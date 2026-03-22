import test from "node:test";
import assert from "node:assert/strict";

import { HardGateError } from "../src/errors.js";
import { parseGateAudit, translateMarkdownArticle, type GateAudit } from "../src/translate.js";
import type { CodexExecOptions, CodexExecResult, CodexExecutor } from "../src/codex-exec.js";

function createAudit(pass: boolean, mustFix: string[] = []): GateAudit {
  return {
    hard_checks: {
      paragraph_match: { pass, problem: pass ? "" : "paragraph mismatch" },
      first_mention_bilingual: { pass, problem: pass ? "" : "missing bilingual term" },
      numbers_units_logic: { pass, problem: pass ? "" : "unit mismatch" },
      chinese_punctuation: { pass, problem: pass ? "" : "punctuation mismatch" },
      unit_conversion_boundary: { pass, problem: pass ? "" : "conversion mismatch" }
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
