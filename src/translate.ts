import { buildGateAuditPrompt, buildInitialPrompt, buildRepairPrompt, buildStylePolishPrompt } from "./internal/prompts/scheme-h.js";
import { DefaultCodexExecutor, type CodexExecutor } from "./codex-exec.js";
import { FormattingError, HardGateError } from "./errors.js";
import { formatTranslatedBody, reconstructMarkdown } from "./format.js";
import { planMarkdownChunks, type MarkdownChunk, type MarkdownChunkPlan } from "./markdown-chunks.js";
import {
  extractFrontmatter,
  protectMarkdownSpans,
  restoreMarkdownSpans,
  type ProtectedSpan
} from "./markdown-protection.js";

const DEFAULT_MODEL = "gpt-5.4-mini";
const MAX_REPAIR_CYCLES = 2;

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

export function parseGateAudit(text: string): GateAudit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch (error) {
    throw new HardGateError(error instanceof Error ? error.message : String(error));
  }

  if (!parsed || typeof parsed !== "object") {
    throw new HardGateError("Gate audit JSON is not an object.");
  }

  const data = parsed as Record<string, unknown>;
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

function isHardPass(audit: GateAudit): boolean {
  return Object.values(audit.hard_checks).every((item) => item.pass);
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

  for (const chunk of chunkPlan.chunks) {
    const chunkResult = await translateProtectedChunk(chunk, chunkPlan, {
      cwd,
      executor,
      model,
      options,
      sourcePathHint,
      spanIndex
    });

    restoredChunks.push(chunkResult.body + chunk.separatorAfter);
    gateAudits.push(chunkResult.gateAudit);
    repairCyclesUsed += chunkResult.repairCyclesUsed;
    styleApplied = styleApplied || chunkResult.styleApplied;
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
};

type ChunkTranslationResult = {
  body: string;
  repairCyclesUsed: number;
  styleApplied: boolean;
  gateAudit: GateAudit;
};

type SegmentTranslationResult = {
  protectedBody: string;
  restoredBody: string;
  repairCyclesUsed: number;
  gateAudit: GateAudit;
};

async function translateProtectedChunk(
  chunk: MarkdownChunk,
  plan: MarkdownChunkPlan,
  context: ChunkTranslationContext
): Promise<ChunkTranslationResult> {
  const chunkLabel = formatChunkLabel(chunk, plan);
  const chunkPromptContext = buildChunkPromptContext(chunk, plan, context.sourcePathHint);
  const segments = splitProtectedChunkSegments(chunk.source, context.spanIndex);
  const rebuiltProtectedSegments: string[] = [];
  const rebuiltRestoredSegments: string[] = [];
  const segmentAudits: GateAudit[] = [];
  let repairCyclesUsed = 0;

  for (const segment of segments) {
    if (segment.kind === "fixed") {
      rebuiltProtectedSegments.push(segment.source + segment.separatorAfter);
      rebuiltRestoredSegments.push(restoreMarkdownSpans(segment.source, segment.spans) + segment.separatorAfter);
      continue;
    }

    const segmentPromptContext: ChunkPromptContext = {
      ...chunkPromptContext,
      segmentHeadings: extractSegmentHeadingHints(segment.source)
    };
    const segmentLabel =
      segments.length > 1
        ? `${chunkLabel}, segment ${segment.index + 1}/${segments.length}`
        : chunkLabel;
    const segmentResult = await translateProtectedSegment(segment, plan, context, segmentPromptContext, segmentLabel);
    rebuiltProtectedSegments.push(segmentResult.protectedBody + segment.separatorAfter);
    rebuiltRestoredSegments.push(segmentResult.restoredBody + segment.separatorAfter);
    segmentAudits.push(segmentResult.gateAudit);
    repairCyclesUsed += segmentResult.repairCyclesUsed;
  }

  const hardPassProtectedChunk = rebuiltProtectedSegments.join("");
  const hardPassBody = rebuiltRestoredSegments.join("");
  const chunkSpans = collectChunkSpans(hardPassProtectedChunk, context.spanIndex);
  let restoredChunkBody = hardPassBody;
  let styleApplied = false;

  if (segmentAudits.length > 0) {
    const chunkStylePromptContext: ChunkPromptContext = {
      ...chunkPromptContext,
      segmentHeadings: extractSegmentHeadingHints(chunk.source)
    };

    report(
      context.options,
      "style",
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: applying style polish after hard gate pass.`
    );
    const styleResult = await context.executor.execute(
      withChunkContext(buildStylePolishPrompt(chunk.source, hardPassProtectedChunk), chunkStylePromptContext),
      {
        cwd: context.cwd,
        model: context.model,
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
    gateAudit: mergeGateAudits(segmentAudits)
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
  chunkLabel: string
): Promise<SegmentTranslationResult> {
  report(
    context.options,
    "draft",
    `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: starting translation with model ${context.model}.`
  );
  const draftResult = await context.executor.execute(
    withChunkContext(buildInitialPrompt(segment.source), chunkPromptContext),
    {
      cwd: context.cwd,
      model: context.model,
      onStderr: (stderrChunk) =>
        reportChunkProgress(context.options, "draft", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
    }
  );
  let currentTranslation = draftResult.text;

  report(
    context.options,
    "audit",
    `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: running hard gate audit.`
  );
  let auditResult = await context.executor.execute(
    withChunkContext(buildGateAuditPrompt(segment.source, currentTranslation), chunkPromptContext),
    {
      cwd: context.cwd,
      model: context.model,
      outputSchema: GATE_AUDIT_SCHEMA,
      onStderr: (stderrChunk) =>
        reportChunkProgress(context.options, "audit", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
    }
  );
  let gateAudit = parseGateAudit(auditResult.text);
  validateStructuralGateChecks(gateAudit);
  let repairCyclesUsed = 0;

  while (!isHardPass(gateAudit) && repairCyclesUsed < MAX_REPAIR_CYCLES && gateAudit.must_fix.length > 0) {
    repairCyclesUsed += 1;
    report(
      context.options,
      "repair",
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: repair cycle ${repairCyclesUsed} of ${MAX_REPAIR_CYCLES}.`
    );
    const repairResult = await context.executor.execute(
      withChunkContext(
        buildRepairPrompt(segment.source, currentTranslation, gateAudit.must_fix),
        chunkPromptContext
      ),
      {
        cwd: context.cwd,
        model: context.model,
        onStderr: (stderrChunk) =>
          reportChunkProgress(context.options, "repair", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
      }
    );
    currentTranslation = repairResult.text;

    report(
      context.options,
      "audit",
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel}: rechecking hard gate after repair cycle ${repairCyclesUsed}.`
    );
    auditResult = await context.executor.execute(
      withChunkContext(buildGateAuditPrompt(segment.source, currentTranslation), chunkPromptContext),
      {
        cwd: context.cwd,
        model: context.model,
        outputSchema: GATE_AUDIT_SCHEMA,
        onStderr: (stderrChunk) =>
          reportChunkProgress(context.options, "audit", chunkPromptContext.chunkIndex - 1, plan, chunkLabel, stderrChunk)
      }
    );
    gateAudit = parseGateAudit(auditResult.text);
    validateStructuralGateChecks(gateAudit);
  }

  if (!isHardPass(gateAudit)) {
    const remaining =
      gateAudit.must_fix.length > 0
        ? gateAudit.must_fix.join(" | ")
        : "Gate audit still failed after the repair loop.";
    throw new HardGateError(
      `Chunk ${chunkPromptContext.chunkIndex}/${plan.chunks.length}${chunkLabel} failed after ${repairCyclesUsed} repair cycle(s): ${remaining}`
    );
  }

  const restoredBody = restoreMarkdownSpans(currentTranslation, segment.spans);

  return {
    protectedBody: currentTranslation,
    restoredBody,
    repairCyclesUsed,
    gateAudit
  };
}

const MIN_SEGMENT_HEADING_SPLIT_CHARACTERS = 2600;

function splitProtectedChunkSegments(
  source: string,
  spanIndex: ReadonlyMap<string, ProtectedSpan>
): ProtectedChunkSegment[] {
  const blocks = splitRawBlocks(source);
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
  spanIndex: ReadonlyMap<string, ProtectedSpan>
): ProtectedSpan[] {
  const placeholderPattern = /@@MDZH_[A-Z_]+_\d{4}@@/g;
  const spanIds = [...new Set(source.match(placeholderPattern) ?? [])];
  return spanIds.map((spanId) => {
    const span = spanIndex.get(spanId);
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

type ChunkPromptContext = {
  documentTitle: string | null;
  headingPath: string[];
  chunkIndex: number;
  chunkCount: number;
  sourcePathHint: string;
  segmentHeadings: string[];
};

function buildChunkPromptContext(
  chunk: MarkdownChunk,
  plan: MarkdownChunkPlan,
  sourcePathHint: string
): ChunkPromptContext {
  return {
    documentTitle: plan.documentTitle,
    headingPath: chunk.headingPath,
    chunkIndex: chunk.index + 1,
    chunkCount: plan.chunks.length,
    sourcePathHint,
    segmentHeadings: []
  };
}

function withChunkContext(prompt: string, context: ChunkPromptContext): string {
  const headingPath =
    context.headingPath.length > 0 ? context.headingPath.join(" > ") : "无明确标题路径";
  const documentTitle = context.documentTitle ?? "无标题";
  const segmentHeadings =
    context.segmentHeadings.length > 0 ? context.segmentHeadings.join(" | ") : "无显式标题";
  const contextLines = [
    "【全文上下文】",
    `源文件提示：${context.sourcePathHint}`,
    `全文标题：${documentTitle}`,
    `当前分块：第 ${context.chunkIndex} / ${context.chunkCount} 块`,
    `当前章节路径：${headingPath}`,
    `当前分段标题：${segmentHeadings}`,
    "说明：当前输入只覆盖全文的一部分。请保持术语、专名、语气和上下文的一致性，不要补写未出现在当前分块中的段落。",
    "如果当前分段标题、加粗标题、列表项标题里包含冒号、括号限定语、枚举标签或英文补充说明，翻译时必须完整保留这些信息，不要只保留其中一部分。"
  ].join("\n");

  return prompt.replace("【英文原文】", `${contextLines}\n\n【英文原文】`);
}

function formatChunkLabel(chunk: MarkdownChunk, plan: MarkdownChunkPlan): string {
  const label = chunk.headingPath.at(-1) ?? plan.documentTitle;
  return label ? ` (${label})` : "";
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
