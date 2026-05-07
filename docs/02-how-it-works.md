# 它到底在做什么

读完这篇你会理解：
- 为什么直接调 LLM 翻一本书会出大问题
- 这个工具的解法分几层、每层在解决什么
- 那些 stderr 进度行（chunk / segment / anchor / repair / rescue）背后是什么
- 为什么有时候译文里有英文段——这是设计而不是 bug

预计 45 分钟。

---

## 0. 一个直接调 LLM 翻一本书会发生什么的故事

假设你拿到一本 700 KB 的英文书，想译成中文。最直觉的办法是：

```python
chinese = call_llm("把下面这段英文翻译成中文：" + entire_book)
```

这会出几类问题：

**1. 上下文窗口装不下** — 700 KB 远超 LLM 的输入上限。

**2. 切成小段送进去，术语前后不一致** — 第一段把 "Pan Am" 译成"泛美航空"，第十段译成"泛美"，第二十段又变成"潘安"。

**3. 代码块被翻** — `const x = 1` 变成 `常量 x = 1`，`pip install` 变成 `pip 安装`。

**4. 链接被改** — `[click here](https://...)` 变成 `[点这里](https://翻译过的中文域名)`。

**5. 图片占位符丢失** — 图片标签被模型当成普通文字处理掉。

**6. 长段重复 / 漏段** — 模型在翻 20 段连续叙事时，记不住前面有没有翻过，导致第 14 段重复了第 8 段，原文第 22 段没有对应译文。

**7. 单位换算缺失** — 美式书里说 "200 pounds"，中文读者要心算。

**8. 失败无救援** — 某一段翻车了，整本就没法用，要从头再来。

---

## 1. 设计目标：怎么解决上面 8 件事

这个工具不是"调一次 LLM 翻全文"，而是一条**流水线**。流水线的每一层针对上面的某类失败：

| 失败 | 解决层 |
|---|---|
| 1. 装不下 | **Chunk plan**：按 H2/H3 切大块 |
| 2. 术语不一致 | **Anchor catalog**：先扫全文建术语表，翻译时强制使用 |
| 3, 4, 5. 代码 / 链接 / 图片被改 | **Protected span**：把它们换成占位符再交给 LLM |
| 6. 长段乱 | **Segment**：chunk 内再切小段，加上 audit 检查段落数 |
| 7. 单位 | **Audit hard check**：检测 inch/pound/Fahrenheit 没换算就拒收 |
| 8. 失败无救援 | **Repair × 2 → Rescue → external hook → Soft-gate fallback to source** |

接下来逐项展开。

---

## 2. 核心概念

### 2.1 Chunk vs Segment

**Chunk**：一篇文档按 H2 / H3 章节切成的大段。一个 chunk ≈ 一节内容，可能 2-10 KB。

**Segment**：chunk 内进一步切的小段。一个 segment ≈ 几个紧密相关的段落，可能 500-2000 字符。

切法的目的：**让 LLM 一次只翻它"消化得了"的量**。

```
loonshots.md (728 KB)
  │
  └─ planMarkdownChunks
       │
       ├─ Chunk 1: # Loonshots             (4 KB)
       │    ├─ Segment 1/2  (2 KB)
       │    └─ Segment 2/2  (2 KB)
       ├─ Chunk 2: ## Prologue              (3 KB)
       │    └─ Segment 1/1  (3 KB)
       ├─ Chunk 3: ## Introduction          (8 KB)
       │    ├─ Segment 1/4  (2 KB)
       │    ├─ Segment 2/4  (2 KB)
       │    ├─ Segment 3/4  (2 KB)
       │    └─ Segment 4/4  (2 KB)
       ...
       └─ Chunk 134: ## Source Notes        (10 KB)
```

每个 segment 是 LLM 实际翻译的最小单元。chunk 是 audit / rescue 的单位（chunk 内任何 segment 失败，整 chunk 重来）。

**为什么要双层？** 单层不够：
- 只切到 chunk 级 → segment 太大，模型对长段记不住前后段落
- 只切到 segment 级 → 没有 chunk 这一层"整体上下文"，audit 时不知道完整段落数对不对

### 2.2 Anchor catalog（术语表）

翻译开始前 pipeline **先扫整篇文档**，识别所有需要在中文里保持一致的"术语"——人名、公司、专有概念、技术术语。

每个 anchor 长这样：

```json
{
  "english": "Pan Am",
  "chineseHint": "泛美航空",
  "familyKey": "pan am",
  "firstOccurrence": { "chunkId": "chunk-25", "segmentId": "chunk-25-segment-3" },
  "category": "company",
  "displayPolicy": "chinese-primary",
  "sourceForms": ["Pan Am", "Pan American"]
}
```

含义：
- `english` / `chineseHint`：英文形式 + 中文标准译法
- `firstOccurrence`：在哪个 chunk-segment 第一次出现
- `displayPolicy: chinese-primary`：中文为主、首现加英文括注（`泛美航空（Pan Am）`），后续出现只用中文
- `sourceForms`：模型可能在原文里看到的不同写法

翻译每个 segment 时，pipeline 把跟这个 segment 相关的 anchor **作为强制约束**塞进 prompt：
- 是 anchor 首现 → 模型必须输出"中文 + 英文括注"形式
- 是 repeat → 模型只能用中文（不能再括注一次）

这样 "Pan Am" 全书都是同一个译法，"Lindbergh" 永远是"林德伯格（Lindbergh）"首现 + 后续"林德伯格"。

### 2.3 Protected span（占位符）

代码块、链接、图片、HTML 这些**不能让 LLM 看到原文**——一看到就会去改。

pipeline 在调用 LLM **之前**，把它们替换成占位符：

```
原文：
  See [click here](https://example.com/path).
  
  ```typescript
  const x = 1;
  ```
  
  ![diagram](images/foo.png)

protected：
  See @@MDZH_LINK_DESTINATION_0001@@.
  
  @@MDZH_CODE_BLOCK_0002@@
  
  @@MDZH_IMAGE_DESTINATION_0003@@
```

LLM 看到的是 protected 版本——它知道 `@@MDZH_*@@` 是占位符，**原样保留**就行。LLM 不需要知道占位符背后是什么。

LLM 出了译文之后，pipeline 再把占位符换回原始的 `[click here](...)` / 代码块 / 图片。

`audit` 阶段会强制检查：占位符数量必须跟 source 一致（hard check `protected_span_integrity`）。模型乱改一个占位符 → 直接失败 → 进 repair。

### 2.4 Audit gate（审校门）

每翻完一个 chunk，pipeline 让**另一次 LLM 调用**做"自检"，输出结构化的 JSON：

```json
{
  "hard_checks": {
    "paragraph_match": { "pass": true, "problem": "" },
    "first_mention_bilingual": { "pass": false, "problem": "Pan Am 首现未加英文括注" },
    "numbers_units_logic": { "pass": true, "problem": "" },
    "chinese_punctuation": { "pass": true, "problem": "" },
    "unit_conversion_boundary": { "pass": true, "problem": "" },
    "protected_span_integrity": { "pass": true, "problem": "" },
    "embedded_template_integrity": { "pass": true, "problem": "" }
  },
  "must_fix": ["Pan Am 首现需补 (Pan Am) 英文括注"]
}
```

七项 hard check：
- `paragraph_match`：段落数 / 顺序跟原文严格对应
- `first_mention_bilingual`：anchor 首现必须有中英对照
- `numbers_units_logic`：数字 / 数量 / 计算关系正确
- `chinese_punctuation`：中文排版规范（中英文之间空格、标点正确）
- `unit_conversion_boundary`：英寸 / 磅 / 华氏度补常见公制换算
- `protected_span_integrity`：protected 占位符数量 = source 的数量
- `embedded_template_integrity`：嵌入式伪代码模板（如规格说明书的 `## 1. Overview` bold 标题）原样保留

任何一项 fail → must_fix 列表进入 **repair stage**。

### 2.5 Repair stage

audit 报了具体什么错，pipeline 把这些 must_fix 作为**指令**塞进新一轮 prompt 让模型针对性修：

```
前一轮译文有这些问题：
- Pan Am 首现需补 (Pan Am) 英文括注

请修正后重新输出译文。
```

repair 跑最多 2 个 cycle（硬编码上限）。每 cycle 后再 audit。

repair 默认用 **gpt-5.5**（比初始 draft 用的 gpt-5.4-mini 强）—— 因为带着精确指令的强模型，命中率比"瞎写一遍"高。

### 2.6 Rescue model（整 chunk 重做）

如果 2 cycles repair 都没修好，pipeline 把这整个 chunk **从头**用更强的模型重做一遍：

- 抛掉之前的 draft / repair 结果
- 用 gpt-5.5 重新跑 draft + audit + repair 一整套
- 不再带 audit 的 must_fix（这跟 repair 不同——rescue 假设之前的反馈本身没用，从空白来一遍）

如果 rescue 也失败，进入下一层。

### 2.7 默认 final-rescue（PR #115，默认开启）

当内置 rescue 也失败、`MDZH_SOFT_GATE` 仍为 true 时，pipeline 自动跑一档"默认 final-rescue"：

- 仍用 `gpt-5.5`，但**不走 audit / repair**：单次直翻
- prompt 比内置 rescue 更宽松、信息更多——含章节路径、占位符说明、可选术语表（`MDZH_RESCUE_GLOSSARY_PATH`）、可选上一段译文
- 校验只做三件事：段落数 = 原文段落数、占位符数 = 原文占位符数、至少含 1 个中文字符

设计意图：内置 rescue 用 `gpt-5.5` 走完整 audit + repair 还失败的 chunk，问题往往不是模型译不出来，而是 audit 反复挑刺把候选枪毙；这一档把 audit 拿掉，用同一个模型再试一次更宽松的版本。

关闭：`MDZH_DEFAULT_FINAL_RESCUE=off`。

如果这一档也失败，进入下一层。

### 2.8 External rescue hook（PR #110，opt-in）

当 codex 内置层（draft + repair + rescue + 默认 final-rescue）全都救不回时，调用用户配置的外部命令：

```bash
export MDZH_FINAL_RESCUE_COMMAND="claude-translate.sh"
```

- 命令通过 `/bin/sh -c` 启动
- protected source 写到 stdin
- stdout 是中文译文
- pipeline 校验后接受（段落数 / placeholder / CJK 字符）

设计意图：**让 pipeline 不绑定具体模型**——用户接 Claude / 接 GPT-5（不通过 codex）/ 接句子级拆分 / 接人工 webhook 都行。

详见 [`05-advanced.md` § external rescue hook](05-advanced.md)。

### 2.9 Soft-gate fallback to source

最后一层兜底：上面所有层都失败，pipeline 把这一段**保留为英文 source**（带占位符还原），继续翻下一个 chunk。

```
原文段：    Trippe began discussions with Boeing...
译文段：    Trippe began discussions with Boeing...   ← 没翻，原样保留
```

这是**特性不是 bug**：

- 整本书不会因为一段翻不好就废掉
- 段落级结构完整（图片 / 链接 / 占位符全保留）
- 你能精准知道哪几段需要人工或外部模型补
- 跑完 telemetry 里 `chunk.error` 事件 `recovered=true` 的就是这种 chunk

要禁用 soft-gate（让任一 chunk 失败就整 run 抛错）：`MDZH_SOFT_GATE=false`。

---

## 3. 流水线全貌

```
英文 .md
  │
  ├─ Frontmatter 提取（保留 YAML 头）
  │
  ├─ Protect spans
  │     代码块 / 链接 / 图片 / HTML → @@MDZH_*@@ 占位符
  │
  ├─ Plan chunks（按 H2/H3 切）
  │
  ├─ Document analysis（扫整篇建 anchor catalog + heading plan）
  │     ├─ 先比对内置 known_entities.json
  │     └─ 模型补充未识别的 anchor（多 shard 并行）
  │
  ├─ Per-chunk loop（默认并发 3）
  │     │
  │     │   ┌─ Draft (gpt-5.4-mini, json-blocks lane 默认)
  │     │   │     │
  │     │   │     └─ 每个 segment 独立翻译
  │     │   │
  │     │   ├─ Audit (bundled, 7 项 hard checks)
  │     │   │     │
  │     │   │     ├─ pass → done
  │     │   │     └─ fail → must_fix
  │     │   │
  │     │   ├─ Repair × 2 (gpt-5.5)
  │     │   │     │
  │     │   │     ├─ 命中 → done
  │     │   │     └─ 仍 fail → rescue
  │     │   │
  │     │   ├─ Rescue (整 chunk gpt-5.5 重做)
  │     │   │     │
  │     │   │     ├─ 命中 → done
  │     │   │     └─ 仍 fail
  │     │   │           │
  │     │   │           ├─ Default final-rescue (默认开, gpt-5.5 单次直翻, 无 audit)
  │     │   │           │     │
  │     │   │           │     ├─ 通过宽松校验 → done
  │     │   │           │     └─ 仍 fail
  │     │   │           │           │
  │     │   │           │           ├─ External rescue hook (opt-in, MDZH_FINAL_RESCUE_COMMAND)
  │     │   │           │           │     │
  │     │   │           │           │     ├─ 通过校验 → done
  │     │   │           │           │     └─ 仍 fail → soft-gate
  │     │   │           │           │
  │     │   │           │           └─ Soft-gate fallback to source (保留英文段)
  │     │   │
  │     │   └─ 后处理：anchor 注入、错绑清理、结构骨架对齐、reprotect
  │     │
  │     └─ Checkpoint write（chunk 完成就写）
  │
  ├─ Restore spans（@@MDZH_*@@ → 原始 markdown）
  │
  ├─ Format（@jacobbubu/md-zh-format 美化中英文空格 / 标点）
  │
  └─ 写入 .zh.md
```

---

## 4. 缓存与续译

为加速重跑：

**Analysis cache**（`MDZH_ANALYSIS_CACHE_DIR`）：
- anchor catalog 的发现成本高（多 shard 调模型，~30 min 一次）
- cache key 含源文哈希 + 实现指纹（代码改了 cache 自动失效，保正确性）
- 命中时跳过整个 analysis 阶段

**Checkpoint**（`MDZH_CHECKPOINT_DIR`）：
- 每完成一个 chunk 就把 body 写到 checkpoint JSON
- 中途崩溃重跑时，已完成的 chunks 自动跳过
- PR #108 后支持 **sparse checkpoint**：手动从 checkpoint 删几个 chunk 的 entry，重跑只翻这几个（适合"事后修复"工作流）

**Translation Memory**（`MDZH_TM_PATH`）：
- segment 级翻译记忆库（JSONL）
- 同样源文哈希命中 → 直接复用，跳过 LLM 调用
- 跨文档复用术语 / 重复段落

详见 [`03-configuration.md`](03-configuration.md)。

---

## 5. 为什么会有 fallback chunks（重要）

读到这里你可能会问：上面层层救援都过去了，为什么还有 chunk 翻不出来？

实测在 loonshots（728 KB / 134 chunks）上，跑完后稳定有 7 个 chunks 走到 soft-gate fallback。多次重跑都是同样集合（chunks 14 / 30 / 54 / 69 / 72 / 91 / 109）。这是**当前模型 + 当前 prompt 形态**的能力天花板。

具体失败模式分三类：

**A. 段落级幻觉**（chunks 14 / 30 / 54 / 69 / 72）
- 模型在 4-10 KB 的叙事密集 segment 上"记不住"已经翻过哪些段
- 表现：第 4 段重复第 2 段、漏译第 6 段、跨段错位
- audit 的 `paragraph_match` 抓得到、repair / rescue 都修不好——模型每次都犯同样错

**B. Placeholder 复制**（chunk 91）
- image 占位符 `@@MDZH_IMAGE_DESTINATION_0095@@` 被模型错误复制到译文不同位置
- audit `protected_span_integrity` 抓得到、修不好

**C. Draft 元话语**（chunk 109）
- source 是密集的 reference list（书目）
- 模型解读成"审校请求"返回元话语而不是翻译
- draft contract 检测到拒绝、再 retry 仍是同样错

这些都是**模型在特定 source 形态上的固有偏好**，不是 prompt / 流水线的 bug。

**怎么处理它们？** 详见 [`05-advanced.md` § 处理 fallback chunks](05-advanced.md)：
- 启用 external rescue hook 接更强模型（如 Claude Opus）
- 用 sparse retry 仅重译失败 chunks
- 实在不行手工译那几段（占比通常 <5%）

---

## 6. 关键代码入口

如果你想读源码理解某层：

| 概念 | 代码位置 |
|---|---|
| Chunk plan | `src/markdown-chunks.ts` |
| Protected span | `src/markdown-protection.ts` |
| Anchor catalog / 注入 | `src/anchor-normalization.ts` + `src/translation-state.ts` |
| Translate orchestration | `src/translate.ts`（主流程，~3000 行） |
| Audit prompts / parsing | `src/internal/prompts/scheme-h.ts` + `src/translate.ts` 内 audit helpers |
| Telemetry | `src/telemetry.ts` |
| Translation Memory | `src/translation-memory.ts` |
| 结构骨架对齐器 | `src/structure-skeleton.ts` |
| Final rescue hook | `src/translate.ts` 内 `executeFinalRescueCommand` / `validateFinalRescueOutput` |

更深入的代码级讲解见 [`internals/pipeline-deep-dive.md`](internals/pipeline-deep-dive.md)。

---

## 下一步

- 想配置参数让它更贴合你的场景？→ [`03-configuration.md`](03-configuration.md)
- 跑出问题需要诊断？→ [`04-troubleshooting.md`](04-troubleshooting.md)
- 想接外部模型 / 跨文档 TM / 接 MCP？→ [`05-advanced.md`](05-advanced.md)
- 想理解为什么这么设计（设计源流）？→ [`06-design-rationale.md`](06-design-rationale.md)
