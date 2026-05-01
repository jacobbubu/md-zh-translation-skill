# Internals

这个目录里的文档是**给改代码的人**看的，不是上手文档。

如果你是新用户想用这个工具，请去：

- [`README.md`](../../README.md) — 入口（5 分钟读完）
- [`docs/01-getting-started.md`](../01-getting-started.md) — 入门教程
- [`docs/02-how-it-works.md`](../02-how-it-works.md) — 透彻讲原理
- [`docs/03-configuration.md`](../03-configuration.md) — 环境变量全表
- [`docs/04-troubleshooting.md`](../04-troubleshooting.md) — 常见问题
- [`docs/05-advanced.md`](../05-advanced.md) — 高级用法

---

## 这里有什么

| 文档 | 用途 | 何时看 |
|---|---|---|
| [architecture-current.md](architecture-current.md) | 系统当前态快照 | 想了解整体架构 |
| [pipeline-deep-dive.md](pipeline-deep-dive.md) | 流水线每一阶段的代码级深读（1000+ 行） | 改 `translate.ts` 之前 |
| [system-design.md](system-design.md) | 设计源流：为什么走到现在 | 想理解"为什么这么写" |
| [resilience-plan.md](resilience-plan.md) | 容错机制的演进史（PR #91-#110） | 改 audit / repair / rescue 之前 |
| [known-entities-governance.md](known-entities-governance.md) | 术语表（known_entities.json）的收编准则 | 加术语之前 |
| [architecture-calibration-2026-04-25.md](architecture-calibration-2026-04-25.md) | 2026-04-25 那一轮架构校准 | 历史归档 |
| [handoff-memo.md](handoff-memo.md) | 之前一轮交接备忘录 | 历史归档 |

## 阅读路径

**第一次接触这个 codebase**：
1. 先读 [`docs/02-how-it-works.md`](../02-how-it-works.md) 理解整体（用户视角）
2. 然后读 [`system-design.md`](system-design.md) 理解为什么这么设计
3. 改具体代码前再读 [`pipeline-deep-dive.md`](pipeline-deep-dive.md) 对应章节

**修 bug / 加 feature**：
- audit / repair / rescue 相关 → [`resilience-plan.md`](resilience-plan.md)
- chunk 切分 / segment 边界 → [`pipeline-deep-dive.md`](pipeline-deep-dive.md) §3
- anchor / 术语 → [`known-entities-governance.md`](known-entities-governance.md)

**理解一段历史决策**：
- [`architecture-calibration-2026-04-25.md`](architecture-calibration-2026-04-25.md) / [`handoff-memo.md`](handoff-memo.md) 是历史快照
