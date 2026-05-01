# 为什么这么设计

这篇是给读完了 [02 § 它到底在做什么](02-how-it-works.md) 后想问"**为什么不直接 X**"的人。

每节回答一个具体的设计取舍，配上"如果不这么做会怎样"的真实例子。

---

## 1. 为什么是 Chunk + Segment 双层切分？

**直觉做法**：按某个固定大小切（如每 4 KB 一段），不分层。

**问题**：
- 切太大 → LLM 一次翻不动，长段重复 / 漏段
- 切太小 → 上下文丢失，术语前后翻译不一致；audit 拿不到"完整一节"看段落数对不对

**解法**：
- **Chunk** 按 H2 / H3 切（语义边界）—— audit 在这一层做"段落数 / 顺序 / 首现锚定"检查
- **Segment** 在 chunk 内进一步切到 ~2 KB —— LLM 实际翻译的最小单元

这样：
- LLM 输入永远在它"消化得了"的范围
- audit 看得到完整章节，能验全局结构
- chunk 失败时 rescue 单位清晰（重跑这一整章）

**反例**：曾经尝试只到 chunk 级（一次给 LLM 4-10 KB），实测在叙事密集长文上 paragraph_match 失败率高（loonshots 7 硬骨头就是这种）。后来加 segment 层后，命中率从 ~50% 提到 ~95%。

---

## 2. 为什么 Anchor catalog 是 first-class 概念？

**直觉做法**：每段独立翻译，让 LLM 自己保证术语一致。

**问题**：LLM 在长文里**记不住**前面用了什么译法。
- 第 1 段：Pan Am → 泛美航空
- 第 10 段：Pan Am → 泛美
- 第 20 段：Pan Am → 潘安（？！）

**解法**：翻译开始**前**先扫整篇文档建 anchor catalog，每个术语固化一种 `chineseHint`。翻译每个 segment 时，跟这个 segment 相关的 anchor **作为强制约束**塞进 prompt：
- 是首现 → 必须输出 `中文（English）`
- 是 repeat → 只能用 `中文`

这样全篇 Pan Am 永远是"泛美航空（Pan Am）"首现 + 后续只用"泛美航空"。

**反例**：某次 anchor catalog 没识别到某专有名词，整篇 14 段里同一个名字被译成了 4 种不同中文版本——读者完全分不清是不是同一个人。把它加到 `known_entities.json` 后问题消失。

---

## 3. 为什么 Protected span 在 LLM 之外做？

**直觉做法**：让 LLM 看见原文，告诉它"代码块不要翻"。

**问题**：LLM 很难真听话。
- 看到 `const x = 1` 就想译成"常量 x = 1"
- 看到 `pip install` 就想译成"pip 安装"
- 看到 URL 就想"翻译"域名

更糟：占位符 placeholder 数量发生变化（多了 / 少了 / 改了），下游恢复时报错或乱位。

**解法**：在调 LLM **之前**把代码 / 链接 / 图片 / HTML 替换成 `@@MDZH_*@@` 占位符。LLM 看到的是：

```
See @@MDZH_LINK_DESTINATION_0001@@.

@@MDZH_CODE_BLOCK_0002@@
```

LLM 只需要做一件简单事：保留这些占位符。

audit 强制检查：占位符数量 = source 数量。模型乱改一个占位符 → 直接 fail → repair。

**反例**：早期没用占位符直接给 LLM 看代码块，每 5 个 chunk 就有 1 个把 `const` 翻成"常量"。换占位符后这类问题降到接近 0。

---

## 4. 为什么 Audit 用 LLM 而不是确定性规则？

**直觉做法**：写一堆正则 / 规则检查段落数、首现锚定、单位换算。

**问题**：
- 段落数好查，但"首现锚定有没有按 anchor catalog 加英文括注"涉及语义判断
- 单位换算 "200 pounds" 该补"约 91 公斤"——值得不值得补 / 用什么形式补，跟上下文相关
- 中文标点合规（中英文之间是否需要空格）也是语义级

**解法**：让另一次 LLM 调用做"自检"，输出结构化 JSON：

```json
{
  "hard_checks": {
    "paragraph_match": { "pass": true, "problem": "" },
    ...
  },
  "must_fix": [...]
}
```

确定性的部分（占位符数量、段落数）pipeline 自己 double-check 一遍；语义的部分（首现锚定形式、单位换算合理性）信赖 LLM。

**反例**：曾经尝试纯规则做首现锚定检查，规则越写越多越不准——"Apple" 是公司还是水果？"Bush" 是 Vannevar Bush 还是 George Bush？放给 LLM 一次调用就解决。

---

## 5. 为什么 Soft-gate 而不是 Hard-fail？

**直觉做法**：任意 chunk 失败就抛错退出码 4，让用户知道哪段不对。

**问题**：在长文（书 / 大文档）上几乎必然失败。
- 翻一本 700 KB 的书，134 个 chunks，**每个 chunk** 通过率 99% 也意味着整本失败概率 (1 - 0.99^134) = 74%
- 失败的报错只告诉你"chunk 14 没过"——你也只能把整本扔了重跑
- 重跑还是会有不同的 chunk 失败

**解法**：soft-gate 默认开。任一 chunk 实在过不了，**保留这一段为英文 source 段**，整 run 继续：
- 整本译文出来，结构完整
- failed chunk 在 telemetry 标记得清清楚楚（`chunk.error.meta.recovered=true`）
- 你能精准知道哪 5-10 段需要补
- 可以走 sparse retry 仅重译这几段，或挂 external rescue hook 自动补

**反例**：用 hard-gate 模式跑过 spec-driven 长文一次，chunk 7 hard-fail，剩 chunks 12-17 没跑到，第二天起来什么都没有。改 soft-gate 之后，整本能完整跑下来。

---

## 6. 为什么 Repair 默认升 gpt-5.5 而不是延续 mini？

**直觉做法**：mini 既然能翻，就用 mini 修。

**问题**：mini 在 audit 给出"段落数错了，请改"这种**结构性修复指令**上命中率低。
- mini 看到指令"补回原文第 5 段"，可能补了一段但内容随机
- 模型规模决定指令理解力——mini 不够强

**解法**：repair 阶段（带具体 must_fix 指令的）默认用 gpt-5.5：
- 强模型理解指令更准
- 失败的 cycle 比 mini 少
- 总体成本反而**降**（少几次 cycle 比 cycle 内升一档贵的少）

**反例**：曾经 repair 还是用 mini，loonshots 上 12 个 chunks 撞过 paragraph_match 反复 cycle 不收敛。改 5.5 后这些 chunks 几乎都在 cycle 1 命中。

---

## 7. 为什么 Rescue 是"整 chunk 重做"而不是"接着改"？

**直觉做法**：repair 失败了，让模型再多 cycle 几次，多看几次 audit 反馈。

**问题**：repair 反馈带在上下文里，模型会被前面的错误 anchored 住——继续在同样错误的层面打转。
- audit："请删除重复的第 5 段"
- repair：删除了第 5 段但加了重复的第 6 段
- audit："请删除重复的第 6 段"
- 像个无限循环

**解法**：rescue 整 chunk 从头来一遍，**不带 audit 反馈**——清空上下文用强模型 draft + audit + repair。
- 摆脱上一轮错误锚定
- 强模型在干净 draft 上的命中率高于在污染上下文中改进

**反例**：曾经 rescue 也带 audit 反馈，命中率没显著提升，但 token 成本翻倍。改成"清空上下文"后命中率反而升了。

---

## 8. 为什么 External hook 是 shell 命令而不是内置 SDK？

**直觉做法**：在 pipeline 里写 Anthropic SDK 调用。

**问题**：
- 把 pipeline 跟 Anthropic API 绑死，用户用不了 GPT-5 / 自家模型 / 句子级拆分 / 人工 webhook
- 内置 SDK 要处理 API key、retry、模型切换等，每加一个支持就重新打包
- 升级 SDK 要改 pipeline 代码 + 重发版

**解法**：pipeline 通过 `/bin/sh -c` 启动用户写的 shell 命令，stdin 接 source、stdout 接译文。
- pipeline 不知道你接的是什么——Claude / GPT / 句子级拆分 / 人工
- 用户独立升级 hook，不用动 pipeline
- shell 命令可以串联多个工具（先 Claude 不行就 GPT，再不行就发 Slack）

**反例**：考虑过把 Claude 内置成"可选 dependency"，但每次 Anthropic SDK 升级都要 chase；改成 shell hook 后，pipeline 6 个月没动，hook 用户自由升模型。

---

## 9. 为什么 Translation Memory 是 JSONL 而不是 SQLite / Redis？

**直觉做法**：用 SQLite 加索引快速查，或者 Redis 共享。

**问题**：
- 用户场景多样：单机跑 / Git 仓库共享 / 临时跑一次
- SQLite 文件不能直接 git diff，团队协作差
- Redis 要起服务，不必要的部署复杂度

**解法**：JSONL，一行一条记录。
- 直接 `git add` 提交到团队仓库
- `cat` `grep` `jq` 都能直接处理
- 命中查询用 `Map<fingerprint, entry>` 启动时加载到内存（几万条数据下毫秒级）
- 写入 append-only 不锁文件

**反例**：考虑过 SQLite，但用户经常想看 TM 内容、合并不同分支的 TM、tail 实时新增——文本格式都更友好。

---

## 10. 总体设计哲学

把上面这些放一起看，几个一致的偏好：

**1. 把 LLM 看成"会幻觉的强者"**
- 给它强约束（占位符 / anchor / segment 大小）减少出错面
- 出错后快速检测（audit）+ 多层兜底（repair / rescue / hook / soft-gate）
- 不指望它 100% 正确，**指望整本能跑完**

**2. 失败优雅 > 失败显式**
- 长文场景 99% 通过率仍意味着整本必失败
- soft-gate 让"有几段失败"≠"整本失败"
- 失败可观察可追溯（telemetry / checkpoint）能事后修

**3. 通用 hook > 内置专属**
- pipeline 不绑定具体模型 / API / 工具
- shell 接口让用户随时升级、随时切换、随时自定义

**4. 缓存 + 续译是 first-class**
- 不假设跑一次就成功
- analysis cache、checkpoint、TM 三层共同作用，重跑成本接近零
- sparse retry 让"事后精准修复几段"工作流可行

**5. 可观察 > 可解释**
- 大量 telemetry 事件，足够事后复盘
- 不试图解释模型为什么这样翻——只观察它怎么 fail 然后兜住
