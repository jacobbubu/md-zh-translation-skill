# 翻译主线交接 Memo

本文用于交接当前主线目标、技术思路、运行方式和最新状态。  
它不是规范文档，也不是深度设计文档，而是“下一位继续推进的人应该先看什么、从哪里接着做”的执行 memo。

相关文档：
- 规范：[translation-system-design.md](/Users/rongshen/vibe-coding/md-zh-translation-skill-142/docs/translation-system-design.md)
- 深度说明：[translation-pipeline-deep-dive.md](/Users/rongshen/vibe-coding/md-zh-translation-skill-142/docs/translation-pipeline-deep-dive.md)

## 1. 当前目标

当前主线目标不是“修一个词条”或“过一轮 smoke”，而是把 Markdown 翻译系统收敛成一条稳定、可验证、可恢复的生产流水线。

具体目标分三层：

1. 正确性：
- Markdown 结构不坏
- 首现锚定正确
- 标题、列表、引用、强调、protected spans 不乱
- style 不推翻语义真相

2. 性能：
- short/full smoke 不要每轮从 0 开始
- analysis 成本必须可复用
- 已通过的 chunk 必须可恢复

3. 自动化：
- smoke 失败要能自动识别
- smoke 失败要能自动归类
- 后续能够从失败态继续进入下一轮修复

## 2. 当前分支与主线范围

仓库：
- [/Users/rongshen/vibe-coding/md-zh-translation-skill-142](/Users/rongshen/vibe-coding/md-zh-translation-skill-142)

当前分支：
- `codex/171-translation-ir-sidecar`

主线仍然围绕 `#171`，没有再切新的主 issue。

## 3. 当前技术思路

### 3.1 总原则

- LLM 负责理解：
  - anchor
  - heading
  - emphasis
  - alias
  - entity disambiguation
  - block / sentence 语义

- 程序负责执行：
  - source 对齐
  - owner / precedence
  - protected span 恢复
  - checkpoint / cache
  - 失败落盘与回放

- formatter 只负责样式：
  - 标点
  - 空格
  - 细节格式

### 3.2 当前真正的工程结论

经过大量迭代，已经明确：

- `analysis` 不是唯一主矛盾了
- 真正长期不稳的是：
  - freeform draft / repair 主通道
  - 多块 segment 的结构化输出不稳定
  - family / alias / heading owner 的组合态执行

所以当前主线不是继续补词条，而是持续把高风险段型从 freeform 通道迁到更强的结构化 lane。

## 4. 当前已经落地的关键能力

### 4.1 analysis / 执行层稳定性

已落地：
- analysis shard timeout / retry / split
- analysis quality gate
- compact heading recovery
- compact emphasis recovery
- draft / repair / audit / style stage timeout

### 4.2 结构化主通道

已落地：
- literal lane
- sentence lane
- block-structured prompt lane
- JSON block draft lane
- JSON block repair lane

当前趋势：
- 高风险段型持续从 freeform 迁到 JSON blocks
- 但并未完全移除 freeform

### 4.3 smoke 性能复用

已落地：
- analysis cache
- chunk checkpoint / resume
- 统一 smoke runner
- smoke 状态文件
- smoke 失败诊断器

相关脚本：
- [run-smoke.mjs](/Users/rongshen/vibe-coding/md-zh-translation-skill-142/scripts/run-smoke.mjs)
- [smoke-status.mjs](/Users/rongshen/vibe-coding/md-zh-translation-skill-142/scripts/smoke-status.mjs)
- [smoke-diagnose.mjs](/Users/rongshen/vibe-coding/md-zh-translation-skill-142/scripts/smoke-diagnose.mjs)
- [smoke-once.mjs](/Users/rongshen/vibe-coding/md-zh-translation-skill-142/scripts/smoke-once.mjs)

package scripts：
- `npm run smoke:short`
- `npm run smoke:full`
- `npm run smoke:status`
- `npm run smoke:diagnose`
- `npm run smoke:once`

### 4.4 自动诊断

当前 `smoke-diagnose` 已能产出：
- `state`
- `phase`
- `lastEvent`
- `category`
- `signals`
- `recommendedAction`

这意味着：
- 运行控制已基本自动化
- 但“失败后自动改代码再重跑”的 agent 层 supervisor 还没有完全接上

## 5. 当前 smoke fixture

仓库内 fixture：
- short：[claude-code-sandbox-short.md](/Users/rongshen/vibe-coding/md-zh-translation-skill-142/test/fixtures/smoke/claude-code-sandbox-short.md)
- full：[claude-code-sandbox-full.md](/Users/rongshen/vibe-coding/md-zh-translation-skill-142/test/fixtures/smoke/claude-code-sandbox-full.md)

当前 short 不是机械截断，而是结构化块选择生成。  
它用于优先暴露：
- 标题与 alias
- protected/source-shape
- intro / quote / list / heading 组合态
- family / entity disambiguation

## 6. 当前最新运行状态

### 6.1 最近的有效 smoke 结论

截至当前交接，最近两条最有价值的 smoke 结论分别是：

1. 最近的成功出稿但质检不通过：
- [short-artifact-check](/tmp/mdzh-smoke-runs/short-artifact-check)
- 结论：
  - smoke 流程通过并写出了 `output.md`
  - 但独立质量检查失败
  - `smoke-quality` 抓到了 8 个真实问题，包括：
    - 整句英文泄漏
    - 英文括注重复/嵌套
    - `bubblewrap` 链接尾部空格
    - 裸英文 `Sandbox mode`

2. 最近的主线失败：
- [short-continue-rerun](/tmp/mdzh-smoke-runs/short-continue-rerun)
- 结论：
  - `state = failed`
  - `phase = audit`
  - 最终失败点是：
    - `bubblewrap（安全隔离组件） ` 链接尾部空格
    - `* Seatbel*t` 强调片段被污染
  - 当前诊断类别：
    - `protected-span-corruption`

### 6.2 更晚的 fresh run

更晚又起了新的 short run：
- [short-heading-context-rerun](/tmp/mdzh-smoke-runs/short-heading-context-rerun)
- [short-direct-segment-audit-rerun](/tmp/mdzh-smoke-runs/short-direct-segment-audit-rerun)
- [short-blockquote-json-rerun](/tmp/mdzh-smoke-runs/short-blockquote-json-rerun)
- [short-list-json-rerun](/tmp/mdzh-smoke-runs/short-list-json-rerun)
- [short-sandbox-family-rerun](/tmp/mdzh-smoke-runs/short-sandbox-family-rerun)

这些 run 的意义：
- 持续验证新的分段规则和 lane 迁移是否把主阻塞后移
- 不一定每轮都形成一个稳定“最终主阻塞”，但它们提供了关键中间证据

### 6.3 最新最有价值的运行证据

当前最有价值的一条 fresh evidence 是：
- [short-list-json-rerun](/tmp/mdzh-smoke-runs/short-list-json-rerun)

它证明了两件事：

1. analysis cache 和 checkpoint 已真实生效
- 已复用 analysis cache
- 已跳过 `chunk 1`
- 已跳过 `chunk 2`

2. 主阻塞已经不再是最早那批 intro/protected-span 问题
- 最新有效失败已后移到：
  - `chunk 3`
  - `Sandbox / sandbox mode / Claude Code sandbox` 组合态
- 也暴露出新的结构化 draft lane 问题：
  - `empty final message`
  - `per-segment audit timeout`

## 7. 当前最小主阻塞

当前最值得继续收的最小阻塞不是单一一个，而是两条并行主线：

1. `protected/source-shape` 仍有尾部污染
- 最新直接体现在：
  - `bubblewrap（安全隔离组件） ` 链接尾部空格
  - `* Seatbel*t` 强调片段污染
- 这条属于：
  - `protected span restore/normalize`
  - 不是语义理解问题

2. `chunk 3` 的 family / alias 组合态
- `Sandbox / sandbox mode / Claude Code sandbox`
- 表现为：
  - alias 首现不稳定
  - family 混拼
  - 普通名词 / 产品名边界不稳
  - 结构化 lane 在该组合态段里仍不够稳定

### 为什么这条是当前主线

因为更早的几条问题已经明显后移：
- `chunk 1` 的 intro 结构切分已明显改善
- `--dangerously-skip-permissions` 不再是最早崩的地方
- `analysis cache` / `checkpoint` 已让验证成本明显下降
- 运行控制层已经能自动识别失败、读取状态、给出下一步建议
- `smoke-quality` 已能把“假通过”拦下来

所以继续推进的 ROI 最高点，不在基础设施，而在：
- `protected/source-shape` 的精细恢复
- `chunk 3` 的 family/alias 组合态
- 以及高风险结构化 lane 的稳定性

## 8. 已经证明有效的近期改动

以下改动已至少通过单测或真实 smoke 证明“方向有效”：

- analysis cache
- chunk checkpoint / resume
- smoke status / diagnose / once
- control-plane contamination stripping
- empty JSON-block draft -> strict JSON retry -> text rescue
- 单独 blockquote + protected flag 走 JSON block lane
- 纯 list block 走 JSON block lane
- intro quote / lead-in / heading 等边界继续拆细
- title-cased product anchor 不再宽松匹配 generic lowercase source phrase

## 9. 当前仍然没彻底解决的点

1. 结构化 lane 仍不够强
- 在某些组合态段落里，JSON block draft 仍会：
  - 返回空 blocks
  - 返回 meta/audit text
  - 或最终 empty final message

2. 失败后 agent 还不能完全“无人值守自动修”
- 运行控制已自动化
- 失败归类已自动化
- 但 category -> patch strategy -> patch -> rerun 这条 agent-side supervisor 还没彻底做成闭环

3. `chunk 3` 的 family/alias 组合态仍缺更强 owner 执行
- 现有 `aliasPlan`、`entityDisambiguationPlan`、canonical injection 思路是对的
- 但在真实多块段里仍未完全稳定

## 10. 推荐的继续推进顺序

下一位接手时，推荐顺序如下：

1. 先跑最新 short smoke
- 命令：
  - `npm run smoke:once -- --fixture short`
- 或：
  - `npm run smoke:short -- --label <new-label>`

2. 先读自动诊断结果
- 命令：
  - `npm run smoke:diagnose -- --fixture short --state failed`

3. 若主阻塞仍是 `chunk 3` family 问题
- 优先继续收：
  - `aliasPlan` 执行
  - `entityDisambiguation` 执行
  - family canonicalization 的 source match / owner precedence
- 不要先回去再调 timeout

4. 若主阻塞重新变回 `analysis quality gate`
- 优先收：
  - heading recovery 输入
  - heading owner 收敛
- 不要继续跑 chunk

## 11. 当前最小结论

一句话总结当前主线状态：

- 基础设施已经够用了：
  - 可以缓存
  - 可以 checkpoint
  - 可以自动检测失败
  - 可以给出失败建议
- 真正还没收口的是：
  - `chunk 3` 的 family/alias/owner 组合态
  - 以及结构化 draft lane 在这类段上的稳定性

也就是说，下一步不是再补 runner，而是继续收 **translation pipeline 本身**。
