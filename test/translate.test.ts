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
    return next;
  }
}

class PromptAwareExecutor implements CodexExecutor {
  readonly prompts: string[] = [];
  private readonly passingAudit = JSON.stringify(createAudit(true));

  async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
    this.prompts.push(prompt);

    if (options.outputSchema || prompt.includes('"hard_checks"') || prompt.includes("只返回 JSON")) {
      return createExecResult(this.passingAudit);
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
      return createExecResult(JSON.stringify(createAudit(true)), "thread-1");
    }

    if (prompt.includes("只返回 JSON")) {
      if (options.threadId === "thread-1") {
        return createExecResult("not-json", "thread-1");
      }

      return createExecResult(JSON.stringify(createAudit(true)), "thread-1");
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

  const { protectedBody } = protectMarkdownSpans(source);
  const passingAudit = JSON.stringify(createAudit(true));
  const brokenStyle = protectedBody.replace("@@MDZH_LINK_DESTINATION_0001@@", "");
  const executor = new StubExecutor([protectedBody, passingAudit, brokenStyle]);
  const progress: string[] = [];

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
        return createExecResult(JSON.stringify(createAudit(true)));
      }

      if (prompt.includes("只做“风格与可读性润色”")) {
        assert.match(prompt, /@@MDZH_CODE_BLOCK_0001@@/);
        assert.match(prompt, /@@MDZH_LINK_DESTINATION_0002@@/);
        assert.match(prompt, /@@MDZH_LINK_DESTINATION_0003@@/);
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
  const firstAudit = JSON.stringify(createAudit(false, ["标题首现术语缺少中英对照"]));
  const secondAudit = JSON.stringify(createAudit(true));
  const calls: CodexExecOptions[] = [];
  const responses = [
    createExecResult("# 标题\n\n正文", "thread-1"),
    createExecResult(firstAudit, "thread-1"),
    createExecResult("# 标题（Title）\n\n正文", "thread-1"),
    createExecResult(secondAudit, "thread-1"),
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
  assert.equal(calls[1]?.threadId, "thread-1");
  assert.equal(calls[1]?.reasoningEffort, "medium");
  assert.equal(calls[2]?.threadId, "thread-1");
  assert.equal(calls[2]?.reasoningEffort, "low");
  assert.equal(calls[3]?.threadId, "thread-1");
  assert.equal(calls[3]?.reasoningEffort, "medium");
  assert.equal(calls[4]?.reasoningEffort, "low");
});

test("translateMarkdownArticle falls back to a structured fresh audit when resumed audit is not valid JSON", async () => {
  const source = "# Title\n\nBody";
  const executor = new SessionReuseExecutor();

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown
  });

  assert.equal(result.markdown, "# 标题（Title）\n\n正文");
  assert.equal(executor.calls[0]?.reuseSession, true);
  assert.equal(executor.calls[0]?.reasoningEffort, "medium");
  assert.equal(executor.calls[1]?.threadId, "thread-1");
  assert.equal(executor.calls[1]?.reasoningEffort, "medium");
  assert.ok(executor.calls[2]?.outputSchema);
  assert.equal(executor.calls[2]?.reuseSession, true);
  assert.equal(executor.calls[2]?.reasoningEffort, "medium");
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
