import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { HardGateError } from "../src/errors.js";
import { planMarkdownChunks } from "../src/markdown-chunks.js";
import { extractFrontmatter, protectMarkdownSpans } from "../src/markdown-protection.js";
import {
  buildRepairPromptContextForTest,
  getDraftContractViolationForTest,
  parseGateAudit,
  translateMarkdownArticle,
  __testOnlyIsHardPass,
  __testOnlyDedupDraftDuplicateTailListItems,
  type ChunkPromptContext,
  type GateAudit
} from "../src/translate.js";
import { CodexExecutionError } from "../src/errors.js";
import type { CodexExecOptions, CodexExecResult, CodexExecutor } from "../src/codex-exec.js";
import { createMemoryTelemetrySink, type TelemetryEvent } from "../src/telemetry.js";
import { createMemoryTmStore, fingerprint as tmFingerprint } from "../src/translation-memory.js";

function isDocumentAnalysisPrompt(prompt: string): boolean {
  return prompt.includes("【文档分析输入】");
}

function isBundledAuditPrompt(prompt: string, options: CodexExecOptions): boolean {
  return Boolean(
    options.outputSchema &&
      (prompt.includes("【分段审校输入】") ||
        prompt.includes("请检查下面按 segment 编号提供的英文原文与当前译文"))
  );
}

function createEmptyAnchorCatalog(): string {
  return JSON.stringify({
    anchors: [],
    headingPlans: [],
    emphasisPlans: [],
    blockPlans: [],
    aliasPlans: [],
    entityDisambiguationPlans: [],
    ignoredTerms: []
  });
}

function createAnchorCatalog(
  anchors: Array<{
    english: string;
    chineseHint: string;
    category?: string;
    familyKey: string;
    displayPolicy?: "auto" | "acronym-compound" | "english-only" | "english-primary" | "chinese-primary";
    chunkId?: string;
    segmentId?: string;
  }>,
  headingPlans: Array<{
    chunkId: string;
    segmentId: string;
    headingIndex?: number;
    sourceHeading: string;
    strategy: "none" | "concept" | "source-template" | "mixed-qualifier" | "natural-heading";
    targetHeading?: string;
    governedTerms?: string[];
    english?: string;
    chineseHint?: string;
    category?: string;
    displayPolicy?: "auto" | "acronym-compound" | "english-only" | "english-primary" | "chinese-primary";
  }> = [],
  emphasisPlans: Array<{
    chunkId: string;
    segmentId: string;
    emphasisIndex?: number;
    lineIndex?: number;
    sourceText: string;
    strategy: "preserve-strong" | "none";
    targetText?: string;
    governedTerms?: string[];
  }> = [],
  blockPlans: Array<{
    chunkId: string;
    segmentId: string;
    blockIndex: number;
    blockKind: "heading" | "blockquote" | "list" | "code" | "paragraph";
    sourceText: string;
    targetText?: string;
  }> = [],
  aliasPlans: Array<{
    chunkId: string;
    segmentId: string;
    sourceText: string;
    targetText: string;
    currentText?: string;
    english?: string;
    lineIndex?: number;
    scope?: "local" | "sentence-local" | "heading-local";
  }> = [],
  entityDisambiguationPlans: Array<{
    chunkId: string;
    segmentId: string;
    sourceText: string;
    targetText: string;
    currentText?: string;
    english?: string;
    lineIndex?: number;
    forbiddenDisplays?: string[];
    scope?: "local" | "sentence-local" | "heading-local";
  }> = []
): string {
  return JSON.stringify({
    anchors: anchors.map((anchor) => ({
      english: anchor.english,
      chineseHint: anchor.chineseHint,
      ...(anchor.category ? { category: anchor.category } : {}),
      familyKey: anchor.familyKey,
      ...(anchor.displayPolicy ? { displayPolicy: anchor.displayPolicy } : {}),
      firstOccurrence: {
        chunkId: anchor.chunkId ?? "chunk-1",
        segmentId: anchor.segmentId ?? "chunk-1-segment-1"
      }
    })),
    headingPlans: headingPlans.map((plan) => ({
      chunkId: plan.chunkId,
      segmentId: plan.segmentId,
      headingIndex: plan.headingIndex ?? null,
      sourceHeading: plan.sourceHeading,
      strategy: plan.strategy,
      targetHeading: plan.targetHeading ?? null,
      governedTerms: plan.governedTerms ?? null,
      english: plan.english ?? null,
      chineseHint: plan.chineseHint ?? null,
      category: plan.category ?? null,
      displayPolicy: plan.displayPolicy ?? null
    })),
    emphasisPlans: emphasisPlans.map((plan) => ({
      chunkId: plan.chunkId,
      segmentId: plan.segmentId,
      emphasisIndex: plan.emphasisIndex ?? null,
      lineIndex: plan.lineIndex ?? null,
      sourceText: plan.sourceText,
      strategy: plan.strategy,
      targetText: plan.targetText ?? null,
      governedTerms: plan.governedTerms ?? null
    })),
    blockPlans: blockPlans.map((plan) => ({
      chunkId: plan.chunkId,
      segmentId: plan.segmentId,
      blockIndex: plan.blockIndex,
      blockKind: plan.blockKind,
      sourceText: plan.sourceText,
      targetText: plan.targetText ?? null
    })),
    aliasPlans: aliasPlans.map((plan) => ({
      chunkId: plan.chunkId,
      segmentId: plan.segmentId,
      sourceText: plan.sourceText,
      targetText: plan.targetText,
      currentText: plan.currentText ?? null,
      english: plan.english ?? null,
      lineIndex: plan.lineIndex ?? null,
      scope: plan.scope ?? "local"
    })),
    entityDisambiguationPlans: entityDisambiguationPlans.map((plan) => ({
      chunkId: plan.chunkId,
      segmentId: plan.segmentId,
      sourceText: plan.sourceText,
      targetText: plan.targetText,
      currentText: plan.currentText ?? null,
      english: plan.english ?? null,
      lineIndex: plan.lineIndex ?? null,
      forbiddenDisplays: plan.forbiddenDisplays ?? null,
      scope: plan.scope ?? "local"
    })),
    ignoredTerms: []
  });
}

function createAudit(pass: boolean, mustFix: string[] = [], overrides: Partial<GateAudit["hard_checks"]> = {}): GateAudit {
  return {
    hard_checks: {
      paragraph_match: { pass, problem: pass ? "" : "paragraph mismatch" },
      first_mention_bilingual: { pass, problem: pass ? "" : "missing bilingual term" },
      numbers_units_logic: { pass, problem: pass ? "" : "unit mismatch" },
      chinese_punctuation: { pass, problem: pass ? "" : "punctuation mismatch" },
      unit_conversion_boundary: { pass, problem: pass ? "" : "conversion mismatch" },
      protected_span_integrity: { pass: true, problem: "" },
      embedded_template_integrity: { pass: true, problem: "" },
      ...overrides
    },
    must_fix: mustFix
  };
}

function extractAuditSegmentIndices(prompt: string): number[] {
  return [...prompt.matchAll(/【segment (\d+)】/g)].map((match) => Number(match[1]));
}

function wrapAuditForSegments(prompt: string, audit: GateAudit): string {
  const segmentIndices = extractAuditSegmentIndices(prompt);
  if (segmentIndices.length === 0) {
    return JSON.stringify(audit);
  }

  return JSON.stringify({
    segments: segmentIndices.map((segmentIndex) => ({
      segment_index: segmentIndex,
      ...audit
    }))
  });
}

function wrapPerSegmentAudits(prompt: string, audits: Array<{ segment_index: number; audit: GateAudit }>): string {
  const segmentIndices = extractAuditSegmentIndices(prompt);
  const auditMap = new Map(audits.map((entry) => [entry.segment_index, entry.audit]));
  return JSON.stringify({
    segments: segmentIndices.map((segmentIndex) => ({
      segment_index: segmentIndex,
      ...(auditMap.get(segmentIndex) ?? createAudit(true))
    }))
  });
}

class StubExecutor implements CodexExecutor {
  readonly prompts: string[] = [];
  readonly responses: Array<CodexExecResult>;

  constructor(texts: string[]) {
    this.responses = texts.map((text) => ({
      text,
      stderr: "",
      jsonl: "",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }
    }));
  }

  async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
    this.prompts.push(prompt);
    if (isDocumentAnalysisPrompt(prompt)) {
      return createExecResult(createEmptyAnchorCatalog());
    }
    if (options.outputSchema && prompt.includes("### BLOCK")) {
      const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
      return createExecResult(JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "中文占位译文") }));
    }
    // Handle bundled/per-segment audit when no queued response matches
    if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
      // Check if next queued response is a valid audit; if so use it
      const peeked = this.responses[0];
      if (peeked) {
        try {
          const parsed = JSON.parse(peeked.text) as Record<string, unknown>;
          if (parsed.hard_checks || parsed.segments) {
            this.responses.shift();
            if (parsed.hard_checks && !parsed.segments) {
              return { ...peeked, text: wrapAuditForSegments(prompt, parsed as GateAudit) };
            }
            return peeked;
          }
        } catch { /* not JSON audit, fall through to default audit */ }
      }
      return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
    }
    const next = this.responses.shift();
    assert.ok(next, "Unexpected extra Codex call");
    if (prompt.includes("【segment ")) {
      try {
        const parsed = JSON.parse(next.text) as Record<string, unknown>;
        if (parsed.hard_checks && parsed.must_fix && !parsed.segments) {
          return {
            ...next,
            text: wrapAuditForSegments(prompt, parsed as GateAudit)
          };
        }
      } catch {
        // Ignore non-JSON responses.
      }
    }
    return next;
  }
}

class PromptAwareExecutor implements CodexExecutor {
  readonly prompts: string[] = [];

  async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
    this.prompts.push(prompt);

    if (isDocumentAnalysisPrompt(prompt)) {
      return createExecResult(createEmptyAnchorCatalog());
    }

    if (options.outputSchema && prompt.includes("### BLOCK")) {
      const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
      return createExecResult(JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "中文占位译文") }));
    }

    if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
      return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
    }

    const currentTranslation = extractPromptSection(prompt, "【当前译文】");
    if (currentTranslation !== null) {
      return createExecResult(currentTranslation);
    }

    const source = extractPromptSection(prompt, "【英文原文】");
    return createExecResult(source ? "中文占位译文" : "");
  }
}

// P2 wrapper: intercepts JSON-blocks draft lane, guards against echoed
// English and empty content so inline test executors don't need individual
// BLOCK / contract-violation handling.
function createP2CompatibleExecutor(inner: CodexExecutor): CodexExecutor {
  return {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        // Try inner executor first — it may return valid JSON blocks
        const innerResult = await inner.execute(prompt, options);
        try {
          const parsed = JSON.parse(innerResult.text);
          if (Array.isArray(parsed.blocks) && parsed.blocks.length > 0) {
            return innerResult;
          }
        } catch { /* not valid JSON blocks, use placeholder */ }
        const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(
          JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "中文占位译文") })
        );
      }
      const result = await inner.execute(prompt, options);
      const trimmedResult = result.text.trim();
      // Guard: empty → placeholder
      if (!trimmedResult) {
        return { ...result, text: "中文占位译文" };
      }
      // Guard: result is pure English matching source → placeholder
      // Only trigger on draft/repair prompts (contain 【英文原文】), not audit
      if (
        prompt.includes("【英文原文】") &&
        !options.outputSchema &&
        !/[\u4e00-\u9fff]/u.test(trimmedResult)
      ) {
        return { ...result, text: "中文占位译文" };
      }
      return result;
    }
  };
}

function createExecResult(text: string, threadId?: string): CodexExecResult {
  return {
    text,
    stderr: "",
    jsonl: "",
    ...(threadId ? { threadId } : {}),
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  };
}

class SessionReuseExecutor implements CodexExecutor {
  readonly calls: CodexExecOptions[] = [];

  async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
    this.calls.push(options);

    if (isDocumentAnalysisPrompt(prompt)) {
      return createExecResult(createEmptyAnchorCatalog(), "thread-1");
    }

    if (options.outputSchema) {
      return createExecResult(wrapAuditForSegments(prompt, createAudit(true)), "thread-1");
    }

    if (prompt.includes("只返回 JSON")) {
      return createExecResult(wrapAuditForSegments(prompt, createAudit(true)), "thread-1");
    }

    if (prompt.includes("【must_fix】")) {
      assert.equal(options.threadId, "thread-1");
      return createExecResult("# 标题（Title）\n\n正文", "thread-1");
    }

    if (prompt.includes("只做“风格与可读性润色”")) {
      return createExecResult("# 标题（Title）\n\n正文");
    }

    return createExecResult("# 标题\n\n正文", "thread-1");
  }
}

class WrappedInlineCodeExecutor implements CodexExecutor {
  readonly prompts: string[] = [];

  async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const bc = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: bc }, () => "中文占位译文") }));
      }
    this.prompts.push(prompt);

    if (isDocumentAnalysisPrompt(prompt)) {
      return createExecResult(createEmptyAnchorCatalog());
    }

    if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
      const currentTranslation = extractPromptSection(prompt, "【当前译文】") ?? "";
      assert.match(currentTranslation, /`~\/\.ssh`/);
      assert.doesNotMatch(currentTranslation, /@@MDZH_INLINE_CODE_\d{4,}@@/);
      return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
    }

    if (prompt.includes("只做“风格与可读性润色”")) {
      return createExecResult(extractPromptSection(prompt, "【当前译文】") ?? "");
    }

    return createExecResult("With sandbox: 访问 `~/.ssh` 会被阻止。\n");
  }
}

function extractPromptSection(prompt: string, label: string): string | null {
  const start = prompt.indexOf(`${label}\n`);
  if (start < 0) {
    return null;
  }

  const contentStart = start + label.length + 1;
  const nextLabelIndex = prompt
    .slice(contentStart)
    .search(/\n\n【[^】]+】/);

  if (nextLabelIndex < 0) {
    return prompt.slice(contentStart);
  }

  return prompt.slice(contentStart, contentStart + nextLabelIndex);
}

function createMinimalChunkPromptContext(
  overrides: Partial<ChunkPromptContext> = {}
): ChunkPromptContext {
  return {
    documentTitle: "Title",
    headingPath: ["Title"],
    chunkIndex: 1,
    chunkCount: 1,
    sourcePathHint: "article.md",
    segmentHeadings: [],
    headingPlanSummaries: [],
    emphasisPlanSummaries: [],
    blockPlanSummaries: [],
    analysisPlanDraft: '<SEGMENT id="chunk-1-segment-1">\n</SEGMENT>',
    requiredAnchors: [],
    repeatAnchors: [],
    establishedAnchors: [],
    pendingRepairs: [],
    specialNotes: [],
    stateSlice: null,
    ...overrides
  };
}

test("parseGateAudit accepts fenced JSON output", () => {
  const audit = createAudit(true);
  const parsed = parseGateAudit(`\`\`\`json\n${JSON.stringify(audit, null, 2)}\n\`\`\``);
  assert.equal(parsed.hard_checks.paragraph_match.pass, true);
  assert.deepEqual(parsed.must_fix, []);
});

test("parseGateAudit normalizes corner quotes in audit text", () => {
  const audit = createAudit(false, ["第 2 类「Commands」小节中“docker”“sudo”两条命令需去掉行内代码。"]);
  audit.hard_checks.first_mention_bilingual.problem = "标题『System File Access』缺少首现中英对照。";

  const parsed = parseGateAudit(JSON.stringify(audit));

  assert.equal(parsed.hard_checks.first_mention_bilingual.problem, "标题‘System File Access’缺少首现中英对照。");
  assert.deepEqual(parsed.must_fix, ["第 2 类“Commands”小节中“docker”“sudo”两条命令需去掉行内代码。"]);
});

test("parseGateAudit parses structured repair targets", () => {
  const audit = {
    ...createAudit(false, ["第 1 个项目符号中的 `npm registry` 需改为 `npm 注册表（npm registry）`。"]),
    repair_targets: [
      {
        location: "第 1 个项目符号",
        kind: "list_item",
        currentText: "npm",
        targetText: "npm 注册表（npm registry）",
        english: "npm registry",
        chineseHint: "npm 注册表"
      }
    ]
  };

  const parsed = parseGateAudit(JSON.stringify(audit));

  assert.equal(parsed.repair_targets?.[0]?.location, "第 1 个项目符号");
  assert.equal(parsed.repair_targets?.[0]?.targetText, "npm 注册表（npm registry）");
  assert.equal(parsed.repair_targets?.[0]?.english, "npm registry");
});

test("parseGateAudit downgrades formatter-only chinese punctuation failures", () => {
  const audit = {
    ...createAudit(false, ["将“审批疲劳（approval fatigue):”中的半角冒号改为全角冒号。"], {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: true, problem: "" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: false, problem: "“审批疲劳（approval fatigue):”中的半角冒号应改为全角。" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" },
      embedded_template_integrity: { pass: true, problem: "" }
    }),
    repair_targets: [
      {
        location: "标题",
        kind: "heading",
        currentText: "审批疲劳（approval fatigue):",
        targetText: "审批疲劳（approval fatigue）：",
        english: "approval fatigue",
        chineseHint: "审批疲劳",
        forbiddenTerms: null,
        sourceReferenceTexts: null
      }
    ]
  };

  const parsed = parseGateAudit(JSON.stringify(audit));

  assert.equal(parsed.hard_checks.chinese_punctuation.pass, true);
  assert.deepEqual(parsed.must_fix, []);
  assert.equal(parsed.repair_targets, undefined);
});

test("translateMarkdownArticle reifies chunk failures into executable repair tasks", async () => {
  const source = "- npm registry\n";

  class ChunkFailureReifyExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        const audit: GateAudit = {
          ...createAudit(false, ["第 1 个项目符号中的 `npm registry` 需改为 `npm 注册表（npm registry）`。"], {
            paragraph_match: { pass: true, problem: "" },
            first_mention_bilingual: { pass: false, problem: "第 1 个项目符号中的 npm registry 需补成 npm 注册表（npm registry）。" },
            numbers_units_logic: { pass: true, problem: "" },
            // #80: first_mention_bilingual is a soft check and can't trigger
            // the repair-task reification path on its own. Pair it with a
            // non-structural hard failure so the reification + HardGateError
            // path still exercises.
            chinese_punctuation: { pass: false, problem: "第 1 个项目符号句末缺少中文标点。" },
            unit_conversion_boundary: { pass: true, problem: "" },
            protected_span_integrity: { pass: true, problem: "" },
            embedded_template_integrity: { pass: true, problem: "" }
          }),
          repair_targets: [
            {
              location: "第 1 个项目符号",
              kind: "list_item",
              currentText: "npm",
              targetText: "npm 注册表（npm registry）",
              english: "npm registry",
              chineseHint: "npm 注册表",
              forbiddenTerms: [],
              sourceReferenceTexts: []
            }
          ]
        };
        return createExecResult(wrapAuditForSegments(prompt, audit));
      }

      if (prompt.includes("【must_fix】")) {
        return createExecResult("- npm\n");
      }

      return createExecResult("- npm\n");
    }
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "mdzh-reify-"));
  const debugPath = path.join(tempDir, "state.json");
  const previous = process.env.MDZH_DEBUG_STATE_PATH;
  process.env.MDZH_DEBUG_STATE_PATH = debugPath;

  try {
    await assert.rejects(
      () =>
        translateMarkdownArticle(source, {
          executor: new ChunkFailureReifyExecutor(),
          formatter: async (markdown) => markdown,
          softGate: false
        }),
      (error: unknown) => error instanceof HardGateError
    );

    const exported = JSON.parse(await readFile(debugPath, "utf8")) as {
      chunks: Array<{
        lastFailure: {
          summary: string;
          segments: Array<{
            segmentId: string | null;
            structuredTargets?: Array<{ targetText?: string }>;
          }>;
        } | null;
      }>;
      segments: Array<{ id: string; repairTaskIds: string[] }>;
      repairs: Array<{
        segmentId: string;
        structuredTarget?: { targetText?: string };
        status: string;
      }>;
    };

    assert.match(exported.chunks[0]?.lastFailure?.summary ?? "", /npm registry/);
    assert.equal(
      exported.chunks[0]?.lastFailure?.segments[0]?.structuredTargets?.[0]?.targetText,
      "npm 注册表（npm registry）"
    );
    assert.ok((exported.segments[0]?.repairTaskIds.length ?? 0) > 0);
    assert.ok(
      exported.repairs.some(
        (repair) =>
          repair.segmentId === "chunk-1-segment-1" &&
          repair.status === "pending" &&
          repair.structuredTarget?.targetText === "npm 注册表（npm registry）"
      )
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_DEBUG_STATE_PATH;
    } else {
      process.env.MDZH_DEBUG_STATE_PATH = previous;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("translateMarkdownArticle splits a trailing standalone blockquote away from a paragraph run", async () => {
  const source = [
    "# Title",
    "",
    "Neither option is sustainable.",
    "",
    "The permission system interrupts every action, creating files, running commands, and installing packages.",
    "",
    "Click approve once, and you will be prompted again 30 seconds later.",
    "",
    "> YOLO mode is an alternative, designed to skip all prompts and grant Claude unrestricted access to your system.",
    "",
    "Claude Code’s new sandbox mode solves both problems with a more innovative approach.",
    ""
  ].join("\n");

  const prompts: string[] = [];
  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      prompts.push(prompt);
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "占位正文") }));
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      const current = extractPromptSection(prompt, "【当前译文】");
      if (current !== null) {
        return createExecResult(current);
      }
      const sourceSection = extractPromptSection(prompt, "【英文原文】");
      return createExecResult(sourceSection ?? "");
    }
  };

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const promptBodies = prompts.filter((prompt) => !isDocumentAnalysisPrompt(prompt));
  assert.ok(
    promptBodies.some(
      (prompt) =>
        prompt.includes("> YOLO mode is an alternative, designed to skip all prompts and grant Claude unrestricted access to your system.") &&
        !prompt.includes("Neither option is sustainable.")
    )
  );
});

test("translateMarkdownArticle routes a standalone blockquote with protected flags through the JSON block lane", async () => {
  const source = [
    "> If you’ve been coding with Claude Code, you’ve likely hit two walls: the constant permission prompts that kill productivity, or the --dangerously-skip-permissions flag that removes all safety guardrails.",
    ""
  ].join("\n");

  const prompts: string[] = [];
  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      prompts.push(prompt);
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (options.outputSchema && prompt.includes("### BLOCK 1")) {
        return createExecResult(JSON.stringify({ blocks: ["> `--dangerously-skip-permissions` 标志会移除所有安全护栏。"] }));
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      throw new Error("Standalone blockquote should not fall back to the freeform text draft lane.");
    }
  };

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.ok(prompts.some((prompt) => prompt.includes("### BLOCK 1 (blockquote)")));
  assert.match(result.markdown, /--dangerously-skip-permissions/);
});

test("translateMarkdownArticle normalizes protected link label spacing and malformed inline emphasis before audit", async () => {
  const source = [
    "This is not Claude code by default, but it’s isolation enforced by Linux [bubblewrap ](https://github.com/containers/bubblewrap) or [macOS](https://en.wikipedia.org/wiki/MacOS) * Seatbel*t — the same security primitives that protect containers and system services.",
    ""
  ].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createEmptyAnchorCatalog());
        }

        if (options.outputSchema && prompt.includes("### BLOCK 1")) {
          return createExecResult(
            JSON.stringify({
              blocks: [
                "默认情况下，这并不是 Claude Code（Anthropic 的命令行编码助手） 代码，而是由 Linux [bubblewrap（安全隔离组件） ](@@MDZH_LINK_DESTINATION_0001@@) 或 [macOS](@@MDZH_LINK_DESTINATION_0002@@) * Seatbel*t 强制实施的隔离。"
              ]
            })
          );
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
        }

        const current = extractPromptSection(prompt, "【当前译文】");
        if (current !== null) {
          return createExecResult(current);
        }

        return createExecResult(
          "默认情况下，这并不是 Claude Code（Anthropic 的命令行编码助手） 代码，而是由 Linux [bubblewrap（安全隔离组件） ](https://github.com/containers/bubblewrap) 或 [macOS](https://en.wikipedia.org/wiki/MacOS) * Seatbel*t 强制实施的隔离。"
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /\[bubblewrap（安全隔离组件）\]\(https:\/\/github\.com\/containers\/bubblewrap\)/);
  assert.match(result.markdown, /\*Seatbelt\*/);
  assert.doesNotMatch(result.markdown, /bubblewrap（安全隔离组件） \]/);
  assert.doesNotMatch(result.markdown, /\* Seatbel\*t/);
});

test("translateMarkdownArticle routes a standalone list block through the JSON block lane", async () => {
  const source = [
    "- Pre-approved destinations (npm registry, GitHub, your APIs)",
    "- Blocked destinations (random servers, pastebin sites, unknown domains)",
    "- Request-based approval for new destinations",
    ""
  ].join("\n");

  const prompts: string[] = [];
  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      prompts.push(prompt);
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (options.outputSchema && prompt.includes("### BLOCK 1")) {
        return createExecResult(
          JSON.stringify({
            blocks: [
              [
                "- 预先批准的目标（npm registry、GitHub、你的 API）",
                "- 被阻止的目标（随机服务器、pastebin 站点、未知域名）",
                "- 对新目标采用请求式批准"
              ].join("\n")
            ]
          })
        );
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      throw new Error("Standalone list blocks should not use the freeform text draft lane.");
    }
  };

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.ok(prompts.some((prompt) => prompt.includes("### BLOCK 1 (list)")));
  assert.match(result.markdown, /npm registry/);
});

test("translateMarkdownArticle normalizes bilingual anchor text before gate audit", async () => {
  const source = "- Prompt injection attacks can hide malicious instructions.\n";

  class NormalizingExecutor implements CodexExecutor {
    readonly prompts: string[] = [];

    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      this.prompts.push(prompt);

      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          createAnchorCatalog([
            {
              english: "Prompt injection attacks",
              chineseHint: "提示注入攻击",
              familyKey: "prompt-injection",
              chunkId: "chunk-1",
              segmentId: "chunk-1-segment-1"
            }
          ])
        );
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        const currentTranslation = extractPromptSection(prompt, "【当前译文】") ?? "";
        assert.match(currentTranslation, /提示注入攻击（Prompt injection attacks）/);
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult(extractPromptSection(prompt, "【当前译文】") ?? "");
      }

      return createExecResult("Prompt injection attacks（Prompt injection attacks） can hide malicious instructions.\n");
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new NormalizingExecutor(),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /提示注入攻击（Prompt injection attacks）/);
});

test("translateMarkdownArticle falls back to the hard-pass translation when style polish returns meta task text", async () => {
  const source = [
    "# Docs",
    "",
    "Prompt injection attacks can be blocked.",
    ""
  ].join("\n");

  const passingAudit = createAudit(true);
  const progress: string[] = [];

  class MetaStyleExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const bc = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: bc }, () => "中文占位译文") }));
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, passingAudit));
      }

      const current = extractPromptSection(prompt, "【当前译文】") ?? extractPromptSection(prompt, "【英文原文】") ?? "";
      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult(
          "无法继续处理：当前任务未提供所属 GitLab 项目和 issue。\n\n请先提供项目链接和 issue 编号。"
        );
      }

      return createExecResult(current);
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new MetaStyleExecutor(),
    formatter: async (markdown) => markdown,
    styleMode: "final",
    onProgress: (message) => progress.push(message)
  });

  assert.equal(result.styleApplied, false);
  assert.match(result.markdown, /中文占位译文/);
  assert.ok(
    progress.some((message) =>
      message.includes("style polish returned task-management or refusal text")
    )
  );
});

test("translateMarkdownArticle falls back to the hard-pass translation when style polish returns AGENTS/NO_REPO guidance", async () => {
  const source = [
    "# Docs",
    "",
    "Supply chain attacks can be blocked.",
    ""
  ].join("\n");

  const passingAudit = createAudit(true);
  const progress: string[] = [];

  class AgentsRuleStyleExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const bc = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: bc }, () => "中文占位译文") }));
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, passingAudit));
      }

      const current = extractPromptSection(prompt, "【当前译文】") ?? extractPromptSection(prompt, "【英文原文】") ?? "";
      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult(
          "当前无法继续处理这段润色，因为按仓库内 [AGENTS.md](/tmp/AGENTS.md) 规则，任务必须先绑定项目和 issue；而我现在无法访问 GitLab 来确认或创建记录。\n\n如果你要我直接在本地继续，请回复精确短语：`NO_REPO`。"
        );
      }

      return createExecResult(current);
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new AgentsRuleStyleExecutor(),
    formatter: async (markdown) => markdown,
    styleMode: "final",
    onProgress: (message) => progress.push(message)
  });

  assert.equal(result.styleApplied, false);
  assert.match(result.markdown, /中文占位译文/);
  assert.ok(
    progress.some((message) =>
      message.includes("style polish returned task-management or refusal text")
    )
  );
});

test("translateMarkdownArticle falls back to the hard-pass translation when style polish says GitLab project and issue info are missing", async () => {
  const source = [
    "# Docs",
    "",
    "Supply chain attacks can be blocked.",
    ""
  ].join("\n");

  const passingAudit = createAudit(true);
  const progress: string[] = [];

  class MissingProjectStyleExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const bc = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: bc }, () => "中文占位译文") }));
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, passingAudit));
      }

      const current = extractPromptSection(prompt, "【当前译文】") ?? extractPromptSection(prompt, "【英文原文】") ?? "";
      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult(
          "缺少 GitLab 项目与 issue 信息，按仓库规则不能继续。若当前确实无法关联项目，请回复 `NO_REPO`。"
        );
      }

      return createExecResult(current);
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new MissingProjectStyleExecutor(),
    formatter: async (markdown) => markdown,
    styleMode: "final",
    onProgress: (message) => progress.push(message)
  });

  assert.equal(result.styleApplied, false);
  assert.match(result.markdown, /中文占位译文/);
  assert.ok(
    progress.some((message) =>
      message.includes("style polish returned task-management or refusal text")
    )
  );
});

test("translateMarkdownArticle falls back to the hard-pass translation when style polish says GitLab project info is missing", async () => {
  const source = [
    "# Docs",
    "",
    "Autonomous coding agents need file access.",
    ""
  ].join("\n");

  const passingAudit = createAudit(true);
  const progress: string[] = [];

  class MissingProjectOnlyStyleExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const bc = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: bc }, () => "中文占位译文") }));
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, passingAudit));
      }

      const current = extractPromptSection(prompt, "【当前译文】") ?? extractPromptSection(prompt, "【英文原文】") ?? "";
      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult(
          "缺少 GitLab 项目信息，不能按仓库规则继续处理。请提供对应项目链接；如果当前确实无法创建或访问项目，请明确回复 `NO_REPO`。"
        );
      }

      return createExecResult(current);
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new MissingProjectOnlyStyleExecutor(),
    formatter: async (markdown) => markdown,
    styleMode: "final",
    onProgress: (message) => progress.push(message)
  });

  assert.equal(result.styleApplied, false);
  assert.match(result.markdown, /中文占位译文/);
  assert.ok(
    progress.some((message) =>
      message.includes("style polish returned task-management or refusal text")
    )
  );
});

test("translateMarkdownArticle strips added inline code from plain command list items under Commands", async () => {
  const source = [
    "### Category 2: Prompted",
    "",
    "**Commands:**",
    "",
    "- docker (system-level tool)",
    "- sudo anything (privilege escalation)"
  ].join("\n");

  class PlainCommandExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const translated = [
        "### 第 2 类：提示后执行",
        "",
        "**命令（Commands）：**",
        "",
        "- `docker`（系统级工具）",
        "- `sudo` 的任何用法（提权）"
      ].join("\n");

      return createExecResult(translated);
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new PlainCommandExecutor(),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /- docker（系统级工具）/);
  assert.match(result.markdown, /- sudo 的任何用法（提权）/);
  assert.doesNotMatch(result.markdown, /`docker`/);
  assert.doesNotMatch(result.markdown, /`sudo`/);
});

test("translateMarkdownArticle strips added inline code from multi-command phrases under Commands", async () => {
  const source = [
    "### Category 1: Auto-Allowed",
    "",
    "**Commands:**",
    "",
    "- git status, git log, git diff",
    "- npm install, npm test, npm run",
    "- ls, cat, echo, basic shell commands",
    "- python script.py (runs code in project)"
  ].join("\n");

  class MultiCommandExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const translated = [
        "### 第 1 类：自动允许",
        "",
        "**命令（Commands）：**",
        "",
        "- `git status`、`git log`、`git diff`",
        "- `npm install`、`npm test`、`npm run`",
        "- ls、`cat`、`echo`、基础 shell 命令",
        "- `python script.py`（在项目中运行代码）"
      ].join("\n");

      return createExecResult(translated);
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new MultiCommandExecutor(),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /- git status、git log、git diff/);
  assert.match(result.markdown, /- npm install、npm test、npm run/);
  assert.match(result.markdown, /- ls、cat、echo、基础 shell 命令/);
  assert.match(result.markdown, /- python script\.py（在项目中运行代码）/);
  assert.doesNotMatch(result.markdown, /`git status`/);
  assert.doesNotMatch(result.markdown, /`npm install`/);
  assert.doesNotMatch(result.markdown, /`cat`/);
  assert.doesNotMatch(result.markdown, /`python script\.py`/);
});

test("translateMarkdownArticle strips added inline code from plain flags inside blockquotes", async () => {
  const source = [
    "# Title",
    "",
    "> If you use the --dangerously-skip-permissions flag, you remove safety guardrails.",
    "",
    "The `--dangerously-skip-permissions` flag exists as an escape hatch from this fatigue."
  ].join("\n");

  class MixedFlagQuoteExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const translated = [
        "# Title",
        "",
        "> 如果你使用 `--dangerously-skip-permissions` 标志，就会移除安全护栏。",
        "",
        "这个 --dangerously-skip-permissions 标志是为了缓解这种疲劳而存在的逃生舱。"
      ].join("\n");

      return createExecResult(translated);
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new MixedFlagQuoteExecutor(),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /> 如果你使用 --dangerously-skip-permissions 标志/);
  assert.match(result.markdown, /这个 `--dangerously-skip-permissions` 标志是为了缓解这种疲劳而存在的逃生舱/);
  assert.doesNotMatch(result.markdown, /> 如果你使用 `--dangerously-skip-permissions` 标志/);
});

test("translateMarkdownArticle keeps translatable strong emphasis and raw inline code visible at final style polish", async () => {
  const source = [
    "# Title",
    "",
    "> Why is this blocked? `~/.bashrc` is sensitive.",
    "",
    "Choose **Deny** for this test.",
    ""
  ].join("\n");

  class InlineMarkupExecutor implements CodexExecutor {
    readonly prompts: string[] = [];

    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      this.prompts.push(prompt);

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        assert.match(prompt, /`~\/\.bashrc`/);
        assert.doesNotMatch(prompt, /@@MDZH_INLINE_CODE_\d{4,}@@/);
        assert.match(prompt, /\*\*Deny\*\*/);
        return createExecResult(extractPromptSection(prompt, "【当前译文】") ?? "");
      }

      const protectedSource = extractPromptSection(prompt, "【英文原文】") ?? "";
      return createExecResult(
        protectedSource
          .replace("# Title", "# 标题")
          .replace("Why is this blocked?", "为什么这会被拦截？")
          .replace("is sensitive.", "属于敏感文件。")
          .replace("Choose", "本次测试请选择")
          .replace("for this test.", "。")
      );
    }
  }

  const executor = new InlineMarkupExecutor();
  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    styleMode: "final"
  });

  assert.match(result.markdown, /> 为什么这会被拦截？ `~\/\.bashrc` 属于敏感文件。/);
  assert.match(result.markdown, /本次测试请选择 \*\*Deny\*\*\。?/);
});

test("translateMarkdownArticle skips bundled audit for large multi-segment chunks", async () => {
  const source = [
    "# How to Use New Claude Code Sandbox",
    "",
    "226",
    "",
    "*Claude Code Sandbox Featured Image/ By Author*",
    "",
    "Claude Code **now has a sandbox mode** that makes the YOLO mode look amateurish.",
    "",
    "> If you’ve been coding with Claude Code, you’ve likely hit two walls: the constant permission prompts that kill productivity, or the --dangerously-skip-permissions flag that removes all safety guardrails.",
    "",
    "Neither option is sustainable.",
    "",
    "The permission system interrupts every action, creating files, running commands, and installing packages.",
    "",
    "Click “approve” once, and you will be prompted again 30 seconds later.",
    "",
    "Repeat this 100 times per session, and you may become frustrated or experience a slowdown.",
    "",
    "> YOLO mode is an alternative, designed to skip all prompts and grant Claude unrestricted access to your system.",
    ""
  ].join("\n");

  const prompts: string[] = [];
  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      prompts.push(prompt);
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "占位正文") }));
      }
      if (options.outputSchema && prompt.includes("【分段审校输入】")) {
        throw new Error("Bundled audit should be skipped for this chunk shape.");
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(JSON.stringify(createAudit(true)));
      }
      const current = extractPromptSection(prompt, "【当前译文】");
      if (current !== null) {
        return createExecResult(current);
      }
      const sourceSection = extractPromptSection(prompt, "【英文原文】");
      // Return Chinese placeholder content rather than echoing the English
      // source so the draft contract and the untranslated-segment guard treat
      // the mock as a real translation. This test exists to verify that
      // bundled audit is skipped for large multi-segment chunks, not to
      // exercise the echoed-source repair path.
      return createExecResult(sourceSection ? "中文占位译文" : "");
    }
  });

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.ok(
    prompts.some((prompt) => prompt.includes("【英文原文】") && prompt.includes("> YOLO mode is an alternative"))
  );
  assert.equal(prompts.some((prompt) => prompt.includes("【分段审校输入】")), false);
});

test("translateMarkdownArticle switches to per-segment audits after a repair cycle", async () => {
  const source = [
    "# Title",
    "",
    "## Need",
    "",
    "Kernel level enforcement reduces prompt spam.",
    "",
    "Socket level interception blocks unauthorized connections.",
    "",
    "Sandbox mode protects the system.",
    ""
  ].join("\n");

  let bundledAuditCount = 0;
  let fallbackAuditCount = 0;
  let bundledAuditAfterRepair = false;
  let sawRepair = false;

  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        return createExecResult(currentTranslation ?? "");
      }

      if (prompt.includes("只做“定点修复”")) {
        sawRepair = true;
        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        return createExecResult(currentTranslation ?? "");
      }

      if (options.outputSchema && prompt.includes("【分段审校输入】")) {
        bundledAuditCount += 1;
        if (sawRepair) {
          bundledAuditAfterRepair = true;
        }
        if (bundledAuditCount === 1) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              { segment_index: 1, audit: createAudit(false, ["修复项一"]) },
              { segment_index: 3, audit: createAudit(false, ["修复项二"]) }
            ])
          );
        }
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        fallbackAuditCount += 1;
        return createExecResult(JSON.stringify(createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }

      const sourceSection = extractPromptSection(prompt, "【英文原文】");
      return createExecResult(sourceSection ?? "");
    }
  });

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.equal(bundledAuditCount, 1);
  assert.equal(bundledAuditAfterRepair, false);
  assert.ok(fallbackAuditCount >= 1);
});

test("translateMarkdownArticle passes segment heading hints into prompts for heading-like blocks", async () => {
  const source = [
    "# Title",
    "",
    "Intro paragraph.",
    "",
    "**Step One: Run Check (No Prompt)**",
    "",
    "Explain the step.",
    ""
  ].join("\n");

  const responses = [
    "# Title\n\nIntro paragraph.\n",
    JSON.stringify(createAudit(true)),
    "# Title\n\nIntro paragraph.\n",
    "**步骤一：运行检查（Step One: Run Check, No Prompt）**\n",
    JSON.stringify(createAudit(true)),
    "**步骤一：运行检查（Step One: Run Check, No Prompt）**\n",
    "Explain the step.\n",
    JSON.stringify(createAudit(true)),
    "Explain the step.\n"
  ];
  const executor = new StubExecutor(responses);

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.ok(
    executor.prompts.some(
      (prompt) =>
        prompt.includes("当前分段标题：") && prompt.includes("Step One: Run Check (No Prompt)")
    )
  );
});

test("translateMarkdownArticle adds heading-specific bilingual guidance for heading segments", async () => {
  const source = [
    "# Title",
    "",
    "## How Sandbox Mode Changes Autonomous Coding",
    "",
    "Body paragraph.",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const prompt = executor.prompts.find(
    (item) => !isDocumentAnalysisPrompt(item) && item.includes("How Sandbox Mode Changes Autonomous Coding")
  );
  assert.ok(prompt);
  assert.match(prompt, /【当前分段附加规则】/);
  assert.match(prompt, /当前分段包含标题或加粗标题/);
  assert.match(prompt, /必须直接在标题本身补齐中英文对照/);
});

test("translateMarkdownArticle repeats heading-only repair guidance when must_fix targets the title", async () => {
  const source = [
    "# Title",
    "",
    "## How Sandbox Mode Changes Autonomous Coding",
    "",
    "Body paragraph.",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        executor.prompts.push(prompt);

        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "autonomous coding",
                chineseHint: "自主编码",
                familyKey: "autonomous-coding"
              },
              {
                english: "autonomous coding agents",
                chineseHint: "自主编码代理",
                familyKey: "autonomous-coding"
              }
            ])
          );
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              { segment_index: 1, audit: createAudit(false, ["标题中的“Autonomous Coding”需补中英文对照"]) }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        const sourceSection = extractPromptSection(prompt, "【英文原文】");
        return createExecResult(sourceSection ?? "");
      }
    }),
    formatter: async (markdown) => markdown
  });

  const repairPrompt = executor.prompts.find(
    (item) => item.includes("【must_fix】") && item.includes("标题中的“Autonomous Coding”需补中英文对照")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /本次 must_fix 明确指向标题/);
  assert.match(repairPrompt, /必须直接修改以下标题文本本身/);
  assert.match(repairPrompt, /不要把标题里的首现双语修复转移到正文其他句子/);
  assert.match(repairPrompt, /如果标题里的目标是英文产品名、工具名、项目名、模型名、CLI 名称，或以英文表达的核心概念性标题术语/);
});

test("translateMarkdownArticle repeats list-item repair guidance when must_fix targets bullet items", async () => {
  const source = [
    "# Title",
    "",
    "## Section",
    "",
    "- Pre-approved destinations (npm registry, GitHub, your APIs)",
    "- Auto-allowed commands (git, npm, basic file operations)",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        executor.prompts.push(prompt);

        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "autonomous coding",
                chineseHint: "自主编码",
                familyKey: "autonomous-coding"
              },
              {
                english: "autonomous coding agents",
                chineseHint: "自主编码代理",
                familyKey: "autonomous-coding"
              }
            ])
          );
        }

        if (isBundledAuditPrompt(prompt, options)) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(false, [
                  "在“预先批准的目标”条目中，`npm registry` 首次出现只保留了英文，需补上中文说明并保持中英文对应。",
                  "在“自动允许的命令”条目中，`npm` 首次出现只保留了英文，需补上中文说明并保持中英文对应。"
                ])
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        const sourceSection = extractPromptSection(prompt, "【英文原文】");
        return createExecResult(sourceSection ?? "");
      }
    }),
    formatter: async (markdown) => markdown
  });

  const repairPrompts = executor.prompts.filter((item) => item.includes("【must_fix】"));
  assert.ok(repairPrompts.length >= 1);
  const combinedRepairPrompt = repairPrompts.join("\n\n");
  assert.match(combinedRepairPrompt, /当前分段包含列表项或项目符号/);
  assert.match(combinedRepairPrompt, /本次 must_fix 明确指向列表项或项目符号/);
  assert.match(combinedRepairPrompt, /必须直接修改对应的列表项文本本身/);
  assert.match(combinedRepairPrompt, /要逐条在各自的列表项里补齐/);
  assert.match(combinedRepairPrompt, /如果 must_fix 点名的是某个列表项里的核心英文概念、术语或英文短语/);
  assert.match(combinedRepairPrompt, /不要只保留同一列表项括号里的另一个英文专名、品牌名、缩写或解释来冒充“已修复”/);
});

test("translateMarkdownArticle repeats list-lead-in repair guidance when must_fix targets a colon-led intro sentence", async () => {
  const source = [
    "# Title",
    "",
    "## Section",
    "",
    "Compromised npm packages or dependencies that attempt to:",
    "",
    "- Read environment variables and credentials",
    "- Exfiltrate source code to external servers",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        executor.prompts.push(prompt);

        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "autonomous coding",
                chineseHint: "自主编码",
                familyKey: "autonomous-coding"
              },
              {
                english: "autonomous coding agents",
                chineseHint: "自主编码代理",
                familyKey: "autonomous-coding"
              }
            ])
          );
        }

        if (isBundledAuditPrompt(prompt, options)) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(false, [
                  "在“被攻破的 npm 包或依赖项可能会尝试：”中，首次出现的 npm 需补中文说明，不能只保留英文缩写。"
                ])
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        const sourceSection = extractPromptSection(prompt, "【英文原文】");
        return createExecResult(sourceSection ?? "");
      }
    }),
    formatter: async (markdown) => markdown
  });

  const repairPrompt = executor.prompts.find(
    (item) =>
      item.includes("【must_fix】") &&
      item.includes("在“被攻破的 npm 包或依赖项可能会尝试：”中，首次出现的 npm 需补中文说明")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /当前分段包含列表前的说明句、导语句或冒号引导句/);
  assert.match(repairPrompt, /本次 must_fix 明确指向列表前的说明句、导语句或冒号引导句/);
  assert.match(repairPrompt, /必须直接修改对应引导句本身/);
  assert.match(repairPrompt, /不要把缺失的首现双语或中文说明转移到后面的列表项里/);
});

test("translateMarkdownArticle repeats in-sentence repair guidance when must_fix targets the current sentence", async () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    [
      "当前句“But you need to understand what kind of access your Claude Code AI agents need so that you can understand why you need the sandboxes.”中，首次出现的“sandboxes”未补中英对照；需在该处补成中文+英文首现锚定。"
    ]
  );

  const notes = context.specialNotes.join("\n");
  assert.match(notes, /本次 must_fix 明确指向当前句或该句的正文说明/);
  assert.match(notes, /必须直接在这同一句本身补齐缺失的首现中英文对照或中文说明/);
  assert.match(notes, /不要把修复转移到同一分段的前一句、后一句、标题、列表项或总结句里/);
});

test("buildRepairPromptContext injects paragraph_match missing-source guidance when audit quotes an unfixed sentence (#67)", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    [
      "第 1 个标题块的译文缺少原文后半句\"because they look great on both the mobile app and desktop, and they won't get messed up by the publication's formatting rules.\"，需补全整句含义并保持标题结构。",
      "硬性检查 paragraph_match 未通过：标题译文只覆盖了原句前半部分，缺少后半句内容，和原文不严格对应。"
    ]
  );

  const notes = context.specialNotes.join("\n");
  assert.match(notes, /当前段落或标题块漏翻了以下原文片段/);
  assert.match(notes, /because they look great on both the mobile app and desktop/);
  assert.match(notes, /paragraph_match 硬失败的本质是“内容缺失”而非排版问题/);
  assert.match(notes, /整段仍保持为单一标题节点/);
  assert.match(notes, /输出的修订译文相对当前译文必须明显变长/);
});

test("buildRepairPromptContext does not emit paragraph_match guidance for unrelated must_fix items (#67)", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    [
      "当前句“But you need to understand what kind of access your Claude Code AI agents need.”中，首次出现的“sandboxes”未补中英对照。"
    ]
  );

  const notes = context.specialNotes.join("\n");
  assert.doesNotMatch(notes, /paragraph_match 硬失败的本质是“内容缺失”/);
  assert.doesNotMatch(notes, /当前段落或标题块漏翻了以下原文片段/);
});

test("getDraftContractViolation rejects adjacent duplicate English parenthetical annotations (#69)", () => {
  const violation = getDraftContractViolationForTest(
    "@@MDZH_STRONG_EMPHASIS_0001@@",
    "小语言模型（Small Language Models (SLMs)）（SLMs）"
  );
  assert.ok(violation, "expected a violation string, got null");
  assert.match(violation!, /stacked duplicate English parenthetical/);
});

test("getDraftContractViolation allows a single English parenthetical annotation (#69)", () => {
  const violation = getDraftContractViolationForTest(
    "@@MDZH_STRONG_EMPHASIS_0001@@",
    "小语言模型（Small Language Models (SLMs)）"
  );
  assert.equal(violation, null);
});

test("getDraftContractViolation rejects raw bold markers when protected source had none (#69)", () => {
  const violation = getDraftContractViolationForTest(
    "@@MDZH_STRONG_EMPHASIS_0001@@",
    "**小语言模型**和**"
  );
  assert.ok(violation, "expected a violation string, got null");
  assert.match(violation!, /introduced raw bold markers/);
});

test("getDraftContractViolation preserves raw bold markers when the source already contained them (#69)", () => {
  const violation = getDraftContractViolationForTest(
    "这是**原文本身**带有的加粗片段",
    "这是**译文**保留的加粗片段"
  );
  assert.equal(violation, null);
});

test("getDraftContractViolation rejects extra raw bold markers when the source already had some (#77)", () => {
  const violation = getDraftContractViolationForTest(
    "这是**原文本身**带有的加粗片段",
    "这是**译文**保留的**额外**加粗片段"
  );
  assert.ok(violation, "expected a violation string, got null");
  assert.match(violation!, /introduced raw bold markers/);
});

test("getDraftContractViolation rejects moving a protected-span placeholder onto a heading line (#77)", () => {
  const source = [
    "### Large models (30-70B): three paths",
    "",
    "Once models exceed consumer GPU VRAM (32 GB), three options remain.",
    "",
    "@@MDZH_STRONG_EMPHASIS_0001@@ The RTX Pro 6000 Blackwell runs a 70B Q4 model."
  ].join("\n");
  const draft = [
    "### 大型模型（30-70B）：三种路径 @@MDZH_STRONG_EMPHASIS_0001@@",
    "",
    "一旦模型超过消费级 GPU 显存（32 GB），仅剩三种选项。",
    "",
    "RTX Pro 6000 Blackwell 可在单卡上运行 70B Q4 模型。"
  ].join("\n");
  const violation = getDraftContractViolationForTest(source, draft);
  assert.ok(violation, "expected a violation string, got null");
  assert.match(violation!, /moved protected-span placeholder .* onto a heading line/);
});

test("getDraftContractViolation allows a protected-span placeholder that stays on its non-heading line (#77)", () => {
  const source = [
    "### Large models (30-70B): three paths",
    "",
    "@@MDZH_STRONG_EMPHASIS_0001@@ The RTX Pro 6000 Blackwell runs a 70B Q4 model."
  ].join("\n");
  const draft = [
    "### 大型模型（30-70B）：三种路径",
    "",
    "@@MDZH_STRONG_EMPHASIS_0001@@ RTX Pro 6000 Blackwell 可运行 70B Q4 模型。"
  ].join("\n");
  const violation = getDraftContractViolationForTest(source, draft);
  assert.equal(violation, null);
});

test("getDraftContractViolation allows a placeholder that the source already puts on a heading line (#77)", () => {
  const source = [
    "### 关于 @@MDZH_INLINE_MARKDOWN_LINK_0001@@ 的说明",
    "",
    "段落内容。"
  ].join("\n");
  const draft = [
    "### @@MDZH_INLINE_MARKDOWN_LINK_0001@@ 相关说明",
    "",
    "段落内容。"
  ].join("\n");
  const violation = getDraftContractViolationForTest(source, draft);
  assert.equal(violation, null);
});

test("getDraftContractViolation rejects drafts that drop a list item (#82)", () => {
  const source = [
    "Bandwidth and capacity narrow the field. Three correction factors determine the final choice.",
    "",
    "- Energy consumption.",
    "A Mac Studio M3 Ultra draws 250–300W under sustained AI inference load.",
    "- Form factor and noise.",
    "A Mac Studio or Strix Halo mini-PC operates silently on a desk.",
    "- Software ecosystem.",
    "The inference framework significantly influences real-world performance."
  ].join("\n");
  const draft = [
    "带宽与容量先做筛选，最终选型由三项修正因素决定。",
    "",
    "- 能耗。",
    "Mac Studio M3 Ultra 在持续 AI 推理负载下功耗为 250–300W。",
    "- 外形因素与噪声。",
    "Mac Studio 或 Strix Halo 迷你 PC 可在桌面上静音运行。"
  ].join("\n");
  const violation = getDraftContractViolationForTest(source, draft);
  assert.ok(violation, "expected a violation when draft drops a bullet");
  assert.match(violation!, /dropped \d+ list item/);
});

test("getDraftContractViolation allows drafts that preserve every list item (#82)", () => {
  const source = [
    "- Add bandwidth to specifications",
    "Memory bandwidth belongs as its own line item.",
    "- Require bandwidth in RFPs",
    "One line in the template suffices.",
    "- Benchmark before buying",
    "Before investments above $25,000, benchmark one representative."
  ].join("\n");
  const draft = [
    "- 把带宽列入规格书。",
    "内存带宽应作为独立条目列出。",
    "- 在 RFP 中要求标注带宽。",
    "模板里加一行即可。",
    "- 采购前先基准测试。",
    "超过 $25,000 的投资前，先对每类架构做一次基准测试。"
  ].join("\n");
  const violation = getDraftContractViolationForTest(source, draft);
  assert.equal(violation, null);
});

test("getDraftContractViolation does not flag drafts with more list items than source (#82)", () => {
  // A draft that accidentally adds a bullet is a different failure mode; #82
  // targets the dropped-bullet case specifically.
  const source = "- Alpha\n- Beta";
  const draft = "- 甲\n- 乙\n- 丙";
  const violation = getDraftContractViolationForTest(source, draft);
  assert.equal(violation, null);
});

test("buildRepairPromptContext injects first_mention_bilingual cut-piece guidance when must_fix quotes an English target (#71)", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    [
      "第 2 个列表项中\"Boeing 747\"首次出现未按要求补中英文对照，需在该处直接补齐。"
    ]
  );

  const notes = context.specialNotes.join("\n");
  assert.match(notes, /first_mention_bilingual 硬失败/);
  assert.match(notes, /Boeing 747/);
  assert.match(notes, /切片 A——译文里已经有该概念的中文译名/);
  assert.match(notes, /切片 B——译文完全漏掉该概念/);
  assert.match(notes, /相邻重复括注/);
});

test("buildRepairPromptContext catches first_mention_bilingual signals phrased as 首现/双语 (#71)", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    [
      "在当前引用句中，\"Entity-Relationship\" 首现位置缺少双语锚定，需要补齐。"
    ]
  );

  const notes = context.specialNotes.join("\n");
  assert.match(notes, /first_mention_bilingual 硬失败/);
  assert.match(notes, /Entity-Relationship/);
});

test("buildRepairPromptContext does not emit first_mention_bilingual guidance for unrelated must_fix items (#71)", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    [
      "硬性检查 paragraph_match 未通过：标题译文只覆盖了原句前半部分。"
    ]
  );

  const notes = context.specialNotes.join("\n");
  assert.doesNotMatch(notes, /first_mention_bilingual 硬失败/);
  assert.doesNotMatch(notes, /切片 A——译文里已经有该概念的中文译名/);
});

test("translateMarkdownArticle ships first_mention_bilingual cut-piece guidance to the live repair prompt (#71 constructive smoke)", async () => {
  const source = "# Boeing Test\n\nThe Boeing 747 is a large aircraft.\n";
  const capturedPrompts: string[] = [];
  // #80: first_mention_bilingual is now a soft check and can't trigger the
  // repair loop by itself. Pair it with a non-structural hard failure
  // (chinese_punctuation) so the repair loop still runs and we can verify
  // first_mention_bilingual guidance is merged into the repair prompt.
  const failingAudit = createAudit(
    false,
    [
      "第 1 段中\"Boeing 747\"首次出现未按要求补中英文对照，需在该处直接补齐。",
      "第 1 段句末中文标点缺失。"
    ],
    {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: false, problem: "Boeing 747 missing bilingual anchor" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: false, problem: "missing Chinese punctuation" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" },
      embedded_template_integrity: { pass: true, problem: "" }
    }
  );

  await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
        capturedPrompts.push(prompt);
        if (isDocumentAnalysisPrompt(prompt)) return createExecResult(createEmptyAnchorCatalog());
        if (options.outputSchema || prompt.includes("只返回 JSON"))
          return createExecResult(wrapAuditForSegments(prompt, failingAudit));
        const current = extractPromptSection(prompt, "【当前译文】");
        return createExecResult(current ?? "波音 747 是一种大型飞机。");
      }
    }),
    formatter: async (markdown) => markdown,
    softGate: true
  });

  const repairPrompts = capturedPrompts.filter((prompt) => prompt.includes("【当前译文】"));
  assert.ok(repairPrompts.length > 0, "expected at least one repair prompt");
  const hitPrompt = repairPrompts.find(
    (prompt) =>
      prompt.includes("first_mention_bilingual 硬失败") &&
      prompt.includes("切片 A——译文里已经有该概念的中文译名") &&
      prompt.includes("Boeing 747")
  );
  assert.ok(
    hitPrompt,
    "expected a repair prompt carrying the #71 cut-piece guidance + the quoted English target"
  );
});

test("buildRepairPromptContext appends product-noun exemption and category-word blacklist guidance (#74)", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    [
      "第 1 段中\"Mac Studio M3 Ultra\"首次出现未按要求补中英文对照，需在该处直接补齐。"
    ]
  );

  const notes = context.specialNotes.join("\n");
  assert.match(notes, /first_mention_bilingual 硬失败/);
  assert.match(notes, /产品专名豁免（#74）/);
  assert.match(notes, /Mac Studio、DGX Spark、CUDA、RTX/);
  assert.match(notes, /类目词黑名单/);
  assert.match(notes, /机型、工作站、桌面机/);
  assert.match(notes, /Mac Studio M3 Ultra/);
  assert.match(notes, /protected_span_integrity 硬失败/);
});

test("buildRepairPromptContext does not emit product-noun exemption when no first_mention_bilingual signal fires (#74)", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    [
      "硬性检查 paragraph_match 未通过：标题译文只覆盖了原句前半部分。"
    ]
  );

  const notes = context.specialNotes.join("\n");
  assert.doesNotMatch(notes, /产品专名豁免（#74）/);
  assert.doesNotMatch(notes, /类目词黑名单/);
});

test("buildRepairPromptContext emits reverse whitelist for non-product technical concepts (#76)", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    [
      "第 7 个段落首次出现的 Mixture-of-Experts 需补齐中英对照，不能只写英文原名。"
    ]
  );

  const notes = context.specialNotes.join("\n");
  assert.match(notes, /反向白名单（#76/);
  assert.match(notes, /Mixture-of-Experts → 混合专家/);
  assert.match(notes, /Retrieval-Augmented Generation/);
  assert.match(notes, /Chain-of-Thought/);
  assert.match(notes, /产品豁免不适用/);
});

test("isHardPass treats first_mention_bilingual as soft check and returns true when only it fails (#80)", () => {
  const audit = createAudit(true);
  audit.hard_checks.first_mention_bilingual = {
    pass: false,
    problem: "首段 Mixture-of-Experts 未建立中英对照。"
  };
  assert.equal(__testOnlyIsHardPass(audit), true);
});

test("isHardPass still returns false when a structural hard check fails alongside first_mention_bilingual (#80)", () => {
  const audit = createAudit(true);
  audit.hard_checks.first_mention_bilingual = { pass: false, problem: "缺首现对照" };
  audit.hard_checks.paragraph_match = { pass: false, problem: "段落数量不一致" };
  assert.equal(__testOnlyIsHardPass(audit), false);
});

test("isHardPass still returns false when a non-semantic hard check fails on its own (#80)", () => {
  const audit = createAudit(true);
  audit.hard_checks.protected_span_integrity = {
    pass: false,
    problem: "占位符 @@MDZH_STRONG_EMPHASIS_0001@@ 未恢复。"
  };
  assert.equal(__testOnlyIsHardPass(audit), false);
});

test("isHardPass returns true for all-pass audits regardless of semantic check bypass (#80)", () => {
  const audit = createAudit(true);
  assert.equal(__testOnlyIsHardPass(audit), true);
});

test("translateMarkdownArticle surfaces IR targets in repair guidance when pending repairs are already bound", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext({
      stateSlice: {
        documentTitle: "Title",
        chunkId: "chunk-1",
        segmentId: "chunk-1-segment-1",
        chunkIndex: 1,
        segmentIndex: 1,
        headingPath: ["Title"],
        headingHints: [],
        headingPlans: [],
        emphasisPlans: [],
        blockPlans: [],
        aliasPlans: [],
        entityDisambiguationPlans: [],
        requiredAnchors: [],
        repeatAnchors: [],
        establishedAnchors: [],
        protectedSpanIds: [],
        pendingRepairs: [
          {
            repairId: "repair-1",
            anchorId: "anchor-1",
            failureType: "missing_anchor",
            locationLabel: "当前句",
            instruction: "当前句“Sandbox mode is now active.”中的“sandbox mode”需补为“沙盒模式（sandbox mode）”。",
            analysisPlanIds: ["anchor:anchor-1"],
            analysisPlanKinds: ["anchor"],
            analysisTargets: ["sandbox mode", "沙盒模式（sandbox mode）"]
          }
        ],
        headingPlanGovernedAnchorIds: [],
        analysisPlans: [],
        analysisPlanDraft: '<SEGMENT id="chunk-1-segment-1">\n  <PLAN id="anchor:anchor-1" kind="anchor" scope="required" source="sandbox mode" target="沙盒模式（sandbox mode）" />\n</SEGMENT>',
        ownerMap: []
      }
    }),
    ["当前句“Sandbox mode is now active.”中的“sandbox mode”需补为“沙盒模式（sandbox mode）”。"]
  );

  const notes = context.specialNotes.join("\n");
  assert.match(notes, /本次 must_fix 已关联到这些 IR 目标：sandbox mode \| 沙盒模式（sandbox mode）/);
  assert.match(notes, /修复时优先服从这些结构化 IR 目标/);
});


test("translateMarkdownArticle repeats explicit English target guidance when must_fix names a quoted term", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    ["第4条项目符号：将\u201cbubblewrap\u201d补成首现中英对照，保留原句含义。"]
  );
  const notes = context.specialNotes.join("\n");
  assert.match(notes, /本次 must_fix 明确点名了这些英文目标：bubblewrap/);
  assert.match(notes, /即使它看起来是常见技术词，也必须严格按 must_fix 要求修复/);
});

test("translateMarkdownArticle repeats blockquote-specific repair guidance when must_fix targets a quote segment", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    ["位置：引用段\u201c沙箱通过将这两类情况区分开来发挥作用\u201d。问题：核心术语 Sandbox 未完成中英文对照。修复目标：补齐。"]
  );
  const notes = context.specialNotes.join("\n");
  assert.match(notes, /本次 must_fix 已经通过/);
  assert.match(notes, /修复时必须把这句视为唯一有效落点/);
});

test("translateMarkdownArticle repeats duplicate-English-anchor guidance when must_fix rejects repeated parenthetical English", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    ["位置：`**Seatbelt**` 下第一条列表项；问题：`Seatbelt 安全框架（Seatbelt）` 的首现写法属于英文重复回括，未采用自然的中英锚定；修复目标：改为只保留一次英文原名并配中文说明。"]
  );
  const notes = context.specialNotes.join("\n");
  assert.match(notes, /同一个英文原名在同一个首现锚点里只能保留一次/);
});

test("translateMarkdownArticle repeats single-layer-parentheses guidance when must_fix rejects nested brackets", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    ["位置：列表第 1 项\u201c~/.ssh/\u201d。问题：译文写成\u201c（SSH 密钥（SSH keys））\u201d，出现双层括号。修复目标：改为单层括注。"]
  );
  const notes = context.specialNotes.join("\n");
  assert.match(notes, /双层括号或嵌套括注/);
  assert.match(notes, /不要生成.*中文.*English.*双层括号/);
});

test("translateMarkdownArticle repeats plain-path guidance when must_fix rejects newly added inline code", () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    ["位置：三个列表项中的路径 `~/.ssh/`、`~/.aws/`、`~/.config/`。问题：译文把原文普通文本路径改成了 inline code。修复目标：去掉反引号。"]
  );
  const notes = context.specialNotes.join("\n");
  assert.match(notes, /擅自把原文普通文本改成了 inline code/);
  assert.match(notes, /不要把路径本身改成代码样式/);
});
test("translateMarkdownArticle repeats paragraph-specific repair guidance when must_fix targets a numbered paragraph", async () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    [
      "位置：第4段“Claude 可以访问任何文件、运行任何命令，并连接到任何服务器。”问题：产品名“Claude”在全文当前分块首次出现时未做中英文对照。修复目标：在该首次出现处补最小必要的中英文锚定，并与后文保持一致。"
    ]
  );

  const notes = context.specialNotes.join("\n");
  assert.match(notes, /本次 must_fix 明确点名了某一具体段落/);
  assert.match(notes, /必须直接在被点名的那一段本身补齐缺失的首现中英文对照或中文说明/);
  assert.match(notes, /修复时应把该段视为唯一有效落点/);
});

test("translateMarkdownArticle repeats sentence-local repair guidance when must_fix quotes a specific sentence inside a paragraph", async () => {
  const context = buildRepairPromptContextForTest(
    createMinimalChunkPromptContext(),
    [
      "位置：第4段“文件系统权限决定了 Claude 可以访问什么。”问题：产品名“Claude”在正文句内首次出现时未做中英文对照。修复目标：在该句内补最小必要的中英文锚定，不要把修复转移到别处。"
    ]
  );

  const notes = context.specialNotes.join("\n");
  assert.match(notes, /本次 must_fix 已经通过“位置：……“某句””的形式明确摘录了具体句子/);
  assert.match(notes, /必须把这句视为唯一有效落点/);
  assert.match(notes, /不要把锚定转移到同段其他句子、标题、列表项、引用外说明或后续段落/);
});

test("translateMarkdownArticle repeats concept-family guidance when must_fix names both base and extended english terms", async () => {
  const source = [
    "## Claude Code Permission Problem",
    "",
    "> I like to call this autonomous coding without guardrails.",
    "",
    "In simple terms, autonomous coding agents need:",
    "",
    "- File access"
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        executor.prompts.push(prompt);

        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "autonomous coding",
                chineseHint: "自主编码",
                familyKey: "autonomous-coding"
              },
              {
                english: "autonomous coding agents",
                chineseHint: "自主编码代理",
                familyKey: "autonomous-coding"
              }
            ])
          );
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(false, [
                  "位置：引用段“我喜欢把这称为没有护栏的自主编码。”；问题：核心术语 autonomous coding 首次出现时缺少中英文对照；修复目标：在该处为“自主编码”补最小必要的英文锚定，并保持引用结构不变。",
                  "位置：“简要来说，自主编码代理需要的是：”；问题：核心术语 autonomous coding agents 在首次作为完整概念出现时未建立稳定中英对应；修复目标：在该句内为“自主编码代理”补足中英文对照，且不要把修复转移到后文列表或标题。"
                ])
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        const sourceSection = extractPromptSection(prompt, "【英文原文】");
        return createExecResult(sourceSection ?? "");
      }
    }),
    formatter: async (markdown) => markdown
  });

  const repairPrompt = executor.prompts.find(
    (item) =>
      item.includes("【must_fix】") &&
      item.includes("autonomous coding") &&
      item.includes("autonomous coding agents")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /同一概念家族的多个英文目标/);
  assert.match(repairPrompt, /必须把它们视为两个独立锚点分别修复/);
  assert.match(repairPrompt, /不要把其中一个锚点挪去充当另一个/);
});

test("translateMarkdownArticle repeats slash-qualified heading repair guidance when must_fix targets a heading", async () => {
  const source = [
    "# Title",
    "",
    "**Expected behavior (bubblewrap/Seatbelt):**",
    "",
    "Body paragraph.",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        executor.prompts.push(prompt);

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(false, [
                  "标题“Expected behavior (bubblewrap/Seatbelt)”中 bubblewrap/Seatbelt 首现缺少中文对照，需在标题内补齐对应说明。"
                ])
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        const sourceSection = extractPromptSection(prompt, "【英文原文】");
        return createExecResult(sourceSection ?? "");
      }
    }),
    formatter: async (markdown) => markdown
  });

  const repairPrompt = executor.prompts.find(
    (item) =>
      item.includes("【must_fix】") &&
      item.includes("标题“Expected behavior (bubblewrap/Seatbelt)”中 bubblewrap/Seatbelt 首现缺少中文对照")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /本次 must_fix 明确指向标题/);
  assert.match(repairPrompt, /如果标题里有用 \/ 连接的并列平台名/);
  assert.match(repairPrompt, /必须在标题本身完整保留这组并列结构/);
  assert.match(repairPrompt, /应在标题里为整组并列范围补自然的中文说明或锚定/);
  assert.match(repairPrompt, /优先保留整组英文原名，再在整组后面补一个整体中文说明词/);
});

test("translateMarkdownArticle treats bold platform labels as heading-like repair targets", async () => {
  const source = [
    "# Title",
    "",
    "**Seatbelt** — Works on most distributions",
    "",
    "- Ubuntu 20.04+",
    "- Fedora 32+",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        executor.prompts.push(prompt);

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(false, [
                  "第2段“Seatbelt（安全框架）”是首次出现的专名，需补成包含英文原名的中英对照首现锚定。"
                ])
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        const sourceSection = extractPromptSection(prompt, "【英文原文】");
        return createExecResult(sourceSection ?? "");
      }
    }),
    formatter: async (markdown) => markdown
  });

  const repairPrompt = executor.prompts.find(
    (item) =>
      item.includes("【must_fix】") &&
      item.includes("第2段“Seatbelt（安全框架）”是首次出现的专名")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /本次 must_fix 明确指向标题/);
  assert.match(repairPrompt, /必须直接修改以下标题文本本身：.*Seatbelt/);
  assert.match(repairPrompt, /如果标题里的目标是英文产品名、工具名、项目名、模型名、CLI 名称，或以英文表达的核心概念性标题术语/);
});

test("translateMarkdownArticle does not treat title-cased product anchors as matching generic lowercase source phrases", async () => {
  const source = [
    "# Title",
    "",
    "## How Sandbox Mode Changes Autonomous Coding",
    "",
    "Claude Code sandbox creates operating system-level restrictions.",
    ""
  ].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "Claude Code Sandbox",
                chineseHint: "Claude Code 沙盒",
                familyKey: "claude-code-sandbox",
                displayPolicy: "english-primary"
              },
              {
                english: "sandbox mode",
                chineseHint: "沙盒模式",
                familyKey: "sandbox-mode",
                displayPolicy: "chinese-primary"
              }
            ])
          );
        }

        if (options.outputSchema && prompt.includes("### BLOCK")) {
          const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
          return createExecResult(JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "占位正文") }));
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(
          ["# Title", "", "## 沙盒模式如何改变自主编码", "", "Claude Code sandbox 会创建操作系统级限制。", ""].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.doesNotMatch(result.markdown, /Claude Code Sandbox（Claude Code 沙盒）/);
});

test("translateMarkdownArticle keeps sandbox family terms coherent across a mixed paragraph and heading segment", async () => {
  const source = [
    "Claude Code sandbox creates operating system-level restrictions that define where Claude can work autonomously.",
    "",
    "Instead of asking permission for each individual action, you configure boundaries once:",
    "",
    "**Without Sandbox:**",
    ""
  ].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "sandbox mode",
                chineseHint: "沙盒模式",
                familyKey: "sandbox-mode",
                displayPolicy: "chinese-primary"
              },
              {
                english: "Claude Code Sandbox",
                chineseHint: "Claude Code 沙盒",
                familyKey: "claude-code-sandbox",
                displayPolicy: "english-primary"
              }
            ])
          );
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(false, [
                  "第 1 个段落中的“Claude Code Sandbox（Claude Code 沙盒） Code 的 sandbox”存在重复词和英文裸用，需修正为单一产品名加中文说明的合法表达。"
                ])
              }
            ])
          );
        }

        if (options.outputSchema && prompt.includes("### BLOCK")) {
          const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
          return createExecResult(JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "占位正文") }));
        }

        if (prompt.includes("【按块展开的英文原文】")) {
          const sourceBlocks = [...prompt.matchAll(/^### SOURCE BLOCK \d+ \([^)]+\)\n([\s\S]*?)(?=^### SOURCE BLOCK \d+ \(|\n\n【当前译文按块展开】|\Z)/gm)].map((match) => match[1]!.trimEnd());
          return createExecResult(JSON.stringify({ blocks: sourceBlocks.length > 0 ? sourceBlocks : ["占位正文"] }));
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(
          [
            "Claude Code Sandbox（Claude Code 沙盒） Code 的 sandbox 会创建操作系统级限制。",
            "",
            "在你为每个单独动作请求权限之前，你可以先配置边界：",
            "",
            "**无沙盒：**",
            ""
          ].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.doesNotMatch(result.markdown, /Claude Code Sandbox（Claude Code 沙盒） Code 的 sandbox/);
});

test("translateMarkdownArticle adds attribution guidance for caption-like segments", async () => {
  const source = [
    "# Title",
    "",
    "## Sandbox",
    "",
    "*Claude Code Sandbox Illustration / By Anthropic*",
    "",
    "Body paragraph.",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const prompt = executor.prompts.find(
    (item) => !isDocumentAnalysisPrompt(item) && item.includes("Claude Code Sandbox Illustration / By Anthropic")
  );
  assert.ok(prompt);
  assert.match(prompt, /【当前分段附加规则】/);
  assert.match(prompt, /图注、署名、来源、配图说明或出品归属类文本/);
  assert.match(prompt, /不要为了满足首现双语而强行创造中文主译/);
});

test("translateMarkdownArticle adds tool-name guidance for glossary-like list items", async () => {
  const source = [
    "# Title",
    "",
    "## Tools",
    "",
    "- kubectl - Kubernetes cluster access",
    "- docker - Container runtime access",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const prompt = executor.prompts.find(
    (item) => !isDocumentAnalysisPrompt(item) && item.includes("kubectl - Kubernetes cluster access")
  );
  assert.ok(prompt);
  assert.match(prompt, /【当前分段附加规则】/);
  assert.match(prompt, /工具名、命令名、包名、CLI 名称或产品名的列表项说明/);
  assert.match(prompt, /允许保留英文原名，并在后面直接接中文解释/);
});

test("translateMarkdownArticle includes established terms from prior chunks in later chunk prompts", async () => {
  const source = [
    "# Title",
    "",
    "## One",
    "",
    `${"Claude Code helps with coding. ".repeat(240)}`,
    "",
    "## Two",
    "",
    "Claude should not be treated as a first mention here.",
    ""
  ].join("\n");

  class PriorAnchorExecutor extends PromptAwareExecutor {
    override async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          JSON.stringify({
            anchors: [
              {
                english: "Claude Code",
                chineseHint: "Claude Code",
                familyKey: "claude code",
                firstOccurrence: {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1"
                }
              }
            ],
            ignoredTerms: []
          })
        );
      }
      return super.execute(prompt, options);
    }
  }

  const executor = new PriorAnchorExecutor();
  // Established-anchor flow only fires when chunk N-1 finishes audit before
  // chunk N's slice is built — which requires strictly serial chunk
  // processing. The default concurrency is 3 so we pin to 1 here.
  const previousConcurrency = process.env.MDZH_CHUNK_CONCURRENCY;
  process.env.MDZH_CHUNK_CONCURRENCY = "1";
  try {
    await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown
    });
  } finally {
    if (previousConcurrency === undefined) {
      delete process.env.MDZH_CHUNK_CONCURRENCY;
    } else {
      process.env.MDZH_CHUNK_CONCURRENCY = previousConcurrency;
    }
  }

  const secondChunkPrompt = executor.prompts.find(
    (prompt) => !isDocumentAnalysisPrompt(prompt) && prompt.includes("当前分块：第 2 /")
  );
  assert.ok(secondChunkPrompt);
  assert.match(secondChunkPrompt, /全文已建立的锚点摘要：/);
  assert.match(secondChunkPrompt, /Claude Code/);
  assert.match(secondChunkPrompt, /repeatAnchors 表示：/);
});

test("translateMarkdownArticle does not carry generic prior headings into established terms", async () => {
  const source = [
    "# Title",
    "",
    "## Launch Checklist",
    "",
    `${"Claude Code helps with coding. ".repeat(240)}`,
    "",
    "## Final Notes",
    "",
    "Claude Code should keep its earlier bilingual anchor here.",
    ""
  ].join("\n");

  class PriorAnchorExecutor extends PromptAwareExecutor {
    override async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          JSON.stringify({
            anchors: [
              {
                english: "Claude Code",
                chineseHint: "Claude Code",
                familyKey: "claude code",
                firstOccurrence: {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1"
                }
              }
            ],
            ignoredTerms: []
          })
        );
      }
      return super.execute(prompt, options);
    }
  }

  const executor = new PriorAnchorExecutor();
  // Pin to serial: established-anchor propagation across chunks needs the
  // prior chunk to finish before the next slice is built.
  const previousConcurrency = process.env.MDZH_CHUNK_CONCURRENCY;
  process.env.MDZH_CHUNK_CONCURRENCY = "1";
  try {
    await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown
    });
  } finally {
    if (previousConcurrency === undefined) {
      delete process.env.MDZH_CHUNK_CONCURRENCY;
    } else {
      process.env.MDZH_CHUNK_CONCURRENCY = previousConcurrency;
    }
  }

  const secondChunkPrompt = executor.prompts.find(
    (prompt) => !isDocumentAnalysisPrompt(prompt) && prompt.includes("当前分块：第 2 /")
  );
  assert.ok(secondChunkPrompt);
  const establishedTermsLine = secondChunkPrompt.match(/全文已建立的锚点摘要：([^\n]+)/);
  assert.ok(establishedTermsLine);
  assert.match(establishedTermsLine[1] ?? "", /Claude Code/);
  assert.doesNotMatch(establishedTermsLine[1] ?? "", /Launch Checklist/);
});

test("translateMarkdownArticle adds structure guidance for translatable emphasis and command flags", async () => {
  const source = [
    "# Title",
    "",
    "Claude Code **now has a sandbox mode** that changes the workflow.",
    "",
    "> If you use the --dangerously-skip-permissions flag, you remove safety guardrails.",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const prompt = executor.prompts.find(
    (item) =>
      !isDocumentAnalysisPrompt(item) &&
      (item.includes("**now has a sandbox mode**") || item.includes("--dangerously-skip-permissions"))
  );
  assert.ok(prompt);
  assert.match(prompt, /【当前分段附加规则】/);
  assert.match(prompt, /当前分段包含可翻译的 Markdown 强调结构或命令\/flag 写法/);
  assert.match(prompt, /--dangerously-skip-permissions/);
});

test("translateMarkdownArticle fails when the hard-pass translation already broke a protected span", async () => {
  const source = [
    "# Docs",
    "",
    "Read [the docs](https://example.com/docs).",
    "",
    "Keep going.",
    ""
  ].join("\n");

  const { protectedBody } = protectMarkdownSpans(source);
  const passingAudit = JSON.stringify(createAudit(true));
  const brokenDraft = "Read the docs.\n\nKeep going.\n";
  const executor = new StubExecutor([brokenDraft, passingAudit]);

  await assert.rejects(
    () =>
      translateMarkdownArticle(source, {
        executor,
        formatter: async (markdown) => markdown
      }),
    (error: unknown) => {
      assert.ok(error instanceof HardGateError);
      assert.match(error.message, /Protected span integrity failed/);
      return true;
    }
  );
});

test("parseGateAudit requires structural hard checks", () => {
  const invalid = JSON.stringify({
    hard_checks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: true, problem: "" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" }
    },
    must_fix: []
  });

  assert.throws(() => parseGateAudit(invalid), /protected_span_integrity/);
});

test("translateMarkdownArticle injects structured anchor state into draft prompts", async () => {
  const source = "Prompt injection attacks can be blocked.\n";
  const prompts: string[] = [];

  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      prompts.push(prompt);

      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          JSON.stringify({
            anchors: [
              {
                english: "Prompt injection attacks",
                chineseHint: "提示注入攻击",
                familyKey: "prompt injection attacks",
                firstOccurrence: {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1"
                }
              }
            ],
            ignoredTerms: []
          })
        );
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }

      const currentSource = extractPromptSection(prompt, "【英文原文】");
      return createExecResult(currentSource ?? "");
    }
  });

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const draftPrompt = prompts.find((prompt) => prompt.includes("当前分段必须建立的首现锚点"));
  assert.ok(draftPrompt);
  assert.match(draftPrompt, /提示注入攻击（Prompt injection attacks）/);
  assert.match(draftPrompt, /【当前分段 IR】/);
  assert.match(draftPrompt, /<PLAN id="anchor:anchor-1" kind="anchor"/);
  assert.doesNotMatch(draftPrompt, /【状态切片\(JSON\)】/);
});

test("translateMarkdownArticle injects required anchors into list items before hard gate", async () => {
  const source = "- API tokens\n";
  let auditedTranslation = "";

  const executor: CodexExecutor = {
    async execute(prompt, options) {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          createAnchorCatalog([
            {
              english: "API tokens",
              chineseHint: "API 令牌",
              familyKey: "api tokens"
            }
          ])
        );
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        auditedTranslation = extractPromptSection(prompt, "【当前译文】") ?? "";
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }

      return createExecResult("- API 令牌");
    }
  };

  const output = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.match(auditedTranslation, /- API 令牌（API tokens）/);
  assert.match(output.markdown, /- API 令牌（API tokens）/);
});

test("translateMarkdownArticle restores a required anchor inside a longer list item after explicit repair", async () => {
  const source = "- Environment variables containing secrets\n";
  let auditCount = 0;

  const executor: CodexExecutor = {
    async execute(prompt, options) {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          createAnchorCatalog([
            {
              english: "Environment variables",
              chineseHint: "环境变量",
              familyKey: "environment variables"
            }
          ])
        );
      }

      if (options.outputSchema && prompt.includes("【分段审校输入】")) {
        auditCount += 1;
        if (auditCount === 1) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(false, [
                  "位置：第一段列表“包含秘密信息的环境变量”：Environment variables 首次出现需补中英文对照，不能只写中文。"
                ])
              }
            ])
          );
        }

        return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(JSON.stringify(createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }

      return createExecResult("- 包含秘密信息的环境变量");
    }
  };

  const output = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.match(output.markdown, /- 包含秘密信息的环境变量（Environment variables）/);
});

test("translateMarkdownArticle exports debug state when MDZH_DEBUG_STATE_PATH is set", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "mdzh-state-"));
  const debugPath = path.join(tempDir, "state.json");
  const previous = process.env.MDZH_DEBUG_STATE_PATH;
  process.env.MDZH_DEBUG_STATE_PATH = debugPath;

  try {
    await translateMarkdownArticle("# Title\n\nBody", {
      executor: new PromptAwareExecutor(),
      formatter: async (markdown) => markdown,
      sourcePathHint: "debug.md"
    });

    const exported = JSON.parse(await readFile(debugPath, "utf8")) as Record<string, unknown>;
    assert.equal(exported.version, 1);
    assert.equal((exported.document as Record<string, unknown>).sourcePathHint, "debug.md");
    assert.ok(Array.isArray(exported.chunks));
    assert.ok(Array.isArray(exported.segments));
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_DEBUG_STATE_PATH;
    } else {
      process.env.MDZH_DEBUG_STATE_PATH = previous;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("translateMarkdownArticle exports analysis IR sidecar when MDZH_DEBUG_IR_PATH is set", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "mdzh-ir-"));
  const irPath = path.join(tempDir, "analysis.ir");
  const previous = process.env.MDZH_DEBUG_IR_PATH;
  process.env.MDZH_DEBUG_IR_PATH = irPath;

  try {
    await translateMarkdownArticle("## Permission Problem\n\n**now has a sandbox mode**", {
      executor: new PromptAwareExecutor(),
      formatter: async (markdown) => markdown,
      sourcePathHint: "ir.md"
    });

    const exported = await readFile(irPath, "utf8");
    assert.match(exported, /<DOCUMENT title=".*">/);
    assert.match(exported, /<SEGMENT id="chunk-1-segment-1">/);
    assert.match(exported, /kind="anchor"/);
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_DEBUG_IR_PATH;
    } else {
      process.env.MDZH_DEBUG_IR_PATH = previous;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("translateMarkdownArticle reuses a persisted analysis cache on repeated runs", async () => {
  const source = "Plain body.\n";
  const tempDir = await mkdtemp(path.join(tmpdir(), "mdzh-analysis-cache-"));
  const cacheDir = path.join(tempDir, "cache");
  const progressMessages: string[] = [];

  class AnalysisCountingExecutor extends PromptAwareExecutor {
    analysisCalls = 0;

    override async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        this.analysisCalls += 1;
      }
      if (options.outputSchema && prompt.includes("### BLOCK 1")) {
        return createExecResult(
          JSON.stringify({
            blocks: ["Plain body."]
          })
        );
      }
      return super.execute(prompt, options);
    }
  }

  const firstExecutor = new AnalysisCountingExecutor();
  const secondExecutor = new AnalysisCountingExecutor();

  try {
    await translateMarkdownArticle(source, {
      executor: firstExecutor,
      formatter: async (markdown) => markdown,
      sourcePathHint: "cache.md",
      analysisCacheDir: cacheDir,
      onProgress: (message) => {
        progressMessages.push(message);
      }
    });

    assert.ok(firstExecutor.analysisCalls >= 1);

    await translateMarkdownArticle(source, {
      executor: secondExecutor,
      formatter: async (markdown) => markdown,
      sourcePathHint: "cache.md",
      analysisCacheDir: cacheDir,
      onProgress: (message) => {
        progressMessages.push(message);
      }
    });

    assert.equal(secondExecutor.analysisCalls, 0);
    assert.match(progressMessages.join("\n"), /Reused cached analysis catalog/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("translateMarkdownArticle resumes completed chunks from a persisted checkpoint", async () => {
  const source = ["## One", "", "Body one.", "", "## Two", "", "Body two.", ""].join("\n");
  const tempDir = await mkdtemp(path.join(tmpdir(), "mdzh-checkpoint-"));
  const checkpointDir = path.join(tempDir, "checkpoint");
  const progressMessages: string[] = [];

  class CheckpointExecutor implements CodexExecutor {
    analysisCalls = 0;
    contentCalls = 0;

    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        this.analysisCalls += 1;
        return createExecResult(createEmptyAnchorCatalog());
      }

      if (options.outputSchema && prompt.includes("### BLOCK 1")) {
        this.contentCalls += 1;
        const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length;
        return createExecResult(
          JSON.stringify({
            blocks: Array.from({ length: Math.max(1, blockCount) }, (_, index) => `块 ${index + 1}`)
          })
        );
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        this.contentCalls += 1;
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        this.contentCalls += 1;
        return createExecResult(currentTranslation);
      }

      const sourceSection = extractPromptSection(prompt, "【英文原文】");
      this.contentCalls += 1;
      return createExecResult(sourceSection ?? "");
    }
  }

  const firstExecutor = new CheckpointExecutor();
  const secondExecutor = new CheckpointExecutor();

  try {
    await translateMarkdownArticle(source, {
      executor: firstExecutor,
      formatter: async (markdown) => markdown,
      sourcePathHint: "checkpoint.md",
      checkpointDir,
      disableAnalysisCache: true,
      onProgress: (message) => {
        progressMessages.push(message);
      }
    });

    assert.ok(firstExecutor.contentCalls > 0);

    await translateMarkdownArticle(source, {
      executor: secondExecutor,
      formatter: async (markdown) => markdown,
      sourcePathHint: "checkpoint.md",
      checkpointDir,
      disableAnalysisCache: true,
      onProgress: (message) => {
        progressMessages.push(message);
      }
    });

    assert.ok(secondExecutor.analysisCalls >= 1);
    assert.equal(secondExecutor.contentCalls, 0);
    assert.match(progressMessages.join("\n"), /Resumed translation checkpoint with 1 completed chunk\(s\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("translateMarkdownArticle strips hook prompt control-text contamination before audit", async () => {
  const source = "Plain body.\n";
  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (options.outputSchema && prompt.includes("### BLOCK 1")) {
        return createExecResult(JSON.stringify({ blocks: ["Plain body.\n<hook_prompt hook_run_id=\"x\">OMX Ralph is still active</hook_prompt>"] }));
      }
      if (prompt.includes("前一轮结构化 blocks 输出")) {
        return createExecResult("Plain body.\n");
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }
      return createExecResult("Plain body.\n<hook_prompt hook_run_id=\"x\">OMX Ralph is still active</hook_prompt>");
    }
  };

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /Plain body\./);
  assert.doesNotMatch(result.markdown, /hook_prompt|OMX Ralph|hook_run_id/);
});

test("translateMarkdownArticle retries with text rescue when a JSON block draft returns empty content", async () => {
  const source = "The `--dangerously-skip-permissions` flag exists as an escape hatch from this fatigue.\n";
  let jsonDraftCalls = 0;

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (options.outputSchema && prompt.includes("### BLOCK 1")) {
        jsonDraftCalls += 1;
        return createExecResult(JSON.stringify({ blocks: [""] }));
      }
      if (prompt.includes("前一轮结构化 blocks 输出")) {
        return createExecResult("`--dangerously-skip-permissions` 标志的存在，是为了从这种疲劳中脱身。\n");
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }
      return createExecResult("`--dangerously-skip-permissions` 标志的存在，是为了从这种疲劳中脱身。\n");
    }
  };

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.equal(jsonDraftCalls, 2);
  assert.match(result.markdown, /--dangerously-skip-permissions/);
});

test("translateMarkdownArticle retries a failed JSON block draft with a stricter JSON block prompt before text rescue", async () => {
  const source = "The `--dangerously-skip-permissions` flag exists as an escape hatch from this fatigue.\n";
  let jsonDraftCalls = 0;

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (options.outputSchema && prompt.includes("### BLOCK 1")) {
        jsonDraftCalls += 1;
        if (jsonDraftCalls === 1) {
          return createExecResult(JSON.stringify({ blocks: [""] }));
        }
        return createExecResult(
          JSON.stringify({
            blocks: ["`--dangerously-skip-permissions` 标志的存在，是为了从这种疲劳中脱身。"]
          })
        );
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      throw new Error("Text rescue should not be reached when strict JSON block retry succeeds.");
    }
  };

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.equal(jsonDraftCalls, 2);
  assert.match(result.markdown, /--dangerously-skip-permissions/);
});

test("translateMarkdownArticle fails fast when analysis quality collapses below the heading-plan threshold", async () => {
  const source = [
    "# Title",
    "",
    "## One",
    "",
    "**Alpha**",
    "",
    "## Two",
    "",
    "**Beta**",
    "",
    "## Three",
    "",
    "**Gamma**",
    "",
    "## Four",
    "",
    "**Delta**",
    ""
  ].join("\n");

  const progress: string[] = [];
  let nonAnalysisCalls = 0;

  await assert.rejects(
    () =>
      translateMarkdownArticle(source, {
        executor: {
          async execute(prompt: string, options: CodexExecOptions) {
            if (isDocumentAnalysisPrompt(prompt)) {
              return createExecResult(createEmptyAnchorCatalog());
            }

            nonAnalysisCalls += 1;
            if (options.outputSchema && prompt.includes("### BLOCK")) {
              const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
              return createExecResult(JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "中文占位译文") }));
            }
            if (options.outputSchema || prompt.includes("只返回 JSON")) {
              return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
            }

            return createExecResult(extractPromptSection(prompt, "【当前译文】") ?? "中文占位译文");
          }
        },
        formatter: async (markdown: string) => markdown,
        onProgress: (message: string) => progress.push(message)
      }),
    (error: unknown) =>
      error instanceof HardGateError &&
      /Analysis quality gate failed: heading plan coverage 0\/\d+/.test(error.message)
  );

  assert.equal(nonAnalysisCalls, 0);
  assert.ok(progress.some((message) => /Analysis quality gate failed: heading plan coverage 0\/\d+/.test(message)));
});

test("translateMarkdownArticle fails after two repair cycles when the gate never passes", async () => {
  const source = "# Title\n\nBody\n";
  await assert.rejects(
    () => translateMarkdownArticle(source, {
      executor: createP2CompatibleExecutor({
        async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
          if (isDocumentAnalysisPrompt(prompt)) return createExecResult(createEmptyAnchorCatalog());
          if (options.outputSchema || prompt.includes("只返回 JSON"))
            return createExecResult(wrapAuditForSegments(prompt, createAudit(false, ["正文首现术语缺少中英对照"])));
          const current = extractPromptSection(prompt, "【当前译文】");
          return createExecResult(current ?? "中文占位译文");
        }
      }),
      formatter: async (markdown) => markdown,
      softGate: false
    }),
    (error: unknown) => {
      assert.ok(error instanceof HardGateError);
      assert.match(error.message, /failed after 2 repair cycle/);
      return true;
    }
  );
});

test("translateMarkdownArticle under soft-gate treats first_mention_bilingual-only failures as a clean pass (#80)", async () => {
  const source = "# Title\n\nBody\n";
  const progress: string[] = [];
  // #80: when only first_mention_bilingual fails (audit flags a judgment-call
  // anchor miss but every structural/punctuation/unit check passes), the new
  // contract is to treat this as a hard pass — no repair loop, no soft-gate
  // fallback banner, no "Output is degraded" warning.
  const semanticFailingAudit = createAudit(false, ["正文首现术语缺少中英对照"], {
    paragraph_match: { pass: true, problem: "" },
    first_mention_bilingual: { pass: false, problem: "missing bilingual term" },
    numbers_units_logic: { pass: true, problem: "" },
    chinese_punctuation: { pass: true, problem: "" },
    unit_conversion_boundary: { pass: true, problem: "" },
    protected_span_integrity: { pass: true, problem: "" },
    embedded_template_integrity: { pass: true, problem: "" }
  });

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
        if (isDocumentAnalysisPrompt(prompt)) return createExecResult(createEmptyAnchorCatalog());
        if (options.outputSchema || prompt.includes("只返回 JSON"))
          return createExecResult(wrapAuditForSegments(prompt, semanticFailingAudit));
        const current = extractPromptSection(prompt, "【当前译文】");
        return createExecResult(current ?? "中文占位译文");
      }
    }),
    formatter: async (markdown) => markdown,
    softGate: true,
    onProgress: (message) => progress.push(message)
  });

  assert.ok(result.markdown.length > 0, "should emit a translated body");
  assert.ok(
    !progress.some((message) => /soft-gate enabled \(semantic failures only\)/.test(message)),
    "no per-chunk soft-gate log line should fire when only first_mention_bilingual fails"
  );
  assert.ok(
    !progress.some((message) => /Soft-gate fallback applied to \d+ chunk/.test(message)),
    "no aggregate degraded-output banner should fire under #80 contract"
  );
  assert.ok(
    !progress.some((message) => /failed after \d+ repair cycle/.test(message)),
    "first_mention_bilingual-only failures should not enter the repair loop"
  );
});

test("translateMarkdownArticle under soft-gate still throws HardGateError when a structural hard-check fails", async () => {
  const source = "# Title\n\nBody\n";
  const structuralFailingAudit = createAudit(false, ["段落数对不上"], {
    paragraph_match: { pass: false, problem: "source has 2 paragraphs, draft has 3" },
    first_mention_bilingual: { pass: true, problem: "" },
    numbers_units_logic: { pass: true, problem: "" },
    chinese_punctuation: { pass: true, problem: "" },
    unit_conversion_boundary: { pass: true, problem: "" },
    protected_span_integrity: { pass: true, problem: "" },
    embedded_template_integrity: { pass: true, problem: "" }
  });

  await assert.rejects(
    () => translateMarkdownArticle(source, {
      executor: createP2CompatibleExecutor({
        async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
          if (isDocumentAnalysisPrompt(prompt)) return createExecResult(createEmptyAnchorCatalog());
          if (options.outputSchema || prompt.includes("只返回 JSON"))
            return createExecResult(wrapAuditForSegments(prompt, structuralFailingAudit));
          const current = extractPromptSection(prompt, "【当前译文】");
          return createExecResult(current ?? "中文占位译文");
        }
      }),
      formatter: async (markdown) => markdown,
      softGate: true
    }),
    (error: unknown) => {
      assert.ok(error instanceof HardGateError);
      assert.match(error.message, /failed after 2 repair cycle/);
      return true;
    }
  );
});

test("translateMarkdownArticle emits telemetry around run, chunks, stages and gate results", async () => {
  const source = ["# Hello", "", "World."].join("\n");
  const sink = createMemoryTelemetrySink();

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return {
          ...createExecResult(createEmptyAnchorCatalog()),
          usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, totalTokens: 120 }
        };
      }
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return {
          ...createExecResult(JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "你好世界") })),
          usage: { inputTokens: 80, cachedInputTokens: 30, outputTokens: 12, totalTokens: 92 }
        };
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return {
          ...createExecResult(wrapAuditForSegments(prompt, createAudit(true))),
          usage: { inputTokens: 60, cachedInputTokens: 20, outputTokens: 30, totalTokens: 90 }
        };
      }
      const current = extractPromptSection(prompt, "【当前译文】");
      if (current !== null) {
        return createExecResult(current);
      }
      return createExecResult("你好世界");
    }
  };

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    telemetry: sink
  });

  const events = [...sink.events];
  const types = events.map((event) => event.type);

  assert.equal(types[0], "run.start");
  assert.equal(types[types.length - 1], "run.end");
  assert.ok(types.includes("chunk.start"), "expected chunk.start");
  assert.ok(types.includes("chunk.end"), "expected chunk.end");
  assert.ok(types.includes("stage.start"), "expected stage.start");
  assert.ok(types.includes("stage.end"), "expected stage.end");
  assert.ok(types.includes("gate.result"), "expected gate.result");

  const runStart = events.find((event) => event.type === "run.start") as TelemetryEvent;
  const runEnd = events.find((event) => event.type === "run.end") as TelemetryEvent;
  assert.equal(runStart.runId, runEnd.runId);
  assert.match(runStart.runId, /^run_/);

  const stageEnds = events.filter((event) => event.type === "stage.end");
  assert.ok(stageEnds.length >= 1);
  for (const event of stageEnds) {
    assert.equal(typeof event.durationMs, "number");
    assert.equal(typeof event.inputTokens, "number");
    assert.equal(typeof event.outputTokens, "number");
  }

  const gateResults = events.filter((event) => event.type === "gate.result");
  assert.ok(gateResults.length >= 1);
  assert.equal((gateResults[0]!.meta as Record<string, unknown>).hardPass, true);
});

test("translateMarkdownArticle emits stage.error when an LLM stage fails", async () => {
  const source = ["# Hello", "", "World."].join("\n");
  const sink = createMemoryTelemetrySink();

  const executor: CodexExecutor = {
    async execute(prompt: string): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      throw new CodexExecutionError("draft synthetic failure");
    }
  };

  await assert.rejects(
    () =>
      translateMarkdownArticle(source, {
        executor,
        formatter: async (markdown) => markdown,
        telemetry: sink
      })
  );

  const stageErrors = [...sink.events].filter((event) => event.type === "stage.error");
  assert.ok(stageErrors.length >= 1, "expected at least one stage.error event");
  for (const event of stageErrors) {
    assert.equal(event.error, "draft synthetic failure");
    assert.equal(typeof event.durationMs, "number");
  }

  const runEnd = [...sink.events].find((event) => event.type === "run.end");
  assert.ok(runEnd, "expected run.end emitted on failure");
  assert.equal((runEnd!.meta as Record<string, unknown>).failed, true);
});

test("repair patch lane short-circuits the LLM when structured targets fully cover the must_fix batch", async () => {
  // Use a source that will NOT match any formal known_entities so the
  // upstream `injectPlannedAnchorText` doesn't auto-apply the canonical form
  // before the patch lane gets a chance.
  const source = "- foobar widget\n";
  const sink = createMemoryTelemetrySink();

  let repairCalls = 0;
  let auditPasses = 0;

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }

      if (isBundledAuditPrompt(prompt, options) || prompt.includes("只返回 JSON") && prompt.includes("hard_checks")) {
        if (auditPasses === 0) {
          auditPasses += 1;
          const failingAudit: GateAudit = {
            hard_checks: {
              paragraph_match: { pass: true, problem: "" },
              first_mention_bilingual: { pass: true, problem: "" },
              numbers_units_logic: { pass: false, problem: "需补 foobar 小工具的双语锚定。" },
              chinese_punctuation: { pass: true, problem: "" },
              unit_conversion_boundary: { pass: true, problem: "" },
              protected_span_integrity: { pass: true, problem: "" },
              embedded_template_integrity: { pass: true, problem: "" }
            },
            must_fix: ["第 1 个项目符号需补 foobar 小工具（foobar widget）首现双语。"],
            repair_targets: [
              {
                location: "第 1 个项目符号",
                kind: "list_item",
                currentText: "foobar 小工具",
                targetText: "foobar 小工具（foobar widget）",
                english: "foobar widget",
                chineseHint: "foobar 小工具"
              }
            ]
          };
          return createExecResult(wrapAuditForSegments(prompt, failingAudit));
        }
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "- foobar 小工具") }));
      }

      if (prompt.includes("【must_fix】")) {
        repairCalls += 1;
        return createExecResult("- foobar 小工具（foobar widget）。\n");
      }

      const current = extractPromptSection(prompt, "【当前译文】");
      if (current !== null) {
        return createExecResult(current);
      }

      return createExecResult("- foobar 小工具\n");
    }
  };

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    softGate: true,
    telemetry: sink
  });

  const patchEvents = [...sink.events].filter((event) => event.type === "repair.patch");
  assert.ok(patchEvents.length >= 1, "expected at least one repair.patch event");
  const appliedTotal = patchEvents.reduce(
    (sum, event) => sum + Number((event.meta as Record<string, unknown>).applied ?? 0),
    0
  );
  assert.ok(appliedTotal >= 1, `expected at least one structured patch to apply, got ${appliedTotal}`);
  assert.equal(repairCalls, 0, "patch lane should have skipped the LLM repair call");
});

test("repair patch lane falls through to the LLM when MDZH_REPAIR_PATCH_LANE=false", async () => {
  const source = "- foobar widget\n";

  let repairCalls = 0;
  let auditPasses = 0;

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || prompt.includes("只返回 JSON") && prompt.includes("hard_checks")) {
        if (auditPasses === 0) {
          auditPasses += 1;
          const failingAudit: GateAudit = {
            hard_checks: {
              paragraph_match: { pass: true, problem: "" },
              first_mention_bilingual: { pass: true, problem: "" },
              numbers_units_logic: { pass: false, problem: "需补 foobar 小工具双语。" },
              chinese_punctuation: { pass: true, problem: "" },
              unit_conversion_boundary: { pass: true, problem: "" },
              protected_span_integrity: { pass: true, problem: "" },
              embedded_template_integrity: { pass: true, problem: "" }
            },
            must_fix: ["第 1 个项目符号需补首现双语。"],
            repair_targets: [
              {
                location: "第 1 个项目符号",
                kind: "list_item",
                currentText: "foobar 小工具",
                targetText: "foobar 小工具（foobar widget）",
                english: "foobar widget",
                chineseHint: "foobar 小工具"
              }
            ]
          };
          return createExecResult(wrapAuditForSegments(prompt, failingAudit));
        }
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "- foobar 小工具") }));
      }
      if (prompt.includes("【must_fix】")) {
        repairCalls += 1;
        return createExecResult("- foobar 小工具（foobar widget）。\n");
      }
      const current = extractPromptSection(prompt, "【当前译文】");
      if (current !== null) {
        return createExecResult(current);
      }
      return createExecResult("- foobar 小工具\n");
    }
  };

  const previous = process.env.MDZH_REPAIR_PATCH_LANE;
  process.env.MDZH_REPAIR_PATCH_LANE = "false";
  try {
    await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown,
      softGate: true
    });
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_REPAIR_PATCH_LANE;
    } else {
      process.env.MDZH_REPAIR_PATCH_LANE = previous;
    }
  }

  assert.equal(repairCalls, 1, "with patch lane disabled, repair LLM must be called once");
});

test("MDZH_CHUNK_CONCURRENCY=2 preserves chunk order in the final document", async () => {
  const source = [
    "## Alpha",
    "",
    "Alpha body line.",
    "",
    "## Bravo",
    "",
    "Bravo body line.",
    "",
    "## Charlie",
    "",
    "Charlie body line.",
    ""
  ].join("\n");

  const draftLatencyByMarker: Record<string, number> = {
    Alpha: 80,
    Bravo: 0,
    Charlie: 40
  };

  const sink = createMemoryTelemetrySink();
  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      const sourceSection = extractPromptSection(prompt, "【英文原文】") ?? "";
      const marker =
        sourceSection.includes("Alpha") ? "Alpha"
        : sourceSection.includes("Bravo") ? "Bravo"
        : sourceSection.includes("Charlie") ? "Charlie"
        : null;
      if (marker) {
        const wait = draftLatencyByMarker[marker] ?? 0;
        await new Promise((resolve) => setTimeout(resolve, wait));
        // Echo the source heading verbatim so the draft contract is satisfied;
        // only translate the body line and inject the marker token so the test
        // can detect chunk order in the final document.
        const translated = sourceSection
          .replace(`## ${marker}`, `## ${marker}`)
          .replace(`${marker} body line.`, `译文 ${marker} 正文。`);
        return createExecResult(translated);
      }
      return createExecResult(sourceSection);
    }
  };

  const previous = process.env.MDZH_CHUNK_CONCURRENCY;
  process.env.MDZH_CHUNK_CONCURRENCY = "2";
  let result;
  try {
    result = await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown,
      telemetry: sink
    });
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_CHUNK_CONCURRENCY;
    } else {
      process.env.MDZH_CHUNK_CONCURRENCY = previous;
    }
  }

  const alphaIdx = result.markdown.indexOf("译文 Alpha");
  const bravoIdx = result.markdown.indexOf("译文 Bravo");
  const charlieIdx = result.markdown.indexOf("译文 Charlie");
  assert.ok(alphaIdx >= 0 && bravoIdx >= 0 && charlieIdx >= 0, "all chunks should appear");
  assert.ok(alphaIdx < bravoIdx, "Alpha must come before Bravo");
  assert.ok(bravoIdx < charlieIdx, "Bravo must come before Charlie");

  const concurrencyEvent = [...sink.events].find((event) => event.type === "chunk.concurrency");
  assert.ok(concurrencyEvent, "expected chunk.concurrency event");
  assert.equal((concurrencyEvent!.meta as Record<string, unknown>).concurrency, 2);
});

test("MDZH_CHUNK_CONCURRENCY=1 forces strict serial — chunk N+1 starts only after chunk N ends", async () => {
  const source = ["## A", "", "Body A.", "", "## B", "", "Body B.", ""].join("\n");

  const startTimestamps: Array<{ chunkId: string; ts: number }> = [];
  const endTimestamps: Array<{ chunkId: string; ts: number }> = [];

  const memory = createMemoryTelemetrySink();
  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      const sourceSection = extractPromptSection(prompt, "【英文原文】") ?? "";
      return createExecResult(sourceSection);
    }
  };

  const previous = process.env.MDZH_CHUNK_CONCURRENCY;
  process.env.MDZH_CHUNK_CONCURRENCY = "1";
  try {
    await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown,
      telemetry: {
        emit(event) {
          memory.emit(event);
          if (event.type === "chunk.start" && event.chunkId) {
            startTimestamps.push({ chunkId: event.chunkId, ts: event.ts });
          } else if (event.type === "chunk.end" && event.chunkId) {
            endTimestamps.push({ chunkId: event.chunkId, ts: event.ts });
          }
        },
        async close() {
          await memory.close();
        }
      }
    });
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_CHUNK_CONCURRENCY;
    } else {
      process.env.MDZH_CHUNK_CONCURRENCY = previous;
    }
  }

  for (let index = 1; index < startTimestamps.length; index += 1) {
    const previousEnd = endTimestamps[index - 1]?.ts;
    const currentStart = startTimestamps[index]?.ts;
    assert.ok(
      typeof previousEnd === "number" && typeof currentStart === "number",
      "chunk start/end events must carry timestamps"
    );
    assert.ok(
      currentStart! >= previousEnd!,
      `chunk ${startTimestamps[index]!.chunkId} started before previous chunk ended — concurrency leakage`
    );
  }

  const concurrencyEvent = [...memory.events].find((event) => event.type === "chunk.concurrency");
  assert.ok(concurrencyEvent, "expected chunk.concurrency event");
  assert.equal((concurrencyEvent!.meta as Record<string, unknown>).concurrency, 1);
});

test("default concurrency is 3 when MDZH_CHUNK_CONCURRENCY is unset", async () => {
  const source = ["## A", "", "Body A.", "", "## B", "", "Body B.", ""].join("\n");

  const memory = createMemoryTelemetrySink();
  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      const sourceSection = extractPromptSection(prompt, "【英文原文】") ?? "";
      return createExecResult(sourceSection);
    }
  };

  const previous = process.env.MDZH_CHUNK_CONCURRENCY;
  delete process.env.MDZH_CHUNK_CONCURRENCY;
  try {
    await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown,
      telemetry: memory
    });
  } finally {
    if (previous !== undefined) {
      process.env.MDZH_CHUNK_CONCURRENCY = previous;
    }
  }

  const concurrencyEvent = [...memory.events].find((event) => event.type === "chunk.concurrency");
  assert.ok(concurrencyEvent, "expected chunk.concurrency event");
  assert.equal((concurrencyEvent!.meta as Record<string, unknown>).concurrency, 3);
});

test("Translation Memory hit short-circuits the draft LLM call and reuses the cached target", async () => {
  const source = "## Hello\n\nWorld.\n";
  const sink = createMemoryTelemetrySink();

  let draftCalls = 0;
  const cachedTarget = "## 你好\n\n世界。\n";

  // Pre-seed the TM with the cached target, fingerprinted from the segment
  // source the pipeline will produce. We don't know the exact protected-span
  // splits up-front, so this is the simplest cross-check: the only segment
  // here has no spans, so segment.source === source body of the chunk minus
  // separators. Use a snapshot fingerprint based on the full source minus
  // the trailing newline.
  const tm = createMemoryTmStore();

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      // Any draft / json-blocks call should never fire on a TM hit.
      draftCalls += 1;
      const sourceSection = extractPromptSection(prompt, "【英文原文】") ?? "";
      return createExecResult(sourceSection);
    }
  };

  // First run: TM is cold. The pipeline drafts via the executor and writes a
  // hard-passed entry into the TM.
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    telemetry: sink,
    tmStore: tm
  });
  assert.ok(draftCalls > 0, "first run should still call the draft LLM");
  const writtenAfterFirstRun = tm.entries.length;
  assert.ok(writtenAfterFirstRun > 0, "first run should populate at least one TM entry");

  // Second run: with TM warmed, every segment's draft LLM call should be
  // skipped — only audit (and any other non-draft stages) should fire.
  draftCalls = 0;
  const sink2 = createMemoryTelemetrySink();
  void cachedTarget;
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    telemetry: sink2,
    tmStore: tm
  });

  assert.equal(draftCalls, 0, "with a warm TM, no draft LLM calls should fire");
  const hits = [...sink2.events].filter((event) => event.type === "tm.hit");
  assert.ok(hits.length >= 1, "second run should emit at least one tm.hit event");
});

test("Translation Memory writes only when the chunk hard-passes", async () => {
  const source = "## Hello\n\nWorld.\n";
  const tm = createMemoryTmStore();
  const sink = createMemoryTelemetrySink();

  // Force a hard-gate failure: the audit reports failure repeatedly, the run
  // exhausts MAX_REPAIR_CYCLES and (with softGate=false) throws HardGateError.
  // We expect the TM to remain empty because no chunk actually passed.
  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        const failingAudit: GateAudit = {
          ...createAudit(false, ["第 1 段需补 first 锚定。"], {
            first_mention_bilingual: { pass: false, problem: "缺首现双语。" },
            chinese_punctuation: { pass: false, problem: "标点缺失。" }
          })
        };
        return createExecResult(wrapAuditForSegments(prompt, failingAudit));
      }
      const current = extractPromptSection(prompt, "【当前译文】");
      if (current !== null) {
        return createExecResult(current);
      }
      const sourceSection = extractPromptSection(prompt, "【英文原文】") ?? "";
      return createExecResult(sourceSection);
    }
  };

  await assert.rejects(
    () =>
      translateMarkdownArticle(source, {
        executor,
        formatter: async (markdown) => markdown,
        softGate: false,
        telemetry: sink,
        tmStore: tm
      })
  );

  assert.equal(tm.entries.length, 0, "no TM entries should be written when no chunk hard-passes");
  const writes = [...sink.events].filter((event) => event.type === "tm.write");
  assert.equal(writes.length, 0, "no tm.write events should fire when no chunk hard-passes");
});

test("Translation Memory miss event fires when no entry exists for the segment", async () => {
  const source = "## Hello\n\nWorld.\n";
  const tm = createMemoryTmStore();
  const sink = createMemoryTelemetrySink();

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      const sourceSection = extractPromptSection(prompt, "【英文原文】") ?? "";
      return createExecResult(sourceSection);
    }
  };

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    telemetry: sink,
    tmStore: tm
  });

  const misses = [...sink.events].filter((event) => event.type === "tm.miss");
  assert.ok(misses.length >= 1, "first run with cold TM should emit at least one tm.miss event");
  void tmFingerprint;
});

test("MDZH_RESCUE_MODEL retries a failed chunk with the rescue model and recovers", async () => {
  const source = "## Hello\n\nWorld.\n";

  let primaryDraftCalls = 0;
  let rescueDraftCalls = 0;

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      const sourceSection = extractPromptSection(prompt, "【英文原文】") ?? "";
      if (options.model === "rescue-strong") {
        rescueDraftCalls += 1;
        return createExecResult(sourceSection.replace("World.", "世界。"));
      }
      primaryDraftCalls += 1;
      throw new CodexExecutionError("primary draft synthetic failure");
    }
  };

  const previous = process.env.MDZH_RESCUE_MODEL;
  process.env.MDZH_RESCUE_MODEL = "rescue-strong";
  const sink = createMemoryTelemetrySink();
  try {
    await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown,
      telemetry: sink
    });
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_RESCUE_MODEL;
    } else {
      process.env.MDZH_RESCUE_MODEL = previous;
    }
  }

  assert.ok(primaryDraftCalls > 0, "primary draft must have been attempted first");
  assert.ok(rescueDraftCalls > 0, "rescue draft must have been called after primary failed");

  const rescueStart = [...sink.events].find((event) => event.type === "chunk.rescue.start");
  assert.ok(rescueStart, "expected chunk.rescue.start event");
  const rescueEnd = [...sink.events].find((event) => event.type === "chunk.rescue.end");
  assert.ok(rescueEnd, "expected chunk.rescue.end event");
  assert.equal((rescueEnd!.meta as Record<string, unknown>).success, true);
});

test("MDZH_RESCUE_MODEL surfaces the original error when the rescue also fails", async () => {
  const source = "## Hello\n\nWorld.\n";

  let primaryDraftCalls = 0;
  let rescueDraftCalls = 0;

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      if (options.model === "rescue-strong") {
        rescueDraftCalls += 1;
        throw new CodexExecutionError("rescue draft synthetic failure");
      }
      primaryDraftCalls += 1;
      throw new CodexExecutionError("primary draft synthetic failure");
    }
  };

  const previous = process.env.MDZH_RESCUE_MODEL;
  process.env.MDZH_RESCUE_MODEL = "rescue-strong";
  const sink = createMemoryTelemetrySink();
  try {
    await assert.rejects(
      () =>
        translateMarkdownArticle(source, {
          executor,
          formatter: async (markdown) => markdown,
          telemetry: sink
        }),
      (error: unknown) =>
        error instanceof CodexExecutionError && /primary draft synthetic failure/.test(error.message)
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_RESCUE_MODEL;
    } else {
      process.env.MDZH_RESCUE_MODEL = previous;
    }
  }

  assert.ok(primaryDraftCalls > 0, "primary draft must have been attempted first");
  assert.ok(rescueDraftCalls > 0, "rescue draft must have been attempted before failing the run");
  const rescueEnd = [...sink.events].find((event) => event.type === "chunk.rescue.end");
  assert.ok(rescueEnd, "expected chunk.rescue.end event");
  assert.equal((rescueEnd!.meta as Record<string, unknown>).success, false);
});

test("default behavior: rescue defaults to gpt-5.5 when MDZH_RESCUE_MODEL is unset", async () => {
  const source = "## Hello\n\nWorld.\n";

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      const sourceSection = extractPromptSection(prompt, "【英文原文】") ?? "";
      // Primary mini draft fails; the default rescue model recovers it.
      if (options.model === "gpt-5.5") {
        return createExecResult(sourceSection.replace("World.", "世界。"));
      }
      throw new CodexExecutionError("primary draft fail");
    }
  };

  const previous = process.env.MDZH_RESCUE_MODEL;
  delete process.env.MDZH_RESCUE_MODEL;
  const sink = createMemoryTelemetrySink();
  try {
    await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown,
      telemetry: sink
    });
  } finally {
    if (previous !== undefined) {
      process.env.MDZH_RESCUE_MODEL = previous;
    }
  }

  const rescueStart = [...sink.events].find((event) => event.type === "chunk.rescue.start");
  assert.ok(rescueStart, "default rescue should fire when MDZH_RESCUE_MODEL is unset");
  assert.equal((rescueStart!.meta as Record<string, unknown>).rescueModel, "gpt-5.5");
});

test("MDZH_RESCUE_MODEL=off explicitly disables rescue", async () => {
  const source = "## Hello\n\nWorld.\n";

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      throw new CodexExecutionError("draft fail");
    }
  };

  const previous = process.env.MDZH_RESCUE_MODEL;
  process.env.MDZH_RESCUE_MODEL = "off";
  const sink = createMemoryTelemetrySink();
  try {
    await assert.rejects(() =>
      translateMarkdownArticle(source, {
        executor,
        formatter: async (markdown) => markdown,
        telemetry: sink
      })
    );
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_RESCUE_MODEL;
    } else {
      process.env.MDZH_RESCUE_MODEL = previous;
    }
  }

  const rescueEvents = [...sink.events].filter((event) => event.type.startsWith("chunk.rescue"));
  assert.equal(rescueEvents.length, 0, "no rescue events should fire when MDZH_RESCUE_MODEL=off");
});

test("embedded_template_integrity check failure routes through repair lane and patch fix", async () => {
  // Audit reports embedded_template_integrity=false with a structured target;
  // the patch lane should fix it via literal replacement without an LLM repair
  // call. Validates that the new check participates in the existing repair
  // pipeline rather than escalating directly to a structural HardGateError.
  const source = "## API\n\nfoobar 小工具\n";

  const sink = createMemoryTelemetrySink();
  let auditPasses = 0;
  let repairCalls = 0;

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (prompt.includes("只返回 JSON") && prompt.includes("hard_checks"))) {
        if (auditPasses === 0) {
          auditPasses += 1;
          const failingAudit: GateAudit = {
            hard_checks: {
              paragraph_match: { pass: true, problem: "" },
              first_mention_bilingual: { pass: true, problem: "" },
              numbers_units_logic: { pass: true, problem: "" },
              chinese_punctuation: { pass: true, problem: "" },
              unit_conversion_boundary: { pass: true, problem: "" },
              protected_span_integrity: { pass: true, problem: "" },
              embedded_template_integrity: { pass: false, problem: "字段名 foobar 小工具 应字面保留为 foobar widget。" }
            },
            must_fix: ["第 1 段需保留原文字面 foobar widget，不要改为 foobar 小工具。"],
            repair_targets: [
              {
                location: "第 1 段",
                kind: "block",
                currentText: "foobar 小工具",
                targetText: "foobar widget",
                english: "foobar widget"
              }
            ]
          };
          return createExecResult(wrapAuditForSegments(prompt, failingAudit));
        }
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const blockCount = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: blockCount }, () => "foobar 小工具") }));
      }
      if (prompt.includes("【must_fix】")) {
        repairCalls += 1;
        return createExecResult("foobar widget\n");
      }
      const current = extractPromptSection(prompt, "【当前译文】");
      if (current !== null) {
        return createExecResult(current);
      }
      return createExecResult("foobar 小工具\n");
    }
  };

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    softGate: true,
    telemetry: sink
  });

  // Patch lane should have applied the structured target at least once. We
  // don't assert repairCalls === 0 because materializeFailedHardCheckProblems
  // injects a sentinel must_fix for the failing check itself (which has no
  // structuredTarget), so the LLM repair lane still fires for that companion
  // task. The point of the test is that embedded_template_integrity failures
  // flow through the existing repair pipeline (patch lane + LLM) rather than
  // immediately bubbling as a structural HardGateError.
  const repairCycles = [...sink.events].filter((event) => event.type === "repair.cycle");
  assert.ok(repairCycles.length >= 1, "expected at least one repair.cycle event");
  const patchEvents = [...sink.events].filter((event) => event.type === "repair.patch");
  assert.ok(patchEvents.length >= 1, "expected at least one repair.patch event");
  const applied = patchEvents.reduce(
    (sum, event) => sum + Number((event.meta as Record<string, unknown>).applied ?? 0),
    0
  );
  assert.ok(applied >= 1, `expected at least one structured patch to apply, got ${applied}`);
  void repairCalls;
});

test("dedupDraftDuplicateTailListItems trims duplicated tail bullets matching earlier ones", () => {
  const source = [
    "Here are the tools:",
    "",
    "- alpha",
    "- bravo",
    "- charlie",
    ""
  ].join("\n");
  const draft = [
    "工具如下：",
    "",
    "- 甲",
    "- 乙",
    "- 丙",
    "- 甲",
    "- 乙",
    "- 丙",
    ""
  ].join("\n");

  const trimmed = __testOnlyDedupDraftDuplicateTailListItems(source, draft);
  const trimmedLines = trimmed.split("\n");
  const bulletLines = trimmedLines.filter((line) => /^\s*-\s/.test(line));
  assert.equal(bulletLines.length, 3, `expected 3 bullets, got ${bulletLines.length}`);
});

test("dedupDraftDuplicateTailListItems leaves draft untouched when tail bullets are not duplicates", () => {
  const source = [
    "Here are the tools:",
    "",
    "- alpha",
    "- bravo",
    ""
  ].join("\n");
  // Draft has 3 bullets but the third is genuinely new content (not a
  // duplicate of any earlier bullet) — should NOT trim.
  const draft = [
    "工具如下：",
    "",
    "- 甲",
    "- 乙",
    "- 完全不一样的 X 项目说明",
    ""
  ].join("\n");

  const trimmed = __testOnlyDedupDraftDuplicateTailListItems(source, draft);
  assert.equal(trimmed, draft);
});

test("dedupDraftDuplicateTailListItems is a no-op when source has no trailing list", () => {
  const source = "Just a paragraph.\n\nAnother paragraph.\n";
  const draft = "中文段落。\n\n再一段。\n";
  const trimmed = __testOnlyDedupDraftDuplicateTailListItems(source, draft);
  assert.equal(trimmed, draft);
});

test("dedupDraftDuplicateTailListItems is a no-op when draft list count matches source", () => {
  const source = "- a\n- b\n- c\n";
  const draft = "- 甲\n- 乙\n- 丙\n";
  const trimmed = __testOnlyDedupDraftDuplicateTailListItems(source, draft);
  assert.equal(trimmed, draft);
});

test("dedupDraftDuplicateTailListItems trims numbered list duplicates too", () => {
  const source = "1. first\n2. second\n3. third\n";
  const draft = [
    "1. 第一",
    "2. 第二",
    "3. 第三",
    "1. 第一",
    "2. 第二",
    "3. 第三"
  ].join("\n");
  const trimmed = __testOnlyDedupDraftDuplicateTailListItems(source, draft);
  const items = trimmed.split("\n").filter((line) => /^\d+\.\s/.test(line));
  assert.equal(items.length, 3);
});

