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
  parseGateAudit,
  translateMarkdownArticle,
  type ChunkPromptContext,
  type GateAudit
} from "../src/translate.js";
import { CodexExecutionError } from "../src/errors.js";
import type { CodexExecOptions, CodexExecResult, CodexExecutor } from "../src/codex-exec.js";

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
      protected_span_integrity: { pass: true, problem: "" }
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
            chinese_punctuation: { pass: true, problem: "" },
            unit_conversion_boundary: { pass: true, problem: "" },
            protected_span_integrity: { pass: true, problem: "" }
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
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

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
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

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

test("translateMarkdownArticle under soft-gate emits degraded body and banner when only semantic hard-checks fail", async () => {
  const source = "# Title\n\nBody\n";
  const progress: string[] = [];
  const semanticFailingAudit = createAudit(false, ["正文首现术语缺少中英对照"], {
    paragraph_match: { pass: true, problem: "" },
    first_mention_bilingual: { pass: false, problem: "missing bilingual term" },
    numbers_units_logic: { pass: true, problem: "" },
    chinese_punctuation: { pass: true, problem: "" },
    unit_conversion_boundary: { pass: true, problem: "" },
    protected_span_integrity: { pass: true, problem: "" }
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

  assert.ok(result.markdown.length > 0, "soft-gate should emit a non-empty degraded body");
  assert.ok(
    progress.some((message) =>
      /soft-gate enabled \(semantic failures only\)/.test(message)
    ),
    "expected per-chunk soft-gate log line"
  );
  assert.ok(
    progress.some((message) => /Soft-gate fallback applied to \d+ chunk/.test(message)),
    "expected final aggregate banner"
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
    protected_span_integrity: { pass: true, problem: "" }
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

