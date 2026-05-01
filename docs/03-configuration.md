# 配置参考

所有可调的环境变量，按**你想做什么**分组（不是字母排序）。

读完前需要先理解 [02 § 流水线全貌](02-how-it-works.md#3-流水线全貌)——里面提到的 chunk / segment / repair / rescue / soft-gate 是这里参数的目标。

---

## 1. 模型选择

### `TRANSLATION_MODEL`
**作用**：覆盖初始 draft 阶段用的模型。
**默认**：`gpt-5.4-mini`
**何时改**：很少。mini 已经被验证是 draft 阶段成本/速度/质量的最优解。
**改的代价**：换更强的模型（如 `gpt-5.5`）会让 draft 命中率更高但成本翻倍、速度减半。

```bash
export TRANSLATION_MODEL=gpt-5.5
```

### `POST_DRAFT_MODEL`
**作用**：覆盖 audit 阶段用的模型。
**默认**：跟 `TRANSLATION_MODEL` 相同（即 mini）
**何时改**：罕见。

### `MDZH_REPAIR_MODEL`
**作用**：覆盖 repair stage（带 audit must_fix 指令重做）的模型。
**默认**：`gpt-5.5`（PR #105 升的——repair 带精确指令的强模型命中率高）
**禁用回退**：`MDZH_REPAIR_MODEL=off`（会回到 post-draft model，即 mini）

```bash
export MDZH_REPAIR_MODEL=gpt-5.5    # 默认
export MDZH_REPAIR_MODEL=off         # 退回到 mini（省钱但 repair 命中率降）
```

### `MDZH_RESCUE_MODEL`
**作用**：覆盖整 chunk rescue 阶段的模型。
**默认**：`gpt-5.5`
**禁用**：`off` / `none` / `false` / `0` / 空字符串

```bash
export MDZH_RESCUE_MODEL=gpt-5.5     # 默认
export MDZH_RESCUE_MODEL=off          # 禁用 rescue（直接进 soft-gate）
```

### `MDZH_FINAL_RESCUE_COMMAND`（PR #110）
**作用**：在所有 codex 内置层都失败后、soft-gate fallback 之前，调用用户指定的 shell 命令做最后一搏。
**默认**：未设置（不启用）
**契约**：命令通过 `/bin/sh -c` 启动，protectedSource 写到 stdin，stdout 是中文译文。

```bash
export MDZH_FINAL_RESCUE_COMMAND="claude-translate.sh"
```

详见 [`05-advanced.md` § external rescue hook](05-advanced.md)。

### `MDZH_FINAL_RESCUE_TIMEOUT_MS`
**作用**：external rescue 命令的超时（毫秒）。
**默认**：`600000`（10 分钟）
**何时改**：你的 hook 调外部 API、单次响应可能超过 10 分钟时调大。

---

## 2. 性能（速度 + 成本）

### `MDZH_CHUNK_CONCURRENCY`
**作用**：同时翻译几个 chunk。
**默认**：`3`
**范围**：1-8
**取舍**：
- 调到 1 → 完全串行，保证日志可读、便于诊断
- 默认 3 → 实测 1.88× 加速、不会撞 codex API rate limit
- 调到 5+ → 速度再涨 20%，但 rate limit 报错概率上升

```bash
export MDZH_CHUNK_CONCURRENCY=1       # 调试用
export MDZH_CHUNK_CONCURRENCY=5       # 极速模式（看你的 codex 配额）
```

### `MDZH_TM_PATH`
**作用**：Translation Memory 文件路径（JSONL 格式）。同 segment hash 命中 → 跳过 LLM 调用直接复用。
**默认**：未设置（不启用 TM）

```bash
export MDZH_TM_PATH=/path/to/loonshots-tm.jsonl
md-zh-translate --input book1.md --output book1.zh.md
md-zh-translate --input book2.md --output book2.zh.md
# book2 跟 book1 共享术语段落 → 部分 segment 直接命中
```

详见 [`05-advanced.md` § Translation Memory](05-advanced.md)。

### `MDZH_REPAIR_PATCH_LANE`
**作用**：repair 阶段的 patch 优化。当 audit 给出 structured `repair_targets`（具体哪段哪行替换什么）时，pipeline 用纯字符串替换跳过 LLM 调用。
**默认**：`true`（启用）
**禁用**：`MDZH_REPAIR_PATCH_LANE=false`
**何时关**：调试 patch lane 是否吃掉了不该吃的 audit case 时。

---

## 3. 缓存与续译

### `MDZH_ANALYSIS_CACHE_DIR`
**作用**：缓存 anchor catalog 发现结果。命中时跳过 30+ 分钟的 analysis 阶段。
**默认**：未设置（每次 run 重做 analysis）
**cache key**：源文哈希 + 实现指纹（代码改了自动失效）

```bash
export MDZH_ANALYSIS_CACHE_DIR=/tmp/mdzh-analysis-cache
```

### `MDZH_CHECKPOINT_DIR`
**作用**：每完成一个 chunk 写入 checkpoint。中途崩溃可断点续译。
**默认**：未设置（不写 checkpoint）

```bash
export MDZH_CHECKPOINT_DIR=/tmp/mdzh-checkpoint
md-zh-translate --input book.md --output book.zh.md
# Ctrl+C 中断
md-zh-translate --input book.md --output book.zh.md   # 已完成的 chunks 自动跳过
```

PR #108 后支持 **sparse checkpoint**——手动从 checkpoint 文件删几个 chunk entry，重跑只翻这几个：

```bash
# 删除 chunk-14, chunk-30 的 entry
python3 -c "
import json
with open('/tmp/mdzh-checkpoint/<key>.json') as f: cp = json.load(f)
cp['completedChunks'] = [c for c in cp['completedChunks']
                          if c['chunkId'] not in {'chunk-14','chunk-30'}]
with open('/tmp/mdzh-checkpoint/<key>.json', 'w') as f: json.dump(cp, f)
"
# 重跑——sparse 路径生效，仅翻 14/30
md-zh-translate --input book.md --output book.zh.md
```

详见 [`05-advanced.md` § Sparse retry workflow](05-advanced.md)。

---

## 4. 调试与可观测

### `MDZH_TELEMETRY_PATH`
**作用**：把流水线的 run / chunk / stage / repair / gate 事件以 JSONL 写到文件。
**默认**：未设置（不写 telemetry）

```bash
export MDZH_TELEMETRY_PATH=/tmp/mdzh-telem.jsonl
md-zh-translate --input book.md --output book.zh.md

# 然后分析
grep '"type":"chunk.error"' /tmp/mdzh-telem.jsonl | jq .
```

事件类型见 `src/telemetry.ts`：
- `run.start` / `run.end`
- `chunk.start` / `chunk.end` / `chunk.error`
- `chunk.rescue.start` / `chunk.rescue.end`
- `chunk.final_rescue.start` / `chunk.final_rescue.end`（PR #110）
- `stage.start` / `stage.end` / `stage.error`
- `gate.result`
- `repair.cycle` / `repair.patch`
- `tm.hit` / `tm.miss` / `tm.write`
- `analysis.shard.start` / `analysis.shard.end`

### `MDZH_DEBUG_IR_PATH`
**作用**：把内部 Intermediate Representation（IR）写到文件。用来调 anchor catalog / heading plan 错配的问题。
**默认**：未设置

---

## 5. 行为开关

### `MDZH_SOFT_GATE`
**作用**：是否允许"翻不好就保留英文段而不让整 run 失败"。
**默认**：CLI 默认 `true`（命令行 `--strict-gate` 反转）
**取舍**：
- `true`：长文友好，整本能跑完，少数段留英文
- `false`：任意 chunk 实在过不了 hard check 就抛 HardGateError 退出码 4

```bash
export MDZH_SOFT_GATE=true              # 长文场景默认
md-zh-translate --strict-gate ...        # 命令行覆盖为严格

export MDZH_SOFT_GATE=false             # 严格场景（CI 质量门）
```

### `MDZH_SMOKE_HARD_GATE`
**作用**：smoke 测试场景下强制 hard gate（覆盖 default soft-gate）。
**默认**：未设置
**何时用**：跑 smoke 想看哪些 chunk 真的过不了 audit。

---

## 6. Codex CLI 自身

### `CODEX_CLI`
**作用**：codex 可执行文件路径。
**默认**：从 PATH 找 `codex`
**何时改**：你装了多个版本 / 在容器里要指向特定路径。

```bash
export CODEX_CLI=/opt/codex/bin/codex
```

---

## 完整组合示例

跑一本 1 MB 的英文书，要求最稳 + 可断点续译 + 写 telemetry：

```bash
export MDZH_CHECKPOINT_DIR=/tmp/mybook-checkpoint
export MDZH_ANALYSIS_CACHE_DIR=/tmp/mybook-analysis-cache
export MDZH_TELEMETRY_PATH=/tmp/mybook-telem.jsonl
export MDZH_TM_PATH=/tmp/mybook-tm.jsonl
export MDZH_CHUNK_CONCURRENCY=3
export MDZH_FINAL_RESCUE_COMMAND="claude-translate.sh"   # 见 05-advanced

md-zh-translate --input mybook.md --output mybook.zh.md
```

中断后接着跑同样命令——会跳过已完成 chunks。

---

## 默认值速查表

| 环境变量 | 默认值 |
|---|---|
| `TRANSLATION_MODEL` | `gpt-5.4-mini` |
| `POST_DRAFT_MODEL` | 同 `TRANSLATION_MODEL` |
| `MDZH_REPAIR_MODEL` | `gpt-5.5` |
| `MDZH_RESCUE_MODEL` | `gpt-5.5` |
| `MDZH_FINAL_RESCUE_COMMAND` | （未设置） |
| `MDZH_FINAL_RESCUE_TIMEOUT_MS` | `600000` |
| `MDZH_CHUNK_CONCURRENCY` | `3` |
| `MDZH_REPAIR_PATCH_LANE` | `true` |
| `MDZH_TM_PATH` | （未设置） |
| `MDZH_ANALYSIS_CACHE_DIR` | （未设置） |
| `MDZH_CHECKPOINT_DIR` | （未设置） |
| `MDZH_TELEMETRY_PATH` | （未设置） |
| `MDZH_DEBUG_IR_PATH` | （未设置） |
| `MDZH_SOFT_GATE` | `true`（CLI 默认） |
| `CODEX_CLI` | 从 PATH 找 `codex` |
