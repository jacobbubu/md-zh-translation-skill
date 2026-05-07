import test from "node:test";
import assert from "node:assert/strict";

import { translateMarkdownArticle, type GateAudit } from "../src/translate.js";
import { CodexExecutionError } from "../src/errors.js";
import type { CodexExecOptions, CodexExecResult, CodexExecutor } from "../src/codex-exec.js";
import { createMemoryTelemetrySink } from "../src/telemetry.js";

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

function createPassingAudit(): GateAudit {
  return {
    chunk_id: "chunk-1",
    hard_checks: {
      mention_consistency: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" },
      paragraph_segmentation: { pass: true, problem: "" },
      embedded_template_integrity: { pass: true, problem: "" }
    },
    soft_checks: {
      glossary_alignment: { pass: true, problem: "" },
      register_match: { pass: true, problem: "" },
      readability: { pass: true, problem: "" }
    },
    must_fix: []
  } as unknown as GateAudit;
}

function wrapAuditForSegments(prompt: string, audit: GateAudit): string {
  // The bundled-audit lane expects a JSON object keyed by segment id. The
  // tests below use a single-chunk single-segment fixture, so the segment id
  // is a deterministic `seg-1`. Match that.
  const segmentMatch = prompt.match(/seg-\d+/g);
  const segments = segmentMatch ? Array.from(new Set(segmentMatch)) : ["seg-1"];
  const segmentAudits: Record<string, unknown> = {};
  for (const segmentId of segments) {
    segmentAudits[segmentId] = audit;
  }
  return JSON.stringify({ segmentAudits });
}

function createExecResult(text: string): CodexExecResult {
  return {
    text,
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

const RESCUE_INPUT_LABEL = "【待翻译原文】";

function withCleanRescueEnv<T>(setup: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const keys = [
    "MDZH_DEFAULT_FINAL_RESCUE",
    "MDZH_DEFAULT_FINAL_RESCUE_TIMEOUT_MS",
    "MDZH_RESCUE_MODEL",
    "MDZH_FINAL_RESCUE_COMMAND",
    "MDZH_FINAL_RESCUE_TIMEOUT_MS",
    "MDZH_RESCUE_GLOSSARY_PATH"
  ] as const;
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) {
    previous[key] = process.env[key];
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(setup, key)) {
      const value = setup[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    } else {
      delete process.env[key];
    }
  }
  return body().finally(() => {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  });
}

test("default final-rescue: triggers when internal rescue fails under soft-gate, accepts valid output", async () => {
  const source = "## Hello\n\nWorld.\n";

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createPassingAudit()));
      }
      // The default final-rescue tier is the only call site that uses the
      // `【待翻译原文】` section header. Recognize it and produce a valid
      // 2-paragraph Chinese translation that matches the source structure.
      if (prompt.includes(RESCUE_INPUT_LABEL)) {
        // Return a strict 2-paragraph response that matches source structure
        // — this is the contract the default tier validates against. Avoid
        // re-extracting source from the prompt, which would risk pulling in
        // trailing instruction lines and breaking the paragraph count.
        return createExecResult("## 你好\n\n世界。\n");
      }
      // Both the primary mini draft and the in-pipeline rescue draft (gpt-5.5
      // running through audit+repair) fail.
      throw new CodexExecutionError("draft fail");
    }
  };

  const sink = createMemoryTelemetrySink();
  const result = await withCleanRescueEnv({}, () =>
    translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown,
      softGate: true,
      telemetry: sink
    })
  );

  assert.match(result.markdown, /你好/);
  assert.match(result.markdown, /世界/);
  assert.doesNotMatch(result.markdown, /World\./);

  const startEvent = [...sink.events].find((e) => e.type === "chunk.default_final_rescue.start");
  assert.ok(startEvent, "expected chunk.default_final_rescue.start event");
  assert.equal((startEvent!.meta as Record<string, unknown>).rescueModel, "gpt-5.5");

  const endEvent = [...sink.events].find((e) => e.type === "chunk.default_final_rescue.end");
  assert.ok(endEvent, "expected chunk.default_final_rescue.end event");
  assert.equal((endEvent!.meta as Record<string, unknown>).success, true);

  const chunkErrorEvent = [...sink.events].find((e) => e.type === "chunk.error");
  assert.ok(chunkErrorEvent);
  const chunkErrorMeta = chunkErrorEvent!.meta as Record<string, unknown>;
  assert.equal(chunkErrorMeta.defaultFinalRescueAccepted, true);
  assert.equal(chunkErrorMeta.acceptedTier, "default-final-rescue");
});

test("default final-rescue: MDZH_DEFAULT_FINAL_RESCUE=off skips the new tier", async () => {
  const source = "## Hello\n\nWorld.\n";

  let defaultTierInvoked = false;
  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createPassingAudit()));
      }
      if (prompt.includes(RESCUE_INPUT_LABEL)) {
        defaultTierInvoked = true;
        return createExecResult("不应该到达这里");
      }
      throw new CodexExecutionError("draft fail");
    }
  };

  const sink = createMemoryTelemetrySink();
  await withCleanRescueEnv({ MDZH_DEFAULT_FINAL_RESCUE: "off" }, () =>
    translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown,
      softGate: true,
      telemetry: sink
    })
  );

  assert.equal(defaultTierInvoked, false, "default final-rescue must not be invoked when env=off");
  const events = [...sink.events].filter((e) => e.type.startsWith("chunk.default_final_rescue"));
  assert.equal(events.length, 0);
});

test("default final-rescue: success skips the external hook (default tier runs first)", async () => {
  const source = "## Hello\n\nWorld.\n";

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createPassingAudit()));
      }
      if (prompt.includes(RESCUE_INPUT_LABEL)) {
        // Return a strict 2-paragraph response that matches source structure
        // — this is the contract the default tier validates against. Avoid
        // re-extracting source from the prompt, which would risk pulling in
        // trailing instruction lines and breaking the paragraph count.
        return createExecResult("## 你好\n\n世界。\n");
      }
      throw new CodexExecutionError("draft fail");
    }
  };

  const sink = createMemoryTelemetrySink();
  // External hook would emit DIFFERENT recognizable text — its presence in
  // the output would mean the default tier failed to pre-empt the hook.
  const result = await withCleanRescueEnv(
    { MDZH_FINAL_RESCUE_COMMAND: "printf '## 外部钩子\\n\\n外部钩子内容。\\n'" },
    () =>
      translateMarkdownArticle(source, {
        executor,
        formatter: async (markdown) => markdown,
        softGate: true,
        telemetry: sink
      })
  );

  assert.match(result.markdown, /你好/);
  assert.doesNotMatch(result.markdown, /外部钩子/, "external hook must not be invoked when default tier succeeded");

  const externalHookEvents = [...sink.events].filter((e) => e.type.startsWith("chunk.final_rescue"));
  assert.equal(externalHookEvents.length, 0, "external hook events must not fire when default tier accepted");
  const defaultTierEvents = [...sink.events].filter((e) => e.type.startsWith("chunk.default_final_rescue"));
  assert.ok(defaultTierEvents.length >= 2, "default_final_rescue.start + .end should both fire");
});

test("default final-rescue: invalid output (paragraph mismatch) falls through to external hook", async () => {
  const source = "## Hello\n\nWorld.\n";

  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createPassingAudit()));
      }
      if (prompt.includes(RESCUE_INPUT_LABEL)) {
        // Single paragraph — paragraph_match validation should reject it.
        return createExecResult("只有一段中文。");
      }
      throw new CodexExecutionError("draft fail");
    }
  };

  const sink = createMemoryTelemetrySink();
  const result = await withCleanRescueEnv(
    { MDZH_FINAL_RESCUE_COMMAND: "printf '## 外部钩子\\n\\n外部钩子内容。\\n'" },
    () =>
      translateMarkdownArticle(source, {
        executor,
        formatter: async (markdown) => markdown,
        softGate: true,
        telemetry: sink
      })
  );

  // Default tier rejected → external hook accepted → external hook output
  // appears in the body.
  assert.match(result.markdown, /外部钩子/);

  const defaultEnd = [...sink.events].find((e) => e.type === "chunk.default_final_rescue.end");
  assert.ok(defaultEnd);
  assert.equal((defaultEnd!.meta as Record<string, unknown>).success, false);

  const externalEnd = [...sink.events].find((e) => e.type === "chunk.final_rescue.end");
  assert.ok(externalEnd, "external hook should be invoked after default tier failed");
  assert.equal((externalEnd!.meta as Record<string, unknown>).success, true);

  const chunkErrorEvent = [...sink.events].find((e) => e.type === "chunk.error");
  const chunkErrorMeta = chunkErrorEvent!.meta as Record<string, unknown>;
  assert.equal(chunkErrorMeta.defaultFinalRescueAccepted, false);
  assert.equal(chunkErrorMeta.finalRescueAccepted, true);
  assert.equal(chunkErrorMeta.acceptedTier, "external-final-rescue");
});

test("default final-rescue: MDZH_RESCUE_MODEL=off disables both internal rescue and the new tier", async () => {
  const source = "## Hello\n\nWorld.\n";

  let defaultTierInvoked = false;
  const executor: CodexExecutor = {
    async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
      if (isDocumentAnalysisPrompt(prompt)) {
        return createExecResult(createEmptyAnchorCatalog());
      }
      if (isBundledAuditPrompt(prompt, options) || (options.outputSchema && prompt.includes('"hard_checks"'))) {
        return createExecResult(wrapAuditForSegments(prompt, createPassingAudit()));
      }
      if (prompt.includes(RESCUE_INPUT_LABEL)) {
        defaultTierInvoked = true;
        return createExecResult("不应到达");
      }
      throw new CodexExecutionError("draft fail");
    }
  };

  const sink = createMemoryTelemetrySink();
  const result = await withCleanRescueEnv({ MDZH_RESCUE_MODEL: "off" }, () =>
    translateMarkdownArticle(source, {
      executor,
      formatter: async (markdown) => markdown,
      softGate: true,
      telemetry: sink
    })
  );

  assert.equal(defaultTierInvoked, false, "default tier must skip when MDZH_RESCUE_MODEL=off");
  // Source preserved (English) because all rescue tiers are off.
  assert.match(result.markdown, /World/);
});
