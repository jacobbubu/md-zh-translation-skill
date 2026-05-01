# 高级用法

读完前需要先理解 [02-how-it-works](02-how-it-works.md) 里的流水线分层。

本篇覆盖：
1. **External rescue hook** — 接外部模型补 fallback chunks
2. **Sparse retry workflow** — 只重译失败的 chunks
3. **Translation Memory** — 跨文档复用
4. **接到 MCP 客户端** — Claude Desktop 等

---

## 1. External rescue hook（PR #110）

### 1.1 什么时候要用

跑完一遍长文，看到 stderr 有几行：

```
Chunk 30/134 (JT AND LINDY): soft-gate caught chunk failure (...); falling back to source content.
```

意思是这一段实在翻不出来，pipeline 保留了英文段。

如果你**不想**保留英文段——希望这一段也是中文——有两条路：

- **手工**：[`docs/01`](01-getting-started.md) 已演示
- **自动**：external rescue hook（本节）

### 1.2 设计契约

pipeline 在 codex 内置 rescue 也失败之后、soft-gate fallback 之前，调用你指定的 shell 命令：

```
pipeline                            user command
─────────                            ────────────
启动 /bin/sh -c "$MDZH_FINAL_RESCUE_COMMAND"
  │
  └── stdin: 英文 source（带 @@MDZH_*@@ 占位符）
                                     │
                                     ├── 你写啥都行：
                                     │   - 调 Claude API
                                     │   - 调 GPT-5（不通过 codex）
                                     │   - 句子级拆分
                                     │   - 发 Slack 给译者
                                     │
                                     └── stdout: 中文译文
  │
  └── 收到 stdout
       │
       └── 校验：
           ✓ 段落数（按空行切）= source 段落数
           ✓ placeholder 数（@@MDZH_*@@）= source 数
           ✓ 至少 1 个中文字符
           │
           ├─ 通过 → 用 stdout 替换 chunk body
           └─ 失败 → soft-gate fallback to source（跟没启用 hook 一样）
```

### 1.3 从零开始写一个 hook

**Step 1：理解 stdin 长什么样**

stdin 是 protected 后的 source，举个例子：

```markdown
## How To Win At Chess

In April 2000, three years after Steve Jobs returned to Apple, he invited @@MDZH_LINK_DESTINATION_0042@@ Art Levinson to join his new board of directors.

@@MDZH_IMAGE_DESTINATION_0008@@

The well-told story of Jobs's return to Apple...
```

`@@MDZH_LINK_DESTINATION_0042@@` 等是占位符。你的命令**必须保留这些占位符不动**——pipeline 会在事后还原。

**Step 2：最小验证 hook**（无依赖）

`echo-cn.sh`：

```bash
#!/usr/bin/env bash
# 只验证 hook 被调用了。把英文 source 加上"[未翻译]"前缀返回。
# 实际生产中这个 hook 会因为没有中文字符而被 pipeline 拒绝，
# 但能让你看到 telemetry 里有 chunk.final_rescue.start / .end 事件。
SOURCE=$(cat)
echo "[未翻译]"
echo "$SOURCE"
```

```bash
chmod +x echo-cn.sh
export MDZH_FINAL_RESCUE_COMMAND="$(pwd)/echo-cn.sh"
md-zh-translate --input book.md --output book.zh.md

# 看 telemetry 验证
grep '"type":"chunk.final_rescue.end"' $MDZH_TELEMETRY_PATH | jq '.meta.success'
# false → hook 被调用了但被 validation 拒绝（因为没有真翻译）
```

**Step 3：接 Claude API**

`claude-translate.sh`（需要 `ANTHROPIC_API_KEY`，需要 `curl` 和 `jq`）：

```bash
#!/usr/bin/env bash
set -e

if [[ -z "$ANTHROPIC_API_KEY" ]]; then
  echo "ANTHROPIC_API_KEY not set" >&2
  exit 1
fi

SOURCE=$(cat)

# 注意 prompt 里强调三件事：保段落数 / 保占位符 / 输出中文
RESPONSE=$(curl -s https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "$(jq -n --arg src "$SOURCE" '{
    model: "claude-opus-4-7",
    max_tokens: 16000,
    messages: [{
      role: "user",
      content: ($src + "\n\n请把上面的英文 Markdown 翻译成中文。要求：\n1. 段落数与原文严格一致（按空行分隔的块数相同）\n2. @@MDZH_*@@ 形式的占位符原样保留，不要翻译、不要改\n3. 代码块原样保留，不要翻译代码本身\n4. 首次出现的人名 / 专有名词加中英对照（如：林德伯格（Lindbergh））\n5. 只输出译文，不要写任何说明或前后缀")
    }]
  }')") || exit 2

# 抽取 text 内容
echo "$RESPONSE" | jq -r '.content[0].text'
```

```bash
chmod +x claude-translate.sh
export ANTHROPIC_API_KEY=sk-ant-...
export MDZH_FINAL_RESCUE_COMMAND="$(pwd)/claude-translate.sh"
md-zh-translate --input loonshots.md --output loonshots.zh.md
```

**Step 4：进阶——拆句重译策略**

如果整段一次翻反复失败，可以按句拆开：

```bash
#!/usr/bin/env bash
# sentence-split-translate.sh
# 思路：把 source 按 \n\n 切成块，每块按句号 . 切成句子，逐句翻译再拼回。
# 单句 prompt 短，模型不容易在长段重复 / 错位。

SOURCE=$(cat)
OUTPUT=""
while IFS= read -r block; do
  if [[ -z "$block" ]]; then
    OUTPUT+="$'\n'"
    continue
  fi
  # 这一块逐句翻译（伪代码）
  TRANSLATED=$(echo "$block" | translate-sentence-by-sentence-script)
  OUTPUT+="$TRANSLATED"$'\n'
done <<< "$SOURCE"

echo "$OUTPUT"
```

具体实现因你的 LLM API 而异，但思路是：**把模型最容易犯错的"长段记不住"问题，通过拆小输入避开**。

### 1.4 调试 hook

看 telemetry 里 hook 状态：

```bash
grep 'final_rescue' $MDZH_TELEMETRY_PATH | jq '{type, chunkId, success: .meta.success, error}'
```

常见 `success: false` 原因：

| 错误信息 | 含义 | 修法 |
|---|---|---|
| `paragraph count mismatch` | hook 改了段落数 | prompt 强调"段落数严格一致"；或 hook 内部按 `\n\n` 计数对齐 |
| `protected placeholder count mismatch` | hook 把 `@@MDZH_*@@` 改了或丢了 | prompt 强调占位符原样保留；或 hook 内部正则替换前先转义 |
| `rescue output contains no Chinese characters` | hook 输出了英文（没翻译 / echo 了 source） | 检查 hook 的 LLM prompt 实际有没让它翻译 |
| `command exited non-zero` | hook 内部错误 | 看 hook 的 stderr |
| `command timed out` | 超过 `MDZH_FINAL_RESCUE_TIMEOUT_MS` | 调大超时或优化 hook 性能 |

### 1.5 跟内置 rescue 的区别

| 维度 | 内置 rescue | external hook |
|---|---|---|
| 模型 | 必须是 codex 内置（gpt-5.5） | 任意（Claude / GPT-5 / 自己拼） |
| 输入 | pipeline 内部组装 prompt | 你完全自由（自己写 prompt） |
| 失败兜底 | external hook → soft-gate | soft-gate |
| 何时触发 | repair × 2 都失败 | rescue 也失败 |

---

## 2. Sparse retry workflow（PR #108）

### 2.1 场景

你跑完一本书，发现有 7 个 chunks 走了 fallback。你启用了 `MDZH_FINAL_RESCUE_COMMAND` 接了 Claude，**只想重跑这 7 个**——不想花 2 小时整本重做。

### 2.2 操作

**Step 1：找到 checkpoint 文件**

```bash
ls $MDZH_CHECKPOINT_DIR
# <hash>.json
```

**Step 2：删除失败 chunks 的 entry**

```bash
python3 << 'EOF'
import json, sys
cp_path = "$MDZH_CHECKPOINT_DIR/<hash>.json"
failed = {'chunk-14', 'chunk-30', 'chunk-54', 'chunk-69', 'chunk-72', 'chunk-91', 'chunk-109'}
with open(cp_path) as f: cp = json.load(f)
cp['completedChunks'] = [c for c in cp['completedChunks'] if c['chunkId'] not in failed]
with open(cp_path, 'w') as f: json.dump(cp, f, ensure_ascii=False)
print(f"checkpoint now has {len(cp['completedChunks'])} chunks")
EOF
```

**Step 3：重跑（不改任何代码）**

```bash
md-zh-translate --input book.md --output book.zh.md
```

stderr 会显示：

```
Resumed translation checkpoint with 127 completed chunk(s) from ...
Skipping chunk-1; restored from checkpoint.
Skipping chunk-2; restored from checkpoint.
...
Chunk 14/134 (ONE AT A TIME), segment 1: starting translation with model gpt-5.4-mini.   ← 只翻这 7 个
```

7 个 chunks 走完一遍 draft → repair → rescue → external hook → soft-gate 整套，~15-20 分钟（vs 整本重跑 ~2 小时）。

### 2.3 注意事项

- **代码改了 / 升级版本** → fingerprint 变 → cache key 变 → 老 checkpoint 不命中
- 这种情况要么吃整本重跑，要么手动改 checkpoint 文件名 + 内部 `cacheKey` 字段（详见 PR #108 commit message）

---

## 3. Translation Memory（跨文档复用）

### 3.1 场景

你要翻一个系列文章 / 一本书的多个章节。后面文章里的术语、片段跟前面重复——希望复用前面的翻译，不再调 LLM。

### 3.2 启用

```bash
export MDZH_TM_PATH=/path/to/series-tm.jsonl

md-zh-translate --input article-1.md --output article-1.zh.md
md-zh-translate --input article-2.md --output article-2.zh.md   # 部分 segment 命中 article-1 的翻译
md-zh-translate --input article-3.md --output article-3.zh.md
```

TM 是 JSONL 文件，每行一条：

```json
{"fingerprint": "<sha1>", "english": "Trippe began...", "chinese": "特里普开始……"}
```

`fingerprint` 是 source segment 的 SHA1（带规范化：去尾空格、统一行尾）。

### 3.3 命中率与质量

- TM 只在 segment hash 完全一致时命中（小改动 → miss）
- 命中跳过 draft 但**仍跑 audit**——保证术语一致性 / 占位符完整性
- 每个 chunk 完成后，pipeline 把 hardPass=true 的 segment 写入 TM（hardPass=false 不写，避免污染）

### 3.4 多人协作

把 `series-tm.jsonl` 提交到 git 仓库，团队共享：每个人跑都把好结果写进去，下次别人就命中。

---

## 4. 接到 MCP 客户端

`md-zh-translation-skill` 提供 MCP server 模式，能接到任何支持 MCP 协议的客户端（Claude Desktop / Cursor / 自家 IDE）。

### 4.1 一键安装

```bash
md-zh-translate install claude-desktop      # 写入 ~/.claude/claude_desktop_config.json
md-zh-translate install codex               # 写入 ~/.codex/skills/...
md-zh-translate install claude-code         # 写入 ~/.claude/agents/...
md-zh-translate install all                 # 全装
```

### 4.2 自定义 MCP 客户端

```bash
md-zh-translate mcp-config
```

输出一段 JSON，照着塞进客户端的 MCP 配置：

```json
{
  "mcpServers": {
    "md-zh-translate": {
      "command": "md-zh-translate-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

### 4.3 在客户端里调用

接好后，在 Claude Desktop / Cursor 里直接说：

> 帮我把 ~/Downloads/article.md 翻译成中文，输出到同目录 article.zh.md

客户端会自动调用 `md-zh-translate` 工具完成。

---

## 下一步

- 想理解为什么这些机制这么设计？→ [`06-design-rationale.md`](06-design-rationale.md)
- 想改代码 / 贡献？→ [`internals/`](internals/)
