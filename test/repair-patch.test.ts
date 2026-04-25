import test from "node:test";
import assert from "node:assert/strict";

import { applyStructuredRepairPatches } from "../src/repair-patch.js";
import type { RepairTask } from "../src/translation-state.js";

function makeTask(overrides: Partial<RepairTask> & { id: string }): RepairTask {
  return {
    segmentId: "chunk-1-segment-1",
    anchorId: null,
    failureType: "missing_anchor",
    locationLabel: "第 1 个项目符号",
    instruction: "首现需补双语",
    status: "pending",
    ...overrides
  };
}

test("applies a unique-match patch and returns the new body", () => {
  const body = "- npm 是包管理器。\n";
  const result = applyStructuredRepairPatches(body, [
    makeTask({
      id: "r1",
      structuredTarget: {
        location: "第 1 个项目符号",
        kind: "list_item",
        currentText: "npm",
        targetText: "npm 注册表（npm registry）"
      }
    })
  ]);

  assert.equal(result.patchedBody, "- npm 注册表（npm registry） 是包管理器。\n");
  assert.deepEqual(result.appliedTaskIds, ["r1"]);
  assert.equal(result.remainingTasks.length, 0);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]!.status, "applied");
});

test("skips ambiguous current text appearing more than once", () => {
  const body = "npm 一处。npm 又一处。";
  const task = makeTask({
    id: "r1",
    structuredTarget: {
      location: "第 1 处",
      kind: "list_item",
      currentText: "npm",
      targetText: "npm 注册表"
    }
  });
  const result = applyStructuredRepairPatches(body, [task]);

  assert.equal(result.patchedBody, body);
  assert.deepEqual(result.appliedTaskIds, []);
  assert.equal(result.remainingTasks[0], task);
  assert.equal(result.attempts[0]!.status, "skipped");
  assert.equal((result.attempts[0] as { reason: string }).reason, "current_text_ambiguous");
});

test("skips when current text is missing entirely", () => {
  const body = "完全无关的内容。";
  const task = makeTask({
    id: "r1",
    structuredTarget: {
      location: "第 1 处",
      kind: "list_item",
      currentText: "npm",
      targetText: "npm 注册表"
    }
  });
  const result = applyStructuredRepairPatches(body, [task]);

  assert.equal(result.patchedBody, body);
  assert.equal((result.attempts[0] as { reason: string }).reason, "current_not_found");
});

test("skips when structuredTarget is missing", () => {
  const body = "样例正文";
  const task = makeTask({ id: "r1" });
  const result = applyStructuredRepairPatches(body, [task]);

  assert.equal((result.attempts[0] as { reason: string }).reason, "no_structured_target");
});

test("skips when currentText or targetText is missing or equal", () => {
  const body = "abc";
  const result = applyStructuredRepairPatches(body, [
    makeTask({
      id: "r1",
      structuredTarget: { location: "x", kind: "list_item", currentText: "a", targetText: "" }
    }),
    makeTask({
      id: "r2",
      structuredTarget: { location: "x", kind: "list_item", currentText: "a", targetText: "a" }
    })
  ]);

  assert.equal(result.appliedTaskIds.length, 0);
  for (const attempt of result.attempts) {
    assert.equal(attempt.status, "skipped");
    assert.equal((attempt as { reason: string }).reason, "missing_current_or_target");
  }
});

test("refuses to patch a placeholder-bearing currentText", () => {
  const body = "前文 @@MDZH_LINK_DESTINATION_0001@@ 后文";
  const task = makeTask({
    id: "r1",
    structuredTarget: {
      location: "x",
      kind: "list_item",
      currentText: "前文 @@MDZH_LINK_DESTINATION_0001@@",
      targetText: "中文（English）"
    }
  });

  const result = applyStructuredRepairPatches(body, [task]);
  assert.equal(result.patchedBody, body);
  assert.equal((result.attempts[0] as { reason: string }).reason, "current_contains_placeholder");
});

test("refuses to patch when target would introduce a placeholder pattern", () => {
  const body = "中文";
  const task = makeTask({
    id: "r1",
    structuredTarget: {
      location: "x",
      kind: "list_item",
      currentText: "中文",
      targetText: "中文 @@MDZH_LINK_DESTINATION_0099@@ 说明"
    }
  });
  const result = applyStructuredRepairPatches(body, [task]);
  assert.equal(result.patchedBody, body);
  assert.equal((result.attempts[0] as { reason: string }).reason, "target_contains_placeholder");
});

test("applies multiple compatible patches sequentially", () => {
  const body = "alpha 与 beta 各自独立。";
  const result = applyStructuredRepairPatches(body, [
    makeTask({
      id: "r1",
      structuredTarget: {
        location: "x",
        kind: "anchor",
        currentText: "alpha",
        targetText: "alpha（甲）"
      }
    }),
    makeTask({
      id: "r2",
      structuredTarget: {
        location: "y",
        kind: "anchor",
        currentText: "beta",
        targetText: "beta（乙）"
      }
    })
  ]);

  assert.equal(result.patchedBody, "alpha（甲） 与 beta（乙） 各自独立。");
  assert.deepEqual(result.appliedTaskIds, ["r1", "r2"]);
  assert.equal(result.remainingTasks.length, 0);
});

test("partial application: some tasks land, others stay for the LLM lane", () => {
  const body = "alpha 一处。重复 重复 出现两次。";
  const result = applyStructuredRepairPatches(body, [
    makeTask({
      id: "r1",
      structuredTarget: {
        location: "x",
        kind: "anchor",
        currentText: "alpha",
        targetText: "alpha（甲）"
      }
    }),
    makeTask({
      id: "r2",
      structuredTarget: {
        location: "y",
        kind: "anchor",
        currentText: "重复",
        targetText: "已修"
      }
    })
  ]);

  assert.equal(result.patchedBody, "alpha（甲） 一处。重复 重复 出现两次。");
  assert.deepEqual(result.appliedTaskIds, ["r1"]);
  assert.equal(result.remainingTasks.length, 1);
  assert.equal(result.remainingTasks[0]!.id, "r2");
});

test("preserves all protected placeholders in the body", () => {
  const body = "前 @@MDZH_LINK_DESTINATION_0001@@ alpha 后 @@MDZH_AUTOLINK_0002@@";
  const result = applyStructuredRepairPatches(body, [
    makeTask({
      id: "r1",
      structuredTarget: {
        location: "x",
        kind: "anchor",
        currentText: "alpha",
        targetText: "alpha（甲）"
      }
    })
  ]);

  assert.match(result.patchedBody, /@@MDZH_LINK_DESTINATION_0001@@/);
  assert.match(result.patchedBody, /@@MDZH_AUTOLINK_0002@@/);
  assert.equal(result.patchedBody, "前 @@MDZH_LINK_DESTINATION_0001@@ alpha（甲） 后 @@MDZH_AUTOLINK_0002@@");
});
