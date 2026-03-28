import test from "node:test";
import assert from "node:assert/strict";

import { HardGateError } from "../src/errors.js";
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
      frontmatter_isolation: { pass: true, problem: "" },
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

class DelayedExecutor implements CodexExecutor {
  readonly prompts: string[] = [];

  constructor(
    private readonly responses: string[],
    private readonly delayMs: number
  ) {}

  async execute(prompt: string, _options: CodexExecOptions): Promise<CodexExecResult> {
    this.prompts.push(prompt);
    const next = this.responses.shift();
    assert.ok(next != null, "Unexpected extra Codex call");
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return {
      text: next,
      stderr: "",
      jsonl: "",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      }
    };
  }
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
  assert.ok(progress.some((message) => message.includes("Repair cycle 1")));
});

test("translateMarkdownArticle emits heartbeat progress while waiting on long stages", async () => {
  const source = "# Title\n\nBody";
  const passingAudit = JSON.stringify(createAudit(true));
  const executor = new DelayedExecutor(["# 标题\n\n正文", passingAudit, "# 标题\n\n正文"], 25);
  const progress: string[] = [];

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    onProgress: (message) => progress.push(message),
    progressHeartbeatMs: 10
  });

  assert.equal(result.markdown, "# 标题\n\n正文");
  assert.ok(progress.some((message) => message.includes("Still generating draft translation")));
  assert.ok(progress.some((message) => message.includes("Still waiting for hard gate audit")));
  assert.ok(progress.some((message) => message.includes("Still applying style polish")));
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
      assert.match(error.message, /Hard gate failed/);
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

  const { body } = extractFrontmatter(source);
  const { protectedBody } = protectMarkdownSpans(body);
  const passingAudit = JSON.stringify(createAudit(true));
  const executor = new StubExecutor([protectedBody, passingAudit, protectedBody]);

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
    "# Sandbox",
    "",
    "Run this command:",
    "",
    "```bash",
    "/sandbox",
    "```",
    ""
  ].join("\n");

  const { protectedBody } = protectMarkdownSpans(source);
  const passingAudit = JSON.stringify(createAudit(true));
  const brokenStyle = protectedBody.replace("@@MDZH_CODE_BLOCK_0001@@", "");
  const executor = new StubExecutor([protectedBody, passingAudit, brokenStyle]);
  const progress: string[] = [];

  const result = await translateMarkdownArticle(source, {
    executor,
    formatter: async (markdown) => markdown,
    onProgress: (message) => progress.push(message)
  });

  assert.equal(result.styleApplied, false);
  assert.match(result.markdown, /```bash\n\/sandbox\n```/);
  assert.ok(
    progress.some((message) =>
      message.includes("falling back to the hard-pass translation")
    )
  );
});

test("translateMarkdownArticle fails when the hard-pass translation already broke a protected span", async () => {
  const source = [
    "# Sandbox",
    "",
    "Run this command:",
    "",
    "```bash",
    "/sandbox",
    "```",
    ""
  ].join("\n");

  const { protectedBody } = protectMarkdownSpans(source);
  const passingAudit = JSON.stringify(createAudit(true));
  const brokenDraft = protectedBody.replace("@@MDZH_CODE_BLOCK_0001@@", "");
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
