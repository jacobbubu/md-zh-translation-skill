import test from "node:test";
import assert from "node:assert/strict";

import { HardGateError } from "../src/errors.js";
import { planMarkdownChunks } from "../src/markdown-chunks.js";
import { extractFrontmatter, protectMarkdownSpans } from "../src/markdown-protection.js";
import { parseGateAudit, translateMarkdownArticle, type GateAudit } from "../src/translate.js";
import type { CodexExecOptions, CodexExecResult, CodexExecutor } from "../src/codex-exec.js";

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

  async execute(prompt: string, _options: CodexExecOptions): Promise<CodexExecResult> {
    this.prompts.push(prompt);
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

    if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
      return createExecResult(wrapAuditForSegments(prompt, createAudit(true)));
    }

    const currentTranslation = extractPromptSection(prompt, "【当前译文】");
    if (currentTranslation !== null) {
      return createExecResult(currentTranslation);
    }

    const source = extractPromptSection(prompt, "【英文原文】");
    return createExecResult(source ?? "");
  }
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

test("parseGateAudit accepts fenced JSON output", () => {
  const audit = createAudit(true);
  const parsed = parseGateAudit(`\`\`\`json\n${JSON.stringify(audit, null, 2)}\n\`\`\``);
  assert.equal(parsed.hard_checks.paragraph_match.pass, true);
  assert.deepEqual(parsed.must_fix, []);
});

test("translateMarkdownArticle repairs once and then runs style polish", async () => {
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
    onProgress: (message) => progress.push(message)
  });

  assert.equal(result.repairCyclesUsed, 1);
  assert.equal(result.styleApplied, true);
  assert.equal(result.markdown, "# 标题（Title）\n\n更自然的正文");
  assert.ok(progress.some((message) => message.includes("repair cycle 1")));
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
      if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, passingAudit));
      }

      const current = extractPromptSection(prompt, "【当前译文】") ?? extractPromptSection(prompt, "【英文原文】") ?? "";
      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult(current.replace(/@@MDZH_INLINE_MARKDOWN_LINK_\d{4,}@@/g, ""));
      }

      return createExecResult(current);
    }
  }

  const executor = new BrokenStyleExecutor();

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
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
  assert.ok(executor.prompts[0]?.includes("当前分块：第 1 /"));
});

test("translateMarkdownArticle canonicalizes expanded URL spans before chunk-level style polish", async () => {
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
        assert.match(prompt, /@@MDZH_INLINE_MARKDOWN_LINK_\d{4,}@@/);
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
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /^# Docs\n\nRead \[docs\]\(https:\/\/example\.com\/docs\)\./);
  assert.match(result.markdown, /```bash\nprintf 'ok'\n```/);
  assert.match(result.markdown, /See \[guide\]\(https:\/\/example\.com\/guide\)\.\n$/);
});

test("translateMarkdownArticle keeps translatable strong emphasis and raw inline code visible at chunk-level style polish", async () => {
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
    formatter: async (markdown) => markdown
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

test("translateMarkdownArticle carries local inline markdown link placeholders into chunk-level style polish", async () => {
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
        assert.match(prompt, /@@MDZH_INLINE_MARKDOWN_LINK_\d{4,}@@/);
        assert.doesNotMatch(prompt, /\[bubblewrap \]\(@@MDZH_LINK_DESTINATION_0067@@\)/);
        assert.doesNotMatch(prompt, /\[macOS\]\(@@MDZH_LINK_DESTINATION_0068@@\)/);
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
    formatter: async (markdown) => markdown
  });

  assert.match(result.markdown, /\[bubblewrap \]\(https:\/\/example\.com\/bubblewrap\)/);
  assert.match(result.markdown, /\[macOS\]\(https:\/\/example\.com\/macos\)/);
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

  const executor = new PromptAwareExecutor();
  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.equal(result.markdown, source);
  const nonStylePrompts = executor.prompts.filter(
    (prompt) => !prompt.includes("只做“风格与可读性润色”")
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
    createExecResult(
      wrapPerSegmentAudits("【segment 1】", [
        { segment_index: 1, audit: createAudit(true) }
      ])
    ),
    createExecResult("# 标题（Title）\n\n正文")
  ];

  const executor: CodexExecutor = {
    async execute(_prompt, options) {
      calls.push(options);
      const next = responses.shift();
      assert.ok(next, "Unexpected extra Codex call");
      return next;
    }
  };

  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
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

test("translateMarkdownArticle runs chunk-level audit with structured output", async () => {
  const source = "# Title\n\nBody";
  const calls: CodexExecOptions[] = [];
  const executor: CodexExecutor = {
    async execute(prompt, options) {
      calls.push(options);
      if (options.outputSchema || prompt.includes("只返回 JSON")) {
        return createExecResult(wrapAuditForSegments(prompt, createAudit(true)), "audit-thread");
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        return createExecResult("# 标题\n\n正文");
      }

      return createExecResult("# 标题\n\n正文", "draft-thread");
    }
  };

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.equal(result.markdown, "# 标题\n\n正文");
  assert.equal(calls[0]?.reuseSession, true);
  assert.equal(calls[0]?.reasoningEffort, "medium");
  assert.ok(calls[1]?.outputSchema);
  assert.equal(calls[1]?.reuseSession, true);
  assert.equal(calls[1]?.reasoningEffort, "medium");
  assert.equal(calls[2]?.reasoningEffort, "low");
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
  const executor: CodexExecutor = {
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
  };

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

  const prompt = executor.prompts.find((item) => item.includes("Claude Code Sandbox Illustration / By Anthropic"));
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

  const prompt = executor.prompts.find((item) => item.includes("kubectl - Kubernetes cluster access"));
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

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const secondChunkPrompt = executor.prompts.find((prompt) => prompt.includes("当前分块：第 2 /"));
  assert.ok(secondChunkPrompt);
  assert.match(secondChunkPrompt, /前文已完成首现锚定的专名\/术语：/);
  assert.match(secondChunkPrompt, /Claude Code/);
  assert.match(secondChunkPrompt, /一律视为全文非首现/);
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

  const executor = new PromptAwareExecutor();
  await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  const secondChunkPrompt = executor.prompts.find((prompt) => prompt.includes("当前分块：第 2 /"));
  assert.ok(secondChunkPrompt);
  const establishedTermsLine = secondChunkPrompt.match(/前文已完成首现锚定的专名\/术语：([^\n]+)/);
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
    (item) => item.includes("**now has a sandbox mode**") || item.includes("--dangerously-skip-permissions")
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
  const brokenDraft = protectedBody.replace("@@MDZH_LINK_DESTINATION_0001@@", "");
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

  assert.equal(executor.prompts.length, 2);
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
