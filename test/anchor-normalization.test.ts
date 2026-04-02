import test from "node:test";
import assert from "node:assert/strict";

import {
  formatAnchorDisplay,
  injectPlannedAnchorText,
  normalizeExplicitRepairAnchorText,
  normalizeHeadingLikeAnchorText,
  normalizeSegmentAnchorText,
  type PromptAnchor
} from "../src/anchor-normalization.js";
import type { PromptSlice } from "../src/translation-state.js";

function createAnchor(
  anchorId: string,
  english: string,
  chineseHint: string,
  familyId = anchorId
): PromptAnchor {
  return {
    anchorId,
    english,
    chineseHint,
    familyId
  };
}

function createSlice(overrides: Partial<PromptSlice>): PromptSlice {
  return {
    documentTitle: "Sample",
    chunkId: "chunk-1",
    segmentId: "chunk-1-segment-1",
    chunkIndex: 1,
    segmentIndex: 1,
    headingPath: ["Sample"],
    headingHints: [],
    requiredAnchors: [],
    repeatAnchors: [],
    establishedAnchors: [],
    protectedSpanIds: [],
    pendingRepairs: [],
    ...overrides
  };
}

test("normalizeSegmentAnchorText flips english-first duplicated anchors into Chinese-English form", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Prompt injection attacks", "提示注入攻击")]
  });

  const normalized = normalizeSegmentAnchorText(
    "Prompt injection attacks（Prompt injection attacks） can hide malicious instructions.",
    slice
  );

  assert.equal(
    normalized,
    "提示注入攻击（Prompt injection attacks） can hide malicious instructions."
  );
});

test("normalizeSegmentAnchorText removes repeated english parentheses for already established anchors", () => {
  const slice = createSlice({
    establishedAnchors: [createAnchor("anchor-1", "sandbox mode", "沙箱模式")]
  });

  const normalized = normalizeSegmentAnchorText("沙箱模式（sandbox mode） 解决了这个问题。", slice);

  assert.equal(normalized, "沙箱模式 解决了这个问题。");
});

test("normalizeSegmentAnchorText collapses exact duplicate english-only parentheses", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "npm", "npm")]
  });

  const normalized = normalizeSegmentAnchorText("npm（npm） registry access is allowed.", slice);

  assert.equal(normalized, "npm registry access is allowed.");
});

test("normalizeSegmentAnchorText rewrites english-leading duplicated anchor text into english-primary form", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "bubblewrap", "bubblewrap 框架")]
  });

  const normalized = normalizeSegmentAnchorText(
    "Linux 上的 bubblewrap 框架（bubblewrap）提供了隔离能力。",
    slice
  );

  assert.equal(normalized, "Linux 上的 bubblewrap（框架）提供了隔离能力。");
});

test("normalizeSegmentAnchorText preserves english-primary tool anchors with a chinese explanation", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "bubblewrap", "安全隔离组件")]
  });

  const normalized = normalizeSegmentAnchorText(
    "Linux 上的 bubblewrap（安全隔离组件）提供了隔离能力。",
    slice
  );

  assert.equal(normalized, "Linux 上的 bubblewrap（安全隔离组件）提供了隔离能力。");
});

test("formatAnchorDisplay prefers english-primary formatting for single-token tool names", () => {
  assert.equal(formatAnchorDisplay(createAnchor("anchor-1", "bubblewrap", "安全隔离组件")), "bubblewrap（安全隔离组件）");
  assert.equal(formatAnchorDisplay(createAnchor("anchor-2", "bubblewrap", "bubblewrap 框架")), "bubblewrap（框架）");
  assert.equal(
    formatAnchorDisplay(createAnchor("anchor-3", "Prompt injection attacks", "提示注入攻击")),
    "提示注入攻击（Prompt injection attacks）"
  );
});

test("normalizeHeadingLikeAnchorText restores a missing english anchor inside a bold pseudo-heading", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "System File Access", "系统文件访问")]
  });
  const source = [
    "No permission prompts are displayed, and the operation completes immediately.",
    "",
    "**Test 2: System File Access**",
    "",
    "Tell Claude:"
  ].join("\n");
  const translated = [
    "没有显示权限提示，操作会立即完成。",
    "",
    "**测试 2：系统文件访问**",
    "",
    "告诉 Claude："
  ].join("\n");

  const normalized = normalizeHeadingLikeAnchorText(source, translated, slice);

  assert.match(normalized, /\*\*测试 2：系统文件访问（System File Access）\*\*/);
  assert.match(normalized, /告诉 Claude：/);
});

test("injectPlannedAnchorText injects a missing anchor into a heading-like line", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "System File Access", "系统文件访问")]
  });
  const source = "**Test 2: System File Access**";
  const translated = "**测试 2：系统文件访问**";

  const normalized = injectPlannedAnchorText(source, translated, slice);

  assert.equal(normalized, "**测试 2：系统文件访问（System File Access）**");
});

test("injectPlannedAnchorText injects a missing anchor into a list item", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "API tokens", "API 令牌")]
  });
  const source = "- API tokens";
  const translated = "- API 令牌";

  const normalized = injectPlannedAnchorText(source, translated, slice);

  assert.equal(normalized, "- API 令牌（API tokens）");
});

test("injectPlannedAnchorText injects a missing anchor into a blockquote line", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Sandbox mode", "沙箱模式")]
  });
  const source = "> Let's now look at what Sandbox mode protects you from.";
  const translated = "> 现在让我们看看沙箱模式会保护你免受什么影响。";

  const normalized = injectPlannedAnchorText(source, translated, slice);

  assert.equal(normalized, "> 现在让我们看看沙箱模式（Sandbox mode）会保护你免受什么影响。");
});

test("injectPlannedAnchorText injects a missing anchor into a paragraph line", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Prompt injection attacks", "提示注入攻击")]
  });
  const source = "Prompt injection attacks can hide malicious instructions.";
  const translated = "提示注入攻击会隐藏恶意指令。";

  const normalized = injectPlannedAnchorText(source, translated, slice);

  assert.equal(normalized, "提示注入攻击（Prompt injection attacks）会隐藏恶意指令。");
});

test("injectPlannedAnchorText does not expand command phrases inside Commands-style list items", () => {
  const slice = createSlice({
    requiredAnchors: [
      createAnchor("anchor-1", "Git", "版本控制工具"),
      createAnchor("anchor-2", "Python", "python")
    ]
  });
  const source = ["- git status, git log, git diff", "- python script.py (runs code in project)"].join("\n");
  const translated = ["- git status、git log、git diff", "- python script.py（在项目中运行代码）"].join("\n");

  const normalized = injectPlannedAnchorText(source, translated, slice);

  assert.equal(normalized, translated);
});

test("normalizeExplicitRepairAnchorText restores a quoted-line anchor from an explicit repair target", () => {
  const slice = createSlice({
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "引用段",
        instruction:
          "第 4 段引用句“现在让我们看看沙箱模式会保护你免受什么影响。”中，关键术语“Sandbox mode”首次出现缺少英文对照，需补为“沙箱模式（Sandbox mode）”，并保留引用结构。"
      }
    ]
  });
  const source = "> Let's now look at what Sandbox mode protects you from.";
  const translated = "> 现在让我们看看沙箱模式会保护你免受什么影响。";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "> 现在让我们看看沙箱模式（Sandbox mode）会保护你免受什么影响。");
});
