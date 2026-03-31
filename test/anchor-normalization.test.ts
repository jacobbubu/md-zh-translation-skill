import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSegmentAnchorText, type PromptAnchor } from "../src/anchor-normalization.js";
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
