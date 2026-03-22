# md-zh-translation-skill

把英文 Markdown 文章翻译成中文 Markdown 的 CLI Skill。公开入口只有 `md-zh-translate`，内部使用冻结版 `方案H`，默认模型固定为 `gpt-5.4-mini`，最终结果会经过 `@jacobbubu/md-zh-format` 美化。

## 环境要求

- Node.js `>= 20`
- 本机已安装并可直接执行 `codex`
- `codex` 已完成登录或鉴权

## 安装

先克隆仓库，然后安装依赖并构建：

```bash
git clone https://github.com/jacobbubu/md-zh-translation-skill.git
cd md-zh-translation-skill
npm install
npm run build
```

如果你希望在任意目录直接使用 `md-zh-translate`，再执行一次：

```bash
npm link
```

如果你不想做全局链接，也可以直接用：

```bash
node dist/src/cli.js --help
```

## 最常用的 3 种模式

文件到文件：

```bash
md-zh-translate --input article.md --output article.zh.md
```

文件到标准输出：

```bash
md-zh-translate --input article.md > article.zh.md
```

标准输入到标准输出：

```bash
cat article.md | md-zh-translate > article.zh.md
```

查看帮助和版本：

```bash
md-zh-translate --help
md-zh-translate --version
```

## 参数与行为

- `--input <path>`：从文件读取英文 Markdown。提供后会忽略 stdin。
- `--output <path>`：把最终译文写到文件。不提供时，结果写到 stdout。
- `--help`：打印完整帮助。
- `--version`：打印当前版本号。

标准流约定：

- `stdout` 只输出最终译文。
- `stderr` 只输出阶段进度和故障信息。
- 当你使用 `--output` 时，`stdout` 默认保持为空。

退出码：

- `0`：成功
- `2`：参数错误或没有提供输入
- `3`：`codex exec` 执行失败
- `4`：内部硬性门控在修复轮后仍未通过
- `5`：Markdown 美化失败

## 输入与输出约束

这个工具面向“英文 Markdown 文章”场景，默认约束如下：

- 保留 Markdown 结构
- 保留代码块、行内代码、链接目标、图片 URL 和原始 HTML
- 首次出现的人名、机构名、关键术语会做中英文对照
- 长度、重量、华氏温度、以英寸表示的累计降水量会补常见公制/摄氏度换算
- 最终译文会再经过 `@jacobbubu/md-zh-format` 美化

这些约束是工具内部行为，不需要额外传参。

## 常见问题

### 1. 提示 `md-zh-translate: command not found`

说明你还没有执行 `npm link`，或者当前 shell 没拿到全局 npm bin 路径。

先试：

```bash
npm link
```

如果你只是在当前仓库里用，也可以直接运行：

```bash
node dist/src/cli.js --help
```

### 2. 提示没有输入内容

你需要二选一：

- 传 `--input <path>`
- 或者通过管道把 Markdown 喂给 stdin

例如：

```bash
cat article.md | md-zh-translate > article.zh.md
```

### 3. 提示 `codex exec` 失败

先确认两件事：

- `codex` 已安装并且在 `PATH` 里
- 当前机器上的 `codex` 已完成登录

可以先单独执行：

```bash
codex --help
```

### 4. stderr 里为什么会有进度信息

这是设计行为。这个工具把最终译文留给 `stdout`，便于重定向、管道和脚本消费；阶段进度和故障都写到 `stderr`。

## 在 Codex 里作为 Skill 使用

仓库根目录已经包含 `SKILL.md` 和 `agents/openai.yaml`。如果你要把它安装成一个本地 Codex skill，可以把整个仓库放到 `$CODEX_HOME/skills/md-zh-translation-skill` 下，再按你的 Codex 环境约定触发该 skill。

对 skill 使用者来说，公开接口仍然只有 `md-zh-translate`，不会暴露 prompt 研究和评测流程。
