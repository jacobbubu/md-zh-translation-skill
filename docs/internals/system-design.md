# Markdown 翻译系统统一规范

这份文档是当前主线的单一规范文档。它合并了原始架构说明与最近一轮失败复盘后的校准结论。后续对翻译流水线、IR、hard gate、repair、smoke 策略的修改，默认都应以这里为准。

阅读边界：
- 如果你要看“规则和边界”，读本文。
- 如果你要完整理解“pipeline 怎么跑、每个 LLM 节点做什么、状态树为什么这样设计、为什么 50+ 轮仍未收口”，读 [translation-pipeline-deep-dive.md](./translation-pipeline-deep-dive.md)。

延伸阅读：
- [翻译 Pipeline 深度说明](./translation-pipeline-deep-dive.md)：解释当前实现如何执行、每个 prompt 节点如何与 LLM 交互、状态树如何流动，以及为什么一个表面简单的翻译任务会在 50+ 轮里持续暴露架构问题。

相关补充文档：
- `docs/known-entities-governance.md`：只定义 `known_entities` 的收编和治理，不替代本文。

## 0. 本文示例来源

本文中的例子默认都取自仓库内 smoke fixture，而不是虚构文本：

- 短文 fixture：[claude-code-sandbox-short.md](../test/fixtures/smoke/claude-code-sandbox-short.md)
- 长文 fixture：[claude-code-sandbox-full.md](../test/fixtures/smoke/claude-code-sandbox-full.md)

后文会反复引用这些真实片段：

- 开篇标题、图注与强调导语：
  - [claude-code-sandbox-short.md#L1-L7](../test/fixtures/smoke/claude-code-sandbox-short.md#L1)
- `--dangerously-skip-permissions` 与权限提示引用：
  - [claude-code-sandbox-short.md#L9-L21](../test/fixtures/smoke/claude-code-sandbox-short.md#L9)
  - [claude-code-sandbox-short.md#L52](../test/fixtures/smoke/claude-code-sandbox-short.md#L52)
- `**Filesystem Isolation**` 与预批准目标列表：
  - [claude-code-sandbox-short.md#L71-L79](../test/fixtures/smoke/claude-code-sandbox-short.md#L71)
- `The Sandbox` alias 首现：
  - [claude-code-sandbox-short.md#L95](../test/fixtures/smoke/claude-code-sandbox-short.md#L95)
- `bubblewrap / macOS / Seatbelt` 的混合 inline 段：
  - [claude-code-sandbox-short.md#L127](../test/fixtures/smoke/claude-code-sandbox-short.md#L127)
- `### Prompt Injection Attacks`：
  - [claude-code-sandbox-short.md#L135](../test/fixtures/smoke/claude-code-sandbox-short.md#L135)
- `Testing Your Claude Code Sandbox Setup` 与 `"sandbox mode is active"`：
  - [claude-code-sandbox-short.md#L152-L172](../test/fixtures/smoke/claude-code-sandbox-short.md#L152)
- `Alternative Solutions (Windows)`：
  - [claude-code-sandbox-short.md#L179](../test/fixtures/smoke/claude-code-sandbox-short.md#L179)

## 1. 核心原则

这套系统的目标不是“让模型直接翻完一篇 Markdown”，而是把翻译拆成一条受控流水线：

- LLM 负责理解与决策。
- 状态工程负责承载、校验和执行。
- formatter 负责纯格式清理。
- smoke 负责验证架构边界，而不是代替架构设计。

最重要的校准结论有三条：

- 语义理解优先交给 LLM，不再让本地 heuristic 代替模型理解标题、别名、块顺序、句子约束。
- 程序不再负责“理解该怎么翻”，只负责 source 对齐、scope、precedence、失败重放和结构完整性。
- 半角冒号、引号、括号样式这类 formatter-only 问题不再作为当前高优先级架构阻塞项。

## 2. 分层模型

### 2.1 结构保护层

进入模型前，程序必须先保护这些不可翻译结构：

- YAML frontmatter
- fenced code block
- raw HTML block
- link destination
- image destination
- autolink
- HTML URL 属性

原则：

- 结构保护不能靠 prompt 自觉。
- 结构损坏优先级高于风格和可读性。
- 结构错误不应退化成普通 repair 闭环。

### 2.2 分块执行层

程序负责按 Markdown 结构切 chunk / segment，而不是按字数硬切。

规则：

- 优先保留 `##` 小节完整性。
- 只在明显过长时才在小节内部拆 segment。
- chunk 负责执行窗口，不负责语义理解本身。

analysis 阶段允许按 shard 分片，以控制外部模型调用成本和不稳定性，但 shard 只是执行切片，不改变全文语义真相。

性能校准要求：

- 性能问题优先从 **segment 复杂度** 和 **prompt 体积** 下手，不优先通过无限拉长 timeout 解决。
- 对 instruction-heavy 区段（多组 fenced code、多个引用、多个加粗伪标题、测试步骤/预期行为密集出现）应优先按结构块拆小，而不是继续把更多 block 塞进同一个 draft 调用。
- draft prompt 只保留必要的 IR、anchor 摘要和当前分段附加规则；整份 state JSON 不应默认进入 draft。
- timeout 属于执行层最后一刀，用来切断“无声挂死”；它不能替代更细的 segmenter 与更轻的 prompt 设计。

### 2.3 语义规划层

从这一层开始，**以 LLM 理解能力为主**。

analysis 不再只输出平面 `anchors`，而是统一输出 segment / block 级 IR。当前目标 IR 至少包含五类：

- `anchorPlan`
- `headingPlan`
- `emphasisPlan`
- `blockPlan`
- `sentenceRepairPlan`

后续应继续补齐：

- `aliasPlan`

各类 IR 的职责：

- `anchorPlan`
  - 定义术语、专名、产品名、概念的 canonical 形式与 display policy。
- `headingPlan`
  - 决定标题属于 `natural-heading`、`concept`、`source-template`、`mixed-qualifier` 等哪类，并给出 `targetHeading`。
- `emphasisPlan`
  - 决定正文强调结构应如何保留以及强调内部的目标文本。
- `blockPlan`
  - 决定块级顺序、块类型以及必要时的块级 `targetText`。
- `sentenceRepairPlan`
  - 决定句子级删除新增限定词、只改当前句、不得把修复转移到后文等局部约束。
- `aliasPlan`
  - 决定 canonical concept 与局部 alias 之间的对应关系，例如 `Sandbox -> sandbox mode`。

原则：

- LLM 负责判断“这是什么语义对象、该用哪种策略”。
- 程序不能再用正则或 heuristic 去替代这种语义判断。
- 程序只在 LLM 缺 plan 且已有无歧义全局真相时，做受约束执行 fallback。

### 2.4 状态执行层

状态工程不再理解语义，只负责以下职责：

- 验证 source 对齐
  - surface 是否真实存在
  - 位置是否匹配
  - 是否越界到别的 heading / block / sentence
- 维护 scope
  - `global`
  - `local`
  - `heading-local`
  - `sentence-local`
- 维护 precedence
  - `headingPlan.targetHeading` > 同标题上的 global anchor
  - 已匹配的 global canonical > local structured target 自造说明
  - explicit `structuredTarget` > free-text `must_fix`
  - formatter-only 问题不生成高优先级 repair
- 维护生命周期
  - analysis IR
  - segment executable state
  - bundled audit structured failures
  - reified repair tasks

这四层状态必须可追踪、可回放、不可断链。

### 2.5 Reconciliation 与 Owner Map

analysis 可以同时产出多类 plan：

- `anchorPlan`
- `headingPlan`
- `emphasisPlan`
- `blockPlan`
- `sentenceRepairPlan`
- `aliasPlan`
- `entityDisambiguationPlan`

这些 plan 不能并列直接执行，必须先经过一次 **reconciliation**，收敛成唯一的执行 owner。

最小要求：

- 同一 heading 只能有一个最终 owner
- 同一 sentence/span 只能有一个最终 owner
- generic normalizer 只能处理 **没有 owner** 的文本

建议的 owner 形态：

- `heading owner`
- `block owner`
- `sentence owner`
- `mention owner`
- `protected owner`

owner map 的职责：

- 决定哪一段文本由哪类语义计划接管
- 决定后续谁可以改写、谁必须跳过
- 防止 `headingPlan / blockPlan / anchorPlan / local structured target` 互相覆盖
- 防止同一 family 的 alias owner 与 canonical owner 在同一输出 span 上混拼

典型例子：

- `Prompt Injection Attacks`
  - 真实来源：[claude-code-sandbox-short.md#L135](../test/fixtures/smoke/claude-code-sandbox-short.md#L135)
  - 如果 `headingPlan` 给了纯中文标题，但 global anchor 明确要求双语概念标题，reconciliation 必须先收敛出唯一 heading owner，再交给执行层。
- `npm registry`
  - 真实来源：[claude-code-sandbox-short.md#L79](../test/fixtures/smoke/claude-code-sandbox-short.md#L79)
  - 一旦某个 span 已被 matched global canonical 接管，generic terminology normalization 必须跳过。
- `The Sandbox`
  - 真实来源：[claude-code-sandbox-short.md#L95](../test/fixtures/smoke/claude-code-sandbox-short.md#L95)
  - 如果 analysis 给出了 `aliasPlan`，该引用句必须建立 `sentence-local owner`，后续修复不得把锚定转移到后文 canonical 标题。
- `sandbox / sandbox mode`
  - 真实来源：[claude-code-sandbox-short.md#L95](../test/fixtures/smoke/claude-code-sandbox-short.md#L95)、[claude-code-sandbox-short.md#L162](../test/fixtures/smoke/claude-code-sandbox-short.md#L162)、[claude-code-sandbox-short.md#L172](../test/fixtures/smoke/claude-code-sandbox-short.md#L172)
  - 如果同一家族同时存在 alias surface 与 canonical surface，reconciliation 必须先决定当前 span 由哪一个 owner 接管。
  - 允许 alias 升级为 canonical，也允许 alias 在其局部位置保持 alias；但禁止产出“中文来自 canonical、英文来自 alias”的 hybrid display，例如 `沙盒模式（sandbox）`。
- `--dangerously-skip-permissions`
  - 真实来源：[claude-code-sandbox-short.md#L9](../test/fixtures/smoke/claude-code-sandbox-short.md#L9)、[claude-code-sandbox-short.md#L52](../test/fixtures/smoke/claude-code-sandbox-short.md#L52)
  - 这类 code-like protected span 必须进入 `protected owner`，不允许模型或 generic normalizer 再拥有形态编辑权。

### 2.6 审校层

hard gate 以后只做两件事：

- 判断“当前输出是否满足已有 IR / state”
- 对 state 没覆盖、但 source 明确、且当前块局部可判定的问题，生成 `local structured repair target`

hard gate 不再负责：

- 直接宣布新的全局真相
- 用自由文本 must-fix 代替结构化 target
- 把纯格式问题升级成高优先级架构失败

### 2.7 格式化层

formatter 只负责纯格式统一，例如：

- 半角 / 全角冒号
- 引号样式
- 书名号 / 括号等标点规范

formatter 不负责：

- 修复语义
- 修复锚定
- 修复标题策略
- 修复块顺序

## 3. 单一真相与优先级

当前系统必须遵守以下优先级：

1. `headingPlan.targetHeading`
2. matched global anchor canonical
3. local structured target
4. free-text `must_fix`

在真正执行前，还必须再经过一层 owner map 收敛：

1. `protected owner`
2. `heading / block / sentence owner`
3. `alias / entityDisambiguation owner`
4. matched global anchor canonical
5. local structured target
6. generic normalization
7. formatter

解释：

- 如果一个标题已经有 `headingPlan.targetHeading`，后续全局 anchor 不能在同一标题上追加冲突要求。
- 如果某个英文实体已命中无歧义 global anchor，local structured target 只能复用 canonical，不能再造第二套中文说明。
- 如果某段文本已经被 owner 接管，generic normalization 和 formatter 只能做不改变语义真相的收尾，不能再改写 canonical。
- 同一 family 的不同 scope 不得跨 owner 混拼：
  - 不能把 alias 的英文 surface 附着到 canonical 的中文显示上
  - 不能把 canonical 的中文显示回写到仅应保留 alias 的局部位置
- `must_fix` 只保留给模型和人阅读，不能继续作为程序执行的唯一真相。

典型约束：

- `Claude` 已 established 且 `english-only` 时，不得再补 `Claude（Anthropic 的 AI 助手）`
- `Claude Code` 的 local target 不能产生第二套中文说明
- 没有 `headingPlan` 时，只允许复用无歧义 global anchor 做标题执行 fallback，不能恢复旧 heuristic 去猜标题语义

## 4. 当前 IR 的规范要求

### 4.1 headingPlan

标题语义是一级对象，不能再当成普通 anchor 的副产物。

最少应包含：

- `sourceHeading`
- `strategy`
- `targetHeading`
- `governedTerms`

职责：

- 决定标题应该自然中文化、双语概念化，还是保留 source template
- 决定标题内部哪些术语已经由标题计划接管

### 4.2 blockPlan

块顺序必须进入 IR 主链。

`blockPlan` 至少要表达：

- `blockIndex`
- `blockKind`
- `sourceText`
- 可选 `targetText`

职责：

- 约束标题、说明句、lead-in、列表、引用、代码块的相对顺序
- 防止模型把后面的标题或列表搬到前面
- 防止模型重复插入已经出现过的段落、说明句或 lead-in
- 当 `targetText` 已提供时，blockPlan 应成为真正的 `block owner`，由执行层直接落到对应 block，而不是只作为 prompt 提示

### 4.3 sentenceRepairPlan

句子级修复必须可结构化表达，不能只靠 must-fix 文案。

典型场景：

- 删除 source 中不存在的新增限定词
- 只改当前句
- 不把修复转移到后文

### 4.4 aliasPlan

concept alias 不是字符串替换问题，而是语义问题。

典型场景：

- `Sandbox` 先于 `sandbox mode` 出现
- 局部 alias 先出现，canonical 后出现

真实例子：

- 引用句里的 alias 首现：
  - [The Sandbox works by differentiating between these two cases.](../test/fixtures/smoke/claude-code-sandbox-short.md#L95)
- 后文 canonical 标题：
  - [## How Sandbox Mode Changes Autonomous Coding](../test/fixtures/smoke/claude-code-sandbox-short.md#L97)

要求：

- 必须把 alias 与 canonical concept 的关系结构化
- analysis 产出的 `aliasPlan` 至少要能表达：
  - 当前局部写法 `currentText`
  - canonical 目标 `targetText`
  - 对齐的 source 句子 `sourceText` / `sourceReferenceTexts`
- 不得只靠 surface form 碰运气
- 如果 analysis 漏掉 aliasPlan，audit 必须补成 `sentence-local structured repair target`，而不是只留下自然语言 must-fix

## 5. 当前仍然必须保持的不变量

### 5.1 Canonical protected representation

只要译文还会继续进入 chunk 合并、style 或最终 restore，它就必须保持 canonical placeholder 形态，不能停留在半恢复状态。

### 5.2 Protected span integrity

以下结构一旦损坏，直接视为结构错误：

- code block
- raw HTML block
- link destination
- image destination
- HTML URL 属性

### 5.3 Frontmatter isolation

frontmatter 不属于翻译范围：

- 不翻译
- 不改写
- 不参与正文段落对齐
- 不参与术语或标点审校

### 5.4 Hard gate before style

hard gate 没全过，不能跑 style。

style 是锦上添花，不是救火手段。

## 6. 最近三天失败问题的重新分类

### 6.1 架构大结构 / 分层问题

这些问题应归到“语义规划层缺项”，不是单词级 bug：

- 标题类型与标题目标
  - `#159 #163 #164 #165 #171-full-rerun2 #171-full-rerun4`
- 强调结构
  - `#166`
- alias 首现
  - `#169 #170`
- 句子级删除新增限定词
  - `#171-full-rerun5`
- 块顺序
  - `#171-full-rerun6`

### 6.2 状态传递 / 执行层断裂

这些问题应归到“状态传递问题”，不是语义理解问题：

- `npm registry` 一类 structured target 没被完整带到 repair
  - `#160 #171-short-after-fix4 #171-short-after-fix6`
- bundled audit 失败摘要没有回到 segment state
  - `#162`
- structured schema 无法落地
  - `#171-rerun8`
- global canonical 与 local target 冲突未仲裁
  - `#171-short-after-fix #171-short-after-fix3`

### 6.3 执行层可靠性问题

这些问题应单独作为执行器问题处理，不应污染内容架构判断：

- `#167` 之前的 analysis 挂死
- `#156 #170` 的 transport closed

## 7. 结构性规则

后续实现默认遵守这些收紧规则：

- 停止把自由文本 `must_fix` 当主真相
- 标题 fallback 只允许“已知真相的执行 fallback”
- `chunk.lastFailure` 必须 reify 回 segment `RepairTask`
- formatter-only 问题默认降级
- global / local 冲突一律以全局 canonical 优先，除非更高优先级 plan 明确覆盖

## 8. 验证顺序

### 8.1 优先 short smoke

仓库内默认 smoke fixture：

- 短文：`test/fixtures/smoke/claude-code-sandbox-short.md`
- 长文：`test/fixtures/smoke/claude-code-sandbox-full.md`

短文不是机械截断，必须通过结构化块选择生成，不能用字符串截断拼接。
短文应控制在当前长文的大约一半以内，同时优先覆盖：

- 标题 / alias / emphasis 的高频故障段
- source-shape / protected owner 容易出错的段
- block owner 容易出错的 instruction-heavy 段
- 最近一次 smoke 的主阻塞段

当前短文优先覆盖的真实片段：

- [标题 + 图注 + 强调导语](../test/fixtures/smoke/claude-code-sandbox-short.md#L1)
- [权限提示 / YOLO / `--dangerously-skip-permissions` 引用段](../test/fixtures/smoke/claude-code-sandbox-short.md#L9)
- [**Filesystem Isolation** 与预批准列表](../test/fixtures/smoke/claude-code-sandbox-short.md#L71)
- [The Sandbox alias 首现](../test/fixtures/smoke/claude-code-sandbox-short.md#L95)
- [bubblewrap / macOS / Seatbelt 混合 inline](../test/fixtures/smoke/claude-code-sandbox-short.md#L127)
- [### Prompt Injection Attacks](../test/fixtures/smoke/claude-code-sandbox-short.md#L135)
- [Testing Your Claude Code Sandbox Setup](../test/fixtures/smoke/claude-code-sandbox-short.md#L152)
- [Alternative Solutions (Windows)](../test/fixtures/smoke/claude-code-sandbox-short.md#L179)

### 8.1.1 统一 smoke 运行入口

后续 smoke 不应再手工拼接长串环境变量，统一通过脚本入口执行：

- `npm run smoke:short`
- `npm run smoke:full`
- `npm run smoke:once -- --fixture short`
- `npm run smoke:diagnose -- --fixture short`

它们会统一输出：

- `output_dir`
- `output`
- `stderr`
- `status`
- `analysis_cache`
- `checkpoint`

其中：

- `analysis_cache` 默认开启，用于复用最贵的 analysis / heading recovery / emphasis recovery
- `checkpoint` 默认用于 smoke，可在 chunk 成功后落盘，以便下一轮从后续 chunk 继续

### 8.1.2 自动检测中断 / 失败 / 成功

每次 smoke run 都会在运行目录下写 `status.json`。

状态文件最少包含：

- `state`：`running` / `succeeded` / `failed`
- `phase`：`analysis` / `draft` / `audit` / `repair` / `format`
- `lastEvent`
- `exitCode`
- `signal`
- `updatedAt`

读取方式：

- `npm run smoke:status -- --run-dir /tmp/mdzh-smoke-runs/<run-id>`
- `npm run smoke:status -- --fixture short --state failed`
- `npm run smoke:diagnose -- --fixture short --state failed`

如果外层循环希望“一条命令完成启动、等待、返回结果摘要”，使用：

- `npm run smoke:once -- --fixture short`

它会：

- 启动一次 smoke
- 等待 `status.json` 进入最终态
- 打印最终状态 JSON
- 若失败，再自动打印诊断 JSON
- 若成功，再自动跑独立质量检查
- 再打印一份紧凑 `summary`
- 退出码等于这轮的最终验收结果：
  - smoke 失败 => 非零
  - smoke 成功但质量检查失败 => 非零
  - smoke 成功且质量检查通过 => 0

如果外层循环希望“失败后直接得到归类结果”，使用：

- `npm run smoke:diagnose -- --fixture short --state failed`

它会返回：

- `state`
- `phase`
- `lastEvent`
- `category`
- `recommendedAction`

其中 `category` 当前会把常见失败先归到：

- `analysis-quality-gate`
- `stage-timeout`
- `external-termination`
- `control-plane-contamination`
- `protected-span-missing`
- `protected-span-corruption`
- `bundled-audit-timeout`
- `freeform-contract-failure`

`recommendedAction` 则给出该类失败在下一轮默认应该优先收哪条线。例如：

- `protected-span-missing` -> 优先收 protected/source-shape owner
- `freeform-contract-failure` -> 优先把当前段型迁到结构化 lane
- `analysis-quality-gate` -> 优先收 analysis / heading recovery，而不是继续跑 chunk

要求：

- 后续 Ralph / 自动循环必须优先读取 `status.json` 或 `smoke-status`，不再人工 tail 日志判断是否已经挂掉。
- 一旦 `state != running`，循环器应立即进入下一步：
  - `succeeded`：进入后续验收
  - `failed`：读取 `lastEvent` 和 `stderr.log`，开始下一轮

### 8.2 验收顺序

每次修复按以下顺序验证：

1. 单元 / 编排回归
2. 仓库内 short fixture
3. 仓库内 full fixture
4. 独立文档质量校验
5. 外部真实原文确认

### 8.3 验收重点

优先级应改为：

1. semantic / block correctness
2. canonical consistency
3. formatter 细节

formatter-only 问题不应持续掩盖真正的架构失败。

### 8.4 Full Smoke 之后的独立文档质量校验

full fixture 跑通后，不能直接宣布完成。必须再做一次与 hard gate 独立的文档质量校验。

要求：

- 校验对象必须是完整译文产物，不是单条日志或局部片段。
- 校验应独立于 smoke 的 hard gate 结果，不得把“hard gate 已通过”当作质量通过的替代。
- 校验重点包括：
  - 结构完整性：标题、列表、代码块、引用、链接、强调是否仍可正常阅读
  - 语义一致性：是否存在重复句、遗漏句、错位块、同 family 混拼、局部 owner 泄漏
  - canonical consistency：已建立锚点是否被后处理改坏，局部 alias / block / sentence owner 是否与全局真相冲突
  - source-shape 质量：路径、glob、flag、link label/destination、代码示例 token 是否保持可读且与 source 对齐
  - 文档可读性：是否仍存在肉眼明显不自然、污染、残留占位、重复括注或残句

执行规则：

- 如果独立文档质量校验不通过，则本轮不算完成，必须重新进入 Ralph 循环。
- 新一轮优先处理独立质检发现的问题，而不是只依据上一次 hard gate 的失败摘要。
- 只有在 full smoke 通过且独立文档质量校验通过后，才允许把该轮视为真正收口。

## 9. 后续实现优先级

下一阶段实现顺序应是：

1. 把 IR 扩成完整五类
   - `anchor / heading / emphasis / block / sentence`
2. 把 bundled audit 改成只产结构化 failure
3. 补齐 `chunk failure -> segment repair` 的重物化主链
4. 再处理 full smoke 中剩余的执行层超时 / 网络问题和 formatter 细节

## 10. 反模式

后续改动默认避免以下反模式：

- 用 regex / heuristic 代替 LLM 做语义理解
- 用单篇文章特判掩盖架构边界问题
- 继续围绕 `应改为 / 需改为 / 改成` 这类动词扩规则
- 让 hard gate 直接宣布新的全局真相
- 让 chunk failure 只停留在摘要，不变成可执行 repair

## 11. 一句话结论

这套系统不是“让程序尽量聪明地猜”，而是：

- 让 LLM 负责理解语义与策略，
- 让状态工程负责承载、约束和执行，
- 让 formatter 只做格式清理，
- 让 smoke 只验证这套架构是否成立。
