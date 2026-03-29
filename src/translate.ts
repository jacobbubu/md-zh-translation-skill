import {
  buildBundledGateAuditPrompt,
  buildInitialPrompt,
  buildRepairPrompt,
  buildStylePolishPrompt
} from "./internal/prompts/scheme-h.js";
import { DefaultCodexExecutor, type CodexExecutor } from "./codex-exec.js";
import { FormattingError, HardGateError } from "./errors.js";
import { formatTranslatedBody, reconstructMarkdown } from "./format.js";
import { planMarkdownChunks, type MarkdownChunk, type MarkdownChunkPlan } from "./markdown-chunks.js";
import {
  extractFrontmatter,
  protectMarkdownSpans,
  protectSegmentFormattingSpans,
  reprotectMarkdownSpans,
  restoreMarkdownSpans,
  type ProtectedSpan
} from "./markdown-protection.js";

const DEFAULT_MODEL = "gpt-5.4-mini";
const MAX_REPAIR_CYCLES = 2;
const DRAFT_REASONING_EFFORT = "medium";
const AUDIT_REASONING_EFFORT = "medium";
const REPAIR_REASONING_EFFORT = "low";
const STYLE_REASONING_EFFORT = "low";

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
  | "draft"
  | "audit"
  | "repair"
  | "style"
  | "format";

export type TranslateOptions = {
  cwd?: string;
  sourcePathHint?: string;
  model?: string;
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
  }

  if (!Array.isArray(mustFix) || !mustFix.every((item) => typeof item === "string")) {
    throw new HardGateError("Gate audit JSON must_fix must be an array of strings.");
  }

  return {
    hard_checks: hardChecks as GateAudit["hard_checks"],
    must_fix: mustFix.map((item) => item.trim()).filter(Boolean)
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

export async function translateMarkdownArticle(source: string, options: TranslateOptions = {}): Promise<TranslateResult> {
  const executor = options.executor ?? new DefaultCodexExecutor();
  const formatter = options.formatter ?? formatTranslatedBody;
  const model = options.model ?? (process.env.TRANSLATION_MODEL?.trim() || DEFAULT_MODEL);
  const cwd = options.cwd ?? process.cwd();
  const sourcePathHint = options.sourcePathHint ?? "article.md";
  const { frontmatter, body } = extractFrontmatter(source);
  const { protectedBody, spans } = protectMarkdownSpans(body);
  const chunkPlan = planMarkdownChunks(protectedBody);
  const spanIndex = new Map(spans.map((span) => [span.id, span]));
  const restoredChunks: string[] = [];
  const gateAudits: GateAudit[] = [];
  let repairCyclesUsed = 0;
  let styleApplied = false;
  let establishedTerms: string[] = [];

  for (const chunk of chunkPlan.chunks) {
    const chunkResult = await translateProtectedChunk(chunk, chunkPlan, {
      cwd,
      executor,
      model,
      options,
      sourcePathHint,
      spanIndex,
      establishedTerms
    });

    restoredChunks.push(chunkResult.body + chunk.separatorAfter);
    gateAudits.push(chunkResult.gateAudit);
    repairCyclesUsed += chunkResult.repairCyclesUsed;
    styleApplied = styleApplied || chunkResult.styleApplied;
    establishedTerms = mergeEstablishedTerms(
      establishedTerms,
      collectEstablishedTerms(chunk.source, chunkResult.body)
    );
  }

  report(options, "format", "Formatting translated Markdown.");
  try {
    const formattedBody = await formatter(restoredChunks.join(""), sourcePathHint);
    const markdown = reconstructMarkdown(frontmatter, formattedBody);
    return {
      markdown,
      model,
      repairCyclesUsed,
      styleApplied,
      gateAudit: mergeGateAudits(gateAudits),
      chunkCount: chunkPlan.chunks.length
    };
  } catch (error) {
    throw new FormattingError(error instanceof Error ? error.message : String(error));
  }
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
  executor: CodexExecutor;
  model: string;
  cwd: string;
  sourcePathHint: string;
  options: TranslateOptions;
  spanIndex: ReadonlyMap<string, ProtectedSpan>;
  establishedTerms: readonly string[];
};

type ChunkTranslationResult = {
  body: string;
  repairCyclesUsed: number;
  styleApplied: boolean;
  gateAudit: GateAudit;
};

type DraftedSegmentState = {
  segment: ProtectedChunkSegment;
  promptContext: ChunkPromptContext;
  protectedSource: string;
  protectedBody: string;
  restoredBody: string;
  spans: ProtectedSpan[];
  threadId?: string;
};

async function translateProtectedChunk(
  chunk: MarkdownChunk,
  plan: MarkdownChunkPlan,
  context: ChunkTranslationContext
): Promise<ChunkTranslationResult> {
  const chunkLabel = formatChunkLabel(chunk, plan);
  const chunkPromptContext = buildChunkPromptContext(chunk, plan, context.sourcePathHint, context.establishedTerms);
  const segments = splitProtectedChunkSegments(chunk.source, context.spanIndex);
  const draftedSegments: DraftedSegmentState[] = [];
  const fixedSegments: ProtectedChunkSegment[] = [];
  let repairCyclesUsed = 0;
  let nextLocalSpanIndex = context.spanIndex.size + 1;

  for (const segment of segments) {
    if (segment.kind === "fixed") {
      fixedSegments.push(segment);
      continue;
    }

    const segmentPromptContext: ChunkPromptContext = {
      ...chunkPromptContext,
      segmentHeadings: extractSegmentHeadingHints(segment.source),
      specialNotes: extractSegmentSpecialNotes(segment.source)
    };
    const segmentLabel =
      segments.length > 1
        ? `${chunkLabel}, segment ${segment.index + 1}/${segments.length}`
        : chunkLabel;
    const segmentResult = await translateProtectedSegment(
      segment,
      plan,
      context,
      segmentPromptContext,
      segmentLabel,
      nextLocalSpanIndex
    );
    nextLocalSpanIndex += segmentResult.spans.filter((span) => span.kind === "inline_markdown_link").length;
    draftedSegments.push(segmentResult);
  }

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
        segmentAudit.must_fix,
        plan,
        context,
        chunkLabel
      );
    }

    bundledAudit = await runBundledGateAudit(
      draftedSegments,
      plan,
      context,
      chunkPromptContext,
      chunkLabel
    );
  }

  if (!isBundledHardPass(bundledAudit)) {
    const remaining = bundledAudit.segments
      .filter((audit) => !isHardPass(audit))
      .map((audit) => `segment ${audit.segment_index}: ${audit.must_fix.join(" | ") || "hard gate failed"}`)
      .join(" || ");
    throw new HardGateError(
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel} failed after ${repairCyclesUsed} repair cycle(s): ${remaining}`
    );
  }

  const hardPassProtectedSource = rebuildChunkFromSegmentStates(segments, draftedSegments, "protectedSource");
  const hardPassProtectedChunk = rebuildChunkFromSegmentStates(segments, draftedSegments, "protectedBody");
  const hardPassBody = rebuildChunkFromSegmentStates(segments, draftedSegments, "restoredBody");
  const accumulatedChunkSpans = collectAccumulatedChunkSpans(segments, draftedSegments);
  const chunkSpans = collectChunkSpans(hardPassProtectedChunk, context.spanIndex, accumulatedChunkSpans);
  let restoredChunkBody = hardPassBody;
  let styleApplied = false;

  if (bundledAudit.segments.length > 0) {
    const chunkStylePromptContext: ChunkPromptContext = {
      ...chunkPromptContext,
      segmentHeadings: extractSegmentHeadingHints(chunk.source),
      specialNotes: extractSegmentSpecialNotes(chunk.source)
    };

    report(
      context.options,
      "style",
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: applying style polish after hard gate pass.`
    );
    const styleResult = await context.executor.execute(
      withChunkContext(buildStylePolishPrompt(hardPassProtectedSource, hardPassProtectedChunk), chunkStylePromptContext),
      {
        cwd: context.cwd,
        model: context.model,
        reasoningEffort: STYLE_REASONING_EFFORT,
        onStderr: (stderrChunk) =>
          reportChunkProgress(context.options, "style", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
      }
    );

    try {
      restoredChunkBody = restoreMarkdownSpans(styleResult.text, chunkSpans);
      styleApplied = true;
    } catch (error) {
      if (!(error instanceof HardGateError)) {
        throw error;
      }
      report(
        context.options,
        "style",
        `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: style polish changed protected Markdown spans; falling back to the hard-pass translation.`
      );
    }
  }

  return {
    body: restoredChunkBody,
    repairCyclesUsed,
    styleApplied,
    gateAudit: mergeGateAudits(bundledAudit.segments)
  };
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
    `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: starting translation with model ${context.model}.`
  );
  const draftResult = await context.executor.execute(
    withChunkContext(buildInitialPrompt(protectedSource), chunkPromptContext),
    {
      cwd: context.cwd,
      model: context.model,
      reasoningEffort: DRAFT_REASONING_EFFORT,
      reuseSession: true,
      onStderr: (stderrChunk) =>
        reportChunkProgress(context.options, "draft", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
    }
  );
  threadId = draftResult.threadId;
  const canonicalProtectedBody = reprotectMarkdownSpans(draftResult.text, combinedSpans);
  const restoredBody = restoreMarkdownSpans(canonicalProtectedBody, combinedSpans);

  return {
    segment,
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
  mustFix: readonly string[],
  plan: MarkdownChunkPlan,
  context: ChunkTranslationContext,
  chunkLabel: string
): Promise<void> {
  report(
    context.options,
    "repair",
    `Chunk ${draftedSegment.promptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}, segment ${draftedSegment.segment.index + 1}: repairing failed segment.`
  );
  const repairResult = await context.executor.execute(
    withChunkContext(
      buildRepairPrompt(draftedSegment.protectedSource, draftedSegment.protectedBody, mustFix),
      draftedSegment.promptContext
    ),
    {
      cwd: context.cwd,
      model: context.model,
      reasoningEffort: REPAIR_REASONING_EFFORT,
      ...(draftedSegment.threadId ? { threadId: draftedSegment.threadId } : { reuseSession: true }),
      onStderr: (stderrChunk) =>
        reportChunkProgress(
          context.options,
          "repair",
          draftedSegment.promptContext.chunkIndex - 1,
          plan,
          `${chunkLabel}, segment ${draftedSegment.segment.index + 1}`,
          stderrChunk
        )
    }
  );

  if (repairResult.threadId) {
    draftedSegment.threadId = repairResult.threadId;
  }
  draftedSegment.protectedBody = reprotectMarkdownSpans(repairResult.text, draftedSegment.spans);
  draftedSegment.restoredBody = restoreMarkdownSpans(draftedSegment.protectedBody, draftedSegment.spans);
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
    model: context.model,
    reasoningEffort: AUDIT_REASONING_EFFORT,
    outputSchema: BUNDLED_GATE_AUDIT_SCHEMA,
    reuseSession: true,
    onStderr: (stderrChunk) =>
      reportChunkProgress(context.options, "audit", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
  });

  const bundledAudit = parseBundledGateAudit(auditResult.text, segmentIndices);
  for (const segmentAudit of bundledAudit.segments) {
    validateStructuralGateChecks(segmentAudit);
  }
  return bundledAudit;
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

  return /^\*\*[^*\n].+\*\*$/.test(trimmed);
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
  const spanIds = [...new Set(source.match(placeholderPattern) ?? [])];
  const localSpanIndex = new Map(extraSpans.map((span) => [span.id, span]));
  return spanIds.map((spanId) => {
    const span = localSpanIndex.get(spanId) ?? spanIndex.get(spanId);
    if (!span) {
      throw new HardGateError(`Protected span integrity failed: unknown placeholder ${spanId}.`);
    }
    return span;
  });
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
    }
  }

  return hints;
}

function extractSegmentSpecialNotes(source: string): string[] {
  const notes: string[] = [];

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

function isToolNameExplanationBlock(content: string): boolean {
  return content.split(/\r?\n/).some((line) => isToolNameExplanationLine(line));
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

type ChunkPromptContext = {
  documentTitle: string | null;
  headingPath: string[];
  chunkIndex: number;
  chunkCount: number;
  sourcePathHint: string;
  segmentHeadings: string[];
  establishedTerms: string[];
  specialNotes: string[];
};

function buildChunkPromptContext(
  chunk: MarkdownChunk,
  plan: MarkdownChunkPlan,
  sourcePathHint: string,
  establishedTerms: readonly string[]
): ChunkPromptContext {
  return {
    documentTitle: plan.documentTitle,
    headingPath: chunk.headingPath,
    chunkIndex: chunk.index + 1,
    chunkCount: plan.chunks.length,
    sourcePathHint,
    segmentHeadings: [],
    establishedTerms: [...establishedTerms],
    specialNotes: []
  };
}

function withChunkContext(prompt: string, context: ChunkPromptContext): string {
  return withChunkContextAt(prompt, context, "【英文原文】");
}

function withChunkContextAt(prompt: string, context: ChunkPromptContext, marker: string): string {
  const headingPath =
    context.headingPath.length > 0 ? context.headingPath.join(" > ") : "无明确标题路径";
  const documentTitle = context.documentTitle ?? "无标题";
  const segmentHeadings =
    context.segmentHeadings.length > 0 ? context.segmentHeadings.join(" | ") : "无显式标题";
  const establishedTerms =
    context.establishedTerms.length > 0 ? context.establishedTerms.join(" | ") : "无";
  const contextLines = [
    "【全文上下文】",
    `源文件提示：${context.sourcePathHint}`,
    `全文标题：${documentTitle}`,
    `当前分块：第 ${context.chunkIndex} / ${context.chunkCount} 块`,
    `当前章节路径：${headingPath}`,
    `当前分段标题：${segmentHeadings}`,
    `前文已完成首现锚定的专名/术语：${establishedTerms}`,
    "说明：当前输入只覆盖全文的一部分。请保持术语、专名、语气和上下文的一致性，不要补写未出现在当前分块中的段落。",
    "上面的清单表示：这些专名、产品名、项目名或关键术语已经在全文前文完成首现双语锚定。",
    "对清单内条目及其明显简称，即使它们在当前分块标题、加粗标题、列表项标题或正文里是本块第一次出现，也一律视为全文非首现；翻译、审校和修复时不要再要求补首次中英文对照。",
    "只有不在前文清单里、且确实是全文第一次出现的专名、产品名、项目名或关键术语，才需要补首次中英文对照。",
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
