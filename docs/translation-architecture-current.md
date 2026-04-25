# Markdown 翻译系统当前架构（已校准）

本文是 2026-04-25 对照源码逐条校准过的架构说明。每一节只描述**代码里能找到出处的现状**，并在末尾列出文档声称但本次没找到执行路径的部分（标记为「声称-待验证」）。

校准证据见 [`translation-architecture-calibration-2026-04-25.md`](./translation-architecture-calibration-2026-04-25.md)。

阅读边界：
- 想了解「当前真实在跑什么、每条规则代码里在哪」——读本文。
- 想了解「为什么这样设计、为什么 50+ 轮还在收口」——读 [`translation-pipeline-deep-dive.md`](./translation-pipeline-deep-dive.md)。
- 想了解 `known_entities` 治理流程——读 [`known-entities-governance.md`](./known-entities-governance.md)。

---

## 总体形态

整个翻译流程是一条由程序串起来的状态机，**不是单次大 prompt**。

四个层次，从外到内：

```
[结构保护层]  markdown-protection.ts   把不可翻译片段冻结成占位符
[分块层]      markdown-chunks.ts        按结构切 chunk / 按复杂度拆 segment
[规划层]      analyzeDocumentForAnchors 输出 IR（6 类 plan 的 AnchorCatalog）
[执行层]      translate.ts              draft → audit → repair → style，由 state 驱动
```

跨层共用的运行时真相在 `translation-state.ts`：anchor、heading plan、emphasis plan、block plan、alias plan、entity disambiguation plan、repair task、segment slice、prompt slice。

---

## 1. 结构保护层

实现位置：`src/markdown-protection.ts`（585 行）。统一入口 `protectMarkdownSpans` 在 L79。

代码兑现的保护类别（每类都验证过）：

| 类别 | 实现入口 |
|------|----------|
| YAML frontmatter | `extractFrontmatter` L42-67，使用点 `translate.ts:2526` |
| fenced code block | `protectFencedCodeBlocks` L127-166，调用点 L79 |
| raw HTML block | `protectHtmlBlocks` 注册点 L80 |
| link destination | `protectLinkDestinations` L83（在 `mapOutsideInlineCode` 内）|
| image destination | 同 L83 入口 |
| autolink | `protectAutolinks` L84 |
| HTML URL 属性 | `protectHtmlAttributes` L85 |

原则（与代码一致）：
- 这些片段在进入任何 LLM prompt 前已变成占位符。
- frontmatter 完全独立，不参与翻译，仅在 `translate.ts:2533` 标记 `frontmatterPresent`。

声明-待验证：
- **「protected span 损坏 = 直接判结构错，不进 repair 闭环」**（`translation-system-design.md:354-362`）。`translation-state.ts:15` 列出了 `protected_span_integrity` 这类 hardCheckKey，`translate.ts` 约 L1160 有 `hasStructuralHardCheckFailure` 入口，但「不进入 repair」的强制路径未在抽查范围内追到。

---

## 2. 分块层

实现位置：`src/markdown-chunks.ts`（269 行）+ `translate.ts` 内的 segment 拆分。

切分规则（实证）：
- **按结构切**：`splitIntoSections` L86-102，触发条件是 `block.headingLevel <= 2 && current.length > 0`，即 `#` / `##` 处切分。
- **字符上限是二级目标**：`MAX_CHUNK_CHARACTERS=8500`、`TARGET_CHUNK_CHARACTERS=5200`。结构边界优先，字数只在结构允许时介入。
- **chunk 内继续按复杂度拆 segment**：`splitProtectedChunkSegments` `translate.ts:7663-7725`，使用 `shouldSplitPendingByComplexity` L7715 作为复杂度预算。
- **heading 拆分阈值**：`MIN_SEGMENT_HEADING_SPLIT_CHARACTERS=2600`（`translate.ts:7659`）。

Analysis 分片（实证）：
- `analyzeDocumentForAnchors` 在 `translate.ts:2361-2413` 实现，按 shard 循环调用 LLM。
- 每个 shard 输出独立 `AnchorCatalog`，之后 `mergeAnchorCatalogs` 合并（L2399）。
- 分片只切执行不切语义：合并后再消费。

性能约束（实证 + 待验证）：
- 已落地：复杂度拆分（`shouldSplitPendingByComplexity`）作为切 segment 一级依据。
- 待验证：「draft prompt 不应默认带整份 state JSON」（`translation-system-design.md:93`）。`buildSegmentTaskSlice` `translate.ts:676` 返回 `PromptSlice`（定义在 `translation-state.ts:356-462`），但 draft 是否严格只用 slice、不旁路注入完整 state，本次未追到。

---

## 3. 翻译四阶段

`translate.ts` 内每个 chunk 走固定四阶段，串联在 `translateProtectedChunk`（约 L4750）中：

```
draft  →  bundledAudit  →  repair  →  postRepairAudit  →  (全部 chunk hard pass 后) style
```

### 3.1 各阶段入口（实证）

| 阶段 | 入口 | 文件:行 |
|------|------|---------|
| analysis | `analyzeDocumentForAnchors` | `translate.ts:2361` |
| draft | `translateProtectedSegment` | `translate.ts:4776` |
| audit | `runBundledGateAudit` | `translate.ts:7358` |
| repair | `repairDraftedSegment` | `translate.ts:5518` |
| style | `applyFinalStylePolish` | `translate.ts:5079` |

### 3.2 阶段串行（实证）

`translate.ts:4776-4847` 的 chunk 翻译循环里：
- 先 draft；
- 再 `runBundledGateAudit`；
- 进入 repair 循环条件是 `!isBundledHardPass(bundledAudit)`（L4798）；
- repair 调用时 must_fix 经由 `mustFix: audit.must_fix` 传入（L4867），这是 repair 入口约束。
- repair 循环上限：`MAX_REPAIR_CYCLES=2`。

### 3.3 hard gate before style（实证）

`translate.ts:2688-2699`：`if (styleMode === "final")` 仅在所有 chunk 通过 `gateAudits` 后才执行。即 hard gate 失败时 style 不跑。

### 3.4 阶段职责（实证 + 待验证）

实证：
- 入口与 prompt 文件分离（每阶段独立 prompt）。
- repair 入口只接 must_fix。

待验证：
- **repair 循环内是否真的「只修 must_fix、不重新发挥」**——文档反复强调（`translation-system-design.md:150`），但循环内的 prompt 与上下文构造未在抽查内确认是否完全闭合。这是当前最高风险口子之一。

---

## 4. State-first / 单一真相

实现位置：`src/translation-state.ts`（2553 行）。

### 4.1 真相对象（实证）

| 真相 | 类型 | 文件:行 |
|------|------|---------|
| 已建立的 anchor + 显示策略 | `AnchorState`（`english`、`chineseHint`、`displayPolicy`、`sourceForms`、`status: "planned" \| "established"`）| L59-71 |
| heading 计划 | `HeadingPlanState`（`sourceHeading`、`strategy`、`targetHeading`、`displayPolicy`、`governedTerms`）| L226-238 |
| segment 内的所有计划 | `SegmentState`（`headingPlans`、`emphasisPlans`、`aliasPlans`、`repairTaskIds` 等）| L127-150 |
| repair 任务绑定 | `RepairTask`（`failureType`、`structuredTarget`、`sentenceConstraint`）| L93-110 |
| 整篇 IR | `AnchorCatalog`（含 6 类 plan 数组）| L282-293 |

### 4.2 状态消费（实证）

- 每个 segment 调 `buildSegmentTaskSlice`（`translate.ts:676`）拿到该 segment 需要的局部切片，输出 `PromptSlice`。
- `PromptSlice` 类型定义在 `translation-state.ts:356-462`，是给各阶段 prompt 用的压缩视图，不是整份 state JSON。

### 4.3 不属于真相（实证 + 待验证）

文档（`translation-system-design.md:241-260`）声明：discovered anchor、自然语言 must_fix、prompt 描述性上下文都不算真相，必须经程序校验后才进 state。

实证：`reconcileSegmentSemanticPlans`（`translation-state.ts:1332-1410`）在 heading plan 与 global anchor 之间做仲裁。

待验证：「fallback anchor → global anchor 的程序化校验」未找到对应入口（详见第 5 节）。

---

## 5. Anchor / 双语显示

### 5.1 IR 6 类（实证）

`translation-state.ts:213-269` 实际定义的 plan 类型：

| 类型 | 用途 | 文件:行 |
|------|------|---------|
| `AnalysisAnchor` | 跨段稳定锚点 | L213-224 |
| `AnalysisHeadingPlan` | 标题处理计划 | L226-238 |
| `AnalysisEmphasisPlan` | 强调（粗体伪标题等）| L240-249 |
| `AnalysisBlockPlan` | 列表 / 代码块等结构块 | L251-258 |
| `AnalysisAliasPlan` | 别名（如 The Sandbox）| L260-269 |
| `AnalysisEntityDisambiguationPlan` | 实体歧义消解 | L271-280 附近 |

文档（`translation-system-design.md:100-126`）声明 5 类，代码实际 6 类，多出 `AliasPlan` 与 `EntityDisambiguationPlan`。这是文档落后于代码的一处，方向一致。

### 5.2 Heading 策略（实证）

`HeadingPlanStrategy` 枚举（`translation-state.ts:43-48`）：
- `concept` — 概念标题，走 canonical bilingual
- `source-template` — 产品/工具标题，恢复 source 形式
- `mixed-qualifier` — 带限定词
- `natural-heading` — 一般标题

`reconcileSegmentSemanticPlans`（L1341-1383）按 strategy 决定 `targetHeading`，并在 heading 与 global anchor 之间仲裁。

### 5.3 反向翻转防护（实证 + 待验证）

实证：
- `flipReversedBilingualForChinesePrimary`（`anchor-normalization.ts:94-104`）处理 chinese-primary 被错误反向的情况。

待验证（影响较大，建议优先内审）：
- **english-primary heading 不重复括注**（`translation-system-design.md:272-273`）——只看到 chinese-primary 反向逻辑，**没找到对称的 english-primary 防护代码**。
- **fallback anchor → global anchor 的提升边界**（`translation-system-design.md:159-212`）——`reconcileSegmentSemanticPlans` 处理的是 heading↔anchor 仲裁，不是 fallback 升级。
- **子锚点不重复注入**（`translation-system-design.md:201-204`）——`SegmentState.aliasPlans`（L136-150）字段存在，执行细节未追。
- **source-template 的实际恢复路径**——`HeadingPlanStrategy` 枚举存在，`anchor-normalization.ts` 内具体执行未读完。

---

## 6. known_entities 治理

实现位置：`src/known-entities.ts`（664 行）+ `src/data/known_entities.json`（27 个 formal entity）。

### 6.1 表结构（实证）

| 表 | 字段 | 文件:行 |
|----|------|---------|
| formal | `surface_forms`、`aliases`、`display_policy` | `known-entities.ts:27-37` |
| candidate | formal 字段 + `confidence`、`evidence`、`source` | `known-entities.ts:44-57` |
| 候选导出路径 | 环境变量 `MDZH_KNOWN_ENTITIES_CANDIDATES_PATH` | `known-entities.ts:59-63` |

### 6.2 收编原则（实证）

formal 表只收：跨文档稳定 + display policy 明确 + 不与命令/路径/代码规则冲突。当前 27 条全部符合（如 `Claude` → `bare_english_ok`、`npm-registry` → `chinese_primary_with_en_anchor`）。

candidate 不能直接成 formal——代码层面是两张分离的表，提升只能由人工编辑 `known_entities.json` 完成。治理流程见 [`known-entities-governance.md`](./known-entities-governance.md)。

---

## 7. Smoke / 验证

入口（实证，来自 `package.json:21-26`）：

| 命令 | 用途 |
|------|------|
| `npm run smoke:short` | 短文 fixture 跑通 |
| `npm run smoke:full` | 长文 fixture 跑通 |
| `npm run smoke:once` | 单次执行 |
| `npm run smoke:status` | 查看运行状态 |
| `npm run smoke:diagnose` | 失败归类 |

脚本文件位置：`scripts/smoke-once.mjs`、`scripts/smoke-status.mjs`、`scripts/smoke-diagnose.mjs`、`scripts/smoke-quality.mjs`、`scripts/build-smoke-fixtures.mjs`、`scripts/run-smoke.mjs`。

声明-待验证（这是当前最大的「黑盒」）：
- 短文 fixture 是否真按结构化块选择生成（`translation-system-design.md:435-436`）。
- smoke 输出结构（output_dir / status.json / analysis_cache / checkpoint）（L469-476、L481-488）。
- smoke 失败自动归类（L525-540）。
- smoke-quality 独立质检流程（L549-588）。

脚本都在，但本次校准没读这 6 个 mjs 的内容，**这部分需要单独一次内审才能确认行为**。

---

## 8. 主要常量与阈值（实证）

| 名称 | 值 | 位置 | 用途 |
|------|-----|------|------|
| `MAX_CHUNK_CHARACTERS` | 8500 | `markdown-chunks.ts` | chunk 字符上限 |
| `TARGET_CHUNK_CHARACTERS` | 5200 | `markdown-chunks.ts` | chunk 目标字符 |
| `MIN_SEGMENT_HEADING_SPLIT_CHARACTERS` | 2600 | `translate.ts:7659` | heading 触发拆 segment 的最小字符 |
| `MAX_REPAIR_CYCLES` | 2 | `translate.ts` | repair 循环上限 |

其他切分阈值（`shouldSplitPendingAt*` 系列）分散在 `translate.ts` 内，未完整盘点——见第 10 节。

---

## 9. 文件总览（实证）

```
src/
  translate.ts              8625 行  核心 pipeline（draft/audit/repair/style + chunk/segment 调度）
  translation-state.ts      2553 行  state-first 单一真相、所有 IR 类型、PromptSlice
  anchor-normalization.ts   3050 行  anchor 显示策略归一、heading 恢复
  markdown-protection.ts     585 行  结构保护（frontmatter/code/HTML/link/image/autolink/HTML 属性）
  markdown-chunks.ts         269 行  按结构切 chunk
  known-entities.ts          664 行  formal + candidate 治理
  data/known_entities.json   27 个 entity
  cli.ts                     320 行
  mcp-server.ts               99 行
  codex-exec.ts              346 行  外部 LLM 执行 wrapper
  internal/
    eval/                            评测脚本
    prompts/                         各阶段 prompt 文件
test/
  translate.test.ts         ~2000 行（PR #171 后从 7561 行精简）
  anchor-normalization.test.ts  503 行
  translation-state.test.ts
  markdown-chunks.test.ts
  markdown-protection.test.ts
  known-entities.test.ts
  + fixtures/
docs/
  translation-system-design.md       规范（含历史推理）
  translation-pipeline-deep-dive.md  pipeline 深度说明
  translation-handoff-memo.md        交接备忘
  known-entities-governance.md       known_entities 治理
  translation-architecture-calibration-2026-04-25.md  本轮校准证据
  translation-architecture-current.md                  本文
scripts/
  smoke-once.mjs / smoke-status.mjs / smoke-diagnose.mjs / smoke-quality.mjs
  build-smoke-fixtures.mjs / run-smoke.mjs
```

---

## 10. 提效方向调研之前的前置内审清单

校准过程中识别出 19 条「声称-待验证」项目。要做架构级提效改造之前，建议先消化以下三组：

### 10.1 高优先（影响后续提效判断的正确性）

1. **`scripts/smoke-*.mjs` 实现真值**（6 条缺证据集中在这里）：归类逻辑、输出结构、失败重跑路径。任何「让回归更快」的方向都依赖这一块。
2. **draft prompt 实际入参体积**：核 `translate.ts` 内 draft 调用是否严格使用 `PromptSlice`，没有把整份 state JSON 旁路灌进去。
3. **repair 循环内的约束闭合**：核 repair prompt 的实际上下文，确认它真守 must_fix。

### 10.2 中优先（影响双语 / heading 行为的稳定性）

4. **fallback anchor 升 global anchor 的程序化判定**——文档声明的边界没找到代码。
5. **english-primary heading 不重复括注的对称防护**——只见 chinese-primary 一侧。
6. **source-template heading 恢复的执行路径**。
7. **子锚点不重复注入的 alias 保护**。

### 10.3 低优先（清单完整性）

8. **protected span 损坏 → 强制结构错** 的执行入口。
9. `shouldSplitPendingAt*` 系列阈值的完整枚举与可解释性。
10. timeout 在执行层的统一形态。

完成 10.1 后，再讨论「提效方向」（segment 切分策略、prompt 体积、并行度、缓存层、smoke 加速等）才有事实基础。
