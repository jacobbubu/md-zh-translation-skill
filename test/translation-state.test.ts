import test from "node:test";
import assert from "node:assert/strict";

import {
  applyAnchorCatalog,
  applyRepairResult,
  applySegmentAudit,
  buildSegmentTaskSlice,
  createTranslationRunState,
  getSegmentState,
  markChunkFailure,
  type AnchorCatalog
} from "../src/translation-state.js";

test("translation state tracks first-occurrence anchors and repeat anchors across segments", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Prompt injection attacks.\n\nPrompt injection attacks again.",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Prompt injection attacks.",
            separatorAfter: "\n\n",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          },
          {
            kind: "translatable",
            source: "Prompt injection attacks again.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const catalog: AnchorCatalog = {
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
  };

  applyAnchorCatalog(state, catalog);

  const firstSlice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.equal(firstSlice.requiredAnchors.length, 1);
  assert.equal(firstSlice.repeatAnchors.length, 0);

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: true, problem: "" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [],
    rawMustFix: []
  });

  const secondSlice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-2");
  assert.equal(secondSlice.requiredAnchors.length, 0);
  assert.equal(secondSlice.repeatAnchors.length, 1);
  assert.equal(secondSlice.repeatAnchors[0]?.english, "Prompt injection attacks");
});

test("translation state keeps repair tasks bound to the target segment only", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: null,
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Body",
        separatorAfter: "",
        headingPath: [],
        segments: [
          {
            kind: "translatable",
            source: "Body",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: false, problem: "missing anchor" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [
      {
        id: "repair-1",
        segmentId: "chunk-1-segment-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "正文段落",
        instruction: "在本段补齐首现中英对照",
        status: "pending"
      }
    ],
    rawMustFix: ["在本段补齐首现中英对照"]
  });

  applyRepairResult(state, "chunk-1-segment-1", ["repair-1"], {
    protectedBody: "Body (fixed)",
    restoredBody: "Body (fixed)"
  });

  const segment = getSegmentState(state, "chunk-1-segment-1");
  assert.equal(segment.phase, "repaired");
  assert.equal(segment.currentProtectedBody, "Body (fixed)");
  assert.equal(state.repairs[0]?.status, "applied");
});

test("translation state carries sentence-local repair constraints into the prompt slice", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: null,
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Body",
        separatorAfter: "",
        headingPath: [],
        segments: [
          {
            kind: "translatable",
            source: "Body",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: false, problem: "missing anchor" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [
      {
        id: "repair-1",
        segmentId: "chunk-1-segment-1",
        anchorId: null,
        failureType: "other",
        locationLabel: "正文句",
        instruction:
          "第 1 句“关键区别在于，强制是在 Linux 的内核层执行的...”应去掉新增的“Linux”限定，保持与原文仅“kernel level”一致。",
        sentenceConstraint: {
          quotedText: "关键区别在于，强制是在 Linux 的内核层执行的...",
          forbiddenTerms: ["Linux"],
          sourceReferenceTexts: ["kernel level"]
        },
        status: "pending"
      }
    ],
    rawMustFix: [
      "第 1 句“关键区别在于，强制是在 Linux 的内核层执行的...”应去掉新增的“Linux”限定，保持与原文仅“kernel level”一致。"
    ]
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.deepEqual(slice.pendingRepairs[0]?.sentenceConstraint, {
    quotedText: "关键区别在于，强制是在 Linux 的内核层执行的...",
    forbiddenTerms: ["Linux"],
    sourceReferenceTexts: ["kernel level"]
  });
});

test("translation state persists chunk-level failure details for bundled audit failures", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: null,
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Body",
        separatorAfter: "",
        headingPath: [],
        segments: [
          {
            kind: "translatable",
            source: "Body",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  markChunkFailure(state, "chunk-1", {
    summary: "segment 1: 标题缺少英文锚定",
    segments: [
      {
        segmentId: "chunk-1-segment-1",
        segmentIndex: 1,
        mustFix: ["标题缺少英文锚定"],
        analysisPlanIds: ["heading:chunk-1-segment-1:system-requirements"],
        analysisTargets: ["系统要求", "System Requirements"]
      }
    ]
  });

  assert.equal(state.chunks[0]?.phase, "failed");
  assert.equal(state.chunks[0]?.lastFailure?.summary, "segment 1: 标题缺少英文锚定");
  assert.deepEqual(state.chunks[0]?.lastFailure?.segments, [
    {
      segmentId: "chunk-1-segment-1",
      segmentIndex: 1,
      mustFix: ["标题缺少英文锚定"],
      analysisPlanIds: ["heading:chunk-1-segment-1:system-requirements"],
      analysisTargets: ["系统要求", "System Requirements"]
    }
  ]);
});

test("translation state coalesces a shorter required anchor when a longer same-segment phrase already covers it", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "- Claude can freely access the npm registry.",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "- Claude can freely access the npm registry.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const catalog: AnchorCatalog = {
    anchors: [
      {
        english: "npm",
        chineseHint: "npm",
        familyKey: "npm",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      },
      {
        english: "npm registry",
        chineseHint: "npm 注册表",
        familyKey: "npm registry",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  };

  applyAnchorCatalog(state, catalog);

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.deepEqual(
    slice.requiredAnchors.map((anchor) => anchor.english),
    ["npm registry"]
  );
});

test("translation state builds a unified analysis IR draft for headings, anchors, and emphasis", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "## Permission Problem\n\n**now has a sandbox mode**",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "## Permission Problem\n\n**now has a sandbox mode**",
            separatorAfter: "",
            spanIds: [],
            headingHints: ["Permission Problem"],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "sandbox mode",
        chineseHint: "沙盒模式",
        familyKey: "sandbox mode",
        displayPolicy: "chinese-primary",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    headingPlans: [
      {
        chunkId: "chunk-1",
        segmentId: "chunk-1-segment-1",
        headingIndex: 1,
        sourceHeading: "Permission Problem",
        strategy: "natural-heading",
        targetHeading: "权限问题"
      }
    ],
    emphasisPlans: [
      {
        chunkId: "chunk-1",
        segmentId: "chunk-1-segment-1",
        emphasisIndex: 1,
        sourceText: "now has a sandbox mode",
        strategy: "preserve-strong",
        targetText: "现在有了沙盒模式（sandbox mode）"
      }
    ],
    ignoredTerms: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.ok(slice.analysisPlans.some((plan) => plan.kind === "heading" && plan.targetText === "权限问题"));
  assert.ok(slice.analysisPlans.some((plan) => plan.kind === "anchor" && plan.english === "sandbox mode"));
  assert.ok(
    slice.analysisPlans.some(
      (plan) => plan.kind === "emphasis" && plan.targetText === "现在有了沙盒模式（sandbox mode）"
    )
  );
  assert.ok(slice.analysisPlans.some((plan) => plan.kind === "block" && plan.blockKind === "heading"));
  assert.ok(
    slice.analysisPlans.some(
      (plan) => plan.kind === "block" && plan.sourceText.includes("now has a sandbox mode")
    )
  );
  assert.match(slice.analysisPlanDraft, /<SEGMENT id="chunk-1-segment-1">/);
  assert.match(slice.analysisPlanDraft, /kind="heading"/);
  assert.match(slice.analysisPlanDraft, /kind="anchor"/);
  assert.match(slice.analysisPlanDraft, /kind="emphasis"/);
  assert.match(slice.analysisPlanDraft, /kind="block"/);
});

test("translation state links pending repairs to matching analysis IR plans", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Title",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Sandbox mode is now active.",
        separatorAfter: "",
        headingPath: ["Title"],
        segments: [
          {
            kind: "translatable",
            source: "Sandbox mode is now active.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "sandbox mode",
        chineseHint: "沙盒模式",
        familyKey: "sandbox mode",
        displayPolicy: "chinese-primary",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    headingPlans: [],
    emphasisPlans: [],
    ignoredTerms: []
  });

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: false, problem: "missing anchor" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [
      {
        id: "repair-1",
        segmentId: "chunk-1-segment-1",
        anchorId: "anchor-1",
        failureType: "missing_anchor",
        locationLabel: "当前句",
        instruction: "当前句“Sandbox mode is now active.”中的“sandbox mode”需补为“沙盒模式（sandbox mode）”。",
        status: "pending"
      }
    ],
    rawMustFix: ["当前句“Sandbox mode is now active.”中的“sandbox mode”需补为“沙盒模式（sandbox mode）”。"]
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.deepEqual(slice.pendingRepairs[0]?.analysisPlanIds, ["anchor:anchor-1"]);
  assert.deepEqual(slice.pendingRepairs[0]?.analysisPlanKinds, ["anchor"]);
  assert.ok(slice.pendingRepairs[0]?.analysisTargets?.includes("sandbox mode"));
});

test("translation state synthesizes local fallback anchors from bound IR targets even when repair text is vague", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Title",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "> This creates approval fatigue in teams.",
        separatorAfter: "",
        headingPath: ["Title"],
        segments: [
          {
            kind: "translatable",
            source: "> This creates approval fatigue in teams.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: ["当前分段包含引用段落"]
          }
        ]
      }
    ]
  });

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: false, problem: "missing anchor" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [
      {
        id: "repair-1",
        segmentId: "chunk-1-segment-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "引用段",
        instruction: "需在引用句本身补齐首现锚定。",
        analysisPlanIds: ["anchor:local-approval-fatigue"],
        analysisPlanKinds: ["anchor"],
        analysisTargets: ["approval fatigue", "批准疲劳（approval fatigue）"],
        status: "pending"
      }
    ],
    rawMustFix: ["需在引用句本身补齐首现锚定。"]
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  const localAnchor = slice.requiredAnchors.find((anchor) => anchor.english === "approval fatigue");
  assert.ok(localAnchor);
  assert.equal(localAnchor?.canonicalDisplay, "批准疲劳（approval fatigue）");
});

test("translation state synthesizes a local fallback anchor for a longer list-item qualifier named by repair", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "- Pre-approved destinations (npm registry, GitHub, your APIs)",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "- Pre-approved destinations (npm registry, GitHub, your APIs)",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
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
  });

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: true, problem: "" },
      numbers_units_logic: {
        pass: false,
        problem: "第 1 个项目符号需保留 `npm registry` 这一限定，不要只写成 `npm`。"
      },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [
      {
        id: "repair-1",
        segmentId: "chunk-1-segment-1",
        anchorId: "local:chunk-1-segment-1:npm-registry",
        failureType: "other",
        locationLabel: "列表项",
        instruction: "第 1 个项目符号需保留 `npm registry` 这一限定，不要只写成 `npm`。",
        status: "pending"
      }
    ],
    rawMustFix: ["第 1 个项目符号需保留 `npm registry` 这一限定，不要只写成 `npm`。"]
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.equal(slice.requiredAnchors.some((anchor) => anchor.english === "npm registry"), true);
});

test("translation state synthesizes a local fallback anchor from a structured repair target", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "- Pre-approved destinations (npm registry, GitHub, your APIs)",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "- Pre-approved destinations (npm registry, GitHub, your APIs)",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: false, problem: "缺少首现锚定" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [
      {
        id: "repair-1",
        segmentId: "chunk-1-segment-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "第 1 个项目符号",
        instruction: "请按结构化目标修复本条项目符号。",
        structuredTarget: {
          location: "第 1 个项目符号",
          kind: "list_item",
          currentText: "npm",
          targetText: "npm 注册表（npm registry）",
          english: "npm registry",
          chineseHint: "npm 注册表"
        },
        status: "pending"
      }
    ],
    rawMustFix: ["请按结构化目标修复本条项目符号。"]
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.equal(slice.requiredAnchors.some((anchor) => anchor.english === "npm registry"), true);
});

test("translation state reconciles a shorter family local fallback target to an existing longer canonical anchor", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Run these tests to verify the sandbox is working well.\n\nsandbox mode is active.",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Run these tests to verify the sandbox is working well.\n\nsandbox mode is active.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "sandbox mode",
        chineseHint: "沙盒模式",
        familyKey: "sandbox-mode",
        displayPolicy: "chinese-primary",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  });

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: false, problem: "missing anchor" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [
      {
        id: "repair-1",
        segmentId: "chunk-1-segment-1",
        anchorId: null,
        failureType: "other",
        locationLabel: "第 2 个段落",
        instruction: "第 2 个段落中的“沙盒模式（sandbox）”必须改为与既定锚点一致的“沙盒模式（sandbox mode）”或仅保留“沙盒模式”。",
        structuredTarget: {
          location: "第 2 个段落",
          kind: "sentence",
          currentText: "沙盒模式（sandbox）",
          targetText: "沙盒模式（sandbox mode）",
          english: "sandbox",
          chineseHint: "沙盒模式"
        },
        status: "pending"
      }
    ],
    rawMustFix: ["第 2 个段落中的“沙盒模式（sandbox）”必须改为与既定锚点一致的“沙盒模式（sandbox mode）”或仅保留“沙盒模式”。"]
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  const sandboxModeAnchor = slice.requiredAnchors.find((anchor) => anchor.english === "sandbox mode");
  const sandboxAnchor = slice.requiredAnchors.find((anchor) => anchor.english === "sandbox");
  assert.ok(sandboxModeAnchor);
  assert.equal(sandboxAnchor, undefined);
});

test("translation state suppresses conflicting product anchors when entity disambiguation governs the segment", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "This is not Claude code by default.",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "This is not Claude code by default.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "Claude Code",
        chineseHint: "Anthropic 的命令行编码助手",
        familyKey: "claude-code",
        displayPolicy: "english-primary",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    entityDisambiguationPlans: [
      {
        chunkId: "chunk-1",
        segmentId: "chunk-1-segment-1",
        sourceText: "This is not Claude code by default.",
        english: "Claude code",
        targetText: "Claude 代码",
        forbiddenDisplays: ["Claude Code", "Claude Code（Anthropic 的命令行编码助手）"],
        lineIndex: 1
      }
    ],
    ignoredTerms: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.equal(slice.requiredAnchors.some((anchor) => anchor.english === "Claude Code"), false);
  assert.equal(slice.analysisPlans.some((plan) => plan.kind === "disambiguation"), true);
});

test("translation state synthesizes a local fallback anchor for an inline concept named by repair", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "> This creates what security researchers call \"approval fatigue.\"",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "> This creates what security researchers call \"approval fatigue.\"",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: false, problem: "" },
      first_mention_bilingual: { pass: false, problem: "" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [
      {
        id: "repair-1",
        segmentId: "chunk-1-segment-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "引用句",
        instruction:
          "位置：`批准疲劳`。问题：首次出现的工具/专名未完整建立中英文对照。修复目标：在该位置本身需补为“批准疲劳（approval fatigue）”。",
        status: "pending"
      }
    ],
    rawMustFix: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  const fallbackAnchor = slice.requiredAnchors.find((anchor) => anchor.english === "approval fatigue");
  assert.equal(fallbackAnchor?.displayPolicy, "chinese-primary");
  assert.equal(fallbackAnchor?.chineseHint, "批准疲劳");
});

test("translation state infers acronym-compound display policy for acronym-led anchors", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "- SSH keys\n- API tokens",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "- SSH keys\n- API tokens",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const catalog: AnchorCatalog = {
    anchors: [
      {
        english: "SSH keys",
        chineseHint: "SSH 密钥",
        familyKey: "ssh key",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      },
      {
        english: "API tokens",
        chineseHint: "API 令牌",
        familyKey: "api token",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  };

  applyAnchorCatalog(state, catalog);

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.deepEqual(
    slice.requiredAnchors.map((anchor) => [anchor.english, anchor.displayPolicy]),
    [
      ["SSH keys", "acronym-compound"],
      ["API tokens", "acronym-compound"]
    ]
  );
});

test("translation state infers english-primary display policy for english-led tool hints", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "**Option 2: cco Sandbox**",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "**Option 2: cco Sandbox**",
            separatorAfter: "",
            spanIds: [],
            headingHints: ["Option 2: cco Sandbox"],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const catalog: AnchorCatalog = {
    anchors: [
      {
        english: "cco Sandbox",
        chineseHint: "cco 沙箱工具",
        familyKey: "cco sandbox",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  };

  applyAnchorCatalog(state, catalog);

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.equal(slice.requiredAnchors[0]?.displayPolicy, "english-primary");
  assert.equal(slice.requiredAnchors[0]?.displayMode, "english-primary");
});

test("translation state matches anchors through emphasis-fragmented source text", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "This is enforced by Linux *Seatbel*t.",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "This is enforced by Linux *Seatbel*t.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const catalog: AnchorCatalog = {
    anchors: [
      {
        english: "Seatbelt",
        chineseHint: "Seatbelt",
        familyKey: "seatbelt",
        displayPolicy: "english-only",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  };

  applyAnchorCatalog(state, catalog);

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.equal(slice.requiredAnchors[0]?.english, "Seatbelt");
  assert.equal(slice.requiredAnchors[0]?.displayPolicy, "english-only");
});

test("translation state synthesizes local fallback anchors for heading-like configuration titles named by repair", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "## Filesystem Permissions (Critical )\n\n**Permission Pattern Syntax**",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "## Filesystem Permissions (Critical )\n\n**Permission Pattern Syntax**",
            separatorAfter: "",
            spanIds: [],
            headingHints: ["Filesystem Permissions (Critical )", "Permission Pattern Syntax"],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: false, problem: "" },
      first_mention_bilingual: { pass: false, problem: "" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [
      {
        id: "repair-1",
        segmentId: "chunk-1-segment-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "标题",
        instruction:
          "位置：`## 文件系统权限（关键）`。问题：首次出现的关键术语 `Filesystem Permissions` 未保留中英对照。修复目标：在标题内补成合法的中英锚定形式。",
        status: "pending"
      },
      {
        id: "repair-2",
        segmentId: "chunk-1-segment-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "标题",
        instruction:
          "位置：`**权限模式语法**`。问题：首次出现的关键术语 `Permission Pattern Syntax` 未保留中英对照。修复目标：在该标题内补成合法的中英锚定形式。",
        status: "pending"
      }
    ],
    rawMustFix: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  const filesystemAnchor = slice.requiredAnchors.find((anchor) => anchor.english === "Filesystem Permissions");
  const syntaxAnchor = slice.requiredAnchors.find((anchor) => anchor.english === "Permission Pattern Syntax");

  assert.equal(filesystemAnchor?.displayPolicy, "chinese-primary");
  assert.equal(filesystemAnchor?.chineseHint, "文件系统权限");
  assert.equal(syntaxAnchor?.displayPolicy, "chinese-primary");
  assert.equal(syntaxAnchor?.chineseHint, "权限模式语法");
});

test("translation state does not synthesize heading-local anchors directly from heading hints without plans", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "## Filesystem Permissions (Critical )\n\n**Permission Pattern Syntax**\n\n**Paths:**",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "## Filesystem Permissions (Critical )\n\n**Permission Pattern Syntax**\n\n**Paths:**",
            separatorAfter: "",
            spanIds: [],
            headingHints: ["Filesystem Permissions (Critical )", "Permission Pattern Syntax", "Paths:"],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1", {
    currentRestoredBody: "## 文件系统权限（关键）\n\n**权限模式语法**\n\n**路径：**"
  });

  assert.deepEqual(slice.requiredAnchors, []);
});

test("translation state does not heuristically synthesize heading anchors without LLM plans or explicit repair", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "### System Requirements\n\n**Supported Platforms:**",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "### System Requirements\n\n**Supported Platforms:**",
            separatorAfter: "",
            spanIds: [],
            headingHints: ["System Requirements", "Supported Platforms:"],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyRepairResult(state, "chunk-1-segment-1", [], {
    protectedBody: "### 系统要求\n\n**支持的平台：**",
    restoredBody: "### 系统要求\n\n**支持的平台：**"
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1", {
    currentRestoredBody: "### 系统要求\n\n**支持的平台：**"
  });

  assert.equal(slice.requiredAnchors.some((anchor) => anchor.english === "System Requirements"), false);
  assert.equal(slice.requiredAnchors.some((anchor) => anchor.english === "Supported Platforms"), false);
});

test("translation state synthesizes a constrained heading fallback when a global anchor exactly matches a heading hint", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "### Prompt Injection Attacks",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "### Prompt Injection Attacks",
            separatorAfter: "",
            spanIds: [],
            headingHints: ["Prompt Injection Attacks"],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "prompt injection attacks",
        chineseHint: "提示注入攻击",
        familyKey: "prompt-injection",
        displayPolicy: "chinese-primary",
        sourceForms: ["prompt injection attacks", "Prompt Injection Attacks"],
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    headingPlans: [],
    ignoredTerms: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1", {
    currentRestoredBody: "### 提示注入攻击"
  });

  assert.equal(slice.requiredAnchors.some((anchor) => anchor.english === "prompt injection attacks"), true);
  const headingFallback = slice.requiredAnchors.find((anchor) => anchor.english === "prompt injection attacks");
  assert.ok(headingFallback);
  assert.equal(headingFallback?.canonicalDisplay, "提示注入攻击（prompt injection attacks）");
});

test("translation state reconciles conflicting heading and block plans with an exact governed anchor", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "# Title\n\n### Prompt Injection Attacks",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "# Title\n\n### Prompt Injection Attacks",
            separatorAfter: "",
            spanIds: [],
            headingHints: ["Title", "Prompt Injection Attacks"],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "prompt injection attacks",
        chineseHint: "提示注入攻击",
        familyKey: "prompt-injection",
        displayPolicy: "chinese-primary",
        sourceForms: ["prompt injection attacks", "Prompt Injection Attacks"],
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    headingPlans: [
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
    blockPlans: [
      {
        chunkId: "chunk-1",
        segmentId: "chunk-1-segment-1",
        blockIndex: 1,
        blockKind: "heading",
        sourceText: "### Prompt Injection Attacks",
        targetText: "### 提示注入攻击"
      }
    ],
    ignoredTerms: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1", {
    currentRestoredBody: "### 提示注入攻击"
  });

  assert.equal(slice.headingPlans[0]?.targetHeading, "提示注入攻击（Prompt Injection Attacks）");
  assert.deepEqual(slice.blockPlans, [
    {
      blockIndex: 1,
      blockKind: "heading",
      sourceText: "### Prompt Injection Attacks",
      targetText: "### 提示注入攻击（Prompt Injection Attacks）"
    }
  ]);
  assert.equal(slice.requiredAnchors.some((anchor) => anchor.english === "prompt injection attacks"), true);
});

test("translation state prefers LLM heading plans over heuristic heading planning", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "**Glob Patterns:**\n\n**Examples:**",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "**Glob Patterns:**\n\n**Examples:**",
            separatorAfter: "",
            spanIds: [],
            headingHints: ["Glob Patterns:", "Examples:"],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [],
    headingPlans: [
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
        targetHeading: "示例："
      }
    ],
    ignoredTerms: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1", {
    currentRestoredBody: "**Glob 模式：**\n\n**示例：**"
  });

  assert.deepEqual(
    slice.requiredAnchors.map((anchor) => [anchor.english, anchor.chineseHint]),
    [["Patterns", "模式"]]
  );
  assert.deepEqual(
    slice.headingPlans.map((plan) => [plan.sourceHeading, plan.strategy, plan.targetHeading ?? ""]),
    [
      ["Glob Patterns:", "mixed-qualifier", "Glob 模式（Patterns）："],
      ["Examples:", "none", "示例："]
    ]
  );
});

test("translation state prefers LLM block plans over heuristic block planning", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Intro paragraph.\n\n- first\n- second",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Intro paragraph.\n\n- first\n- second",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [],
    headingPlans: [],
    emphasisPlans: [],
    blockPlans: [
      {
        chunkId: "chunk-1",
        segmentId: "chunk-1-segment-1",
        blockIndex: 1,
        blockKind: "paragraph",
        sourceText: "Intro paragraph.",
        targetText: "介绍段落。"
      },
      {
        chunkId: "chunk-1",
        segmentId: "chunk-1-segment-1",
        blockIndex: 2,
        blockKind: "list",
        sourceText: "- first\n- second",
        targetText: "- 第一项\n- 第二项"
      }
    ],
    ignoredTerms: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");

  assert.deepEqual(slice.blockPlans, [
    {
      blockIndex: 1,
      blockKind: "paragraph",
      sourceText: "Intro paragraph.",
      targetText: "介绍段落。"
    },
    {
      blockIndex: 2,
      blockKind: "list",
      sourceText: "- first\n- second",
      targetText: "- 第一项\n- 第二项"
    }
  ]);
  assert.ok(slice.analysisPlanDraft.includes('kind="block"'));
  assert.ok(slice.analysisPlanDraft.includes('source="Intro paragraph."'));
  assert.ok(slice.analysisPlanDraft.includes('target="介绍段落。"'));
});

test("translation state reconciles emphasis and block targets to the canonical bilingual anchor display", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Claude Code **now has a sandbox mode** that makes the YOLO mode look amateurish.",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Claude Code **now has a sandbox mode** that makes the YOLO mode look amateurish.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "sandbox mode",
        chineseHint: "沙盒模式",
        familyKey: "sandbox mode",
        displayPolicy: "chinese-primary",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      },
      {
        english: "YOLO mode",
        chineseHint: "YOLO 模式",
        familyKey: "yolo mode",
        displayPolicy: "english-primary",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    emphasisPlans: [
      {
        chunkId: "chunk-1",
        segmentId: "chunk-1-segment-1",
        emphasisIndex: 1,
        lineIndex: 1,
        sourceText: "now has a sandbox mode",
        strategy: "preserve-strong",
        targetText: "现在有了沙盒模式",
        governedTerms: ["sandbox mode"]
      }
    ],
    blockPlans: [
      {
        chunkId: "chunk-1",
        segmentId: "chunk-1-segment-1",
        blockIndex: 1,
        blockKind: "paragraph",
        sourceText: "Claude Code **now has a sandbox mode** that makes the YOLO mode look amateurish.",
        targetText: "Claude Code 现在有了沙盒模式，让 YOLO 模式显得很业余。"
      }
    ],
    ignoredTerms: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");

  assert.equal(slice.emphasisPlans[0]?.targetText, "现在有了沙盒模式（sandbox mode）");
  assert.equal(
    slice.blockPlans[0]?.targetText,
    "Claude Code 现在有了沙盒模式（sandbox mode），让 YOLO mode（YOLO 模式）显得很业余。"
  );
});

test("translation state suppresses conflicting global heading anchors when a headingPlan target governs the title", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "## Claude Code Permission Problem",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "## Claude Code Permission Problem",
            separatorAfter: "",
            spanIds: [],
            headingHints: ["Claude Code Permission Problem"],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "Permission Problem",
        chineseHint: "权限问题",
        familyKey: "permission problem",
        displayPolicy: "chinese-primary",
        sourceForms: ["Permission Problem"],
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    headingPlans: [
      {
        chunkId: "chunk-1",
        segmentId: "chunk-1-segment-1",
        headingIndex: 1,
        sourceHeading: "Claude Code Permission Problem",
        strategy: "natural-heading",
        targetHeading: "Claude Code 的权限问题",
        governedTerms: ["Claude Code", "Permission Problem"]
      }
    ],
    ignoredTerms: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");

  assert.deepEqual(slice.requiredAnchors, []);
  assert.deepEqual(slice.headingPlanGovernedAnchorIds, ["anchor-1"]);
  assert.equal(slice.headingPlans[0]?.targetHeading, "Claude Code 的权限问题");
});

test("translation state exposes canonical display metadata for english-primary anchors", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Filesystem permissions control what Claude can access.",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Filesystem permissions control what Claude can access.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "Claude",
        chineseHint: "Anthropic 的 AI 助手",
        familyKey: "claude-family",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  assert.equal(slice.requiredAnchors[0]?.displayMode, "english-primary");
  assert.equal(slice.requiredAnchors[0]?.canonicalDisplay, "Claude（Anthropic 的 AI 助手）");
  assert.deepEqual(slice.requiredAnchors[0]?.allowedDisplayForms, ["Claude（Anthropic 的 AI 助手）"]);
});

test("translation state allows bare repeat text for established english-primary anchors", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Claude can access files.\n\n- When Claude tries to access a file.\n- When Claude attempts a network request.",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Claude can access files.",
            separatorAfter: "\n\n",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          },
          {
            kind: "translatable",
            source: "- When Claude tries to access a file.\n- When Claude attempts a network request.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "Claude",
        chineseHint: "Anthropic 的 AI 助手",
        familyKey: "claude-family",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  });

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: true, problem: "" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [],
    rawMustFix: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-2");
  assert.equal(slice.repeatAnchors[0]?.displayMode, "english-primary");
  assert.equal(slice.repeatAnchors[0]?.canonicalDisplay, "Claude（Anthropic 的 AI 助手）");
  assert.deepEqual(slice.repeatAnchors[0]?.allowedDisplayForms, [
    "Claude（Anthropic 的 AI 助手）",
    "Claude"
  ]);
});

test("translation state does not treat a singular anchor as mentioned by a pluralized source variant", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Claude Code sandbox is enabled.\n\nThis is my quick reference for standard commands when working with Claude Code sandboxes.",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Claude Code sandbox is enabled.",
            separatorAfter: "\n\n",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          },
          {
            kind: "translatable",
            source: "This is my quick reference for standard commands when working with Claude Code sandboxes.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "Claude Code sandbox",
        chineseHint: "沙箱模式",
        familyKey: "claude-code-sandbox-mode",
        displayPolicy: "chinese-primary",
        sourceForms: ["Claude Code sandbox"],
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  });

  applySegmentAudit(state, {
    segmentId: "chunk-1-segment-1",
    hardChecks: {
      paragraph_match: { pass: true, problem: "" },
      first_mention_bilingual: { pass: true, problem: "" },
      numbers_units_logic: { pass: true, problem: "" },
      chinese_punctuation: { pass: true, problem: "" },
      unit_conversion_boundary: { pass: true, problem: "" },
      protected_span_integrity: { pass: true, problem: "" }
    },
    repairTasks: [],
    rawMustFix: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-2");
  assert.equal(slice.requiredAnchors.length, 0);
  assert.equal(slice.repeatAnchors.length, 0);
  assert.equal(slice.establishedAnchors.some((anchor) => anchor.english === "Claude Code sandbox"), true);
});

test("buildSegmentTaskSlice generates an ownerMap covering anchors and plans (#2 P1 step 1)", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "## Claude Code\n\nClaude Code is useful.",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "## Claude Code\n\nClaude Code is useful.",
            separatorAfter: "",
            spanIds: ["span-1"],
            headingHints: ["Claude Code"],
            specialNotes: []
          }
        ]
      }
    ]
  });

  applyAnchorCatalog(state, {
    anchors: [
      {
        english: "Claude Code",
        chineseHint: "Claude Code",
        familyKey: "claude code",
        displayPolicy: "english-only",
        firstOccurrence: { chunkId: "chunk-1", segmentId: "chunk-1-segment-1" }
      }
    ],
    headingPlans: [
      {
        chunkId: "chunk-1",
        segmentId: "chunk-1-segment-1",
        headingIndex: 1,
        sourceHeading: "Claude Code",
        strategy: "source-template",
        targetHeading: "Claude Code",
        english: "Claude Code",
        chineseHint: "Claude Code"
      }
    ],
    ignoredTerms: []
  });

  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");
  const map = slice.ownerMap ?? [];

  assert.ok(map.some((entry) => entry.ownerType === "protected" && entry.planId === "span-1"));
  assert.ok(map.some((entry) => entry.ownerType === "heading" && entry.sourceText === "Claude Code"));
  // `Claude Code` 由 headingPlan 接管（headingPlanGovernedAnchorIds），不再
  // 作为 mention owner 重复登记——这是 P1 reconciliation 的期望行为。
});
