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
          formatter: async (markdown) => markdown
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

test("translateMarkdownArticle repairs once and then runs final style polish when enabled", async () => {
  const source = "# Title\n\nBody";
  const firstAudit = JSON.stringify(createAudit(false, ["标题首现术语缺少中英对照"]));
  const secondAudit = JSON.stringify(createAudit(true));
  const executor = new StubExecutor([
    "# 标题\n\n正文",
    firstAudit,
    "# 标题（Title）\n\n正文",
    secondAudit,
    "# 标题（Title）\n\n更自然的正文"
  ]);

  const progress: string[] = [];
  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    styleMode: "final",
    onProgress: (message) => progress.push(message)
  });

  assert.equal(result.repairCyclesUsed, 1);
  assert.equal(result.styleApplied, true);
  assert.equal(result.markdown, "# 标题（Title）\n\n更自然的正文");
  assert.ok(progress.some((message) => message.includes("repair cycle 1")));
});

test("translateMarkdownArticle skips style polish by default", async () => {
  const source = "# Title\n\nBody";
  const executor = new StubExecutor([
    "# 标题\n\n正文",
    JSON.stringify(createAudit(true))
  ]);

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.equal(result.styleApplied, false);
  assert.equal(result.markdown, "# 标题\n\n正文");
  assert.equal(executor.prompts.some((prompt) => prompt.includes("只做“风格与可读性润色”")), false);
});

test("translateMarkdownArticle splits structurally dense mixed intro segments before draft execution", async () => {
  const source = [
    "# How to Use New Claude Code Sandbox",
    "",
    "226",
    "",
    "*Claude Code Sandbox Featured Image/ By Author*",
    "",
    "Claude Code **now has a sandbox mode** that makes the YOLO mode look amateurish.",
    "",
    "> If you’ve been coding with Claude Code, you’ve likely hit two walls.",
    "",
    "Neither option is sustainable.",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const draftPrompts = executor.prompts.filter(
    (prompt) => !isDocumentAnalysisPrompt(prompt) && !prompt.includes("只返回 JSON") && !prompt.includes("【当前译文】")
  );
  const draftSources = draftPrompts
    .map((prompt) => extractPromptSection(prompt, "【英文原文】")?.trim() ?? "")
    .filter(Boolean);

  assert.ok(draftPrompts.length >= 4);
  assert.ok(draftSources.includes("# How to Use New Claude Code Sandbox"));
  assert.ok(draftSources.includes("226"));
  assert.ok(draftSources.includes("*Claude Code Sandbox Featured Image/ By Author*"));
  assert.ok(
    draftSources.includes("Claude Code **now has a sandbox mode** that makes the YOLO mode look amateurish.")
  );
});

test("translateMarkdownArticle splits a standalone intro blockquote away from following paragraphs", async () => {
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
        return createExecResult(
          JSON.stringify({
            blocks: Array.from({ length: blockCount }, () => "占位正文")
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
      const sourceSection = extractPromptSection(prompt, "【英文原文】");
      return createExecResult(sourceSection ?? "");
    }
  });
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const draftSources = prompts
    .filter((prompt) => !isDocumentAnalysisPrompt(prompt))
    .map((prompt) => extractPromptSection(prompt, "【英文原文】")?.trim() ?? "")
    .filter(Boolean);

  assert.ok(
    draftSources.includes(
      "> If you’ve been coding with Claude Code, you’ve likely hit two walls: the constant permission prompts that kill productivity, or the --dangerously-skip-permissions flag that removes all safety guardrails."
    )
  );
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

test("translateMarkdownArticle splits a heading-like block away from a following list", async () => {
  const source = [
    "**Network Isolation**",
    "",
    "- Pre-approved destinations (npm registry, GitHub, your APIs)",
    "- Blocked destinations (random servers, pastebin sites, unknown domains)",
    "- Request-based approval for new destinations",
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
  });

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const promptBodies = prompts.filter((prompt) => !isDocumentAnalysisPrompt(prompt));
  assert.ok(
    promptBodies.some(
      (prompt) =>
        prompt.includes("**Network Isolation**") &&
        !prompt.includes("- Pre-approved destinations")
    )
  );
  assert.ok(
    promptBodies.some(
      (prompt) =>
        prompt.includes("- Pre-approved destinations") &&
        !prompt.includes("**Network Isolation**")
    )
  );
});

test("translateMarkdownArticle splits before a heading when pending content already contains list or blockquote blocks", async () => {
  const source = [
    "**Protection Against Attack Vectors**",
    "",
    "- Prompt injection attacks (malicious instructions in code comments)",
    "- Supply chain attacks (compromised npm packages trying to steal data)",
    "",
    "> System permissions, by design, don’t distinguish between these scenarios. The Sandbox works by differentiating between these two cases.",
    "",
    "## How Sandbox Mode Changes Autonomous Coding",
    "",
    "Sandbox mode creates operating system-level restrictions.",
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
  });

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const promptBodies = prompts.filter((prompt) => !isDocumentAnalysisPrompt(prompt));
  assert.ok(
    promptBodies.some(
      (prompt) =>
        prompt.includes("Prompt injection attacks") &&
        prompt.includes("The Sandbox works by differentiating between these two cases.") &&
        !prompt.includes("## How Sandbox Mode Changes Autonomous Coding")
    )
  );
  assert.ok(
    promptBodies.some(
      (prompt) =>
        prompt.includes("## How Sandbox Mode Changes Autonomous Coding") &&
        !prompt.includes("Prompt injection attacks")
    )
  );
});

test("translateMarkdownArticle splits a blockquote away from a preceding list before the next heading", async () => {
  const source = [
    "**Protection Against Attack Vectors**",
    "",
    "- Prompt injection attacks (malicious instructions in code comments)",
    "- Supply chain attacks (compromised npm packages trying to steal data)",
    "",
    "> System permissions, by design, don’t distinguish between these scenarios. The Sandbox works by differentiating between these two cases.",
    "",
    "## How Sandbox Mode Changes Autonomous Coding",
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
  });

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const promptBodies = prompts.filter((prompt) => !isDocumentAnalysisPrompt(prompt));
  assert.ok(
    promptBodies.some(
      (prompt) =>
        prompt.includes("> System permissions, by design, don’t distinguish between these scenarios.") &&
        !prompt.includes("Prompt injection attacks") &&
        !prompt.includes("## How Sandbox Mode Changes Autonomous Coding")
    )
  );
});

test("translateMarkdownArticle fails after two repair cycles when the gate never passes", async () => {
  const source = "# Title\n\nBody";
  const failingAudit = JSON.stringify(createAudit(false, ["正文首现术语缺少中英对照"]));
  const executor = new StubExecutor([
    "# 标题\n\n正文",
    failingAudit,
    "# 标题（Title）\n\n正文",
    failingAudit,
    "# 标题（Title）\n\n正文",
    failingAudit
  ]);

  await assert.rejects(
    () =>
      translateMarkdownArticle(source, {
        executor,
        formatter: async (markdown) => markdown
      }),
    (error: unknown) => {
      assert.ok(error instanceof HardGateError);
      assert.match(error.message, /failed after 2 repair cycle/);
      return true;
    }
  );
});

test("translateMarkdownArticle preserves frontmatter and protected Markdown spans", async () => {
  const source = [
    "---",
    "title: Hello World",
    "tags:",
    "  - ai",
    "---",
    "",
    "# Intro",
    "",
    "Use `npm install` before running.",
    "",
    "```ts",
    'const url = "https://example.com";',
    "```",
    "",
    "Read [the docs](https://example.com/docs).",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /^---\ntitle: Hello World\ntags:\n  - ai\n---\n/);
  assert.match(result.markdown, /Use `npm install` before running\./);
  assert.match(result.markdown, /```ts\nconst url = "https:\/\/example\.com";\n```/);
  assert.match(result.markdown, /\[the docs\]\(https:\/\/example\.com\/docs\)/);
  assert.equal(executor.prompts.some((prompt) => prompt.includes("title: Hello World")), false);
});

test("translateMarkdownArticle falls back to the hard-pass translation when style polish breaks a protected span", async () => {
  const source = [
    "# Docs",
    "",
    "Read [the docs](https://example.com/docs).",
    "",
    "Keep going.",
    ""
  ].join("\n");

  const passingAudit = createAudit(true);
  const progress: string[] = [];

  class BrokenStyleExecutor implements CodexExecutor {
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
        return createExecResult(current.replace(/\[the docs\]\(@@MDZH_LINK_DESTINATION_\d{4,}@@\)/g, "the docs"));
      }

      return createExecResult(current);
    }
  }

  const executor = new BrokenStyleExecutor();

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    styleMode: "final",
    onProgress: (message) => progress.push(message)
  });

  assert.equal(result.styleApplied, false);
  assert.match(result.markdown, /\[the docs\]\(https:\/\/example\.com\/docs\)/);
  assert.ok(
    progress.some((message) =>
      message.includes("falling back to the hard-pass translation")
    )
  );
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

test("translateMarkdownArticle strips added inline code from plain path list items", async () => {
  const source = [
    "## Credential Theft",
    "",
    "Attempts to access:",
    "",
    "- ~/.ssh/ (SSH keys)",
    "- ~/.aws/ (AWS credentials)",
    "- ~/.config/ (API tokens)"
  ].join("\n");

  class PlainPathExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult(
          [
            "## 凭据窃取（Credential Theft）",
            "",
            "尝试访问：",
            "",
            "- `~/.ssh/`（SSH keys）",
            "- `~/.aws/`（AWS credentials）",
            "- `~/.config/`（API tokens）"
          ].join("\n")
        );
      }

      return createExecResult(
        [
          "## 凭据窃取（Credential Theft）",
          "",
          "尝试访问：",
          "",
          "- `~/.ssh/`（SSH keys）",
          "- `~/.aws/`（AWS credentials）",
          "- `~/.config/`（API tokens）"
        ].join("\n")
      );
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new PlainPathExecutor(),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /- ~\/\.ssh\/（SSH keys）/);
  assert.match(result.markdown, /- ~\/\.aws\/（AWS credentials）/);
  assert.match(result.markdown, /- ~\/\.config\/（API tokens）/);
  assert.doesNotMatch(result.markdown, /`~\/\.ssh\/`/);
  assert.doesNotMatch(result.markdown, /`~\/\.aws\/`/);
  assert.doesNotMatch(result.markdown, /`~\/\.config\/`/);
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

test("translateMarkdownArticle restores inline code only at source locations when the same flag also appears as plain text", async () => {
  const source = [
    "## Claude Code Permission Problem",
    "",
    "If you use the --dangerously-skip-permissions flag, you remove safety guardrails.",
    "",
    "The `--dangerously-skip-permissions` flag exists as an escape hatch from this fatigue."
  ].join("\n");

  class MixedFlagExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const translated = [
        "## Claude Code 权限问题",
        "",
        "如果你使用 `--dangerously-skip-permissions` 标志，就会移除安全护栏。",
        "",
        "这个 --dangerously-skip-permissions 标志是为了缓解这种疲劳而存在的逃生舱。"
      ].join("\n");

      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult(extractPromptSection(prompt, "【当前译文】") ?? translated);
      }

      return createExecResult(translated);
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new MixedFlagExecutor(),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /如果你使用 --dangerously-skip-permissions 标志/);
  assert.match(result.markdown, /这个 `--dangerously-skip-permissions` 标志是为了缓解这种疲劳而存在的逃生舱/);
  assert.doesNotMatch(result.markdown, /如果你使用 `--dangerously-skip-permissions` 标志/);
});

test("translateMarkdownArticle canonicalizes inline code fence shape back to the source form", async () => {
  const source = [
    "## Claude Code Permission Problem",
    "",
    "The `--dangerously-skip-permissions` flag exists as an escape hatch from this fatigue."
  ].join("\n");

  class DoubleBacktickExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const translated = [
        "## Claude Code 权限问题",
        "",
        "这个 ``--dangerously-skip-permissions`` 标志是为了缓解这种疲劳而存在的逃生舱。"
      ].join("\n");

      return createExecResult(translated);
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new DoubleBacktickExecutor(),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /`--dangerously-skip-permissions`/);
  assert.doesNotMatch(result.markdown, /``--dangerously-skip-permissions``/);
});

test("translateMarkdownArticle restores code-like wildcard tokens back to the source shape", async () => {
  const source = "- Wildcards: ./src/**/*.js\n";

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createEmptyAnchorCatalog());
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult("- 通配符：./src/\\*_/_.js");
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /\.\/src\/\*\*\/\*\.js/);
  assert.doesNotMatch(result.markdown, /\.\/src\/\\\*_\//);
});

test("translateMarkdownArticle restores source-shaped example tokens inside markdown lists", async () => {
  const source = [
    "**Glob Patterns:**",
    "",
    "- * - Matches any character except /",
    "- ** - Matches any character, including /",
    "- ? - Matches a single character",
    "- [abc] - Matches any character in the set"
  ].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createEmptyAnchorCatalog());
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
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
            "**Glob 模式：**",
            "",
            "- - - 匹配除 / 之外的任意字符",
            "- \\*\\* - 匹配任意字符，包括 /",
            "-? - 匹配单个字符",
            "- [abc] - 匹配集合中的任意字符"
          ].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /^- \* - /m);
  assert.match(result.markdown, /^- \*\* - /m);
  assert.match(result.markdown, /^- \? - /m);
  assert.match(result.markdown, /^- \[abc\] - /m);
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

test("translateMarkdownArticle runs the hidden pipeline chunk by chunk for long Markdown sections", async () => {
  const source = [
    "# Title",
    "",
    "Intro paragraph.",
    "",
    "## First Section",
    "",
    "Alpha paragraph with docs.",
    "",
    "## Second Section",
    "",
    "Beta paragraph.",
    ""
  ].join("\n");

  const { protectedBody } = protectMarkdownSpans(source);
  const chunkPlan = planMarkdownChunks(protectedBody);
  const executor = new PromptAwareExecutor();

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.equal(result.chunkCount, chunkPlan.chunks.length);
  assert.equal(result.markdown, source);
  assert.ok(executor.prompts.length >= chunkPlan.chunks.length * 3);
  assert.ok(
    executor.prompts.some(
      (prompt) => !isDocumentAnalysisPrompt(prompt) && prompt.includes("当前分块：第 1 /")
    )
  );
});

test("translateMarkdownArticle allocates unique local markdown-link placeholders across chunks", async () => {
  const source = [
    "# Title",
    "",
    "## One",
    "",
    "This is [bubblewrap](https://example.com/bwrap).",
    "",
    "## Two",
    "",
    "This is [macOS](https://example.com/macos).",
    ""
  ].join("\n");

  const draftPrompts: string[] = [];
  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (!options.outputSchema && !prompt.includes("【must_fix】") && !prompt.includes("只做“风格与可读性润色”")) {
        draftPrompts.push(prompt);
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
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

  assert.ok(
    draftPrompts.every((prompt) => !/@@MDZH_INLINE_MARKDOWN_LINK_\d{4,}@@/.test(prompt))
  );
  assert.ok(
    draftPrompts.some((prompt) => /\[bubblewrap\]\(@@MDZH_LINK_DESTINATION_\d{4,}@@\)/.test(prompt))
  );
  assert.ok(
    draftPrompts.some((prompt) => /\[macOS\]\(@@MDZH_LINK_DESTINATION_\d{4,}@@\)/.test(prompt))
  );
});

test("translateMarkdownArticle canonicalizes expanded URL spans before final style polish", async () => {
  const source = [
    "# Docs",
    "",
    "Read [docs](https://example.com/docs).",
    "",
    "```bash",
    "printf 'ok'",
    "```",
    "",
    "See [guide](https://example.com/guide).",
    ""
  ].join("\n");

  class CanonicalChunkExecutor implements CodexExecutor {
    readonly prompts: string[] = [];
    private draftCallCount = 0;

    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      this.prompts.push(prompt);

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        assert.match(prompt, /@@MDZH_CODE_BLOCK_0001@@/);
        assert.match(prompt, /\[docs\]\(@@MDZH_LINK_DESTINATION_\d{4,}@@\)/);
        assert.match(prompt, /\[guide\]\(@@MDZH_LINK_DESTINATION_\d{4,}@@\)/);
        assert.doesNotMatch(prompt, /\]\(https:\/\/example\.com\/docs\)/);
        assert.doesNotMatch(prompt, /\]\(https:\/\/example\.com\/guide\)/);
        return createExecResult(extractPromptSection(prompt, "【当前译文】") ?? "");
      }

      this.draftCallCount += 1;
      if (this.draftCallCount === 1) {
        return createExecResult("# Docs\n\nRead [docs](https://example.com/docs).\n");
      }
      if (this.draftCallCount === 2) {
        return createExecResult("See [guide](https://example.com/guide).\n");
      }

      throw new Error("Unexpected extra draft call");
    }
  }

  const executor = new CanonicalChunkExecutor();
  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    styleMode: "final"
  });

  assert.match(result.markdown, /^# Docs\n\nRead \[docs\]\(https:\/\/example\.com\/docs\)\./);
  assert.match(result.markdown, /```bash\nprintf 'ok'\n```/);
  assert.match(result.markdown, /See \[guide\]\(https:\/\/example\.com\/guide\)\.\n$/);
});

test("translateMarkdownArticle canonicalizes expanded URL spans before final style polish even when draft changes destination formatting", async () => {
  const source = [
    "## How Sandbox Mode Changes Autonomous Coding",
    "",
    "This is not Claude code by default, but it’s isolation enforced by Linux [bubblewrap ](https://example.com/bubblewrap)or [macOS](https://example.com/macos)* Seatbel*t — the same security primitives that protect containers and system services.",
    ""
  ].join("\n");

  class DraftDestinationFormattingExecutor implements CodexExecutor {
    readonly prompts: string[] = [];

    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const bc = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: bc }, () => "中文占位译文") }));
      }
      this.prompts.push(prompt);

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        assert.match(prompt, /\[bubblewrap（安全隔离组件）]\( @@MDZH_LINK_DESTINATION_\d{4,}@@ "bubblewrap" \)/);
        assert.match(prompt, /\[macOS（苹果操作系统）]\(@@MDZH_LINK_DESTINATION_\d{4,}@@ \)/);
        assert.doesNotMatch(prompt, /https:\/\/example\.com\/bubblewrap/);
        assert.doesNotMatch(prompt, /https:\/\/example\.com\/macos/);
        return createExecResult(extractPromptSection(prompt, "【当前译文】") ?? "");
      }

      return createExecResult(
        [
          "## 沙箱模式（Sandbox Mode）如何改变自主编码（Autonomous Coding）",
          "",
          "这并非 Claude Code 的默认行为，而是由 Linux [bubblewrap（安全隔离组件）]( https://example.com/bubblewrap \"bubblewrap\" ) 或 [macOS（苹果操作系统）](https://example.com/macos ) *Seatbelt（安全框架）* 强制执行的隔离机制——这正是用于保护容器和系统服务的同类安全基元。",
          ""
        ].join("\n")
      );
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new DraftDestinationFormattingExecutor(),
    formatter: async (markdown) => markdown,
    styleMode: "final"
  });

  assert.match(result.markdown, /\[bubblewrap（安全隔离组件）]\( https:\/\/example\.com\/bubblewrap "bubblewrap" \)/);
  assert.match(result.markdown, /\[macOS（苹果操作系统）]\(https:\/\/example\.com\/macos \)/);
});

test("translateMarkdownArticle restores style-polish output that expands markdown links with protected destinations", async () => {
  const source = [
    "# Docs",
    "",
    "Read [docs](https://example.com/docs) and [guide](https://example.com/guide).",
    ""
  ].join("\n");

  class ExpandedStyleLinkExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema && prompt.includes("### BLOCK")) {
        const bc = (prompt.match(/^### BLOCK \d+ \([^)]+\)$/gm) ?? []).length || 1;
        return createExecResult(JSON.stringify({ blocks: Array.from({ length: bc }, () => "中文占位译文") }));
      }
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        const current = extractPromptSection(prompt, "【当前译文】") ?? "";
        assert.match(current, /\[docs\]\(@@MDZH_LINK_DESTINATION_\d{4,}@@\)/);
        assert.match(current, /\[guide\]\(@@MDZH_LINK_DESTINATION_\d{4,}@@\)/);

        return createExecResult(
          current
            .replace(
              /\[docs\]\(@@MDZH_LINK_DESTINATION_\d{4,}@@\)/,
              "[docs](https://example.com/docs)"
            )
            .replace(
              /\[guide\]\(@@MDZH_LINK_DESTINATION_\d{4,}@@\)/,
              "[guide](https://example.com/guide)"
            )
        );
      }

      const sourceSection = extractPromptSection(prompt, "【英文原文】");
      return createExecResult(sourceSection ?? "");
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new ExpandedStyleLinkExecutor(),
    formatter: async (markdown) => markdown,
    styleMode: "final"
  });

  assert.equal(
    result.markdown,
    "# Docs\n\nRead [docs](https://example.com/docs) and [guide](https://example.com/guide).\n"
  );
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

test("translateMarkdownArticle passes raw inline code through before segment audit", async () => {
  const source = "With sandbox: access to `~/.ssh` is blocked.\n";
  const executor = new WrappedInlineCodeExecutor();

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.equal(result.markdown, "With sandbox: 访问 `~/.ssh` 会被阻止。\n");
});

test("translateMarkdownArticle keeps inline markdown links visible at final style polish", async () => {
  const source = [
    "# Title",
    "",
    "This is enforced by Linux [bubblewrap ](https://example.com/bubblewrap) or [macOS](https://example.com/macos).",
    ""
  ].join("\n");

  class InlineLinkExecutor implements CodexExecutor {
    readonly prompts: string[] = [];

    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      this.prompts.push(prompt);

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        assert.match(prompt, /\[bubblewrap \]\(@@MDZH_LINK_DESTINATION_\d{4,}@@\)/);
        assert.match(prompt, /\[macOS\]\(@@MDZH_LINK_DESTINATION_\d{4,}@@\)/);
        assert.doesNotMatch(prompt, /@@MDZH_INLINE_MARKDOWN_LINK_\d{4,}@@/);
        return createExecResult(extractPromptSection(prompt, "【当前译文】") ?? "");
      }

      const protectedSource = extractPromptSection(prompt, "【英文原文】") ?? "";
      return createExecResult(
        protectedSource
          .replace("# Title", "# 标题")
          .replace("This is enforced by Linux", "这由 Linux 强制执行")
      );
    }
  }

  const executor = new InlineLinkExecutor();
  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    styleMode: "final"
  });

  assert.match(result.markdown, /\[bubblewrap \]\(https:\/\/example\.com\/bubblewrap\)/);
  assert.match(result.markdown, /\[macOS\]\(https:\/\/example\.com\/macos\)/);
});

test("translateMarkdownArticle rebuilds missing markdown link destinations from visible link labels", async () => {
  const source = [
    "# Title",
    "",
    "This is enforced by Linux [bubblewrap ](https://example.com/bubblewrap) or [macOS](https://example.com/macos).",
    ""
  ].join("\n");

  class MissingLinkDestinationExecutor implements CodexExecutor {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult(extractPromptSection(prompt, "【当前译文】") ?? "");
      }

      if (prompt.includes("【英文原文】")) {
        return createExecResult(
          [
            "# 标题",
            "",
            "这由 Linux bubblewrap（安全隔离组件）或 macOS（苹果操作系统）强制执行。",
            ""
          ].join("\n")
        );
      }

      return createExecResult("[]");
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new MissingLinkDestinationExecutor(),
    formatter: async (markdown) => markdown
  });

  assert.match(
    result.markdown,
    /\[bubblewrap（安全隔离组件）]\(https:\/\/example\.com\/bubblewrap\)或 \[macOS（苹果操作系统）]\(https:\/\/example\.com\/macos\)/
  );
});

test("translateMarkdownArticle keeps standalone code blocks out of translatable segment prompts", async () => {
  const source = [
    "# Title",
    "",
    "Intro before the command.",
    "",
    "```bash",
    "/sandbox",
    "```",
    "",
    "After the command.",
    ""
  ].join("\n");

  class AnchorExecutor extends PromptAwareExecutor {
    override async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          JSON.stringify({
            anchors: [
              {
                english: "npm",
                chineseHint: "npm",
                familyKey: "npm",
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

  const executor = new AnchorExecutor();
  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.equal(result.markdown, source);
  const nonStylePrompts = executor.prompts.filter(
    (prompt) => !prompt.includes("只做“风格与可读性润色”") && !isDocumentAnalysisPrompt(prompt)
  );
  assert.equal(nonStylePrompts.some((prompt) => prompt.includes("@@MDZH_CODE_BLOCK_")), false);
});

test("translateMarkdownArticle reuses a Codex thread within a segment", async () => {
  const source = "# Title\n\nBody";
  const calls: CodexExecOptions[] = [];
  const responses = [
    createExecResult("# 标题\n\n正文", "thread-1"),
    createExecResult(
      wrapPerSegmentAudits("【segment 1】", [
        { segment_index: 1, audit: createAudit(false, ["标题首现术语缺少中英对照"]) }
      ])
    ),
    createExecResult("# 标题（Title）\n\n正文", "thread-1"),
    createExecResult(JSON.stringify(createAudit(true))),
    createExecResult("# 标题（Title）\n\n正文")
  ];

  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog(), "analysis-thread");
      }
      calls.push(options);
      const next = responses.shift();
      assert.ok(next, "Unexpected extra Codex call");
      return next;
    }
  });

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    styleMode: "final"
  });

  assert.equal(calls[0]?.reuseSession, true);
  assert.equal(calls[0]?.reasoningEffort, "medium");
  assert.ok(calls[1]?.outputSchema);
  assert.equal(calls[1]?.reuseSession, true);
  assert.equal(calls[1]?.reasoningEffort, "medium");
  assert.equal(calls[2]?.threadId, "thread-1");
  assert.equal(calls[2]?.reasoningEffort, "low");
  assert.ok(calls[3]?.outputSchema);
  assert.equal(calls[3]?.reuseSession, true);
  assert.equal(calls[3]?.reasoningEffort, "medium");
  assert.equal(calls[4]?.reasoningEffort, "low");
});

test("translateMarkdownArticle routes post-draft stages to the configured post-draft model", async () => {
  const source = "# Title\n\nBody";
  const calls: Array<{ prompt: string; options: CodexExecOptions }> = [];
  const previousPostDraftReasoning = process.env.POST_DRAFT_REASONING_EFFORT;
  process.env.POST_DRAFT_REASONING_EFFORT = "medium";

  try {
    const executor: CodexExecutor = createP2CompatibleExecutor({
      async execute(prompt, options) {
        calls.push({ prompt, options });

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          if (prompt.includes("【当前译文】") && prompt.includes("正文（Body）")) {
            return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
          }

          return createExecResult(
            wrapAuditForSegments(prompt, createAudit(false, ["将“Body”补成首现中英对照。"]))
          );
        }

        if (prompt.includes("【must_fix】")) {
          return createExecResult("# 标题（Title）\n\n正文（Body）");
        }

        if (prompt.includes("只做“风格与可读性润色”")) {
          return createExecResult("# 标题（Title）\n\n更自然的正文（Body）");
        }

        return createExecResult("# 标题\n\n正文");
      }
    });

    await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown,
      model: "gpt-5.4-mini",
      postDraftModel: "gpt-5.4",
      styleMode: "final"
    });

    const draftCall = calls.find(
      (entry) =>
        !entry.options.outputSchema &&
        !entry.prompt.includes("【must_fix】") &&
        !entry.prompt.includes("只做“风格与可读性润色”")
    );
    assert.ok(draftCall);
    assert.equal(draftCall.options.model, "gpt-5.4-mini");
    assert.equal(draftCall.options.reasoningEffort, "medium");
    assert.equal(draftCall.options.timeoutMs, 180000);

    const auditCalls = calls.filter((entry) => entry.options.outputSchema || entry.prompt.includes("只返回 JSON"));
    assert.ok(auditCalls.length >= 1);
    for (const call of auditCalls) {
      assert.equal(call.options.model, "gpt-5.4");
      assert.equal(call.options.reasoningEffort, "medium");
      assert.equal(call.options.timeoutMs, 120000);
    }

    const repairCall = calls.find((entry) => entry.prompt.includes("【must_fix】"));
    assert.ok(repairCall);
    assert.equal(repairCall.options.model, "gpt-5.4");
    assert.equal(repairCall.options.reasoningEffort, "medium");
    assert.equal(repairCall.options.timeoutMs, 120000);

    const styleCall = calls.find((entry) => entry.prompt.includes("只做“风格与可读性润色”"));
    assert.ok(styleCall);
    assert.equal(styleCall.options.model, "gpt-5.4");
    assert.equal(styleCall.options.reasoningEffort, "medium");
    assert.equal(styleCall.options.timeoutMs, 120000);
  } finally {
    if (previousPostDraftReasoning == null) {
      delete process.env.POST_DRAFT_REASONING_EFFORT;
    } else {
      process.env.POST_DRAFT_REASONING_EFFORT = previousPostDraftReasoning;
    }
  }
});

test("translateMarkdownArticle runs chunk-level audit with structured output", async () => {
  const source = "# Title\n\nBody";
  const calls: Array<{ prompt: string; options: CodexExecOptions }> = [];
  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog(), "analysis-thread");
      }
      calls.push({ prompt, options });
      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)), "audit-thread");
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult("# 标题\n\n正文");
      }

      return createExecResult("# 标题\n\n正文", "draft-thread");
    }
  });

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    styleMode: "final"
  });

  assert.equal(result.markdown, "# 标题\n\n正文");
  const draftCall = calls.find(
    ({ prompt, options }) =>
      !options.outputSchema &&
      !prompt.includes("只做“风格与可读性润色”")
  );
  const auditCall = calls.find(({ options }) => Boolean(options.outputSchema));
  const styleCall = calls.find(({ prompt }) => prompt.includes("只做“风格与可读性润色”"));
  assert.ok(draftCall);
  assert.ok(auditCall);
  assert.ok(styleCall);
  assert.equal(draftCall.options.reuseSession, true);
  assert.equal(draftCall.options.reasoningEffort, "medium");
  assert.ok(auditCall.options.outputSchema);
  assert.equal(auditCall.options.reuseSession, true);
  assert.equal(auditCall.options.reasoningEffort, "medium");
  assert.equal(styleCall.options.reasoningEffort, "low");
});

test("translateMarkdownArticle falls back to per-segment audit when bundled audit omits segment results", async () => {
  const source = [
    "# Title",
    "",
    "## Need",
    "",
    "Filesystem Isolation keeps the agent away from sensitive paths.",
    "",
    "```sh",
    "ls ~/.ssh",
    "```",
    "",
    "Network Isolation constrains outbound access until it is explicitly approved.",
    "",
    "```sh",
    "curl https://example.com",
    "```",
    "",
    "Command Restrictions decide which commands may run automatically and which need review.",
    ""
  ].join("\n");

  let bundledAuditSeen = false;
  let singleAuditCount = 0;
  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (options.outputSchema && prompt.includes("【分段审校输入】")) {
        bundledAuditSeen = true;
        return createExecResult(
          JSON.stringify({
            segments: [
              {
                segment_index: 1,
                ...createAudit(true)
              }
            ]
          })
        );
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        singleAuditCount += 1;
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

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.ok(bundledAuditSeen);
  assert.ok(singleAuditCount >= 3);
  assert.match(result.markdown, /Filesystem Isolation/);
  assert.match(result.markdown, /Network Isolation/);
  assert.match(result.markdown, /Command Restrictions/);
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

test("translateMarkdownArticle falls back to per-segment audit when bundled audit times out", async () => {
  const source = [
    "# Title",
    "",
    "## Need",
    "",
    "Filesystem Isolation keeps the agent away from sensitive paths.",
    "",
    "Command Restrictions decide which commands may run automatically and which need review.",
    ""
  ].join("\n");

  let bundledAuditSeen = false;
  let singleAuditCount = 0;
  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (options.outputSchema && prompt.includes("【分段审校输入】")) {
        bundledAuditSeen = true;
        throw new CodexExecutionError("Chunk 1/1 (Need): bundled audit timed out after 120000ms.");
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        singleAuditCount += 1;
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

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.ok(bundledAuditSeen);
  assert.ok(singleAuditCount >= 2);
  assert.match(result.markdown, /Filesystem Isolation/);
  assert.match(result.markdown, /Command Restrictions/);
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

test("translateMarkdownArticle does not re-audit unchanged segments after later repair cycles", async () => {
  const source = [
    "# Title",
    "",
    "## Need",
    "",
    "Filesystem Isolation keeps the agent away from sensitive paths.",
    "",
    "```sh",
    "ls ~/.ssh",
    "```",
    "",
    "Network Isolation constrains outbound access until it is explicitly approved.",
    "",
    "```sh",
    "curl https://example.com",
    "```",
    "",
    "Command Restrictions decide which commands may run automatically and which need review.",
    ""
  ].join("\n");

  let bundledAuditCount = 0;
  let fallbackAuditCount = 0;
  let secondFallbackSawSegmentOne = false;

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
        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        return createExecResult(currentTranslation ?? "");
      }

      if (options.outputSchema && prompt.includes("【分段审校输入】")) {
        bundledAuditCount += 1;
        return createExecResult(
          wrapPerSegmentAudits(prompt, [
            { segment_index: 1, audit: createAudit(false, ["修复项一"]) },
            { segment_index: 3, audit: createAudit(false, ["修复项二"]) }
          ])
        );
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        fallbackAuditCount += 1;
        const sourceSection = extractPromptSection(prompt, "【英文原文】") ?? "";

        if (fallbackAuditCount === 1) {
          assert.match(sourceSection, /Filesystem Isolation/);
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        if (fallbackAuditCount === 2) {
          assert.doesNotMatch(sourceSection, /Filesystem Isolation/);
          return createExecResult(JSON.stringify(createAudit(false, ["只剩 segment 3 的修复项"])));
        }

        if (sourceSection.includes("Filesystem Isolation")) {
          secondFallbackSawSegmentOne = true;
          return createExecResult(JSON.stringify(createAudit(false, ["不应再次审到 segment 1"])));
        }

        assert.doesNotMatch(sourceSection, /Filesystem Isolation/);
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

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.equal(bundledAuditCount, 1);
  assert.equal(fallbackAuditCount, 3);
  assert.equal(secondFallbackSawSegmentOne, false);
  assert.match(result.markdown, /Filesystem Isolation/);
  assert.match(result.markdown, /Command Restrictions/);
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

test("translateMarkdownArticle keeps IR and special notes in draft prompts but omits the heavy stateSlice JSON", async () => {
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

  const draftPrompt = executor.prompts.find(
    (item) =>
      !isDocumentAnalysisPrompt(item) &&
      !item.includes("只返回 JSON") &&
      !item.includes("【当前译文】") &&
      item.includes("How Sandbox Mode Changes Autonomous Coding")
  );
  assert.ok(draftPrompt);
  assert.match(draftPrompt, /【当前分段 IR】/);
  assert.match(draftPrompt, /【当前分段附加规则】/);
  assert.doesNotMatch(draftPrompt, /【状态切片\(JSON\)】/);
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

test("translateMarkdownArticle synthesizes a local heading anchor target when audit only reports a chinese title location", async () => {
  const source = [
    "# Title",
    "",
    "## How Sandbox Mode Changes Autonomous Coding",
    "",
    "Body paragraph.",
    ""
  ].join("\n");

  let auditCount = 0;
  const executor = new PromptAwareExecutor();
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        executor.prompts.push(prompt);

        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createEmptyAnchorCatalog());
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    "位置：`自主编码`。问题：首次出现的工具/专名未完整建立中英文对照。修复目标：在该位置本身补齐首现锚定。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["# Title", "", "## 沙盒模式如何改变自主编码", "", "正文。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  const repairPrompt = executor.prompts.find(
    (item) => item.includes("【must_fix】") && item.includes("自主编码（Autonomous Coding）")
  );
  assert.ok(repairPrompt);
  assert.match(result.markdown, /## 沙盒模式（Sandbox Mode）如何改变自主编码（Autonomous Coding）/);
});

test("translateMarkdownArticle suppresses first-mention demands that are neither in state nor safely synthesizable locally", async () => {
  const source = ["# Title", "", "**Commit to ToolX (`.config.json`):**", "", "Body paragraph.", ""].join("\n");

  let auditCount = 0;
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createEmptyAnchorCatalog());
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    "位置：分段标题“Commit to ToolX（`.config.json`）”。问题：ToolX 首次出现缺少中文对照；需补成合法的中英锚定形式。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["# Title", "", "**提交到 ToolX（`.config.json`）：**", "", "正文。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /\*\*提交到 ToolX（`\.config\.json`）：\*\*/);
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

test("translateMarkdownArticle repeats explicit English target guidance when must_fix names a quoted term", async () => {
  const source = [
    "# Title",
    "",
    "## Python Data Science Project Example",
    "",
    "**Key features:**",
    "",
    "- Notebook full access",
    "- Python and pip commands allowed",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        executor.prompts.push(prompt);

        if (isBundledAuditPrompt(prompt, options)) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(false, [
                  "第4条项目符号：将“bubblewrap”补成首现中英对照，保留原句含义。"
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
      item.includes("将“bubblewrap”补成首现中英对照")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /本次 must_fix 明确点名了这些英文目标：bubblewrap/);
  assert.match(repairPrompt, /即使它看起来是常见技术词，也必须严格按 must_fix 要求修复/);
  assert.match(repairPrompt, /必须在对应的标题、当前句、列表项或被点名位置本身保留这个英文原名/);
});

test("translateMarkdownArticle repeats blockquote-specific repair guidance when must_fix targets a quote segment", async () => {
  const source = [
    "# Title",
    "",
    "> System permissions, by design, don’t distinguish between these scenarios. The Sandbox works by differentiating between these two cases.",
    "",
    "## How Sandbox Mode Changes Autonomous Coding",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        executor.prompts.push(prompt);

        if (isBundledAuditPrompt(prompt, options)) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(false, [
                  "位置：引用段“沙箱通过将这两类情况区分开来发挥作用”。问题：核心术语 Sandbox 在全文本块首次出现时未完成中英文对照。修复目标：在该引用段中的首个“沙箱”处直接补齐自然的中英文对应。"
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
      item.includes("位置：引用段“沙箱通过将这两类情况区分开来发挥作用”")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /当前分段包含引用段落或 `>` 引用句/);
  assert.match(repairPrompt, /本次 must_fix 明确指向引用段中的句子/);
  assert.match(repairPrompt, /必须直接在对应引用句本身补齐缺失的首现中英文对照或中文说明/);
  assert.match(repairPrompt, /不要把英文锚点延后到后文标题或下一段第一次出现的位置/);
});

test("translateMarkdownArticle normalizes an explicit quote-segment anchor target after repair", async () => {
  const source = [
    "## So, What Do AI Agents Need?",
    "",
    "> Let's now look at what Sandbox mode protects you from.",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        executor.prompts.push(prompt);

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          if (prompt.includes("【当前译文】\n> 现在让我们看看沙箱模式（Sandbox mode）会保护你免受什么影响。")) {
            return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
          }

          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(false, [
                  "第 4 段引用句“现在让我们看看沙箱模式会保护你免受什么影响。”中，关键术语“Sandbox mode”首次出现缺少英文对照，需补为“沙箱模式（Sandbox mode）”，并保留引用结构。"
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
        if (sourceSection !== null) {
          return createExecResult(
            sourceSection.replace(
              "> Let's now look at what Sandbox mode protects you from.",
              "> 现在让我们看看沙箱模式会保护你免受什么影响。"
            )
          );
        }

        return createExecResult("");
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /> 现在让我们看看沙箱模式（Sandbox mode）会保护你免受什么影响。/);
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

test("translateMarkdownArticle keeps sentence-local Claude repairs away from earlier Claude Code anchors", async () => {
  const source = [
    "# Title",
    "",
    "## Earlier",
    "",
    `${"Claude Code is already established here. ".repeat(240)}`,
    "",
    "## External API Access",
    "",
    "**Test 4: External API Access (Should Prompt First Time)**",
    "",
    "Tell Claude:",
    ""
  ].join("\n");

  class PriorAnchorExecutor extends PromptAwareExecutor {
    override async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      this.prompts.push(prompt);

      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          createAnchorCatalog([
            {
              english: "Claude Code",
              chineseHint: "Claude Code",
              familyKey: "claude code",
              chunkId: "chunk-1",
              segmentId: "chunk-1-segment-1"
            }
          ])
        );
      }

      if (options.outputSchema && prompt.includes("【分段审校输入】") && prompt.includes("Tell Claude:")) {
        return createExecResult(
          wrapPerSegmentAudits(prompt, [
            {
              segment_index: 1,
              audit: createAudit(false, [
                "第4段末句“告诉 Claude Code（Claude）”与原文“Tell Claude:”不一致；需保持原文专名 Claude 的对应，不要额外加入 Code。"
              ])
            }
          ])
        );
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }

      const sourceSection = extractPromptSection(prompt, "【英文原文】");
      return createExecResult(sourceSection ?? "");
    }
  }

  const executor = new PriorAnchorExecutor();
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const repairPrompt = executor.prompts.find(
    (item) =>
      item.includes("【must_fix】") &&
      item.includes("Tell Claude:") &&
      item.includes("不要额外加入 Code")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /必须把这句视为唯一有效落点/);
  assert.match(repairPrompt, /不要把锚定转移到同段其他句子、标题、列表项、引用外说明或后续段落/);
  assert.doesNotMatch(repairPrompt, /本次 must_fix 明确指向标题/);
  assert.doesNotMatch(repairPrompt, /本次 must_fix 明确点名了这些英文目标：.*Claude Code/);
});

test("translateMarkdownArticle keeps the source surface form when Claude and Claude Code share a family", async () => {
  const source = [
    "# Title",
    "",
    "Claude Code is already established earlier in this segment.",
    "",
    "Tell Claude:"
  ].join("\n");

  class ClaudeSurfaceExecutor extends PromptAwareExecutor {
    override async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      this.prompts.push(prompt);

      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          createAnchorCatalog([
            {
              english: "Claude Code",
              chineseHint: "Claude Code",
              familyKey: "claude-family"
            },
            {
              english: "Claude",
              chineseHint: "Anthropic 的 AI 助手",
              familyKey: "claude-family"
            }
          ])
        );
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }

      return createExecResult([
        "# 标题",
        "",
        "Claude Code 已在本段前文建立。",
        "",
        "告诉 Claude Code（Claude）："
      ].join("\n"));
    }
  }

  const result = await translateMarkdownArticle(source, {
    executor: new ClaudeSurfaceExecutor(),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /告诉 Claude/);
  assert.doesNotMatch(result.markdown, /Claude Code（Claude）/);
});

test("translateMarkdownArticle exposes known-entity bare english displays in prompt context", async () => {
  const source = [
    "# Title",
    "",
    "Filesystem permissions control what Claude can access.",
    "",
    "Get this wrong and either security fails or Claude can’t work."
  ].join("\n");

  class ClaudeCanonicalAuditExecutor extends PromptAwareExecutor {
    override async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      this.prompts.push(prompt);

      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          createAnchorCatalog([
            {
              english: "Claude",
              chineseHint: "Anthropic 的 AI 助手",
              familyKey: "claude-family"
            }
          ])
        );
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }

      return createExecResult([
        "# 标题",
        "",
        "文件系统权限决定了 Claude 可以访问什么。",
        "",
        "这里一旦配置错误，要么安全性失效，要么 Claude 无法正常工作。"
      ].join("\n"));
    }
  }

  const executor = new ClaudeCanonicalAuditExecutor();
  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const draftPrompt = executor.prompts.find(
    (prompt) => !isDocumentAnalysisPrompt(prompt) && !prompt.includes("只返回 JSON")
  );
  assert.ok(draftPrompt);
  assert.match(draftPrompt, /Claude \[display=english-only]/);
  assert.match(draftPrompt, /"canonicalDisplay": "Claude"/);
  assert.match(draftPrompt, /"allowedDisplayForms": \[\s*"Claude"\s*]/);
});

test("translateMarkdownArticle tells repair when the same anchor is still missing in multiple locations", async () => {
  const source = [
    "## So, What Do AI Agents Need?",
    "",
    "- Claude, are you reading your SSH keys? Also needs approval.",
    "",
    "**Filesystem Isolation**",
    "",
    "- Blocked zones that are never accessible (SSH keys, AWS credentials)",
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
                  "位置：第 1 条项目符号“Claude，你在读取你的 SSH 密钥吗？这也需要审批。”问题：首次出现的“SSH 密钥”缺少英文对照，需在该句内补齐中英锚定。",
                  "位置：第 4 条项目符号“阻止访问的区域（SSH 密钥、AWS 凭据）”问题：首次出现的“SSH 密钥”缺少英文对照，需在该列表项内补齐中英锚定。"
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
      item.includes("SSH 密钥")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /同一锚点在多个被点名位置仍未修齐/);
  assert.match(repairPrompt, /逐个在各自被点名的句子、引用句、标题或列表项本身补齐/);
  assert.match(repairPrompt, /同一锚点的多个落点需要分别达标/);
});

test("translateMarkdownArticle repeats duplicate-English-anchor guidance when must_fix rejects repeated parenthetical English", async () => {
  const source = [
    "## Getting Started with Sandbox Mode",
    "",
    "### System Requirements",
    "",
    "**Security Frameworks:**",
    "",
    "**Seatbelt** — Works on all recent versions (10.14+)",
    "",
    "- Uses the Seatbelt security framework"
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
                  "位置：`**Seatbelt**` 下第一条列表项；问题：`Seatbelt 安全框架（Seatbelt）` 的首现写法属于英文重复回括，未采用自然的中英锚定；修复目标：改为只保留一次英文原名并配中文说明的首现形式，不要重复回括同一英文词。"
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
      item.includes("Seatbelt 安全框架（Seatbelt）")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /同一个英文原名在同一个首现锚点里只能保留一次/);
  assert.match(repairPrompt, /不要再生成“中文说明（同一英文原名）”/);
  assert.match(repairPrompt, /只保留一次英文原名的写法/);
});

test("translateMarkdownArticle repeats single-layer-parentheses guidance when must_fix rejects nested brackets", async () => {
  const source = [
    "## Credential Theft",
    "",
    "Attempts to access:",
    "",
    "- ~/.ssh/ (SSH keys)",
    "- ~/.aws/ (AWS credentials)",
    "- ~/.config/ (API tokens)"
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
                  "位置：列表第 1 项“~/.ssh/”。问题：译文写成“（SSH 密钥（SSH keys））”，出现双层括号，不符合中文标点习惯。修复目标：改为单层、等价且不嵌套的括注形式。"
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
      item.includes("（SSH 密钥（SSH keys））")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /双层括号或嵌套括注/);
  assert.match(repairPrompt, /必须在这一层括注内部完成中英锚定/);
  assert.match(repairPrompt, /不要生成“（中文（English））”/);
});

test("translateMarkdownArticle repeats plain-path guidance when must_fix rejects newly added inline code", async () => {
  const source = [
    "## Credential Theft",
    "",
    "Attempts to access:",
    "",
    "- ~/.ssh/ (SSH keys)",
    "- ~/.aws/ (AWS credentials)",
    "- ~/.config/ (API tokens)"
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
                  "位置：三个列表项中的路径 `~/.ssh/`、`~/.aws/`、`~/.config/`。问题：译文把原文普通文本路径改成了 inline code，改变了原有 Markdown 结构。修复目标：去掉这些路径外层新增的反引号，保持与原文一致的普通列表文本结构。"
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
      item.includes("原文普通文本路径改成了 inline code")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /擅自把原文普通文本改成了 inline code/);
  assert.match(repairPrompt, /如果原文中的路径、目录名、文件名、URL 片段或命令样式文本本来没有反引号/);
  assert.match(repairPrompt, /不要把路径本身改成代码样式/);
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

test("translateMarkdownArticle repairs multiple must_fix items one at a time", async () => {
  const source = "# Title\n\nBody";
  const repairMustFixSections: string[] = [];
  let auditCallCount = 0;

  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (prompt.includes("【must_fix】")) {
        const mustFixSection = extractPromptSection(prompt, "【must_fix】") ?? "";
        repairMustFixSections.push(mustFixSection.trim());
        return createExecResult("# 标题（Title）\n\n正文");
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult("# 标题（Title）\n\n更自然的正文");
      }

      if (options.outputSchema && prompt.includes("【分段审校输入】")) {
        auditCallCount += 1;
        const audit = auditCallCount === 1
          ? createAudit(false, ["修复项一", "修复项二", "修复项三"])
          : createAudit(true);
        return createExecResult(
          wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit }])
        );
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        return createExecResult(JSON.stringify(createAudit(true)));
      }

      return createExecResult("# 标题\n\n正文");
    }
  });

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.deepEqual(repairMustFixSections, [
    "- 修复项一",
    "- 修复项二",
    "- 修复项三"
  ]);
});

test("translateMarkdownArticle batches mixed-location repairs in the same segment together", async () => {
  const source = [
    "# Title",
    "",
    "> Quote line",
    "",
    "- List item one",
    "- List item two",
    ""
  ].join("\n");
  const repairMustFixSections: string[] = [];
  let auditCallCount = 0;

  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (prompt.includes("【must_fix】")) {
        const mustFixSection = extractPromptSection(prompt, "【must_fix】") ?? "";
        repairMustFixSections.push(mustFixSection.trim());
        return createExecResult(source);
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult(source);
      }

      if (options.outputSchema && prompt.includes("【分段审校输入】")) {
        auditCallCount += 1;
        const audit = auditCallCount === 1
          ? createAudit(false, [
              "第 1、2 条列表项中的 `Claude` 需要在本段首次出现处补中英文对照，不能只保留英文。",
              "最后一条引用中的 `Sandbox mode` 需要补英文原名对应关系，不能只译成“沙盒模式”。"
            ])
          : createAudit(true);
        return createExecResult(
          wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit }])
        );
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        return createExecResult(JSON.stringify(createAudit(true)));
      }

      return createExecResult(source);
    }
  });

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.deepEqual(repairMustFixSections, [
    [
      "- 第 1、2 条列表项中的 `Claude` 需要在本段首次出现处补中英文对照，不能只保留英文。",
      "- 最后一条引用中的 `Sandbox mode` 需要补英文原名对应关系，不能只译成“沙盒模式”。"
    ].join("\n")
  ]);
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

test("translateMarkdownArticle keeps heading-anchor repairs on a bold heading after a lead-in sentence", async () => {
  const source = [
    "# Title",
    "",
    "In a quick summary, here is what autonomous coding agents need:",
    "",
    "**Filesystem Isolation**",
    "",
    "- Safe zone where Claude can work freely",
    "- Restricted zones that require explicit permission",
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
                  "第3段“**文件系统隔离**”未在首次出现处保留 `Filesystem Isolation` 的中英对照；需把双语锚定放回该标题本身。"
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
      item.includes("第3段“**文件系统隔离**”未在首次出现处保留 `Filesystem Isolation` 的中英对照")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /本次 must_fix 明确指向标题/);
  assert.match(repairPrompt, /当前分段包含列表前的说明句、导语句或冒号引导句/);
  assert.match(repairPrompt, /冒号引导句或说明句 \+ 下一行加粗标题\/标题 \+ 后续列表/);
  assert.match(repairPrompt, /必须直接在这个标题本身补齐锚定/);
  assert.match(repairPrompt, /核心概念性英文标题/);
});

test("translateMarkdownArticle splits a short lead-in sentence before a bold concept heading", async () => {
  const source = [
    "# Title",
    "",
    "In a quick summary, here is what autonomous coding agents need:",
    "",
    "**Filesystem Isolation**",
    "",
    "- Safe zone where Claude can work freely",
    "- Restricted zones that require explicit permission",
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
        return createExecResult(
          JSON.stringify({
            blocks: Array.from({ length: blockCount }, () => "占位正文")
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
      const sourceSection = extractPromptSection(prompt, "【英文原文】");
      return createExecResult(sourceSection ?? "");
    }
  });

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const promptBodies = prompts.filter((prompt) => !isDocumentAnalysisPrompt(prompt));
  assert.ok(
    promptBodies.some(
      (prompt) =>
        prompt.includes("In a quick summary, here is what autonomous coding agents need:") &&
        !prompt.includes("**Filesystem Isolation**")
    )
  );
  assert.ok(
    promptBodies.some(
      (prompt) =>
        prompt.includes("**Filesystem Isolation**") &&
        prompt.includes("- Safe zone where Claude can work freely") &&
        !prompt.includes("In a quick summary, here is what autonomous coding agents need:")
    )
  );
});

test("translateMarkdownArticle adds numbered bold-heading guidance for colon-qualified test labels", async () => {
  const source = [
    "# Title",
    "",
    "**Test 2: System File Access**",
    "",
    "Tell Claude:",
    "",
    "Read my .bashrc file and show me the first 5 lines.",
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
                  "位置：分段标题“**测试 2：系统文件访问**”。问题：首次出现的关键术语“System File Access”缺少中英对照。修复目标：在标题中补齐该术语的首现双语锚定。"
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
      item.includes("System File Access") &&
      item.includes("测试 2：系统文件访问")
  );
  assert.ok(repairPrompt);
  assert.match(repairPrompt, /本次 must_fix 明确指向标题/);
  assert.match(repairPrompt, /如果标题本身带有编号标签、测试标签、步骤标签、示例标签或其他冒号前导部分/);
  assert.match(repairPrompt, /必须在这一整行标题里同时保留前导标签和后面的核心英文术语锚点/);
  assert.match(repairPrompt, /不要只把冒号后的英文核心术语翻成中文而漏掉英文原名/);
  assert.match(repairPrompt, /完整保留 `Test 2`、`Step 1`、`Example` 这类前导结构/);
});

test("translateMarkdownArticle restores a structured heading-like anchor after repair even when the model leaves the title unchanged", async () => {
  const source = [
    "# Title",
    "",
    "**Test 2: System File Access**",
    "",
    "Tell Claude:",
    "",
    "Read my .bashrc file and show me the first 5 lines.",
    ""
  ].join("\n");

  let auditCount = 0;
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    "位置：分段标题“**测试 2：系统文件访问**”；问题：首次出现的关键术语“System File Access”缺少中英文对照；修复目标：在标题本身补齐该术语的英文锚定。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(
          [
            "# Title",
            "",
            "**测试 2：系统文件访问**",
            "",
            "告诉 Claude：",
            "",
            "读取我的 `.bashrc` 文件，并显示前 5 行。",
            ""
          ].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /\*\*测试 2：系统文件访问（System File Access）\*\*/);
});

test("translateMarkdownArticle restores a heading-like anchor with a single trailing colon after repair", async () => {
  const source = [
    "# Title",
    "",
    "**Paths:**",
    "",
    "- Absolute: /home/user/projects",
    ""
  ].join("\n");

  let auditCount = 0;
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    "位置：分段标题“路径（Paths：）：”。问题：标点有误，去掉括号内外多余的冒号，恢复为与原文 `Paths:` 对应的单一冒号。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(
          [
            "# Title",
            "",
            "**路径：**",
            "",
            "- 绝对路径：/home/user/projects",
            ""
          ].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /\*\*路径（Paths）：\*\*/);
});

test("translateMarkdownArticle strips full english back-reference from operational headings", async () => {
  const source = [
    "# Title",
    "",
    "**Edit configuration:**",
    "",
    "```\n/config\n```",
    ""
  ].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(
          [
            "# Title",
            "",
            "**编辑配置（Edit configuration）：**",
            "",
            "```\n/config\n```",
            ""
          ].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /\*\*编辑配置：\*\*/);
});

test("translateMarkdownArticle skips duplicate child anchors inside a composite heading", async () => {
  const source = [
    "# Title",
    "",
    "## React/Next.js Web Project Configuration Example",
    "",
    "Body.",
    ""
  ].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(
          [
            "# Title",
            "",
            "## React/Next.js（Next.js（框架））Web 项目配置示例",
            "",
            "正文。",
            ""
          ].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /^## React\/Next\.js Web 项目配置示例$/m);
  assert.doesNotMatch(result.markdown, /Next\.js（Next\.js（框架））/);
});

test("translateMarkdownArticle restores an ATX heading anchor after repair when must_fix only names the translated heading", async () => {
  const source = [
    "# Title",
    "",
    "### Credential Theft",
    "",
    "Attempts to access:",
    ""
  ].join("\n");

  let auditCount = 0;
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    "`### 凭证窃取`：这是本分段首次出现的关键术语，小标题需补英文对照后再用。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["# Title", "", "### 凭证窃取", "", "尝试访问：", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /### 凭证窃取（Credential Theft）/);
});

test("translateMarkdownArticle restores the canonical bilingual display for an exact ATX heading after repair", async () => {
  const source = [
    "# Title",
    "",
    "### Accidental Destructive Operations",
    "",
    "Body.",
    ""
  ].join("\n");

  let auditCount = 0;
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "Accidental Destructive Operations",
                chineseHint: "意外的破坏性操作",
                familyKey: "accidental-destructive-operations"
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
                    "位置：第 4 段标题“### 误删破坏（Accidental Destructive Operations）”；问题：英文括注与前文已建立的锚点不一致；修复目标：改回与既有锚点一致的双语形式。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["# Title", "", "### 误删破坏（Accidental Destructive Operations）", "", "正文。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /### 意外的破坏性操作（Accidental Destructive Operations）/);
});

test("translateMarkdownArticle restores missing source heading qualifiers inside category-style headings", async () => {
  const source = [
    "# Title",
    "",
    "### Category 2: Prompted (Requires Permission)",
    "",
    "Body.",
    ""
  ].join("\n");

  let auditCount = 0;
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    "位置：### 第 2 类：提示式（Prompted）。问题：缺少源文标题括注“Requires Permission”的对应信息。修复目标：补齐该标题的中英文对照，且不改动结构。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["# Title", "", "### 第 2 类：提示式（Prompted）", "", "正文。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /### 第 2 类：提示式（Prompted，Requires Permission）/);
});

test("translateMarkdownArticle restores a named anchor inside an ATX heading after repair", async () => {
  const source = [
    "# Title",
    "",
    "## How Sandbox Mode Changes Autonomous Coding",
    "",
    "Body.",
    ""
  ].join("\n");

  let auditCount = 0;
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "Sandbox Mode",
                chineseHint: "沙箱模式",
                familyKey: "sandbox-mode"
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
                    "位置：## 标题“沙箱模式如何改变自主编码”｜问题：首现术语 Sandbox Mode 未补中英文对照｜修复目标：在标题本身建立该术语的双语锚点。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["# Title", "", "## 沙箱模式如何改变自主编码", "", "正文。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /## 沙盒模式（Sandbox Mode）如何改变自主编码/);
});

test("translateMarkdownArticle keeps a source-shaped english-primary heading during repair", async () => {
  const source = [
    "# Title",
    "",
    "**Option 2: cco Sandbox**",
    "",
    "Body.",
    ""
  ].join("\n");

  let auditCount = 0;
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "cco Sandbox",
                chineseHint: "cco 沙箱工具",
                category: "tool",
                familyKey: "cco-sandbox"
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
                    "位置：分段标题“**选项 2：cco Sandbox（cco Sandbox（cco 沙箱工具））**”；问题：标题首现锚定格式错误；修复目标：保留标题结构并修复为合法的首现形式。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["# Title", "", "**选项 2：cco Sandbox（cco Sandbox（cco 沙箱工具））**", "", "正文。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /\*\*选项 2：cco Sandbox\*\*/);
  assert.doesNotMatch(result.markdown, /cco Sandbox（cco Sandbox/);
});

test("translateMarkdownArticle restores concept english-primary headings to bilingual canonical form", async () => {
  const source = [
    "# Title",
    "",
    "**Network Isolation**",
    "",
    "Body.",
    ""
  ].join("\n");

  let auditCount = 0;
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "Network Isolation",
                chineseHint: "网络隔离",
                familyKey: "network-isolation",
                displayPolicy: "english-primary",
                chunkId: "chunk-1",
                segmentId: "chunk-1-segment-1"
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
                    "当前分段标题“**Network Isolation**”首次出现需补中英对照，修复目标是改为合法锚定形式“Network Isolation（网络隔离）”。"
                  ])
                }
              ])
            );
          }

          return createExecResult(
            wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["# Title", "", "**Network Isolation**", "", "正文。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /\*\*Network Isolation（网络隔离）\*\*/);
});

test("translateMarkdownArticle prefers explicit chinese canonical repair targets over incidental english mentions", async () => {
  const source = [
    "# Title",
    "",
    "## Sandbox Mode",
    "",
    "Claude Code sandboxes create OS-level restrictions.",
    ""
  ].join("\n");

  let auditCount = 0;
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "Claude",
                chineseHint: "Anthropic 的 AI 助手",
                familyKey: "claude",
                displayPolicy: "english-only"
              },
              {
                english: "Claude Code",
                chineseHint: "Anthropic 的命令行编码助手",
                familyKey: "claude"
              },
              {
                english: "Sandbox Mode",
                chineseHint: "沙盒模式",
                familyKey: "sandbox-mode"
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
                    "在“## 沙盒模式（Sandbox Mode）”下的首句，将“Claude Code 沙盒”改为与全文锚点一致的“沙盒模式”术语形式，避免缩写成“沙盒”。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(
          ["# Title", "", "## 沙盒模式（Sandbox Mode）", "", "Claude Code 沙盒会创建操作系统级限制。", ""].join(
            "\n"
          )
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /沙盒模式会创建操作系统级限制。/);
  assert.doesNotMatch(result.markdown, /Claude Code 沙盒/);
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

test("translateMarkdownArticle suppresses a short-anchor must_fix when a longer anchored phrase already covers it in the same list item", async () => {
  const source = [
    "## So, What Do AI Agents Need?",
    "",
    "- Pre-approved destinations (npm registry, GitHub, your APIs)",
    ""
  ].join("\n");

  const executor = new PromptAwareExecutor();
  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        executor.prompts.push(prompt);

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(false, [
                  "第 1 个项目符号“预先批准的目标位置（npm 包仓库（npm registry）、GitHub（代码托管平台）、你的 API）”中的 `npm` 首现未完成中英对照；需在此处直接补成带中文说明的自然锚点，不能等到后文再补。"
                ])
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const sourceSection = extractPromptSection(prompt, "【英文原文】");
        if (sourceSection !== null) {
          return createExecResult(
            sourceSection.replace(
              "- Pre-approved destinations (npm registry, GitHub, your APIs)",
              "- 预先批准的目标位置（npm 包仓库（npm registry）、GitHub（代码托管平台）、你的 API）"
            )
          );
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        return createExecResult(currentTranslation ?? "");
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /npm 包仓库（npm registry）/);
  const repairPrompt = executor.prompts.find((item) => item.includes("【must_fix】") && item.includes("`npm`"));
  assert.equal(repairPrompt, undefined);
});

test("translateMarkdownArticle synthesizes missing first-mention repair tasks when audit omits one of multiple locations", async () => {
  const source = [
    "### Category 1: Auto-Allowed (No Prompts)",
    "",
    "- npm/pip/cargo package registries (default allowlist)",
    "- ~/.aws/credentials (AWS credentials)",
    ""
  ].join("\n");

  class MultiLocationAuditExecutor extends PromptAwareExecutor {
    readonly repairPrompts: string[] = [];

    override async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }

      if (options.outputSchema && prompt.includes("【分段审校输入】")) {
        return createExecResult(
          wrapPerSegmentAudits(prompt, [
            {
              segment_index: 1,
              audit: createAudit(
                false,
                ["第 10 块，`~/.aws/credentials (AWS credentials)`：`AWS credentials` 首次出现未完成中英文对照，需在该条目内补齐首现锚定。"],
                {
                  first_mention_bilingual: {
                    pass: false,
                    problem:
                      "第 10 块 / `npm/pip/cargo package registries (default allowlist)` 与 `~/.aws/credentials (AWS credentials)` 两处首次出现的工具/专名未完整建立中英文对照。"
                  }
                }
              )
            }
          ])
        );
      }

      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        return createExecResult(JSON.stringify(createAudit(true)));
      }

      if (prompt.includes("【must_fix】")) {
        this.repairPrompts.push(prompt);
        return createExecResult(extractPromptSection(prompt, "【当前译文】") ?? "");
      }

      return createExecResult([
        "### 第 1 类：自动允许（无需提示）",
        "",
        "- npm/pip/cargo 包注册表（默认允许列表）",
        "- ~/.aws/credentials（AWS 凭据）",
        ""
      ].join("\n"));
    }
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "mdzh-multi-location-repair-"));
  const debugStatePath = path.join(tempDir, "state.json");
  const previousDebugStatePath = process.env.MDZH_DEBUG_STATE_PATH;
  process.env.MDZH_DEBUG_STATE_PATH = debugStatePath;

  const executor = new MultiLocationAuditExecutor();
  try {
    const result = await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown
    });

    assert.ok(result.markdown.length > 0);
    const savedState = JSON.parse(await readFile(debugStatePath, "utf8")) as {
      anchors: Array<{ english: string }>;
    };
    assert.ok(
      savedState.anchors.some((anchor) => anchor.english === "cargo")
    );
  } finally {
    if (previousDebugStatePath === undefined) {
      delete process.env.MDZH_DEBUG_STATE_PATH;
    } else {
      process.env.MDZH_DEBUG_STATE_PATH = previousDebugStatePath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("translateMarkdownArticle does not let explicit package-registry wording override an established semantic anchor", async () => {
  const source = [
    "### Supply Chain Attacks",
    "",
    "Use the npm registry for package downloads.",
    "",
    "The npm registry remains the only allowed destination.",
    ""
  ].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createEmptyAnchorCatalog());
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(true)
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        return createExecResult([
          "### 供应链攻击",
          "",
          "使用 npm 注册表进行包下载。",
          "",
          "npm 注册表仍然是唯一允许的目标。",
          ""
        ].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /npm 注册表（npm registry）/);
  assert.doesNotMatch(result.markdown, /包注册源/);
});

test("translateMarkdownArticle does not let generic package-registry normalization choose the meaning of approved registries", async () => {
  const source = [
    "### Supply Chain Attacks",
    "",
    "Sandbox blocks file access outside the project directory and restricts network connections to approved registries.",
    ""
  ].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createEmptyAnchorCatalog());
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(true)
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        return createExecResult([
          "### 供应链攻击",
          "",
          "沙盒会阻止访问项目目录之外的文件，并将网络连接限制到已批准的注册表。",
          ""
        ].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /已批准的注册表/);
  assert.doesNotMatch(result.markdown, /包注册源/);
});

test("translateMarkdownArticle does not rewrite generic registry text outside package dependency context", async () => {
  const source = [
    "### Windows Internals",
    "",
    "The Windows registry stores system configuration values.",
    ""
  ].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createEmptyAnchorCatalog());
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(true)
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        return createExecResult([
          "### Windows Internals",
          "",
          "Windows 注册表存储系统配置值。",
          ""
        ].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /Windows 注册表存储系统配置值/);
  assert.doesNotMatch(result.markdown, /包注册源/);
});

test("translateMarkdownArticle does not let generic registry normalization override a satisfied semantic anchor", async () => {
  const source = ["- Pre-approved destinations (npm registry, GitHub, your APIs)", ""].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "npm registry",
                chineseHint: "npm 注册表",
                familyKey: "npm-registry",
                displayPolicy: "chinese-primary"
              }
            ])
          );
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(true)
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        return createExecResult(["- 预先批准的目标位置（npm 注册表（npm registry）、GitHub、你的 API）", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /npm 注册表（npm registry）/);
  assert.doesNotMatch(result.markdown, /npm 包注册源/);
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

test("translateMarkdownArticle restores translatable strong emphasis from LLM emphasis plans", async () => {
  const source = [
    "# Title",
    "",
    "Claude Code **now has a sandbox mode** that changes the workflow.",
    ""
  ].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog(
              [],
              [],
              [
                {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1",
                  emphasisIndex: 1,
                  lineIndex: 1,
                  sourceText: "now has a sandbox mode",
                  strategy: "preserve-strong",
                  targetText: "现在有了沙盒模式（sandbox mode）",
                  governedTerms: ["sandbox mode"]
                }
              ]
            )
          );
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(true)
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        return createExecResult(["# Title", "", "Claude Code 现在有了沙盒模式，改变了工作流。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /\*\*现在有了沙盒模式（sandbox mode）\*\*/);
});

test("translateMarkdownArticle recovers missing emphasis plans before drafting", async () => {
  const source = [
    "# Title",
    "",
    "Claude Code **now has a sandbox mode** that changes the workflow.",
    ""
  ].join("\n");

  let analysisCalls = 0;

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          analysisCalls += 1;
          if (prompt.includes('"mode": "emphasis-recovery"')) {
            return createExecResult(
              JSON.stringify({
                emphasisPlans: [
                  {
                    chunkId: "chunk-1",
                    segmentId: "chunk-1-segment-1",
                    emphasisIndex: 1,
                    lineIndex: 1,
                    sourceText: "now has a sandbox mode",
                    strategy: "preserve-strong",
                    targetText: "现在有了沙盒模式（sandbox mode）",
                    governedTerms: ["sandbox mode"]
                  }
                ]
              })
            );
          }
          return createExecResult(createEmptyAnchorCatalog());
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          return createExecResult(
            wrapPerSegmentAudits(prompt, [
              {
                segment_index: 1,
                audit: createAudit(true)
              }
            ])
          );
        }

        if (options.outputSchema || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        return createExecResult(["# Title", "", "Claude Code 现在有了沙盒模式，改变了工作流。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.ok(analysisCalls >= 2);
  assert.match(result.markdown, /\*\*现在有了沙盒模式（sandbox mode）\*\*/);
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

test("translateMarkdownArticle fails immediately when protected span integrity is broken", async () => {
  const source = "# Title\n\nBody";
  const brokenAudit = JSON.stringify(
    createAudit(false, ["占位符被改写"], {
      protected_span_integrity: { pass: false, problem: "占位符 @@MDZH_INLINE_CODE_0001@@ 被改写。" }
    })
  );
  const executor = new StubExecutor(["# 标题\n\n正文", brokenAudit]);

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

  assert.equal(executor.prompts.filter((prompt) => !isDocumentAnalysisPrompt(prompt)).length, 2);
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

test("translateMarkdownArticle synthesizes a local fallback anchor for a longer english qualifier named by repair", async () => {
  const source = "- Pre-approved destinations (npm registry, GitHub, your APIs)\n";
  let auditCount = 0;

  const executor: CodexExecutor = {
    async execute(prompt, options) {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          createAnchorCatalog([
            {
              english: "npm",
              chineseHint: "npm",
              familyKey: "npm",
              displayPolicy: "english-only"
            },
            {
              english: "GitHub",
              chineseHint: "GitHub",
              familyKey: "github",
              displayPolicy: "english-only"
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
                  "第 1 个项目符号需保留 `npm registry` 这一限定，不要只写成 `npm`。"
                ])
              }
            ])
          );
        }

        return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
      }

      if (prompt.includes("【必须修复】")) {
        const currentTranslation = extractPromptSection(prompt, "【当前译文】") ?? "";
        return createExecResult(currentTranslation);
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(JSON.stringify(createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }

      return createExecResult("- 预先批准的目标位置（npm、GitHub、你的 API）");
    }
  };

  const output = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.match(output.markdown, /npm registry/);
  assert.doesNotMatch(output.markdown, /预先批准的目标位置（npm、GitHub/);
});

test("translateMarkdownArticle does not duplicate an already satisfied structured bilingual target across repair cycles", async () => {
  const source = "- Pre-approved destinations (npm registry, GitHub, your APIs)\n";
  let auditCount = 0;

  const output = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createEmptyAnchorCatalog());
        }

        if (isBundledAuditPrompt(prompt, options)) {
          auditCount += 1;
          if (auditCount <= 2) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: {
                    ...createAudit(false, [
                      "第 15 个项目符号中的“你的 API（应用程序编程接口）”重复了括注，只保留一组括注。"
                    ]),
                    repair_targets: [
                      {
                        location: "第 15 个项目符号",
                        kind: "list_item",
                        currentText: "API",
                        targetText: "API（应用程序编程接口）",
                        english: "API",
                        chineseHint: "应用程序编程接口"
                      }
                    ]
                  }
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (prompt.includes("【必须修复】")) {
          return createExecResult(extractPromptSection(prompt, "【当前译文】") ?? "");
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult("- 预先批准的目标位置（npm registry、GitHub、你的 API）");
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(output.markdown, /你的 API（应用程序编程接口）/);
  assert.doesNotMatch(output.markdown, /应用程序编程接口）\s*（应用程序编程接口/);
});

test("translateMarkdownArticle synthesizes a local fallback anchor for an inline concept named by repair", async () => {
  const source = '> This creates what security researchers call "approval fatigue."\n';
  let auditCount = 0;

  const output = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createAnchorCatalog([]));
        }

        if (isBundledAuditPrompt(prompt, options)) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    '位置：第 1 个引用段“这就造成了安全研究人员所说的‘批准疲劳’效应。”问题：术语“approval fatigue”首次出现时缺少英文对照。修复目标：在该句内为“批准疲劳”建立合法的中英文首现对应。'
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (prompt.includes("【必须修复】")) {
          const currentTranslation = extractPromptSection(prompt, "【当前译文】") ?? "";
          return createExecResult(currentTranslation);
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult("> 这就造成了安全研究人员所说的“批准疲劳”效应。");
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(output.markdown, /批准疲劳（approval fatigue）/);
});

test("translateMarkdownArticle infers an inline concept local fallback anchor from quoted location text", async () => {
  const source = '> This creates what security researchers call "approval fatigue."\n';
  let auditCount = 0;

  const output = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createAnchorCatalog([]));
        }

        if (isBundledAuditPrompt(prompt, options)) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    '位置：第二段引用“这就造成了安全研究人员所说的‘审批疲劳’……”。问题：术语 approval fatigue 在全文当前分块首次出现时未建立中英文对照。修复目标：在该引用句内为该术语补齐合法的首现中英文锚定，且不要把整句英文原文整句括注进去。'
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (prompt.includes("【must_fix】")) {
          const currentTranslation = extractPromptSection(prompt, "【当前译文】") ?? "";
          return createExecResult(currentTranslation);
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult("> 这就造成了安全研究人员所说的“审批疲劳”……");
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(output.markdown, /审批疲劳（approval fatigue）/);
});

test("translateMarkdownArticle rewrites an alias first mention to the canonical concept display inside a quoted sentence", async () => {
  const source = [
    '> Sandbox works by separating these two cases.',
    "",
    "## What Sandbox Mode Protects Against",
    "",
    "Sandbox mode addresses real attack vectors.",
    ""
  ].join("\n");
  let auditCount = 0;

  const output = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "sandbox mode",
                chineseHint: "沙盒模式",
                familyKey: "sandbox-mode",
                displayPolicy: "chinese-primary",
                chunkId: "chunk-1",
                segmentId: "chunk-1-segment-1"
              }
            ])
          );
        }

        if (isBundledAuditPrompt(prompt, options)) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    '位置：引用段“Sandbox 的工作方式，就是把这两种情况区分开来。”；问题：Sandbox 在本分段中先于“沙盒模式（sandbox mode）”出现，但未在首次出现处建立稳定的中英对应；修复目标：在该引用句内就地补齐并与后文“沙盒模式（sandbox mode）”保持同一概念锚定，不要把修复转移到后文标题或正文。'
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (prompt.includes("【必须修复】")) {
          const currentTranslation = extractPromptSection(prompt, "【当前译文】") ?? "";
          return createExecResult(currentTranslation);
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult([
          '> Sandbox 的工作方式，就是把这两种情况区分开来。',
          "",
          "## 沙盒模式保护什么",
          "",
          "沙盒模式可以处理真实的攻击向量。",
          ""
        ].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(output.markdown, /沙盒模式（[Ss]andbox mode）的工作方式，就是把这两种情况区分开来/);
  assert.match(output.markdown, /## 沙盒模式（[Ss]andbox mode）保护什么/);
});

test("translateMarkdownArticle reifies a blockquote alias repair target from must_fix when analysis misses the alias plan", async () => {
  const source = [
    "> System permissions, by design, don’t distinguish between these scenarios. The Sandbox works by differentiating between these two cases.",
    "",
    "## How Sandbox Mode Changes Autonomous Coding",
    "",
    "Sandbox mode creates operating system-level restrictions.",
    ""
  ].join("\n");
  let auditCount = 0;

  const output = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "sandbox mode",
                chineseHint: "沙盒模式",
                familyKey: "sandbox-mode",
                displayPolicy: "chinese-primary",
                chunkId: "chunk-1",
                segmentId: "chunk-1-segment-1"
              }
            ])
          );
        }

        if (isBundledAuditPrompt(prompt, options)) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    "位置：第 4 个块引用句。问题：首次出现的关键术语“沙盒模式”未完成中英对照。修复目标：在该引用句内补为“沙盒模式（sandbox mode）”，不要把修复转移到后文标题或正文。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (prompt.includes("【必须修复】")) {
          const currentTranslation = extractPromptSection(prompt, "【当前译文】") ?? "";
          return createExecResult(currentTranslation);
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(
          [
            "> 系统权限在设计上并不会区分这些场景。沙盒的工作方式，就是把这两种情况区分开来。",
            "",
            "## 沙盒模式如何改变自主编码",
            "",
            "沙盒模式会创建操作系统级的限制。",
            ""
          ].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(output.markdown, /沙盒模式（sandbox mode）的工作方式，就是把这两种情况区分开来/);
});

test("translateMarkdownArticle avoids duplicating chinese suffixes when an alias target already contains the full canonical display", async () => {
  const source = ["Sandbox mode addresses real attack vectors.", ""].join("\n");

  const output = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog(
              [],
              [],
              [],
              [],
              [
                {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1",
                  sourceText: "Sandbox mode addresses real attack vectors.",
                  currentText: "沙盒",
                  english: "Sandbox",
                  targetText: "沙盒模式（sandbox mode）",
                  lineIndex: 1,
                  scope: "sentence-local"
                }
              ]
            )
          );
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["沙盒模式处理真实的攻击向量。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(output.markdown, /沙盒模式（sandbox mode）处理真实的攻击向量。/);
  assert.doesNotMatch(output.markdown, /沙盒模式（sandbox mode）模式/);
});

test("translateMarkdownArticle applies alias plans during draft normalization without relying on repair text", async () => {
  const source = ["> The Sandbox works by separating these two cases.", ""].join("\n");

  const output = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog(
              [
                {
                  english: "sandbox mode",
                  chineseHint: "沙盒模式",
                  familyKey: "sandbox-mode",
                  displayPolicy: "chinese-primary"
                }
              ],
              [],
              [],
              [],
              [
                {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1",
                  sourceText: "The Sandbox works by separating these two cases.",
                  currentText: "沙盒",
                  english: "Sandbox",
                  targetText: "沙盒（Sandbox）",
                  lineIndex: 1,
                  scope: "sentence-local"
                }
              ]
            )
          );
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["> 沙盒的工作方式，就是把这两种情况区分开来。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(output.markdown, /> 沙盒（Sandbox）的工作方式，就是把这两种情况区分开来。/);
});

test("translateMarkdownArticle applies entity disambiguation plans before product-family canonicalization", async () => {
  const source = ["This is not Claude code by default.", ""].join("\n");

  const output = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog(
              [],
              [],
              [],
              [],
              [],
              [
                {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1",
                  sourceText: "This is not Claude code by default.",
                  english: "Claude code",
                  targetText: "Claude 代码",
                  forbiddenDisplays: ["Claude Code（Anthropic 的命令行编码助手）", "Claude Code"],
                  lineIndex: 1,
                  scope: "sentence-local"
                }
              ]
            )
          );
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["这默认不是 Claude Code（Anthropic 的命令行编码助手）。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(output.markdown, /这默认不是 Claude 代码。/);
  assert.doesNotMatch(output.markdown, /Anthropic 的命令行编码助手/);
});

test("translateMarkdownArticle synthesizes heading-local fallback anchors for configuration titles named by repair", async () => {
  const source = [
    "# Title",
    "",
    "## Filesystem Permissions (Critical )",
    "",
    "Filesystem permissions control what Claude can access.",
    "",
    "**Permission Pattern Syntax**",
    ""
  ].join("\n");
  let auditCount = 0;

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createAnchorCatalog([]));
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    "位置：`## 文件系统权限（关键）`。问题：首次出现的关键术语 `Filesystem Permissions` 未保留中英对照。修复目标：在标题内补成合法的中英锚定形式。",
                    "位置：`**权限模式语法**`。问题：首次出现的关键术语 `Permission Pattern Syntax` 未保留中英对照。修复目标：在该标题内补成合法的中英锚定形式。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (prompt.includes("【必须修复】")) {
          const currentTranslation = extractPromptSection(prompt, "【当前译文】") ?? "";
          return createExecResult(currentTranslation);
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
            "# Title",
            "",
            "## 文件系统权限（关键）",
            "",
            "文件系统权限控制 Claude 可以访问什么。",
            "",
            "**权限模式语法**",
            ""
          ].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /## 文件系统权限（Filesystem Permissions）（关键）/);
  assert.match(result.markdown, /\*\*权限模式语法（Permission Pattern Syntax）\*\*/);
});

test("translateMarkdownArticle synthesizes structured repair targets from explicit bilingual heading goals", async () => {
  const source = [
    "# Title",
    "",
    "## Filesystem Permissions (Critical )",
    "",
    "Filesystem permissions control what Claude can access.",
    "",
    "**Permission Pattern Syntax**",
    ""
  ].join("\n");
  let auditCount = 0;

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createAnchorCatalog([]));
        }

        if (options.outputSchema && prompt.includes("【分段审校输入】")) {
          auditCount += 1;
          if (auditCount === 1) {
            return createExecResult(
              wrapPerSegmentAudits(prompt, [
                {
                  segment_index: 1,
                  audit: createAudit(false, [
                    "第 2 个标题“权限模式语法”未按首现要求保留英文对照，需改为“权限模式语法（Permission Pattern Syntax）”。"
                  ])
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (prompt.includes("【必须修复】")) {
          const currentTranslation = extractPromptSection(prompt, "【当前译文】") ?? "";
          return createExecResult(currentTranslation);
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
            "# Title",
            "",
            "## 文件系统权限（关键）",
            "",
            "文件系统权限控制 Claude 可以访问什么。",
            "",
            "**权限模式语法**",
            ""
          ].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /\*\*权限模式语法（Permission Pattern Syntax）\*\*/);
});

test("translateMarkdownArticle restores heading hints through planning before repair text exists", async () => {
  const source = [
    "# Title",
    "",
    "## Filesystem Permissions (Critical )",
    "",
    "Filesystem permissions control what Claude can access.",
    "",
    "**Permission Pattern Syntax**",
    "",
    "**Paths:**",
    ""
  ].join("\n");
  let auditedTranslation = "";

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(createAnchorCatalog([]));
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          auditedTranslation = extractPromptSection(prompt, "【当前译文】") ?? "";
          return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(
          [
            "# Title",
            "",
            "## 文件系统权限（关键）",
            "",
            "文件系统权限控制 Claude 可以访问什么。",
            "",
            "**权限模式语法**",
            "",
            "**路径：**",
            ""
          ].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(auditedTranslation, /## 文件系统权限（Filesystem Permissions）（关键）/);
  assert.match(auditedTranslation, /\*\*权限模式语法（Permission Pattern Syntax）\*\*/);
  assert.match(auditedTranslation, /\*\*路径（Paths）：\*\*/);
  assert.match(result.markdown, /## 文件系统权限（Filesystem Permissions）（关键）/);
  assert.match(result.markdown, /\*\*权限模式语法（Permission Pattern Syntax）\*\*/);
  assert.match(result.markdown, /\*\*路径（Paths）：\*\*/);
});

test("translateMarkdownArticle prefers LLM heading plans over heuristic heading planning", async () => {
  const source = ["# Title", "", "**Glob Patterns:**", "", "**Examples:**", ""].join("\n");
  let auditedTranslation = "";

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog(
              [],
              [
                {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1",
                  headingIndex: 1,
                  sourceHeading: "Glob Patterns:",
                  strategy: "mixed-qualifier",
                  targetHeading: "Glob 模式（Patterns）：",
                  governedTerms: ["Patterns"],
                  english: "Patterns",
                  chineseHint: "模式",
                  displayPolicy: "chinese-primary"
                },
                {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1",
                  headingIndex: 2,
                  sourceHeading: "Examples:",
                  strategy: "none",
                  targetHeading: "示例：",
                  governedTerms: []
                }
              ]
            )
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

        return createExecResult(["# Title", "", "**Glob 模式：**", "", "**示例：**", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(auditedTranslation, /\*\*Glob 模式（Patterns）：\*\*/);
  assert.match(auditedTranslation, /\*\*示例：\*\*/);
  assert.match(result.markdown, /\*\*Glob 模式（Patterns）：\*\*/);
  assert.match(result.markdown, /\*\*示例：\*\*/);
});

test("translateMarkdownArticle executes LLM natural-heading plans directly", async () => {
  const source = ["# Title", "", "## Claude Code Permission Problem", ""].join("\n");
  let auditedTranslation = "";

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog(
              [
                {
                  english: "Claude Code Sandbox",
                  chineseHint: "沙盒模式",
                  familyKey: "claude code sandbox mode",
                  displayPolicy: "chinese-primary"
                }
              ],
              [
                {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1",
                  headingIndex: 1,
                  sourceHeading: "Claude Code Permission Problem",
                  strategy: "natural-heading",
                  targetHeading: "Claude Code 的权限问题",
                  governedTerms: ["Claude Code", "Permission Problem"]
                }
              ]
            )
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

        return createExecResult(["# Title", "", "## 权限问题", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(auditedTranslation, /## Claude Code 的权限问题/);
  assert.doesNotMatch(auditedTranslation, /Permission Problem/u);
  assert.match(result.markdown, /## Claude Code 的权限问题/);
});

test("translateMarkdownArticle falls back to a known global anchor when a headingPlan is missing", async () => {
  const source = ["# Title", "", "### Prompt Injection Attacks", ""].join("\n");
  let auditedTranslation = "";

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "prompt injection attacks",
                chineseHint: "提示注入攻击",
                familyKey: "prompt-injection",
                displayPolicy: "chinese-primary",
                chunkId: "chunk-1",
                segmentId: "chunk-1-segment-1"
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

        return createExecResult(["# Title", "", "### 提示注入攻击", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(auditedTranslation, /### 提示注入攻击（Prompt Injection Attacks）/);
  assert.match(result.markdown, /### 提示注入攻击（Prompt Injection Attacks）/);
});

test("translateMarkdownArticle reconciles a conflicting heading plan with an exact global anchor", async () => {
  const source = ["# Title", "", "### Prompt Injection Attacks", ""].join("\n");
  let auditedTranslation = "";

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog(
              [
                {
                  english: "prompt injection attacks",
                  chineseHint: "提示注入攻击",
                  familyKey: "prompt-injection",
                  displayPolicy: "chinese-primary",
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1"
                }
              ],
              [
                {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1",
                  headingIndex: 1,
                  sourceHeading: "Prompt Injection Attacks",
                  strategy: "concept",
                  targetHeading: "提示注入攻击",
                  english: "Prompt Injection Attacks",
                  chineseHint: "提示注入攻击",
                  displayPolicy: "chinese-primary"
                }
              ],
              [],
              [
                {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1",
                  blockIndex: 1,
                  blockKind: "heading",
                  sourceText: "### Prompt Injection Attacks",
                  targetText: "### 提示注入攻击"
                }
              ]
            )
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

        return createExecResult(["# Title", "", "### 提示注入攻击", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(auditedTranslation, /### 提示注入攻击（Prompt Injection Attacks）/);
  assert.match(result.markdown, /### 提示注入攻击（Prompt Injection Attacks）/);
});

test("translateMarkdownArticle applies block plan target text to prevent duplicated paragraph content", async () => {
  const source = [
    "## Alternative Solutions (Windows)",
    "",
    "Native sandbox works great on macOS and Linux. But what about Windows developers?",
    "",
    "Docker containers provide complete environment isolation that works on any OS — including Windows.",
    "",
    "**Option 1: claude-code-sandbox**",
    ""
  ].join("\n");

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog(
              [],
              [],
              [],
              [
                {
                  chunkId: "chunk-1",
                  segmentId: "chunk-1-segment-1",
                  blockIndex: 2,
                  blockKind: "paragraph",
                  sourceText:
                    "Docker containers provide complete environment isolation that works on any OS — including Windows.",
                  targetText: "Docker 容器提供适用于任何操作系统（包括 Windows）的完整环境隔离。"
                }
              ]
            )
          );
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(
          [
            "## 替代方案（Windows）",
            "",
            "原生沙盒在 macOS 和 Linux 上效果很好。但 Windows 开发者怎么办？",
            "",
            "原生沙盒在 macOS 和 Linux 上效果很好。但 Windows 开发者怎么办？",
            "",
            "**选项 1：claude-code-sandbox**",
            ""
          ].join("\n")
        );
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /Docker 容器提供适用于任何操作系统（包括 Windows）的完整环境隔离。/);
  assert.doesNotMatch(
    result.markdown,
    /原生沙盒在 macOS 和 Linux 上效果很好。但 Windows 开发者怎么办？\n\n原生沙盒在 macOS 和 Linux 上效果很好。但 Windows 开发者怎么办？/
  );
});

test("translateMarkdownArticle prefers the global canonical display over a conflicting local structured target", async () => {
  const source = ["# Title", "", "Claude Code works here.", ""].join("\n");
  let auditCount = 0;

  const result = await translateMarkdownArticle(source, {
    executor: createP2CompatibleExecutor({
      async execute(prompt, options) {
        if (isDocumentAnalysisPrompt(prompt)) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "Claude Code",
                chineseHint: "Anthropic 的命令行编码助手",
                familyKey: "claude",
                displayPolicy: "english-primary",
                chunkId: "chunk-1",
                segmentId: "chunk-1-segment-1"
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
                  audit: {
                    ...createAudit(false, [
                      "第 1 个正文句中 `Claude Code` 的首现写成了 `Claude Code（Anthropic 的命令行编码助手）（Claude 代码工具）`，多出一层重复括注，需改成单一合法锚定形式。"
                    ]),
                    repair_targets: [
                      {
                        location: "第 1 个正文句",
                        kind: "sentence",
                        currentText: "Claude Code（Anthropic 的命令行编码助手）（Claude 代码工具）",
                        targetText: "Claude Code（Claude 代码工具）",
                        english: "Claude Code",
                        chineseHint: "Claude 代码工具"
                      }
                    ]
                  }
                }
              ])
            );
          }

          return createExecResult(wrapPerSegmentAudits(prompt, [{ segment_index: 1, audit: createAudit(true) }]));
        }

        if (prompt.includes("【必须修复】")) {
          return createExecResult(["# Title", "", "Claude Code（Anthropic 的命令行编码助手）（Claude 代码工具）在此工作。", ""].join("\n"));
        }

        if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
          return createExecResult(JSON.stringify(createAudit(true)));
        }

        const currentTranslation = extractPromptSection(prompt, "【当前译文】");
        if (currentTranslation !== null) {
          return createExecResult(currentTranslation);
        }

        return createExecResult(["# Title", "", "Claude Code 在此工作。", ""].join("\n"));
      }
    }),
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /Claude Code（Anthropic 的命令行编码助手）在此工作。/);
  assert.doesNotMatch(result.markdown, /Claude 代码工具/);
  assert.doesNotMatch(result.markdown, /Anthropic 的命令行编码助手）\s*（/);
});

test("translateMarkdownArticle does not inject required anchors into command phrases", async () => {
  const source = ["**Commands:**", "", "- git status, git log, git diff", "- python script.py (runs code in project)", ""].join(
    "\n"
  );
  let auditedTranslation = "";

  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          createAnchorCatalog([
            {
              english: "Git",
              chineseHint: "版本控制工具",
              familyKey: "git"
            },
            {
              english: "Python",
              chineseHint: "python",
              familyKey: "python"
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

      return createExecResult(["**命令（Commands）：**", "", "- git status、git log、git diff", "- python script.py（在项目中运行代码）"].join("\n"));
    }
  });

  const output = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.match(auditedTranslation, /- git status、git log、git diff/);
  assert.match(auditedTranslation, /- python script\.py（在项目中运行代码）/);
  assert.doesNotMatch(auditedTranslation, /Git（版本控制工具）status/);
  assert.doesNotMatch(auditedTranslation, /Python（python）脚本 script\.py/);
  assert.match(output.markdown, /- git status、git log、git diff/);
  assert.match(output.markdown, /- python script\.py（在项目中运行代码）/);
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

test("translateMarkdownArticle reports known-entity analysis stages to progress hooks", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "mdzh-known-entity-progress-"));
  const candidatePath = path.join(tempDir, "known_entities_candidates.json");
  const previous = process.env.MDZH_KNOWN_ENTITIES_CANDIDATES_PATH;
  process.env.MDZH_KNOWN_ENTITIES_CANDIDATES_PATH = candidatePath;

  class KnownEntityProgressExecutor extends PromptAwareExecutor {
    override async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(
          createAnchorCatalog([
            {
              english: "Seatbelt",
              chineseHint: "macOS 沙箱框架",
              familyKey: "seatbelt"
            }
          ])
        );
      }

      return super.execute(prompt, options);
    }
  }

  try {
    const progress: string[] = [];
    await translateMarkdownArticle("Tell Claude to use sandbox mode with Seatbelt.\n", {
      executor: new KnownEntityProgressExecutor(),
      formatter: async (markdown) => markdown,
      onProgress: (message) => progress.push(message)
    });

    assert.ok(progress.some((message) => message.includes("Loading formal known_entities.")));
    assert.ok(progress.some((message) => message.includes("Matched 2 formal known_entities in source.")));
    assert.ok(progress.some((message) => message.includes("Planned 1 analysis shard(s)")));
    assert.ok(progress.some((message) => message.includes("Starting model-based anchor discovery for shard 1/1")));
    assert.ok(
      progress.some((message) => message.includes("Model-based anchor discovery finished: 1 anchors, 0 heading plan(s), 0 ignored term(s)."))
    );
    assert.ok(progress.some((message) => message.includes("Wrote 1 known_entity candidate(s) to")));
    assert.ok(progress.some((message) => message.includes("Merged formal and discovered anchors: 3 total, 0 heading plan(s).")));
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_KNOWN_ENTITIES_CANDIDATES_PATH;
    } else {
      process.env.MDZH_KNOWN_ENTITIES_CANDIDATES_PATH = previous;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("translateMarkdownArticle shards document analysis and carries priorAccepted summary forward", async () => {
  const previousMaxChunks = process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS;
  process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS = "1";

  const analysisPrompts: string[] = [];
  const analysisReuseFlags: Array<boolean | undefined> = [];
  const largeParagraph = "Alpha ".repeat(1200);

  const source = [
    "# Title",
    "",
    "## First Heading",
    "",
    largeParagraph,
    "",
    "## Second Heading",
    "",
    largeParagraph,
    "",
    "## Third Heading",
    "",
    largeParagraph,
    ""
  ].join("\n");

  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (isDocumentAnalysisPrompt(prompt)) {
        analysisPrompts.push(prompt);
        analysisReuseFlags.push(options.reuseSession);
        if (prompt.includes("First Heading") && !prompt.includes("Second Heading")) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "First Heading",
                chineseHint: "第一个标题",
                familyKey: "first-heading",
                chunkId: "chunk-2",
                segmentId: "chunk-2-segment-1"
              }
            ])
          );
        }
        if (prompt.includes("Second Heading")) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "Second Heading",
                chineseHint: "第二个标题",
                familyKey: "second-heading",
                chunkId: "chunk-3",
                segmentId: "chunk-3-segment-1"
              }
            ])
          );
        }
        return createExecResult(createEmptyAnchorCatalog());
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }

      const sourceSection = extractPromptSection(prompt, "【英文原文】");
      return createExecResult(sourceSection ?? "");
    }
  });

  try {
    await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown
    });

    assert.ok(analysisPrompts.length >= 2);
    assert.ok(analysisPrompts.every((prompt) => prompt.includes('"mode": "shard"')));
    assert.equal(analysisReuseFlags.every((flag) => flag === false), true);
    assert.ok(analysisPrompts[1]?.includes('"priorAccepted"'));
    assert.ok(analysisPrompts[1]?.includes("First Heading"));
    assert.ok(analysisPrompts[1]?.includes('"english": "First Heading"'));
  } finally {
    if (previousMaxChunks === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS = previousMaxChunks;
    }
  }
});

test("translateMarkdownArticle retries a timed-out analysis shard before splitting into bounded fallback shards", async () => {
  const previousMaxChunks = process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS;
  const previousMaxSourceChars = process.env.MDZH_ANALYSIS_SHARD_MAX_SOURCE_CHARS;
  const previousMaxAttempts = process.env.MDZH_ANALYSIS_SHARD_MAX_ATTEMPTS;
  const previousMaxSplitDepth = process.env.MDZH_ANALYSIS_SHARD_MAX_SPLIT_DEPTH;
  const previousMinSplitSourceChars = process.env.MDZH_ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS;
  const previousTimeoutMs = process.env.MDZH_ANALYSIS_SHARD_TIMEOUT_MS;
  process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS = "10";
  process.env.MDZH_ANALYSIS_SHARD_MAX_SOURCE_CHARS = "20000";
  process.env.MDZH_ANALYSIS_SHARD_MAX_ATTEMPTS = "3";
  process.env.MDZH_ANALYSIS_SHARD_MAX_SPLIT_DEPTH = "2";
  process.env.MDZH_ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS = "900";
  process.env.MDZH_ANALYSIS_SHARD_TIMEOUT_MS = "1000";

  const analysisPrompts: string[] = [];
  const progress: string[] = [];
  const largeParagraph = "Alpha ".repeat(400);

  const source = [
    "# Title",
    "",
    "## First Heading",
    "",
    largeParagraph,
    "",
    "## Second Heading",
    "",
    largeParagraph,
    "",
    "## Third Heading",
    "",
    largeParagraph,
    ""
  ].join("\n");

  let fullShardAttempts = 0;
  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (isDocumentAnalysisPrompt(prompt)) {
        analysisPrompts.push(prompt);

        const isFullShard =
          prompt.includes("First Heading") &&
          prompt.includes("Second Heading") &&
          prompt.includes("Third Heading");
        if (isFullShard) {
          fullShardAttempts += 1;
          throw new Error("Codex exec timed out after 1000ms.");
        }

        if (prompt.includes("First Heading") && prompt.includes("Second Heading")) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "First Heading",
                chineseHint: "第一个标题",
                familyKey: "first-heading",
                chunkId: "chunk-2",
                segmentId: "chunk-2-segment-1"
              },
              {
                english: "Second Heading",
                chineseHint: "第二个标题",
                familyKey: "second-heading",
                chunkId: "chunk-3",
                segmentId: "chunk-3-segment-1"
              }
            ])
          );
        }

        if (prompt.includes("Third Heading")) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "Third Heading",
                chineseHint: "第三个标题",
                familyKey: "third-heading",
                chunkId: "chunk-4",
                segmentId: "chunk-4-segment-1"
              }
            ])
          );
        }

        return createExecResult(createEmptyAnchorCatalog());
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }

      const sourceSection = extractPromptSection(prompt, "【英文原文】");
      return createExecResult(sourceSection ?? "");
    }
  });

  try {
    await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown,
      onProgress: (message) => progress.push(message)
    });

    assert.equal(fullShardAttempts, 2);
    assert.ok(
      progress.some((message) =>
        message.includes("timed out on attempt 1; retrying once with timeout 1500ms before fallback split")
      )
    );
    assert.ok(
      progress.some((message) => message.includes("timed out on attempt 2; splitting into 2 fallback shard(s)"))
    );
    assert.ok(analysisPrompts.some((prompt) => prompt.includes("First Heading") && prompt.includes("Second Heading") && !prompt.includes("Third Heading")));
    assert.ok(analysisPrompts.some((prompt) => prompt.includes("Third Heading") && !prompt.includes("Second Heading")));
  } finally {
    if (previousMaxChunks === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS = previousMaxChunks;
    }
    if (previousMaxSourceChars === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_MAX_SOURCE_CHARS;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_MAX_SOURCE_CHARS = previousMaxSourceChars;
    }
    if (previousMaxAttempts === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_MAX_ATTEMPTS;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_MAX_ATTEMPTS = previousMaxAttempts;
    }
    if (previousMaxSplitDepth === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_MAX_SPLIT_DEPTH;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_MAX_SPLIT_DEPTH = previousMaxSplitDepth;
    }
    if (previousMinSplitSourceChars === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS = previousMinSplitSourceChars;
    }
    if (previousTimeoutMs === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_TIMEOUT_MS;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_TIMEOUT_MS = previousTimeoutMs;
    }
  }
});

test("translateMarkdownArticle analyzes fallback shards with bounded concurrency after a split", async () => {
  const previousMaxChunks = process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS;
  const previousMaxSourceChars = process.env.MDZH_ANALYSIS_SHARD_MAX_SOURCE_CHARS;
  const previousMaxAttempts = process.env.MDZH_ANALYSIS_SHARD_MAX_ATTEMPTS;
  const previousMaxSplitDepth = process.env.MDZH_ANALYSIS_SHARD_MAX_SPLIT_DEPTH;
  const previousMinSplitSourceChars = process.env.MDZH_ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS;
  const previousFallbackConcurrency = process.env.MDZH_ANALYSIS_FALLBACK_SHARD_CONCURRENCY;
  const previousTimeoutMs = process.env.MDZH_ANALYSIS_SHARD_TIMEOUT_MS;
  process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS = "10";
  process.env.MDZH_ANALYSIS_SHARD_MAX_SOURCE_CHARS = "20000";
  process.env.MDZH_ANALYSIS_SHARD_MAX_ATTEMPTS = "3";
  process.env.MDZH_ANALYSIS_SHARD_MAX_SPLIT_DEPTH = "2";
  process.env.MDZH_ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS = "900";
  process.env.MDZH_ANALYSIS_FALLBACK_SHARD_CONCURRENCY = "2";
  process.env.MDZH_ANALYSIS_SHARD_TIMEOUT_MS = "1000";

  const largeParagraph = "Alpha ".repeat(400);
  const source = [
    "# Title",
    "",
    "## First Heading",
    "",
    largeParagraph,
    "",
    "## Second Heading",
    "",
    largeParagraph,
    "",
    "## Third Heading",
    "",
    largeParagraph,
    ""
  ].join("\n");

  let fullShardAttempts = 0;
  let inFlightChildAnalyses = 0;
  let maxConcurrentChildAnalyses = 0;
  const executor: CodexExecutor = createP2CompatibleExecutor({
    async execute(prompt, options) {
      if (isDocumentAnalysisPrompt(prompt)) {
        const isFullShard =
          prompt.includes("First Heading") &&
          prompt.includes("Second Heading") &&
          prompt.includes("Third Heading");
        if (isFullShard) {
          fullShardAttempts += 1;
          throw new Error("Codex exec timed out after 1000ms.");
        }

        inFlightChildAnalyses += 1;
        maxConcurrentChildAnalyses = Math.max(maxConcurrentChildAnalyses, inFlightChildAnalyses);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlightChildAnalyses -= 1;

        if (prompt.includes("First Heading") && prompt.includes("Second Heading")) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "First Heading",
                chineseHint: "第一个标题",
                familyKey: "first-heading",
                chunkId: "chunk-2",
                segmentId: "chunk-2-segment-1"
              },
              {
                english: "Second Heading",
                chineseHint: "第二个标题",
                familyKey: "second-heading",
                chunkId: "chunk-3",
                segmentId: "chunk-3-segment-1"
              }
            ])
          );
        }

        if (prompt.includes("Third Heading")) {
          return createExecResult(
            createAnchorCatalog([
              {
                english: "Third Heading",
                chineseHint: "第三个标题",
                familyKey: "third-heading",
                chunkId: "chunk-4",
                segmentId: "chunk-4-segment-1"
              }
            ])
          );
        }

        return createExecResult(createEmptyAnchorCatalog());
      }

      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
      }

      const currentTranslation = extractPromptSection(prompt, "【当前译文】");
      if (currentTranslation !== null) {
        return createExecResult(currentTranslation);
      }

      const sourceSection = extractPromptSection(prompt, "【英文原文】");
      return createExecResult(sourceSection ?? "");
    }
  });

  try {
    await translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown
    });

    assert.equal(fullShardAttempts, 2);
    assert.equal(maxConcurrentChildAnalyses, 2);
  } finally {
    if (previousMaxChunks === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_MAX_CHUNKS = previousMaxChunks;
    }
    if (previousMaxSourceChars === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_MAX_SOURCE_CHARS;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_MAX_SOURCE_CHARS = previousMaxSourceChars;
    }
    if (previousMaxAttempts === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_MAX_ATTEMPTS;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_MAX_ATTEMPTS = previousMaxAttempts;
    }
    if (previousMaxSplitDepth === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_MAX_SPLIT_DEPTH;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_MAX_SPLIT_DEPTH = previousMaxSplitDepth;
    }
    if (previousMinSplitSourceChars === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_MIN_SPLIT_SOURCE_CHARS = previousMinSplitSourceChars;
    }
    if (previousFallbackConcurrency === undefined) {
      delete process.env.MDZH_ANALYSIS_FALLBACK_SHARD_CONCURRENCY;
    } else {
      process.env.MDZH_ANALYSIS_FALLBACK_SHARD_CONCURRENCY = previousFallbackConcurrency;
    }
    if (previousTimeoutMs === undefined) {
      delete process.env.MDZH_ANALYSIS_SHARD_TIMEOUT_MS;
    } else {
      process.env.MDZH_ANALYSIS_SHARD_TIMEOUT_MS = previousTimeoutMs;
    }
  }
});
