# 翻译系统设计原则与回归策略

## 目标

这套系统的目标不是“让模型直接翻完一篇 Markdown”，而是把 Markdown 翻译拆成一条可控流水线：

- 程序负责保护结构。
- 模型只处理可翻译正文。
- 先过硬性项，再做风格润色。
- 新问题必须能被归类、复现、回归，而不是靠一次 smoke 碰运气。

这份文档是当前主线的设计基线，后续修 bug 或调整 pipeline 时，默认都应以这里的边界为准。

## 一、总体分层

### 1. 结构层

结构层的目标是把“不该翻译的东西”从模型作用域里拿掉。

当前由程序保护的内容包括：

- YAML frontmatter
- fenced code block
- raw HTML block
- link destination
- image destination
- autolink
- HTML URL 属性

设计原则：

- 这些内容不应靠 prompt 自觉保护。
- 这些内容必须先由程序抽离、占位或原样保留。
- 进入模型前，输入里只能剩下可翻译正文和必要的结构占位。

### 2. 分块层

分块层的目标是让模型既有上下文，又不会因为整篇过长而失稳。

当前策略：

- 按 Markdown 结构块切 chunk，而不是按固定字数硬切。
- 尽量保留 `##` 小节完整性。
- 不把 chunk 切得过小，避免语气、术语首现和指代被切碎。
- 只在明显过长时，才在小节内部进一步拆 segment。

设计原则：

- chunk 只切生成，不切理解。
- 先保结构边界，再考虑大小阈值。
- 不能为了提速把硬边界切烂。

### 3. 翻译层

每个可翻译 segment 走固定四阶段：

1. `draft`
2. `audit`
3. `repair`
4. `style`

职责边界：

- `draft`：先把正文翻出来。
- `audit`：只做硬性项审校，不润色，不重写。
- `repair`：只修 `must_fix`。
- `style`：只有硬性项全过后才允许执行。

设计原则：

- 阶段职责必须单一。
- 不允许把“审校”“修复”“润色”混在一个 prompt 里。
- 不允许为了风格去破坏已通过的硬性项。

### 4. 管理层

每类问题单独建 issue、单独建分支、单独做回归。

设计原则：

- 不把新问题硬塞进当前 issue。
- 不用文章特判去掩盖规则边界问题。
- 一次只修一类问题，防止结论失真。

## 二、关键不变量

下面这些是不变量，违反任一条都不应继续往下跑。

### 1. Canonical protected representation

只要译文还要进入：

- chunk 合并
- chunk 级 style
- 最终 restore

它就必须保持 canonical placeholder 形态，不能是“半恢复版”。

例如：

- URL 类 span 允许模型临时展开成真实值。
- 但只要还没到最终输出，就必须先 `reprotect` 回占位符。

否则会出现“segment 级通过，chunk 级再次炸掉”的状态机错误。

### 2. Protected span integrity

以下结构一旦被模型改坏，直接视为结构错误，不按普通翻译质量问题处理：

- code block
- raw HTML block
- link destination
- image destination
- HTML URL 属性

设计原则：

- 结构损坏不进入 repair 闭环兜底。
- 结构错误优先级高于风格和可读性。

### 3. Frontmatter isolation

frontmatter 不属于翻译范围。

约束：

- 不翻译
- 不改写
- 不参与正文段落对齐
- 不参与术语或标点审校

### 4. Hard gate before style

只要 hard gate 没全过，就不能跑 style。

原因：

- style 是“锦上添花”，不是“救火”。
- 如果允许 style 在 hard gate 前执行，风格优化会放大结构和术语问题。

## 三、首现双语的当前口径

首现双语不是“所有英文都要补中文”，而是有明确边界的。

### 需要首现双语的对象

- 人名
- 机构名
- 公司名
- 产品名
- 专有项目名
- 真正关键的专业术语

### 默认不应强制双语的对象

- 通用职业称谓
- 通用科学名词
- 普通类群名
- 纯工具说明里的英文标签
- 图注、署名、credit/byline 中原样出现的英文归属名

### 两条已经固化的边界

1. 图注 / 署名 / 来源 / 配图说明 / 出品归属  
   对这类归属说明里的公司名、机构名、媒体名，不要为了满足首现双语强行创造中文主译。

2. 工具名 / 命令名 / 包名 / CLI 名称的列表项说明  
   对 `kubectl - Kubernetes cluster access`、`docker - ...`、`npm install -g ...` 这类条目，允许保留英文原名并直接跟中文解释，不强制改成“中文（英文）”。

设计原则：

- 首现双语是“帮助理解”，不是“机械套格式”。
- 凡是标签式、归属式、工具式文本，都要优先判断语用场景，再决定是否强制双语。

## 四、为什么会持续暴露新问题

这是当前阶段的正常现象，不代表同一个问题反复没修好。

主要原因有三个：

### 1. 问题是分层暴露的

真实长文里，前一层的大问题修掉后，后一层的小问题才有机会浮出来。

例如：

- 先是整篇占位符系统不稳
- 再是 chunk 合并前的链接 canonicalize
- 再是图注归属类双语口径
- 再是工具名列表项双语口径
- 之后才轮到更细的结构保持问题

### 2. 很多问题不是翻译错误，而是规则边界错误

模型不是总在“乱翻”，很多时候是我们自己定义的 hard gate 口径过严、过宽或语境不清。

### 3. 全文 smoke 不能替代状态机级测试

整篇跑通一次，只能说明“这次路径没炸”，不能证明：

- 中间态都满足不变量
- 其他模型也能稳过
- 相邻问题不会互相干扰

所以必须同时保留：

- 单元测试
- 最小失败区段 smoke
- 整篇长文回归

## 五、当前推荐的验证顺序

每次修复都按下面的顺序验证。

### 1. 单元/编排回归

先证明：

- 新规则能被稳定触发
- 不变量仍成立
- 没引入明显回归

### 2. 最小失败区段 smoke

从真实文章里摘出最小可复现片段，只验证当前 issue 的问题。

目的：

- 快速确认根因修复是否生效
- 避免整篇长文里的其他问题干扰结论

### 3. 整篇长文 smoke

只有区段 smoke 过了，才上整篇回归。

推荐顺序：

1. 先用 `gpt-5.3-codex-spark` 打通整条链路，快速发现新问题。
2. 再用 `gpt-5.4-mini` 验证默认模型是否稳定。

设计原则：

- `spark` 用来提早暴露问题。
- `mini` 用来验证主线质量和默认模型行为。

## 六、当前的收口策略

当某条修复通过最小失败区段，但整篇长文又暴露新问题时，正确做法是：

1. 关闭当前问题，不把新问题混进来。
2. 新问题单独建 linked issue。
3. 在当前 issue 里明确说明：
   - 已修复的根因
   - 通过的 targeted smoke
   - 整篇回归里暴露的新 follow-up

这样做的原因：

- 保证问题归因清晰
- 保证分支和提交只对应一个主题
- 保证后续回归能知道“哪类问题已经解决，哪类还没解决”

## 七、当前仍然成立的约束

后续改动默认遵守这些约束：

- 不做文章白名单/黑名单
- 不做站点特判
- 不为单篇样本写专门逻辑
- 只做通用规则修复
- 能用程序约束解决的，不靠 prompt 兜底
- 能用最小失败区段验证的，不先跑整篇长文

## 八、后续维护建议

如果后续继续扩展这套系统，优先级建议如下：

1. 继续收紧结构不变量
2. 把新问题先做成最小失败区段 fixture
3. 保持 prompt 职责边界清晰
4. 不轻易扩大 hard gate 适用范围
5. 只有在通用规则确立后，再补整篇回归

一句话总结：

这套系统不是“让模型尽量聪明”，而是“让程序先把边界钉死，再让模型在边界内工作”。

## 九、架构为什么逐步走向 state-first

这套系统最初不是现在这个样子。

一开始更接近“prompt-first”：

- 先把 Markdown 切 chunk
- 让模型翻译
- 再让模型审校
- 如果有问题，再靠 repair prompt 修

这条路在短文上能工作，但在真实长文上很快暴露出三个系统性问题。

### 1. 同一个术语会在不同阶段被当成不同东西

典型例子：

- `Claude`
- `Claude Code`
- `sandbox mode`
- `Seatbelt`

如果没有状态机，模型在不同阶段会各自理解：

- draft 觉得它是产品名
- audit 觉得它需要中文说明
- repair 又可能把它扩写成同家族但不同词形的名字

例如我们真实遇到过：

- 原文是 `Tell Claude:`
- 译文在 repair 后漂成 `告诉 Claude Code（Claude）：`

这不是翻译能力问题，而是**缺少单一真相**：

- 这个位置原文写的是 `Claude`
- 它和 `Claude Code` 虽同家族，但不是同一 surface form

所以后来才引入：

- `anchors`
- `sourceForms`
- `displayPolicy`
- `source surface identity`

程序先定义“这个位置到底是哪一个实体”，模型才能在这个边界内修。

### 2. 标题不是普通句子

真实失败案例很多：

- `**Test 2: System File Access**`
- `### Credential Theft`
- `### Category 2: Prompted (Requires Permission)`
- `**Option 2: cco Sandbox**`
- `**Network Isolation**`

如果把标题当成普通正文做锚点注入，后果通常是：

- 英文补不回来
- qualifier 丢掉半截
- 子锚点在同一标题里重复注入
- 冒号、括号结构被破坏
- 英文主名标题被错误套成 `English（中文说明）`

我们后来才确认：

**标题修复本质上不是“补一个锚点”，而是“恢复 source template”。**

所以 heading-like 行现在必须走独立逻辑：

- 先判断这是 product/tool heading，还是 concept heading
- product/tool heading 优先保 source template
- concept heading 才恢复 canonical bilingual display

### 3. hard gate 能看出问题，不等于它能定义全局真相

真实案例：

- `Autonomous Coding`
- `Git`

这类词有时在 analysis 阶段漏掉了，但 hard gate 又能在局部看出：

- “这里像是首次出现，应补锚”

如果直接把 hard gate 的自由文本结论升成全局 anchor，会有两个风险：

- 它可能只看到了局部 paraphrase，不是 source 里的正式 surface form
- 它可能把 code-like、标题短语或单篇短语错误提升为全局真相

我们踩过的坑包括：

- 列表项里的 `Accidental destruction` 误污染标题 canonical
- `--dangerously-skip-permissions flag` 这类 code-like 组合差点被提升成 anchor

所以现在的原则是：

- hard gate 可以触发局部补漏
- 但不能直接充当全局 canonical anchor 发现器

这就是 local fallback anchor 存在的原因。

## 十、当前的单一真相设计

当前系统真正的核心，不是 prompt 文案，而是运行时状态对象。

可以把它理解成：

- analysis 负责提出候选
- known_entities 负责给已有规则兜底
- state 负责持有当前唯一有效的真相
- audit / repair / style 只消费 state 的局部切片

### 1. 什么属于“真相”

当前至少包括：

- 哪些 anchor 已建立
- 每个 anchor 的 `displayPolicy`
- 每个 anchor 的 canonical display
- 每个位置原文到底写了哪个 surface form
- 哪些标题要走 source template 恢复
- 哪些 repair task 已绑定到具体位置

### 2. 什么不属于“真相”

以下内容只能算输入线索，不能直接等同于真相：

- 模型产出的 discovered anchors
- hard gate 的自然语言 `must_fix`
- repair prompt 里的描述性上下文

这些都必须经过程序侧校验、归一和绑定，才能进入 state。

### 3. 为什么要这么严格

因为我们已经真实遇到过这三类污染：

1. discovered anchor 把列表项 paraphrase 当成标题 canonical
2. repair task 被 incidental English mention 绑错 anchor
3. hard gate 自己发明了一个 state 里根本不存在的“全局必修锚点”

所以现在的设计目标不是“让模型更聪明”，而是：

**让任何后续阶段都不能绕开 state 自己重新发明规则。**

## 十一、标题为什么必须是“模板恢复场景”

这是最近一系列 issue 复盘后最明确的一条结论。

### 1. 普通锚点注入适合正文

例如：

- `提示注入攻击`
- `供应链攻击`
- `沙盒模式`

这类可以通过 canonical display 注入成：

- `提示注入攻击（Prompt injection attacks）`
- `供应链攻击（Supply chain attacks）`
- `沙盒模式（sandbox mode）`

### 2. 标题修复不是这样

例如：

- `**Option 2: cco Sandbox**`
- `### Category 2: Prompted (Requires Permission)`

如果按正文的逻辑直接注入，会变成：

- `Option 2: cco Sandbox（cco 沙箱工具）`
- qualifier 被吞掉
- 子锚点重复
- 冒号位置错乱

所以标题修复的正确顺序应该是：

1. 识别标题类型
2. 读取 source heading template
3. 判断它该恢复 source-shaped 形式还是 canonical bilingual 形式
4. 最后才做极少量 display normalization

一句话：

**正文是“注入锚点”，标题是“恢复模板”。**

## 十二、formal known_entities 与 candidates 的分工

`known_entities` 不是词典，而是一张显示策略表。

### 1. formal 表负责什么

formal `known_entities` 只收：

- 跨文档稳定
- display policy 明确
- 不容易和命令/路径/代码规则冲突

例如：

- `Claude`
- `GitHub`
- `Docker`
- `sandbox mode`
- `prompt injection attacks`
- `supply chain attacks`

### 2. candidate 表负责什么

candidate 表只做两件事：

- 记录全文 analysis 识别到、但尚未确认的实体
- 给后续人工筛选或规则提升提供证据

candidate 不能直接成为 formal 真相。

### 3. 为什么不能“识别到就永久入表”

因为我们已经遇到过很多高风险候选：

- 路径
- flag
- config 文件名
- 标题短语
- 组合词
- 过度依赖单篇语境的解释

例如：

- `--dangerously-skip-permissions`
- `.gitignore`
- `claude-sandbox.config.json`
- `Accidental destruction`

这些如果直接入 formal，会把后面的 display policy 和 repair 都带偏。

## 十三、local fallback anchor 与 global anchor 的边界

这是当前设计里最容易被误解的一点。

### 1. 为什么允许后续阶段补 anchor

因为 analysis 不可能一次发现所有东西。

真实长文里，我们已经多次遇到：

- analysis 漏掉标题概念
- analysis 漏掉局部术语
- 但 hard gate 明显能看出当前这一处缺锚

所以系统必须允许：

- 在当前 heading / list item / sentence 局部补一个 fallback anchor

### 2. 为什么不能直接升级成 global anchor

因为局部问题信号不等于全局 canonical 真相。

如果把 local fallback 直接升成 global，会有这些风险：

- 用 paraphrase 污染 canonical
- 用局部上下文定义错误的 display policy
- 把 code-like 短语提升成正式实体
- 让后续 chunk 全部受错规则影响

### 3. 正确做法

当前推荐边界是：

- local fallback 可以修当前块
- 只有通过 source 校验、display policy 明确、不是高风险形态时，才允许提升成 global anchor

一句话：

**local fallback 是补洞，global anchor 是立法。补洞可以就地做，立法必须谨慎。**

## 十四、从最近这批 issue 得出的统一决策逻辑

最近这批问题已经足够说明，我们以后判断新 bug 时不该再按字面现象拆，而应该先判它属于哪一层。

### 1. 结构层问题

典型现象：

- code block / inline code 形态丢失
- link destination 丢失
- protected span integrity failed

处理方式：

- 优先修程序边界
- 不靠 prompt

### 2. 状态层问题

典型现象：

- analysis 识别了，但 segment slice 没带进去
- hard gate 报的问题 state 里没有
- repair task 绑错 anchor

处理方式：

- 修 state-first 单一真相
- 修 source surface / display policy / task binding

### 3. 标题模板层问题

典型现象：

- 标题英文缺失
- qualifier 丢半截
- english-primary 标题重复括注
- 子锚点在标题里二次注入

处理方式：

- 先看 source template
- 再看 heading kind
- 最后才考虑 canonical display

### 4. 术语治理层问题

典型现象：

- `Linux` 这类本应裸英文的实体被误报
- `Python` 这类高耦合实体被过早正式收编

处理方式：

- 优先调整 `known_entities` 收编边界
- 不要用单篇失败直接推动 formal 表膨胀

## 十五、下一阶段真正值得做的工程收紧

如果后续继续演进，这几条比“继续补 prompt”更重要：

1. 给 heading 恢复补更明确的 kind/policy 结构
2. 让 audit 更严格地服从 state，而不是自由发明新全局要求
3. 让 local fallback 的提升条件更程序化
4. 继续收紧 source span / source surface 匹配
5. 为每个高频家族建立家族级回归，而不是只补单点 case

一句话总结：

这套系统下一阶段的重点不是“更强模型”，而是**让 analysis、state、heading recovery、audit 四层真正共享同一套规则真相。**
