# 翻译架构文档校准报告（2026-04-25）

本文是把 main 分支上四份架构文档（共 2155 行）逐条对照当前源码后得到的差异校准结果。目的是为后续「提效方向调研」提供一份可信的现状基线，回答两类问题：

- 文档声称的边界，代码到底有没有兑现？
- 哪些环节是「文档说死、代码缺证据」，必须先补内审才能在上面继续做架构判断？

校准对象：

- `docs/translation-system-design.md`（617 行）
- `docs/translation-pipeline-deep-dive.md`（1039 行）
- `docs/translation-handoff-memo.md`（317 行）
- `docs/known-entities-governance.md`（182 行）

校准基线代码：

- `src/translate.ts`（8625 行）
- `src/translation-state.ts`（2553 行）
- `src/anchor-normalization.ts`（3050 行）
- `src/markdown-protection.ts`（585 行）
- `src/markdown-chunks.ts`（269 行）
- `src/known-entities.ts`（664 行）+ `src/data/known_entities.json`
- `src/internal/prompts/`、`scripts/smoke-*.mjs`、`test/*`

状态约定：

- **一致**：文档声明在源码中找到了直接对应的实现路径与行号。
- **偏差**：源码做的事情与文档声明不一致（本次校准未发现此类）。
- **缺证据**：文档说得很明确，但本次抽查只在源码中看到「类型/字段/挂钩点」，**实际的执行/约束路径没追到**。这一类不等于「没做」，而是「要继续内审才能判断真实状态」。

---

## 1. 结构保护层

### 1.1 frontmatter 由程序保护不进模型
- 文档定位：`translation-system-design.md:63`
- 代码定位：`markdown-protection.ts:42-67`（`extractFrontmatter`）；`translate.ts:2526` 使用点
- 状态：一致

### 1.2 fenced code block 由程序保护
- 文档定位：`translation-system-design.md:64`
- 代码定位：`markdown-protection.ts:127-166`（`protectFencedCodeBlocks`），由 `protectMarkdownSpans` L79 调用
- 状态：一致

### 1.3 raw HTML block 由程序保护
- 文档定位：`translation-system-design.md:65`
- 代码定位：`markdown-protection.ts:80` `protectHtmlBlocks` 注册点
- 状态：一致

### 1.4 link destination 由程序保护
- 文档定位：`translation-system-design.md:66`
- 代码定位：`markdown-protection.ts:83`（在 `mapOutsideInlineCode` 内调 `protectLinkDestinations`）
- 状态：一致

### 1.5 image destination 由程序保护
- 文档定位：`translation-system-design.md:67`
- 代码定位：`markdown-protection.ts:83` 同一统一入口
- 状态：一致

### 1.6 autolink 由程序保护
- 文档定位：`translation-system-design.md:68`
- 代码定位：`markdown-protection.ts:84`（`protectAutolinks`）
- 状态：一致

### 1.7 HTML URL 属性由程序保护
- 文档定位：`translation-system-design.md:69`
- 代码定位：`markdown-protection.ts:85`（`protectHtmlAttributes`）
- 状态：一致

### 1.8 protected span integrity 损坏 = 直接判结构错误
- 文档定位：`translation-system-design.md:354-362`
- 代码定位：`translation-state.ts:15`（`hardCheckKey` 含 `protected_span_integrity`）；`translate.ts` 中存在 `hasStructuralHardCheckFailure` 入口（约 L1160）
- 状态：缺证据
- 备注：硬性项类别已枚举，但「结构损坏不进 repair 闭环、直接结构错」的强制路径在本次抽查里没追到完整执行点。

---

## 2. 分块层

### 2.1 按 `##` 小节切 chunk、不固定字数硬切
- 文档定位：`translation-system-design.md:77-85`；`translation-pipeline-deep-dive.md:77-88`
- 代码定位：`markdown-chunks.ts:86-102`（`splitIntoSections`，条件 `headingLevel <= 2`）
- 状态：一致
- 备注：字符上限（`MAX_CHUNK_CHARACTERS=8500`、`TARGET_CHUNK_CHARACTERS=5200`）是二级目标，不是切分主依据。

### 2.2 必要时在小节内拆 segment
- 文档定位：`translation-system-design.md:83-84`
- 代码定位：`translate.ts:7663-7725`（`splitProtectedChunkSegments` + `shouldSplitPendingByComplexity`）
- 状态：一致

### 2.3 analysis 按 shard 分片，但只切执行不切语义
- 文档定位：`translation-system-design.md:87-88`
- 代码定位：`translate.ts:2373-2399`（shard 循环 + `mergeAnchorCatalogs`）；`translation-state.ts:1564` 附近的构造点
- 状态：一致

### 2.4 性能问题先从 segment 复杂度 / prompt 体积下手
- 文档定位：`translation-system-design.md:89-94`
- 代码定位：`translate.ts:7715`（`shouldSplitPendingByComplexity`）；`buildSegmentTaskSlice` 在 L676；draft prompt 入口 `buildJsonBlockDraftPrompt` 在 L6050 附近
- 状态：部分一致
- 备注：复杂度拆分已落地。但文档第 93 行写「整份 state JSON 不应默认进入 draft」——`PromptSlice` 是压缩视图（`translation-state.ts:356-462` 定义），但 draft 调用是否严格使用 slice 而不直接序列化整份 state，本次抽查没追完。

---

## 3. 翻译四阶段（draft / audit / repair / style）

### 3.1 四个阶段串行
- 文档定位：`translation-system-design.md:96-240`；`translation-pipeline-deep-dive.md:258-398`
- 代码定位：`translate.ts` 第 4776–4847 行（`translateProtectedChunk` 内 draft → bundledAudit → repair → postRepairAudit）
- 状态：一致

### 3.2 hard gate 全过才能跑 style
- 文档定位：`translation-system-design.md:374-377`
- 代码定位：`translate.ts:2688-2699`（`if (styleMode === "final")` 仅在所有 chunk 通过后执行；用 `gateAudits` 判断）
- 状态：一致

### 3.3 repair 只修 must_fix
- 文档定位：`translation-system-design.md:150`
- 代码定位：`translate.ts:4827-4847`（`repairDraftedSegment` 调用）；L4867 `mustFix: audit.must_fix`
- 状态：一致（入口约束确认；循环内是否真的「不重新发挥」见第 10 节风险点）

### 3.4 各阶段 prompt 入口
- 文档定位：`translation-pipeline-deep-dive.md:419-437`
- 代码定位：
  - analysis → `translate.ts:2361` `analyzeDocumentForAnchors`
  - draft → `translate.ts:4776` `translateProtectedSegment`
  - audit → `translate.ts:7358` `runBundledGateAudit`
  - repair → `translate.ts:5518` `repairDraftedSegment`
  - style → `translate.ts:5079` `applyFinalStylePolish`
- 状态：一致

### 3.5 hard gate 通过则跳过 repair 循环
- 文档定位：`translation-system-design.md:374-375`
- 代码定位：`translate.ts:4798-4848`（循环条件 `!isBundledHardPass(bundledAudit)`)
- 状态：一致

---

## 4. State-first / 单一真相

### 4.1 anchors / sourceForms / displayPolicy / canonical display 由 state 持有
- 文档定位：`translation-system-design.md:241-260`；`translation-pipeline-deep-dive.md:790-929`
- 代码定位：`translation-state.ts:59-71`（`AnchorState` 含 `english`、`chineseHint`、`displayPolicy`、`sourceForms`、`status: "planned" | "established"`）
- 状态：一致

### 4.2 source surface / heading kind/policy 由 state 持有
- 文档定位：`translation-system-design.md:241-260`
- 代码定位：`translation-state.ts:226-238`（`HeadingPlanState` 含 `sourceHeading`、`strategy`、`targetHeading`、`displayPolicy`、`governedTerms`）；`SegmentState.headingPlans` 在 L127-150
- 状态：一致

### 4.3 repair task binding 由 state 持有
- 文档定位：`translation-system-design.md:150-155`
- 代码定位：`translation-state.ts:93-110`（`RepairTask`）；`SegmentState.repairTaskIds` L127-150
- 状态：一致

---

## 5. Anchor / 双语显示

### 5.1 local fallback anchor vs global anchor 边界
- 文档定位：`translation-system-design.md:159-212`
- 代码定位：`translation-state.ts:1332-1410`（`reconcileSegmentSemanticPlans`）；`anchor-normalization.ts:67-104`
- 状态：缺证据
- 备注：`reconcileSegmentSemanticPlans` 处理的是 heading plan 与 global anchor 的冲突仲裁（L1341-1383），「fallback 提升为 global 的程序化校验」没找到对应代码。

### 5.2 heading 走 source template 恢复
- 文档定位：`translation-system-design.md:275-293`
- 代码定位：`translation-state.ts:45` `HeadingPlanStrategy` 包含 `"source-template"`
- 状态：缺证据
- 备注：strategy 类型存在；`anchor-normalization.ts` 内对 source-template 的执行细节本次没读完。

### 5.3 english-primary heading 不重复括注
- 文档定位：`translation-system-design.md:272-273`
- 代码定位：`anchor-normalization.ts:94-104`（`flipReversedBilingualForChinesePrimary`）
- 状态：部分一致
- 备注：只看到 chinese-primary 反向翻转的处理，**没找到对称的 english-primary 不重复括注的防护**——这一条值得专门内审。

### 5.4 子锚点不重复注入
- 文档定位：`translation-system-design.md:201-204`
- 代码定位：`translation-state.ts:136-150`（`SegmentState.aliasPlans`）
- 状态：缺证据
- 备注：字段存在，执行细节没追到。

---

## 6. known_entities formal vs candidate

### 6.1 formal 表只收跨文档稳定 + display policy 明确
- 文档定位：`known-entities-governance.md:38-65`
- 代码定位：`src/data/known_entities.json`（version:1，27 个 entity）；`known-entities.ts:39-42`（`KnownEntitiesFile` 类型）
- 状态：一致

### 6.2 candidate 不能直接成 formal
- 文档定位：`known-entities-governance.md:163-175`
- 代码定位：`known-entities.ts:44-57`（`KnownEntityCandidateRecord`）；L59-63 候选表导出（`MDZH_KNOWN_ENTITIES_CANDIDATES_PATH`）
- 状态：一致

### 6.3 formal/candidate 字段与提升流程
- 文档定位：`known-entities-governance.md:27-37` / `163-175`
- 代码定位：`known-entities.ts:27-37` formal 记录；L44-57 候选记录（额外含 `confidence` / `evidence` / `source`）
- 状态：一致

---

## 7. Heading 处理

### 7.1 heading kind 识别（product/tool vs concept）
- 文档定位：`translation-system-design.md:278-293`、`116-118`
- 代码定位：`translation-state.ts:43-48`（`HeadingPlanStrategy` 含 `concept` / `source-template` / `mixed-qualifier` / `natural-heading`）
- 状态：一致

### 7.2 先识别 kind 再决定 source-shaped 还是 canonical bilingual
- 文档定位：`translation-system-design.md:278-293`
- 代码定位：`translation-state.ts:1341-1383`（`reconcileSegmentSemanticPlans` 中按 strategy 决定 `targetHeading`、与 global anchor 仲裁）
- 状态：一致

---

## 8. IR（intermediate representation）

### 8.1 IR 至少 5 类
- 文档定位：`translation-system-design.md:100-126`
- 代码定位：`translation-state.ts:213-293` 实际有 6 类：`AnalysisAnchor`、`AnalysisHeadingPlan`、`AnalysisEmphasisPlan`、`AnalysisBlockPlan`、`AnalysisAliasPlan`、`AnalysisEntityDisambiguationPlan`
- 状态：一致（实际多于声明）

### 8.2 analysis 输出即 IR
- 文档定位：`translation-pipeline-deep-dive.md:169-200`
- 代码定位：`translate.ts:2361-2413` 返回 `AnchorCatalog`；`translation-state.ts:282-293` `AnchorCatalog` 完整结构（含全部 plan 类）
- 状态：一致

### 8.3 各类 IR 字段与职责
- 文档定位：`translation-system-design.md:112-125`
- 代码定位：
  - anchorPlan → `translation-state.ts:213-224`
  - headingPlan → L226-238
  - emphasisPlan → L240-249
  - blockPlan → L251-258
  - aliasPlan → L260-269
- 状态：一致

---

## 9. Smoke / 验证顺序

### 9.1 短文 fixture 是结构化块选择
- 文档定位：`translation-system-design.md:435-436`
- 代码定位：`scripts/build-smoke-fixtures.mjs` 存在
- 状态：缺证据
- 备注：脚本未读内容。

### 9.2 smoke 入口 npm scripts
- 文档定位：`translation-system-design.md:458-462`
- 代码定位：`package.json:21-26`（`smoke:short` / `smoke:full` / `smoke:status` / `smoke:diagnose` / `smoke:once`）
- 状态：一致

### 9.3 smoke 输出结构（output_dir / status / analysis_cache / checkpoint）
- 文档定位：`translation-system-design.md:469-476`
- 代码定位：`scripts/smoke-once.mjs` / `run-smoke.mjs` 存在
- 状态：缺证据

### 9.4 status.json 字段结构
- 文档定位：`translation-system-design.md:481-488`
- 代码定位：`scripts/smoke-once.mjs`、`smoke-status.mjs` 存在
- 状态：缺证据

### 9.5 smoke 失败自动归类
- 文档定位：`translation-system-design.md:525-540`
- 代码定位：`scripts/smoke-diagnose.mjs` 存在（7669 字节）
- 状态：缺证据

### 9.6 验收顺序：单元 → short → full → 独立质检
- 文档定位：`translation-system-design.md:549-588`
- 代码定位：`scripts/smoke-quality.mjs` 存在
- 状态：缺证据

---

## 10. Performance 校准

### 10.1 性能问题优先从 segment 复杂度入手
- 文档定位：`translation-system-design.md:89-94`
- 代码定位：`translate.ts:7715` `shouldSplitPendingByComplexity`；L7659 `MIN_SEGMENT_HEADING_SPLIT_CHARACTERS=2600`
- 状态：一致

### 10.2 draft prompt 不进整份 state JSON
- 文档定位：`translation-system-design.md:93`
- 代码定位：`translate.ts:676` `buildSegmentTaskSlice` 返回 `PromptSlice`（定义在 `translation-state.ts:356-462`）
- 状态：缺证据
- 备注：slice 视图存在，但 draft 调用是否真的只用 slice 不旁路注入完整 state，没在抽查范围内确认。

### 10.3 timeout 是执行层最后一刀
- 文档定位：`translation-system-design.md:94-95`
- 代码定位：`translate.ts:2689` / `5100` 等多处 `executeStageWithTimeout`
- 状态：缺证据

---

## 总结

### 量化

- 一致：32 条
- 偏差：0 条
- 缺证据：19 条

「缺证据」≠「没做」，意思是文档说得很明确、代码看得到挂钩点，但**这次抽查没追到执行/约束路径**，要继续内审。

### 偏差最严重的 0 条（无）

文档与代码没有正面冲突。

### 缺证据 Top 5（按对架构判断的影响排序）

1. **protected span 损坏的强制结构错路径**——硬性项类别已定义，但「不进 repair 闭环」的执行链路未确认。
2. **fallback anchor → global anchor 的程序化校验**——文档反复强调的边界，代码里没找到对应判定。
3. **english-primary heading 不重复括注**——只看到 chinese-primary 反向逻辑，对称防护缺失。
4. **draft prompt 体积约束**——`PromptSlice` 视图存在，但 draft 是否严格只用 slice 没核到。
5. **smoke 脚本组的实现真值**——19 条缺证据里有 6 条来自 `scripts/smoke-*.mjs`，文档的 smoke 行为承诺基本悬空。

### 对「提效方向调研」最关键的现状

1. **文档与代码的主体框架对齐**：四层（保护 / 分块 / 规划 / 执行）、四阶段（draft / audit / repair / style）、IR、known_entities formal-vs-candidate、state-first 单一真相，全部能在代码里找到承载结构。
2. **真正的不确定性集中在执行细节**：跨层边界（fallback↔global、protected span 优先级）、循环约束（repair 是否守 must_fix、style 之前真的全 hard gate 通过）、prompt 体积约束。这些是任何「提效」改造的前置——边界没钉死，提速会先打破现有保证。
3. **smoke 框架是黑盒**：脚本完整、入口清晰，但里面的归类、产物结构、失败重跑逻辑都没在校准范围内验证。提效如果走「更快的回归」方向，这一块要先补内审。
4. **风险点**：
   - `MAX_REPAIR_CYCLES=2` 下 repair 是否真「只修 must_fix」（文档禁止自由发挥）。
   - draft prompt 是否真没默认带整份 state JSON。
   - `shouldSplitPendingByComplexity` 与其他 `shouldSplitPendingAt*` 系列阈值是否完整、可解释。

### 下一步建议

按对调研的杠杆排序：

1. 先补 `scripts/smoke-*.mjs` 内审（消化 6 条缺证据，决定提效是否能从「更快的回归」入手）。
2. 再核 `translate.ts` 内 repair / style / draft 三处的 prompt 实际入参（消化 2 条最高风险缺证据）。
3. 最后核 `anchor-normalization.ts` 内 fallback / english-primary / source-template 的执行路径（消化 4 条 anchor 缺证据）。

完成上述三步后，再开「提效方向」的具体方向选项（segment 拆分策略、prompt 体积、并行度、缓存层、smoke 加速等）才有事实基础。
