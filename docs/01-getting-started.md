# 入门：翻译你的第一篇文章

读完这篇你会：
- 装好工具，跑通一次完整翻译
- 看懂跑的过程中 stderr 在说什么
- 看懂产出的 .zh.md 哪些段是好的、哪些段需要关注

预计 30 分钟。

---

## 1. 安装

```bash
# 用 npm
npm install -g md-zh-translation-skill

# 验证
md-zh-translate --version
md-zh-translate --help
```

如果还没装 [codex](https://github.com/openai/codex)，先装它并登录：

```bash
codex --help          # 应该能看到帮助
codex auth login      # 还没登录就登一下
```

> 这个工具不是直接调 OpenAI API，而是调本地的 codex CLI——所以不需要在环境里配 `OPENAI_API_KEY`，codex 自己管。

---

## 2. 准备一篇短文

新建 `hello.md`：

```markdown
# What Is Spec-Driven Development

Spec-driven development means writing a detailed specification **before** any code.

## Key benefits

- No debates about architecture during coding
- Tests can be derived directly from the spec
- Onboarding new team members becomes mechanical

```typescript
const greeting: string = "Hello, World!";
console.log(greeting);
```

For more, see the [original article](https://example.com).
```

3 个段落、1 个二级标题、1 段代码、1 个链接——足够展示工具的所有核心行为。

---

## 3. 跑翻译

```bash
md-zh-translate --input hello.md --output hello.zh.md
```

终端（stderr）会一行一行打出进度，大致这样：

```
[md-zh-translate] Analyzing document-wide anchors.
[md-zh-translate] Loading formal known_entities.
[md-zh-translate] Matched 0 formal known_entities in source.
[md-zh-translate] Planned 1 analysis shard(s) for model-based anchor discovery.
[md-zh-translate] Starting model-based anchor discovery for shard 1/1 attempt 1 (...)
[md-zh-translate] Shard 1/1 attempt 1 finished: 2 anchors, 1 heading plan(s), 0 ignored term(s).
[md-zh-translate] Chunk 1/1 (What Is Spec-Driven Development), segment 1/2: starting translation with model gpt-5.4-mini.
[md-zh-translate] Chunk 1/1 (What Is Spec-Driven Development), segment 2/2: starting translation with model gpt-5.4-mini.
[md-zh-translate] Chunk 1/1 (What Is Spec-Driven Development): running hard gate audit for 2 segment(s).
[md-zh-translate] Updated translation checkpoint at /tmp/...
[md-zh-translate] Formatting translated Markdown.
```

跑完没报错 → 退出码 0 → 看 `hello.zh.md`。

---

## 4. 读懂进度日志

每行 `[md-zh-translate]` 都对应流水线的一个步骤。从上到下依次发生：

| 看到这一行 | pipeline 在做什么 |
|---|---|
| `Analyzing document-wide anchors` | 扫整篇文档，识别人名 / 公司 / 关键术语，建一份**术语表（anchor catalog）** |
| `Loading formal known_entities / Matched N` | 跟内置的"已知术语表"对一遍，避免重新发明 |
| `Planned N analysis shard(s)` | 决定 anchor 发现要切几片调模型 |
| `Starting model-based anchor discovery for shard X/N` | 模型在帮忙发现术语 |
| `Chunk X/N ... segment Y/M: starting translation` | 翻译某个 chunk 的某个 segment（chunk 是一大节内容，segment 是 chunk 内更小的拆分） |
| `running hard gate audit` | 翻完后让模型自检：段落数对得上吗？术语首现给中英对照了吗？数字单位换算补了吗？ |
| `repair cycle X of 2` | audit 发现问题，让模型针对性修 |
| `retrying with rescue model gpt-5.5` | 一般模型修不好，换更强的模型整 chunk 重做 |
| `soft-gate caught chunk failure ... falling back to source content` | 全部救援都失败了，保留这一段英文不让整篇翻译失败（详见 [02 § soft-gate](02-how-it-works.md)） |
| `Formatting translated Markdown` | 调 `@jacobbubu/md-zh-format` 做最后美化（统一空格、标点） |

最关键的一行是 `falling back to source content`——意思是**这段没翻好，留了英文**。这不是 bug，是设计（详见 [02-how-it-works](02-how-it-works.md) 的 soft-gate 一节）。

---

## 5. 看产出文件

`hello.zh.md` 大致这样：

```markdown
# 什么是规格驱动开发（What Is Spec-Driven Development）

规格驱动开发（spec-driven development）的意思是在动任何代码之前**先**写一份详细的规格。

## 主要好处

- 编码期间不再争论架构
- 测试可以直接从规格推导出来
- 新成员上手变成机械化的事

```typescript
const greeting: string = "Hello, World!";
console.log(greeting);
```

更多内容见[原文](https://example.com)。
```

注意几件事：

**1. 标题加了首现锚定**：`# 什么是规格驱动开发（What Is Spec-Driven Development）`
- 第一次出现的关键术语会自动加英文对照
- 后面再出现就只用中文了

**2. 列表项被翻译，结构（`-`）保留**

**3. 代码块原样保留**——`const greeting`、`console.log` 这些不动
- 工具知道代码是代码，不会去翻 `string` 这种类型名

**4. 链接结构保留**：`[原文](https://example.com)`
- 链接文字翻译，URL 不动

---

## 6. 输入输出约定

```
md-zh-translate --input <英文.md> --output <中文.md>     # 文件 → 文件
md-zh-translate --input <英文.md> > <中文.md>             # 文件 → stdout
cat <英文.md> | md-zh-translate > <中文.md>               # stdin → stdout
```

- `stdout` 只输出最终译文
- `stderr` 输出进度日志和错误（你看的那些 `[md-zh-translate]` 行）
- 进度可以管道到日志文件：`md-zh-translate ... 2> progress.log`

---

## 7. 退出码

跑完后 `echo $?` 看返回值：

| 码 | 含义 | 怎么办 |
|---|---|---|
| 0 | 成功 | 直接看产出文件 |
| 2 | 参数错误 | 看 `--help`，确认 `--input` 给了正确路径 |
| 3 | codex 执行失败 | 检查 codex 装了没、登录了没（[04-troubleshooting](04-troubleshooting.md)） |
| 4 | 翻译反复救不回 | 启用 [`MDZH_SOFT_GATE=true`](03-configuration.md) 让 pipeline 容忍失败段（默认 CLI 已开） |
| 5 | 美化失败 | 罕见。一般是 codex 输出了非法 Markdown |

---

## 下一步

- 想理解上面那些 chunk / segment / anchor / soft-gate 到底是什么？→ [`02-how-it-works.md`](02-how-it-works.md)
- 想跑长文（书 / 大篇文章），需要 checkpoint / 缓存 / 并发？→ [`03-configuration.md`](03-configuration.md)
- 跑出问题了？→ [`04-troubleshooting.md`](04-troubleshooting.md)
