# md-zh-translation-skill

把英文 Markdown 文章翻译成中文 Markdown 的 CLI。专门为**长文 + 复杂结构**设计——书、技术博客、API 文档、研究论文都跑得动。

```
英文 Markdown                                            中文 Markdown
─────────────                                            ─────────────
# Loonshots                                              # Loonshots
                                                         
Trippe began discussions with Boeing,    ──translate──>  特里普（Trippe）开始与波音（Boeing）
which was then primarily a builder of                    商谈，当时波音主要还是军用飞机制造商，
military aircraft...                                     ……

[link to docs](https://example.com)                      [文档链接](https://example.com)

```typescript                                            ```typescript
const x = 1;          ← 代码块原样保留                   const x = 1;
```                                                      ```
```

**保结构**：标题、列表、代码块、链接、图片、HTML 一律不动。
**保术语**：人名 / 公司 / 专有概念首次出现时自动加中英文对照。
**保单位**：英寸 / 磅 / 华氏度自动补常见公制换算。
**保完整**：哪怕某段实在翻不好，也保留英文段而不是让整本失败。

---

## 30 秒上手

```bash
# 安装
npm install -g md-zh-translation-skill

# 翻译一篇文章
md-zh-translate --input article.md --output article.zh.md
```

跑起来后 `stderr` 会一行一行显示进度（`Chunk 3/17 segment 1/2: starting translation...`），最终译文写到 `--output` 指定的文件。

---

## 翻译失败如何兜底

每个分块（chunk）按以下顺序逐档下沉，前一档失败才进下一档；只要任一档产出合格中文就停在那里。

| 档位 | 模型 / 入口 | 校验强度 | 默认 |
|---|---|---|---|
| 1. draft | `gpt-5.4-mini` | 完整 audit + 必修项门控 | 开 |
| 2. repair × 2 | 同 draft 模型 | 同上 | 开 |
| 3. 内置 rescue（升模型重译） | `gpt-5.5`，整段 draft+audit+repair 全套 | 完整 audit + 必修项门控 | 开 |
| 4. 默认 final-rescue（**新**） | `gpt-5.5`，**单次直翻、无 audit** | **宽松**：段落数 = 占位符数 = 至少 1 个中文 | 开 |
| 5. 外部 hook | `MDZH_FINAL_RESCUE_COMMAND` 指定的任意命令 | 同第 4 档 | opt-in |
| 6. soft-gate fallback | — | — | 开（最终兜底，保留英文段） |

第 4 档为本地、零配置自动启用：用同一个 `gpt-5.5`，去掉 audit / repair 这些反复挑刺的环节，只对结构（段落数、占位符、含中文）做最小校验。它是给"`gpt-5.5` 其实能翻，但 audit 老在卡"的情况设计的最后一道自动救援，避免直接落到第 6 档保留英文段。

- 关掉第 4 档：`MDZH_DEFAULT_FINAL_RESCUE=off`
- 完整契约和自定义示例：[`docs/05-advanced.md`](docs/05-advanced.md)
- 全部相关环境变量：[`docs/03-configuration.md`](docs/03-configuration.md)

---

## 你接下来想做什么？

不同的入口对应不同的需求：

| 你想…… | 去看 |
|---|---|
| **跑一篇真实文章试试** | [`docs/01-getting-started.md`](docs/01-getting-started.md) |
| **理解它内部到底在做什么** | [`docs/02-how-it-works.md`](docs/02-how-it-works.md) |
| **配置（模型、并发、缓存、超时）** | [`docs/03-configuration.md`](docs/03-configuration.md) |
| **跑出问题了** | [`docs/04-troubleshooting.md`](docs/04-troubleshooting.md) |
| **搞高级玩法**（接外部模型 / 跨文档术语库 / 接 MCP）| [`docs/05-advanced.md`](docs/05-advanced.md) |
| **理解为什么这么设计** | [`docs/06-design-rationale.md`](docs/06-design-rationale.md) |
| **改代码 / 贡献** | [`docs/internals/`](docs/internals/) |

---

## 环境要求

- Node.js `>= 20`（源码开发要 `>= 24.10.0`）
- 已安装并登录 [`codex`](https://github.com/openai/codex) CLI

> 这个工具调用 codex CLI 跟 OpenAI 模型对话。安装好 codex、跑一遍 `codex --help` 能正常输出，就说明前置条件 OK。

---

## 安装到 AI 客户端

如果你想在 Codex CLI / Claude Code / Claude Desktop 里直接调用：

```bash
md-zh-translate install codex          # Codex CLI
md-zh-translate install claude-code    # Claude Code
md-zh-translate install claude-desktop # Claude Desktop（走 MCP）
md-zh-translate install all            # 全部默认目标
```

详见 [`docs/05-advanced.md` § 接到 MCP 客户端](docs/05-advanced.md)。

---

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（即便有 chunk 走了 source-fallback） |
| 2 | 参数错误或没输入 |
| 3 | `codex exec` 执行失败（codex 没装好 / 没登录 / 网络） |
| 4 | 内部硬性门控在修复轮后仍未通过 |
| 5 | Markdown 美化失败 |

---

## 项目状态

- 当前默认翻译模型：`gpt-5.4-mini`，repair / rescue / 默认 final-rescue 升 `gpt-5.5`
- 后处理走 [`@jacobbubu/md-zh-format`](https://www.npmjs.com/package/@jacobbubu/md-zh-format) 美化
- 持续把真实长文失败收编为 fixture，按 §3.3 「接受能力边界」管理（见 [internals/resilience-plan.md](docs/internals/resilience-plan.md)）
