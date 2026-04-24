import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDocumentAnalysisPrompt,
  buildEmphasisRecoveryAnalysisPrompt,
  buildHeadingRecoveryAnalysisPrompt,
  buildBundledGateAuditPrompt,
  buildGateAuditPrompt,
  buildInitialPrompt,
  buildRepairPrompt,
  buildStylePolishPrompt
} from "./internal/prompts/scheme-h.js";
import { DefaultCodexExecutor, type CodexExecOptions, type CodexExecResult, type CodexExecutor } from "./codex-exec.js";
import {
  applyEmphasisPlanTargets,
  applySemanticMentionPlans,
  describeAnchorDisplay,
  formatAnchorDisplay,
  injectPlannedAnchorText,
  lineSatisfiesAnchorDisplay,
  normalizeExplicitRepairAnchorText,
  normalizeHeadingLikeAnchorText,
  normalizeSourceSurfaceAnchorText,
  normalizeSegmentAnchorText
} from "./anchor-normalization.js";
import { CodexExecutionError, FormattingError, HardGateError } from "./errors.js";
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
  classifyPromptBlockKind,
  createTranslationRunState,
  getChunkSegments,
  getSegmentState,
  markChunkFailure,
  markChunkPhase,
  markSegmentStyled,
  renderTranslationIRSidecar,
  setChunkFinalBody,
  splitPromptBlocks,
  summarizePromptBlockSource,
  type AnchorCatalog,
  type AnalysisAnchor,
  type AnalysisBlockPlan,
  type AnalysisAliasPlan,
  type AnalysisEntityDisambiguationPlan,
  type AnalysisHeadingPlan,
  type AnalysisEmphasisPlan,
  type AuditCheckKey as StateAuditCheckKey,
  type ChunkSeed,
  type PromptSlice,
  type RepairFailureType,
  type RepairTask,
  type StructuredRepairTarget,
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
const DRAFT_REASONING_EFFORT = "low";
const AUDIT_REASONING_EFFORT = "low";
const ANALYSIS_REASONING_EFFORT = "low";
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
const ANALYSIS_MIN_HEADING_PLAN_COVERAGE_RATIO = 0.5;
const ANALYSIS_QUALITY_MIN_HEADING_LINES = 8;
const DRAFT_TIMEOUT_MS = 180000;
const REPAIR_TIMEOUT_MS = 120000;
const AUDIT_TIMEOUT_MS = 120000;
const STYLE_TIMEOUT_MS = 120000;
const EXECUTION_HEARTBEAT_MS = 15000;
const ANALYSIS_SHARD_MAX_ATTEMPTS = 3;
const ANALYSIS_SHARD_MAX_SPLIT_DEPTH = 2;
const ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS = 900;
const ANALYSIS_FALLBACK_SHARD_CONCURRENCY = 2;
const ANALYSIS_CACHE_SCHEMA_VERSION = 1;
const BUNDLED_AUDIT_MAX_SEGMENTS = 6;
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
  blockPlans: Array<{
    blockKind: AnalysisBlockPlan["blockKind"];
    sourceText: string;
    targetText?: string;
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
  repair_targets?: StructuredRepairTarget[];
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
  analysisCacheDir?: string;
  disableAnalysisCache?: boolean;
  checkpointDir?: string;
  disableCheckpoint?: boolean;
  /**
   * When true, a chunk that exhausts MAX_REPAIR_CYCLES with remaining
   * `must_fix` items keeps its best-effort body and the run continues to the
   * next chunk instead of throwing HardGateError. Structural failures from
   * `validateStructuralGateChecks` (protected span integrity, JSON parse,
   * etc.) still throw because the body is unrecoverable. Used by smoke runs
   * that defer final acceptance to the independent quality checker.
   */
  softGate?: boolean;
};

export type TranslateResult = {
  markdown: string;
  model: string;
  repairCyclesUsed: number;
  styleApplied: boolean;
  gateAudit: GateAudit;
  chunkCount: number;
};

let analysisImplementationFingerprintPromise: Promise<string> | null = null;

type TranslationCheckpoint = {
  schemaVersion: 1;
  cacheKey: string;
  savedAt: string;
  state: TranslationRunState;
  completedChunks: Array<{
    chunkId: string;
    body: string;
    gateAudit: GateAudit;
  }>;
  repairCyclesUsed: number;
  nextLocalSpanIndex: number;
};

const GATE_AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hard_checks", "must_fix", "repair_targets"],
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
    },
    repair_targets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "location",
          "kind",
          "currentText",
          "targetText",
          "english",
          "chineseHint",
          "forbiddenTerms",
          "sourceReferenceTexts"
        ],
        properties: {
          location: { type: "string" },
          kind: {
            type: "string",
            enum: ["anchor", "heading", "sentence", "blockquote", "list_item", "lead_in", "block", "other"]
          },
          currentText: { type: ["string", "null"] },
          targetText: { type: ["string", "null"] },
          english: { type: ["string", "null"] },
          chineseHint: { type: ["string", "null"] },
          forbiddenTerms: {
            type: ["array", "null"],
            items: { type: "string" }
          },
          sourceReferenceTexts: {
            type: ["array", "null"],
            items: { type: "string" }
          }
        }
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
        required: ["segment_index", "hard_checks", "must_fix", "repair_targets"],
        properties: {
          segment_index: { type: "integer", minimum: 1 },
          hard_checks: GATE_AUDIT_SCHEMA.properties.hard_checks,
          must_fix: GATE_AUDIT_SCHEMA.properties.must_fix,
          repair_targets: GATE_AUDIT_SCHEMA.properties.repair_targets
        }
      }
    }
  }
} as const;

const ANCHOR_CATALOG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "anchors",
    "headingPlans",
    "emphasisPlans",
    "blockPlans",
    "aliasPlans",
    "entityDisambiguationPlans",
    "ignoredTerms"
  ],
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
    blockPlans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["chunkId", "segmentId", "blockIndex", "blockKind", "sourceText", "targetText"],
        properties: {
          chunkId: { type: "string" },
          segmentId: { type: "string" },
          blockIndex: { type: "integer", minimum: 1 },
          blockKind: {
            type: "string",
            enum: ["heading", "blockquote", "list", "code", "paragraph"]
          },
          sourceText: { type: "string" },
          targetText: {
            anyOf: [{ type: "string" }, { type: "null" }]
          }
        }
      }
    },
    aliasPlans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["chunkId", "segmentId", "lineIndex", "sourceText", "currentText", "targetText", "english", "chineseHint"],
        properties: {
          chunkId: { type: "string" },
          segmentId: { type: "string" },
          lineIndex: {
            anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }]
          },
          sourceText: { type: "string" },
          currentText: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          targetText: { type: "string" },
          english: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          chineseHint: {
            anyOf: [{ type: "string" }, { type: "null" }]
          }
        }
      }
    },
    entityDisambiguationPlans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["chunkId", "segmentId", "lineIndex", "sourceText", "currentText", "targetText", "english", "forbiddenDisplays"],
        properties: {
          chunkId: { type: "string" },
          segmentId: { type: "string" },
          lineIndex: {
            anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }]
          },
          sourceText: { type: "string" },
          currentText: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          targetText: { type: "string" },
          english: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          forbiddenDisplays: {
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
  const repairTargets = data.repair_targets;
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

  const parsedRepairTargets = parseStructuredRepairTargets(repairTargets);

  return downgradeFormatterOnlyAuditIssues({
    hard_checks: hardChecks as GateAudit["hard_checks"],
    must_fix: mustFix.map((item) => normalizeAuditQuoteStyle(item.trim())).filter(Boolean),
    ...(parsedRepairTargets.length ? { repair_targets: parsedRepairTargets } : {})
  });
}

function parseStructuredRepairTargets(value: unknown): StructuredRepairTarget[] {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new HardGateError("Gate audit JSON repair_targets must be an array when present.");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new HardGateError(`Gate audit JSON repair_targets[${index}] is not an object.`);
    }

    const record = item as Record<string, unknown>;
    if (typeof record.location !== "string" || typeof record.kind !== "string") {
      throw new HardGateError(`Gate audit JSON repair_targets[${index}] is missing location or kind.`);
    }

    const target: StructuredRepairTarget = {
      location: normalizeAuditQuoteStyle(record.location.trim()),
      kind: record.kind as StructuredRepairTarget["kind"]
    };

    if (typeof record.currentText === "string" && record.currentText.trim()) {
      target.currentText = normalizeAuditQuoteStyle(record.currentText.trim());
    }
    if (typeof record.targetText === "string" && record.targetText.trim()) {
      target.targetText = normalizeAuditQuoteStyle(record.targetText.trim());
    }
    if (typeof record.english === "string" && record.english.trim()) {
      target.english = normalizeAuditQuoteStyle(record.english.trim());
    }
    if (typeof record.chineseHint === "string" && record.chineseHint.trim()) {
      target.chineseHint = normalizeAuditQuoteStyle(record.chineseHint.trim());
    }
    if (Array.isArray(record.forbiddenTerms)) {
      const forbiddenTerms = record.forbiddenTerms
        .filter((term): term is string => typeof term === "string")
        .map((term) => normalizeAuditQuoteStyle(term.trim()))
        .filter(Boolean);
      if (forbiddenTerms.length) {
        target.forbiddenTerms = forbiddenTerms;
      }
    }
    if (Array.isArray(record.sourceReferenceTexts)) {
      const sourceReferenceTexts = record.sourceReferenceTexts
        .filter((term): term is string => typeof term === "string")
        .map((term) => normalizeAuditQuoteStyle(term.trim()))
        .filter(Boolean);
      if (sourceReferenceTexts.length) {
        target.sourceReferenceTexts = sourceReferenceTexts;
      }
    }

    return target;
  });
}

function downgradeFormatterOnlyAuditIssues(audit: GateAudit): GateAudit {
  const repairTargets = audit.repair_targets ?? [];
  const paired = Array.from({ length: Math.max(audit.must_fix.length, repairTargets.length) }, (_, index) => ({
    instruction: audit.must_fix[index] ?? null,
    target: repairTargets[index] ?? null
  }));

  const kept = paired.filter(({ instruction, target }) => !isFormatterOnlyRepairIssue(instruction, target));
  const chinesePunctuationSuppressed = paired.length > kept.length;

  const hardChecks = {
    ...audit.hard_checks,
    chinese_punctuation:
      chinesePunctuationSuppressed &&
      !Object.entries(audit.hard_checks).some(
        ([key, value]) => key !== "chinese_punctuation" && value && typeof value === "object" && !(value as { pass: boolean }).pass
      )
        ? { pass: true, problem: "" }
        : audit.hard_checks.chinese_punctuation
  };

  return {
    hard_checks: hardChecks,
    must_fix: kept.map((entry) => entry.instruction).filter((item): item is string => Boolean(item)),
    ...(kept.some((entry) => entry.target) ? { repair_targets: kept.map((entry) => entry.target).filter((item): item is StructuredRepairTarget => Boolean(item)) } : {})
  };
}

function isFormatterOnlyRepairIssue(
  instruction: string | null,
  target: StructuredRepairTarget | null
): boolean {
  const text = [instruction, target?.currentText, target?.targetText, target?.location].filter(Boolean).join(" ");
  if (!text) {
    return false;
  }

  const mentionsSemanticContent =
    /中英对照|双语|首现|锚定|术语|段落顺序|protected span|占位符|数字|单位|逻辑|Network|Claude|npm|registry|GitHub|Attack|Sandbox/i.test(
      text
    );
  if (mentionsSemanticContent) {
    return false;
  }

  return /半角|全角|冒号|引号|书名号|括号|标点/u.test(text);
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

  const blockPlans = (Array.isArray(data.blockPlans) ? data.blockPlans : []).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new HardGateError(`Anchor catalog blockPlans[${index}] is not an object.`);
    }
    const plan = item as Record<string, unknown>;
    if (
      typeof plan.chunkId !== "string" ||
      typeof plan.segmentId !== "string" ||
      typeof plan.blockIndex !== "number" ||
      typeof plan.blockKind !== "string" ||
      typeof plan.sourceText !== "string"
    ) {
      throw new HardGateError(`Anchor catalog blockPlans[${index}] has an invalid shape.`);
    }

    const parsedPlan: AnalysisBlockPlan = {
      chunkId: plan.chunkId.trim(),
      segmentId: plan.segmentId.trim(),
      blockIndex: plan.blockIndex,
      blockKind: plan.blockKind as AnalysisBlockPlan["blockKind"],
      sourceText: plan.sourceText.trim()
    };

    if (typeof plan.targetText === "string" && plan.targetText.trim()) {
      parsedPlan.targetText = plan.targetText.trim();
    }

    return parsedPlan;
  });

  const aliasPlans = (Array.isArray(data.aliasPlans) ? data.aliasPlans : []).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new HardGateError(`Anchor catalog aliasPlans[${index}] is not an object.`);
    }
    const plan = item as Record<string, unknown>;
    if (
      typeof plan.chunkId !== "string" ||
      typeof plan.segmentId !== "string" ||
      typeof plan.sourceText !== "string" ||
      typeof plan.targetText !== "string"
    ) {
      throw new HardGateError(`Anchor catalog aliasPlans[${index}] has an invalid shape.`);
    }

    const parsedPlan: AnalysisAliasPlan = {
      chunkId: plan.chunkId.trim(),
      segmentId: plan.segmentId.trim(),
      sourceText: plan.sourceText.trim(),
      targetText: plan.targetText.trim()
    };

    if (typeof plan.lineIndex === "number" && Number.isInteger(plan.lineIndex) && plan.lineIndex >= 1) {
      parsedPlan.lineIndex = plan.lineIndex;
    }
    if (typeof plan.currentText === "string" && plan.currentText.trim()) {
      parsedPlan.currentText = plan.currentText.trim();
    }
    if (typeof plan.english === "string" && plan.english.trim()) {
      parsedPlan.english = plan.english.trim();
    }
    if (typeof plan.chineseHint === "string" && plan.chineseHint.trim()) {
      parsedPlan.chineseHint = plan.chineseHint.trim();
    }

    return parsedPlan;
  });

  const entityDisambiguationPlans = (
    Array.isArray(data.entityDisambiguationPlans) ? data.entityDisambiguationPlans : []
  ).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new HardGateError(`Anchor catalog entityDisambiguationPlans[${index}] is not an object.`);
    }
    const plan = item as Record<string, unknown>;
    if (
      typeof plan.chunkId !== "string" ||
      typeof plan.segmentId !== "string" ||
      typeof plan.sourceText !== "string" ||
      typeof plan.targetText !== "string"
    ) {
      throw new HardGateError(`Anchor catalog entityDisambiguationPlans[${index}] has an invalid shape.`);
    }

    const parsedPlan: AnalysisEntityDisambiguationPlan = {
      chunkId: plan.chunkId.trim(),
      segmentId: plan.segmentId.trim(),
      sourceText: plan.sourceText.trim(),
      targetText: plan.targetText.trim()
    };

    if (typeof plan.lineIndex === "number" && Number.isInteger(plan.lineIndex) && plan.lineIndex >= 1) {
      parsedPlan.lineIndex = plan.lineIndex;
    }
    if (typeof plan.currentText === "string" && plan.currentText.trim()) {
      parsedPlan.currentText = plan.currentText.trim();
    }
    if (typeof plan.english === "string" && plan.english.trim()) {
      parsedPlan.english = plan.english.trim();
    }
    if (Array.isArray(plan.forbiddenDisplays)) {
      const forbiddenDisplays = plan.forbiddenDisplays
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
      if (forbiddenDisplays.length > 0) {
        parsedPlan.forbiddenDisplays = forbiddenDisplays;
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

  return { anchors, headingPlans, emphasisPlans, blockPlans, aliasPlans, entityDisambiguationPlans, ignoredTerms };
}

function isHardPass(audit: GateAudit): boolean {
  return Object.values(audit.hard_checks).every((item) => item.pass);
}

function isBundledHardPass(audit: BundledGateAudit): boolean {
  return audit.segments.every((segment) => isHardPass(segment));
}

const STRUCTURAL_HARD_CHECKS: readonly AuditCheckKey[] = [
  "protected_span_integrity",
  "paragraph_match"
];

export function hasStructuralHardCheckFailure(audit: GateAudit): boolean {
  return STRUCTURAL_HARD_CHECKS.some((key) => !audit.hard_checks[key]?.pass);
}

const STRUCTURAL_HARD_GATE_MARKER = Symbol.for("mdzh.structuralHardGate");

function markStructuralHardGateError<E extends HardGateError>(error: E): E {
  Object.defineProperty(error, STRUCTURAL_HARD_GATE_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return error;
}

function isStructuralHardGateError(error: unknown): boolean {
  return (
    error instanceof HardGateError &&
    (error as { [STRUCTURAL_HARD_GATE_MARKER]?: boolean })[STRUCTURAL_HARD_GATE_MARKER] === true
  );
}

function validateStructuralGateChecks(audit: GateAudit): void {
  if (!audit.hard_checks.protected_span_integrity.pass) {
    const detail = audit.hard_checks.protected_span_integrity.problem || "Protected span integrity failed.";
    throw markStructuralHardGateError(new HardGateError(`Protected span integrity failed: ${detail}`));
  }
}

function report(options: TranslateOptions, stage: TranslateProgress, message: string): void {
  options.onProgress?.(message, stage);
}

async function executeStageWithTimeout(
  executor: CodexExecutor,
  prompt: string,
  execOptions: CodexExecOptions,
  meta: {
    options: TranslateOptions;
    stage: TranslateProgress;
    timeoutMs: number;
    heartbeatLabel: string;
    onHeartbeat?: (message: string) => void;
  }
): Promise<CodexExecResult> {
  const heartbeatMs = getExecutionHeartbeatMs();
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const message = `${meta.heartbeatLabel} still waiting for model response (${Date.now() - startedAt}ms elapsed).`;
    if (meta.onHeartbeat) {
      meta.onHeartbeat(message);
      return;
    }
    report(meta.options, meta.stage, message);
  }, heartbeatMs);

  try {
    return await executor.execute(prompt, {
      ...execOptions,
      timeoutMs: meta.timeoutMs
    });
  } catch (error) {
    if (error instanceof CodexExecutionError && /timed out after \d+ms\./i.test(error.message)) {
      throw new CodexExecutionError(`${meta.heartbeatLabel} timed out after ${meta.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
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

function getAnalysisMinHeadingPlanCoverageRatio(): number {
  const raw = process.env.MDZH_ANALYSIS_MIN_HEADING_PLAN_COVERAGE_RATIO?.trim();
  if (!raw) {
    return ANALYSIS_MIN_HEADING_PLAN_COVERAGE_RATIO;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : ANALYSIS_MIN_HEADING_PLAN_COVERAGE_RATIO;
}

function getAnalysisQualityMinHeadingLines(): number {
  return readPositiveIntEnv("MDZH_ANALYSIS_QUALITY_MIN_HEADING_LINES", ANALYSIS_QUALITY_MIN_HEADING_LINES);
}

function getDraftTimeoutMs(): number {
  return readPositiveIntEnv("MDZH_DRAFT_TIMEOUT_MS", DRAFT_TIMEOUT_MS);
}

function getRepairTimeoutMs(): number {
  return readPositiveIntEnv("MDZH_REPAIR_TIMEOUT_MS", REPAIR_TIMEOUT_MS);
}

function getAuditTimeoutMs(): number {
  return readPositiveIntEnv("MDZH_AUDIT_TIMEOUT_MS", AUDIT_TIMEOUT_MS);
}

function getStyleTimeoutMs(): number {
  return readPositiveIntEnv("MDZH_STYLE_TIMEOUT_MS", STYLE_TIMEOUT_MS);
}

function getExecutionHeartbeatMs(): number {
  return readPositiveIntEnv("MDZH_EXECUTION_HEARTBEAT_MS", EXECUTION_HEARTBEAT_MS);
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

function isAnalysisCacheDisabled(options: TranslateOptions): boolean {
  if (options.disableAnalysisCache) {
    return true;
  }

  const raw = process.env.MDZH_DISABLE_ANALYSIS_CACHE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveAnalysisCacheDir(cwd: string, options: TranslateOptions): string | null {
  if (isAnalysisCacheDisabled(options)) {
    return null;
  }

  const configured = options.analysisCacheDir ?? process.env.MDZH_ANALYSIS_CACHE_DIR?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
  }

  return path.join(tmpdir(), "mdzh-analysis-cache");
}

async function getAnalysisImplementationFingerprint(): Promise<string> {
  if (!analysisImplementationFingerprintPromise) {
    analysisImplementationFingerprintPromise = (async () => {
      const hasher = createHash("sha256");
      const runtimeFiles = [
        fileURLToPath(import.meta.url),
        fileURLToPath(new URL("./internal/prompts/scheme-h.js", import.meta.url)),
        fileURLToPath(new URL("./translation-state.js", import.meta.url)),
        fileURLToPath(new URL("./known-entities.js", import.meta.url)),
        fileURLToPath(new URL("./data/known_entities.json", import.meta.url))
      ];

      for (const filePath of runtimeFiles) {
        try {
          hasher.update(await readFile(filePath));
        } catch {
          hasher.update(filePath);
        }
      }

      return hasher.digest("hex");
    })();
  }

  return analysisImplementationFingerprintPromise;
}

async function buildAnalysisCacheKey(
  state: TranslationRunState,
  knownEntities: ReturnType<typeof loadKnownEntities>,
  context: Pick<ChunkTranslationContext, "postDraftModel" | "postDraftReasoningEffort" | "cwd" | "options">
): Promise<string> {
  const hasher = createHash("sha256");
  const payload = {
    schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
    implementationFingerprint: await getAnalysisImplementationFingerprint(),
    sourcePathHint: state.document.sourcePathHint,
    documentTitle: state.document.title,
    postDraftModel: context.postDraftModel,
    analysisReasoningEffort: context.postDraftReasoningEffort ?? ANALYSIS_REASONING_EFFORT,
    shardLimits: getAnalysisShardLimits(),
    shardTimeoutMs: getAnalysisShardTimeoutMs(),
    shardMaxAttempts: getAnalysisShardMaxAttempts(),
    shardMaxSplitDepth: getAnalysisShardMaxSplitDepth(),
    shardMinSplitSourceChars: getAnalysisShardMinSplitSourceChars(),
    analysisMinHeadingPlanCoverageRatio: getAnalysisMinHeadingPlanCoverageRatio(),
    analysisQualityMinHeadingLines: getAnalysisQualityMinHeadingLines(),
    chunks: state.chunks.map((chunk) => ({
      id: chunk.id,
      source: chunk.source,
      headingPath: chunk.headingPath
    })),
    segments: state.segments.map((segment) => ({
      id: segment.id,
      kind: segment.kind,
      source: segment.source,
      headingHints: segment.headingHints,
      specialNotes: segment.specialNotes
    })),
    knownEntities
  };
  hasher.update(JSON.stringify(payload));
  return hasher.digest("hex");
}

async function readAnalysisCatalogFromCache(
  cacheDir: string,
  cacheKey: string
): Promise<AnchorCatalog | null> {
  const cachePath = path.join(cacheDir, `${cacheKey}.json`);

  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as {
      schemaVersion?: number;
      cacheKey?: string;
      catalog?: AnchorCatalog;
    };

    if (
      parsed.schemaVersion !== ANALYSIS_CACHE_SCHEMA_VERSION ||
      parsed.cacheKey !== cacheKey ||
      !parsed.catalog
    ) {
      return null;
    }

    return parsed.catalog;
  } catch {
    return null;
  }
}

async function writeAnalysisCatalogToCache(
  cacheDir: string,
  cacheKey: string,
  catalog: AnchorCatalog
): Promise<string> {
  const cachePath = path.join(cacheDir, `${cacheKey}.json`);
  await mkdir(cacheDir, { recursive: true });
  const tempPath = `${cachePath}.tmp-${process.pid}`;
  await writeFile(
    tempPath,
    `${JSON.stringify(
      {
        schemaVersion: ANALYSIS_CACHE_SCHEMA_VERSION,
        cacheKey,
        createdAt: new Date().toISOString(),
        catalog
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await rename(tempPath, cachePath);
  return cachePath;
}

function isCheckpointDisabled(options: TranslateOptions): boolean {
  if (options.disableCheckpoint) {
    return true;
  }

  const raw = process.env.MDZH_DISABLE_CHECKPOINT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveCheckpointDir(cwd: string, options: TranslateOptions): string | null {
  if (isCheckpointDisabled(options)) {
    return null;
  }

  const configured = options.checkpointDir ?? process.env.MDZH_CHECKPOINT_DIR?.trim();
  if (!configured) {
    return null;
  }

  return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
}

async function buildCheckpointCacheKey(
  source: string,
  sourcePathHint: string,
  draftModel: string,
  postDraftModel: string,
  styleMode: StyleMode
): Promise<string> {
  const hasher = createHash("sha256");
  hasher.update(
    JSON.stringify({
      schemaVersion: 1,
      implementationFingerprint: await getAnalysisImplementationFingerprint(),
      source,
      sourcePathHint,
      draftModel,
      postDraftModel,
      styleMode
    })
  );
  return hasher.digest("hex");
}

async function readTranslationCheckpoint(
  checkpointDir: string,
  cacheKey: string
): Promise<TranslationCheckpoint | null> {
  const checkpointPath = path.join(checkpointDir, `${cacheKey}.json`);

  try {
    const parsed = JSON.parse(await readFile(checkpointPath, "utf8")) as TranslationCheckpoint;
    if (parsed.schemaVersion !== 1 || parsed.cacheKey !== cacheKey) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeTranslationCheckpoint(
  checkpointDir: string,
  cacheKey: string,
  checkpoint: Omit<TranslationCheckpoint, "schemaVersion" | "cacheKey" | "savedAt">
): Promise<string> {
  const checkpointPath = path.join(checkpointDir, `${cacheKey}.json`);
  const tempPath = `${checkpointPath}.tmp-${process.pid}`;
  await mkdir(checkpointDir, { recursive: true });
  await writeFile(
    tempPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        cacheKey,
        savedAt: new Date().toISOString(),
        ...checkpoint
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await rename(tempPath, checkpointPath);
  return checkpointPath;
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
  type AnalysisSegmentUnit = {
    chunkId: string;
    segmentId: string;
    sourceChars: number;
    headingCount: number;
    emphasisCount: number;
  };

  const limits = getAnalysisShardLimits();
  const shards: AnalysisShard[] = [];
  let currentUnits: AnalysisSegmentUnit[] = [];
  let sourceChars = 0;
  let headingCount = 0;
  let emphasisCount = 0;

  const flush = () => {
    if (currentUnits.length === 0) {
      return;
    }

    const chunkIds: string[] = [];
    const segmentIdsByChunk: Record<string, string[]> = {};
    for (const unit of currentUnits) {
      if (!chunkIds.includes(unit.chunkId)) {
        chunkIds.push(unit.chunkId);
      }
      segmentIdsByChunk[unit.chunkId] ??= [];
      segmentIdsByChunk[unit.chunkId]!.push(unit.segmentId);
    }

    shards.push({
      id: `analysis-shard-${shards.length + 1}`,
      index: shards.length,
      chunkIds,
      segmentIdsByChunk,
      sourceChars,
      headingCount,
      emphasisCount,
      depth: 0
    });
    currentUnits = [];
    sourceChars = 0;
    headingCount = 0;
    emphasisCount = 0;
  };

  for (const chunk of state.chunks) {
    for (const segment of getChunkSegments(state, chunk.id)) {
      const segmentSourceChars = segment.source.length;
      const segmentHeadingCount = segment.headingHints.length;
      const segmentEmphasisCount = extractTranslatableStrongEmphasisSpans(segment.source).length;
      const nextChunkCount = new Set([...currentUnits.map((unit) => unit.chunkId), chunk.id]).size;
      const nextSegmentCount = currentUnits.length + 1;
      const nextSourceChars = sourceChars + segmentSourceChars;
      const nextHeadingCount = headingCount + segmentHeadingCount;
      const nextEmphasisCount = emphasisCount + segmentEmphasisCount;
      const wouldExceed =
        currentUnits.length > 0 &&
        (nextChunkCount > limits.maxChunks ||
          nextSourceChars > limits.maxSourceChars ||
          nextHeadingCount > limits.maxHeadings ||
          nextEmphasisCount > limits.maxEmphasis ||
          wouldCreateDenseAnalysisShard(
            limits,
            nextChunkCount,
            nextSegmentCount,
            nextSourceChars,
            nextHeadingCount,
            nextEmphasisCount
          ));

      if (wouldExceed) {
        flush();
      }

      currentUnits.push({
        chunkId: chunk.id,
        segmentId: segment.id,
        sourceChars: segmentSourceChars,
        headingCount: segmentHeadingCount,
        emphasisCount: segmentEmphasisCount
      });
      sourceChars += segmentSourceChars;
      headingCount += segmentHeadingCount;
      emphasisCount += segmentEmphasisCount;
    }
  }

  flush();
  return shards;
}

function wouldCreateDenseAnalysisShard(
  limits: ReturnType<typeof getAnalysisShardLimits>,
  chunkCount: number,
  segmentCount: number,
  sourceChars: number,
  headingCount: number,
  emphasisCount: number
): boolean {
  if (segmentCount <= 1) {
    return false;
  }

  const headingSoftCap = Math.max(6, Math.ceil(limits.maxHeadings * 0.75));
  const sourceSoftCap = Math.max(2400, Math.ceil(limits.maxSourceChars * 0.6));
  const emphasisSoftCap = Math.max(2, Math.ceil(limits.maxEmphasis * 0.5));
  const compactHeadingSoftCap = Math.max(5, Math.ceil(limits.maxHeadings * 0.4));
  const compactSourceSoftCap = Math.max(2800, Math.ceil(limits.maxSourceChars * 0.38));

  if (chunkCount > 1 && (sourceChars >= 2400 || headingCount >= 4)) {
    return true;
  }

  if (headingCount >= compactHeadingSoftCap && sourceChars >= compactSourceSoftCap) {
    return true;
  }

  if (headingCount >= headingSoftCap && sourceChars >= sourceSoftCap) {
    return true;
  }

  return sourceChars >= sourceSoftCap && emphasisCount >= emphasisSoftCap;
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
  const minSegmentSplitSourceChars = Math.max(320, Math.floor(minSplitSourceChars * 0.4));

  if (shard.chunkIds.length > 1) {
    if (shard.sourceChars < minSplitSourceChars * 2) {
      return [];
    }

    const ensureViable = (children: AnalysisShard[]): AnalysisShard[] =>
      children.every((child) => child.sourceChars >= minSplitSourceChars) ? children : [];
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
  if (shard.sourceChars < minSegmentSplitSourceChars * 2) {
    return [];
  }
  const segments = getShardSegments(state, shard, chunkId);
  const segmentSplit = splitArrayBalanced(segments, (segment) => segment.source.length);
  if (!segmentSplit) {
    return [];
  }

  return segmentSplit.every((group) =>
    group.reduce((total, segment) => total + segment.source.length, 0) >= minSegmentSplitSourceChars
  )
    ? segmentSplit.map((group, index) =>
        createAnalysisShard(state, {
          id: `${shard.id}-s${index + 1}`,
          index: shard.index,
          chunkIds: [chunkId],
          segmentIdsByChunk: {
            [chunkId]: group.map((segment) => segment.id)
          },
          depth: shard.depth + 1
        })
      )
    : [];
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
    blockPlans: (catalog.blockPlans ?? []).slice(0, ANALYSIS_SUMMARY_MAX_HEADINGS).map((plan) => ({
      blockKind: plan.blockKind,
      sourceText: plan.sourceText,
      ...(plan.targetText ? { targetText: plan.targetText } : {})
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
  const compactStructure =
    Boolean(options.shard) &&
    ((options.shard?.sourceChars ?? 0) >= 2500 ||
      (options.shard?.headingCount ?? 0) >= 5 ||
      (options.shard?.chunkIds.length ?? 0) > 1);
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
            emphasisCount: options.shard.emphasisCount,
            compactStructure
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
          headingLikeLines: segment.headingHints.map((heading, index) => ({
            index: index + 1,
            sourceHeading: heading
          })),
          ...(!compactStructure
            ? {
                blockLikeBlocks: splitPromptBlocks(segment.source).map((block, index) => ({
                  index: index + 1,
                  kind: classifyPromptBlockKind(block.content),
                  sourceText: summarizePromptBlockSource(block.content)
                }))
              }
            : {}),
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
    0
  );
}

function normalizeHeadingRecoveryKey(
  chunkId: string,
  segmentId: string,
  headingIndex: number,
  sourceHeading: string
): string {
  return `${chunkId}::${segmentId}::${headingIndex}::${sourceHeading.trim().toLowerCase()}`;
}

function buildHeadingRecoveryInput(state: TranslationRunState, catalog: AnchorCatalog): string {
  const existingHeadingKeys = new Set(
    (catalog.headingPlans ?? []).map((plan) =>
      normalizeHeadingRecoveryKey(plan.chunkId, plan.segmentId, plan.headingIndex ?? 0, plan.sourceHeading)
    )
  );

  const headings = state.chunks.flatMap((chunk) =>
    getChunkSegments(state, chunk.id).flatMap((segment) =>
      segment.headingHints
        .map((sourceHeading, index) => ({
          chunkId: chunk.id,
          chunkIndex: chunk.index + 1,
          segmentId: segment.id,
          segmentIndex: segment.index + 1,
          headingPath: chunk.headingPath,
          headingIndex: index + 1,
          sourceHeading,
          segmentContext: {
            blockLikeBlocks: splitPromptBlocks(segment.source).map((block, blockIndex) => ({
              index: blockIndex + 1,
              kind: classifyPromptBlockKind(block.content),
              sourceText: summarizePromptBlockSource(block.content)
            })),
            source: segment.source
          }
        }))
        .filter(
          (heading) =>
            !existingHeadingKeys.has(
              normalizeHeadingRecoveryKey(
                heading.chunkId,
                heading.segmentId,
                heading.headingIndex,
                heading.sourceHeading
              )
            )
        )
    )
  );

  return JSON.stringify(
    {
      document: state.document,
      analysisScope: {
        mode: "heading-recovery",
        headingCount: headings.length
      },
      priorAccepted: {
        headingPlans: (catalog.headingPlans ?? []).map((plan) => ({
          chunkId: plan.chunkId,
          segmentId: plan.segmentId,
          headingIndex: plan.headingIndex ?? null,
          sourceHeading: plan.sourceHeading,
          strategy: plan.strategy,
          ...(plan.targetHeading ? { targetHeading: plan.targetHeading } : {})
        }))
      },
      headings
    }
  );
}

function normalizeEmphasisRecoveryKey(
  chunkId: string,
  segmentId: string,
  emphasisIndex: number,
  lineIndex: number,
  sourceText: string
): string {
  return `${chunkId}::${segmentId}::${emphasisIndex}::${lineIndex}::${sourceText.trim().toLowerCase()}`;
}

function buildEmphasisRecoveryInput(state: TranslationRunState, catalog: AnchorCatalog): string {
  const existingEmphasisKeys = new Set(
    (catalog.emphasisPlans ?? []).map((plan) =>
      normalizeEmphasisRecoveryKey(
        plan.chunkId,
        plan.segmentId,
        plan.emphasisIndex ?? 0,
        plan.lineIndex ?? 0,
        plan.sourceText
      )
    )
  );

  const emphasisSpans = state.chunks.flatMap((chunk) =>
    getChunkSegments(state, chunk.id).flatMap((segment) =>
      extractTranslatableStrongEmphasisSpans(segment.source)
        .map((span) => ({
          chunkId: chunk.id,
          chunkIndex: chunk.index + 1,
          segmentId: segment.id,
          segmentIndex: segment.index + 1,
          headingPath: chunk.headingPath,
          emphasisIndex: span.index,
          lineIndex: span.lineIndex,
          sourceText: span.sourceText
        }))
        .filter(
          (span) =>
            !existingEmphasisKeys.has(
              normalizeEmphasisRecoveryKey(
                span.chunkId,
                span.segmentId,
                span.emphasisIndex,
                span.lineIndex,
                span.sourceText
              )
            )
        )
    )
  );

  return JSON.stringify(
    {
      document: state.document,
      analysisScope: {
        mode: "emphasis-recovery",
        emphasisCount: emphasisSpans.length
      },
      priorAccepted: {
        emphasisPlans: (catalog.emphasisPlans ?? []).map((plan) => ({
          chunkId: plan.chunkId,
          segmentId: plan.segmentId,
          emphasisIndex: plan.emphasisIndex ?? null,
          lineIndex: plan.lineIndex ?? null,
          sourceText: plan.sourceText,
          strategy: plan.strategy,
          ...(plan.targetText ? { targetText: plan.targetText } : {}),
          ...(plan.governedTerms?.length ? { governedTerms: plan.governedTerms } : {})
        }))
      },
      emphasisSpans
    }
  );
}

function countHeadingLikeLines(state: TranslationRunState): number {
  return state.segments.reduce((count, segment) => count + segment.headingHints.length, 0);
}

function getAnalysisQualityFailure(
  state: TranslationRunState,
  discoveredCatalog: AnchorCatalog,
  mergedCatalog: AnchorCatalog
): string | null {
  const headingLikeLineCount = countHeadingLikeLines(state);
  const minHeadingLines = getAnalysisQualityMinHeadingLines();
  if (headingLikeLineCount < minHeadingLines) {
    return null;
  }

  const headingPlanCount = mergedCatalog.headingPlans?.length ?? 0;
  const minCoverageRatio = getAnalysisMinHeadingPlanCoverageRatio();
  const actualCoverageRatio = headingLikeLineCount === 0 ? 1 : headingPlanCount / headingLikeLineCount;

  if (actualCoverageRatio >= minCoverageRatio) {
    return null;
  }

  const coveragePercent = Math.round(actualCoverageRatio * 100);
  const thresholdPercent = Math.round(minCoverageRatio * 100);
  return `Analysis quality gate failed: heading plan coverage ${headingPlanCount}/${headingLikeLineCount} (${coveragePercent}%) is below the minimum ${thresholdPercent}% threshold; discovered anchors=${discoveredCatalog.anchors.length}.`;
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
      reasoningEffort: context.postDraftReasoningEffort ?? ANALYSIS_REASONING_EFFORT,
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

async function recoverHeadingPlansOnly(
  state: TranslationRunState,
  context: Pick<ChunkTranslationContext, "executor" | "postDraftModel" | "cwd" | "options" | "postDraftReasoningEffort">,
  catalog: AnchorCatalog
): Promise<AnchorCatalog> {
  const prompt = buildHeadingRecoveryAnalysisPrompt(buildHeadingRecoveryInput(state, catalog));

  report(
    context.options,
    "analyze",
    "Recovering missing heading plans with a compact heading-only pass."
  );

  const result = await context.executor.execute(prompt, {
    cwd: context.cwd,
    model: context.postDraftModel,
    reasoningEffort: context.postDraftReasoningEffort ?? ANALYSIS_REASONING_EFFORT,
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["headingPlans"],
      properties: {
        headingPlans: ANCHOR_CATALOG_SCHEMA.properties.headingPlans
      }
    },
    reuseSession: false,
    timeoutMs: Math.min(getAnalysisShardTimeoutMs(), 120000),
    onStderr: (stderrChunk) => {
      const trimmed = stderrChunk.trim();
      if (trimmed) {
        report(context.options, "analyze", trimmed);
      }
    }
  });

  const parsed = parseAnchorCatalog(
    JSON.stringify({
      anchors: [],
      headingPlans: JSON.parse(result.text).headingPlans ?? [],
      emphasisPlans: [],
      blockPlans: [],
      aliasPlans: [],
      entityDisambiguationPlans: [],
      ignoredTerms: []
    })
  );
  return normalizeDiscoveredAnchorCatalog(state, parsed);
}

async function recoverEmphasisPlansOnly(
  state: TranslationRunState,
  context: Pick<ChunkTranslationContext, "executor" | "postDraftModel" | "cwd" | "options" | "postDraftReasoningEffort">,
  catalog: AnchorCatalog
): Promise<AnchorCatalog> {
  const prompt = buildEmphasisRecoveryAnalysisPrompt(buildEmphasisRecoveryInput(state, catalog));

  report(
    context.options,
    "analyze",
    "Recovering missing emphasis plans with a compact emphasis-only pass."
  );

  const result = await context.executor.execute(prompt, {
    cwd: context.cwd,
    model: context.postDraftModel,
    reasoningEffort: context.postDraftReasoningEffort ?? ANALYSIS_REASONING_EFFORT,
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["emphasisPlans"],
      properties: {
        emphasisPlans: ANCHOR_CATALOG_SCHEMA.properties.emphasisPlans
      }
    },
    reuseSession: false,
    timeoutMs: Math.min(getAnalysisShardTimeoutMs(), 120000),
    onStderr: (stderrChunk) => {
      const trimmed = stderrChunk.trim();
      if (trimmed) {
        report(context.options, "analyze", trimmed);
      }
    }
  });

  const parsed = parseAnchorCatalog(
    JSON.stringify({
      anchors: [],
      headingPlans: [],
      emphasisPlans: JSON.parse(result.text).emphasisPlans ?? [],
      blockPlans: [],
      aliasPlans: [],
      entityDisambiguationPlans: [],
      ignoredTerms: []
    })
  );
  return normalizeDiscoveredAnchorCatalog(state, parsed);
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
    const totalHeadingLikeLines = countHeadingLikeLines(state);
    const mergedHeadingPlanCount = mergedCatalog.headingPlans?.length ?? 0;
    if (mergedHeadingPlanCount < totalHeadingLikeLines) {
      const recovered = await recoverHeadingPlansOnly(
        state,
        context,
        mergeAnchorCatalogs(formalCatalog, discoveredCatalog)
      );
      if ((recovered.headingPlans?.length ?? 0) > 0) {
        discoveredCatalog = mergeAnchorCatalogs(discoveredCatalog, recovered);
        const recoveredCatalog = mergeAnchorCatalogs(formalCatalog, discoveredCatalog);
        report(
          context.options,
          "analyze",
          `Heading-only recovery finished: ${recoveredCatalog.headingPlans?.length ?? 0}/${countHeadingLikeLines(state)} heading-like line(s).`
        );
      }
    }
    const qualityFailure = getAnalysisQualityFailure(
      state,
      discoveredCatalog,
      mergeAnchorCatalogs(formalCatalog, discoveredCatalog)
    );
    const recoveredEmphasis = await recoverEmphasisPlansOnly(
      state,
      context,
      mergeAnchorCatalogs(formalCatalog, discoveredCatalog)
    );
    if ((recoveredEmphasis.emphasisPlans?.length ?? 0) > 0) {
      discoveredCatalog = mergeAnchorCatalogs(discoveredCatalog, recoveredEmphasis);
      report(
        context.options,
        "analyze",
        `Emphasis-only recovery finished: ${discoveredCatalog.emphasisPlans?.length ?? 0} emphasis plan(s).`
      );
    }
    if (qualityFailure) {
      report(context.options, "analyze", qualityFailure);
      throw new HardGateError(qualityFailure);
    }
    return mergeAnchorCatalogs(formalCatalog, discoveredCatalog);
  } catch (error) {
    if (error instanceof HardGateError && /^Analysis quality gate failed:/u.test(error.message)) {
      throw error;
    }
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
  const debugIrPath = process.env.MDZH_DEBUG_IR_PATH?.trim();
  if (!debugStatePath && !debugIrPath) {
    return;
  }

  if (debugStatePath) {
    await mkdir(path.dirname(debugStatePath), { recursive: true });
    await writeFile(debugStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  if (debugIrPath) {
    await mkdir(path.dirname(debugIrPath), { recursive: true });
    await writeFile(debugIrPath, renderTranslationIRSidecar(state), "utf8");
  }
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
  let state = createTranslationRunState({
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
  const checkpointDir = resolveCheckpointDir(cwd, options);
  const checkpointKey = checkpointDir
    ? await buildCheckpointCacheKey(source, sourcePathHint, draftModel, postDraftModel, styleMode)
    : null;
  const completedCheckpointChunks: Array<{
    chunkId: string;
    body: string;
    gateAudit: GateAudit;
  }> = [];

  try {
    report(options, "analyze", "Analyzing document-wide anchors.");
    const knownEntities = loadKnownEntities();
    const analysisContext = {
      executor,
      postDraftModel,
      cwd,
      options,
      postDraftReasoningEffort
    } as const;
    const analysisCacheDir = resolveAnalysisCacheDir(cwd, options);
    let anchorCatalog: AnchorCatalog | null = null;

    if (analysisCacheDir) {
      const analysisCacheKey = await buildAnalysisCacheKey(state, knownEntities, analysisContext);
      const cachedCatalog = await readAnalysisCatalogFromCache(analysisCacheDir, analysisCacheKey);
      if (cachedCatalog) {
        anchorCatalog = cachedCatalog;
        report(
          options,
          "analyze",
          `Reused cached analysis catalog from ${path.join(analysisCacheDir, `${analysisCacheKey}.json`)}.`
        );
      } else {
        anchorCatalog = await analyzeDocumentForAnchors(state, analysisContext);
        const cachePath = await writeAnalysisCatalogToCache(analysisCacheDir, analysisCacheKey, anchorCatalog);
        report(options, "analyze", `Stored analysis catalog cache at ${cachePath}.`);
      }
    } else {
      anchorCatalog = await analyzeDocumentForAnchors(state, analysisContext);
    }
    applyAnchorCatalog(state, anchorCatalog);

    if (checkpointDir && checkpointKey) {
      const checkpoint = await readTranslationCheckpoint(checkpointDir, checkpointKey);
      if (checkpoint) {
        const isPrefixCheckpoint = checkpoint.completedChunks.every((entry, index) => {
          const chunk = chunkPlan.chunks[index];
          return chunk ? entry.chunkId === `chunk-${chunk.index + 1}` : false;
        });

        if (isPrefixCheckpoint) {
          state = checkpoint.state;
          repairCyclesUsed = checkpoint.repairCyclesUsed;
          nextLocalSpanIndex = checkpoint.nextLocalSpanIndex;
          completedCheckpointChunks.push(...checkpoint.completedChunks);
          for (const [index, completedChunk] of checkpoint.completedChunks.entries()) {
            const chunk = chunkPlan.chunks[index];
            if (!chunk) {
              continue;
            }
            restoredChunks.push(completedChunk.body + chunk.separatorAfter);
            gateAudits.push(completedChunk.gateAudit);
          }
          report(
            options,
            "draft",
            `Resumed translation checkpoint with ${checkpoint.completedChunks.length} completed chunk(s) from ${path.join(checkpointDir, `${checkpointKey}.json`)}.`
          );
        }
      }
    }

    for (const chunk of chunkPlan.chunks) {
      const chunkId = `chunk-${chunk.index + 1}`;
      if (completedCheckpointChunks.some((entry) => entry.chunkId === chunkId)) {
        report(options, "draft", `Skipping ${chunkId}; restored from checkpoint.`);
        continue;
      }
      let chunkResult;
      try {
        chunkResult = await translateProtectedChunk(chunk, chunkPlan, {
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
      } catch (error) {
        // Soft-gate fallback for any chunk-level error (HardGateError from
        // structural validate, repair contract failures, etc.). Preserve the
        // protected source for this chunk so the final output.md has a
        // structurally complete document, just with the failed chunk left in
        // its English / partial form. Quality checker will surface this.
        if (!options.softGate || isStructuralHardGateError(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        report(
          options,
          "audit",
          `Chunk ${chunk.index + 1}/${chunkPlan.chunks.length} (${chunk.headingPath.join(" > ") || "untitled"}): soft-gate caught chunk failure (${message}); falling back to source content.`
        );
        // Pass only spans whose placeholder ID appears in this chunk's source
        // — restoreMarkdownSpans throws if asked to restore a span absent from
        // the body, and the document-wide `spans` includes IDs from other
        // chunks.
        const chunkSpans = spans.filter((span) => chunk.source.includes(span.id));
        const fallbackBody = restoreMarkdownSpans(chunk.source, chunkSpans);
        chunkResult = {
          body: fallbackBody,
          repairCyclesUsed: 0,
          gateAudit: createSyntheticChunkFailureAudit(message),
          nextLocalSpanIndex
        };
      }

      restoredChunks.push(chunkResult.body + chunk.separatorAfter);
      gateAudits.push(chunkResult.gateAudit);
      repairCyclesUsed += chunkResult.repairCyclesUsed;
      nextLocalSpanIndex = chunkResult.nextLocalSpanIndex;
      setChunkFinalBody(state, chunkId, chunkResult.body);
      completedCheckpointChunks.push({
        chunkId,
        body: chunkResult.body,
        gateAudit: chunkResult.gateAudit
      });
      if (checkpointDir && checkpointKey) {
        const checkpointPath = await writeTranslationCheckpoint(checkpointDir, checkpointKey, {
          state,
          completedChunks: completedCheckpointChunks,
          repairCyclesUsed,
          nextLocalSpanIndex
        });
        report(options, "draft", `Updated translation checkpoint at ${checkpointPath}.`);
      }
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
    formattedBody = restoreCodeLikeSourceShape(body, formattedBody);
    formattedBody = restoreSourceShapeExampleTokens(body, formattedBody);
    formattedBody = normalizeMarkdownLinkLabelWhitespace(formattedBody);
    formattedBody = normalizeMalformedInlineEnglishEmphasis(formattedBody);
    const markdown = reconstructMarkdown(frontmatter, formattedBody);
    await writeDebugStateIfRequested(state);
    if (options.softGate) {
      const softGatedChunks = gateAudits.filter((audit) => !isHardPass(audit)).length;
      if (softGatedChunks > 0) {
        report(
          options,
          "audit",
          `⚠ Soft-gate fallback applied to ${softGatedChunks} chunk(s). Output is degraded. Re-run with --strict-gate to fail fast instead.`
        );
      }
    }
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

function createSyntheticChunkFailureAudit(message: string): GateAudit {
  return {
    hard_checks: {
      paragraph_match: { pass: false, problem: `soft-gate fallback: ${message}` },
      first_mention_bilingual: { pass: true, problem: "" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    must_fix: [`chunk fell back to source content under soft-gate: ${message}`]
  };
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

function summarizeBlockPlan(plan: PromptSlice["blockPlans"][number]): string {
  return `${plan.blockIndex}:${plan.blockKind}:${plan.sourceText}${plan.targetText ? ` -> ${plan.targetText}` : ""}`;
}

function summarizePendingRepair(task: PromptSlice["pendingRepairs"][number]): string {
  const planSummary =
    task.analysisTargets && task.analysisTargets.length > 0
      ? `；IR=${task.analysisTargets.join(" / ")}`
      : "";
  const sentenceSummary = task.sentenceConstraint
    ? `；句子约束=${[
        task.sentenceConstraint.quotedText ? `句=${task.sentenceConstraint.quotedText}` : null,
        task.sentenceConstraint.forbiddenTerms?.length
          ? `禁增=${task.sentenceConstraint.forbiddenTerms.join("/")}`
          : null,
        task.sentenceConstraint.sourceReferenceTexts?.length
          ? `原文=${task.sentenceConstraint.sourceReferenceTexts.join("/")}`
          : null
      ]
        .filter(Boolean)
        .join(" | ")}`
    : "";
  return `${task.instruction}${planSummary}${sentenceSummary}`;
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
    blockPlanSummaries: slice.blockPlans.map(summarizeBlockPlan),
    analysisPlanDraft: slice.analysisPlanDraft,
    specialNotes: extractSegmentSpecialNotes(source),
    requiredAnchors: slice.requiredAnchors.map(summarizePromptAnchor),
    repeatAnchors: slice.repeatAnchors.map(summarizePromptAnchor),
    establishedAnchors: slice.establishedAnchors.map(summarizePromptAnchor),
    pendingRepairs: slice.pendingRepairs.map(summarizePendingRepair),
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
    blockPlanSummaries: [],
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

function extractSentenceRepairConstraint(
  instruction: string
): {
  quotedText?: string;
  forbiddenTerms?: string[];
  sourceReferenceTexts?: string[];
} | null {
  if (!hasSentenceLocalRepairTarget(instruction)) {
    return null;
  }

  const quotedText =
    instruction.match(/第\s*\d+\s*句“([^”]+)”/u)?.[1]?.trim() ??
    instruction.match(/位置：[^“\n]*“([^”]+)”/u)?.[1]?.trim() ??
    instruction.match(/当前句“([^”]+)”/u)?.[1]?.trim() ??
    undefined;
  const forbiddenTerms = [
    ...instruction.matchAll(/(?:去掉|删除)(?:新增的)?“([^”]+)”限定/gu),
    ...instruction.matchAll(/不得新增“([^”]+)”/gu)
  ]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const sourceReferenceTexts = [...instruction.matchAll(/原文(?:仅|中的)?“([^”]+)”/gu)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  if (!quotedText && forbiddenTerms.length === 0 && sourceReferenceTexts.length === 0) {
    return null;
  }

  return {
    ...(quotedText ? { quotedText } : {}),
    ...(forbiddenTerms.length ? { forbiddenTerms: [...new Set(forbiddenTerms)] } : {}),
    ...(sourceReferenceTexts.length ? { sourceReferenceTexts: [...new Set(sourceReferenceTexts)] } : {})
  };
}

function inferRepairAnchorId(
  slice: PromptSlice,
  segmentSource: string,
  instruction: string
): string | null {
  const analysisPlanAnchorId = inferRepairAnchorIdFromAnalysisPlans(slice, instruction);
  if (analysisPlanAnchorId) {
    return analysisPlanAnchorId;
  }

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

function inferRepairAnchorIdFromAnalysisPlans(slice: PromptSlice, instruction: string): string | null {
  const matchedPlans = findMatchingAnalysisPlansForInstruction(slice, instruction);
  for (const plan of matchedPlans) {
    if (plan.anchorId) {
      return plan.anchorId;
    }

    const matchedAnchor = [...slice.requiredAnchors, ...slice.repeatAnchors, ...slice.establishedAnchors].find(
      (anchor) =>
        (plan.english && anchor.english === plan.english) ||
        (plan.chineseHint && normalizeRepairChineseTarget(anchor.chineseHint) === normalizeRepairChineseTarget(plan.chineseHint))
    );
    if (matchedAnchor) {
      return matchedAnchor.anchorId;
    }
  }

  return null;
}

function findMatchingAnalysisPlansForInstruction(
  slice: PromptSlice,
  instruction: string
): PromptSlice["analysisPlans"] {
  const normalizedInstruction = normalizeAnalysisPlanRepairText(instruction);
  if (!normalizedInstruction) {
    return [];
  }

  return slice.analysisPlans.filter((plan) => {
    const candidates = [
      plan.sourceText,
      plan.targetText,
      plan.english,
      plan.chineseHint,
      ...(plan.governedTerms ?? [])
    ]
      .map((value) => normalizeAnalysisPlanRepairText(value ?? ""))
      .filter(Boolean);

    return candidates.some(
      (candidate) =>
        normalizedInstruction.includes(candidate) || candidate.includes(normalizedInstruction)
    );
  });
}

function normalizeAnalysisPlanRepairText(text: string): string {
  return text
    .replace(/[`“”‘’"「」『』]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
  const matchedPlan = findMatchingAnalysisPlansForInstruction(slice, instruction).find((plan) => plan.english?.trim());
  if (matchedPlan?.english?.trim()) {
    return matchedPlan.english.trim();
  }

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
  draftedSegment: { segment: { source: string }; restoredBody: string },
  slice: PromptSlice,
  audit: GateAudit,
  instruction: string,
  structuredTarget?: StructuredRepairTarget | null
): string {
  if (inferRepairFailureType(audit, instruction) !== "missing_anchor") {
    return structuredTarget ? renderStructuredRepairTargetInstruction(structuredTarget) : instruction;
  }

  const locationText = extractExplicitRepairLocationText(instruction);
  if (!locationText) {
    return structuredTarget ? renderStructuredRepairTargetInstruction(structuredTarget) : instruction;
  }

  if (structuredTarget?.english?.trim()) {
    const exactAnchor = [...slice.requiredAnchors, ...slice.repeatAnchors, ...slice.establishedAnchors].find(
      (anchor) => anchor.english === structuredTarget.english
    );
    if (exactAnchor?.displayPolicy === "english-only") {
      return `位置：\`${structuredTarget.location || locationText}\`。问题：该处命中了前文已建立的专名锚点，不应重复补中文说明。修复目标：保持为“${exactAnchor.english}”，不要追加括注。`;
    }

    return renderStructuredRepairTargetInstruction(structuredTarget);
  }

  const aliasCanonicalTarget = extractAliasCanonicalRepairTarget(instruction, locationText);
  if (aliasCanonicalTarget) {
    return `位置：\`${locationText}\`。问题：首次出现的概念别名未与全文 canonical 锚定保持一致。修复目标：将“${aliasCanonicalTarget.currentText}”改为“${aliasCanonicalTarget.chineseHint}（${aliasCanonicalTarget.english}）”，并保持其余内容不变。`;
  }

  const inferredAnchorId = inferRepairAnchorId(slice, draftedSegment.segment.source, instruction);
  if (inferredAnchorId && !inferredAnchorId.startsWith("local:")) {
    const matchedAnchor = [...slice.requiredAnchors, ...slice.repeatAnchors, ...slice.establishedAnchors].find(
      (anchor) => anchor.anchorId === inferredAnchorId
    );
    if (matchedAnchor?.displayPolicy === "english-only") {
      return `位置：\`${locationText}\`。问题：该处命中了前文已建立的专名锚点，不应重复补中文说明。修复目标：保持为“${matchedAnchor.english}”，不要追加括注。`;
    }
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

// Detect the "draft echoed the source verbatim" failure mode. The bundled /
// per-segment audit LLMs have no hard_check that actually compares the body
// against the source, so a segment that came back untranslated can pass every
// structural check. Inject a synthetic must_fix (with a matching structured
// target) so the repair lane is forced to retranslate it.
// Promote failed hard_check problems into must_fix entries. The audit LLM
// sometimes reports a structural / style failure via hard_checks (e.g.
// chinese_punctuation.pass=false with a clear problem) but leaves must_fix
// empty. Without a must_fix entry the repair loop treats the chunk as "no work
// to do", exits early, and the failure is never repaired even though
// isBundledHardPass remains false. Mirror each failed hard_check problem into
// must_fix so the repair lane has an actionable instruction.
function materializeFailedHardCheckProblems(audit: GateAudit): GateAudit {
  const extras: string[] = [];
  const existing = new Set((audit.must_fix ?? []).map((entry) => entry.trim()));
  for (const [checkName, check] of Object.entries(audit.hard_checks ?? {})) {
    if (check?.pass !== false) {
      continue;
    }
    const problem = check.problem?.trim();
    if (!problem) {
      continue;
    }
    const mustFixEntry = `硬性检查 ${checkName} 未通过：${problem}`;
    if (existing.has(mustFixEntry)) {
      continue;
    }
    existing.add(mustFixEntry);
    extras.push(mustFixEntry);
  }
  if (extras.length === 0) {
    return audit;
  }
  return {
    ...audit,
    must_fix: [...(audit.must_fix ?? []), ...extras]
  };
}

// Predicate for "this segment's translated body is just an echo of the English
// source". Used by injectUntranslatedSegmentMustFix to add a repair
// instruction during audit. Central rules: segment must be translatable (not
// a fixed non-translatable block); source trimmed equals body trimmed; after
// stripping fenced/inline code and URLs the source has at least 15 English
// letters; the body contains zero CJK characters.
// When the draft / repair LLM visibly "retries" by appending a re-run of
// earlier blocks, the chunk ends up with its bullets or paragraphs duplicated
// back-to-back. Detect this pattern deterministically so the downstream
// normalizers see a cleanly-sized body: require (a) draft block count to
// exceed source block count, and (b) the longest possible tail to be a
// near-duplicate of the preceding window of the same length. When both hold,
// trim the tail. Block similarity is measured as normalized-char overlap to
// accommodate LLM paraphrase.
// Collapse runaway English-anchor parenthesis chains like
// `（sandbox mode）（Sandbox）（sandbox mode）**（sandbox mode）**` that the
// anchor injection chain can produce when several passes each append a
// canonical display without detecting the one inserted by an earlier layer.
// Also collapses `****` (double bold delimiter) that the same sequence can
// leave behind. Only fires when 3 or more adjacent parens share a case-
// insensitive English form, so cases with a single anchor or two legitimately
// distinct English tokens are left untouched.
// Collapse `（中文A（English B）） → 中文A（English B）`: when LLM draft wraps
// a canonical bilingual form inside an outer Chinese paren, the result reads
// as a double-nested paren that audit rejects. Lift the inner canonical out
// by removing the outer `（` and trailing `）`. Only fires when the outer
// paren's content is `CJK+（ASCII+）` pattern — no effect on single-layer
// parens or non-nested content.
function collapseNestedChineseEnglishParens(text: string): string {
  // Match an optional Chinese prefix BEFORE the outer paren + the nested
  // structure. When the prefix is a substring of the inner Chinese, the whole
  // span collapses to `innerChinese（English）` (canonical form).
  return text.replace(
    /([\u4e00-\u9fff]+)（([\u4e00-\u9fff][\u4e00-\u9fff\w\s]*?)（([A-Za-z][A-Za-z0-9 .+/_\-]*)）\s*）/gu,
    (_match, prefix, innerChinese, english) => {
      const pre = String(prefix).trim();
      const cn = String(innerChinese).trim();
      const en = String(english).trim();
      if (!cn || !en) {
        return _match;
      }
      // If prefix is a leading substring of inner Chinese (e.g. 沙盒 of 沙盒模式),
      // drop the prefix — the canonical `innerChinese（English）` already covers it.
      if (cn.startsWith(pre)) {
        return `${cn}（${en}）`;
      }
      // Otherwise keep prefix, just unwrap the nesting.
      return `${pre}${cn}（${en}）`;
    }
  );
}

function collapseRunawayEnglishAnchorChain(text: string): string {
  const collapseChain = (input: string): string =>
    input.replace(
      /(?:（([A-Za-z][A-Za-z0-9 .+/_\-]*)）(?:\s*\*{0,4}\s*)){3,}/gu,
      (match) => {
        const parens = [...match.matchAll(/（([A-Za-z][A-Za-z0-9 .+/_\-]*)）/gu)].map((m) =>
          String(m[1]).trim()
        );
        if (parens.length < 3) {
          return match;
        }
        const seen = new Set<string>();
        const kept: string[] = [];
        for (const paren of parens) {
          const key = paren.toLowerCase();
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          kept.push(paren);
        }
        return kept.map((paren) => `（${paren}）`).join("");
      }
    );
  // Separately collapse two adjacent parens that are case-only duplicates or
  // case-insensitive whole-word family variants (e.g. `（Sandbox）`, `（sandbox
  // mode）`). Runs at the post-normalizer stage so lines where anchor injection
  // short-circuited earlier still get the cleanup.
  const collapsePairs = (input: string): string =>
    input.replace(
      /（([A-Za-z][A-Za-z0-9 .+/_\-]*)）\s*（([A-Za-z][A-Za-z0-9 .+/_\-]*)）/gu,
      (match, first, second) => {
        const a = String(first).trim();
        const b = String(second).trim();
        if (!a || !b) return match;
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();
        if (aLower === bLower) {
          return `（${b}）`;
        }
        if (
          bLower.startsWith(`${aLower} `) ||
          bLower.endsWith(` ${aLower}`) ||
          aLower.startsWith(`${bLower} `) ||
          aLower.endsWith(` ${bLower}`)
        ) {
          return aLower.length >= bLower.length ? `（${a}）` : `（${b}）`;
        }
        return match;
      }
    );
  // Normalize accidental 4-star bold delimiters `****` to `**`; keep paired so
  // we do not corrupt balanced bold sequences elsewhere in the line.
  const collapseDoubleBold = (input: string): string => input.replace(/\*{4,}/g, "**");
  // If a line has an odd number of `**` markers, anchor injection likely
  // inserted `（anchor）` after a closed bold span and appended a stray `**`
  // tail (e.g. `**拒绝**。（Deny）**。`). Trim the dangling tail so the
  // protected_span_integrity audit no longer sees an unpaired `**`.
  const stripDanglingBoldTail = (input: string): string =>
    input
      .split(/\r?\n/)
      .map((line) => {
        const boldCount = (line.match(/\*\*/g) ?? []).length;
        if (boldCount === 0 || boldCount % 2 === 0) {
          return line;
        }
        return line.replace(/\*\*([\p{P}\p{S}\s]*)$/u, "$1");
      })
      .join("\n");
  // Issue #14 guard reduction step 1: #8 collapseCaseVariantSlashInParens
  // temporarily removed from the chain. Three consecutive full-smoke runs
  // after P2 / #22 did not surface any `X / Y` case-variant slash pattern,
  // so the guard is no longer needed as a safety net. Function kept for now
  // to make re-enable trivial if regression appears.
  return stripDanglingBoldTail(
    collapseDoubleBold(
      collapsePairs(
        collapseChain(
          collapseAdjacentDuplicateEnglishBeforeChineseParen(
            collapseNestedChineseEnglishParens(text)
          )
        )
      )
    )
  );
}

// Collapse `Seatbelt Seatbelt（...）` style adjacent-duplicate English word
// immediately before a Chinese canonical paren. LLM occasionally writes the
// source phrase AND the anchor canonical form side by side. Safely narrow:
// only when the exact same English token appears twice separated by a single
// whitespace and is immediately followed by a Chinese `（...）`.
function collapseAdjacentDuplicateEnglishBeforeChineseParen(text: string): string {
  return text.replace(
    /\b([A-Za-z][A-Za-z0-9.+_-]*)\s+\1(\s*（)/gu,
    (_match, word, tail) => `${word}${tail}`
  );
}

// Issue #8: when draft LLM emits `（git / Git、...）` or `（Docker / Docker）`,
// collapse the `A / B` pair to a single token when A and B differ only in
// letter case. Scoped to the content inside Chinese parens so normal
// `and / or`-style text outside parens is not touched.
function collapseCaseVariantSlashInParens(text: string): string {
  return text.replace(/（([^（）\n]+)）/gu, (match, innerRaw) => {
    const inner = String(innerRaw);
    const collapsed = inner.replace(
      /([A-Za-z][A-Za-z0-9.+_-]*)\s*\/\s*([A-Za-z][A-Za-z0-9.+_-]*)/g,
      (pairMatch, left, right) => {
        const a = String(left);
        const b = String(right);
        if (a.toLowerCase() !== b.toLowerCase()) {
          return pairMatch;
        }
        return a.length <= b.length ? a : b;
      }
    );
    return collapsed === inner ? match : `（${collapsed}）`;
  });
}

function dedupDraftDuplicateTailBlocks(source: string, draft: string): string {
  if (!draft || !source) {
    return draft;
  }
  const splitBlocks = (text: string): string[] =>
    text
      .split(/\n{2,}/)
      .map((block) => block.replace(/\s+$/, ""))
      .filter((block) => block.trim().length > 0);
  const sourceBlocks = splitBlocks(source);
  const draftBlocks = splitBlocks(draft);
  if (draftBlocks.length <= sourceBlocks.length) {
    return draft;
  }
  const maxTrim = draftBlocks.length - sourceBlocks.length;
  for (let tailLen = maxTrim; tailLen >= 1; tailLen -= 1) {
    const tailStart = draftBlocks.length - tailLen;
    if (tailStart < tailLen) {
      continue;
    }
    const earlierStart = tailStart - tailLen;
    let allSimilar = true;
    for (let k = 0; k < tailLen; k += 1) {
      if (!draftBlocksLookLikeDuplicate(draftBlocks[earlierStart + k] ?? "", draftBlocks[tailStart + k] ?? "")) {
        allSimilar = false;
        break;
      }
    }
    if (allSimilar) {
      return draftBlocks.slice(0, tailStart).join("\n\n");
    }
  }
  return draft;
}

function draftBlocksLookLikeDuplicate(a: string, b: string): boolean {
  const normalize = (s: string) =>
    s
      .replace(/\s+/gu, "")
      .replace(/[（(][^）)]{0,60}[）)]/gu, "")
      .replace(/[\p{P}\p{S}]/gu, "");
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) {
    return false;
  }
  if (na === nb) {
    return true;
  }
  const minLen = Math.min(na.length, nb.length);
  const maxLen = Math.max(na.length, nb.length);
  if (minLen < 8 || minLen / maxLen < 0.6) {
    return false;
  }
  const sample = na.length <= nb.length ? na : nb;
  const other = na.length <= nb.length ? nb : na;
  let hits = 0;
  for (let i = 0; i + 3 <= sample.length; i += 3) {
    if (other.includes(sample.slice(i, i + 3))) {
      hits += 1;
    }
  }
  const ngrams = Math.max(1, Math.floor(sample.length / 3));
  return hits / ngrams >= 0.55;
}

// Issue #9: draft LLM sometimes appends a full "retry" run of the latter
// sentences to the end of a block — all inside the same line / blockquote,
// so `dedupDraftDuplicateTailBlocks` (which splits on blank lines) never
// sees the duplicate. Split by sentence-ending punctuation, and if the
// translated count exceeds the source count, trim tail sentences that
// near-duplicate an earlier run of the same length.
function dedupDraftDuplicateTailSentences(source: string, draft: string): string {
  if (!draft || !source) {
    return draft;
  }
  const sourceSentences = splitIntoSentencesForDedup(source);
  const draftSentences = splitIntoSentencesForDedup(draft);
  if (draftSentences.length <= sourceSentences.length) {
    return draft;
  }
  const maxTrim = draftSentences.length - sourceSentences.length;
  for (let tailLen = maxTrim; tailLen >= 1; tailLen -= 1) {
    const tailStart = draftSentences.length - tailLen;
    if (tailStart < tailLen) {
      continue;
    }
    const earlierStart = tailStart - tailLen;
    let allSimilar = true;
    for (let k = 0; k < tailLen; k += 1) {
      if (
        !draftBlocksLookLikeDuplicate(
          draftSentences[earlierStart + k] ?? "",
          draftSentences[tailStart + k] ?? ""
        )
      ) {
        allSimilar = false;
        break;
      }
    }
    if (allSimilar) {
      // Rejoin kept sentences. Each sentence already carries its trailing
      // punctuation from splitIntoSentencesForDedup; no separator needed.
      return draftSentences.slice(0, tailStart).join("").replace(/\s+$/u, "");
    }
  }
  return draft;
}

function splitIntoSentencesForDedup(text: string): string[] {
  const sentences: string[] = [];
  let buffer = "";
  for (const ch of text) {
    buffer += ch;
    if (ch === "。" || ch === "！" || ch === "？" || ch === "." || ch === "!" || ch === "?") {
      sentences.push(buffer);
      buffer = "";
    }
  }
  if (buffer.trim().length > 0) {
    sentences.push(buffer);
  }
  return sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function isSegmentStillEchoingSource(draftedSegment: DraftedSegmentState): boolean {
  if (draftedSegment.segment.kind !== "translatable") {
    return false;
  }
  const source = draftedSegment.segment.source ?? "";
  const body = draftedSegment.restoredBody ?? "";
  const trimmedSource = source.trim();
  const trimmedBody = body.trim();
  if (!trimmedSource || trimmedSource !== trimmedBody) {
    return false;
  }
  const strippedSource = trimmedSource
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/[\p{P}\p{S}\s]/gu, "");
  const englishLetters = strippedSource.match(/[A-Za-z]/g);
  if (!englishLetters || englishLetters.length < 15) {
    return false;
  }
  if (/[\u4e00-\u9fff]/u.test(trimmedBody)) {
    return false;
  }
  return true;
}

function injectUntranslatedSegmentMustFix(
  draftedSegment: DraftedSegmentState,
  audit: GateAudit
): GateAudit {
  if (!isSegmentStillEchoingSource(draftedSegment)) {
    return audit;
  }

  const instruction =
    "当前分段译文与原文完全一致，未完成翻译。请将其翻译为中文正文，保留 Markdown 结构与受保护片段。";
  return {
    ...audit,
    must_fix: [instruction, ...(audit.must_fix ?? [])]
  };
}

function buildStructuredSegmentAuditResult(
  state: TranslationRunState,
  draftedSegment: DraftedSegmentState,
  audit: GateAudit
): StateSegmentAuditResult {
  const chunkId = draftedSegment.segmentId.split("-segment-")[0] ?? `chunk-${draftedSegment.segment.index + 1}`;
  const slice = buildSegmentTaskSlice(state, chunkId, draftedSegment.segmentId);
  const guardedAudit = materializeFailedHardCheckProblems(
    injectUntranslatedSegmentMustFix(draftedSegment, audit)
  );
  const expandedAudit = expandMissingAnchorMustFixes(guardedAudit);
  const filteredAudit = suppressCoveredAnchorMustFix(state, draftedSegment, slice, expandedAudit);
  const repairTasks = buildRepairTasksForSegment(state, draftedSegment.segmentId, {
    segment: { source: draftedSegment.segment.source },
    restoredBody: draftedSegment.restoredBody
  }, slice, filteredAudit);

  return {
    segmentId: draftedSegment.segmentId,
    hardChecks: filteredAudit.hard_checks,
    repairTasks,
    rawMustFix: filteredAudit.must_fix
  };
}

// Apply a structured audit to state and sync the filter-truth must_fix back onto
// the raw `segmentAudit` so the outer repair loop agrees with the state engine on
// what still needs work. Without this sync the while-loop reads the pre-filter
// must_fix while the repair dispatch reads the post-filter pendingRepairs, which
// causes the loop to spin without making progress whenever the filter suppresses
// an instruction (e.g. anchor already covered) that the auditor still listed.
function applyStructuredSegmentAuditAndSync(
  state: TranslationRunState,
  draftedSegment: DraftedSegmentState,
  segmentAudit: GateAudit & { segment_index?: number }
): void {
  const structured = buildStructuredSegmentAuditResult(state, draftedSegment, segmentAudit);
  applySegmentAudit(state, structured);
  segmentAudit.must_fix = [...structured.rawMustFix];
  segmentAudit.hard_checks = structured.hardChecks;
}

function buildRepairTasksForSegment(
  state: TranslationRunState,
  segmentId: string,
  repairContext: { segment: { source: string }; restoredBody: string },
  slice: PromptSlice,
  audit: GateAudit
): RepairTask[] {
  const structuredTargets = audit.repair_targets ?? [];
  const repairTaskCount = Math.max(audit.must_fix.length, structuredTargets.length);

  return Array.from({ length: repairTaskCount }, (_, index) => {
    const rawInstruction = audit.must_fix[index] ?? null;
    const failureType = inferRepairFailureType(audit, rawInstruction ?? "请修复当前硬性问题。");
    const rawStructuredTarget =
      structuredTargets[index] ??
      (rawInstruction ? synthesizeStructuredRepairTargetFromMustFix(repairContext.segment.source, rawInstruction) : null);
    const resolvedStructuredTarget = rawStructuredTarget
      ? canonicalizeStructuredRepairTarget(slice, rawStructuredTarget)
      : null;
    const structuredTarget = normalizeStructuredRepairTargetForFailureType(
      resolvedStructuredTarget?.target ?? null,
      failureType
    );
    const instruction = rawInstruction
      ? synthesizeLocalRepairInstruction(repairContext, slice, audit, rawInstruction, structuredTarget)
      : structuredTarget
        ? renderStructuredRepairTargetInstruction(structuredTarget)
        : "请修复当前硬性问题。";
    const analysisBindings = collectRepairTaskAnalysisBindings(slice, instruction, structuredTarget ?? undefined);
    const sentenceConstraint =
      structuredTarget && (structuredTarget.forbiddenTerms?.length || structuredTarget.sourceReferenceTexts?.length)
        ? {
            ...(structuredTarget.currentText ? { quotedText: structuredTarget.currentText } : {}),
            ...(structuredTarget.forbiddenTerms?.length ? { forbiddenTerms: [...structuredTarget.forbiddenTerms] } : {}),
            ...(structuredTarget.sourceReferenceTexts?.length
              ? { sourceReferenceTexts: [...structuredTarget.sourceReferenceTexts] }
              : {})
          }
        : extractSentenceRepairConstraint(instruction);

    return {
      id: `${segmentId}-repair-${state.repairs.length + index + 1}`,
      segmentId,
      anchorId:
        (failureType === "missing_anchor"
          ? (resolvedStructuredTarget?.anchorId ??
            (structuredTarget?.english ? buildLocalFallbackAnchorId(segmentId, structuredTarget.english) : null))
          : null) ??
        inferRepairAnchorId(slice, repairContext.segment.source, instruction),
      failureType,
      locationLabel:
        structuredTarget?.location?.trim() ||
        inferRepairLocationLabelFromInstruction(repairContext.segment.source, instruction),
      instruction,
      ...(structuredTarget ? { structuredTarget } : {}),
      ...(sentenceConstraint ? { sentenceConstraint } : {}),
      ...(analysisBindings.analysisPlanIds.length ? { analysisPlanIds: analysisBindings.analysisPlanIds } : {}),
      ...(analysisBindings.analysisPlanKinds.length ? { analysisPlanKinds: analysisBindings.analysisPlanKinds } : {}),
      ...(analysisBindings.analysisTargets.length ? { analysisTargets: analysisBindings.analysisTargets } : {}),
      status: "pending"
    };
  });
}

function normalizeStructuredRepairTargetForFailureType(
  target: StructuredRepairTarget | null,
  failureType: RepairFailureType
): StructuredRepairTarget | null {
  if (!target) {
    return null;
  }

  if (failureType === "missing_anchor") {
    return target;
  }

  if (
    target.kind === "sentence" &&
    target.chineseHint?.trim() &&
    target.english?.trim()
  ) {
    return {
      ...target,
      targetText: target.chineseHint.trim()
    };
  }

  return target;
}

function canonicalizeStructuredRepairTarget(
  slice: PromptSlice,
  target: StructuredRepairTarget
): { target: StructuredRepairTarget; anchorId: string | null } {
  const english = target.english?.trim();
  if (!english) {
    return { target, anchorId: null };
  }

  const anchors = [...slice.requiredAnchors, ...slice.repeatAnchors, ...slice.establishedAnchors];
  const matchingAnchor =
    anchors.find((anchor) => !anchor.anchorId.startsWith("local:") && anchor.english === english) ??
    anchors.find((anchor) => anchor.english === english) ??
    null;
  if (!matchingAnchor) {
    return { target, anchorId: null };
  }

  const canonicalTargetText =
    matchingAnchor.canonicalDisplay ??
    (matchingAnchor.displayPolicy === "english-only"
      ? matchingAnchor.english
      : `${matchingAnchor.chineseHint}（${matchingAnchor.english}）`);

  if (matchingAnchor.displayPolicy === "english-only") {
    const englishOnlyTargetText =
      rewriteStructuredTargetTextToEnglishOnly(target.targetText, matchingAnchor.english) ??
      rewriteStructuredTargetTextToEnglishOnly(target.currentText, matchingAnchor.english) ??
      canonicalTargetText;

    return {
      anchorId: matchingAnchor.anchorId,
      target: {
        ...target,
        english: matchingAnchor.english,
        chineseHint: matchingAnchor.chineseHint,
        targetText: englishOnlyTargetText
      }
    };
  }

  const shouldCanonicalizeTargetText =
    !target.targetText ||
    Boolean(parseBilingualStructuredTargetText(target.targetText)) ||
    target.targetText.trim() === english ||
    target.targetText.trim() === target.chineseHint?.trim();

  return {
    anchorId: matchingAnchor.anchorId,
    target: {
      ...target,
      english: matchingAnchor.english,
      chineseHint: matchingAnchor.chineseHint,
      ...(shouldCanonicalizeTargetText ? { targetText: canonicalTargetText } : {})
    }
  };
}

function rewriteStructuredTargetTextToEnglishOnly(
  text: string | null | undefined,
  english: string
): string | null {
  const trimmed = text?.trim();
  if (!trimmed) {
    return null;
  }

  const escapedEnglish = escapeRegExp(english);
  const collapsed = trimmed
    .replace(new RegExp(`${escapedEnglish}（[^）]+）`, "g"), english)
    .replace(new RegExp(`${escapedEnglish}\\(([^)]+)\\)`, "g"), english)
    .replace(new RegExp(`[^（(\\s]+（${escapedEnglish}）`, "g"), english)
    .replace(new RegExp(`[^)(\\s]+\\(${escapedEnglish}\\)`, "g"), english);

  return collapsed.replace(/\s+/g, " ").replace(/）\s+(?=[\u4e00-\u9fff])/gu, "）").trim();
}

function synthesizeStructuredRepairTargetFromMustFix(
  segmentSource: string,
  instruction: string
): StructuredRepairTarget | null {
  const targetText = extractExplicitStructuredTargetText(instruction);
  if (!targetText) {
    return null;
  }

  const kind = inferStructuredRepairTargetKind(segmentSource, instruction);
  const location = extractExplicitRepairLocationLabel(instruction) || inferRepairLocationLabelFromInstruction(segmentSource, instruction);
  const currentText = extractExplicitRepairLocationText(instruction) ?? undefined;
  const bilingualTarget = parseBilingualStructuredTargetText(targetText);
  const sourceReferenceTexts = inferStructuredRepairTargetSourceReferenceTexts(segmentSource, instruction, location, kind);

  return {
    location,
    kind,
    ...(currentText ? { currentText } : {}),
    targetText,
    ...(bilingualTarget?.english ? { english: bilingualTarget.english } : {}),
    ...(bilingualTarget?.chineseHint ? { chineseHint: bilingualTarget.chineseHint } : {}),
    ...(sourceReferenceTexts.length ? { sourceReferenceTexts } : {})
  };
}

function inferStructuredRepairTargetSourceReferenceTexts(
  segmentSource: string,
  instruction: string,
  location: string,
  kind: StructuredRepairTarget["kind"]
): string[] {
  const explicitSourceReferences = [...instruction.matchAll(/原文(?:仅|中的)?“([^”]+)”/gu)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (explicitSourceReferences.length > 0) {
    return [...new Set(explicitSourceReferences)];
  }

  if (kind !== "blockquote" && kind !== "sentence" && kind !== "lead_in" && kind !== "block") {
    return [];
  }

  const normalizedLocation = location.trim();
  const numberedBlockIndex = normalizedLocation.match(/^第\s*(\d+)\s*个块/u)?.[1];
  if (numberedBlockIndex) {
    const blockIndex = Number.parseInt(numberedBlockIndex, 10);
    const block = splitPromptBlocks(segmentSource)[blockIndex - 1];
    const blockSource = block?.content?.trim();
    if (blockSource) {
      return [blockSource];
    }
  }

  if (kind === "blockquote") {
    const blockquoteBlocks = splitPromptBlocks(segmentSource)
      .map((block) => block.content.trim())
      .filter((content) => classifyPromptBlockKind(content) === "blockquote");
    if (blockquoteBlocks.length === 1 && blockquoteBlocks[0]) {
      return [blockquoteBlocks[0]];
    }
  }

  return [];
}

function extractExplicitStructuredTargetText(instruction: string): string | null {
  const quotedCandidates = [
    ...instruction.matchAll(/“([^”\n]+)”/gu),
    ...instruction.matchAll(/`([^`\n]+)`/g)
  ]
    .map((match) => normalizeAuditQuoteStyle(match[1]?.trim() ?? ""))
    .filter(Boolean);

  const bilingualCandidate = [...quotedCandidates]
    .reverse()
    .find((candidate) => /[\u4e00-\u9fff]/u.test(candidate) && /[（(][^）)]*[A-Za-z][^）)]*[）)]/.test(candidate));
  if (bilingualCandidate) {
    return bilingualCandidate;
  }

  return null;
}

function parseBilingualStructuredTargetText(
  targetText: string
): { english: string; chineseHint: string } | null {
  const fullWidthMatch = targetText.match(/^(.+?)（([^）]+)）$/u);
  if (fullWidthMatch?.[1] && fullWidthMatch[2]) {
    const chineseHint = fullWidthMatch[1].trim();
    const english = fullWidthMatch[2].trim();
    if (chineseHint && english) {
      return { english, chineseHint };
    }
  }

  const asciiMatch = targetText.match(/^(.+?)\(([^)]+)\)$/u);
  if (asciiMatch?.[1] && asciiMatch[2]) {
    const chineseHint = asciiMatch[1].trim();
    const english = asciiMatch[2].trim();
    if (chineseHint && english) {
      return { english, chineseHint };
    }
  }

  return null;
}

function inferStructuredRepairTargetKind(
  segmentSource: string,
  instruction: string
): StructuredRepairTarget["kind"] {
  const locationLabel = inferRepairLocationLabelFromInstruction(segmentSource, instruction);
  switch (locationLabel) {
    case "标题":
      return "heading";
    case "列表项":
      return "list_item";
    case "引用段":
      return "blockquote";
    case "列表引导句":
      return "lead_in";
    case "正文句":
      return "sentence";
    default:
      return "anchor";
  }
}

function extractExplicitRepairLocationLabel(instruction: string): string | null {
  const titleMatch = instruction.match(/^(第\s*\d+\s*个标题)/u)?.[1]?.trim();
  if (titleMatch) {
    return titleMatch;
  }

  const listItemMatch = instruction.match(/^(第\s*\d+\s*个(?:项目符号|列表项))/u)?.[1]?.trim();
  if (listItemMatch) {
    return listItemMatch;
  }

  const sentenceMatch = instruction.match(/^(第\s*\d+\s*段(?:第\s*\d+\s*句|首句|末句))/u)?.[1]?.trim();
  if (sentenceMatch) {
    return sentenceMatch;
  }

  return null;
}

function collectRepairTaskAnalysisBindings(
  slice: PromptSlice,
  instruction: string,
  structuredTarget?: StructuredRepairTarget
): {
  analysisPlanIds: string[];
  analysisPlanKinds: Array<PromptSlice["analysisPlans"][number]["kind"]>;
  analysisTargets: string[];
} {
  const matchedPlans = findMatchingAnalysisPlansForInstruction(
    slice,
    [
      instruction,
      structuredTarget?.location,
      structuredTarget?.currentText,
      structuredTarget?.targetText,
      structuredTarget?.english,
      structuredTarget?.chineseHint,
      ...(structuredTarget?.forbiddenTerms ?? []),
      ...(structuredTarget?.sourceReferenceTexts ?? [])
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" | ")
  );
  return {
    analysisPlanIds: matchedPlans.map((plan) => plan.id),
    analysisPlanKinds: [...new Set(matchedPlans.map((plan) => plan.kind))],
    analysisTargets: [
      ...new Set(
        matchedPlans.flatMap((plan) =>
          [plan.sourceText, plan.targetText, plan.english, plan.chineseHint, ...(plan.governedTerms ?? [])].filter(
            (value): value is string => Boolean(value?.trim())
          )
        )
      )
    ]
  };
}

function renderStructuredRepairTargetInstruction(target: StructuredRepairTarget): string {
  const parts = [`位置：${target.location}`];
  if (target.currentText) {
    parts.push(`当前写法：${target.currentText}`);
  }
  if (target.targetText) {
    parts.push(`目标写法：${target.targetText}`);
  }
  if (target.english) {
    parts.push(`英文目标：${target.english}`);
  }
  if (target.chineseHint) {
    parts.push(`中文目标：${target.chineseHint}`);
  }
  if (target.forbiddenTerms?.length) {
    parts.push(`禁增限定：${target.forbiddenTerms.join(" / ")}`);
  }
  if (target.sourceReferenceTexts?.length) {
    parts.push(`原文对齐：${target.sourceReferenceTexts.join(" / ")}`);
  }
  return `${parts.join("。")}。`;
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
    // materializeFailedHardCheckProblems injects structural-check failures as
    // must_fix with a stable sentinel prefix ("硬性检查 "). Those are not
    // anchor-related even if the underlying problem text happens to mention
    // an anchor surface — never let anchor-coverage heuristics suppress them.
    if (/^硬性检查\s/u.test(instruction.trim())) {
      return true;
    }
    const anchors = [...slice.requiredAnchors, ...slice.repeatAnchors, ...slice.establishedAnchors];
    const explicitLocationText = extractExplicitRepairLocationText(instruction);
    if (isAnalysisPlanTargetAlreadySatisfied(slice, draftedSegment, instruction, explicitLocationText)) {
      return false;
    }

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

function isAnalysisPlanTargetAlreadySatisfied(
  slice: PromptSlice,
  draftedSegment: DraftedSegmentState,
  instruction: string,
  explicitLocationText: string | null
): boolean {
  const matchedPlans = findMatchingAnalysisPlansForInstruction(slice, instruction).filter(
    (plan) => plan.targetText?.trim()
  );
  if (matchedPlans.length === 0) {
    return false;
  }

  const restoredLines = draftedSegment.restoredBody.split(/\r?\n/);
  const targetTexts = matchedPlans
    .map((plan) => plan.targetText?.trim())
    .filter((value): value is string => Boolean(value));

  if (explicitLocationText) {
    const restoredLine = restoredLines.find((line) => line.includes(explicitLocationText));
    if (!restoredLine) {
      return false;
    }

    return targetTexts.some((targetText) => restoredLine.includes(targetText));
  }

  return targetTexts.some((targetText) => draftedSegment.restoredBody.includes(targetText));
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
        const slice = draftedSegment
          ? buildSegmentTaskSlice(context.state, context.chunkId, draftedSegment.segmentId)
          : null;
        const analysisBindings = slice
          ? collectChunkFailureAnalysisBindings(slice, audit.must_fix)
          : { analysisPlanIds: [] as string[], analysisTargets: [] as string[] };
        const sentenceConstraint = audit.must_fix
          .map((instruction) => extractSentenceRepairConstraint(instruction))
          .find((constraint) => constraint !== null);
        return {
          segmentId: draftedSegment?.segmentId ?? null,
          segmentIndex: audit.segment_index,
          mustFix: audit.must_fix.length > 0 ? [...audit.must_fix] : ["hard gate failed"],
          ...(audit.repair_targets?.length
            ? { structuredTargets: audit.repair_targets.map((target) => ({ ...target })) }
            : {}),
          ...(sentenceConstraint ? { sentenceConstraint } : {}),
          ...(analysisBindings.analysisPlanIds.length
            ? { analysisPlanIds: analysisBindings.analysisPlanIds }
            : {}),
          ...(analysisBindings.analysisTargets.length ? { analysisTargets: analysisBindings.analysisTargets } : {})
        };
      });
    const remaining = failedSegments
      .map((audit) => `segment ${audit.segmentIndex}: ${audit.mustFix.join(" | ")}`)
      .join(" || ");
    markChunkFailure(context.state, context.chunkId, {
      summary: remaining,
      segments: failedSegments
    });
    reifyChunkFailureRepairs(context.state, context.chunkId, failedSegments);
    report(
      context.options,
      "audit",
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel} failed after ${repairCyclesUsed} repair cycle(s): ${remaining}`
    );
    const structuralFailure = bundledAudit.segments.some(hasStructuralHardCheckFailure);
    if (context.options.softGate && !structuralFailure) {
      report(
        context.options,
        "audit",
        `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: soft-gate enabled (semantic failures only), keeping best-effort body and continuing.`
      );
      const bestEffortBody = rebuildChunkFromSegmentStates(segments, draftedSegments, "restoredBody");
      markChunkPhase(context.state, context.chunkId, "completed");
      return {
        body: bestEffortBody,
        repairCyclesUsed,
        gateAudit: mergeGateAudits(bundledAudit.segments),
        nextLocalSpanIndex
      };
    }
    if (context.options.softGate && structuralFailure) {
      report(
        context.options,
        "audit",
        `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: soft-gate cannot rescue structural hard-check failure; failing hard.`
      );
    }
    const failureError = new HardGateError(
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel} failed after ${repairCyclesUsed} repair cycle(s): ${remaining}`
    );
    if (structuralFailure) {
      throw markStructuralHardGateError(failureError);
    }
    throw failureError;
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

function collectChunkFailureAnalysisBindings(
  slice: PromptSlice,
  mustFix: readonly string[]
): { analysisPlanIds: string[]; analysisTargets: string[] } {
  const matchedPlans = slice.analysisPlans.filter((plan) =>
    mustFix.some((instruction) =>
      findMatchingAnalysisPlansForInstruction(slice, instruction).some((matchedPlan) => matchedPlan.id === plan.id)
    )
  );

  return {
    analysisPlanIds: matchedPlans.map((plan) => plan.id),
    analysisTargets: [
      ...new Set(
        matchedPlans.flatMap((plan) =>
          [plan.sourceText, plan.targetText, plan.english, plan.chineseHint, ...(plan.governedTerms ?? [])].filter(
            (value): value is string => Boolean(value?.trim())
          )
        )
      )
    ]
  };
}

function reifyChunkFailureRepairs(
  state: TranslationRunState,
  chunkId: string,
  failedSegments: Array<{
    segmentId: string | null;
    segmentIndex: number;
    mustFix: string[];
    structuredTargets?: StructuredRepairTarget[];
    sentenceConstraint?: {
      quotedText?: string;
      forbiddenTerms?: string[];
      sourceReferenceTexts?: string[];
    };
    analysisPlanIds?: string[];
    analysisTargets?: string[];
  }>
): void {
  for (const failure of failedSegments) {
    if (!failure.segmentId) {
      continue;
    }

    const segment = getSegmentState(state, failure.segmentId);
    const syntheticAudit: GateAudit = {
      hard_checks: buildChunkFailureHardChecks(segment.lastAudit?.hardChecks, failure.mustFix),
      must_fix: [...failure.mustFix],
      ...(failure.structuredTargets?.length
        ? { repair_targets: failure.structuredTargets.map((target) => ({ ...target })) }
        : {})
    };
    const slice = buildSegmentTaskSlice(state, chunkId, failure.segmentId);
    const repairTasks = buildRepairTasksForSegment(
      state,
      failure.segmentId,
      {
        segment: { source: segment.source },
        restoredBody: segment.currentRestoredBody
      },
      slice,
      syntheticAudit
    );

    for (const task of repairTasks) {
      if (failure.sentenceConstraint && !task.sentenceConstraint) {
        task.sentenceConstraint = {
          ...(failure.sentenceConstraint.quotedText ? { quotedText: failure.sentenceConstraint.quotedText } : {}),
          ...(failure.sentenceConstraint.forbiddenTerms?.length
            ? { forbiddenTerms: [...failure.sentenceConstraint.forbiddenTerms] }
            : {}),
          ...(failure.sentenceConstraint.sourceReferenceTexts?.length
            ? { sourceReferenceTexts: [...failure.sentenceConstraint.sourceReferenceTexts] }
            : {})
        };
      }
      if (failure.analysisPlanIds?.length && !task.analysisPlanIds?.length) {
        task.analysisPlanIds = [...failure.analysisPlanIds];
      }
      if (failure.analysisTargets?.length && !task.analysisTargets?.length) {
        task.analysisTargets = [...failure.analysisTargets];
      }
      state.repairs.push(task);
    }

    segment.repairTaskIds = repairTasks.map((task) => task.id);
    segment.lastAudit = {
      segmentId: failure.segmentId,
      hardChecks: syntheticAudit.hard_checks,
      repairTasks,
      rawMustFix: syntheticAudit.must_fix
    };
    segment.phase = repairTasks.length > 0 ? "failed" : segment.phase;
  }
}

function buildChunkFailureHardChecks(
  previous: GateAudit["hard_checks"] | null | undefined,
  mustFix: readonly string[]
): GateAudit["hard_checks"] {
  const checks: GateAudit["hard_checks"] = previous
    ? {
        paragraph_match: { ...previous.paragraph_match },
        first_mention_bilingual: { ...previous.first_mention_bilingual },
        numbers_units_logic: { ...previous.numbers_units_logic },
        chinese_punctuation: { ...previous.chinese_punctuation },
        unit_conversion_boundary: { ...previous.unit_conversion_boundary },
        protected_span_integrity: { ...previous.protected_span_integrity }
      }
    : {
        paragraph_match: { pass: true, problem: "" },
        first_mention_bilingual: { pass: true, problem: "" },
        numbers_units_logic: { pass: true, problem: "" },
        chinese_punctuation: { pass: true, problem: "" },
        unit_conversion_boundary: { pass: true, problem: "" },
        protected_span_integrity: { pass: true, problem: "" }
      };

  for (const instruction of mustFix) {
    if (/段落顺序|段落数|块顺序|提前到开头|重排/u.test(instruction)) {
      checks.paragraph_match = { pass: false, problem: instruction };
      continue;
    }
    if (/中英对照|双语|首现|锚定|术语/u.test(instruction)) {
      checks.first_mention_bilingual = { pass: false, problem: instruction };
      continue;
    }
    if (/数字|单位|换算|逻辑/u.test(instruction)) {
      checks.numbers_units_logic = { pass: false, problem: instruction };
      continue;
    }
    if (/半角|全角|冒号|引号|括号|标点/u.test(instruction)) {
      checks.chinese_punctuation = { pass: false, problem: instruction };
      continue;
    }
    if (/占位符|protected span|inline code|code block|链接目标|图片 URL/u.test(instruction)) {
      checks.protected_span_integrity = { pass: false, problem: instruction };
    }
  }

  return checks;
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
  let styleResult: CodexExecResult;
  try {
    styleResult = await executeStageWithTimeout(
      context.executor,
      buildStylePolishPrompt(sourceProtectedBody, protectedTranslatedBody),
      {
        cwd: context.cwd,
        model: context.model,
        reasoningEffort: context.reasoningEffort ?? STYLE_REASONING_EFFORT,
        onStderr: (stderrChunk) => report(context.options, "style", stderrChunk.trim())
      },
      {
        options: context.options,
        stage: "style",
        timeoutMs: getStyleTimeoutMs(),
        heartbeatLabel: "Final style polish",
        onHeartbeat: (message) => report(context.options, "style", message)
      }
    );
  } catch (error) {
    if (error instanceof CodexExecutionError && /timed out after \d+ms\./i.test(error.message)) {
      report(
        context.options,
        "style",
        "Final style polish timed out; falling back to the hard-pass translation."
      );
      return { body: translatedBody, styleApplied: false };
    }
    throw error;
  }

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

export function stripAddedInlineCodeFromPlainPaths(source: string, translated: string): string {
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

export function restoreInlineCodeFromSourceShape(source: string, translated: string): string {
  const sourceLines = source.split(/\r?\n/);
  const translatedLines = translated.split(/\r?\n/);
  let changed = false;

  for (let index = 0; index < Math.min(sourceLines.length, translatedLines.length); index += 1) {
    const sourceLine = sourceLines[index] ?? "";
    let translatedLine = translatedLines[index] ?? "";
    const canonicalizedLine = canonicalizeInlineCodeFenceShape(sourceLine, translatedLine);
    if (canonicalizedLine !== translatedLine) {
      translatedLine = canonicalizedLine;
      changed = true;
    }

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

export function restoreCodeLikeSourceShape(source: string, translated: string): string {
  const sourceLines = source.split(/\r?\n/);
  const translatedLines = translated.split(/\r?\n/);
  let changed = false;

  for (let index = 0; index < Math.min(sourceLines.length, translatedLines.length); index += 1) {
    const sourceLine = sourceLines[index] ?? "";
    let translatedLine = translatedLines[index] ?? "";

    for (const token of extractCodeLikeSourceTokens(sourceLine)) {
      if (translatedLine.includes(token)) {
        continue;
      }

      const candidate = findMangledCodeLikeTokenCandidate(translatedLine, token);
      if (!candidate || candidate === token) {
        continue;
      }

      translatedLine = replaceFirst(translatedLine, candidate, token);
      changed = true;
    }

    translatedLines[index] = translatedLine;
  }

  return changed ? translatedLines.join("\n") : translated;
}

export function restoreSourceShapeExampleTokens(source: string, translated: string): string {
  const sourceLines = source.split(/\r?\n/);
  const translatedLines = translated.split(/\r?\n/);
  let changed = false;

  for (let index = 0; index < Math.min(sourceLines.length, translatedLines.length); index += 1) {
    const sourceLine = sourceLines[index] ?? "";
    const translatedLine = translatedLines[index] ?? "";
    const sourceToken = extractSourceShapeExampleToken(sourceLine);
    if (!sourceToken) {
      continue;
    }

    const restoredLine = restoreSourceShapeExampleTokenLine(translatedLine, sourceToken);
    if (restoredLine !== translatedLine) {
      translatedLines[index] = restoredLine;
      changed = true;
    }
  }

  return changed ? translatedLines.join("\n") : translated;
}

function normalizeMarkdownLinkLabelWhitespace(text: string): string {
  return text.replace(/\[([^\]\n]*?)\s+\]\(([^)\n]+)\)/g, (_match, label, destination) => `[${label.trim()}](${destination})`);
}

function normalizeMalformedInlineEnglishEmphasis(text: string): string {
  return text.replace(/\*\s*([A-Za-z][A-Za-z-]{2,})\*([A-Za-z])\b/g, (_match, stem, tail) => `*${stem}${tail}*`);
}

function extractSourceShapeExampleToken(line: string): string | null {
  const match = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s+-\s+/);
  const candidate = match?.[1]?.trim();
  if (!candidate) {
    return null;
  }

  return looksLikeSourceShapeExampleToken(candidate) ? candidate : null;
}

function looksLikeSourceShapeExampleToken(token: string): boolean {
  return (
    containsGlobSyntax(token) ||
    looksLikeCodeLikeSourceToken(token) ||
    /^(?:\*|\*\*|\?|\[[^\]\n]+\])$/.test(token)
  );
}

function restoreSourceShapeExampleTokenLine(translatedLine: string, sourceToken: string): string {
  const spacedListMatch = translatedLine.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.+)$/);
  const collapsedListMatch = translatedLine.match(/^(\s*(?:[-*+]|\d+[.)]))(.+)$/);
  const listMatch = spacedListMatch ?? collapsedListMatch;
  if (!listMatch?.[1] || !listMatch[2]) {
    return translatedLine;
  }

  const listPrefix = listMatch[1].endsWith(" ") ? listMatch[1] : `${listMatch[1]} `;
  const body = listMatch[2];
  const tokenBodyMatch = body.match(/^(\S+)(\s*-\s*.*)$/);
  if (!tokenBodyMatch?.[1] || !tokenBodyMatch[2]) {
    return translatedLine;
  }

  return `${listPrefix}${sourceToken}${tokenBodyMatch[2]}`;
}

function canonicalizeInlineCodeFenceShape(sourceLine: string, translatedLine: string): string {
  const sourceSegments = extractInlineCodeSegments(sourceLine);
  if (sourceSegments.length === 0) {
    return translatedLine;
  }

  let currentLine = translatedLine;
  const desiredGroups = new Map<string, Map<string, number>>();
  for (const segment of sourceSegments) {
    const perContent = desiredGroups.get(segment.content) ?? new Map<string, number>();
    perContent.set(segment.raw, (perContent.get(segment.raw) ?? 0) + 1);
    desiredGroups.set(segment.content, perContent);
  }

  for (const [content, desiredRawCounts] of desiredGroups.entries()) {
    for (const [desiredRaw, desiredCount] of desiredRawCounts.entries()) {
      let actualCount = extractInlineCodeSegments(currentLine).filter((segment) => segment.raw === desiredRaw).length;
      while (actualCount < desiredCount) {
        const alternateSegment = extractInlineCodeSegments(currentLine).find(
          (segment) => segment.content === content && segment.raw !== desiredRaw
        );
        if (!alternateSegment) {
          break;
        }

        currentLine =
          `${currentLine.slice(0, alternateSegment.start)}` +
          desiredRaw +
          `${currentLine.slice(alternateSegment.end)}`;
        actualCount += 1;
      }
    }
  }

  return currentLine;
}

function extractCodeLikeSourceTokens(line: string): string[] {
  const tokens = new Set<string>();
  const tokenPattern =
    /(?:\.\.?\/|~\/|\/)[A-Za-z0-9._+~@/\-*?\[\]{}]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._+~@\-*?\[\]{}]+)+|--[A-Za-z0-9][A-Za-z0-9-]*|\.[A-Za-z0-9][A-Za-z0-9._-]*\b/g;

  for (const match of line.matchAll(tokenPattern)) {
    const token = match[0]?.trim() ?? "";
    if (!token || token.startsWith("@@MDZH_")) {
      continue;
    }

    if (!looksLikeCodeLikeSourceToken(token)) {
      continue;
    }

    tokens.add(token);
  }

  return [...tokens].sort((left, right) => right.length - left.length);
}

function looksLikeCodeLikeSourceToken(token: string): boolean {
  if (token.startsWith("http://") || token.startsWith("https://")) {
    return false;
  }

  return /[/~]|--|\.[A-Za-z0-9]/.test(token);
}

function findMangledCodeLikeTokenCandidate(translatedLine: string, sourceToken: string): string | null {
  const candidatePattern = /[A-Za-z0-9./~\\_*?\[\]{}+-]+/g;
  const sourcePrefix = extractCodeLikeTokenPrefix(sourceToken);
  const sourceSuffix = extractCodeLikeTokenSuffix(sourceToken);
  const normalizedSourceToken = sourceToken.replace(/\\/g, "");

  for (const match of translatedLine.matchAll(candidatePattern)) {
    const candidate = match[0] ?? "";
    if (!candidate || candidate === sourceToken || candidate.startsWith("@@MDZH_")) {
      continue;
    }

    const normalizedCandidate = candidate.replace(/\\/g, "");
    if (normalizedCandidate === normalizedSourceToken) {
      return candidate;
    }

    if (!containsGlobSyntax(sourceToken)) {
      continue;
    }

    if (!normalizedCandidate.startsWith(sourcePrefix) || !normalizedCandidate.endsWith(sourceSuffix)) {
      continue;
    }

    const candidateMiddle = normalizedCandidate.slice(
      sourcePrefix.length,
      normalizedCandidate.length - sourceSuffix.length
    );
    if (candidateMiddle && /^[*?_[\]/.-]+$/u.test(candidateMiddle)) {
      return candidate;
    }
  }

  return null;
}

function extractCodeLikeTokenPrefix(token: string): string {
  const wildcardIndex = token.search(/[*?[\]{}]/);
  return wildcardIndex < 0 ? token : token.slice(0, wildcardIndex);
}

function extractCodeLikeTokenSuffix(token: string): string {
  const indices = [...token.matchAll(/[*?[\]{}]/g)].map((match) => match.index ?? -1).filter((index) => index >= 0);
  if (indices.length === 0) {
    return token;
  }

  const lastIndex = indices[indices.length - 1]!;
  return token.slice(lastIndex + 1);
}

function containsGlobSyntax(token: string): boolean {
  return /[*?[\]{}]/.test(token);
}

function replaceFirst(text: string, needle: string, replacement: string): string {
  const index = text.indexOf(needle);
  if (index < 0) {
    return text;
  }

  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

export function normalizePackageRegistryTerminology(source: string, translated: string, slice: PromptSlice | null): string {
  if (!/\bregistr(?:y|ies)\b/i.test(source)) {
    return translated;
  }

  const sourceLines = source.split(/\r?\n/);
  const translatedLines = translated.split(/\r?\n/);
  let changed = false;

  for (let index = 0; index < Math.min(sourceLines.length, translatedLines.length); index += 1) {
    const sourceLine = sourceLines[index] ?? "";
    const translatedLine = translatedLines[index] ?? "";
    if (!lineHasExplicitPackageRegistrySurface(sourceLine)) {
      continue;
    }
    if (!/\bregistr(?:y|ies)\b/i.test(sourceLine) || !/注册表/.test(translatedLine)) {
      continue;
    }

    if (lineIsGovernedBySatisfiedAnchor(sourceLine, translatedLine, slice)) {
      continue;
    }

    if (/（[^）]*\bregistr(?:y|ies)\b[^）]*）/i.test(translatedLine)) {
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

function lineHasExplicitPackageRegistrySurface(sourceLine: string): boolean {
  return (
    /\b(?:npm|pip|cargo|pypi)\s+registr(?:y|ies)\b/i.test(sourceLine) ||
    /\bpackage\s+registr(?:y|ies)\b/i.test(sourceLine) ||
    /\bregistr(?:y|ies)\s+for\s+(?:npm|pip|cargo|pypi|packages?)\b/i.test(sourceLine)
  );
}

function lineIsGovernedBySatisfiedAnchor(
  sourceLine: string,
  translatedLine: string,
  slice: PromptSlice | null
): boolean {
  if (!slice) {
    return false;
  }

  const anchors = [
    ...slice.requiredAnchors,
    ...slice.repeatAnchors,
    ...slice.establishedAnchors
  ];

  return anchors.some((anchor) => {
    if (!anchor.english || !sourceLine.includes(anchor.english)) {
      return false;
    }

    return lineSatisfiesAnchorDisplay(translatedLine, anchor);
  });
}

function collectInlineCodeCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const segment of extractInlineCodeSegments(text)) {
    const token = segment.content.trim();
    if (!token) {
      continue;
    }
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function extractInlineCodeSegments(
  text: string
): Array<{ raw: string; content: string; start: number; end: number }> {
  const segments: Array<{ raw: string; content: string; start: number; end: number }> = [];
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }

    let tickCount = 1;
    while (text[index + tickCount] === "`") {
      tickCount += 1;
    }

    const fence = "`".repeat(tickCount);
    const start = index;
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
      continue;
    }

    const end = closingIndex + tickCount;
    segments.push({
      raw: text.slice(start, end),
      content: text.slice(start + tickCount, closingIndex),
      start,
      end
    });
    index = end;
  }

  return segments;
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

type StructuralSegmentDraftStrategy = {
  mode: "literal" | "prompt" | "json-blocks";
  value: string;
  blockCount?: number;
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
  const structuralSegmentDraft = classifyStructuralSegmentDraftStrategy(protectedSource);

  report(
    context.options,
    "draft",
    `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: starting translation with model ${context.draftModel}.`
  );
  const executeDraft = async (prompt: string, reuseSession: boolean) =>
    executeStageWithTimeout(
      context.executor,
      prompt,
      {
        cwd: context.cwd,
        model: context.draftModel,
        reasoningEffort: context.draftReasoningEffort,
        reuseSession,
        onStderr: (stderrChunk) =>
          reportChunkProgress(context.options, "draft", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
      },
      {
        options: context.options,
        stage: "draft",
        timeoutMs: getDraftTimeoutMs(),
        heartbeatLabel: `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: draft`,
        onHeartbeat: (message) =>
          report(context.options, "draft", message)
      }
    );
  const executeJsonBlockDraft = async (prompt: string, blockCount: number) =>
    executeStageWithTimeout(
      context.executor,
      prompt,
      {
        cwd: context.cwd,
        model: context.draftModel,
        reasoningEffort: context.draftReasoningEffort,
        reuseSession: false,
        outputSchema: buildJsonBlockDraftSchema(blockCount),
        onStderr: (stderrChunk) =>
          reportChunkProgress(context.options, "draft", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
      },
      {
        options: context.options,
        stage: "draft",
        timeoutMs: getDraftTimeoutMs(),
        heartbeatLabel: `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: draft`,
        onHeartbeat: (message) =>
          report(context.options, "draft", message)
      }
    );

  const initialDraftPrompt = withDraftChunkContext(buildInitialPrompt(protectedSource), chunkPromptContext);
  const contractSafeDraftPrompt = buildContractSafeDraftPrompt(protectedSource);
  const strictDraftRescuePrompt = buildStrictDraftRescuePrompt(protectedSource);
  const draftPrompts =
    structuralSegmentDraft?.mode === "literal"
      ? []
      : structuralSegmentDraft?.mode === "json-blocks"
        ? [
            `${contractSafeDraftPrompt}\n\n【额外约束】\n前一轮结构化 blocks 输出未形成有效正文。现在直接输出当前分段的中文译文正文本身；不要写审校说明、不要引用源文件路径、不要说“已核对/无需修正/当前块”。`,
            `${strictDraftRescuePrompt}\n\n【额外约束】\n前一轮结构化 blocks 输出失败。你只能翻译当前【英文原文】这一段本身。禁止引入任何未出现在该分段 source 中的标题、代码块、后续章节、列表或额外说明。若 source 分段中没有 heading 或 code block，译文中也不得凭空产生 heading 或 code block。`
          ]
        : structuralSegmentDraft?.mode === "prompt"
        ? [structuralSegmentDraft.value]
        : [
            initialDraftPrompt,
            `${contractSafeDraftPrompt}\n\n【额外约束】\n输出必须是该分段的中文译文正文本身；不要写审校说明、不要引用源文件路径、不要说“已核对/无需修正/当前块”。`,
            `${strictDraftRescuePrompt}\n\n【额外约束】\n你只能翻译当前【英文原文】这一段本身。禁止引入任何未出现在该分段 source 中的标题、代码块、后续章节、列表或额外说明。若 source 分段中没有 heading 或 code block，译文中也不得凭空产生 heading 或 code block。`
          ];
  let draftResult: CodexExecResult | null =
    structuralSegmentDraft?.mode === "literal"
      ? { text: structuralSegmentDraft.value, stderr: "", jsonl: "", usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 } }
      : null;
  let lastDraftViolation: string | null = null;
  if (structuralSegmentDraft?.mode === "json-blocks" && structuralSegmentDraft.blockCount) {
    try {
    const jsonDraftResult = await executeJsonBlockDraft(
      withJsonBlockDraftChunkContext(structuralSegmentDraft.value, chunkPromptContext),
      structuralSegmentDraft.blockCount
    );
    draftResult = {
      ...jsonDraftResult,
      text: stripControlPlaneContamination(reconstructJsonBlockDraft(protectedSource, jsonDraftResult.text))
    };
    const initialJsonViolation = getDraftContractViolation(protectedSource, draftResult.text);
    if (initialJsonViolation) {
      lastDraftViolation = initialJsonViolation;
      report(
        context.options,
        "draft",
        `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: ${initialJsonViolation}; retrying with a stricter JSON-block draft before text rescue.`
      );
      const strictJsonDraftResult = await executeJsonBlockDraft(
        withJsonBlockDraftChunkContext(buildStrictJsonBlockDraftPrompt(protectedSource), chunkPromptContext),
        structuralSegmentDraft.blockCount
      );
      draftResult = {
        ...strictJsonDraftResult,
        text: stripControlPlaneContamination(
          reconstructJsonBlockDraft(protectedSource, strictJsonDraftResult.text)
        )
      };
      const strictJsonViolation = getDraftContractViolation(protectedSource, draftResult.text);
      if (!strictJsonViolation) {
        lastDraftViolation = null;
      } else {
        lastDraftViolation = strictJsonViolation;
        report(
          context.options,
          "draft",
          `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: ${strictJsonViolation}; falling back to strict text rescue after JSON-block retries.`
        );
      }
    }
    } catch (jsonBlockError) {
      // JSON blocks lane failed (e.g. mock returned non-JSON, or block count
      // mismatch). Fall through to the text draft prompts below.
      draftResult = null;
      lastDraftViolation = jsonBlockError instanceof Error ? jsonBlockError.message : String(jsonBlockError);
    }
  }
  if (!draftResult || lastDraftViolation) {
    for (const [attemptIndex, draftPrompt] of draftPrompts.entries()) {
      const rawDraftResult = await executeDraft(draftPrompt, false);
      draftResult = {
        ...rawDraftResult,
        text: stripControlPlaneContamination(rawDraftResult.text)
      };
      const violation = getDraftContractViolation(protectedSource, draftResult.text);
      if (!violation) {
        lastDraftViolation = null;
        break;
      }
      lastDraftViolation = violation;
      if (attemptIndex < draftPrompts.length - 1) {
        report(
          context.options,
          "draft",
          `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: ${violation}; retrying with a stricter clean draft session.`
        );
      }
    }
  }

  if (!draftResult) {
    throw new CodexExecutionError("Draft did not return a usable result.");
  }

  if (lastDraftViolation) {
    throw new CodexExecutionError(
      `Draft contract failed for ${chunkLabel} after clean retries: ${lastDraftViolation}.`
    );
  }
  threadId = draftResult.threadId;
  const dedupedDraftText = dedupDraftDuplicateTailSentences(
    protectedSource,
    dedupDraftDuplicateTailBlocks(protectedSource, draftResult.text)
  );
  const normalizedDraftText = normalizeSegmentAnchorText(
    stripAddedInlineCodeFromPlainPaths(protectedSource, dedupedDraftText),
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
    normalizedSurfaceDraftText,
    headingPlanningSlice
  );
  const emphasisPlannedDraftText = applyEmphasisPlanTargets(
    protectedSource,
    normalizedRegistryDraftText,
    headingPlanningSlice
  );
  const semanticPlannedDraftText = applySemanticMentionPlans(
    protectedSource,
    emphasisPlannedDraftText,
    headingPlanningSlice
  );
  const blockPlannedDraftText = applyBlockPlanTargets(
    protectedSource,
    semanticPlannedDraftText,
    headingPlanningSlice
  );
  const restoredInlineDraftText = restoreInlineCodeFromSourceShape(
    protectedSource,
    blockPlannedDraftText
  );
  const restoredCodeLikeDraftText = restoreCodeLikeSourceShape(
    protectedSource,
    restoredInlineDraftText
  );
  const restoredExampleTokenDraftText = restoreSourceShapeExampleTokens(
    protectedSource,
    restoredCodeLikeDraftText
  );
  const normalizedDraftSurfaceText = collapseRunawayEnglishAnchorChain(
    normalizeMalformedInlineEnglishEmphasis(
      normalizeMarkdownLinkLabelWhitespace(restoredExampleTokenDraftText)
    )
  );
  const canonicalProtectedBody = reprotectMarkdownSpans(normalizedDraftSurfaceText, combinedSpans);
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

function buildContractSafeDraftPrompt(source: string): string {
  return [
    "你是一名 Markdown 翻译器。",
    "只翻译下面这一小段英文 Markdown，本轮第一优先级是保持结构和内容边界严格不越界。",
    "规则：",
    "1. 只输出该分段的中文译文，不要解释。",
    "2. 不要引入 source 中不存在的标题、代码块、列表、引用、额外段落或后续章节。",
    "3. 如果 source 中没有 heading 或 code block，译文中也不得凭空产生 heading 或 code block。",
    "4. 保留 inline code、命令 flag、URL、链接目标和 Markdown 强调结构。",
    "",
    "【英文原文】",
    source
  ].join("\n");
}

function buildJsonBlockDraftPrompt(source: string): string {
  const blocks = splitPromptBlocks(source)
    .map((block, index) => `### BLOCK ${index + 1} (${classifyPromptBlockKind(block.content)})\n${block.content}`)
    .join("\n\n");

  return [
    "你是一名 Markdown 译者。",
    "当前输入是一个多块 Markdown 分段。请逐块翻译，并只返回 JSON。",
    "要求：",
    "1. 必须返回与 source 完全相同数量的 blocks。",
    "2. 每个 block 只写该块对应的中文 Markdown 内容。",
    "3. 不要解释，不要添加额外 block，不要合并或重排。",
    "4. 引用仍是引用，source 中没有 heading 或 code block 的地方，译文中不得凭空新增。",
    "5. 对标注为 code 的 block：保持原样返回，不要翻译代码、注释或命令输出；如果无法原样返回，可以返回空字符串，程序会把源代码贴回来。",
    "6. 术语处理：对任何锚点术语（anchor glossary 里给出的英文-中文对），只输出其 preferred_chinese_hint 即可，如 sandbox mode -> 沙盒模式、Seatbelt -> 保持英文 Seatbelt（因 english-primary），不要自己加括号中英对照，程序会统一在首次出现处补 `（English）` 括注。重复锚点只写中文或只写英文即可。",
    "7. 禁止输出任何任务状态、验证证据、分支信息、工作区状态、git status、路径说明，或“已完成/已核对/已复核/继续执行”之类的元话语。",
    "8. 禁止输出任何控制面标签或指令文本，例如 <hook_prompt ...>、OMX、Ralph、stop:...、::git-*、::archive 等。",
    "",
    "【按块展开的英文原文】",
    blocks
  ].join("\n");
}

function buildStrictJsonBlockDraftPrompt(source: string): string {
  const blocks = splitPromptBlocks(source)
    .map((block, index) => `### BLOCK ${index + 1} (${classifyPromptBlockKind(block.content)})\n${block.content}`)
    .join("\n\n");

  return [
    "你是一名 Markdown 译者。",
    "上一轮 JSON blocks 输出不合格。请再次逐块翻译，并且只返回 JSON。",
    "强约束：",
    "1. 只返回 blocks 数组，长度必须与 source block 数完全一致。",
    "2. 每个 block 只能翻译当前 block，不得合并、拆分、重排或遗漏。",
    "3. 必须保留 inline code、命令 flag、URL、链接目标、数字和 Markdown 强调结构。",
    "4. 禁止输出解释、审校说明、验证证据、控制面文本、文件路径、git status、hook_prompt、OMX、Ralph、::git-*、::archive 等。",
    "5. 如果不确定，优先保留原 block 结构与受保护字面，不要自由发挥。",
    "",
    "【按块展开的英文原文】",
    blocks
  ].join("\n");
}

function buildJsonBlockRepairPrompt(source: string, translation: string, mustFix: readonly string[]): string {
  const sourceBlocks = splitPromptBlocks(source)
    .map((block, index) => `### SOURCE BLOCK ${index + 1} (${classifyPromptBlockKind(block.content)})\n${block.content}`)
    .join("\n\n");
  const translatedBlocks = splitPromptBlocks(translation)
    .map((block, index) => `### CURRENT BLOCK ${index + 1} (${classifyPromptBlockKind(block.content)})\n${block.content}`)
    .join("\n\n");

  return [
    "你是一名 Markdown 修复器。请只返回 JSON。",
    "当前分段需要修复，但必须严格保持与 source 相同的块数和块顺序。",
    "要求：",
    "1. 只返回 blocks 数组，长度必须与 source block 数一致。",
    "2. 每个 block 只写该块修复后的中文 Markdown 内容。",
    "3. 不要合并、拆分、重排，也不要输出解释。",
    "4. 修复以下 must_fix：",
    "5. 禁止输出任何任务状态、验证证据、分支信息、工作区状态、git status、路径说明，或“已完成/已核对/已复核/继续执行”之类的元话语。",
    "6. 禁止输出任何控制面标签或指令文本，例如 <hook_prompt ...>、OMX、Ralph、stop:...、::git-*、::archive 等。",
    ...mustFix.map((item, index) => `${index + 1}. ${item}`),
    "",
    "【按块展开的英文原文】",
    sourceBlocks,
    "",
    "【当前译文按块展开】",
    translatedBlocks
  ].join("\n");
}

function buildJsonBlockDraftSchema(blockCount: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["blocks"],
    properties: {
      blocks: {
        type: "array",
        minItems: blockCount,
        maxItems: blockCount,
        items: {
          type: "string"
        }
      }
    }
  };
}

function reconstructJsonBlockDraft(source: string, jsonText: string): string {
  const parsed = JSON.parse(jsonText) as { blocks?: unknown };
  if (!Array.isArray(parsed.blocks)) {
    throw new CodexExecutionError("JSON block draft is missing blocks.");
  }
  const translatedBlocks = parsed.blocks as unknown[];

  const sourceBlocks = splitPromptBlocks(source);
  if (translatedBlocks.length !== sourceBlocks.length) {
    throw new CodexExecutionError("JSON block draft returned an unexpected block count.");
  }

  return sourceBlocks
    .map((block, index) => {
      const translatedRaw = typeof translatedBlocks[index] === "string" ? translatedBlocks[index] : "";
      // P2: fenced / indented code blocks are not translated. Ignore whatever
      // the LLM returned for those slots and pin them to the source content so
      // code cannot be re-wrapped or paraphrased.
      const kind = classifyPromptBlockKind(block.content);
      const translated = kind === "code" ? block.content : translatedRaw;
      return index === sourceBlocks.length - 1 ? translated : `${translated}${block.separator}`;
    })
    .join("");
}

function buildSentenceDraftPrompt(source: string): string {
  return [
    "你是一名 Markdown 译者。",
    "当前输入只有一个正文句或单段。只输出这一句/这一段对应的中文译文，不要新增标题、列表、代码块、解释、核对说明或文件路径。",
    "禁止输出任何任务状态、验证证据、分支信息、工作区状态、git status、路径说明，或“已完成/已核对/已复核/继续执行”之类的元话语。",
    "禁止输出任何控制面标签或指令文本，例如 <hook_prompt ...>、OMX、Ralph、stop:...、::git-*、::archive 等。",
    "如果原文里有 Markdown 强调、inline code、命令 flag、链接或 URL，必须保持等价结构。",
    "",
    "【英文原文】",
    source
  ].join("\n");
}

function buildStrictDraftRescuePrompt(source: string): string {
  const blocks = splitPromptBlocks(source);
  return blocks.length >= 2 ? buildBlockStructuredDraftPrompt(source) : buildSentenceDraftPrompt(source);
}

function buildBlockStructuredDraftPrompt(source: string): string {
  const blocks = splitPromptBlocks(source)
    .map((block, index) => `### BLOCK ${index + 1} (${classifyPromptBlockKind(block.content)})\n${block.content}`)
    .join("\n\n");

  return [
    "你是一名 Markdown 译者。",
    "当前输入是一个多块 Markdown 分段。必须逐块翻译，不能合并、拆分、增删或重排。",
    "要求：",
    "1. 只输出最终中文 Markdown，不要解释。",
    "2. 保持与 source 完全相同的块数和相对顺序。",
    "3. 引用仍是引用；source 中没有 heading 或 code block 的地方，译文中不得凭空新增。",
    "4. 保留 inline code、命令 flag、URL、链接目标和 Markdown 强调结构。",
    "5. 禁止输出任何任务状态、验证证据、分支信息、工作区状态、git status、路径说明，或“已完成/已核对/已复核/继续执行”之类的元话语。",
    "6. 禁止输出任何控制面标签或指令文本，例如 <hook_prompt ...>、OMX、Ralph、stop:...、::git-*、::archive 等。",
    "",
    "【按块展开的英文原文】",
    blocks
  ].join("\n");
}

function classifyStructuralSegmentDraftStrategy(source: string): StructuralSegmentDraftStrategy | null {
  // P2 (#14) default inversion: every translatable segment goes to the
  // JSON-blocks lane unless it is a single-line literal (heading /
  // attribution / kicker). The previous conservative size / kind thresholds
  // funneled most medium-complexity segments back to freeform, where LLM
  // specific output pathologies (duplicate blocks, dropped list newlines,
  // prompt-leak into body, etc.) kept producing a new failure every full
  // smoke run. Freeform remains available as an explicit fallback when
  // json-blocks fails schema / contract checks — see translateProtectedSegment.
  const trimmed = source.trim();

  // Literal opt-outs (single-line, no block splitting needed).
  if (trimmed && !trimmed.includes("\n\n")) {
    if (isHeadingLikeBlock(trimmed)) {
      return { mode: "literal", value: source };
    }
    if (isAttributionLikeBlock(trimmed)) {
      return { mode: "literal", value: source };
    }
    if (isNumericKickerLikeBlock(trimmed)) {
      return { mode: "literal", value: source };
    }
  }

  const blocks = splitPromptBlocks(source);
  if (blocks.length === 0) {
    return null;
  }
  // Pure-code opt-out: if every block in the segment is a code block, skip
  // json-blocks entirely and return literal. Full-smoke run observed LLM
  // hanging (180s timeout) on a segment whose sole content was a fenced code
  // block with malicious-looking shell commands — the safety gate in the
  // model appears to refuse to engage at all. Code blocks are not translated
  // anyway (reconstructJsonBlockDraft already pins them back to source), so
  // the LLM round-trip adds nothing but risk.
  if (blocks.every((block) => classifyPromptBlockKind(block.content) === "code")) {
    return { mode: "literal", value: source };
  }
  return {
    mode: "json-blocks",
    value: buildJsonBlockDraftPrompt(source),
    blockCount: blocks.length
  };
}

function buildStructuralSegmentDraftPrompt(
  source: string,
  kind: "heading" | "attribution" | "kicker"
): string {
  const kindInstruction =
    kind === "heading"
      ? "当前 source 是单独一行标题。只输出这一行对应的中文 Markdown 标题，不要新增别的段落、代码块或说明。"
      : kind === "attribution"
        ? "当前 source 是单独一行图注/署名/归属说明。只输出这一行对应的中文 Markdown，不要新增别的段落、标题、列表或说明。"
        : "当前 source 是单独一行数字 kicker 或编号。若不需要翻译，可原样保留；无论如何只输出这一行，不要新增别的段落或说明。";

  return [
    "你是一名 Markdown 翻译器。",
    kindInstruction,
    "只输出该单行分段本身对应的结果。",
    "",
    "【英文原文】",
    source
  ].join("\n");
}

function stripControlPlaneContamination(text: string): string {
  let sanitized = text;
  sanitized = sanitized.replace(/<hook_prompt\b[^>]*>[\s\S]*?<\/hook_prompt>/giu, "");
  sanitized = sanitized.replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/giu, "");

  const filteredLines = sanitized.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return true;
    }

    if (/^::git-[\w-]+\{.*\}$/u.test(trimmed) || /^::archive\{.*\}$/u.test(trimmed)) {
      return false;
    }

    if (
      /^OMX\b/u.test(trimmed) ||
      /^Ralph\b/u.test(trimmed) ||
      /^hook_prompt\b/u.test(trimmed) ||
      /^hook_run_id\b/u.test(trimmed) ||
      /^stop:\d+:/u.test(trimmed)
    ) {
      return false;
    }

    return true;
  });

  return filteredLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function getDraftContractViolation(source: string, text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return source.trim() ? "draft returned empty content" : null;
  }

  // Issue #69 (B): reject repair output that emits raw `**` markers when the
  // protected source had zero raw `**` (all bold spans are placeholder-tokenized
  // as `@@MDZH_STRONG_EMPHASIS_NNNN@@`). Raw `**` leaking through means the LLM
  // invented bold markup, which corrupts span boundaries downstream. Runs
  // before block-kind checks because a single-line `**X**` otherwise triggers
  // the heading misclassification branch first and hides the root cause.
  const sourceBoldCount = (source.match(/\*\*/g) ?? []).length;
  const draftBoldCount = (trimmed.match(/\*\*/g) ?? []).length;
  if (sourceBoldCount === 0 && draftBoldCount > 0) {
    return `draft introduced raw bold markers (** x ${draftBoldCount}) not present in the protected source`;
  }

  const trimmedSource = source.trim();
  if (trimmed === trimmedSource) {
    const strippedSource = trimmedSource
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]*`/g, "")
      .replace(/\bhttps?:\/\/\S+/gi, "")
      .replace(/[\p{P}\p{S}\s]/gu, "");
    const englishLetters = strippedSource.match(/[A-Za-z]/g);
    if (englishLetters && englishLetters.length >= 15 && !/[\u4e00-\u9fff]/u.test(trimmed)) {
      return "draft echoed the source verbatim instead of translating";
    }
  }

  if (
    /file:\/\//i.test(trimmed) ||
    /\[[^\]]+\.md\]\(file:\/\//i.test(trimmed) ||
    /(源文件|对应段落|当前块|硬性项|无需修正|没有发现需要|已核对|已复核|任务已完成|验证证据|当前分支|工作区|未提交改动|后续：|继续执行|继续补充|OMX|Ralph|hook_prompt|hook_run_id|stop:\d+:|::git-|::archive|thread\/resume|首现需补双语锚定|补双语锚定|首次出现需补)/u.test(trimmed)
  ) {
    return "draft returned meta/audit text";
  }

  // Detect protected-span placeholder duplication: any `@@MDZH_*@@` token that
  // appears more times in draft than in source means LLM cloned the link /
  // code placeholder, which would fail validateStructuralGateChecks later
  // with no repair path. Catch at draft contract so retry prompts can try
  // again.
  const placeholderPattern = /@@MDZH_[A-Z_]+_\d+@@/g;
  const sourcePlaceholderCounts = new Map<string, number>();
  for (const match of source.matchAll(placeholderPattern)) {
    const token = match[0];
    sourcePlaceholderCounts.set(token, (sourcePlaceholderCounts.get(token) ?? 0) + 1);
  }
  const draftPlaceholderCounts = new Map<string, number>();
  for (const match of trimmed.matchAll(placeholderPattern)) {
    const token = match[0];
    draftPlaceholderCounts.set(token, (draftPlaceholderCounts.get(token) ?? 0) + 1);
  }
  for (const [token, count] of draftPlaceholderCounts) {
    const sourceCount = sourcePlaceholderCounts.get(token) ?? 0;
    if (count > sourceCount) {
      return `draft duplicated protected-span placeholder ${token} (source=${sourceCount}, draft=${count})`;
    }
  }

  // Catch the "lazy LLM" pattern where a list item is replaced by ellipsis
  // ("- ……" or "- ...") but the source list item is real content. The audit
  // catches this too but repairing from a missing item is harder than rejecting
  // it at the draft contract.
  const ellipsisLineInBody = trimmed.split(/\r?\n/).some((line) => {
    const stripped = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
    return /^(?:…+|\.{3,})$/.test(stripped);
  });
  if (ellipsisLineInBody) {
    const sourceHasEllipsisItem = source.split(/\r?\n/).some((line) => {
      const stripped = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
      return /^(?:…+|\.{3,})$/.test(stripped);
    });
    if (!sourceHasEllipsisItem) {
      return "draft replaced a list item with ellipsis instead of translating it";
    }
  }

  if (looksLikeStructuredOutputDebris(source, trimmed)) {
    return "draft returned structured-output debris instead of translated content";
  }

  const sourceBlocks = splitPromptBlocks(source);
  const translatedBlocks = splitPromptBlocks(trimmed);
  const sourceKinds = new Set(sourceBlocks.map((block) => classifyPromptBlockKind(block.content)));
  const translatedKinds = new Set(translatedBlocks.map((block) => classifyPromptBlockKind(block.content)));

  if (!sourceKinds.has("heading") && translatedKinds.has("heading")) {
    return "draft introduced heading blocks that are not present in the source segment";
  }

  if (!sourceKinds.has("code") && translatedKinds.has("code")) {
    return "draft introduced code blocks that are not present in the source segment";
  }

  if (translatedBlocks.length > sourceBlocks.length + 2) {
    return "draft expanded the block structure beyond the source segment";
  }

  if (source.length > 0 && trimmed.length > source.length * 2.8) {
    return "draft expanded far beyond the source segment length";
  }

  // Issue #69 (A): reject repair output that stacks the same English term in
  // two adjacent parenthetical annotations, e.g.
  // `（Small Language Models (SLMs)）（SLMs）` or `（SLMs）（SLMs）`. This pattern
  // emerges when repair over-fixes a first_mention_bilingual audit hint inside
  // a protected bold span; the downstream collapse helper only catches 3+
  // adjacent duplicates, so two-window stacks leak through to audit.
  const parenWindowPattern = /（\s*([A-Za-z][A-Za-z0-9 .+/_\-()]*?)\s*）/gu;
  const parenWindows: { start: number; end: number; innerKey: string }[] = [];
  for (const match of trimmed.matchAll(parenWindowPattern)) {
    const inner = match[1]!.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (inner.length === 0) {
      continue;
    }
    parenWindows.push({
      start: match.index!,
      end: match.index! + match[0].length,
      innerKey: inner
    });
  }
  for (let i = 1; i < parenWindows.length; i += 1) {
    const prev = parenWindows[i - 1]!;
    const curr = parenWindows[i]!;
    const between = trimmed.slice(prev.end, curr.start);
    if (!/^[\s*]*$/.test(between)) {
      continue;
    }
    const a = prev.innerKey;
    const b = curr.innerKey;
    if (a === b || a.includes(b) || b.includes(a)) {
      const snippetStart = Math.max(0, prev.start - 10);
      const snippetEnd = Math.min(trimmed.length, curr.end + 10);
      return `draft stacked duplicate English parenthetical annotation near: ${trimmed.slice(snippetStart, snippetEnd)}`;
    }
  }

  return null;
}

function looksLikeStructuredOutputDebris(source: string, text: string): boolean {
  if (/```json/i.test(text)) {
    return true;
  }

  const sourceAllowsCodeFence = /```/.test(source);
  if (sourceAllowsCodeFence) {
    return false;
  }

  if (/\bblocks\b/i.test(text) && !/\bblocks\b/i.test(source)) {
    return true;
  }

  const punctuationOnlyDensity = text.replace(/[A-Za-z\u4e00-\u9fff0-9]/g, "");
  const punctuationHeavy = punctuationOnlyDensity.length > text.length * 0.45;
  const hasBraceRuns = /[\[\]{}":,`]{6,}/.test(text);
  const startsLikeJsonGarbage = /^[\]\[}{":,\s]{4,}(?:json)?/i.test(text);

  return (punctuationHeavy && hasBraceRuns) || startsLikeJsonGarbage;
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
    const executeRepair = async (prompt: string, useThread: boolean) =>
      executeStageWithTimeout(
        context.executor,
        prompt,
        {
          cwd: context.cwd,
          model: context.postDraftModel,
          reasoningEffort: context.postDraftReasoningEffort ?? REPAIR_REASONING_EFFORT,
          reuseSession: false,
          onStderr: (stderrChunk) =>
            reportChunkProgress(
              context.options,
              "repair",
              draftedSegment.promptContext.chunkIndex - 1,
              plan,
              `${chunkLabel}, segment ${draftedSegment.segment.index + 1}${batchSuffix}`,
              stderrChunk
            )
        },
        {
          options: context.options,
          stage: "repair",
          timeoutMs: getRepairTimeoutMs(),
          heartbeatLabel: `Chunk ${draftedSegment.promptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}, segment ${draftedSegment.segment.index + 1}${batchSuffix}: repair`,
          onHeartbeat: (message) => report(context.options, "repair", message)
        }
      );
    const executeJsonBlockRepair = async (prompt: string, blockCount: number) =>
      executeStageWithTimeout(
        context.executor,
        prompt,
        {
          cwd: context.cwd,
          model: context.postDraftModel,
          reasoningEffort: context.postDraftReasoningEffort ?? REPAIR_REASONING_EFFORT,
          reuseSession: false,
          outputSchema: buildJsonBlockDraftSchema(blockCount),
          onStderr: (stderrChunk) =>
            reportChunkProgress(
              context.options,
              "repair",
              draftedSegment.promptContext.chunkIndex - 1,
              plan,
              `${chunkLabel}, segment ${draftedSegment.segment.index + 1}${batchSuffix}`,
              stderrChunk
            )
        },
        {
          options: context.options,
          stage: "repair",
          timeoutMs: getRepairTimeoutMs(),
          heartbeatLabel: `Chunk ${draftedSegment.promptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}, segment ${draftedSegment.segment.index + 1}${batchSuffix}: repair`,
          onHeartbeat: (message) => report(context.options, "repair", message)
        }
      );

    const baseRepairPrompt = withChunkContext(
      buildRepairPrompt(draftedSegment.protectedSource, draftedSegment.protectedBody, mustFixBatch),
      repairPromptContext
    );
    const sourceBlockCount = splitPromptBlocks(draftedSegment.protectedSource).length;
    const repairPrompts =
      sourceBlockCount >= 1
        ? [
            {
              prompt: buildJsonBlockRepairPrompt(
                draftedSegment.protectedSource,
                draftedSegment.protectedBody,
                mustFixBatch
              ),
              useThread: false,
              mode: "json-blocks" as const
            },
            {
              prompt: `${baseRepairPrompt}\n\n【额外约束】\n输出必须是修复后的当前分段中文译文正文本身；不要写核对说明、不要引用源文件路径、不要报告“已检查/已核验/无需修正”。`,
              useThread: false,
              mode: "text" as const
            },
            {
              prompt: `${buildStrictDraftRescuePrompt(draftedSegment.protectedSource)}\n\n【修复要求】\n${mustFixBatch.join("\n")}`,
              useThread: false,
              mode: "text" as const
            }
          ]
        : [
            { prompt: baseRepairPrompt, useThread: false, mode: "text" as const },
            {
              prompt: `${baseRepairPrompt}\n\n【额外约束】\n输出必须是修复后的当前分段中文译文正文本身；不要写核对说明、不要引用源文件路径、不要报告“已检查/已核验/无需修正”。`,
              useThread: false,
              mode: "text" as const
            },
            {
              prompt: `${buildStrictDraftRescuePrompt(draftedSegment.protectedSource)}\n\n【修复要求】\n${mustFixBatch.join("\n")}`,
              useThread: false,
              mode: "text" as const
            }
          ];

    let repairResult: CodexExecResult | null = null;
    let lastRepairViolation: string | null = null;
    for (const [attemptIndex, item] of repairPrompts.entries()) {
      if (item.mode === "json-blocks") {
        try {
          const result = await executeJsonBlockRepair(item.prompt, sourceBlockCount);
          repairResult = {
            ...result,
            text: stripControlPlaneContamination(
              reconstructJsonBlockDraft(draftedSegment.protectedSource, result.text)
            )
          };
        } catch {
          // JSON block repair failed (e.g. non-JSON response). Skip to next
          // repair prompt (text mode) which doesn't require structured output.
          continue;
        }
      } else {
        const rawRepairResult = await executeRepair(item.prompt, item.useThread);
        repairResult = {
          ...rawRepairResult,
          text: stripControlPlaneContamination(rawRepairResult.text)
        };
      }
      const violation = getDraftContractViolation(draftedSegment.protectedSource, repairResult.text);
      if (!violation) {
        lastRepairViolation = null;
        break;
      }
      lastRepairViolation = violation;
      if (attemptIndex < repairPrompts.length - 1) {
        report(
          context.options,
          "repair",
          `Chunk ${draftedSegment.promptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}, segment ${draftedSegment.segment.index + 1}${batchSuffix}: repair returned invalid content (${violation}); retrying with a stricter clean repair session.`
        );
      }
    }

    if (!repairResult) {
      throw new CodexExecutionError("Repair did not return a usable result.");
    }

    if (lastRepairViolation) {
      throw new CodexExecutionError(
        `Repair contract failed after clean retries: ${lastRepairViolation}.`
      );
    }

    if (repairResult.threadId) {
      draftedSegment.threadId = repairResult.threadId;
    }
    const dedupedRepairText = dedupDraftDuplicateTailSentences(
      draftedSegment.protectedSource,
      dedupDraftDuplicateTailBlocks(draftedSegment.protectedSource, repairResult.text)
    );
    const normalizedRepairText = normalizeSegmentAnchorText(
      stripAddedInlineCodeFromPlainPaths(draftedSegment.protectedSource, dedupedRepairText),
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
      normalizedSurfaceRepairText,
      headingPlanningSlice
    );
    const emphasisPlannedRepairText = applyEmphasisPlanTargets(
      draftedSegment.protectedSource,
      normalizedRegistryRepairText,
      headingPlanningSlice
    );
    const semanticPlannedRepairText = applySemanticMentionPlans(
      draftedSegment.protectedSource,
      emphasisPlannedRepairText,
      headingPlanningSlice
    );
    const blockPlannedRepairText = applyBlockPlanTargets(
      draftedSegment.protectedSource,
      semanticPlannedRepairText,
      headingPlanningSlice
    );
    const restoredInlineRepairText = restoreInlineCodeFromSourceShape(
      draftedSegment.protectedSource,
      blockPlannedRepairText
    );
    const restoredCodeLikeRepairText = restoreCodeLikeSourceShape(
      draftedSegment.protectedSource,
      restoredInlineRepairText
    );
    const restoredExampleTokenRepairText = restoreSourceShapeExampleTokens(
      draftedSegment.protectedSource,
      restoredCodeLikeRepairText
    );
    const normalizedRepairSurfaceText = collapseRunawayEnglishAnchorChain(
      normalizeMalformedInlineEnglishEmphasis(
        normalizeMarkdownLinkLabelWhitespace(restoredExampleTokenRepairText)
      )
    );
    draftedSegment.protectedBody = reprotectMarkdownSpans(
      normalizedRepairSurfaceText,
      draftedSegment.spans
    );
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

function extractParagraphMatchMissingSources(mustFix: readonly string[]): string[] {
  const missing = new Set<string>();
  for (const raw of mustFix) {
    const item = raw ?? "";
    const mentionsParagraphMatch =
      /paragraph_match/i.test(item) ||
      item.includes("段落对应") ||
      item.includes("段落数") ||
      item.includes("段落不对齐") ||
      item.includes("缺少原文") ||
      /漏[翻译]/.test(item);
    if (!mentionsParagraphMatch) {
      continue;
    }
    const quotePattern = /["“]([^"”\n]{8,})["”]/g;
    let match: RegExpExecArray | null;
    while ((match = quotePattern.exec(item)) != null) {
      const text = match[1]?.trim();
      if (text && text.length >= 8) {
        missing.add(text);
      }
    }
  }
  return [...missing];
}

function extractFirstMentionBilingualTargets(mustFix: readonly string[]): string[] {
  const targets = new Set<string>();
  for (const raw of mustFix) {
    const item = raw ?? "";
    const mentionsFirstMention =
      /first_mention_bilingual/i.test(item) ||
      ((item.includes("首次出现") || item.includes("首现")) &&
        (item.includes("中英") ||
          item.includes("双语") ||
          item.includes("对照") ||
          item.includes("英文原名")));
    if (!mentionsFirstMention) {
      continue;
    }
    for (const match of item.matchAll(/[“"`']([A-Za-z][A-Za-z0-9./+&:_ -]{0,79})[”"`']/g)) {
      const candidate = match[1]?.trim();
      if (candidate && /[A-Za-z]/.test(candidate)) {
        targets.add(candidate);
      }
    }
    for (const match of item.matchAll(
      /(?:核心术语|术语|英文目标|英文词|英文原名|产品名|工具名|项目名|模型名|CLI 名称|命令名|框架名|平台名|机制名|概念|首次出现的|首现的)\s+([A-Za-z][A-Za-z0-9./+&:_ -]{0,79}?)(?=\s*(?:首次|首现|在|需|应|未|缺少|没有|作为|并|，|。|；|：|$))/g
    )) {
      const candidate = match[1]?.trim();
      if (candidate && /[A-Za-z]/.test(candidate)) {
        targets.add(candidate);
      }
    }
  }
  return [...targets];
}

function buildRepairPromptContext(
  promptContext: ChunkPromptContext,
  mustFix: readonly string[]
): ChunkPromptContext {
  const extraNotes = [...promptContext.specialNotes];
  const matchedPendingRepairs =
    promptContext.stateSlice?.pendingRepairs.filter((repair) => mustFix.includes(repair.instruction)) ?? [];
  const matchedSentenceConstraints = matchedPendingRepairs
    .map((repair) => repair.sentenceConstraint)
    .filter(
      (
        constraint
      ): constraint is {
        quotedText?: string;
        forbiddenTerms?: string[];
        sourceReferenceTexts?: string[];
      } => Boolean(constraint)
    );
  const matchedStructuredTargets = matchedPendingRepairs
    .map((repair) => repair.structuredTarget)
    .filter((target): target is StructuredRepairTarget => Boolean(target));
  const matchedAnalysisTargets = [
    ...new Set(matchedPendingRepairs.flatMap((repair) => repair.analysisTargets ?? []))
  ];
  if (matchedStructuredTargets.length > 0) {
    extraNotes.push(
      `本次 must_fix 已绑定这些结构化修复目标：${matchedStructuredTargets
        .map((target) =>
          [
            `位置=${target.location}`,
            `类型=${target.kind}`,
            target.currentText ? `当前=${target.currentText}` : null,
            target.targetText ? `目标=${target.targetText}` : null
          ]
            .filter(Boolean)
            .join("；")
        )
        .join(" | ")}。`,
      "修复时优先按这些结构化目标直接落地，不要再根据 must_fix 里的动词措辞猜测真正目标。"
    );
  }
  if (matchedAnalysisTargets.length > 0) {
    extraNotes.push(
      `本次 must_fix 已关联到这些 IR 目标：${matchedAnalysisTargets.join(" | ")}。`,
      "修复时优先服从这些结构化 IR 目标，不要再自由改写同一标题、术语或强调结构的语义目标。"
    );
  } else {
    const matchedAnalysisPlans =
      promptContext.stateSlice?.analysisPlans.filter((plan) =>
        mustFix.some((instruction) =>
          findMatchingAnalysisPlansForInstruction(promptContext.stateSlice as PromptSlice, instruction).some(
            (matchedPlan) => matchedPlan.id === plan.id
          )
        )
      ) ?? [];
    if (matchedAnalysisPlans.length > 0) {
    extraNotes.push(
      `本次 must_fix 已关联到这些 IR 计划：${matchedAnalysisPlans
        .map((plan) => `${plan.kind}:${plan.sourceText}${plan.targetText ? ` -> ${plan.targetText}` : ""}`)
        .join(" | ")}。`,
      "修复时优先服从这些结构化 IR 计划，不要再自由改写同一标题、术语或强调结构的语义目标。"
    );
    }
  }
  if (matchedSentenceConstraints.length > 0) {
    extraNotes.push(
      `本次 must_fix 已绑定这些句子级约束：${matchedSentenceConstraints
        .map((constraint) =>
          [
            constraint.quotedText ? `句子=${constraint.quotedText}` : null,
            constraint.forbiddenTerms?.length ? `禁止新增=${constraint.forbiddenTerms.join("/")}` : null,
            constraint.sourceReferenceTexts?.length ? `原文对齐=${constraint.sourceReferenceTexts.join("/")}` : null
          ]
            .filter(Boolean)
            .join("；")
        )
        .join(" | ")}。`,
      "修复时只修改被点名的这一句，并删除这些被明确禁止新增的限定词；不要把后文平台名、系统名或工具名提前挪到当前句里。",
      "如果约束同时给了“原文对齐”英文片段，应让当前句仅表达这些 source 里存在的限定，不要补出额外平台或系统名。"
    );
  }
  if ((promptContext.stateSlice?.blockPlans.length ?? 0) > 1) {
    extraNotes.push(
      `当前分段块顺序必须遵循 IR：${promptContext.stateSlice!.blockPlans
        .map((plan) => `${plan.blockIndex}:${plan.blockKind}:${plan.sourceText}`)
        .join(" | ")}。`,
      "修复时不要把后面的标题、说明句、引用、列表或代码块提前到前面；若当前错误涉及段落顺序，必须恢复为这份块顺序。"
    );
  }
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

  const paragraphMatchMissingSources = extractParagraphMatchMissingSources(mustFix);
  if (paragraphMatchMissingSources.length > 0) {
    const quoted = paragraphMatchMissingSources.map((text) => `"${text}"`).join(" | ");
    extraNotes.push(
      `本次 must_fix 明确指出当前段落或标题块漏翻了以下原文片段：${quoted}。`,
      "paragraph_match 硬失败的本质是“内容缺失”而非排版问题：修复时必须把这些原文片段完整译成中文并接回当前段落，不得以“保持标题风格”“局部补丁”“已检查”“与原文一致”为理由省略、压缩或只润色旧译文。",
      "如果当前段落是 Markdown 标题或加粗标题，把新译文接在标题现有文本之后，必要时用逗号、句号、破折号或括号串联，整段仍保持为单一标题节点（不得拆行、不得新增独立段落）。",
      "输出的修订译文相对当前译文必须明显变长，且新增内容要与上述原文逐句对应；严禁只重新排版或返回几乎相同的句子。"
    );
  }

  const firstMentionBilingualTargets = extractFirstMentionBilingualTargets(mustFix);
  if (firstMentionBilingualTargets.length > 0) {
    const joined = firstMentionBilingualTargets.join(" / ");
    extraNotes.push(
      `本次 must_fix 指向 first_mention_bilingual 硬失败：以下英文专名或术语在首现位置缺少中英双语锚定：${joined}。`,
      "修复流程分两步：(1) 先检查当前译文里该英文词对应的中文译名是否已经出现；(2) 按下面的切片变换在对应首现位置就地补齐。不要另起一段、另开列表项，也不要把锚点挪到标题或总结句里。",
      "切片 A——译文里已经有该概念的中文译名（例如“波音 747”“实体-关系”），直接在该中文译名之后紧跟一层括注写成“中文译名（English）”，例如“波音 747（Boeing 747）”；不要在同一段其他位置再重复这个英文原名。",
      "切片 B——译文完全漏掉该概念，就在最自然的首现位置补“中文译名（English）”整串，保持单层括注；不要写成“English（中文译名）”倒装形式，也不要只补英文原名。",
      "严禁以下回避写法：(a) 同一英文原名在同段生成相邻重复括注，例如“（Boeing 747）（Boeing 747）”；(b) 双层括号如“（中文（English））”；(c) 把该英文原名改成 inline code 或加粗；(d) 用“英文原名直接当作中文”的等价省略写法。",
      "如果 must_fix 同时点名多个英文目标，必须在各自的首现位置分别补齐；不要因为其中一个已经补过，就认为整段已经达标。"
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

export function getDraftContractViolationForTest(source: string, text: string): string | null {
  return getDraftContractViolation(source, text);
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

  if (draftedSegments.length > BUNDLED_AUDIT_MAX_SEGMENTS) {
    report(
      context.options,
      "audit",
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: skipping bundled audit for ${draftedSegments.length} segment(s); using per-segment audit directly.`
    );
    const bundledAudit = await runFallbackSegmentAudits(
      draftedSegments,
      plan,
      context,
      chunkPromptContext,
      chunkLabel
    );
    for (const segmentAudit of bundledAudit.segments) {
      validateStructuralGateChecks(segmentAudit);
      const draftedSegment = draftedSegments.find((segment) => segment.segment.index + 1 === segmentAudit.segment_index);
      if (!draftedSegment) {
        throw new HardGateError(
          `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: unknown segment ${segmentAudit.segment_index} in per-segment audit.`
        );
      }
      applyStructuredSegmentAuditAndSync(context.state, draftedSegment, segmentAudit);
    }
    return bundledAudit;
  }

  report(
    context.options,
    "audit",
    `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: running hard gate audit for ${segmentIndices.length} segment(s).`
  );

  const prompt = withAuditChunkContextAt(
    buildBundledGateAuditPrompt(formatBundledAuditSegments(draftedSegments)),
    chunkPromptContext,
    "【分段审校输入】"
  );

  let auditResult: CodexExecResult;
  try {
    auditResult = await executeStageWithTimeout(
      context.executor,
      prompt,
      {
        cwd: context.cwd,
        model: context.postDraftModel,
        reasoningEffort: context.postDraftReasoningEffort ?? AUDIT_REASONING_EFFORT,
        outputSchema: BUNDLED_GATE_AUDIT_SCHEMA,
        reuseSession: true,
        onStderr: (stderrChunk) =>
          reportChunkProgress(context.options, "audit", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
      },
      {
        options: context.options,
        stage: "audit",
        timeoutMs: getAuditTimeoutMs(),
        heartbeatLabel: `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: bundled audit`,
        onHeartbeat: (message) => report(context.options, "audit", message)
      }
    );
  } catch (error) {
    if (error instanceof CodexExecutionError && /bundled audit timed out after \d+ms\./i.test(error.message)) {
      report(
        context.options,
        "audit",
        `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: bundled audit timed out; falling back to per-segment audit.`
      );
      const bundledAudit = await runFallbackSegmentAudits(
        draftedSegments,
        plan,
        context,
        chunkPromptContext,
        chunkLabel
      );
      for (const segmentAudit of bundledAudit.segments) {
        validateStructuralGateChecks(segmentAudit);
        const draftedSegment = draftedSegments.find((segment) => segment.segment.index + 1 === segmentAudit.segment_index);
        if (!draftedSegment) {
          throw new HardGateError(
            `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: unknown segment ${segmentAudit.segment_index} in bundled audit.`
          );
        }
        applyStructuredSegmentAuditAndSync(context.state, draftedSegment, segmentAudit);
      }
      return bundledAudit;
    }
    throw error;
  }

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
    applyStructuredSegmentAuditAndSync(context.state, draftedSegment, segmentAudit);
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
    const auditResult = await executeStageWithTimeout(
      context.executor,
      withAuditChunkContextAt(
        buildGateAuditPrompt(draftedSegment.protectedSource, draftedSegment.protectedBody),
        draftedSegment.promptContext
        ,
        "【英文原文】"
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
      },
      {
        options: context.options,
        stage: "audit",
        timeoutMs: getAuditTimeoutMs(),
        heartbeatLabel: `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${segmentLabel}: per-segment audit`,
        onHeartbeat: (message) => report(context.options, "audit", message)
      }
    );

    const audit = parseGateAudit(auditResult.text);
    validateStructuralGateChecks(audit);
    applyStructuredSegmentAuditAndSync(context.state, draftedSegment, audit);
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
const MIN_COMPLEX_SEGMENT_CHARACTERS = 160;
const COMPLEX_SEGMENT_SCORE_THRESHOLD = 4;

export function splitProtectedChunkSegments(
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

    if (shouldSplitPendingAtIntroBoundary(pending, block.content)) {
      flushPending();
    }

    if (shouldSplitPendingByComplexity(pending, block.content)) {
      flushPending();
    }

    pending.push(block);
  }

  flushPending();

  return segments;
}

function shouldSplitPendingAtIntroBoundary(
  pending: ReadonlyArray<{ content: string; separator: string }>,
  incomingContent: string
): boolean {
  if (pending.length === 0) {
    return false;
  }

  const previousContent = pending.at(-1)?.content ?? "";
  if (!previousContent) {
    return false;
  }

  const previousKind = classifyIntroBoundaryKind(previousContent);
  const previousPromptBlockKind = classifyPromptBlockKind(previousContent);
  const incomingPromptBlockKind = classifyPromptBlockKind(incomingContent);
  const incomingKind = classifyIntroBoundaryKind(incomingContent);

  if (
    previousPromptBlockKind === "blockquote" &&
    incomingPromptBlockKind === "paragraph" &&
    pending.length === 1
  ) {
    return true;
  }

  if (
    incomingPromptBlockKind === "blockquote" &&
    pending.length > 0 &&
    pending.every((block) => classifyPromptBlockKind(block.content) === "paragraph")
  ) {
    return true;
  }

  if (
    incomingPromptBlockKind === "blockquote" &&
    pending.some((block) => classifyPromptBlockKind(block.content) === "list")
  ) {
    return true;
  }

  if (
    isHeadingLikeBlock(previousContent) &&
    incomingPromptBlockKind === "paragraph" &&
    pending.length === 1 &&
    incomingContent.trim().length <= 220 &&
    !containsBlockquoteBlock(incomingContent) &&
    !isListLikeBlock(incomingContent)
  ) {
    return true;
  }

  if (
    isHeadingLikeBlock(previousContent) &&
    incomingPromptBlockKind === "list" &&
    pending.length === 1
  ) {
    return true;
  }

  if (
    previousPromptBlockKind === "paragraph" &&
    isHeadingLikeBlock(incomingContent) &&
    pending.length === 1 &&
    previousContent.trim().length <= 220 &&
    /[:：,，]?\s*$/.test(previousContent.trim())
  ) {
    return true;
  }

  if (
    isHeadingLikeBlock(incomingContent) &&
    pending.some((block) => {
      const kind = classifyPromptBlockKind(block.content);
      return kind === "list" || kind === "blockquote";
    })
  ) {
    return true;
  }

  if (
    isHeadingLikeBlock(incomingContent) &&
    pending.length <= 2 &&
    pending.some((block) => isHeadingLikeBlock(block.content)) &&
    pending.some(
      (block) =>
        classifyPromptBlockKind(block.content) === "paragraph" &&
        block.content.trim().length <= 220 &&
        !containsBlockquoteBlock(block.content) &&
        !isListLikeBlock(block.content)
    )
  ) {
    return true;
  }

  if (
    previousKind === "emphasis" &&
    ["blockquote", "paragraph"].includes(incomingPromptBlockKind) &&
    !incomingKind
  ) {
    return true;
  }

  if (!incomingKind) {
    return false;
  }

  if (previousKind) {
    return previousKind !== incomingKind || incomingKind !== "emphasis";
  }

  return isHeadingLikeBlock(previousContent);
}

function classifyIntroBoundaryKind(content: string): "kicker" | "attribution" | "emphasis" | null {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.includes("\n")) {
    return null;
  }

  if (isNumericKickerLikeBlock(trimmed)) {
    return "kicker";
  }

  if (isAttributionLikeBlock(trimmed)) {
    return "attribution";
  }

  if (isStandaloneEmphasizedIntroBlock(trimmed)) {
    return "emphasis";
  }

  return null;
}

function isNumericKickerLikeBlock(content: string): boolean {
  return /^\d{1,6}$/.test(content.trim());
}

function isStandaloneEmphasizedIntroBlock(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > 160) {
    return false;
  }

  return (
    !isHeadingLikeBlock(trimmed) &&
    !containsBlockquoteBlock(trimmed) &&
    !isListLikeBlock(trimmed) &&
    !/^```/.test(trimmed) &&
    /\*\*[^*\n].+?\*\*/.test(trimmed)
  );
}

function shouldSplitPendingByComplexity(
  pending: ReadonlyArray<{ content: string; separator: string }>,
  incomingContent: string
): boolean {
  if (pending.length === 0) {
    return false;
  }

  const incomingKind = classifyPromptBlockKind(incomingContent);
  if (!["heading", "blockquote", "list", "code"].includes(incomingKind)) {
    return false;
  }

  const pendingChars = measureRawBlocks(pending);
  if (pendingChars < MIN_COMPLEX_SEGMENT_CHARACTERS) {
    return false;
  }

  const complexityScore = pending.reduce((total, block) => total + scoreSegmentComplexityBlock(block.content), 0);
  return complexityScore >= COMPLEX_SEGMENT_SCORE_THRESHOLD;
}

function scoreSegmentComplexityBlock(content: string): number {
  let score = 0;

  if (isHeadingLikeBlock(content)) {
    score += 2;
  }
  if (containsBlockquoteBlock(content)) {
    score += 1;
  }
  if (/^```/m.test(content.trim())) {
    score += 2;
  }
  if (isListLikeBlock(content)) {
    score += 1;
  }
  if (isAttributionLikeBlock(content)) {
    score += 1;
  }
  if (isTranslatableMarkdownStructureBlock(content)) {
    score += 1;
  }

  return score;
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

function applyBlockPlanTargets(source: string, translated: string, slice: PromptSlice | null): string {
  if (!slice) {
    return translated;
  }

  const plans = slice.blockPlans.filter((plan) => plan.targetText?.trim());
  if (plans.length === 0) {
    return translated;
  }

  const sourceBlocks = splitPromptBlocks(source);
  const translatedBlocks = splitPromptBlocks(translated);
  if (translatedBlocks.length === 0) {
    return translated;
  }

  let changed = false;

  for (const plan of plans) {
    const blockIndex = plan.blockIndex - 1;
    const targetText = plan.targetText?.trim();
    if (blockIndex < 0 || blockIndex >= translatedBlocks.length || !targetText) {
      continue;
    }

    const sourceBlock = sourceBlocks[blockIndex];
    const translatedBlock = translatedBlocks[blockIndex];
    if (!translatedBlock) {
      continue;
    }

    if (translatedBlock.content === targetText) {
      continue;
    }

    if (sourceBlock && classifyPromptBlockKind(sourceBlock.content) !== plan.blockKind) {
      continue;
    }

    translatedBlocks[blockIndex] = {
      ...translatedBlock,
      content: targetText
    };
    changed = true;
  }

  if (!changed) {
    return translated;
  }

  return translatedBlocks
    .map((block, index) =>
      index === translatedBlocks.length - 1 ? block.content : `${block.content}${block.separator}`
    )
    .join("");
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
  blockPlanSummaries: string[];
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

function withDraftChunkContext(prompt: string, context: ChunkPromptContext): string {
  return withChunkContextAt(prompt, context, "【英文原文】", {
    includeStateSliceJson: false,
    includePendingRepairs: false
  });
}

function withJsonBlockDraftChunkContext(prompt: string, context: ChunkPromptContext): string {
  // JSON blocks prompt uses `【按块展开的英文原文】` as its marker instead of
  // the plain `【英文原文】`; reuse the same chunk context (anchor glossary,
  // heading path, special notes, etc.) so the LLM sees preferred_chinese_hint
  // and display policy for every required anchor and does not have to guess
  // terminology it hasn't been told. Without this, json-blocks lane would
  // freelance on terms like `Seatbelt` or `bubblewrap` even when the state
  // layer already has the canonical chineseHint.
  return withChunkContextAt(prompt, context, "【按块展开的英文原文】", {
    includeStateSliceJson: false,
    includePendingRepairs: false
  });
}

function withAuditChunkContextAt(prompt: string, context: ChunkPromptContext, marker: string): string {
  return withChunkContextAt(prompt, context, marker, {
    includeStateSliceJson: false,
    includePendingRepairs: false
  });
}

function withChunkContextAt(
  prompt: string,
  context: ChunkPromptContext,
  marker: string,
  options?: {
    includeStateSliceJson?: boolean;
    includePendingRepairs?: boolean;
  }
): string {
  const includeStateSliceJson = options?.includeStateSliceJson ?? true;
  const includePendingRepairs = options?.includePendingRepairs ?? true;
  const headingPath =
    context.headingPath.length > 0 ? context.headingPath.join(" > ") : "无明确标题路径";
  const documentTitle = context.documentTitle ?? "无标题";
  const segmentHeadings =
    context.segmentHeadings.length > 0 ? context.segmentHeadings.join(" | ") : "无显式标题";
  const headingPlanSummaries =
    context.headingPlanSummaries.length > 0 ? context.headingPlanSummaries.join(" | ") : "无标题计划";
  const emphasisPlanSummaries =
    context.emphasisPlanSummaries.length > 0 ? context.emphasisPlanSummaries.join(" | ") : "无强调计划";
  const blockPlanSummaries =
    context.blockPlanSummaries.length > 0 ? context.blockPlanSummaries.join(" | ") : "无块顺序计划";
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
    `当前分段块顺序计划：${blockPlanSummaries}`,
    "【当前分段 IR】",
    context.analysisPlanDraft,
    `当前分段必须建立的首现锚点：${requiredAnchors}`,
    `当前分段里已在前文建立过、禁止重复补锚的项目：${repeatAnchors}`,
    `全文已建立的锚点摘要：${establishedAnchors}`,
    "说明：当前输入只覆盖全文的一部分。请保持术语、专名、语气和上下文的一致性，不要补写未出现在当前分块中的段落。",
    "requiredAnchors 表示：这些专名、产品名、项目名或关键术语必须在当前分段本身建立或保持合法的首现显示形式。",
    "如果当前分段标题计划为某个标题给出了 targetHeading，则该标题的语义与最终目标文本由 headingPlan 决定；不要再让全局 anchor 对同一标题追加冲突的中英锚定要求。",
    "如果 headingPlan 同时给出了 governedTerms，则这些术语在对应标题里的处理方式已经由该计划决定；审校时不要再按全局 anchor 对该标题单独追加强制格式。",
    "标题场景下，headingPlan 的 targetHeading 优先于全局 anchor catalog；全局 anchor 只能为没有 targetHeading 的标题补充约束。",
    "analysisPlanDraft 是当前分段的结构化 sidecar plan。若其中某条 PLAN 已给出 source、target、display 或 strategy，请优先按这份计划执行，不要再自由改写同一结构的语义目标。",
    "如果 IR 中包含 kind=block 的 PLAN，它们定义了当前分段按 source 保持的块级顺序。不要把后面的标题、说明句、列表或代码块提前到前面，也不要交换这些块的相对顺序。",
    "如果 requiredAnchors 给出了 canonicalDisplay 或 allowedDisplayForms，则这些形式就是当前分段可接受的合法锚定结果；像“Claude（Anthropic 的 AI 助手）”这类英文原名（中文说明）形式，或像“Claude”这类允许裸英文首现的形式，都视为已经完成首现锚定，不得再按“缺少英文对照”判错。",
    "repeatAnchors 表示：这些项目已经在全文前文完成首现锚定，即使它们在当前分块标题、加粗标题、列表项标题或正文里是本块第一次出现，也不得再补首现中英文对照。",
    "如果当前分段标题、加粗标题、列表项标题里包含冒号、括号限定语、枚举标签或英文补充说明，翻译时必须完整保留这些信息，不要只保留其中一部分。"
  ].join("\n");
  const pendingRepairsBlock = includePendingRepairs
    ? `\n当前分段待处理的结构化修复任务：${pendingRepairs}`
    : "";
  const stateSliceBlock = includeStateSliceJson ? `\n【状态切片(JSON)】\n${stateSliceJson}` : "";
  const specialNotesBlock =
    context.specialNotes.length > 0
      ? `\n\n【当前分段附加规则】\n${context.specialNotes.join("\n")}`
      : "";

  return prompt.replace(marker, `${contextLines}${pendingRepairsBlock}${stateSliceBlock}${specialNotesBlock}\n\n${marker}`);
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
