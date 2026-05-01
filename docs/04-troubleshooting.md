# 常见问题排查

按**症状**索引，三段式：症状 → 诊断 → 修法。

---

## 症状 1：译文里有英文段

**例**：跑完 .zh.md，发现某些段落（甚至整节）是英文。

**诊断**：
1. 退出码 0 还是非 0？
   - 退出码 0：是 soft-gate fallback to source（**设计行为**，详见 [02 § soft-gate](02-how-it-works.md#28-soft-gate-fallback-to-source)）
   - 退出码 4：硬性失败，整 run 没完
2. 看 stderr 是否有：`soft-gate caught chunk failure (...); falling back to source content.`
   - 有 → 确认是 soft-gate fallback
3. 看 telemetry：
   ```bash
   grep '"type":"chunk.error"' $MDZH_TELEMETRY_PATH | jq '.chunkId'
   ```
   列出哪些 chunk 走了 fallback。

**修法**：
- **小问题**（比如 1-2 段）：手工 Edit 这几段——找到英文段、自己译、替换
- **稳定的 fallback 集合**（多次重跑都是同样几个）：启用 [external rescue hook](05-advanced.md) 接更强的外部模型（Claude Opus 等）
- **CI 质量门要求 0 fallback**：`MDZH_SOFT_GATE=false`，让任一失败抛错退出码 4——你能立即看到哪 chunk 出问题

---

## 症状 2：codex 超时 / 失败

**例**：stderr 出现 `Codex exec timed out after 120000ms` 或 `codex exec failed with exit code N`。

**诊断**：
1. codex 装好了吗？
   ```bash
   codex --help              # 应该出帮助
   which codex                # 应该有路径
   ```
2. codex 登录了吗？
   ```bash
   codex auth status          # 检查登录状态
   ```
3. 网络 / API 配额：
   - 偶尔 1-2 次超时 → 可能是 OpenAI API 偶发慢，pipeline 会自动 retry / rescue
   - 大量超时（> 30% chunks）→ 网络问题或配额问题
4. codex 版本：
   ```bash
   codex --version            # 跟 README 期望的版本对一下
   ```

**修法**：
- 偶发 → 不用动，soft-gate 会接住
- 频繁 → 检查网络、换网络环境、确认 OpenAI 账户配额
- codex 版本旧 → 升级 codex CLI

---

## 症状 3：段落数对不上 / 首现术语缺英文 / placeholder 错乱

**例**：audit 反复报 `paragraph_match` / `first_mention_bilingual` / `protected_span_integrity` 失败。

**诊断**：
1. 看 telemetry 找具体失败原因：
   ```bash
   grep '"type":"gate.result"' $MDZH_TELEMETRY_PATH | jq 'select(.meta.hardPass==false)'
   ```
2. 看 chunk source 有没有特殊结构：
   - 嵌入式伪代码（如 `**## 1. Overview**` 这种 bold 包裹的伪标题）
   - 大量重复段落或列表
   - 密集的引用块 / 占位符

**修法**：
- 这通常是模型在特定形态上的能力天花板（详见 [02 § 5 为什么会有 fallback](02-how-it-works.md#5-为什么会有-fallback-chunks重要)）
- soft-gate 会接管，整体可读
- 如果想要这一段也是中文 → external rescue hook 或手工

---

## 症状 4：翻译太慢

**例**：1 MB 的书跑了 2 小时还没完。

**诊断**：
1. 看 telemetry 哪些 chunks 在 rescue：
   ```bash
   grep '"type":"chunk.rescue.start"' $MDZH_TELEMETRY_PATH | wc -l
   ```
2. 大量 rescue → repair 没修好，频繁 fall through 到 rescue（昂贵）
3. 单个 chunk 反复 cycle → 模型在某段持续幻觉

**修法**：
- 提高并发：`MDZH_CHUNK_CONCURRENCY=5`（如果 codex 配额够）
- 启用 TM：`MDZH_TM_PATH=...` 让重复段落跳过 LLM
- 启用 analysis cache：`MDZH_ANALYSIS_CACHE_DIR=...`（重跑省 30 min）
- 实在慢 → 接受先跑完拿到结果，差的几段事后修

---

## 症状 5：跑出来的中文质量差 / 术语不一致

**例**：同一个人名前后译法不同，或者技术术语翻得很怪。

**诊断**：
1. 这个术语在 anchor catalog 里吗？
   ```bash
   # 看 analysis cache 里有没有
   cat $MDZH_ANALYSIS_CACHE_DIR/*.json | jq '.catalog.anchors[] | select(.english | contains("XXX"))'
   ```
2. 如果 catalog 没识别到这个术语，整篇就没强制约束

**修法**：
- 把术语加进 [`src/data/known_entities.json`](../src/data/known_entities.json)（详见 [internals/known-entities-governance.md](internals/known-entities-governance.md)）
- 重跑（cache 会因为 known_entities 变化失效，重做 analysis）

---

## 症状 6：中途崩溃 / 想中断重跑

**例**：跑了 100 chunks 突然电脑重启，或者想停下来明天接着跑。

**诊断**：
- 是否启用了 checkpoint？
  ```bash
  echo $MDZH_CHECKPOINT_DIR
  ls $MDZH_CHECKPOINT_DIR     # 应该有 <key>.json
  ```

**修法**：
- 启用了 checkpoint → 直接重跑同样命令，已完成 chunks 自动跳过
- 没启用 → 这次只能从头跑；下次养成习惯：

  ```bash
  export MDZH_CHECKPOINT_DIR=/tmp/mdzh-checkpoint
  export MDZH_ANALYSIS_CACHE_DIR=/tmp/mdzh-analysis-cache
  ```

---

## 症状 7：`md-zh-translate: command not found`

**诊断**：没装好 / 没 link / 不在 PATH。

**修法**：

```bash
# 装的是 npm 包
npm install -g md-zh-translation-skill
which md-zh-translate

# 在源码目录开发
cd md-zh-translation-skill
npm link

# 不想 link，直接用
node dist/src/cli.js --help
```

---

## 症状 8：`提示没有输入内容`

**诊断**：CLI 既没收到 `--input <path>` 也没从 stdin 收到东西。

**修法**：

```bash
# 三种供入方式选一种
md-zh-translate --input article.md --output article.zh.md
md-zh-translate --input article.md > article.zh.md
cat article.md | md-zh-translate > article.zh.md
```

---

## 症状 9：MCP 客户端（Claude Desktop）没把工具识别出来

**诊断**：
1. 安装了吗？
   ```bash
   md-zh-translate install claude-desktop
   ```
2. Claude Desktop 重启了吗？

**修法**：装完 + 重启 Claude Desktop。如果还不行：

```bash
md-zh-translate mcp-config        # 看完整配置 JSON
# 手动塞到 Claude Desktop 的 claude_desktop_config.json
```

---

## 通用诊断技巧

**1. 一定开 telemetry**
```bash
export MDZH_TELEMETRY_PATH=/tmp/mdzh-telem.jsonl
```
出问题 90% 都能从 telemetry 里看出来。

**2. 串行运行便于读 stderr**
```bash
export MDZH_CHUNK_CONCURRENCY=1
```
默认并发 3 时多个 chunk 进度交错，单线程更易读。

**3. 看 checkpoint 状态**
```bash
python3 -c "
import json
cp = json.load(open('$MDZH_CHECKPOINT_DIR/<key>.json'))
for c in cp['completedChunks']:
    audit = c['gateAudit']['hard_checks']
    failed = [k for k, v in audit.items() if not v['pass']]
    if failed: print(f\"{c['chunkId']}: {failed}\")
"
```
快速看哪些 chunk 是 hardPass=false。

**4. 还是不行 → 提 issue**

仓库 issue 时附：
- `md-zh-translate --version` 输出
- `codex --version` 输出
- stderr 完整输出（`2> stderr.log` 然后贴文件）
- telemetry 文件
- 最小可复现的 source markdown 片段
