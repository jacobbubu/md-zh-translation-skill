import test from "node:test";
import assert from "node:assert/strict";

import {
  applyEmphasisPlanTargets,
  formatAnchorDisplay,
  injectPlannedAnchorText,
  normalizeExplicitRepairAnchorText,
  normalizeHeadingLikeAnchorText,
  normalizeSegmentAnchorText,
  normalizeSourceSurfaceAnchorText,
  type PromptAnchor
} from "../src/anchor-normalization.js";
import type { PromptSlice } from "../src/translation-state.js";

function createAnchor(
  anchorId: string,
  english: string,
  chineseHint: string,
  familyId = anchorId,
  displayPolicy: PromptAnchor["displayPolicy"] = "auto",
  category?: string
): PromptAnchor {
  return {
    anchorId,
    english,
    chineseHint,
    ...(category ? { category } : {}),
    familyId,
    requiresBilingual: displayPolicy !== "english-only",
    displayPolicy
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
    headingPlans: [],
    emphasisPlans: [],
    blockPlans: [],
    aliasPlans: [],
    entityDisambiguationPlans: [],
    requiredAnchors: [],
    repeatAnchors: [],
    establishedAnchors: [],
    protectedSpanIds: [],
    pendingRepairs: [],
    headingPlanGovernedAnchorIds: [],
    analysisPlans: [],
    analysisPlanDraft: '<SEGMENT id="chunk-1-segment-1">\n</SEGMENT>',
    ownerMap: [],
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

test("normalizeSegmentAnchorText restores mixed chinese-primary anchors to their canonical form", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "sandbox mode", "沙箱模式")]
  });

  const normalized = normalizeSegmentAnchorText(
    "Sandbox 模式（sandbox mode）现已在本次会话中启用。",
    slice
  );

  assert.equal(normalized, "沙箱模式（sandbox mode）现已在本次会话中启用。");
});

test("normalizeSegmentAnchorText strips freshness prefixes from chinese-primary canonical anchors", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "sandbox mode", "沙箱模式")]
  });

  const normalized = normalizeSegmentAnchorText(
    "Claude Code 的新沙箱模式（sandbox mode）用一种更有创新性的方式同时解决了这两个问题。",
    slice
  );

  assert.equal(
    normalized,
    "Claude Code 的沙箱模式（sandbox mode）用一种更有创新性的方式同时解决了这两个问题。"
  );
});

test("normalizeHeadingLikeAnchorText treats targetHeading as terminal for governed titles", () => {
  const slice = createSlice({
    headingPlans: [
      {
        headingIndex: 1,
        sourceHeading: "Claude Code Permission Problem",
        strategy: "natural-heading",
        targetHeading: "Claude Code 的权限问题",
        governedTerms: ["Claude Code", "Permission Problem"]
      }
    ],
    requiredAnchors: [createAnchor("anchor-1", "Permission Problem", "权限问题")]
  });

  const normalized = normalizeHeadingLikeAnchorText(
    "## Claude Code Permission Problem",
    "## Claude Code 的权限问题",
    slice
  );

  assert.equal(normalized, "## Claude Code 的权限问题");
});

test("applyEmphasisPlanTargets restores translatable strong emphasis from LLM plans", () => {
  const slice = createSlice({
    emphasisPlans: [
      {
        emphasisIndex: 1,
        lineIndex: 1,
        sourceText: "now has a sandbox mode",
        strategy: "preserve-strong",
        targetText: "现在有了沙盒模式（sandbox mode）",
        governedTerms: ["sandbox mode"]
      }
    ]
  });

  const normalized = applyEmphasisPlanTargets(
    "Claude Code **now has a sandbox mode** that makes the YOLO mode look amateurish.",
    "Claude Code 现在有了沙盒模式（sandbox mode），让 YOLO 模式看起来像业余方案。",
    slice
  );

  assert.equal(normalized, "Claude Code **现在有了沙盒模式（sandbox mode）**，让 YOLO 模式看起来像业余方案。");
});

test("applyEmphasisPlanTargets canonicalizes the chinese skeleton before restoring emphasis", () => {
  const slice = createSlice({
    emphasisPlans: [
      {
        emphasisIndex: 1,
        lineIndex: 1,
        sourceText: "now has a sandbox mode",
        strategy: "preserve-strong",
        targetText: "现在有了沙盒模式（sandbox mode）",
        governedTerms: ["sandbox mode"]
      }
    ]
  });

  const normalized = applyEmphasisPlanTargets(
    "Claude Code **now has a sandbox mode** that makes the YOLO mode look amateurish.",
    "Claude Code 现在有了沙盒模式，让 YOLO 模式看起来像业余方案。",
    slice
  );

  assert.equal(normalized, "Claude Code **现在有了沙盒模式（sandbox mode）**，让 YOLO 模式看起来像业余方案。");
});

test("normalizeSegmentAnchorText moves chinese-primary inline explanations outside the anchor parentheses", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Supply chain attacks", "供应链攻击")]
  });

  const normalized = normalizeSegmentAnchorText(
    "供应链攻击（Supply chain attacks，受感染的 npm 包试图窃取数据）",
    slice
  );

  assert.equal(normalized, "供应链攻击（Supply chain attacks）：受感染的 npm 包试图窃取数据");
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

test("normalizeSegmentAnchorText reuses a better local english-primary hint when a duplicate English parenthesis appears", () => {
  const slice = createSlice({
    requiredAnchors: []
  });

  const normalized = normalizeSegmentAnchorText(
    "它会移除所有提示，但也会取消所有保护。Claude（Claude）可以访问任何文件。\n- Claude（AI 助手）在你的项目文件夹里创建一个文件？这需要批准。",
    slice
  );

  assert.match(normalized, /Claude（AI 助手）可以访问任何文件。/);
  assert.doesNotMatch(normalized, /Claude（Claude）/);
});

test("normalizeSegmentAnchorText strips a trailing repeated english name from an english-primary explainer", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Claude", "Anthropic 的 AI 助手 Claude")]
  });

  const normalized = normalizeSegmentAnchorText(
    "这些内容默认会被阻止，即使 Claude（Anthropic 的 AI 助手 Claude）被指示要访问它们。",
    slice
  );

  assert.equal(normalized, "这些内容默认会被阻止，即使 Claude（Anthropic 的 AI 助手）被指示要访问它们。");
});

test("normalizeSegmentAnchorText strips embedded repeated english from an english-primary explainer", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "claude-code-sandbox", "社区claude-code-sandbox（工具）")]
  });

  const normalized = normalizeSegmentAnchorText(
    "**选项 1：claude-code-sandbox（社区claude-code-sandbox（工具））**",
    slice
  );

  assert.equal(normalized, "**选项 1：claude-code-sandbox（社区工具）**");
});

test("normalizeSegmentAnchorText collapses duplicated acronym-compound anchors into a stable canonical form", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "SSH keys", "SSH 密钥", "ssh key", "acronym-compound")]
  });

  const normalized = normalizeSegmentAnchorText(
    "- Claude，你在读取你的 SSH（SSH）密钥吗？同样需要批准。",
    slice
  );

  assert.equal(normalized, "- Claude，你在读取你的 SSH 密钥（SSH keys）吗？同样需要批准。");
});

test("normalizeSegmentAnchorText collapses nested acronym-compound parentheses into a stable canonical form", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "SSH keys", "SSH 密钥", "ssh key", "acronym-compound")]
  });

  const normalized = normalizeSegmentAnchorText(
    "- Claude，你在读取你的 SSH（SSH keys）密钥吗？同样需要批准。",
    slice
  );

  assert.equal(normalized, "- Claude，你在读取你的 SSH 密钥（SSH keys）吗？同样需要批准。");
});

test("normalizeSourceSurfaceAnchorText keeps the source surface form when a longer family variant appears in translation", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Claude", "Anthropic 的 AI 助手", "claude-family")],
    establishedAnchors: [createAnchor("anchor-2", "Claude Code", "Claude Code", "claude-family")]
  });
  const source = "Tell Claude:";
  const translated = "告诉 Claude Code（Claude）：";

  const normalized = normalizeSourceSurfaceAnchorText(source, translated, slice);

  assert.equal(normalized, "告诉 Claude（Anthropic 的 AI 助手）：");
});

test("normalizeSourceSurfaceAnchorText restores a trailing heading anchor to the canonical chinese-primary form", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Sandbox Mode", "沙箱模式")]
  });
  const source = "## How Sandbox Mode Changes Autonomous Coding";
  const translated = "## 沙箱模式如何改变自主编码（Sandbox Mode）";

  const normalized = normalizeSourceSurfaceAnchorText(source, translated, slice);

  assert.equal(normalized, "## 沙箱模式（Sandbox Mode）如何改变自主编码");
});

test("normalizeSegmentAnchorText collapses duplicate English parentheses when no better local hint exists", () => {
  const slice = createSlice({
    requiredAnchors: []
  });

  const normalized = normalizeSegmentAnchorText("Claude（Claude）可以访问任何文件。", slice);

  assert.equal(normalized, "Claude可以访问任何文件。");
});

test("formatAnchorDisplay prefers english-primary formatting for single-token tool names", () => {
  assert.equal(formatAnchorDisplay(createAnchor("anchor-1", "bubblewrap", "安全隔离组件")), "bubblewrap（安全隔离组件）");
  assert.equal(formatAnchorDisplay(createAnchor("anchor-2", "bubblewrap", "bubblewrap 框架")), "bubblewrap（框架）");
  assert.equal(
    formatAnchorDisplay(createAnchor("anchor-3", "claude-code-sandbox", "社区claude-code-sandbox（工具）")),
    "claude-code-sandbox（社区工具）"
  );
  assert.equal(
    formatAnchorDisplay(createAnchor("anchor-4", "SSH keys", "SSH 密钥", "ssh key", "acronym-compound")),
    "SSH 密钥（SSH keys）"
  );
  assert.equal(
    formatAnchorDisplay(createAnchor("anchor-5", "Prompt injection attacks", "提示注入攻击")),
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

test("normalizeHeadingLikeAnchorText keeps a single trailing colon when restoring a bold pseudo-heading anchor", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Paths:", "路径")]
  });
  const source = "**Paths:**";
  const translated = "**路径：**";

  const normalized = normalizeHeadingLikeAnchorText(source, translated, slice);

  assert.equal(normalized, "**路径（Paths）：**");
});

test("normalizeHeadingLikeAnchorText preserves source-shaped english-primary headings without adding a chinese explainer", () => {
  const slice = createSlice({
    requiredAnchors: [
      createAnchor("anchor-1", "cco Sandbox", "cco 沙箱工具", "cco_sandbox", "english-primary", "tool")
    ]
  });
  const source = "**Option 2: cco Sandbox**";
  const translatedVariants = [
    "**选项 2：cco Sandbox（cco Sandbox（cco 沙箱工具））**",
    "**选项 2：cco Sandbox（cco 沙箱工具）**"
  ];

  for (const translated of translatedVariants) {
    const normalized = normalizeHeadingLikeAnchorText(source, translated, slice);
    assert.equal(normalized, "**选项 2：cco Sandbox**");
  }
});

test("normalizeHeadingLikeAnchorText restores a concept english-primary heading to bilingual canonical form", () => {
  const slice = createSlice({
    requiredAnchors: [
      createAnchor(
        "anchor-1",
        "Network Isolation",
        "网络隔离",
        "network_isolation",
        "english-primary"
      )
    ]
  });
  const source = "**Network Isolation**";
  const translated = "**Network Isolation**";

  const normalized = normalizeHeadingLikeAnchorText(source, translated, slice);

  assert.equal(normalized, "**Network Isolation（网络隔离）**");
});

test("normalizeHeadingLikeAnchorText skips full english back-reference for operational headings", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Edit configuration:", "编辑配置")]
  });
  const source = "**Edit configuration:**";
  const translated = "**编辑配置（Edit configuration）：**";

  const normalized = normalizeHeadingLikeAnchorText(source, translated, slice);

  assert.equal(normalized, "**编辑配置：**");
});

test("normalizeHeadingLikeAnchorText skips shorter child anchors when a longer heading anchor already covers them", () => {
  const slice = createSlice({
    requiredAnchors: [
      createAnchor(
        "anchor-1",
        "React/Next.js Web Project Configuration Example",
        "React/Next.js Web 项目配置示例"
      ),
      createAnchor("anchor-2", "Next.js", "Next.js 框架", "nextjs")
    ]
  });
  const source = "## React/Next.js Web Project Configuration Example";
  const translated = "## React/Next.js（Next.js（框架））Web 项目配置示例";

  const normalized = normalizeHeadingLikeAnchorText(source, translated, slice);

  assert.equal(normalized, "## React/Next.js Web 项目配置示例");
});

test("normalizeHeadingLikeAnchorText restores the canonical bilingual display for an exact ATX heading anchor", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Accidental Destructive Operations", "意外的破坏性操作")]
  });
  const source = "### Accidental Destructive Operations";
  const translated = "### 误删破坏（Accidental Destructive Operations）";

  const normalized = normalizeHeadingLikeAnchorText(source, translated, slice);

  assert.equal(normalized, "### 意外的破坏性操作（Accidental Destructive Operations）");
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

test("normalizeExplicitRepairAnchorText removes a forbidden added qualifier from the cited source sentence", () => {
  const slice = createSlice({
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: null,
        failureType: "other",
        locationLabel: "正文句",
        instruction:
          "第 1 句“关键区别在于，强制是在 Linux 的内核层执行的...”应去掉新增的“Linux”限定，保持与原文仅“kernel level”一致。",
        sentenceConstraint: {
          quotedText: "关键区别在于，强制是在 Linux 的内核层执行的...",
          forbiddenTerms: ["Linux"],
          sourceReferenceTexts: ["kernel level"]
        }
      }
    ]
  });
  const source = [
    "> The key difference is that enforcement occurs at the kernel level, not the application level.",
    "",
    "This is not Claude code by default, but it’s isolation enforced by Linux bubblewrap."
  ].join("\n");
  const translated = [
    "> 关键区别在于，强制是在 Linux 的内核层执行的，而不是在应用层。",
    "",
    "这并非 Claude 的默认行为，而是由 Linux bubblewrap 强制执行的隔离。"
  ].join("\n");

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(
    normalized,
    [
      "> 关键区别在于，强制是在内核层执行的，而不是在应用层。",
      "",
      "这并非 Claude 的默认行为，而是由 Linux bubblewrap 强制执行的隔离。"
    ].join("\n")
  );
});

test("normalizeExplicitRepairAnchorText restores a longer english-only list qualifier from an explicit repair target", () => {
  const slice = createSlice({
    requiredAnchors: [
      {
        ...createAnchor("local:chunk-1-segment-1:npm-registry", "npm registry", "npm registry", "local:npm-registry"),
        displayPolicy: "english-only",
        requiresBilingual: false,
        displayMode: "english-only",
        canonicalDisplay: "npm registry",
        allowedDisplayForms: ["npm registry"]
      }
    ],
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: "local:chunk-1-segment-1:npm-registry",
        failureType: "other",
        locationLabel: "列表项",
        instruction: "第 1 个项目符号需保留 `npm registry` 这一限定，不要只写成 `npm`。"
      }
    ]
  });
  const source = "- Pre-approved destinations (npm registry, GitHub, your APIs)";
  const translated = "- 预先批准的目标位置（npm、GitHub、你的 API）";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "- 预先批准的目标位置（npm registry、GitHub、你的 API）");
});

test("normalizeSourceSurfaceAnchorText restores a longer required anchor when only a shorter covered english-only anchor remains", () => {
  const slice = createSlice({
    requiredAnchors: [
      {
        ...createAnchor("anchor-npm-registry", "npm registry", "npm 注册表", "npm-registry"),
        displayPolicy: "chinese-primary",
        canonicalDisplay: "npm 注册表（npm registry）",
        allowedDisplayForms: ["npm 注册表（npm registry）"]
      },
      {
        ...createAnchor("anchor-npm", "npm", "npm", "npm"),
        displayPolicy: "english-only",
        canonicalDisplay: "npm",
        allowedDisplayForms: ["npm"]
      }
    ]
  });
  const source = "- Pre-approved destinations (npm registry, GitHub, your APIs)";
  const translated = "- 预先批准的目标位置（npm、GitHub、你的 API）";

  const normalized = normalizeSourceSurfaceAnchorText(source, translated, slice);

  assert.equal(normalized, "- 预先批准的目标位置（npm 注册表（npm registry）、GitHub、你的 API）");
});

test("normalizeExplicitRepairAnchorText does not duplicate an already satisfied bilingual API target", () => {
  const slice = createSlice({
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: null,
        failureType: "other",
        locationLabel: "列表项",
        instruction: "第 15 个项目符号中的“你的 API（应用程序编程接口）”重复了括注，只保留一组括注。",
        structuredTarget: {
          location: "第 15 个项目符号",
          kind: "list_item",
          currentText: "API",
          targetText: "API（应用程序编程接口）",
          english: "API",
          chineseHint: "应用程序编程接口"
        }
      }
    ]
  });
  const source = "- Pre-approved destinations (npm registry, GitHub, your APIs)";
  const translated = "- 预先批准的目标位置（npm registry、GitHub、你的 API（应用程序编程接口））";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, translated);
});

test("normalizeExplicitRepairAnchorText restores a heading-like anchor from a structured title repair target", () => {
  const slice = createSlice({
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "分段标题",
        instruction:
          "位置：分段标题“**测试 2：系统文件访问**”；问题：首次出现的关键术语“System File Access”缺少中英文对照；修复目标：在标题本身补齐该术语的英文锚定。"
      }
    ]
  });
  const source = "**Test 2: System File Access**";
  const translated = "**测试 2：系统文件访问**";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "**测试 2：系统文件访问（System File Access）**");
});

test("normalizeExplicitRepairAnchorText restores configuration headings from heading-local fallback anchors", () => {
  const slice = createSlice({
    requiredAnchors: [
      {
        ...createAnchor(
          "local:chunk-1-segment-1:filesystem-permissions",
          "Filesystem Permissions",
          "文件系统权限",
          "local:filesystem-permissions",
          "chinese-primary"
        ),
        displayMode: "chinese-primary",
        canonicalDisplay: "文件系统权限（Filesystem Permissions）",
        allowedDisplayForms: ["文件系统权限（Filesystem Permissions）"]
      },
      {
        ...createAnchor(
          "local:chunk-1-segment-1:permission-pattern-syntax",
          "Permission Pattern Syntax",
          "权限模式语法",
          "local:permission-pattern-syntax",
          "chinese-primary"
        ),
        displayMode: "chinese-primary",
        canonicalDisplay: "权限模式语法（Permission Pattern Syntax）",
        allowedDisplayForms: ["权限模式语法（Permission Pattern Syntax）"]
      }
    ],
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: "local:chunk-1-segment-1:filesystem-permissions",
        failureType: "missing_anchor",
        locationLabel: "标题",
        instruction:
          "位置：`## 文件系统权限（关键）`。问题：首次出现的关键术语 `Filesystem Permissions` 未保留中英对照。修复目标：在标题内补成合法的中英锚定形式。"
      },
      {
        repairId: "repair-2",
        anchorId: "local:chunk-1-segment-1:permission-pattern-syntax",
        failureType: "missing_anchor",
        locationLabel: "标题",
        instruction:
          "位置：`**权限模式语法**`。问题：首次出现的关键术语 `Permission Pattern Syntax` 未保留中英对照。修复目标：在该标题内补成合法的中英锚定形式。"
      }
    ]
  });
  const source = ["## Filesystem Permissions (Critical )", "", "**Permission Pattern Syntax**"].join("\n");
  const translated = ["## 文件系统权限（关键）", "", "**权限模式语法**"].join("\n");

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(
    normalized,
    ["## 文件系统权限（Filesystem Permissions）（关键）", "", "**权限模式语法（Permission Pattern Syntax）**"].join("\n")
  );
});

test("normalizeExplicitRepairAnchorText keeps a single trailing colon when restoring a heading-like anchor", () => {
  const slice = createSlice({
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "分段标题",
        instruction:
          "位置：分段标题“**路径：**”；问题：首次出现的关键术语“Paths:”缺少中英文对照；修复目标：在标题本身补齐该术语的英文锚定。"
      }
    ]
  });
  const source = "**Paths:**";
  const translated = "**路径：**";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "**路径（Paths）：**");
});

test("normalizeExplicitRepairAnchorText strips full english back-reference for operational headings", () => {
  const slice = createSlice({
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "分段标题",
        instruction:
          "当前分段标题“**编辑配置（Edit configuration）：**”中对通用短语做了整句英文括注；修复目标是去掉这类过宽的英文重复锚定，只保留必要的中文标题表达。"
      }
    ]
  });
  const source = "**Edit configuration:**";
  const translated = "**编辑配置（Edit configuration）：**";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "**编辑配置：**");
});

test("normalizeExplicitRepairAnchorText falls back to the source ATX heading when the repair target omits english", () => {
  const slice = createSlice({
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "小标题",
        instruction: "`### 凭证窃取`：这是本分段首次出现的关键术语，小标题需补英文对照后再用。"
      }
    ]
  });
  const source = "### Credential Theft";
  const translated = "### 凭证窃取";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "### 凭证窃取（Credential Theft）");
});

test("normalizeExplicitRepairAnchorText parses title-prefixed repair locations and restores exact heading surfaces", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "supply chain attacks", "供应链攻击")],
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "标题",
        instruction: "位置：标题“### 供应链攻击”；问题：首现术语未补英文对照；修复目标：改为符合首现锚定的双语标题形式。"
      },
      {
        repairId: "repair-2",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "标题",
        instruction: "位置：标题“### 凭据窃取”；问题：首现术语未补英文对照；修复目标：改为符合首现锚定的双语标题形式。"
      }
    ]
  });
  const source = "### Supply Chain Attacks\n\n### Credential Theft";
  const translated = "### 供应链攻击\n\n### 凭据窃取";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "### 供应链攻击（Supply Chain Attacks）\n\n### 凭据窃取（Credential Theft）");
});

test("normalizeExplicitRepairAnchorText preserves missing source heading qualifiers inside an existing heading parenthesis", () => {
  const slice = createSlice({
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: null,
        failureType: "missing_anchor",
        locationLabel: "小标题",
        instruction:
          "位置：### 第 2 类：提示式（Prompted）。问题：缺少源文标题括注“Requires Permission”的对应信息。修复目标：补齐该标题的中英文对照，且不改动结构。"
      }
    ]
  });
  const source = "### Category 2: Prompted (Requires Permission)";
  const translated = "### 第 2 类：提示式（Prompted）";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "### 第 2 类：提示式（Prompted，Requires Permission）");
});

test("normalizeExplicitRepairAnchorText keeps english-primary headings in source shape during repair fallback", () => {
  const slice = createSlice({
    requiredAnchors: [
      createAnchor("anchor-1", "cco Sandbox", "cco 沙箱工具", "cco_sandbox", "english-primary", "tool")
    ],
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: null,
        failureType: "other",
        locationLabel: "分段标题",
        instruction:
          "位置：分段标题“**选项 2：cco Sandbox（cco Sandbox（cco 沙箱工具））**”；问题：标题首现锚定格式错误；修复目标：保留标题结构并修复为合法的首现形式。"
      }
    ]
  });
  const source = "**Option 2: cco Sandbox**";
  const translated = "**选项 2：cco Sandbox（cco Sandbox（cco 沙箱工具））**";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "**选项 2：cco Sandbox**");
});

test("normalizeExplicitRepairAnchorText restores concept english-primary headings to bilingual canonical form", () => {
  const slice = createSlice({
    requiredAnchors: [
      createAnchor(
        "anchor-1",
        "Command Restrictions",
        "命令限制",
        "command_restrictions",
        "english-primary"
      )
    ],
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: "anchor-1",
        failureType: "missing_anchor",
        locationLabel: "标题",
        instruction:
          "当前分段标题“**Command Restrictions**”首次出现需补中英对照，修复目标是改为合法锚定形式“Command Restrictions（命令限制）”。"
      }
    ]
  });
  const source = "**Command Restrictions**";
  const translated = "**Command Restrictions**";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "**Command Restrictions（命令限制）**");
});

test("normalizeExplicitRepairAnchorText injects a named anchor back into a heading line", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Sandbox Mode", "沙箱模式")],
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: "anchor-1",
        failureType: "missing_anchor",
        locationLabel: "标题",
        instruction:
          "位置：## 标题“沙箱模式如何改变自主编码”｜问题：首现术语 Sandbox Mode 未补中英文对照｜修复目标：在标题本身建立该术语的双语锚点。"
      }
    ]
  });
  const source = "## How Sandbox Mode Changes Autonomous Coding";
  const translated = "## 沙箱模式如何改变自主编码";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "## 沙箱模式（Sandbox Mode）如何改变自主编码");
});

test("normalizeExplicitRepairAnchorText restores the canonical bilingual display for an exact ATX heading anchor", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Accidental Destructive Operations", "意外的破坏性操作")],
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: "anchor-1",
        failureType: "missing_anchor",
        locationLabel: "小标题",
        instruction:
          "位置：第 4 段标题“### 误删破坏（Accidental Destructive Operations）”；问题：英文括注与前文已建立的锚点不一致；修复目标：改回与既有锚点一致的双语形式。"
      }
    ]
  });
  const source = "### Accidental Destructive Operations";
  const translated = "### 误删破坏（Accidental Destructive Operations）";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "### 意外的破坏性操作（Accidental Destructive Operations）");
});

test("normalizeExplicitRepairAnchorText injects a named anchor back into a list item", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "Environment variables", "环境变量")],
    pendingRepairs: [
      {
        repairId: "repair-1",
        anchorId: "anchor-1",
        failureType: "missing_anchor",
        locationLabel: "列表项",
        instruction:
          "位置：第一段列表“包含秘密信息的环境变量”：Environment variables 首次出现需补中英文对照，不能只写中文。"
      }
    ]
  });
  const source = "- Environment variables containing secrets";
  const translated = "- 包含秘密信息的环境变量";

  const normalized = normalizeExplicitRepairAnchorText(source, translated, slice);

  assert.equal(normalized, "- 包含秘密信息的环境变量（Environment variables）");
});

test("injectPlannedAnchorText skips mention injection when ownerMap marks the span as structurally owned (#2 P1 step 2)", () => {
  const slice = createSlice({
    requiredAnchors: [createAnchor("anchor-1", "sandbox mode", "沙盒模式")],
    ownerMap: [
      {
        ownerType: "sentence",
        sourceText: "now has a sandbox mode",
        planId: "emphasis-1"
      }
    ]
  });
  const source = "Claude Code **now has a sandbox mode** today.";
  const translated = "Claude Code **现在有了沙盒模式（sandbox mode）** 今天。";

  const normalized = injectPlannedAnchorText(source, translated, slice);

  // Guard fires: the emphasisPlan already owns the `sandbox mode` span, so the
  // mention-layer injector must not re-inject a second `（sandbox mode）`.
  assert.equal(normalized, translated);
});
