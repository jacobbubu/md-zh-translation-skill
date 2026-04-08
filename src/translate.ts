import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildDocumentAnalysisPrompt,
  buildBundledGateAuditPrompt,
  buildGateAuditPrompt,
  buildInitialPrompt,
  buildRepairPrompt,
  buildStylePolishPrompt
} from "./internal/prompts/scheme-h.js";
import { DefaultCodexExecutor, type CodexExecutor } from "./codex-exec.js";
import {
  applyEmphasisPlanTargets,
  describeAnchorDisplay,
  formatAnchorDisplay,
  injectPlannedAnchorText,
  lineSatisfiesAnchorDisplay,
  normalizeExplicitRepairAnchorText,
  normalizeHeadingLikeAnchorText,
  normalizeSourceSurfaceAnchorText,
  normalizeSegmentAnchorText
} from "./anchor-normalization.js";
import { FormattingError, HardGateError } from "./errors.js";
import { formatTranslatedBody, reconstructMarkdown } from "./format.js";
import { planMarkdownChunks, type MarkdownChunk, type MarkdownChunkPlan } from "./markdown-chunks.js";
import {
  extractTranslatableStrongEmphasisSpans,
  extractFrontmatter,
  protectMarkdownSpans,
  protectSegmentFormattingSpans,
  reprotectMarkdownSpans,
  restoreMarkdownSpans,
  type ProtectedSpan
} from "./markdown-protection.js";
import {
  applyAnchorCatalog,
  applyRepairResult,
  applySegmentAudit,
  applySegmentDraft,
  buildLocalFallbackAnchorId,
  buildSegmentTaskSlice,
  createTranslationRunState,
  getChunkSegments,
  getSegmentState,
  markChunkFailure,
  markChunkPhase,
  markSegmentStyled,
  setChunkFinalBody,
  type AnchorCatalog,
  type AnalysisAnchor,
  type AnalysisHeadingPlan,
  type AnalysisEmphasisPlan,
  type AuditCheckKey as StateAuditCheckKey,
  type ChunkSeed,
  type PromptSlice,
  type RepairFailureType,
  type RepairTask,
  type SegmentAuditResult as StateSegmentAuditResult,
  type TranslationRunState
} from "./translation-state.js";
import {
  buildKnownEntityCatalog,
  loadKnownEntities,
  mergeAnchorCatalogs,
  normalizeDiscoveredAnchorCatalog,
  writeKnownEntityCandidatesIfRequested
} from "./known-entities.js";

const DEFAULT_MODEL = "gpt-5.4-mini";
const MAX_REPAIR_CYCLES = 2;
const MAX_MUST_FIX_PER_REPAIR_CALL = 1;
const DRAFT_REASONING_EFFORT = "medium";
const AUDIT_REASONING_EFFORT = "medium";
const REPAIR_REASONING_EFFORT = "low";
const STYLE_REASONING_EFFORT = "low";
const ANALYSIS_SHARD_MAX_CHUNKS = 3;
const ANALYSIS_SHARD_MAX_SOURCE_CHARS = 8000;
const ANALYSIS_SHARD_MAX_HEADINGS = 12;
const ANALYSIS_SHARD_MAX_EMPHASIS = 12;
const ANALYSIS_SUMMARY_MAX_ANCHORS = 40;
const ANALYSIS_SUMMARY_MAX_HEADINGS = 40;
const ANALYSIS_SUMMARY_MAX_IGNORED = 30;
const ANALYSIS_SHARD_TIMEOUT_MS = 120000;
const ANALYSIS_HEARTBEAT_MS = 15000;
const ANALYSIS_SHARD_MAX_ATTEMPTS = 3;
const ANALYSIS_SHARD_MAX_SPLIT_DEPTH = 2;
const ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS = 900;
const ANALYSIS_FALLBACK_SHARD_CONCURRENCY = 2;
type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type StyleMode = "none" | "final";

type AnalysisShard = {
  id: string;
  index: number;
  chunkIds: string[];
  segmentIdsByChunk?: Record<string, string[]>;
  sourceChars: number;
  headingCount: number;
  emphasisCount: number;
  depth: number;
};

type AnalysisShardSummary = {
  anchors: Array<{
    english: string;
    chineseHint: string;
    displayPolicy?: AnalysisAnchor["displayPolicy"];
    sourceForms?: string[] | null;
  }>;
  headingPlans: Array<{
    sourceHeading: string;
    strategy: AnalysisHeadingPlan["strategy"];
    targetHeading?: string;
  }>;
  ignoredTerms: Array<{
    english: string;
    reason: string;
  }>;
};

type AuditCheckKey =
  | "paragraph_match"
  | "first_mention_bilingual"
  | "numbers_units_logic"
  | "chinese_punctuation"
  | "unit_conversion_boundary"
  | "protected_span_integrity";

export type GateAudit = {
  hard_checks: Record<AuditCheckKey, { pass: boolean; problem: string }>;
  must_fix: string[];
};

type IndexedGateAudit = GateAudit & {
  segment_index: number;
};

type BundledGateAudit = {
  segments: IndexedGateAudit[];
};

export type TranslateProgress =
  | "analyze"
  | "draft"
  | "audit"
  | "repair"
  | "style"
  | "format";

export type TranslateOptions = {
  cwd?: string;
  sourcePathHint?: string;
  model?: string;
  postDraftModel?: string;
  styleMode?: StyleMode;
  executor?: CodexExecutor;
  formatter?: typeof formatTranslatedBody;
  onProgress?: (message: string, stage: TranslateProgress) => void;
};

export type TranslateResult = {
  markdown: string;
  model: string;
  repairCyclesUsed: number;
  styleApplied: boolean;
  gateAudit: GateAudit;
  chunkCount: number;
};

const GATE_AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hard_checks", "must_fix"],
  properties: {
    hard_checks: {
      type: "object",
      additionalProperties: false,
      required: [
        "paragraph_match",
        "first_mention_bilingual",
        "numbers_units_logic",
        "chinese_punctuation",
        "unit_conversion_boundary",
        "protected_span_integrity"
      ],
      properties: {
        paragraph_match: auditItemSchema(),
        first_mention_bilingual: auditItemSchema(),
        numbers_units_logic: auditItemSchema(),
        chinese_punctuation: auditItemSchema(),
        unit_conversion_boundary: auditItemSchema(),
        protected_span_integrity: auditItemSchema()
      }
    },
    must_fix: {
      type: "array",
      items: {
        type: "string"
      }
    }
  }
} as const;

const BUNDLED_GATE_AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["segments"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["segment_index", "hard_checks", "must_fix"],
        properties: {
          segment_index: { type: "integer", minimum: 1 },
          hard_checks: GATE_AUDIT_SCHEMA.properties.hard_checks,
          must_fix: GATE_AUDIT_SCHEMA.properties.must_fix
        }
      }
    }
  }
} as const;

const ANCHOR_CATALOG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["anchors", "headingPlans", "emphasisPlans", "ignoredTerms"],
  properties: {
    anchors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "english",
          "chineseHint",
          "category",
          "familyKey",
          "displayPolicy",
          "sourceForms",
          "firstOccurrence"
        ],
        properties: {
          english: { type: "string" },
          chineseHint: { type: "string" },
          category: {
            anyOf: [
              { type: "string" },
              { type: "null" }
            ]
          },
          familyKey: { type: "string" },
          displayPolicy: {
            anyOf: [
              {
                type: "string",
                enum: ["auto", "acronym-compound", "english-only", "english-primary", "chinese-primary"]
              },
              { type: "null" }
            ]
          },
          sourceForms: {
            anyOf: [
              {
                type: "array",
                items: { type: "string" }
              },
              { type: "null" }
            ]
          },
          firstOccurrence: {
            type: "object",
            additionalProperties: false,
            required: ["chunkId", "segmentId"],
            properties: {
              chunkId: { type: "string" },
              segmentId: { type: "string" }
            }
          }
        }
      }
    },
    headingPlans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "chunkId",
          "segmentId",
          "headingIndex",
          "sourceHeading",
          "strategy",
          "targetHeading",
          "governedTerms",
          "english",
          "chineseHint",
          "category",
          "displayPolicy"
        ],
        properties: {
          chunkId: { type: "string" },
          segmentId: { type: "string" },
          headingIndex: {
            anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }]
          },
          sourceHeading: { type: "string" },
          strategy: {
            type: "string",
            enum: ["none", "concept", "source-template", "mixed-qualifier", "natural-heading"]
          },
          targetHeading: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          governedTerms: {
            anyOf: [
              {
                type: "array",
                items: { type: "string" }
              },
              { type: "null" }
            ]
          },
          english: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          chineseHint: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          category: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          displayPolicy: {
            anyOf: [
              {
                type: "string",
                enum: ["auto", "acronym-compound", "english-only", "english-primary", "chinese-primary"]
              },
              { type: "null" }
            ]
          }
        }
      }
    },
    emphasisPlans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "chunkId",
          "segmentId",
          "emphasisIndex",
          "lineIndex",
          "sourceText",
          "strategy",
          "targetText",
          "governedTerms"
        ],
        properties: {
          chunkId: { type: "string" },
          segmentId: { type: "string" },
          emphasisIndex: {
            anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }]
          },
          lineIndex: {
            anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }]
          },
          sourceText: { type: "string" },
          strategy: {
            type: "string",
            enum: ["preserve-strong", "none"]
          },
          targetText: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          governedTerms: {
            anyOf: [
              {
                type: "array",
                items: { type: "string" }
              },
              { type: "null" }
            ]
          }
        }
      }
    },
    ignoredTerms: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["english", "reason"],
        properties: {
          english: { type: "string" },
          reason: { type: "string" }
        }
      }
    }
  }
} as const;

function auditItemSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["pass", "problem"],
    properties: {
      pass: { type: "boolean" },
      problem: { type: "string" }
    }
  };
}

function normalizeAuditQuoteStyle(text: string): string {
  return text
    .replaceAll("「", "“")
    .replaceAll("」", "”")
    .replaceAll("『", "‘")
    .replaceAll("』", "’");
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const firstFenceEnd = trimmed.indexOf("\n");
    const lastFenceStart = trimmed.lastIndexOf("```");
    if (firstFenceEnd >= 0 && lastFenceStart > firstFenceEnd) {
      return trimmed.slice(firstFenceEnd + 1, lastFenceStart).trim();
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new HardGateError("Gate audit did not return a JSON object.");
  }
  return trimmed.slice(start, end + 1);
}

function parseGateAuditValue(value: unknown): GateAudit {
  if (!value || typeof value !== "object") {
    throw new HardGateError("Gate audit JSON is not an object.");
  }

  const data = value as Record<string, unknown>;
  const hardChecks = data.hard_checks;
  const mustFix = data.must_fix;
  const keys: AuditCheckKey[] = [
    "paragraph_match",
    "first_mention_bilingual",
    "numbers_units_logic",
    "chinese_punctuation",
    "unit_conversion_boundary",
    "protected_span_integrity"
  ];

  if (!hardChecks || typeof hardChecks !== "object") {
    throw new HardGateError("Gate audit JSON is missing hard_checks.");
  }

  for (const key of keys) {
    const item = (hardChecks as Record<string, unknown>)[key];
    if (!item || typeof item !== "object") {
      throw new HardGateError(`Gate audit JSON is missing hard_checks.${key}.`);
    }
    const typed = item as Record<string, unknown>;
    if (typeof typed.pass !== "boolean" || typeof typed.problem !== "string") {
      throw new HardGateError(`Gate audit JSON has an invalid hard_checks.${key} entry.`);
    }

    typed.problem = normalizeAuditQuoteStyle(typed.problem);
  }

  if (!Array.isArray(mustFix) || !mustFix.every((item) => typeof item === "string")) {
    throw new HardGateError("Gate audit JSON must_fix must be an array of strings.");
  }

  return {
    hard_checks: hardChecks as GateAudit["hard_checks"],
    must_fix: mustFix.map((item) => normalizeAuditQuoteStyle(item.trim())).filter(Boolean)
  };
}

export function parseGateAudit(text: string): GateAudit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch (error) {
    throw new HardGateError(error instanceof Error ? error.message : String(error));
  }

  return parseGateAuditValue(parsed);
}

function parseBundledGateAudit(text: string, expectedSegmentIndices: readonly number[]): BundledGateAudit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch (error) {
    throw new HardGateError(error instanceof Error ? error.message : String(error));
  }

  if (!parsed || typeof parsed !== "object") {
    throw new HardGateError("Bundled gate audit JSON is not an object.");
  }

  const data = parsed as Record<string, unknown>;
  if (!Array.isArray(data.segments)) {
    throw new HardGateError("Bundled gate audit JSON is missing segments.");
  }

  const audits = data.segments.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new HardGateError(`Bundled gate audit segment[${index}] is not an object.`);
    }

    const segmentIndex = Number((item as Record<string, unknown>).segment_index);
    if (!Number.isInteger(segmentIndex) || segmentIndex < 1) {
      throw new HardGateError(`Bundled gate audit segment[${index}] has an invalid segment_index.`);
    }

    const audit = parseGateAuditValue(item);
    return {
      segment_index: segmentIndex,
      ...audit
    } satisfies IndexedGateAudit;
  });

  const sortedActual = audits.map((audit) => audit.segment_index).sort((left, right) => left - right);
  const sortedExpected = [...expectedSegmentIndices].sort((left, right) => left - right);
  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((value, index) => value !== sortedExpected[index])
  ) {
    throw new HardGateError(
      `Bundled gate audit segment_index set mismatch: expected [${sortedExpected.join(", ")}], got [${sortedActual.join(", ")}].`
    );
  }

  return { segments: audits };
}

function parseAnchorCatalog(text: string): AnchorCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch (error) {
    throw new HardGateError(error instanceof Error ? error.message : String(error));
  }

  if (!parsed || typeof parsed !== "object") {
    throw new HardGateError("Anchor catalog JSON is not an object.");
  }

  const data = parsed as Record<string, unknown>;
  if (!Array.isArray(data.anchors) || !Array.isArray(data.ignoredTerms)) {
    throw new HardGateError("Anchor catalog JSON must contain anchors and ignoredTerms arrays.");
  }

  const anchors = data.anchors.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new HardGateError(`Anchor catalog anchors[${index}] is not an object.`);
    }
    const anchor = item as Record<string, unknown>;
    const firstOccurrence = anchor.firstOccurrence;
    if (
      typeof anchor.english !== "string" ||
      typeof anchor.chineseHint !== "string" ||
      typeof anchor.familyKey !== "string" ||
      !firstOccurrence ||
      typeof firstOccurrence !== "object" ||
      typeof (firstOccurrence as Record<string, unknown>).chunkId !== "string" ||
      typeof (firstOccurrence as Record<string, unknown>).segmentId !== "string"
    ) {
      throw new HardGateError(`Anchor catalog anchors[${index}] has an invalid shape.`);
    }

    const parsedAnchor: AnalysisAnchor = {
      english: anchor.english.trim(),
      chineseHint: anchor.chineseHint.trim(),
      familyKey: anchor.familyKey.trim(),
      firstOccurrence: {
        chunkId: String((firstOccurrence as Record<string, unknown>).chunkId),
        segmentId: String((firstOccurrence as Record<string, unknown>).segmentId)
      }
    };

    if (typeof anchor.category === "string" && anchor.category.trim()) {
      parsedAnchor.category = anchor.category.trim();
    }

    if (typeof anchor.displayPolicy === "string") {
      parsedAnchor.displayPolicy = anchor.displayPolicy as NonNullable<AnalysisAnchor["displayPolicy"]>;
    }

    if (Array.isArray(anchor.sourceForms)) {
      const sourceForms = anchor.sourceForms
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      if (sourceForms.length > 0) {
        parsedAnchor.sourceForms = sourceForms;
      }
    }

    return parsedAnchor;
  });

  const headingPlans = (Array.isArray(data.headingPlans) ? data.headingPlans : []).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new HardGateError(`Anchor catalog headingPlans[${index}] is not an object.`);
    }
    const plan = item as Record<string, unknown>;
    if (
      typeof plan.chunkId !== "string" ||
      typeof plan.segmentId !== "string" ||
      typeof plan.sourceHeading !== "string" ||
      typeof plan.strategy !== "string"
    ) {
      throw new HardGateError(`Anchor catalog headingPlans[${index}] has an invalid shape.`);
    }

    const parsedPlan: AnalysisHeadingPlan = {
      chunkId: plan.chunkId.trim(),
      segmentId: plan.segmentId.trim(),
      sourceHeading: plan.sourceHeading.trim(),
      strategy: plan.strategy as AnalysisHeadingPlan["strategy"]
    };

    if (typeof plan.headingIndex === "number" && Number.isInteger(plan.headingIndex) && plan.headingIndex >= 1) {
      parsedPlan.headingIndex = plan.headingIndex;
    }
    if (typeof plan.targetHeading === "string" && plan.targetHeading.trim()) {
      parsedPlan.targetHeading = plan.targetHeading.trim();
    }
    if (Array.isArray(plan.governedTerms)) {
      const governedTerms = plan.governedTerms
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      if (governedTerms.length > 0) {
        parsedPlan.governedTerms = governedTerms;
      }
    }
    if (typeof plan.english === "string" && plan.english.trim()) {
      parsedPlan.english = plan.english.trim();
    }
    if (typeof plan.chineseHint === "string" && plan.chineseHint.trim()) {
      parsedPlan.chineseHint = plan.chineseHint.trim();
    }
    if (typeof plan.category === "string" && plan.category.trim()) {
      parsedPlan.category = plan.category.trim();
    }
    if (typeof plan.displayPolicy === "string") {
      parsedPlan.displayPolicy = plan.displayPolicy as NonNullable<AnalysisHeadingPlan["displayPolicy"]>;
    }

    return parsedPlan;
  });

  const emphasisPlans = (Array.isArray(data.emphasisPlans) ? data.emphasisPlans : []).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new HardGateError(`Anchor catalog emphasisPlans[${index}] is not an object.`);
    }
    const plan = item as Record<string, unknown>;
    if (
      typeof plan.chunkId !== "string" ||
      typeof plan.segmentId !== "string" ||
      typeof plan.sourceText !== "string" ||
      typeof plan.strategy !== "string"
    ) {
      throw new HardGateError(`Anchor catalog emphasisPlans[${index}] has an invalid shape.`);
    }

    const parsedPlan: AnalysisEmphasisPlan = {
      chunkId: plan.chunkId,
      segmentId: plan.segmentId,
      sourceText: plan.sourceText.trim(),
      strategy: plan.strategy as AnalysisEmphasisPlan["strategy"]
    };

    if (typeof plan.emphasisIndex === "number") {
      parsedPlan.emphasisIndex = plan.emphasisIndex;
    }
    if (typeof plan.lineIndex === "number") {
      parsedPlan.lineIndex = plan.lineIndex;
    }
    if (typeof plan.targetText === "string" && plan.targetText.trim()) {
      parsedPlan.targetText = plan.targetText.trim();
    }
    if (Array.isArray(plan.governedTerms)) {
      const governedTerms = plan.governedTerms
        .filter((term): term is string => typeof term === "string")
        .map((term) => term.trim())
        .filter(Boolean);
      if (governedTerms.length > 0) {
        parsedPlan.governedTerms = governedTerms;
      }
    }

    return parsedPlan;
  });

  const ignoredTerms = data.ignoredTerms.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new HardGateError(`Anchor catalog ignoredTerms[${index}] is not an object.`);
    }
    const ignored = item as Record<string, unknown>;
    if (typeof ignored.english !== "string" || typeof ignored.reason !== "string") {
      throw new HardGateError(`Anchor catalog ignoredTerms[${index}] has an invalid shape.`);
    }

    return {
      english: ignored.english.trim(),
      reason: ignored.reason.trim()
    };
  });

  return { anchors, headingPlans, emphasisPlans, ignoredTerms };
}

function isHardPass(audit: GateAudit): boolean {
  return Object.values(audit.hard_checks).every((item) => item.pass);
}

function isBundledHardPass(audit: BundledGateAudit): boolean {
  return audit.segments.every((segment) => isHardPass(segment));
}

function validateStructuralGateChecks(audit: GateAudit): void {
  if (!audit.hard_checks.protected_span_integrity.pass) {
    const detail = audit.hard_checks.protected_span_integrity.problem || "Protected span integrity failed.";
    throw new HardGateError(`Protected span integrity failed: ${detail}`);
  }
}

function report(options: TranslateOptions, stage: TranslateProgress, message: string): void {
  options.onProgress?.(message, stage);
}

function buildChunkSeeds(
  chunkPlan: MarkdownChunkPlan,
  spanIndex: ReadonlyMap<string, ProtectedSpan>
): ChunkSeed[] {
  return chunkPlan.chunks.map((chunk) => ({
    source: chunk.source,
    separatorAfter: chunk.separatorAfter,
    headingPath: [...chunk.headingPath],
    segments: splitProtectedChunkSegments(chunk.source, spanIndex).map((segment) => ({
      kind: segment.kind,
      source: segment.source,
      separatorAfter: segment.separatorAfter,
      spanIds: segment.spans.map((span) => span.id),
      headingHints: extractSegmentHeadingHints(segment.source),
      specialNotes: extractSegmentSpecialNotes(segment.source)
    }))
  }));
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getAnalysisShardLimits() {
  return {
    maxChunks: readPositiveIntEnv("MDZH_ANALYSIS_SHARD_MAX_CHUNKS", ANALYSIS_SHARD_MAX_CHUNKS),
    maxSourceChars: readPositiveIntEnv("MDZH_ANALYSIS_SHARD_MAX_SOURCE_CHARS", ANALYSIS_SHARD_MAX_SOURCE_CHARS),
    maxHeadings: readPositiveIntEnv("MDZH_ANALYSIS_SHARD_MAX_HEADINGS", ANALYSIS_SHARD_MAX_HEADINGS),
    maxEmphasis: readPositiveIntEnv("MDZH_ANALYSIS_SHARD_MAX_EMPHASIS", ANALYSIS_SHARD_MAX_EMPHASIS)
  };
}

function getAnalysisShardTimeoutMs(): number {
  return readPositiveIntEnv("MDZH_ANALYSIS_SHARD_TIMEOUT_MS", ANALYSIS_SHARD_TIMEOUT_MS);
}

function getAnalysisHeartbeatMs(): number {
  return readPositiveIntEnv("MDZH_ANALYSIS_HEARTBEAT_MS", ANALYSIS_HEARTBEAT_MS);
}

function getAnalysisShardMaxAttempts(): number {
  return readPositiveIntEnv("MDZH_ANALYSIS_SHARD_MAX_ATTEMPTS", ANALYSIS_SHARD_MAX_ATTEMPTS);
}

function getAnalysisShardMaxSplitDepth(): number {
  return readPositiveIntEnv("MDZH_ANALYSIS_SHARD_MAX_SPLIT_DEPTH", ANALYSIS_SHARD_MAX_SPLIT_DEPTH);
}

function getAnalysisShardMinSplitSourceChars(): number {
  return readPositiveIntEnv(
    "MDZH_ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS",
    ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS
  );
}

function getAnalysisFallbackShardConcurrency(): number {
  return Math.min(
    2,
    readPositiveIntEnv(
      "MDZH_ANALYSIS_FALLBACK_SHARD_CONCURRENCY",
      ANALYSIS_FALLBACK_SHARD_CONCURRENCY
    )
  );
}

function getShardSegments(state: TranslationRunState, shard: AnalysisShard, chunkId: string) {
  const segments = getChunkSegments(state, chunkId);
  const selectedSegmentIds = shard.segmentIdsByChunk?.[chunkId];
  if (!selectedSegmentIds?.length) {
    return segments;
  }

  const selected = new Set(selectedSegmentIds);
  return segments.filter((segment) => selected.has(segment.id));
}

function summarizeChunkForAnalysis(state: TranslationRunState, chunkId: string) {
  const segments = getChunkSegments(state, chunkId);
  const sourceChars = segments.reduce((total, segment) => total + segment.source.length, 0);
  const headingCount = segments.reduce((total, segment) => total + segment.headingHints.length, 0);
  const emphasisCount = segments.reduce(
    (total, segment) => total + extractTranslatableStrongEmphasisSpans(segment.source).length,
    0
  );

  return { sourceChars, headingCount, emphasisCount };
}

function summarizeAnalysisShard(state: TranslationRunState, shard: AnalysisShard) {
  const selectedChunks = state.chunks.filter((chunk) => shard.chunkIds.includes(chunk.id));
  let sourceChars = 0;
  let headingCount = 0;
  let emphasisCount = 0;

  for (const chunk of selectedChunks) {
    const segments = getShardSegments(state, shard, chunk.id);
    for (const segment of segments) {
      sourceChars += segment.source.length;
      headingCount += segment.headingHints.length;
      emphasisCount += extractTranslatableStrongEmphasisSpans(segment.source).length;
    }
  }

  return { sourceChars, headingCount, emphasisCount };
}

function buildAnalysisShards(state: TranslationRunState): AnalysisShard[] {
  const limits = getAnalysisShardLimits();
  const shards: AnalysisShard[] = [];
  let currentChunkIds: string[] = [];
  let sourceChars = 0;
  let headingCount = 0;
  let emphasisCount = 0;

  const flush = () => {
    if (currentChunkIds.length === 0) {
      return;
    }
    shards.push({
      id: `analysis-shard-${shards.length + 1}`,
      index: shards.length,
      chunkIds: currentChunkIds,
      sourceChars,
      headingCount,
      emphasisCount,
      depth: 0
    });
    currentChunkIds = [];
    sourceChars = 0;
    headingCount = 0;
    emphasisCount = 0;
  };

  for (const chunk of state.chunks) {
    const chunkSummary = summarizeChunkForAnalysis(state, chunk.id);
    const wouldExceed =
      currentChunkIds.length > 0 &&
      (currentChunkIds.length + 1 > limits.maxChunks ||
        sourceChars + chunkSummary.sourceChars > limits.maxSourceChars ||
        headingCount + chunkSummary.headingCount > limits.maxHeadings ||
        emphasisCount + chunkSummary.emphasisCount > limits.maxEmphasis);

    if (wouldExceed) {
      flush();
    }

    currentChunkIds.push(chunk.id);
    sourceChars += chunkSummary.sourceChars;
    headingCount += chunkSummary.headingCount;
    emphasisCount += chunkSummary.emphasisCount;
  }

  flush();
  return shards;
}

function createAnalysisShard(
  state: TranslationRunState,
  shard: Pick<AnalysisShard, "id" | "index" | "chunkIds" | "segmentIdsByChunk" | "depth">
): AnalysisShard {
  const summary = summarizeAnalysisShard(state, shard as AnalysisShard);
  return {
    ...shard,
    sourceChars: summary.sourceChars,
    headingCount: summary.headingCount,
    emphasisCount: summary.emphasisCount
  };
}

function splitArrayBalanced<T>(
  items: readonly T[],
  weightOf: (item: T) => number
): [T[], T[]] | null {
  if (items.length <= 1) {
    return null;
  }

  const totalWeight = items.reduce((sum, item) => sum + Math.max(weightOf(item), 1), 0);
  const target = totalWeight / 2;
  const left: T[] = [];
  const right: T[] = [];
  let leftWeight = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const remaining = items.length - index;
    if (left.length > 0 && leftWeight >= target && remaining >= 1) {
      right.push(item);
      continue;
    }
    left.push(item);
    leftWeight += Math.max(weightOf(item), 1);
  }

  if (right.length === 0) {
    const moved = left.pop();
    if (moved !== undefined) {
      right.unshift(moved);
    }
  }

  if (left.length === 0 || right.length === 0) {
    return null;
  }

  return [left, right];
}

function splitAnalysisShard(state: TranslationRunState, shard: AnalysisShard): AnalysisShard[] {
  const minSplitSourceChars = getAnalysisShardMinSplitSourceChars();
  if (shard.sourceChars < minSplitSourceChars * 2) {
    return [];
  }

  const ensureViable = (children: AnalysisShard[]): AnalysisShard[] =>
    children.every((child) => child.sourceChars >= minSplitSourceChars) ? children : [];

  if (shard.chunkIds.length > 1) {
    const chunkSplit = splitArrayBalanced(shard.chunkIds, (chunkId) => summarizeChunkForAnalysis(state, chunkId).sourceChars);
    if (!chunkSplit) {
      return [];
    }

    return ensureViable(chunkSplit.map((chunkIds, index) =>
      createAnalysisShard(state, {
        id: `${shard.id}-c${index + 1}`,
        index: shard.index,
        chunkIds,
        depth: shard.depth + 1
      })
    ));
  }

  const chunkId = shard.chunkIds[0];
  if (!chunkId) {
    return [];
  }
  const segments = getShardSegments(state, shard, chunkId);
  const segmentSplit = splitArrayBalanced(segments, (segment) => segment.source.length);
  if (!segmentSplit) {
    return [];
  }

  return ensureViable(segmentSplit.map((group, index) =>
    createAnalysisShard(state, {
      id: `${shard.id}-s${index + 1}`,
      index: shard.index,
      chunkIds: [chunkId],
      segmentIdsByChunk: {
        [chunkId]: group.map((segment) => segment.id)
      },
      depth: shard.depth + 1
    })
  ));
}

function buildAnalysisShardSummary(catalog: AnchorCatalog): AnalysisShardSummary {
  return {
    anchors: catalog.anchors.slice(0, ANALYSIS_SUMMARY_MAX_ANCHORS).map((anchor) => ({
      english: anchor.english,
      chineseHint: anchor.chineseHint,
      ...(anchor.displayPolicy ? { displayPolicy: anchor.displayPolicy } : {}),
      ...(anchor.sourceForms?.length ? { sourceForms: anchor.sourceForms } : {})
    })),
    headingPlans: (catalog.headingPlans ?? []).slice(0, ANALYSIS_SUMMARY_MAX_HEADINGS).map((plan) => ({
      sourceHeading: plan.sourceHeading,
      strategy: plan.strategy,
      ...(plan.targetHeading ? { targetHeading: plan.targetHeading } : {})
    })),
    ignoredTerms: catalog.ignoredTerms.slice(0, ANALYSIS_SUMMARY_MAX_IGNORED)
  };
}

function buildDocumentAnalysisInput(
  state: TranslationRunState,
  options: { shard?: AnalysisShard | null; priorSummary?: AnalysisShardSummary | null; shardCount?: number } = {}
): string {
  const selectedChunkIds = new Set(options.shard?.chunkIds ?? state.chunks.map((chunk) => chunk.id));
  const selectedChunks = state.chunks.filter((chunk) => selectedChunkIds.has(chunk.id));
  return JSON.stringify(
    {
      document: state.document,
      analysisScope: options.shard
        ? {
            mode: "shard",
            shardId: options.shard.id,
            shardIndex: options.shard.index + 1,
            shardCount: options.shardCount ?? buildAnalysisShards(state).length,
            chunkIds: options.shard.chunkIds,
            sourceChars: options.shard.sourceChars,
            headingCount: options.shard.headingCount,
            emphasisCount: options.shard.emphasisCount
          }
        : { mode: "full-document" },
      ...(options.priorSummary
        ? {
            priorAccepted: options.priorSummary
          }
        : {}),
      chunks: selectedChunks.map((chunk) => ({
        id: chunk.id,
        index: chunk.index + 1,
        headingPath: chunk.headingPath,
        segments: (options.shard ? getShardSegments(state, options.shard, chunk.id) : getChunkSegments(state, chunk.id)).map((segment) => ({
          id: segment.id,
          index: segment.index + 1,
          kind: segment.kind,
          headingHints: segment.headingHints,
          headingLikeLines: segment.headingHints.map((heading, index) => ({
            index: index + 1,
            sourceHeading: heading
          })),
          emphasisLikeSpans: extractTranslatableStrongEmphasisSpans(segment.source).map((span) => ({
            index: span.index,
            lineIndex: span.lineIndex,
            sourceText: span.sourceText
          })),
          source: segment.source
        }))
      }))
    },
    null,
    2
  );
}

function countHeadingLikeLines(state: TranslationRunState): number {
  return state.segments.reduce((count, segment) => count + segment.headingHints.length, 0);
}

function isAnalysisShardTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out after \d+ms/i.test(error.message);
}

async function executeAnalysisShardAttempt(
  state: TranslationRunState,
  context: Pick<ChunkTranslationContext, "executor" | "postDraftModel" | "cwd" | "options" | "postDraftReasoningEffort">,
  formalCatalog: AnchorCatalog,
  accumulatedCatalog: AnchorCatalog,
  shard: AnalysisShard,
  shardCount: number,
  attempt: number,
  timeoutMs: number
): Promise<AnchorCatalog> {
  const acceptedSummary = buildAnalysisShardSummary(mergeAnchorCatalogs(formalCatalog, accumulatedCatalog));
  const prompt = buildDocumentAnalysisPrompt(
    buildDocumentAnalysisInput(state, {
      shard,
      shardCount,
      priorSummary: attempt > 1 || shard.index > 0 ? acceptedSummary : null
    })
  );
  report(
    context.options,
    "analyze",
    `Starting model-based anchor discovery for shard ${shard.index + 1}/${shardCount} attempt ${attempt} (${shard.chunkIds.length} chunk(s), ${shard.sourceChars} source chars, ${shard.headingCount} heading(s), ${shard.emphasisCount} emphasis span(s), timeout ${timeoutMs}ms).`
  );

  const shardStartedAt = Date.now();
  const heartbeatMs = getAnalysisHeartbeatMs();
  const heartbeat = setInterval(() => {
    report(
      context.options,
      "analyze",
      `Shard ${shard.index + 1}/${shardCount} attempt ${attempt} still waiting for model response (${Date.now() - shardStartedAt}ms elapsed).`
    );
  }, heartbeatMs);

  try {
    const result = await context.executor.execute(prompt, {
      cwd: context.cwd,
      model: context.postDraftModel,
      reasoningEffort: context.postDraftReasoningEffort ?? AUDIT_REASONING_EFFORT,
      outputSchema: ANCHOR_CATALOG_SCHEMA,
      reuseSession: false,
      timeoutMs,
      onStderr: (stderrChunk) => {
        const trimmed = stderrChunk.trim();
        if (trimmed) {
          report(context.options, "analyze", trimmed);
        }
      }
    });
    const normalizedShardCatalog = normalizeDiscoveredAnchorCatalog(state, parseAnchorCatalog(result.text));
    report(
      context.options,
      "analyze",
      `Shard ${shard.index + 1}/${shardCount} attempt ${attempt} finished: ${normalizedShardCatalog.anchors.length} anchors, ${normalizedShardCatalog.headingPlans?.length ?? 0} heading plan(s), ${normalizedShardCatalog.ignoredTerms.length} ignored term(s).`
    );
    return normalizedShardCatalog;
  } finally {
    clearInterval(heartbeat);
  }
}

async function analyzeShardWithFallback(
  state: TranslationRunState,
  context: Pick<ChunkTranslationContext, "executor" | "postDraftModel" | "cwd" | "options" | "postDraftReasoningEffort">,
  formalCatalog: AnchorCatalog,
  accumulatedCatalog: AnchorCatalog,
  shard: AnalysisShard,
  shardCount: number,
  timeoutMs: number
): Promise<AnchorCatalog> {
  const maxAttempts = getAnalysisShardMaxAttempts();
  const maxSplitDepth = getAnalysisShardMaxSplitDepth();
  let currentTimeoutMs = timeoutMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await executeAnalysisShardAttempt(
        state,
        context,
        formalCatalog,
        accumulatedCatalog,
        shard,
        shardCount,
        attempt,
        currentTimeoutMs
      );
    } catch (error) {
      const isTimeout = isAnalysisShardTimeoutError(error);
      const hasNextAttempt = attempt < maxAttempts;

      if (!isTimeout || !hasNextAttempt) {
        throw error;
      }

      if (attempt === 1) {
        currentTimeoutMs = Math.round(currentTimeoutMs * 1.5);
        report(
          context.options,
          "analyze",
          `Shard ${shard.index + 1}/${shardCount} timed out on attempt ${attempt}; retrying once with timeout ${currentTimeoutMs}ms before fallback split.`
        );
        continue;
      }

      if (shard.depth < maxSplitDepth) {
        const fallbackShards = splitAnalysisShard(state, shard);
        if (fallbackShards.length > 0) {
          report(
            context.options,
            "analyze",
            `Shard ${shard.index + 1}/${shardCount} timed out on attempt ${attempt}; splitting into ${fallbackShards.length} fallback shard(s).`
          );

          const childCatalogs: AnchorCatalog[] = [];
          const concurrency = Math.max(1, getAnalysisFallbackShardConcurrency());

          for (let start = 0; start < fallbackShards.length; start += concurrency) {
            const batch = fallbackShards.slice(start, start + concurrency);
            const batchCatalogs = await Promise.all(
              batch.map((fallbackShard) =>
                analyzeShardWithFallback(
                  state,
                  context,
                  formalCatalog,
                  accumulatedCatalog,
                  fallbackShard,
                  shardCount,
                  timeoutMs
                )
              )
            );
            childCatalogs.push(...batchCatalogs);
          }

          return childCatalogs.reduce<AnchorCatalog>(
            (merged, childCatalog) => mergeAnchorCatalogs(merged, childCatalog),
            {
              anchors: [],
              headingPlans: [],
              emphasisPlans: [],
              ignoredTerms: []
            }
          );
        }
      }

      currentTimeoutMs = Math.round(currentTimeoutMs * 1.5);
      report(
        context.options,
        "analyze",
        `Shard ${shard.index + 1}/${shardCount} timed out on attempt ${attempt}; retrying with expanded timeout ${currentTimeoutMs}ms.`
      );
    }
  }

  throw new Error(`Analysis shard ${shard.id} exhausted retry attempts without returning a result.`);
}

async function analyzeDocumentForAnchors(
  state: TranslationRunState,
  context: Pick<ChunkTranslationContext, "executor" | "postDraftModel" | "cwd" | "options" | "postDraftReasoningEffort">
): Promise<AnchorCatalog> {
  report(context.options, "analyze", "Loading formal known_entities.");
  const knownEntities = loadKnownEntities();
  const formalCatalog = buildKnownEntityCatalog(state, knownEntities);
  report(
    context.options,
    "analyze",
    `Matched ${formalCatalog.anchors.length} formal known_entities in source.`
  );
  const shards = buildAnalysisShards(state);
  report(
    context.options,
    "analyze",
    `Planned ${shards.length} analysis shard(s) for model-based anchor discovery.`
  );
  try {
    let discoveredCatalog: AnchorCatalog = {
      anchors: [],
      headingPlans: [],
      emphasisPlans: [],
      ignoredTerms: []
    };
    const shardTimeoutMs = getAnalysisShardTimeoutMs();

    for (const shard of shards) {
      try {
        const normalizedShardCatalog = await analyzeShardWithFallback(
          state,
          context,
          formalCatalog,
          discoveredCatalog,
          shard,
          shards.length,
          shardTimeoutMs
        );
        discoveredCatalog = mergeAnchorCatalogs(discoveredCatalog, normalizedShardCatalog);
        report(
          context.options,
          "analyze",
          `Accumulated discovery after shard ${shard.index + 1}/${shards.length}: ${discoveredCatalog.anchors.length} anchors, ${discoveredCatalog.headingPlans?.length ?? 0} heading plan(s).`
        );
      } catch (error) {
        report(
          context.options,
          "analyze",
          `Shard ${shard.index + 1}/${shards.length} failed, continuing with accumulated catalog: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    report(
      context.options,
      "analyze",
      `Model-based anchor discovery finished: ${discoveredCatalog.anchors.length} anchors, ${discoveredCatalog.headingPlans?.length ?? 0} heading plan(s), ${discoveredCatalog.ignoredTerms.length} ignored term(s).`
    );
    const candidateWrite = await writeKnownEntityCandidatesIfRequested(discoveredCatalog, knownEntities);
    if (candidateWrite.written) {
      report(
        context.options,
        "analyze",
        `Wrote ${candidateWrite.count} known_entity candidate(s) to ${candidateWrite.outputPath}.`
      );
    }
    const mergedCatalog = mergeAnchorCatalogs(formalCatalog, discoveredCatalog);
    report(
      context.options,
      "analyze",
      `Merged formal and discovered anchors: ${mergedCatalog.anchors.length} total, ${mergedCatalog.headingPlans?.length ?? 0} heading plan(s).`
    );
    report(
      context.options,
      "analyze",
      `Heading plan coverage: ${mergedCatalog.headingPlans?.length ?? 0}/${countHeadingLikeLines(state)} heading-like line(s).`
    );
    return mergedCatalog;
  } catch (error) {
    report(
      context.options,
      "analyze",
      `Document anchor analysis failed, falling back to an empty catalog: ${error instanceof Error ? error.message : String(error)}`
    );
    report(
      context.options,
      "analyze",
      `Using ${formalCatalog.anchors.length} formal known_entities only.`
    );
    return formalCatalog;
  }
}

async function writeDebugStateIfRequested(state: TranslationRunState): Promise<void> {
  const debugStatePath = process.env.MDZH_DEBUG_STATE_PATH?.trim();
  if (!debugStatePath) {
    return;
  }

  await mkdir(path.dirname(debugStatePath), { recursive: true });
  await writeFile(debugStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function translateMarkdownArticle(source: string, options: TranslateOptions = {}): Promise<TranslateResult> {
  const executor = options.executor ?? new DefaultCodexExecutor();
  const formatter = options.formatter ?? formatTranslatedBody;
  const draftModel = options.model ?? (process.env.TRANSLATION_MODEL?.trim() || DEFAULT_MODEL);
  const postDraftModel = options.postDraftModel ?? (process.env.POST_DRAFT_MODEL?.trim() || draftModel);
  const styleMode = resolveStyleMode(options.styleMode);
  const postDraftReasoningEffort = process.env.POST_DRAFT_REASONING_EFFORT?.trim()
    ? (process.env.POST_DRAFT_REASONING_EFFORT.trim() as ReasoningEffort)
    : undefined;
  const cwd = options.cwd ?? process.cwd();
  const sourcePathHint = options.sourcePathHint ?? "article.md";
  const { frontmatter, body } = extractFrontmatter(source);
  const { protectedBody, spans } = protectMarkdownSpans(body);
  const chunkPlan = planMarkdownChunks(protectedBody);
  const spanIndex = new Map(spans.map((span) => [span.id, span]));
  const state = createTranslationRunState({
    sourcePathHint,
    documentTitle: chunkPlan.documentTitle,
    frontmatterPresent: frontmatter !== null,
    protectedSpans: spans,
    chunks: buildChunkSeeds(chunkPlan, spanIndex)
  });
  const restoredChunks: string[] = [];
  const gateAudits: GateAudit[] = [];
  let repairCyclesUsed = 0;
  let styleApplied = false;
  let nextLocalSpanIndex = spanIndex.size + 1;

  try {
    report(options, "analyze", "Analyzing document-wide anchors.");
    const anchorCatalog = await analyzeDocumentForAnchors(state, {
      executor,
      postDraftModel,
      cwd,
      options,
      postDraftReasoningEffort
    });
    applyAnchorCatalog(state, anchorCatalog);

    for (const chunk of chunkPlan.chunks) {
      const chunkId = `chunk-${chunk.index + 1}`;
      const chunkResult = await translateProtectedChunk(chunk, chunkPlan, {
        state,
        chunkId,
        cwd,
        executor,
        draftModel,
        postDraftModel,
        options,
        sourcePathHint,
        spanIndex,
        nextLocalSpanIndex,
        draftReasoningEffort: DRAFT_REASONING_EFFORT as ReasoningEffort,
        postDraftReasoningEffort
      });

      restoredChunks.push(chunkResult.body + chunk.separatorAfter);
      gateAudits.push(chunkResult.gateAudit);
      repairCyclesUsed += chunkResult.repairCyclesUsed;
      nextLocalSpanIndex = chunkResult.nextLocalSpanIndex;
      setChunkFinalBody(state, chunkId, chunkResult.body);
    }

    let translatedBody = restoredChunks.join("");
    if (styleMode === "final") {
      const finalStyleResult = await applyFinalStylePolish(protectedBody, translatedBody, {
        cwd,
        executor,
        model: postDraftModel,
        options,
        reasoningEffort: postDraftReasoningEffort,
        sourceSpans: spans
      });
      translatedBody = finalStyleResult.body;
      styleApplied = finalStyleResult.styleApplied;
    }

    report(options, "format", "Formatting translated Markdown.");
    let formattedBody: string;
    try {
      formattedBody = await formatter(translatedBody, sourcePathHint);
    } catch (error) {
      throw new FormattingError(error instanceof Error ? error.message : String(error));
    }
    const markdown = reconstructMarkdown(frontmatter, formattedBody);
    await writeDebugStateIfRequested(state);
    return {
      markdown,
      model: draftModel,
      repairCyclesUsed,
      styleApplied,
      gateAudit: mergeGateAudits(gateAudits),
      chunkCount: chunkPlan.chunks.length
    };
  } catch (error) {
    await writeDebugStateIfRequested(state);
    if (error instanceof HardGateError || error instanceof FormattingError) {
      throw error;
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function resolveStyleMode(optionStyleMode: TranslateOptions["styleMode"]): StyleMode {
  if (optionStyleMode === "none" || optionStyleMode === "final") {
    return optionStyleMode;
  }

  const raw = process.env.MDZH_STYLE_MODE?.trim().toLowerCase();
  return raw === "final" ? "final" : "none";
}

function mergeGateAudits(audits: readonly GateAudit[]): GateAudit {
  const merged: GateAudit = {
    hard_checks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: true, problem: "" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    must_fix: []
  };

  for (const audit of audits) {
    for (const [key, value] of Object.entries(audit.hard_checks) as Array<
      [AuditCheckKey, GateAudit["hard_checks"][AuditCheckKey]]
    >) {
      if (!value.pass) {
        merged.hard_checks[key] = value;
      }
    }
  }

  return merged;
}

type ChunkTranslationContext = {
  state: TranslationRunState;
  chunkId: string;
  executor: CodexExecutor;
  draftModel: string;
  postDraftModel: string;
  cwd: string;
  sourcePathHint: string;
  options: TranslateOptions;
  spanIndex: ReadonlyMap<string, ProtectedSpan>;
  nextLocalSpanIndex: number;
  draftReasoningEffort: ReasoningEffort;
  postDraftReasoningEffort: ReasoningEffort | undefined;
};

type ChunkTranslationResult = {
  body: string;
  repairCyclesUsed: number;
  gateAudit: GateAudit;
  nextLocalSpanIndex: number;
};

type DraftedSegmentState = {
  segment: ProtectedChunkSegment;
  segmentId: string;
  promptContext: ChunkPromptContext;
  protectedSource: string;
  protectedBody: string;
  restoredBody: string;
  spans: ProtectedSpan[];
  threadId?: string;
};

function summarizePromptAnchor(anchor: PromptSlice["requiredAnchors"][number]): string {
  const canonical = anchor.canonicalDisplay ?? formatAnchorDisplay(anchor);
  const mode = anchor.displayMode ?? describeAnchorDisplay(anchor).mode;
  return `${canonical || "未定中文"} [display=${mode}]`;
}

function summarizeHeadingPlan(plan: PromptSlice["headingPlans"][number]): string {
  const governed = plan.governedTerms?.length ? plan.governedTerms.join(", ") : "无";
  return `${plan.sourceHeading} -> strategy=${plan.strategy}; target=${plan.targetHeading?.trim() || "无"}; governed=${governed}`;
}

function summarizeEmphasisPlan(plan: PromptSlice["emphasisPlans"][number]): string {
  return `${plan.sourceText} -> strategy=${plan.strategy}; target=${plan.targetText?.trim() || "无"}`;
}

function buildSegmentPromptContext(
  state: TranslationRunState,
  chunk: MarkdownChunk,
  plan: MarkdownChunkPlan,
  sourcePathHint: string,
  segmentId: string,
  source: string
): ChunkPromptContext {
  const slice = buildSegmentTaskSlice(state, `chunk-${chunk.index + 1}`, segmentId);
  return {
    documentTitle: plan.documentTitle,
    headingPath: chunk.headingPath,
    chunkIndex: chunk.index + 1,
    chunkCount: plan.chunks.length,
    sourcePathHint,
    segmentHeadings: extractSegmentHeadingHints(source),
    headingPlanSummaries: slice.headingPlans.map(summarizeHeadingPlan),
    emphasisPlanSummaries: slice.emphasisPlans.map(summarizeEmphasisPlan),
    analysisPlanDraft: slice.analysisPlanDraft,
    specialNotes: extractSegmentSpecialNotes(source),
    requiredAnchors: slice.requiredAnchors.map(summarizePromptAnchor),
    repeatAnchors: slice.repeatAnchors.map(summarizePromptAnchor),
    establishedAnchors: slice.establishedAnchors.map(summarizePromptAnchor),
    pendingRepairs: slice.pendingRepairs.map((task) => task.instruction),
    stateSlice: slice
  };
}

function buildChunkStylePromptContext(
  state: TranslationRunState,
  chunk: MarkdownChunk,
  plan: MarkdownChunkPlan,
  sourcePathHint: string,
  source: string
): ChunkPromptContext {
  const chunkId = `chunk-${chunk.index + 1}`;
  const chunkSegments = getChunkSegments(state, chunkId);
  const combinedEstablished = chunkSegments.flatMap((segment) =>
    buildSegmentTaskSlice(state, chunkId, segment.id).requiredAnchors.map(summarizePromptAnchor)
  );
  return {
    documentTitle: plan.documentTitle,
    headingPath: chunk.headingPath,
    chunkIndex: chunk.index + 1,
    chunkCount: plan.chunks.length,
    sourcePathHint,
    segmentHeadings: extractSegmentHeadingHints(source),
    headingPlanSummaries: [],
    emphasisPlanSummaries: [],
    analysisPlanDraft: "<SEGMENT id=\"chunk-style\">\n</SEGMENT>",
    specialNotes: extractSegmentSpecialNotes(source),
    requiredAnchors: [],
    repeatAnchors: [],
    establishedAnchors: [...new Set(combinedEstablished)],
    pendingRepairs: [],
    stateSlice: null
  };
}

function inferRepairFailureType(audit: GateAudit, instruction: string): RepairFailureType {
  if (/中英对照|双语|首现|锚定/.test(instruction)) {
    return "missing_anchor";
  }

  const failedKey = (Object.entries(audit.hard_checks) as Array<
    [StateAuditCheckKey, GateAudit["hard_checks"][AuditCheckKey]]
  >).find(
    ([, item]) => !item.pass
  )?.[0];

  switch (failedKey) {
    case "paragraph_match":
      return "paragraph_match";
    case "numbers_units_logic":
      return "numbers_units_logic";
    case "chinese_punctuation":
      return "chinese_punctuation";
    case "unit_conversion_boundary":
      return "unit_conversion_boundary";
    case "protected_span_integrity":
      return "protected_span_integrity";
    default:
      return "other";
  }
}

function inferRepairLocationLabel(segmentSource: string): string {
  if (containsHeadingLikeBlock(segmentSource)) {
    return "标题";
  }
  if (containsBlockquoteBlock(segmentSource)) {
    return "引用段";
  }
  if (containsListLikeBlock(segmentSource)) {
    return "列表项";
  }
  if (containsListLeadInBlock(segmentSource)) {
    return "列表引导句";
  }
  return "正文段落";
}

function inferRepairLocationLabelFromInstruction(
  segmentSource: string,
  instruction: string
): string {
  if (instruction.includes("标题")) {
    return "标题";
  }
  if (instruction.includes("列表项") || instruction.includes("项目符号")) {
    return "列表项";
  }
  if (instruction.includes("引用段") || instruction.includes("引用中的") || instruction.includes("引用句")) {
    return "引用段";
  }
  if (instruction.includes("引导句") || instruction.includes("说明句") || instruction.includes("导语句")) {
    return "列表引导句";
  }
  if (hasSentenceLocalRepairTarget(instruction)) {
    return "正文句";
  }

  return inferRepairLocationLabel(segmentSource);
}

function hasSentenceLocalRepairTarget(instruction: string): boolean {
  return (
    instruction.includes("当前句") ||
    instruction.includes("该句") ||
    instruction.includes("句内") ||
    instruction.includes("句中") ||
    instruction.includes("首句") ||
    instruction.includes("末句") ||
    /第\d+段(?:第\d+句|首句|末句)/.test(instruction) ||
    /位置：[^。\n]*“[^”]+”/.test(instruction)
  );
}

function inferRepairAnchorId(
  slice: PromptSlice,
  segmentSource: string,
  instruction: string
): string | null {
  const haystack = instruction.toLowerCase();
  const anchors = [...slice.requiredAnchors, ...slice.repeatAnchors, ...slice.establishedAnchors].filter(
    (anchor) => segmentSource.toLowerCase().includes(anchor.english.trim().toLowerCase())
  );

  const explicitChineseTargets = extractExplicitChineseTargetsFromMustFix([instruction]);
  for (const target of explicitChineseTargets) {
    const exactChineseAnchor = anchors.find(
      (anchor) => normalizeRepairChineseTarget(anchor.chineseHint) === target
    );
    if (exactChineseAnchor) {
      return exactChineseAnchor.anchorId;
    }

    const allowedDisplayAnchor = anchors.find((anchor) =>
      (anchor.allowedDisplayForms ?? []).some((display) => normalizeRepairChineseTarget(display) === target)
    );
    if (allowedDisplayAnchor) {
      return allowedDisplayAnchor.anchorId;
    }
  }

  const explicitTargets = extractExplicitEnglishTargetsFromMustFix([instruction]);
  for (const target of explicitTargets) {
    const normalizedTarget = target.toLowerCase();
    const exactAnchor = anchors.find((anchor) => anchor.english.toLowerCase() === normalizedTarget);
    if (exactAnchor) {
      return exactAnchor.anchorId;
    }

    if (
      shouldUseLocalFallbackAnchor(instruction, target) &&
      containsWholePhraseInText(segmentSource, target)
    ) {
      return buildLocalFallbackAnchorId(slice.segmentId, target);
    }

    const matchedAnchor = anchors.find(
      (anchor) =>
        normalizedTarget.includes(anchor.english.toLowerCase()) ||
        anchor.english.toLowerCase().includes(normalizedTarget)
    );
    if (matchedAnchor) {
      return matchedAnchor.anchorId;
    }
  }

  for (const anchor of anchors) {
    if (containsWholePhraseInText(instruction, anchor.english)) {
      return anchor.anchorId;
    }
  }

  for (const anchor of anchors) {
    if (
      haystack.includes(anchor.english.toLowerCase()) ||
      (anchor.chineseHint && haystack.includes(anchor.chineseHint.toLowerCase()))
    ) {
      return anchor.anchorId;
    }
  }
  return null;
}

function shouldUseLocalFallbackAnchor(instruction: string, english: string): boolean {
  if (looksCodeLikeLocalFallbackTarget(english)) {
    return false;
  }

  return (
    ((/(列表项|项目符号)/.test(instruction) && instruction.includes("不要只写成") && /\s/.test(english)) ||
      extractInlineLocalizedRepairTarget(instruction, english) !== null)
  );
}

function looksCodeLikeLocalFallbackTarget(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  return (
    trimmed.startsWith("--") ||
    trimmed.startsWith(".") ||
    trimmed.includes("/") ||
    /[(){}[\]<>]/.test(trimmed)
  );
}

function extractExplicitChineseTargetsFromMustFix(instructions: readonly string[]): string[] {
  const targets = new Set<string>();

  for (const instruction of instructions) {
    const rewriteTarget = instruction.match(/与全文锚点一致的“([^”]+)”(?:术语形式|形式)?/)?.[1]?.trim();
    if (rewriteTarget) {
      const normalizedRewriteTarget = normalizeRepairChineseTarget(rewriteTarget);
      if (looksLikeChineseRepairTarget(normalizedRewriteTarget)) {
        targets.add(normalizedRewriteTarget);
      }
    }

    const quotedTargets = [
      ...[...instruction.matchAll(/“([^”]+)”/g)].map((match) => match[1]?.trim()),
      ...[...instruction.matchAll(/`([^`]+)`/g)].map((match) => match[1]?.trim())
    ];
    for (const rawTarget of quotedTargets) {
      if (!rawTarget) {
        continue;
      }

      const normalizedTarget = normalizeRepairChineseTarget(rawTarget);
      if (looksLikeChineseRepairTarget(normalizedTarget)) {
        targets.add(normalizedTarget);
      }
    }
  }

  return [...targets];
}

function normalizeRepairChineseTarget(text: string): string {
  return normalizeExplicitRepairLocationText(text).replace(/\s+/g, " ").trim();
}

function looksLikeChineseRepairTarget(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text) && !/[A-Za-z]/.test(text);
}

function looksLikeLocalizedRepairTarget(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text) && !looksCodeLikeLocalFallbackTarget(text);
}

function normalizeLocalFallbackChineseHint(text: string): string {
  return normalizeExplicitRepairLocationText(text)
    .replace(/（\s*[A-Za-z][^）]*）$/u, "")
    .replace(/\(\s*[A-Za-z][^)]*\)$/u, "")
    .trim();
}

function extractExplicitLocalizedTargetsFromMustFix(instructions: readonly string[]): string[] {
  const targets = new Set<string>();

  for (const instruction of instructions) {
    const patterns = [
      /需补为[“`]([^”`\n]+?)(?:（[A-Za-z][^）”`\n]*）)?[”`]/g,
      /补齐[“`]([^”`\n]+?)(?:（[A-Za-z][^）”`\n]*）)?[”`]/g,
      /为[“`]([^”`\n]+)[”`]建立(?:合法的)?中英文(?:首现)?对应/g,
      /改为与全文锚点一致的[“`]([^”`\n]+)[”`]/g
    ];

    for (const pattern of patterns) {
      for (const match of instruction.matchAll(pattern)) {
        const candidate = normalizeLocalFallbackChineseHint(match[1] ?? "");
        if (candidate && looksLikeLocalizedRepairTarget(candidate)) {
          targets.add(candidate);
        }
      }
    }
  }

  return [...targets];
}

function extractInlineLocalizedRepairTarget(
  instruction: string,
  english: string
): { english: string; chineseHint: string } | null {
  const normalizedEnglish = english.trim();
  if (!normalizedEnglish || looksCodeLikeLocalFallbackTarget(normalizedEnglish)) {
    return null;
  }

  const bilingualPatterns = [
    new RegExp(`需补为[“\`]([^”\`\\n]+?)（${escapeRegExp(normalizedEnglish)}）[”\`]`, "i"),
    new RegExp(`补齐[“\`]([^”\`\\n]+?)（${escapeRegExp(normalizedEnglish)}）[”\`]`, "i")
  ];

  for (const pattern of bilingualPatterns) {
    const match = instruction.match(pattern);
    const chineseHint = normalizeLocalFallbackChineseHint(match?.[1] ?? "");
    if (chineseHint && looksLikeLocalizedRepairTarget(chineseHint)) {
      return { english: normalizedEnglish, chineseHint };
    }
  }

  const localizedTargets = extractExplicitLocalizedTargetsFromMustFix([instruction]);
  const chineseHint = localizedTargets[0];
  if (chineseHint) {
    return { english: normalizedEnglish, chineseHint };
  }

  return null;
}

function inferLocalizedRepairTargetFromLocationText(
  locationText: string,
  english: string
): { english: string; chineseHint: string } | null {
  const normalizedEnglish = english.trim();
  if (!normalizedEnglish || looksCodeLikeLocalFallbackTarget(normalizedEnglish)) {
    return null;
  }

  const quotedCandidates = [...locationText.matchAll(/[“"‘'「『]([^”"’'」』\n]{1,40})[”"’'」』]/gu)]
    .map((match) => normalizeLocalFallbackChineseHint(match[1] ?? ""))
    .filter((candidate) => candidate && looksLikeLocalizedRepairTarget(candidate));

  const shortestCandidate = quotedCandidates.sort((left, right) => left.length - right.length)[0];
  if (shortestCandidate) {
    return { english: normalizedEnglish, chineseHint: shortestCandidate };
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholePhraseInText(haystack: string, needle: string): boolean {
  if (!needle) {
    return false;
  }

  if (/[A-Za-z]/.test(needle)) {
    const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escapedNeedle}\\b`, "i").test(haystack);
  }

  return haystack.includes(needle);
}

function inferRepairTargetEnglish(
  slice: PromptSlice,
  segmentSource: string,
  instruction: string
): string | null {
  const anchorId = inferRepairAnchorId(slice, segmentSource, instruction);
  if (anchorId) {
    const anchors = [...slice.requiredAnchors, ...slice.repeatAnchors, ...slice.establishedAnchors];
    const matchedAnchor = anchors.find((anchor) => anchor.anchorId === anchorId);
    if (matchedAnchor) {
      return matchedAnchor.english;
    }
  }

  const backtickedEnglish = instruction.match(/`([^`]*[A-Za-z][^`]*)`/)?.[1]?.trim();
  if (backtickedEnglish) {
    return backtickedEnglish;
  }

  const quotedEnglish = instruction.match(/“([^”]*[A-Za-z][^”]*)”/)?.[1]?.trim();
  if (quotedEnglish) {
    return quotedEnglish;
  }

  const groupKey = inferRepairGroupKey(instruction);
  if (groupKey && /[A-Za-z]/.test(groupKey)) {
    return groupKey;
  }

  return null;
}

function extractExplicitRepairLocationText(instruction: string): string | null {
  return (
    instruction.match(/位置：\s*`([^`\n]+)`/)?.[1]?.trim() ??
    instruction.match(/位置：[^“`\n]*“([^”\n]+)”/)?.[1]?.trim() ??
    instruction.match(/位置：\s*“([^”\n]+)”/)?.[1]?.trim() ??
    instruction.match(/位置：(.+?)[。；]问题[:：]/u)?.[1]?.trim() ??
    instruction.match(/当前(?:分段)?标题“([^”]+)”/)?.[1]?.trim() ??
    instruction.match(/`([^`]+)`/)?.[1]?.trim() ??
    null
  );
}

function synthesizeLocalRepairInstruction(
  draftedSegment: DraftedSegmentState,
  slice: PromptSlice,
  audit: GateAudit,
  instruction: string
): string {
  if (inferRepairFailureType(audit, instruction) !== "missing_anchor") {
    return instruction;
  }

  const locationText = extractExplicitRepairLocationText(instruction);
  if (!locationText) {
    return instruction;
  }

  const aliasCanonicalTarget = extractAliasCanonicalRepairTarget(instruction, locationText);
  if (aliasCanonicalTarget) {
    return `位置：\`${locationText}\`。问题：首次出现的概念别名未与全文 canonical 锚定保持一致。修复目标：将“${aliasCanonicalTarget.currentText}”改为“${aliasCanonicalTarget.chineseHint}（${aliasCanonicalTarget.english}）”，并保持其余内容不变。`;
  }

  const inferredAnchorId = inferRepairAnchorId(slice, draftedSegment.segment.source, instruction);
  if (inferredAnchorId && !inferredAnchorId.startsWith("local:")) {
    return instruction;
  }

  const target = inferLocalRepairTarget(draftedSegment.segment.source, draftedSegment.restoredBody, locationText);
  if (target) {
    return `位置：\`${target.chineseHint}\`。问题：首次出现的工具/专名未完整建立中英文对照。修复目标：在该位置本身需补为“${target.chineseHint}（${target.english}）”。`;
  }

  const explicitEnglishTargets = extractExplicitEnglishTargetsFromMustFix([instruction]).filter((targetEnglish) =>
    containsWholePhraseInText(draftedSegment.segment.source, targetEnglish)
  );
  for (const englishTarget of explicitEnglishTargets) {
    const inlineTarget =
      extractInlineLocalizedRepairTarget(instruction, englishTarget) ??
      inferLocalizedRepairTargetFromLocationText(locationText, englishTarget);
    if (inlineTarget) {
      return `位置：\`${inlineTarget.chineseHint}\`。问题：首次出现的工具/专名未完整建立中英文对照。修复目标：在该位置本身需补为“${inlineTarget.chineseHint}（${inlineTarget.english}）”。`;
    }
  }

  return instruction;
}

function extractAliasCanonicalRepairTarget(
  instruction: string,
  locationText: string
): { currentText: string; chineseHint: string; english: string } | null {
  const canonicalMatch = instruction.match(/“([^”\n]+)（([^）\n]+)）”/u);
  if (!canonicalMatch?.[1] || !canonicalMatch[2]) {
    return null;
  }

  const chineseHint = canonicalMatch[1].trim();
  const english = canonicalMatch[2].trim();
  if (!chineseHint || !english) {
    return null;
  }

  const englishFragments = [...locationText.matchAll(/\b([A-Za-z][A-Za-z0-9.+/_ -]{0,79})\b/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length);

  const alias = englishFragments.find((candidate) => {
    const normalizedCandidate = candidate.toLowerCase();
    const normalizedEnglish = english.toLowerCase();
    return (
      normalizedCandidate !== normalizedEnglish &&
      normalizedEnglish.includes(normalizedCandidate)
    );
  });

  if (!alias) {
    return null;
  }

  return {
    currentText: alias,
    chineseHint,
    english
  };
}

function inferLocalRepairTarget(
  source: string,
  restoredBody: string,
  locationText: string
): { chineseHint: string; english: string } | null {
  const normalizedLocation = normalizeExplicitRepairLocationText(locationText);
  if (!normalizedLocation || /[A-Za-z]/.test(normalizedLocation)) {
    return null;
  }

  const sourceHeadingLines = extractLocalHeadingLikeLines(source);
  const translatedHeadingLines = extractLocalHeadingLikeLines(restoredBody);
  for (let index = 0; index < Math.min(sourceHeadingLines.length, translatedHeadingLines.length); index += 1) {
    const sourceHeading = sourceHeadingLines[index];
    const translatedHeading = translatedHeadingLines[index];
    if (!sourceHeading || !translatedHeading) {
      continue;
    }

    const normalizedTranslatedHeading = stripLocalMarkdownMarkers(translatedHeading.content).trim();
    if (!normalizedTranslatedHeading.includes(normalizedLocation)) {
      continue;
    }

    const english =
      extractHeadingEnglishSuffixAfterConnector(sourceHeading.content, normalizedTranslatedHeading, normalizedLocation) ??
      extractHeadingEnglishSuffixAfterColon(sourceHeading.content, normalizedTranslatedHeading, normalizedLocation) ??
      extractHeadingEnglishCoreTerm(sourceHeading.content, normalizedTranslatedHeading, normalizedLocation) ??
      null;
    if (english) {
      return {
        chineseHint: normalizeHeadingLocalRepairChineseHint(normalizedLocation),
        english
      };
    }
  }

  return null;
}

function normalizeExplicitRepairLocationText(locationText: string): string {
  return locationText
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

function normalizeHeadingLocalRepairChineseHint(chineseHint: string): string {
  return chineseHint.replace(/（[\u4e00-\u9fff\s]+）\s*$/u, "").trim();
}

type LocalHeadingLine = {
  raw: string;
  content: string;
};

function extractLocalHeadingLikeLines(text: string): LocalHeadingLine[] {
  const headings: LocalHeadingLine[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    const atxMatch = trimmed.match(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?$/);
    if (atxMatch?.[1]) {
      headings.push({ raw: rawLine, content: atxMatch[1].trim() });
      continue;
    }

    const boldMatch = trimmed.match(/^\*\*(.+)\*\*$/);
    if (boldMatch?.[1]) {
      headings.push({ raw: rawLine, content: boldMatch[1].trim() });
    }
  }

  return headings;
}

function stripLocalMarkdownMarkers(text: string): string {
  return text.replace(/[*_`~]/g, "");
}

function extractHeadingEnglishSuffixAfterConnector(
  sourceHeading: string,
  translatedHeading: string,
  chineseHint: string
): string | null {
  if (!translatedHeading.endsWith(chineseHint)) {
    return null;
  }

  const words = sourceHeading.trim().split(/\s+/);
  const connectorWords = new Set([
    "change",
    "changes",
    "changing",
    "protect",
    "protects",
    "protected",
    "requires",
    "require",
    "requiring",
    "using",
    "use",
    "with",
    "without",
    "for",
    "against",
    "into",
    "toward",
    "to"
  ]);

  for (let index = words.length - 1; index >= 0; index -= 1) {
    const normalizedWord = words[index]?.replace(/[^A-Za-z]/g, "").toLowerCase();
    if (!normalizedWord || !connectorWords.has(normalizedWord)) {
      continue;
    }

    const suffix = words.slice(index + 1).join(" ").trim();
    if (suffix && /[A-Za-z]/.test(suffix)) {
      return suffix;
    }
  }

  return null;
}

function extractHeadingEnglishSuffixAfterColon(
  sourceHeading: string,
  translatedHeading: string,
  chineseHint: string
): string | null {
  if (!translatedHeading.endsWith(chineseHint)) {
    return null;
  }

  const colonMatch = sourceHeading.match(/[:：]\s*([A-Za-z][A-Za-z0-9 .+/_-]*)$/);
  return colonMatch?.[1]?.trim() ?? null;
}

function extractHeadingEnglishCoreTerm(
  sourceHeading: string,
  translatedHeading: string,
  chineseHint: string
): string | null {
  if (!translatedHeading.includes(chineseHint) || !/[A-Za-z]/.test(sourceHeading)) {
    return null;
  }

  const strippedQualifier = sourceHeading.replace(/\s+\(([^)]*[A-Za-z][^)]*)\)\s*$/, "").trim();
  if (strippedQualifier && strippedQualifier !== sourceHeading.trim() && /^[A-Za-z][A-Za-z0-9 .+/_:-]*$/.test(strippedQualifier)) {
    return strippedQualifier;
  }

  const trimmedSource = sourceHeading.trim();
  if (/^[A-Za-z][A-Za-z0-9 .+/_:-]*$/.test(trimmedSource)) {
    return trimmedSource;
  }

  return null;
}

function buildStructuredSegmentAuditResult(
  state: TranslationRunState,
  draftedSegment: DraftedSegmentState,
  audit: GateAudit
): StateSegmentAuditResult {
  const chunkId = draftedSegment.segmentId.split("-segment-")[0] ?? `chunk-${draftedSegment.segment.index + 1}`;
  const slice = buildSegmentTaskSlice(state, chunkId, draftedSegment.segmentId);
  const expandedAudit = expandMissingAnchorMustFixes(audit);
  const filteredAudit = suppressCoveredAnchorMustFix(state, draftedSegment, slice, expandedAudit);
  const repairTasks: RepairTask[] = filteredAudit.must_fix.map((rawInstruction, index) => {
    const instruction = synthesizeLocalRepairInstruction(draftedSegment, slice, filteredAudit, rawInstruction);
    return {
      id: `${draftedSegment.segmentId}-repair-${state.repairs.length + index + 1}`,
      segmentId: draftedSegment.segmentId,
      anchorId: inferRepairAnchorId(slice, draftedSegment.segment.source, instruction),
      failureType: inferRepairFailureType(filteredAudit, instruction),
      locationLabel: inferRepairLocationLabelFromInstruction(draftedSegment.segment.source, instruction),
      instruction,
      status: "pending"
    };
  });

  return {
    segmentId: draftedSegment.segmentId,
    hardChecks: filteredAudit.hard_checks,
    repairTasks,
    rawMustFix: filteredAudit.must_fix
  };
}

function expandMissingAnchorMustFixes(audit: GateAudit): GateAudit {
  if (audit.hard_checks.first_mention_bilingual.pass) {
    return audit;
  }

  const locationHints = extractBacktickedLocationHints(audit.hard_checks.first_mention_bilingual.problem);
  if (locationHints.length === 0) {
    return audit;
  }

  const existingLocations = new Set(
    audit.must_fix.flatMap((instruction) => extractBacktickedLocationHints(instruction)).map((item) => item.toLowerCase())
  );
  const missingInstructions = locationHints
    .filter((location) => !existingLocations.has(location.toLowerCase()))
    .map(
      (location) =>
        `位置：\`${location}\`。问题：首次出现的工具/专名未完整建立中英文对照。修复目标：在该位置本身补齐首现锚定。`
    );

  if (missingInstructions.length === 0) {
    return audit;
  }

  return {
    ...audit,
    must_fix: [...audit.must_fix, ...missingInstructions]
  };
}

function extractBacktickedLocationHints(text: string): string[] {
  const matches = [...text.matchAll(/`([^`\n]+)`/g)];
  const values = matches.map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));
  return [...new Set(values)];
}

function suppressCoveredAnchorMustFix(
  state: TranslationRunState,
  draftedSegment: DraftedSegmentState,
  slice: PromptSlice,
  audit: GateAudit
): GateAudit {
  if (audit.must_fix.length === 0) {
    return audit;
  }

  const remainingMustFix = audit.must_fix.filter((instruction) => {
    const anchors = [...slice.requiredAnchors, ...slice.repeatAnchors, ...slice.establishedAnchors];
    const explicitLocationText = extractExplicitRepairLocationText(instruction);
    if (inferRepairFailureType(audit, instruction) === "missing_anchor") {
      const anchorId = inferRepairAnchorId(slice, draftedSegment.segment.source, instruction);
      if (!anchorId) {
        return hasSafeLocalFallbackAnchorTarget(draftedSegment, instruction);
      }

      if (anchorId) {
        const anchor = anchors.find((item) => item.anchorId === anchorId);
        if (
          anchor &&
          explicitLocationText &&
          !isAnchorDisplaySatisfiedAtExplicitLocation(draftedSegment, explicitLocationText, anchor)
        ) {
          return true;
        }
        if (anchor && isAnchorDisplayAlreadySatisfied(draftedSegment, anchor)) {
          return false;
        }
        if (
          anchor &&
          explicitLocationText &&
          draftedSegment.restoredBody.includes(explicitLocationText) &&
          lineSatisfiesAnchorDisplay(explicitLocationText, anchor)
        ) {
          return false;
        }
      }
    }

    const targetEnglish = inferRepairTargetEnglish(slice, draftedSegment.segment.source, instruction);
    if (!targetEnglish) {
      return true;
    }

    if (
      inferRepairFailureType(audit, instruction) === "missing_anchor" &&
      explicitLocationText &&
      draftedSegment.restoredBody.includes(explicitLocationText) &&
      hasNonDuplicateBilingualLocationText(explicitLocationText, targetEnglish)
    ) {
      return false;
    }

    const matchedAnchor = anchors.find(
      (anchor) =>
        containsWholePhraseInText(targetEnglish, anchor.english) ||
        containsWholePhraseInText(anchor.english, targetEnglish)
    );
    if (
      inferRepairFailureType(audit, instruction) === "missing_anchor" &&
      matchedAnchor &&
      isAnchorDisplayAlreadySatisfied(draftedSegment, matchedAnchor)
    ) {
      return false;
    }

    return !isAnchorCoveredByLongerPhraseInSameLocation(draftedSegment, targetEnglish);
  });

  if (remainingMustFix.length === audit.must_fix.length) {
    return audit;
  }

  const nextHardChecks = { ...audit.hard_checks };
  if (remainingMustFix.length === 0) {
    nextHardChecks.first_mention_bilingual = { pass: true, problem: "" };
  }

  return {
    hard_checks: nextHardChecks,
    must_fix: remainingMustFix
  };
}

function hasSafeLocalFallbackAnchorTarget(
  draftedSegment: DraftedSegmentState,
  instruction: string
): boolean {
  const locationText = extractExplicitRepairLocationText(instruction);
  if (!locationText) {
    return false;
  }

  return (
    inferLocalRepairTarget(draftedSegment.segment.source, draftedSegment.restoredBody, locationText) !== null
  );
}

function isAnchorDisplaySatisfiedAtExplicitLocation(
  draftedSegment: DraftedSegmentState,
  explicitLocationText: string,
  anchor: PromptSlice["requiredAnchors"][number]
): boolean {
  const restoredLine = draftedSegment.restoredBody
    .split(/\r?\n/)
    .find((line) => line.includes(explicitLocationText));

  if (!restoredLine) {
    return false;
  }

  return lineSatisfiesAnchorDisplay(restoredLine, anchor);
}

function isAnchorDisplayAlreadySatisfied(
  draftedSegment: DraftedSegmentState,
  anchor: PromptSlice["requiredAnchors"][number]
): boolean {
  const sourceLines = draftedSegment.segment.source.split(/\r?\n/);
  const translatedLines = draftedSegment.restoredBody.split(/\r?\n/);
  const firstRelevantIndex = sourceLines.findIndex((line) => lineContainsAnchorSourcePhrase(line, anchor.english));

  if (firstRelevantIndex === -1) {
    return false;
  }

  const translatedLine = translatedLines[firstRelevantIndex] ?? "";
  return lineSatisfiesAnchorDisplay(translatedLine, anchor);
}

function lineContainsAnchorSourcePhrase(sourceLine: string, english: string): boolean {
  if (containsWholePhraseInText(sourceLine, english)) {
    return true;
  }

  const normalizedEnglish = english.trim().replace(/[：:]+$/, "").trim();
  return normalizedEnglish.length > 0 && normalizedEnglish !== english && containsWholePhraseInText(sourceLine, normalizedEnglish);
}

function hasNonDuplicateBilingualLocationText(locationText: string, english: string): boolean {
  if (!containsWholePhraseInText(locationText, english)) {
    return false;
  }

  const inner = locationText.match(/（([^）]+)）/)?.[1]?.trim();
  if (!inner) {
    return false;
  }

  return inner.toLowerCase() !== english.trim().toLowerCase();
}

function isAnchorCoveredByLongerPhraseInSameLocation(
  draftedSegment: DraftedSegmentState,
  english: string
): boolean {
  const sourceLines = draftedSegment.segment.source.split(/\r?\n/);
  const translatedLines = draftedSegment.restoredBody.split(/\r?\n/);

  const relevantPairs = sourceLines
    .map((sourceLine, index) => ({ sourceLine, translatedLine: translatedLines[index] ?? "" }))
    .filter(({ sourceLine }) => containsWholeEnglishPhrase(sourceLine, english));

  if (relevantPairs.length === 0) {
    return false;
  }

  return relevantPairs.every(({ sourceLine, translatedLine }) => {
    if (hasStandaloneEnglishOccurrence(sourceLine, english)) {
      return false;
    }

    return containsLongerEnglishPhraseWithChineseAnchor(translatedLine, english);
  });
}

function hasStandaloneEnglishOccurrence(text: string, english: string): boolean {
  const escaped = escapeForRegex(english);
  return new RegExp(`\\b${escaped}\\b(?!\\s+[A-Za-z])`, "i").test(text);
}

function containsLongerEnglishPhraseWithChineseAnchor(text: string, english: string): boolean {
  if (!/[\u4e00-\u9fff]/.test(text)) {
    return false;
  }

  const escaped = escapeForRegex(english);
  const patterns = [
    new RegExp(`\\b${escaped}\\b\\s+[A-Za-z][A-Za-z0-9.+/_-]*`, "i"),
    new RegExp(`[A-Za-z][A-Za-z0-9.+/_-]*\\s+\\b${escaped}\\b`, "i")
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function containsWholeEnglishPhrase(text: string, english: string): boolean {
  const escaped = escapeForRegex(english);
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function translateProtectedChunk(
  chunk: MarkdownChunk,
  plan: MarkdownChunkPlan,
  context: ChunkTranslationContext
): Promise<ChunkTranslationResult> {
  const chunkLabel = formatChunkLabel(chunk, plan);
  const chunkPromptContext = buildChunkStylePromptContext(
    context.state,
    chunk,
    plan,
    context.sourcePathHint,
    chunk.source
  );
  const segments = splitProtectedChunkSegments(chunk.source, context.spanIndex);
  const draftedSegments: DraftedSegmentState[] = [];
  let repairCyclesUsed = 0;
  let nextLocalSpanIndex = context.nextLocalSpanIndex;
  markChunkPhase(context.state, context.chunkId, "drafting");

  for (const segment of segments) {
    if (segment.kind === "fixed") {
      continue;
    }

    const segmentId = `${context.chunkId}-segment-${segment.index + 1}`;
    const segmentPromptContext = buildSegmentPromptContext(
      context.state,
      chunk,
      plan,
      context.sourcePathHint,
      segmentId,
      segment.source
    );
    const segmentLabel =
      segments.length > 1
        ? `${chunkLabel}, segment ${segment.index + 1}/${segments.length}`
        : chunkLabel;
    const segmentResult = await translateProtectedSegment(
      segment,
      segmentId,
      plan,
      context,
      segmentPromptContext,
      segmentLabel,
      nextLocalSpanIndex
    );
    nextLocalSpanIndex += segmentResult.spans.filter((span) => span.kind === "inline_markdown_link").length;
    draftedSegments.push(segmentResult);
  }

  markChunkPhase(context.state, context.chunkId, "auditing");
  let bundledAudit = await runBundledGateAudit(
    draftedSegments,
    plan,
    context,
    chunkPromptContext,
    chunkLabel
  );

  while (
    !isBundledHardPass(bundledAudit) &&
    repairCyclesUsed < MAX_REPAIR_CYCLES &&
    bundledAudit.segments.some((audit) => audit.must_fix.length > 0)
  ) {
    repairCyclesUsed += 1;
    const failedSegmentCount = bundledAudit.segments.filter((audit) => !isHardPass(audit)).length;
    report(
      context.options,
      "repair",
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: repair cycle ${repairCyclesUsed} of ${MAX_REPAIR_CYCLES} for ${failedSegmentCount} failed segment(s).`
    );

    markChunkPhase(context.state, context.chunkId, "repairing");
    const repairedSegmentIndices = new Set<number>();
    for (const segmentAudit of bundledAudit.segments) {
      if (isHardPass(segmentAudit) || segmentAudit.must_fix.length === 0) {
        continue;
      }

      const draftedSegment = draftedSegments.find(
        (item) => item.segment.index + 1 === segmentAudit.segment_index
      );
      if (!draftedSegment) {
        throw new HardGateError(
          `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: unknown segment ${segmentAudit.segment_index} in bundled audit.`
        );
      }

      await repairDraftedSegment(
        draftedSegment,
        buildSegmentTaskSlice(context.state, context.chunkId, draftedSegment.segmentId).pendingRepairs.map(
          (task) => task.repairId
        ),
        plan,
        context,
        chunkLabel
      );
      repairedSegmentIndices.add(draftedSegment.segment.index + 1);
    }

    bundledAudit = await runPostRepairGateAudit(
      draftedSegments,
      bundledAudit,
      repairedSegmentIndices,
      plan,
      context,
      chunkPromptContext,
      chunkLabel
    );
  }

  if (!isBundledHardPass(bundledAudit)) {
    const failedSegments = bundledAudit.segments
      .filter((audit) => !isHardPass(audit))
      .map((audit) => {
        const draftedSegment = draftedSegments.find((item) => item.segment.index + 1 === audit.segment_index);
        return {
          segmentId: draftedSegment?.segmentId ?? null,
          segmentIndex: audit.segment_index,
          mustFix: audit.must_fix.length > 0 ? [...audit.must_fix] : ["hard gate failed"]
        };
      });
    const remaining = failedSegments
      .map((audit) => `segment ${audit.segmentIndex}: ${audit.mustFix.join(" | ")}`)
      .join(" || ");
    markChunkFailure(context.state, context.chunkId, {
      summary: remaining,
      segments: failedSegments
    });
    report(
      context.options,
      "audit",
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel} failed after ${repairCyclesUsed} repair cycle(s): ${remaining}`
    );
    throw new HardGateError(
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel} failed after ${repairCyclesUsed} repair cycle(s): ${remaining}`
    );
  }

  const hardPassBody = rebuildChunkFromSegmentStates(segments, draftedSegments, "restoredBody");
  markChunkPhase(context.state, context.chunkId, "completed");

  return {
    body: hardPassBody,
    repairCyclesUsed,
    gateAudit: mergeGateAudits(bundledAudit.segments),
    nextLocalSpanIndex
  };
}

async function applyFinalStylePolish(
  sourceProtectedBody: string,
  translatedBody: string,
  context: {
    cwd: string;
    executor: CodexExecutor;
    model: string;
    options: TranslateOptions;
    reasoningEffort: ReasoningEffort | undefined;
    sourceSpans: readonly ProtectedSpan[];
  }
): Promise<{ body: string; styleApplied: boolean }> {
  const reprotectableSourceSpans = context.sourceSpans.filter((span) =>
    ["link_destination", "image_destination", "autolink", "html_attribute"].includes(span.kind)
  );
  const canonicalTranslatedBody = reprotectMarkdownSpans(translatedBody, [...reprotectableSourceSpans]);
  const { protectedBody: protectedTranslatedBody, spans } = protectMarkdownSpans(canonicalTranslatedBody);
  const finalSpans = [...reprotectableSourceSpans, ...spans];
  report(context.options, "style", "Applying final style polish after all chunks passed.");
  const styleResult = await context.executor.execute(
    buildStylePolishPrompt(sourceProtectedBody, protectedTranslatedBody),
    {
      cwd: context.cwd,
      model: context.model,
      reasoningEffort: context.reasoningEffort ?? STYLE_REASONING_EFFORT,
      onStderr: (stderrChunk) => report(context.options, "style", stderrChunk.trim())
    }
  );

  try {
    const normalizedStyleText = stripAddedInlineCodeFromPlainPaths(sourceProtectedBody, styleResult.text);
    const restoredInlineStyleText = restoreInlineCodeFromSourceShape(
      sourceProtectedBody,
      normalizedStyleText
    );
    const restoredBody = restoreMarkdownSpans(restoredInlineStyleText, finalSpans);
    if (looksLikeMetaTaskResponse(restoredBody)) {
      report(
        context.options,
        "style",
        "Final style polish returned task-management or refusal text; falling back to the hard-pass translation."
      );
      return { body: translatedBody, styleApplied: false };
    }

    return { body: restoredBody, styleApplied: true };
  } catch (error) {
    if (!(error instanceof HardGateError)) {
      throw error;
    }
    report(
      context.options,
      "style",
      "Final style polish changed protected Markdown spans; falling back to the hard-pass translation."
    );
    return { body: translatedBody, styleApplied: false };
  }
}

function looksLikeMetaTaskResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const patterns = [
    /当前任务未提供.*issue/i,
    /缺少\s*GitLab\s*项目与\s*issue\s*信息/i,
    /缺少\s*GitLab\s*项目(?:信息)?/i,
    /任务必须先绑定.*issue/i,
    /按仓库内.*AGENTS\.md.*规则/i,
    /请先提供.*issue/i,
    /提供对应的项目链接和 issue 编号/i,
    /请先提供.*项目链接/i,
    /请提供对应项目链接/i,
    /无法访问\s*GitLab/i,
    /无法创建或访问项目/i,
    /回复精确短语\s*`?NO_REPO`?/i,
    /请明确回复\s*`?NO_REPO`?/i,
    /未提供所属\s*GitLab\s*项目/i,
    /Project override active/i
  ];

  return patterns.some((pattern) => pattern.test(trimmed));
}

function stripAddedInlineCodeFromPlainPaths(source: string, translated: string): string {
  const sourceInlineCodeTokens = new Set<string>();
  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1]?.trim();
    if (token) {
      sourceInlineCodeTokens.add(token);
    }
  }

  const sourceWithoutInlineCode = source.replace(/`[^`\n]+`/g, " ");
  const plainPathTokens = new Set<string>();
  const pathPattern =
    /(^|[\s(（\[-])((?:~\/|\.{1,2}\/|\/(?!\/))[A-Za-z0-9._~/-]*[A-Za-z0-9_~/-])(?=$|[\s),，。；：！？\]）-])/gm;

  for (const match of sourceWithoutInlineCode.matchAll(pathPattern)) {
    const token = match[2]?.trim();
    if (token && !sourceInlineCodeTokens.has(token)) {
      plainPathTokens.add(token);
    }
  }

  const plainCommandTokens = collectPlainCommandTokens(sourceWithoutInlineCode, sourceInlineCodeTokens);
  const plainFlagTokens = collectPlainFlagTokens(sourceWithoutInlineCode);

  let normalized = translated;
  for (const token of plainPathTokens) {
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    normalized = normalized.replace(new RegExp("`" + escapedToken + "`", "g"), token);
  }

  for (const token of plainCommandTokens) {
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    normalized = normalized.replace(new RegExp("`" + escapedToken + "`", "g"), token);
  }

  for (const token of plainFlagTokens) {
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    normalized = normalized.replace(new RegExp("`" + escapedToken + "`", "g"), token);
  }

  return normalized;
}

function restoreInlineCodeFromSourceShape(source: string, translated: string): string {
  const sourceLines = source.split(/\r?\n/);
  const translatedLines = translated.split(/\r?\n/);
  let changed = false;

  for (let index = 0; index < Math.min(sourceLines.length, translatedLines.length); index += 1) {
    const sourceLine = sourceLines[index] ?? "";
    let translatedLine = translatedLines[index] ?? "";
    const sourceInlineCodeCounts = collectInlineCodeCounts(sourceLine);
    if (sourceInlineCodeCounts.size === 0) {
      continue;
    }

    const translatedInlineCodeCounts = collectInlineCodeCounts(translatedLine);
    for (const [token, sourceCount] of sourceInlineCodeCounts.entries()) {
      let missingCount = sourceCount - (translatedInlineCodeCounts.get(token) ?? 0);
      while (missingCount > 0) {
        const restoredLine = wrapPlainOccurrenceOutsideInlineCode(translatedLine, token);
        if (restoredLine === translatedLine) {
          break;
        }
        translatedLine = restoredLine;
        missingCount -= 1;
        changed = true;
      }
    }

    translatedLines[index] = translatedLine;
  }

  return changed ? translatedLines.join("\n") : translated;
}

function normalizePackageRegistryTerminology(source: string, translated: string): string {
  if (!/\bregistr(?:y|ies)\b/i.test(source)) {
    return translated;
  }

  const hasPackageRegistryContext = /\b(npm|pip|cargo|pypi|package(?:s)?|dependenc(?:y|ies))\b/i.test(source);
  if (!hasPackageRegistryContext) {
    return translated;
  }

  const sourceLines = source.split(/\r?\n/);
  const translatedLines = translated.split(/\r?\n/);
  let changed = false;

  for (let index = 0; index < Math.min(sourceLines.length, translatedLines.length); index += 1) {
    const sourceLine = sourceLines[index] ?? "";
    const translatedLine = translatedLines[index] ?? "";
    if (!/\bregistr(?:y|ies)\b/i.test(sourceLine) || !/注册表/.test(translatedLine)) {
      continue;
    }

    let normalizedLine = translatedLine;
    normalizedLine = normalizedLine.replace(/已批准的注册表/g, "已批准的包注册源");
    normalizedLine = normalizedLine.replace(/批准的注册表/g, "批准的包注册源");
    normalizedLine = normalizedLine.replace(/包注册表/g, "包注册源");
    if (!/包注册源/.test(normalizedLine)) {
      normalizedLine = normalizedLine.replace(/注册表/g, "包注册源");
    }

    if (normalizedLine !== translatedLine) {
      translatedLines[index] = normalizedLine;
      changed = true;
    }
  }

  return changed ? translatedLines.join("\n") : translated;
}

function collectInlineCodeCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1]?.trim();
    if (!token) {
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function wrapPlainOccurrenceOutsideInlineCode(text: string, token: string): string {
  if (!token) {
    return text;
  }

  let output = "";
  let index = 0;
  let textStart = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }

    const plainSegment = text.slice(textStart, index);
    const replaced = replacePlainTokenInSegment(plainSegment, token);
    output += replaced.segment;
    if (replaced.replaced) {
      output += text.slice(index);
      return output;
    }

    let tickCount = 1;
    while (text[index + tickCount] === "`") {
      tickCount += 1;
    }

    const fence = "`".repeat(tickCount);
    const inlineStart = index;
    index += tickCount;

    let closingIndex = -1;
    while (index < text.length) {
      if (text.slice(index, index + tickCount) === fence) {
        closingIndex = index;
        break;
      }
      index += 1;
    }

    if (closingIndex < 0) {
      output += text.slice(inlineStart, inlineStart + tickCount);
      textStart = inlineStart + tickCount;
      index = textStart;
      continue;
    }

    output += text.slice(inlineStart, closingIndex + tickCount);
    index = closingIndex + tickCount;
    textStart = index;
  }

  const tail = text.slice(textStart);
  const replacedTail = replacePlainTokenInSegment(tail, token);
  output += replacedTail.segment;
  return output;
}

function replacePlainTokenInSegment(segment: string, token: string): { segment: string; replaced: boolean } {
  const index = segment.indexOf(token);
  if (index < 0) {
    return { segment, replaced: false };
  }

  return {
    segment: `${segment.slice(0, index)}\`${token}\`${segment.slice(index + token.length)}`,
    replaced: true
  };
}

function collectPlainCommandTokens(
  sourceWithoutInlineCode: string,
  sourceInlineCodeTokens: ReadonlySet<string>
): Set<string> {
  const tokens = new Set<string>();
  const lines = sourceWithoutInlineCode.split(/\r?\n/);
  let inCommandsSection = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed) || /^\*\*.+\*\*:?\s*$/.test(trimmed)) {
      inCommandsSection = /commands/i.test(trimmed);
      continue;
    }

    if (!inCommandsSection) {
      continue;
    }

    const bulletMatch = trimmed.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/);
    const body = bulletMatch?.[1]?.trim();
    if (!body) {
      continue;
    }

    const commandPhrases = extractPlainCommandPhrases(body);
    const leadingToken = body.match(/^([A-Za-z][A-Za-z0-9+._/-]*)\b/)?.[1]?.trim();
    if (leadingToken && !sourceInlineCodeTokens.has(leadingToken)) {
      tokens.add(leadingToken);
    }
    for (const phrase of commandPhrases) {
      if (!sourceInlineCodeTokens.has(phrase)) {
        tokens.add(phrase);
      }
    }
  }

  return tokens;
}

function collectPlainFlagTokens(sourceWithoutInlineCode: string): Set<string> {
  const tokens = new Set<string>();

  for (const match of sourceWithoutInlineCode.matchAll(/(^|[^\w`])(--[A-Za-z0-9][A-Za-z0-9-]*)(?=$|[^\w-])/gm)) {
    const token = match[2]?.trim();
    if (token) {
      tokens.add(token);
    }
  }

  return tokens;
}

function extractPlainCommandPhrases(body: string): string[] {
  const withoutTrailingExplanation = body.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!withoutTrailingExplanation) {
    return [];
  }

  return withoutTrailingExplanation
    .split(/\s*,\s*/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && /[A-Za-z]/.test(item));
}

type ProtectedChunkSegment = {
  kind: "fixed" | "translatable";
  index: number;
  source: string;
  separatorAfter: string;
  spans: ProtectedSpan[];
};

async function translateProtectedSegment(
  segment: ProtectedChunkSegment,
  segmentId: string,
  plan: MarkdownChunkPlan,
  context: ChunkTranslationContext,
  chunkPromptContext: ChunkPromptContext,
  chunkLabel: string,
  localSpanStartIndex: number
): Promise<DraftedSegmentState> {
  let threadId: string | undefined;
  const localFormatting = protectSegmentFormattingSpans(segment.source, localSpanStartIndex);
  const protectedSource = localFormatting.protectedBody;
  const combinedSpans = [...localFormatting.spans, ...segment.spans];

  report(
    context.options,
    "draft",
    `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: starting translation with model ${context.draftModel}.`
  );
  const draftResult = await context.executor.execute(
    withChunkContext(buildInitialPrompt(protectedSource), chunkPromptContext),
    {
      cwd: context.cwd,
      model: context.draftModel,
      reasoningEffort: context.draftReasoningEffort,
      reuseSession: true,
      onStderr: (stderrChunk) =>
        reportChunkProgress(context.options, "draft", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
    }
  );
  threadId = draftResult.threadId;
  const normalizedDraftText = normalizeSegmentAnchorText(
    stripAddedInlineCodeFromPlainPaths(protectedSource, draftResult.text),
    chunkPromptContext.stateSlice
  );
  const injectedDraftText = injectPlannedAnchorText(
    protectedSource,
    normalizedDraftText,
    chunkPromptContext.stateSlice
  );
  const headingPlanningSlice = buildSegmentTaskSlice(context.state, context.chunkId, segmentId, {
    currentRestoredBody: injectedDraftText
  });
  const normalizedHeadingDraftText = normalizeHeadingLikeAnchorText(
    protectedSource,
    injectedDraftText,
    headingPlanningSlice
  );
  const normalizedSurfaceDraftText = normalizeSourceSurfaceAnchorText(
    protectedSource,
    normalizedHeadingDraftText,
    headingPlanningSlice
  );
  const normalizedRegistryDraftText = normalizePackageRegistryTerminology(
    protectedSource,
    normalizedSurfaceDraftText
  );
  const emphasisPlannedDraftText = applyEmphasisPlanTargets(
    protectedSource,
    normalizedRegistryDraftText,
    headingPlanningSlice
  );
  const restoredInlineDraftText = restoreInlineCodeFromSourceShape(
    protectedSource,
    emphasisPlannedDraftText
  );
  const canonicalProtectedBody = reprotectMarkdownSpans(restoredInlineDraftText, combinedSpans);
  const restoredBody = restoreMarkdownSpans(canonicalProtectedBody, combinedSpans);
  applySegmentDraft(context.state, segmentId, {
    protectedSource,
    protectedBody: canonicalProtectedBody,
    restoredBody,
    ...(threadId ? { threadId } : {})
  });

  return {
    segment,
    segmentId,
    promptContext: chunkPromptContext,
    protectedSource,
    protectedBody: canonicalProtectedBody,
    restoredBody,
    spans: combinedSpans,
    ...(threadId ? { threadId } : {})
  };
}

async function repairDraftedSegment(
  draftedSegment: DraftedSegmentState,
  repairTaskIds: readonly string[],
  plan: MarkdownChunkPlan,
  context: ChunkTranslationContext,
  chunkLabel: string
): Promise<void> {
  const repairTasks = repairTaskIds
    .map((repairId) => context.state.repairs.find((item) => item.id === repairId))
    .filter((task): task is RepairTask => task !== undefined && task.status === "pending");
  const repairTaskBatches = splitRepairTaskBatches(context.state, repairTasks, MAX_MUST_FIX_PER_REPAIR_CALL);
  const chunk = plan.chunks.find((item) => `chunk-${item.index + 1}` === context.chunkId);
  if (!chunk) {
    throw new HardGateError(`Missing chunk ${context.chunkId} while repairing segment ${draftedSegment.segmentId}.`);
  }

  for (const [batchIndex, taskBatch] of repairTaskBatches.entries()) {
    const mustFixBatch = taskBatch.map((task) => task.instruction);
    const repairPromptContext = buildRepairPromptContext(
      buildSegmentPromptContext(
        context.state,
        chunk,
        plan,
        context.sourcePathHint,
        draftedSegment.segmentId,
        draftedSegment.segment.source
      ),
      mustFixBatch
    );
    const batchSuffix =
      repairTaskBatches.length > 1 ? `，修复批次 ${batchIndex + 1}/${repairTaskBatches.length}` : "";
    report(
      context.options,
      "repair",
      `Chunk ${draftedSegment.promptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}, segment ${draftedSegment.segment.index + 1}: repairing failed segment${batchSuffix}.`
    );
    const repairResult = await context.executor.execute(
      withChunkContext(
        buildRepairPrompt(draftedSegment.protectedSource, draftedSegment.protectedBody, mustFixBatch),
        repairPromptContext
      ),
      {
        cwd: context.cwd,
        model: context.postDraftModel,
        reasoningEffort: context.postDraftReasoningEffort ?? REPAIR_REASONING_EFFORT,
        ...(draftedSegment.threadId ? { threadId: draftedSegment.threadId } : { reuseSession: true }),
        onStderr: (stderrChunk) =>
          reportChunkProgress(
            context.options,
            "repair",
            draftedSegment.promptContext.chunkIndex - 1,
            plan,
            `${chunkLabel}, segment ${draftedSegment.segment.index + 1}${batchSuffix}`,
            stderrChunk
          )
      }
    );

    if (repairResult.threadId) {
      draftedSegment.threadId = repairResult.threadId;
    }
    const normalizedRepairText = normalizeSegmentAnchorText(
      stripAddedInlineCodeFromPlainPaths(draftedSegment.protectedSource, repairResult.text),
      buildSegmentTaskSlice(context.state, context.chunkId, draftedSegment.segmentId)
    );
    const injectedRepairText = injectPlannedAnchorText(
      draftedSegment.protectedSource,
      normalizedRepairText,
      buildSegmentTaskSlice(context.state, context.chunkId, draftedSegment.segmentId)
    );
    const headingPlanningSlice = buildSegmentTaskSlice(context.state, context.chunkId, draftedSegment.segmentId, {
      currentRestoredBody: injectedRepairText
    });
    const normalizedHeadingRepairText = normalizeHeadingLikeAnchorText(
      draftedSegment.protectedSource,
      injectedRepairText,
      headingPlanningSlice
    );
    const normalizedExplicitRepairText = normalizeExplicitRepairAnchorText(
      draftedSegment.protectedSource,
      normalizedHeadingRepairText,
      headingPlanningSlice
    );
    const normalizedSurfaceRepairText = normalizeSourceSurfaceAnchorText(
      draftedSegment.protectedSource,
      normalizedExplicitRepairText,
      headingPlanningSlice
    );
    const normalizedRegistryRepairText = normalizePackageRegistryTerminology(
      draftedSegment.protectedSource,
      normalizedSurfaceRepairText
    );
    const emphasisPlannedRepairText = applyEmphasisPlanTargets(
      draftedSegment.protectedSource,
      normalizedRegistryRepairText,
      headingPlanningSlice
    );
    const restoredInlineRepairText = restoreInlineCodeFromSourceShape(
      draftedSegment.protectedSource,
      emphasisPlannedRepairText
    );
    draftedSegment.protectedBody = reprotectMarkdownSpans(restoredInlineRepairText, draftedSegment.spans);
    draftedSegment.restoredBody = restoreMarkdownSpans(draftedSegment.protectedBody, draftedSegment.spans);
    applyRepairResult(context.state, draftedSegment.segmentId, taskBatch.map((task) => task.id), {
      protectedBody: draftedSegment.protectedBody,
      restoredBody: draftedSegment.restoredBody,
      ...(draftedSegment.threadId ? { threadId: draftedSegment.threadId } : {})
    });
  }
}

function splitRepairTaskBatches(
  state: TranslationRunState,
  tasks: readonly RepairTask[],
  batchSize: number
): RepairTask[][] {
  const normalizedBatchSize = Math.max(1, batchSize);
  const batches: RepairTask[][] = [];
  let index = 0;

  while (index < tasks.length) {
    const batch = [tasks[index]!];
    let batchFamilies = new Set<string>(
      batch
        .map((task) => task.anchorId)
        .filter((anchorId): anchorId is string => Boolean(anchorId))
        .map((anchorId) => state.anchors.find((anchor) => anchor.id === anchorId)?.familyId ?? anchorId)
    );
    index += 1;

    while (index < tasks.length) {
      const nextTask = tasks[index]!;
      const nextFamily = nextTask.anchorId
        ? state.anchors.find((anchor) => anchor.id === nextTask.anchorId)?.familyId ?? nextTask.anchorId
        : null;
      const relatedToBatch = nextFamily ? batchFamilies.has(nextFamily) : false;
      const spansMultipleLocations =
        batch.some(
          (task) => task.segmentId === nextTask.segmentId && task.locationLabel !== nextTask.locationLabel
        );
      if (batch.length >= normalizedBatchSize && !relatedToBatch && !spansMultipleLocations) {
        break;
      }

      batch.push(nextTask);
      if (nextFamily) {
        batchFamilies = new Set([...batchFamilies, nextFamily]);
      }
      index += 1;
    }

    batches.push(batch);
  }

  return batches;
}

function splitMustFixBatches(mustFix: readonly string[], batchSize: number): string[][] {
  const normalizedBatchSize = Math.max(1, batchSize);
  const batches: string[][] = [];

  let index = 0;
  while (index < mustFix.length) {
    const batch = [mustFix[index]!];
    let batchTargets = extractExplicitEnglishTargetsFromMustFix(batch);
    index += 1;

    while (index < mustFix.length) {
      const nextItem = mustFix[index]!;
      const nextTargets = extractExplicitEnglishTargetsFromMustFix([nextItem]);
      const withinBatchLimit = batch.length < normalizedBatchSize;
      const relatedToBatch =
        batchTargets.length > 0 &&
        nextTargets.length > 0 &&
        nextTargets.some((candidate) =>
          batchTargets.some((existing) => belongToSameConceptFamily(existing, candidate))
        );

      if (!withinBatchLimit && !relatedToBatch) {
        break;
      }

      batch.push(nextItem);
      batchTargets = [...new Set([...batchTargets, ...nextTargets])];
      index += 1;
    }

    batches.push(batch);
  }

  return batches;
}

function extractExplicitEnglishTargetsFromMustFix(mustFix: readonly string[]): string[] {
  const targets = new Set<string>();

  for (const item of mustFix) {
    for (const match of item.matchAll(/[“"`']([A-Za-z][A-Za-z0-9./+&:_ -]{0,79})[”"`']/g)) {
      const candidate = match[1]?.trim();
      if (!candidate) {
        continue;
      }

      if (!/[A-Za-z]/.test(candidate)) {
        continue;
      }

      targets.add(candidate);
    }

    for (const match of item.matchAll(
      /(?:核心术语|术语|英文目标|英文词|英文原名|产品名|工具名|项目名|模型名|CLI 名称|命令名|框架名|平台名|机制名|概念)\s+([A-Za-z][A-Za-z0-9./+&:_ -]{0,79}?)(?=\s*(?:首次|首现|在|需|应|未|缺少|没有|作为|并|，|。|；|：|$))/g
    )) {
      const candidate = match[1]?.trim();
      if (!candidate) {
        continue;
      }

      if (!/[A-Za-z]/.test(candidate)) {
        continue;
      }

      targets.add(candidate);
    }
  }

  return [...targets];
}

function extractConceptFamilyTargets(targets: readonly string[]): string[][] {
  const normalized = [...new Set(targets.map((item) => item.trim()).filter(Boolean))];
  const families: string[][] = [];
  const seen = new Set<string>();

  for (const base of normalized) {
    if (seen.has(base)) {
      continue;
    }

    const related = normalized.filter((candidate) => {
      if (candidate === base) {
        return true;
      }

      return belongToSameConceptFamily(base, candidate);
    });

    if (related.length < 2) {
      continue;
    }

    related.forEach((item) => seen.add(item));
    families.push(related);
  }

  return families;
}

function belongToSameConceptFamily(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(normalizedRight + " ") ||
    normalizedRight.startsWith(normalizedLeft + " ")
  );
}

function buildRepairPromptContext(
  promptContext: ChunkPromptContext,
  mustFix: readonly string[]
): ChunkPromptContext {
  const extraNotes = [...promptContext.specialNotes];
  const explicitEnglishTargets = extractExplicitEnglishTargetsFromMustFix(mustFix);
  const conceptFamilyTargets = extractConceptFamilyTargets(explicitEnglishTargets);
  const duplicatePendingAnchorGroups = collectDuplicatePendingAnchorGroups(promptContext);
  const hasQuotedSentenceLocation = mustFix.some((item) => hasSentenceLocalRepairTarget(item));
  const targetsHeadingLikeAnchor = mustFix.some(
    (item) => item.includes("标题") || item.includes("首次出现") || item.includes("中英对照")
  );
  if (
    promptContext.segmentHeadings.length > 0 &&
    promptContext.specialNotes.some((item) => item.includes("当前分段包含标题或加粗标题")) &&
    targetsHeadingLikeAnchor
  ) {
    extraNotes.push(
      `本次 must_fix 明确指向标题。必须直接修改以下标题文本本身：${promptContext.segmentHeadings.join(" | ")}。`,
      "不要把标题里的首现双语修复转移到正文其他句子；标题缺什么，就在标题里补什么。",
      "如果标题里的目标是英文产品名、工具名、项目名、模型名、CLI 名称，或以英文表达的核心概念性标题术语，而常见中文主译并不稳定，修复时优先保留英文原名，并在标题本身补最小必要的中文说明或类属锚定；不要只把标题其他部分翻成中文，却让这个英文专名或核心概念继续裸露未锚定。"
    );

    if (promptContext.segmentHeadings.some((heading) => /[/／]/.test(heading))) {
      extraNotes.push(
        "如果标题里有用 / 连接的并列平台名、系统名、工具名或范围限定语，修复时必须在标题本身完整保留这组并列结构，不要删掉任何一侧，也不要把其中一侧挪到正文。",
        "这类并列标签若需要补首现双语，应在标题里为整组并列范围补自然的中文说明或锚定，不要只补其中一个英文项，也不要把说明转移到标题后面的段落。",
        "对 `A/B` 这类并列英文标签，优先保留整组英文原名，再在整组后面补一个整体中文说明词，例如“平台”“系统”“工具”或等价表达；不要把它改成英文重复括注，也不要拆成两处分别补。"
      );
    }

    if (promptContext.specialNotes.some((item) => item.includes("当前分段包含列表前的说明句"))) {
      extraNotes.push(
        "如果当前分段的结构是“冒号引导句或说明句 + 下一行加粗标题/标题 + 后续列表”，而 must_fix 指向的是该标题中的首现双语缺失，必须直接在这个标题本身补齐锚定；不要把修复转移到前面的引导句，也不要只在后面的列表项里补一次。",
        "对这类结构里的核心概念性英文标题，例如分类名、能力名、隔离/限制/保护等机制名称，修复目标应是标题本身的最小自然双语形式，例如“中文标题（English Term）”或等价表达；不要只保留中文标题。"
      );
    }

    if (
      promptContext.segmentHeadings.some(
        (heading) =>
          /^[A-Za-z][A-Za-z0-9 ]{0,30}\d+\s*:\s*[A-Za-z]/.test(heading) ||
          /^[A-Za-z][A-Za-z0-9 ]{0,30}\s*:\s*[A-Za-z]/.test(heading)
      )
    ) {
      extraNotes.push(
        "如果标题本身带有编号标签、测试标签、步骤标签、示例标签或其他冒号前导部分，例如 `Test 2: ...`、`Step 1: ...`、`Example: ...`，修复时必须在这一整行标题里同时保留前导标签和后面的核心英文术语锚点。",
        "不要只把冒号后的英文核心术语翻成中文而漏掉英文原名，也不要把英文锚点挪到下一句、后面的解释段或列表项里；这类标题的正确落点就是标题本身。",
        "对这类标题，优先保留“中文标题 + 英文术语回括”或等价的最小自然双语形式，同时完整保留 `Test 2`、`Step 1`、`Example` 这类前导结构。"
      );
    }
  }

  if (
    promptContext.specialNotes.some((item) => item.includes("当前分段包含列表项")) &&
    mustFix.some((item) => item.includes("条目") || item.includes("项目符号") || item.includes("列表项"))
  ) {
    extraNotes.push(
      "本次 must_fix 明确指向列表项或项目符号。必须直接修改对应的列表项文本本身，不要把缺失的首现双语转移到列表前后的说明段落里。",
      "如果 must_fix 指向多个列表项，要逐条在各自的列表项里补齐；不要只在列表标题、段首总结句或其他项目符号里补一次。",
      "如果 must_fix 点名的是某个列表项里的核心英文概念、术语或英文短语，就必须在该列表项本身保留这个英文原名并补自然中文锚定；不要只保留同一列表项括号里的另一个英文专名、品牌名、缩写或解释来冒充“已修复”。",
      "对“概念名（解释）”“中文概念（英文原名）”或带括号说明的列表项，修复时要分清主锚定对象和括号说明：被 must_fix 点名的核心概念必须在这一条列表项里直接补齐，不能因为括号里还有别的英文词就省略它。"
    );
  }

  if (
    promptContext.specialNotes.some((item) => item.includes("当前分段包含列表前的说明句")) &&
    mustFix.some((item) => item.includes("中文说明") || item.includes("英文缩写") || item.includes("首次出现"))
  ) {
    extraNotes.push(
      "本次 must_fix 明确指向列表前的说明句、导语句或冒号引导句。必须直接修改对应引导句本身，不要把缺失的首现双语或中文说明转移到后面的列表项里。",
      "如果 must_fix 指向引导句中的英文缩写、包名、命令名、产品名或术语，优先在同一句里补自然的中文说明，并保持这一句仍然是后续列表的引导句。"
    );
  }

  if (
    mustFix.some((item) => item.includes("当前句") || item.includes("该句")) &&
    mustFix.some((item) => item.includes("首次出现") || item.includes("中英对照") || item.includes("中文说明"))
  ) {
    extraNotes.push(
      "本次 must_fix 明确指向当前句或该句的正文说明。必须直接在这同一句本身补齐缺失的首现中英文对照或中文说明，不要把修复转移到同一分段的前一句、后一句、标题、列表项或总结句里。",
      "如果目标术语、缩写、包名、命令名、产品名或概念出现在这句正文里，应在保持原句论证关系和语气的前提下就地补自然的中文锚定，不要只修同段别处。"
    );
  }

  if (
    mustFix.some((item) => /第\d+段/.test(item)) &&
    mustFix.some((item) => item.includes("首次出现") || item.includes("中英文") || item.includes("中英对照"))
  ) {
    extraNotes.push(
      "本次 must_fix 明确点名了某一具体段落。必须直接在被点名的那一段本身补齐缺失的首现中英文对照或中文说明，不要把锚定转移到同分段的其他段、标题、引用外说明、列表项或后续小节里。",
      "如果 must_fix 已经写明“第N段”或直接摘录了该段原句，修复时应把该段视为唯一有效落点：被点名的英文术语、产品名、概念名或机制名，必须在这段对应中文词处就地补齐英文原名或中文说明。"
    );
  }

  if (hasQuotedSentenceLocation) {
    extraNotes.push(
      "本次 must_fix 已经通过“位置：……“某句””的形式明确摘录了具体句子。修复时必须把这句视为唯一有效落点，在这同一句本身补齐缺失的首现中英文对照或中文说明。",
      "即使 must_fix 外层写的是“第N段”或正文段落，也不要把锚定转移到同段其他句子、标题、列表项、引用外说明或后续段落；被摘录的那一句就是修复目标。"
    );
  }

  if (
    promptContext.specialNotes.some((item) => item.includes("当前分段包含引用段落")) &&
    mustFix.some((item) => item.includes("引用段")) &&
    mustFix.some((item) => item.includes("首次出现") || item.includes("中英文") || item.includes("中英对照"))
  ) {
    extraNotes.push(
      "本次 must_fix 明确指向引用段中的句子。必须直接在对应引用句本身补齐缺失的首现中英文对照或中文说明，不要把锚定转移到引用外的标题、正文、列表项或后续小节里。",
      "如果 must_fix 点名了引用段中的英文术语、机制名、产品名或概念，例如 Sandbox、Prompt injection、Supply chain attacks 等，修复时必须在该引用句里的对应中文词处就地补齐英文原名；不要把英文锚点延后到后文标题或下一段第一次出现的位置。"
    );
  }

  if (explicitEnglishTargets.length > 0) {
    extraNotes.push(
      `本次 must_fix 明确点名了这些英文目标：${explicitEnglishTargets.join(" / ")}。`,
      "只要 must_fix 已经点名某个英文词、命令名、语言名、包名、平台名或术语，即使它看起来是常见技术词，也必须严格按 must_fix 要求修复，不能因为“太常见”就省略首现锚定。",
      "修复时必须在对应的标题、当前句、列表项或被点名位置本身保留这个英文原名，并补最小必要的中文说明；不要只译成中文，也不要把锚定转移到别处。"
    );
  }

  if (conceptFamilyTargets.length > 0) {
    extraNotes.push(
      `本次 must_fix 里存在同一概念家族的多个英文目标：${conceptFamilyTargets
        .map((family) => family.join(" / "))
        .join(" ; ")}。`,
      "对同一概念家族里的 base term 和 extended term，必须把它们视为两个独立锚点分别修复；不能因为已经补了较短词组，就省略较长词组，反之亦然。",
      "如果 must_fix 同时点名了引用句里的短概念和说明句/引导句里的扩展概念，修复时要在各自被点名的位置分别补齐，不要把其中一个锚点挪去充当另一个。"
    );
  }

  if (duplicatePendingAnchorGroups.length > 0) {
    extraNotes.push(
      `当前分段里同一锚点在多个被点名位置仍未修齐：${duplicatePendingAnchorGroups
        .map((group) => group.join(" / "))
        .join(" ; ")}。`,
      "即使本批 must_fix 只展示其中一条，也要结合状态切片里同一锚点的其他待修任务，逐个在各自被点名的句子、引用句、标题或列表项本身补齐。",
      "不要因为其中一处已经补过英文原名或中文说明，就把另一处视为已完成；同一锚点的多个落点需要分别达标。"
    );
  }

  if (
    mustFix.some(
      (item) =>
        item.includes("重复回括") ||
        item.includes("重复括注") ||
        item.includes("重复回注") ||
        item.includes("重复同一英文")
    )
  ) {
    extraNotes.push(
      "本次 must_fix 明确指出英文原名出现了重复回括或重复括注。修复时同一个英文原名在同一个首现锚点里只能保留一次，不要再生成“中文说明（同一英文原名）”或等价的重复回括格式。",
      "如果要为英文原名补中文说明，优先使用自然的单次锚定形式，例如“English（中文说明）”“English + 中文说明”或其他只保留一次英文原名的写法；不要把同一个英文词先写进正文，又在括号里重复一次。"
    );
  }

  if (
    mustFix.some(
      (item) =>
        item.includes("双层括号") ||
        item.includes("嵌套格式") ||
        item.includes("单层括注") ||
        item.includes("不嵌套")
    )
  ) {
    extraNotes.push(
      "本次 must_fix 明确指出当前写法出现了双层括号或嵌套括注。修复时如果原句、列表项或标题里本来就已经有一层括注说明，必须在这一层括注内部完成中英锚定，不要再额外套第二层括号。",
      "对这类已有括注的首现锚定，优先改成单层括注里的并列说明，例如“（中文说明，English）”“（English，中文说明）”或等价的单层形式；不要生成“（中文（English））”或任何双层括号格式。"
    );
  }

  if (
    mustFix.some(
      (item) =>
        item.includes("inline code") ||
        item.includes("反引号") ||
        item.includes("Markdown 结构")
    )
  ) {
    extraNotes.push(
      "本次 must_fix 明确指出当前译文擅自把原文普通文本改成了 inline code。修复时如果原文中的路径、目录名、文件名、URL 片段或命令样式文本本来没有反引号，就必须保持普通文本结构，不要新增反引号或把它们包成 inline code。",
      "对列表项里的 `~/.ssh/`、`~/.aws/`、`~/.config/` 这类路径，如果原文只是普通列表文本加括注说明，修复时应继续保持普通列表文本，只调整双语说明或中文解释；不要把路径本身改成代码样式。"
    );
  }

  return {
    ...promptContext,
    specialNotes: extraNotes
  };
}

export function buildRepairPromptContextForTest(
  promptContext: ChunkPromptContext,
  mustFix: readonly string[]
): ChunkPromptContext {
  return buildRepairPromptContext(promptContext, mustFix);
}

function collectDuplicatePendingAnchorGroups(promptContext: ChunkPromptContext): string[][] {
  const pendingRepairs = promptContext.stateSlice?.pendingRepairs ?? [];
  const groups = new Map<string, Set<string>>();

  for (const repair of pendingRepairs) {
    const groupKey = repair.anchorId ?? inferRepairGroupKey(repair.instruction);
    if (!groupKey) {
      continue;
    }

    const group = groups.get(groupKey) ?? new Set<string>();
    group.add(repair.locationLabel);
    group.add(repair.instruction);
    groups.set(groupKey, group);
  }

  return [...groups.values()]
    .filter((group) => group.size > 1)
    .map((group) => [...group].slice(0, 3));
}

function inferRepairGroupKey(instruction: string): string | null {
  const quotedTerm = instruction.match(/首次出现的“([^”]+)”/)?.[1]?.trim();
  if (quotedTerm) {
    return quotedTerm;
  }

  const backtickedTerm = instruction.match(/`([^`]*)`/)?.[1]?.trim();
  if (backtickedTerm) {
    return backtickedTerm;
  }

  const quotedEnglish = instruction.match(/“([^”]*[A-Za-z][^”]*)”/)?.[1]?.trim();
  if (quotedEnglish) {
    return quotedEnglish;
  }

  return null;
}

async function runBundledGateAudit(
  draftedSegments: readonly DraftedSegmentState[],
  plan: MarkdownChunkPlan,
  context: ChunkTranslationContext,
  chunkPromptContext: ChunkPromptContext,
  chunkLabel: string
): Promise<BundledGateAudit> {
  const segmentIndices = draftedSegments.map((segment) => segment.segment.index + 1);
  if (segmentIndices.length === 0) {
    return { segments: [] };
  }

  report(
    context.options,
    "audit",
    `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: running hard gate audit for ${segmentIndices.length} segment(s).`
  );

  const prompt = withChunkContextAt(
    buildBundledGateAuditPrompt(formatBundledAuditSegments(draftedSegments)),
    chunkPromptContext,
    "【分段审校输入】"
  );

  const auditResult = await context.executor.execute(prompt, {
    cwd: context.cwd,
    model: context.postDraftModel,
    reasoningEffort: context.postDraftReasoningEffort ?? AUDIT_REASONING_EFFORT,
    outputSchema: BUNDLED_GATE_AUDIT_SCHEMA,
    reuseSession: true,
    onStderr: (stderrChunk) =>
      reportChunkProgress(context.options, "audit", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
  });

  let bundledAudit: BundledGateAudit;
  try {
    bundledAudit = parseBundledGateAudit(auditResult.text, segmentIndices);
  } catch (error) {
    if (
      !(error instanceof HardGateError) ||
      !error.message.includes("Bundled gate audit segment_index set mismatch")
    ) {
      throw error;
    }

    report(
      context.options,
      "audit",
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: bundled audit returned incomplete segment results; falling back to per-segment audit.`
    );
    bundledAudit = await runFallbackSegmentAudits(
      draftedSegments,
      plan,
      context,
      chunkPromptContext,
      chunkLabel
    );
  }

  for (const segmentAudit of bundledAudit.segments) {
    validateStructuralGateChecks(segmentAudit);
    const draftedSegment = draftedSegments.find((segment) => segment.segment.index + 1 === segmentAudit.segment_index);
    if (!draftedSegment) {
      throw new HardGateError(
        `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: unknown segment ${segmentAudit.segment_index} in bundled audit.`
      );
    }
    applySegmentAudit(
      context.state,
      buildStructuredSegmentAuditResult(context.state, draftedSegment, segmentAudit)
    );
  }
  return bundledAudit;
}

async function runPostRepairGateAudit(
  draftedSegments: readonly DraftedSegmentState[],
  previousAudit: BundledGateAudit,
  repairedSegmentIndices: ReadonlySet<number>,
  plan: MarkdownChunkPlan,
  context: ChunkTranslationContext,
  chunkPromptContext: ChunkPromptContext,
  chunkLabel: string
): Promise<BundledGateAudit> {
  report(
    context.options,
    "audit",
    `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: re-running per-segment hard gate audit after repair.`
  );

  const repairedSegments = draftedSegments.filter((segment) =>
    repairedSegmentIndices.has(segment.segment.index + 1)
  );

  if (repairedSegments.length === 0) {
    return previousAudit;
  }

  const updatedAudit = await runFallbackSegmentAudits(
    repairedSegments,
    plan,
    context,
    chunkPromptContext,
    chunkLabel
  );

  const updatedByIndex = new Map(
    updatedAudit.segments.map((segmentAudit) => [segmentAudit.segment_index, segmentAudit])
  );

  return {
    segments: previousAudit.segments.map(
      (segmentAudit) => updatedByIndex.get(segmentAudit.segment_index) ?? segmentAudit
    )
  };
}

async function runFallbackSegmentAudits(
  draftedSegments: readonly DraftedSegmentState[],
  plan: MarkdownChunkPlan,
  context: ChunkTranslationContext,
  chunkPromptContext: ChunkPromptContext,
  chunkLabel: string
): Promise<BundledGateAudit> {
  const segments: IndexedGateAudit[] = [];

  for (const draftedSegment of draftedSegments) {
    const segmentLabel =
      draftedSegments.length > 1
        ? `${chunkLabel}, segment ${draftedSegment.segment.index + 1}/${draftedSegments.length}`
        : chunkLabel;
    const auditResult = await context.executor.execute(
      withChunkContext(
        buildGateAuditPrompt(draftedSegment.protectedSource, draftedSegment.protectedBody),
        draftedSegment.promptContext
      ),
      {
        cwd: context.cwd,
        model: context.postDraftModel,
        reasoningEffort: context.postDraftReasoningEffort ?? AUDIT_REASONING_EFFORT,
        outputSchema: GATE_AUDIT_SCHEMA,
        reuseSession: true,
        onStderr: (stderrChunk) =>
          reportChunkProgress(
            context.options,
            "audit",
            chunkPromptContext.chunkIndex - 1,
            plan,
            segmentLabel,
            stderrChunk
          )
      }
    );

    const audit = parseGateAudit(auditResult.text);
    validateStructuralGateChecks(audit);
    applySegmentAudit(
      context.state,
      buildStructuredSegmentAuditResult(context.state, draftedSegment, audit)
    );
    segments.push({
      segment_index: draftedSegment.segment.index + 1,
      ...audit
    });
  }

  return { segments };
}

function rebuildChunkFromSegmentStates(
  segments: readonly ProtectedChunkSegment[],
  draftedSegments: readonly DraftedSegmentState[],
  key: "protectedSource" | "protectedBody" | "restoredBody"
): string {
  return segments
    .map((segment) => {
      if (segment.kind === "fixed") {
        const content = key === "restoredBody"
          ? restoreMarkdownSpans(segment.source, segment.spans)
          : segment.source;
        return `${content}${segment.separatorAfter}`;
      }

      const drafted = draftedSegments.find((item) => item.segment.index === segment.index);
      if (!drafted) {
        throw new HardGateError(`Missing drafted segment ${segment.index + 1} while rebuilding chunk.`);
      }

      return `${drafted[key]}${segment.separatorAfter}`;
    })
    .join("");
}

function collectAccumulatedChunkSpans(
  segments: readonly ProtectedChunkSegment[],
  draftedSegments: readonly DraftedSegmentState[]
): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];

  for (const segment of segments) {
    if (segment.kind === "fixed") {
      spans.push(...segment.spans);
      continue;
    }

    const drafted = draftedSegments.find((item) => item.segment.index === segment.index);
    if (!drafted) {
      throw new HardGateError(`Missing drafted segment ${segment.index + 1} while collecting spans.`);
    }
    spans.push(...drafted.spans);
  }

  return spans;
}

function formatBundledAuditSegments(draftedSegments: readonly DraftedSegmentState[]): string {
  return draftedSegments
    .map((segment) =>
      [
        `【segment ${segment.segment.index + 1}】`,
        "【英文原文】",
        segment.protectedSource,
        "",
        "【当前译文】",
        segment.protectedBody
      ].join("\n")
    )
    .join("\n\n");
}

const MIN_SEGMENT_HEADING_SPLIT_CHARACTERS = 2600;

function splitProtectedChunkSegments(
  source: string,
  spanIndex: ReadonlyMap<string, ProtectedSpan>
): ProtectedChunkSegment[] {
  const blocks = splitRawBlocks(source).flatMap((block) => splitRawBlockOnProtectedBoundaries(block, spanIndex));
  const segments: ProtectedChunkSegment[] = [];
  let pending: Array<{ content: string; separator: string }> = [];

  const flushPending = () => {
    if (pending.length === 0) {
      return;
    }
    const lastBlock = pending.at(-1)!;
    const segmentSource = pending
      .map((block, index) =>
        index === pending.length - 1 ? block.content : `${block.content}${block.separator}`
      )
      .join("");
    const spans = collectChunkSpans(segmentSource, spanIndex);
    segments.push({
      kind: isProtectedOnlySegment(segmentSource, spans) ? "fixed" : "translatable",
      index: segments.length,
      source: segmentSource,
      separatorAfter: lastBlock.separator,
      spans
    });
    pending = [];
  };

  for (const block of blocks) {
    const blockSpans = collectChunkSpans(block.content, spanIndex);
    const blockIsProtectedOnly = isProtectedOnlySegment(block.content, blockSpans);

    if (blockIsProtectedOnly) {
      flushPending();
      pending.push(block);
      flushPending();
      continue;
    }

    if (
      isHeadingLikeBlock(block.content) &&
      pending.length > 0 &&
      measureRawBlocks(pending) >= MIN_SEGMENT_HEADING_SPLIT_CHARACTERS
    ) {
      flushPending();
    }
    pending.push(block);
  }

  flushPending();

  return segments;
}

function splitRawBlockOnProtectedBoundaries(
  block: { content: string; separator: string },
  spanIndex: ReadonlyMap<string, ProtectedSpan>
): Array<{ content: string; separator: string }> {
  const lines = block.content.split(/(?<=\n)/);
  const pieces: string[] = [];
  let current = "";

  const flushCurrent = () => {
    if (current.length > 0) {
      pieces.push(current);
      current = "";
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const span = trimmed ? spanIndex.get(trimmed) : undefined;
    const isStandaloneProtectedLine =
      !!span && (span.kind === "code_block" || span.kind === "html_block") && trimmed === line.trim();

    if (isStandaloneProtectedLine) {
      flushCurrent();
      pieces.push(line);
      continue;
    }

    current += line;
  }

  flushCurrent();

  if (pieces.length <= 1) {
    return [block];
  }

  return pieces.map((content, index) => ({
    content,
    separator: index === pieces.length - 1 ? block.separator : ""
  }));
}

function isProtectedOnlySegment(source: string, spans: readonly ProtectedSpan[]): boolean {
  if (spans.length === 0) {
    return false;
  }

  const remainder = spans.reduce((current, span) => current.split(span.id).join(""), source);
  return remainder.trim().length === 0;
}

function isHeadingLikeBlock(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (/^#{1,6}[ \t]+.+$/.test(trimmed)) {
    return true;
  }

  return /^\*\*[^*\n].+\*\*$/.test(trimmed) || /^\*\*[^*\n]+\*\*\s*(?:—|-|:).+$/.test(trimmed);
}

function splitRawBlocks(source: string): Array<{ content: string; separator: string }> {
  if (source.length === 0) {
    return [];
  }

  const blocks: Array<{ content: string; separator: string }> = [];
  const pattern = /\n{2,}/g;
  let lastIndex = 0;

  for (const match of source.matchAll(pattern)) {
    const separatorStart = match.index ?? 0;
    const content = source.slice(lastIndex, separatorStart);
    const separator = match[0];

    if (content.length === 0) {
      if (blocks.length > 0) {
        blocks[blocks.length - 1]!.separator += separator;
      }
      lastIndex = separatorStart + separator.length;
      continue;
    }

    blocks.push({ content, separator });
    lastIndex = separatorStart + separator.length;
  }

  const tail = source.slice(lastIndex);
  if (tail.length > 0 || blocks.length === 0) {
    blocks.push({ content: tail, separator: "" });
  }

  return blocks;
}

function measureRawBlocks(blocks: ReadonlyArray<{ content: string; separator: string }>): number {
  return blocks.reduce((total, block) => total + block.content.length + block.separator.length, 0);
}

function collectChunkSpans(
  source: string,
  spanIndex: ReadonlyMap<string, ProtectedSpan>,
  extraSpans: readonly ProtectedSpan[] = []
): ProtectedSpan[] {
  const placeholderPattern = /@@MDZH_[A-Z_]+_\d{4,}@@/g;
  const localSpanIndex = new Map(extraSpans.map((span) => [span.id, span]));
  const collected: ProtectedSpan[] = [];
  const seen = new Set<string>();

  const addSpan = (spanId: string) => {
    if (seen.has(spanId)) {
      return;
    }

    const span = localSpanIndex.get(spanId) ?? spanIndex.get(spanId);
    if (!span) {
      throw new HardGateError(`Protected span integrity failed: unknown placeholder ${spanId}.`);
    }

    seen.add(spanId);
    collected.push(span);

    for (const nestedSpanId of span.raw.match(placeholderPattern) ?? []) {
      addSpan(nestedSpanId);
    }
  };

  for (const spanId of [...new Set(source.match(placeholderPattern) ?? [])]) {
    addSpan(spanId);
  }

  return collected;
}

function extractSegmentHeadingHints(source: string): string[] {
  const hints: string[] = [];

  for (const block of splitRawBlocks(source)) {
    const trimmed = block.content.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const atxMatch = trimmed.match(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?$/);
    if (atxMatch?.[1]) {
      hints.push(atxMatch[1].trim());
      continue;
    }

    const boldMatch = trimmed.match(/^\*\*(.+)\*\*$/);
    if (boldMatch?.[1]) {
      hints.push(boldMatch[1].trim());
      continue;
    }

    const boldLeadMatch = trimmed.match(/^\*\*([^*\n]+)\*\*\s*(?:—|-|:)\s*(.+)$/);
    if (boldLeadMatch?.[1]) {
      hints.push(boldLeadMatch[1].trim());
    }
  }

  return hints;
}

function extractSegmentSpecialNotes(source: string): string[] {
  const notes: string[] = [];

  if (containsHeadingLikeBlock(source)) {
    notes.push(
      "当前分段包含标题或加粗标题。若标题中的关键术语、产品名、项目名或专业概念是全文首次出现，必须直接在标题本身补齐中英文对照；不要把这类修复转移到正文其他句子里。",
      "修复标题首现双语时，只补局部术语或专名本身，不要把整条标题原句附上英文，也不要只润色中文标题却遗漏必须补齐的英文锚点。"
    );
  }

  if (containsAttributionLikeBlock(source)) {
    notes.push(
      "当前分段包含图注、署名、来源、配图说明或出品归属类文本。对这类归属说明里的公司名、机构名、品牌名、作者名或媒体名，如果原文本身以英文原名、署名格式或 credit/byline 形式呈现，不要为了满足首现双语而强行创造中文主译。",
      "这类归属说明优先保留原文归属格式，可做最小必要的中文化，但不要把 `Anthropic（Anthropic）` 这类同文重复括注当作正确修复目标，也不要因为缺少中文主译就判为必须修复。"
    );
  }

  if (containsToolNameExplanationBlock(source)) {
    notes.push(
      "当前分段包含工具名、命令名、包名、CLI 名称或产品名的列表项说明。对这类以英文原名作为标签的说明条目，允许保留英文原名，并在后面直接接中文解释；不要为了满足首现双语而强行改写成“中文（英文）”主译格式。",
      "对于 `kubectl - Kubernetes cluster access`、`docker - ...`、`npm install -g ...` 这类工具/命令/产品说明，只要英文原名保留且中文解释清楚，就可视为合格的首现锚定；不要把“英文名（中文解释）”误判为必须修复。"
    );
  }

  if (containsListLikeBlock(source)) {
    notes.push(
      "当前分段包含列表项或项目符号。若列表项中的术语、产品名、命令名或其他关键专名需要补首现双语，必须直接在对应列表项本身补齐，不要把修复转移到列表前后的正文说明里。",
      "如果同一列表里有多个条目各自首次出现不同术语，要逐条补齐，不要只在列表标题、总结句或某一个项目符号里补一次。"
    );
  }

  if (containsListLeadInBlock(source)) {
    notes.push(
      "当前分段包含列表前的说明句、导语句或冒号引导句。若这类引导句本身首次出现术语、缩写、产品名、包名、命令名或其他关键专名，必须直接在该说明句本身补齐中英文对照或中文说明，不要把修复转移到后面的列表项里。",
      "这类引导句通常以冒号结束，用来引出后续列表。修复时应保留原有引导结构，只在该句内部补最小必要的首现锚定，不要改写成列表项标题，也不要把解释拆到下一行列表中。"
    );
  }

  if (containsBlockquoteBlock(source)) {
    notes.push(
      "当前分段包含引用段落或 `>` 引用句。若引用段中的术语、产品名、机制名或其他关键专名需要补首现中英文对照，必须直接在对应引用句本身补齐，不要把修复转移到引用前后的正文、标题或后续小节里。",
      "修复引用句时，应保留引用结构和原句判断关系，只在引用句内部补最小必要的英文锚点或中文说明；不要把被点名的英文术语延后到后文标题、列表项或总结句。"
    );
  }

  if (containsTranslatableMarkdownStructure(source)) {
    notes.push(
      "当前分段包含可翻译的 Markdown 强调结构或命令/flag 写法。翻译时必须保留等价结构：原文中的 **加粗**、*斜体* 等强调，不得无故去掉；像 --dangerously-skip-permissions 这类命令参数或 flag，应保留原始写法，不要改成代码块、标题、列表标签或其他 Markdown 结构。",
      "如果强调结构里的正文需要翻译，请翻译内容本身，但保留强调标记；如果命令、flag、配置键名或 CLI 参数本身是英文原名，请保留原名，只翻译周围解释。"
    );
  }

  return notes;
}

function containsAttributionLikeBlock(source: string): boolean {
  return splitRawBlocks(source).some((block) => isAttributionLikeBlock(block.content));
}

function containsHeadingLikeBlock(source: string): boolean {
  return splitRawBlocks(source).some((block) => isHeadingLikeBlock(block.content));
}

function isAttributionLikeBlock(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.includes("\n")) {
    return false;
  }

  const normalized = trimmed.replace(/^\*+|\*+$/g, "").trim();
  if (normalized.length === 0) {
    return false;
  }

  return /(?:\bfeatured image\b|\billustration\b|\bcredit\b|\bcourtesy\b|\/\s*by\b|\bby\b|来源|供图|出品|署名|配图|图注|插图|照片|制图)/i.test(
    normalized
  );
}

function containsToolNameExplanationBlock(source: string): boolean {
  return splitRawBlocks(source).some((block) => isToolNameExplanationBlock(block.content));
}

function containsListLikeBlock(source: string): boolean {
  return splitRawBlocks(source).some((block) => isListLikeBlock(block.content));
}

function containsListLeadInBlock(source: string): boolean {
  const blocks = splitRawBlocks(source);

  for (let index = 0; index < blocks.length - 1; index += 1) {
    const current = blocks[index]?.content.trim() ?? "";
    const next = blocks[index + 1]?.content ?? "";
    const nextNext = blocks[index + 2]?.content ?? "";

    if (
      current.length === 0 ||
      isHeadingLikeBlock(current) ||
      isListLikeBlock(current) ||
      !/[:：]\s*$/.test(current)
    ) {
      continue;
    }

    if (isListLikeBlock(next)) {
      return true;
    }

    if (isHeadingLikeBlock(next) && isListLikeBlock(nextNext)) {
      return true;
    }
  }

  return false;
}

function containsBlockquoteBlock(source: string): boolean {
  return splitRawBlocks(source).some((block) =>
    block.content
      .split(/\r?\n/)
      .some((line) => line.trimStart().startsWith(">"))
  );
}

function isToolNameExplanationBlock(content: string): boolean {
  return content.split(/\r?\n/).some((line) => isToolNameExplanationLine(line));
}

function isListLikeBlock(content: string): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => /^(\s*)([-*+]|\d+\.)\s+/.test(line.trimStart()));
}

function isToolNameExplanationLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- ")) {
    return false;
  }

  const body = trimmed.slice(2).trim();
  if (!/[A-Za-z]/.test(body)) {
    return false;
  }

  return /^(?:`[^`]+`|[@A-Za-z0-9._/+:-]+)\s*(?:-|—|:)\s+.+$/.test(body);
}

function containsTranslatableMarkdownStructure(source: string): boolean {
  return splitRawBlocks(source).some((block) => isTranslatableMarkdownStructureBlock(block.content));
}

function isTranslatableMarkdownStructureBlock(content: string): boolean {
  if (content.trim().length === 0) {
    return false;
  }

  return /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\n]+?\*|_[^_\n]+?_)/.test(content) || /\B--[A-Za-z0-9][A-Za-z0-9-]*/.test(content);
}

export type ChunkPromptContext = {
  documentTitle: string | null;
  headingPath: string[];
  chunkIndex: number;
  chunkCount: number;
  sourcePathHint: string;
  segmentHeadings: string[];
  headingPlanSummaries: string[];
  emphasisPlanSummaries: string[];
  analysisPlanDraft: string;
  requiredAnchors: string[];
  repeatAnchors: string[];
  establishedAnchors: string[];
  pendingRepairs: string[];
  specialNotes: string[];
  stateSlice: PromptSlice | null;
};

function withChunkContext(prompt: string, context: ChunkPromptContext): string {
  return withChunkContextAt(prompt, context, "【英文原文】");
}

function withChunkContextAt(prompt: string, context: ChunkPromptContext, marker: string): string {
  const headingPath =
    context.headingPath.length > 0 ? context.headingPath.join(" > ") : "无明确标题路径";
  const documentTitle = context.documentTitle ?? "无标题";
  const segmentHeadings =
    context.segmentHeadings.length > 0 ? context.segmentHeadings.join(" | ") : "无显式标题";
  const headingPlanSummaries =
    context.headingPlanSummaries.length > 0 ? context.headingPlanSummaries.join(" | ") : "无标题计划";
  const emphasisPlanSummaries =
    context.emphasisPlanSummaries.length > 0 ? context.emphasisPlanSummaries.join(" | ") : "无强调计划";
  const requiredAnchors = context.requiredAnchors.length > 0 ? context.requiredAnchors.join(" | ") : "无";
  const repeatAnchors = context.repeatAnchors.length > 0 ? context.repeatAnchors.join(" | ") : "无";
  const establishedAnchors =
    context.establishedAnchors.length > 0 ? context.establishedAnchors.join(" | ") : "无";
  const pendingRepairs = context.pendingRepairs.length > 0 ? context.pendingRepairs.join(" | ") : "无";
  const stateSliceJson = context.stateSlice ? JSON.stringify(context.stateSlice, null, 2) : "{}";
  const contextLines = [
    "【全文上下文】",
    `源文件提示：${context.sourcePathHint}`,
    `全文标题：${documentTitle}`,
    `当前分块：第 ${context.chunkIndex} / ${context.chunkCount} 块`,
    `当前章节路径：${headingPath}`,
    `当前分段标题：${segmentHeadings}`,
    `当前分段标题计划：${headingPlanSummaries}`,
    `当前分段强调计划：${emphasisPlanSummaries}`,
    "【当前分段 IR】",
    context.analysisPlanDraft,
    `当前分段必须建立的首现锚点：${requiredAnchors}`,
    `当前分段里已在前文建立过、禁止重复补锚的项目：${repeatAnchors}`,
    `全文已建立的锚点摘要：${establishedAnchors}`,
    `当前分段待处理的结构化修复任务：${pendingRepairs}`,
    "【状态切片(JSON)】",
    stateSliceJson,
    "说明：当前输入只覆盖全文的一部分。请保持术语、专名、语气和上下文的一致性，不要补写未出现在当前分块中的段落。",
    "requiredAnchors 表示：这些专名、产品名、项目名或关键术语必须在当前分段本身建立或保持合法的首现显示形式。",
    "如果 stateSlice.headingPlans 为某个标题给出了 targetHeading，则该标题的语义与最终目标文本由 headingPlan 决定；不要再让全局 anchor 对同一标题追加冲突的中英锚定要求。",
    "如果 headingPlan 同时给出了 governedTerms，则这些术语在对应标题里的处理方式已经由该计划决定；审校时不要再按全局 anchor 对该标题单独追加强制格式。",
    "标题场景下，headingPlan 的 targetHeading 优先于全局 anchor catalog；全局 anchor 只能为没有 targetHeading 的标题补充约束。",
    "analysisPlanDraft 是当前分段的结构化 sidecar plan。若其中某条 PLAN 已给出 source、target、display 或 strategy，请优先按这份计划执行，不要再自由改写同一结构的语义目标。",
    "如果 stateSlice.requiredAnchors 给出了 canonicalDisplay 或 allowedDisplayForms，则这些形式就是当前分段可接受的合法锚定结果；像“Claude（Anthropic 的 AI 助手）”这类英文原名（中文说明）形式，或像“Claude”这类允许裸英文首现的形式，都视为已经完成首现锚定，不得再按“缺少英文对照”判错。",
    "repeatAnchors 表示：这些项目已经在全文前文完成首现锚定，即使它们在当前分块标题、加粗标题、列表项标题或正文里是本块第一次出现，也不得再补首现中英文对照。",
    "pendingRepairs 表示：这些修复任务已经绑定到当前分段，修复时必须就地完成，不要把锚点挪到别处。",
    "如果当前分段标题、加粗标题、列表项标题里包含冒号、括号限定语、枚举标签或英文补充说明，翻译时必须完整保留这些信息，不要只保留其中一部分。"
  ].join("\n");
  const specialNotesBlock =
    context.specialNotes.length > 0
      ? `\n\n【当前分段附加规则】\n${context.specialNotes.join("\n")}`
      : "";

  return prompt.replace(marker, `${contextLines}${specialNotesBlock}\n\n${marker}`);
}

function formatChunkLabel(chunk: MarkdownChunk, plan: MarkdownChunkPlan): string {
  const label = chunk.headingPath.at(-1) ?? plan.documentTitle;
  return label ? ` (${label})` : "";
}

const SINGLE_WORD_TERM_STOPWORDS = new Set([
  "A",
  "An",
  "And",
  "As",
  "At",
  "Author",
  "Because",
  "But",
  "By",
  "Default",
  "Every",
  "For",
  "From",
  "If",
  "In",
  "Into",
  "It",
  "Its",
  "Let",
  "Member",
  "Neither",
  "Network",
  "New",
  "Once",
  "Or",
  "Safe",
  "Sandbox",
  "So",
  "That",
  "The",
  "These",
  "This",
  "Those",
  "To",
  "When",
  "Without",
  "You"
]);

function collectEstablishedTerms(sourceText: string, translatedText: string): string[] {
  const counts = new Map<string, number>();
  const anchorBoosts = new Map<string, number>();

  for (const candidate of extractBilingualAnchorCandidates(translatedText)) {
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    anchorBoosts.set(candidate, (anchorBoosts.get(candidate) ?? 0) + 3);
  }

  for (const text of [sourceText, translatedText]) {
    for (const candidate of extractTermCandidates(stripHeadingLikeBlocks(text))) {
      counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([term, count]) => shouldKeepEstablishedTerm(term, count, anchorBoosts.get(term) ?? 0))
    .sort((left, right) => {
      const leftScore = left[1] + (anchorBoosts.get(left[0]) ?? 0);
      const rightScore = right[1] + (anchorBoosts.get(right[0]) ?? 0);
      const scoreDelta = rightScore - leftScore;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return right[0].length - left[0].length;
    })
    .slice(0, 24)
    .map(([term]) => term);
}

function extractTermCandidates(text: string): string[] {
  const candidates: string[] = [];
  const properNameRegex =
    /\b(?:[A-Z]{2,}|[A-Z][A-Za-z0-9]+(?:[’'.-][A-Za-z0-9]+)*)(?:[ \t]+(?:[A-Z]{2,}|[A-Z][A-Za-z0-9]+(?:[’'.-][A-Za-z0-9]+)*)){0,4}\b/g;

  for (const match of text.matchAll(properNameRegex)) {
    const normalized = normalizeEstablishedTerm(match[0] ?? "");
    if (normalized) {
      candidates.push(normalized);
    }
  }

  return candidates;
}

function extractBilingualAnchorCandidates(text: string): string[] {
  const candidates: string[] = [];
  const bilingualRegex = /[（(]([A-Za-z][A-Za-z0-9&/+'’.,: -]{1,80})[）)]/g;

  for (const match of text.matchAll(bilingualRegex)) {
    const normalized = normalizeEstablishedTerm(match[1] ?? "");
    if (normalized) {
      candidates.push(normalized);
    }
  }

  return candidates;
}

function stripHeadingLikeBlocks(source: string): string {
  return splitRawBlocks(source)
    .filter((block) => !isHeadingLikeBlock(block.content))
    .map((block) => block.content)
    .join("\n\n");
}

function normalizeEstablishedTerm(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’.,:;!?()[\]{}<>-]+|[\s"'“”‘’.,:;!?()[\]{}<>-]+$/g, "")
    .trim();
}

function shouldKeepEstablishedTerm(term: string, count: number, anchorBoost: number): boolean {
  if (!term || term.length < 2 || term.length > 80) {
    return false;
  }

  if (term.includes("MDZH_") || term.includes("http://") || term.includes("https://") || term.includes("_")) {
    return false;
  }

  const words = term.split(/\s+/);
  if (words.length === 1) {
    if (SINGLE_WORD_TERM_STOPWORDS.has(term)) {
      return false;
    }

    return (
      count + anchorBoost >= 3 ||
      /^[A-Z]{2,}$/.test(term) ||
      /[A-Z].*[a-z]|[a-z].*[A-Z]/.test(term)
    );
  }

  return count + anchorBoost >= 3 || hasStrongEstablishedTermSignal(term);
}

function hasStrongEstablishedTermSignal(term: string): boolean {
  return (
    /[A-Z]{2,}/.test(term) ||
    /[a-z].*[A-Z]|[A-Z].*[a-z]/.test(term) ||
    /\d/.test(term) ||
    /[&/+]/.test(term)
  );
}

function mergeEstablishedTerms(previous: readonly string[], next: readonly string[]): string[] {
  const merged = [...previous];

  for (const term of next) {
    if (!merged.includes(term)) {
      merged.push(term);
    }
  }

  return merged.slice(-24);
}

function reportChunkProgress(
  options: TranslateOptions,
  stage: TranslateProgress,
  chunkIndex: number,
  plan: MarkdownChunkPlan,
  chunkLabel: string,
  message: string
): void {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }
  report(
    options,
    stage,
    `Chunk ${chunkIndex + 1}/${plan.chunks.length}${chunkLabel}: ${trimmed}`
  );
}
