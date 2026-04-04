import test from "node:test";
import assert from "node:assert/strict";

import {
  applyAnchorCatalog,
  applyRepairResult,
  applySegmentAudit,
  buildSegmentTaskSlice,
  createTranslationRunState,
  getSegmentState,
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
