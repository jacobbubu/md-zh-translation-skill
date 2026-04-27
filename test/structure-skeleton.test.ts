import test from "node:test";
import assert from "node:assert/strict";

import {
  alignDraftToSourceSkeleton,
  parseStructure,
  planListOverflowTrim,
  planTailTrim,
  type StructuralSkeleton
} from "../src/structure-skeleton.js";

test("parseStructure classifies a list block and counts items", () => {
  const text = "Lead-in.\n\n- a\n- b\n- c\n";
  const skel = parseStructure(text);
  assert.equal(skel.length, 2);
  assert.equal(skel[0]!.kind, "paragraph");
  assert.equal(skel[1]!.kind, "list");
  assert.equal(skel[1]!.listItemCount, 3);
});

test("parseStructure classifies emphasis-headed pseudo-heading as heading", () => {
  const text = "**Step 1: Spec**\n\nBody.\n";
  const skel = parseStructure(text);
  assert.equal(skel[0]!.kind, "heading");
  assert.equal(skel[1]!.kind, "paragraph");
});

test("planTailTrim trims when draft has extra trailing blocks shape-matching earlier ones", () => {
  // source: [para, list, para]
  // draft:  [para, list, para, list, para]  (extra [list, para] at tail)
  const sourceSkel: StructuralSkeleton = [
    { kind: "paragraph", charLen: 12, lineCount: 1 },
    { kind: "list", charLen: 30, lineCount: 3, listItemCount: 3 },
    { kind: "paragraph", charLen: 12, lineCount: 1 }
  ];
  const draftSkel: StructuralSkeleton = [
    { kind: "paragraph", charLen: 12, lineCount: 1 },
    { kind: "list", charLen: 30, lineCount: 3, listItemCount: 3 },
    { kind: "paragraph", charLen: 12, lineCount: 1 },
    { kind: "list", charLen: 30, lineCount: 3, listItemCount: 3 },
    { kind: "paragraph", charLen: 12, lineCount: 1 }
  ];
  const plan = planTailTrim(sourceSkel, draftSkel);
  assert.ok(plan, "expected a tail trim plan");
  assert.equal(plan!.dropFrom, 3);
});

test("planTailTrim refuses to trim when extra trailing block is genuinely new shape", () => {
  // source: [para, list]; draft adds a `code` block which doesn't match
  // any earlier shape — must not trim.
  const sourceSkel: StructuralSkeleton = [
    { kind: "paragraph", charLen: 30, lineCount: 1 },
    { kind: "list", charLen: 30, lineCount: 3, listItemCount: 3 }
  ];
  const draftSkel: StructuralSkeleton = [
    { kind: "paragraph", charLen: 30, lineCount: 1 },
    { kind: "list", charLen: 30, lineCount: 3, listItemCount: 3 },
    { kind: "code", charLen: 50, lineCount: 5 }
  ];
  assert.equal(planTailTrim(sourceSkel, draftSkel), null);
});

test("planListOverflowTrim flags a list block with extra items vs source", () => {
  const sourceSkel: StructuralSkeleton = [
    { kind: "paragraph", charLen: 12, lineCount: 1 },
    { kind: "list", charLen: 30, lineCount: 2, listItemCount: 2 }
  ];
  const draftSkel: StructuralSkeleton = [
    { kind: "paragraph", charLen: 12, lineCount: 1 },
    { kind: "list", charLen: 60, lineCount: 4, listItemCount: 4 }
  ];
  const plan = planListOverflowTrim(sourceSkel, draftSkel);
  assert.ok(plan, "expected a list overflow trim plan");
  assert.equal(plan!.blockIndex, 1);
  assert.equal(plan!.keepItems, 2);
});

test("planListOverflowTrim returns null when block counts diverge", () => {
  const sourceSkel: StructuralSkeleton = [
    { kind: "paragraph", charLen: 12, lineCount: 1 },
    { kind: "list", charLen: 30, lineCount: 2, listItemCount: 2 }
  ];
  const draftSkel: StructuralSkeleton = [
    { kind: "paragraph", charLen: 12, lineCount: 1 },
    { kind: "list", charLen: 30, lineCount: 2, listItemCount: 2 },
    { kind: "paragraph", charLen: 30, lineCount: 1 }
  ];
  // Different block counts → tail trim's job, not list overflow's.
  assert.equal(planListOverflowTrim(sourceSkel, draftSkel), null);
});

test("alignDraftToSourceSkeleton trims small-segment list self-duplication (the spec5 fixture pattern)", () => {
  const source = [
    "When you code from a spec, you are not discovering the design mid-project.",
    "",
    "- No debates about architecture during coding",
    "- No surprise features requested mid-sprint",
    ""
  ].join("\n");
  // Draft has translated 2 bullets correctly then duplicated them — exactly
  // the pattern observed in spec-driven §How To Implement chunk 9 segment 2.
  const draft = [
    "当你从规格写代码时，不是在项目中途发现设计。",
    "",
    "- 编码期间不再争论架构",
    "- 不再有 sprint 中临时插入的需求",
    "- 编码期间不再争论架构",
    "- 不再有 sprint 中临时插入的需求",
    ""
  ].join("\n");

  const aligned = alignDraftToSourceSkeleton(source, draft);
  const items = aligned.split("\n").filter((line) => /^\s*[-*]\s/.test(line));
  assert.equal(items.length, 2, `expected 2 list items after align, got ${items.length}`);
});

test("alignDraftToSourceSkeleton trims [list, summary] tail-block duplication", () => {
  const source = [
    "Here are the tools:",
    "",
    "- alpha",
    "- bravo",
    "- charlie",
    "",
    "These are battle-tested.",
    ""
  ].join("\n");
  // Draft duplicates [list, summary] at the tail.
  const draft = [
    "工具如下：",
    "",
    "- 甲",
    "- 乙",
    "- 丙",
    "",
    "这些都是经过实战检验的。",
    "",
    "- 甲",
    "- 乙",
    "- 丙",
    "",
    "这些都是经过实战检验的。",
    ""
  ].join("\n");

  const aligned = alignDraftToSourceSkeleton(source, draft);
  const skel = parseStructure(aligned);
  // Should be back to [paragraph, list, paragraph].
  assert.equal(skel.length, 3, `expected 3 blocks, got ${skel.length}`);
  assert.equal(skel[0]!.kind, "paragraph");
  assert.equal(skel[1]!.kind, "list");
  assert.equal(skel[1]!.listItemCount, 3);
  assert.equal(skel[2]!.kind, "paragraph");
});

test("alignDraftToSourceSkeleton is a no-op when source and draft share the same skeleton", () => {
  const source = "Lead-in.\n\n- a\n- b\n- c\n";
  const draft = "导语。\n\n- 甲\n- 乙\n- 丙\n";
  const aligned = alignDraftToSourceSkeleton(source, draft);
  assert.equal(aligned, draft);
});

test("alignDraftToSourceSkeleton refuses to trim when extra blocks are genuinely new shape", () => {
  // Source: [para, list]. Draft: [para, list, code]. Code didn't appear
  // earlier in draft, so we must not delete it.
  const source = "Lead-in.\n\n- a\n- b\n";
  const draft = "导语。\n\n- 甲\n- 乙\n\n```\nfn() => {}\n```\n";
  const aligned = alignDraftToSourceSkeleton(source, draft);
  assert.equal(aligned, draft);
});

test("alignDraftToSourceSkeleton tolerates empty inputs", () => {
  assert.equal(alignDraftToSourceSkeleton("", "anything"), "anything");
  assert.equal(alignDraftToSourceSkeleton("anything", ""), "");
});

test("alignDraftToSourceSkeleton refuses to trim when doing so would drop a protected placeholder", () => {
  // Source has 1 list item with a protected link placeholder. Draft has 4
  // list items, with placeholder copies in the duplicates. Trimming the
  // duplicates would also drop placeholder occurrences and break the
  // protected_span_integrity hard check; aligner must abort the trim.
  const source = [
    "Lead-in.",
    "",
    "- See [doc](@@MDZH_LINK_DESTINATION_0001@@)",
    ""
  ].join("\n");
  const draft = [
    "导语。",
    "",
    "- 见 [文档](@@MDZH_LINK_DESTINATION_0001@@)",
    "- 见 [文档](@@MDZH_LINK_DESTINATION_0001@@)",
    "- 见 [文档](@@MDZH_LINK_DESTINATION_0001@@)",
    "- 见 [文档](@@MDZH_LINK_DESTINATION_0001@@)",
    ""
  ].join("\n");

  const aligned = alignDraftToSourceSkeleton(source, draft);
  assert.equal(aligned, draft, "aligner must keep draft untouched when trim would drop placeholders");
});

test("alignDraftToSourceSkeleton trims when no placeholders are touched", () => {
  // Draft duplicates plain bullets without placeholders; source's only
  // placeholder lives in the lead-in paragraph. Trim should fire because
  // the trimmed bullets carry no placeholders.
  const source = [
    "Lead-in with a [link](@@MDZH_LINK_DESTINATION_0001@@).",
    "",
    "- alpha",
    "- bravo",
    ""
  ].join("\n");
  const draft = [
    "导语带 [链接](@@MDZH_LINK_DESTINATION_0001@@)。",
    "",
    "- 甲",
    "- 乙",
    "- 甲",
    "- 乙",
    ""
  ].join("\n");

  const aligned = alignDraftToSourceSkeleton(source, draft);
  const items = aligned.split("\n").filter((line) => /^\s*-\s/.test(line));
  assert.equal(items.length, 2);
  const placeholderCount = (aligned.match(/@@MDZH_LINK_DESTINATION_0001@@/g) ?? []).length;
  assert.equal(placeholderCount, 1);
});
