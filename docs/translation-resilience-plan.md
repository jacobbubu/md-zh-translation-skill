# 翻译流水线弹性计划（Resilience Plan）

记录 2026-04-26 ~ 2026-04-27 一轮针对真实长文失败（spec-driven-development、hermes-agent 等）做的修复反思，以及后续从「症状级补丁」转向「根因级改造」的方向、取舍与排序。

阅读边界：
- 想知道「最近为什么连续在打补丁」「为什么要刹车」——读 §1 §2。
- 想知道「下一步具体干什么」——读 §3 §4。
- 想知道「已合的哪些 PR 是过度修复、要不要回收」——读 §5。

## 1. 我们最近发生了什么

`docs/translation-architecture-calibration-2026-04-25.md` 之后陆续完成了 Phase 1~4 的提效改造（telemetry、prompt cache 前缀、差分 repair、chunk 并发、TM、列表项约束、rescue 模型）。然后转入对真实长文的稳定性补强：

| 时间 | 触发事件 | 应对 PR | 性质 |
|------|------|------|------|
| spec-driven 长文 chunks 4 / 7 撞列表合并 | "列表项数必须严格一致" prompt 收紧 | #91 | 通用规则收紧（合理）|
| spec-driven chunks 7 / 8 / 10 撞类型签名翻译 | embedded_template_integrity 新 hard check | #94 | **症状级补丁**（一类失败 → 一个新 schema 字段 + repair type + audit prompt） |
| spec-driven chunks 9 / 12 / 14 撞列表尾部重复追加 | dedupDraftDuplicateTailListItems 新函数 | #95 | **症状级补丁**（一类尾部去重 → 一个新函数 + prompt 第 9 条） |
| spec-driven chunk 13 / 14 仍撞列表+收束句联合重复 | 准备加 multi-block tail dedup（已止住） | — | **过度修复风险点** |

观察到的趋势：每来一类失败就加一条 bespoke 修复。即使每条单独看都「干净、有测试、是真实改善」，叠在一起就是经典的 whack-a-mole 反模式——失败模式的 long tail 是无穷的。

## 2. 为什么要刹车

`docs/translation-architecture-current.md` 自己已经写过约束：

> 不做文章白名单/黑名单 / 不做站点特判 / 不为单篇样本写专门逻辑 / 只做通用规则修复

最近几条 fix 的特征：
- 都直接对应一篇文章的 N 个失败 chunks
- 都加了「专属」机制（hard check / 函数 / prompt 条款）
- 都不容易被未来的同类（但不完全一样）失败模式复用
- 复盘 spec-driven 第三次 run，从 11/17 → 15/17，但仍剩 2 个结构致命 + chunk 5 verbatim echo + chunk 7/9 audit 超时——**"再加一条 patch" 已经不再带来同等的进步**

## 3. 三个根因方向（按 leverage 从大到小）

### 3.1 缩小 segment + 强制 JSON-blocks lane

**观察**：失败 chunks 几乎全是「大段 + 多组相似列表」。chunk 越大 + 重复模式越多，模型在尾部「凑齐」「补全」的概率越高。

**做法**：
- `shouldSplitPendingByComplexity` 的复杂度指标增加「连续相似列表组数」维度。N ≥ 3 强制拆 segment。
- list-密集 / template-密集的 segment **强制走 JSON-blocks lane**（已存在但当前只对孤立列表块路由）。每个 block 一个槽位，模型没有自由发挥空间，从根上消除「往末尾追加」的机会。

**收益**：
- 直接消除「列表合并 / 列表尾部重复 / bullets+summary 联合重复」一整大类失败
- 同时降低单 segment LLM 调用的复杂度，间接提速 + 降本

**代价**：
- 需要扩 `classifyStructuralSegmentDraftStrategy` 的判定逻辑
- 重新跑长文 smoke 验证 JSON-blocks 路径在更大输入上的稳定性

### 3.2 结构骨架对齐校验（取代多个具体 dedup）

**观察**：现在有 3 个 tail dedup 函数（blocks / sentences / list items），都是「特定结构的去重」，互相不知道彼此存在。每来一种新模式就加一个。

**做法**：合并为一个**结构骨架对比器**（伪代码）：

```ts
type StructuralSkeleton = ReadonlyArray<
  | { kind: "para"; charLen: number }
  | { kind: "list"; itemCount: number; ordered: boolean }
  | { kind: "code"; lang: string | null; lineCount: number }
  | { kind: "blockquote"; charLen: number }
  | { kind: "heading"; level: number }
>;

function parseStructure(text: string): StructuralSkeleton;
function alignSkeletons(source: StructuralSkeleton, draft: StructuralSkeleton):
  | { kind: "match" }
  | { kind: "draft-extra-tail"; extraBlocks: StructuralSkeleton }
  | { kind: "draft-missing-tail"; missingBlocks: StructuralSkeleton }
  | { kind: "shape-divergence"; firstDivergenceAt: number };
```

之后：
- `extraBlocks` 全是 source 已经出现过的形状 → 砍掉
- `missing-tail` 或 `shape-divergence` → 进 audit 自动报 paragraph_match=false

**收益**：
- 一个函数覆盖 list-tail / block-tail / sentence-tail / list+summary 联合 / 段落数错位 / 列表项数错位 全部
- 删掉 `dedupDraftDuplicateTailBlocks` / `dedupDraftDuplicateTailSentences` / `dedupDraftDuplicateTailListItems` 三个老函数（共 200+ 行 + 它们的辅助函数）
- 后续新失败模式不需要新函数，扩 `parseStructure` 的语法表即可

**代价**：
- `parseStructure` 要稳定处理 commonmark + GFM 子集（lists / blockquotes / fenced code / headings），用 markdown-it / unified 之类成熟解析器
- 现有 3 个函数的单元测试要迁移成新函数的测试

### 3.3 接受能力边界 + 失败收编为 fixture

**观察**：spec-driven 长文里 chunk 5（模型 echo source verbatim）、chunks 7/9（audit 超时）即便 rescue 用 gpt-5.5 也救不回来。这是当前模型 + 当前 prompt 形态下的能力边界。

**做法**：
- 失败 chunk 走 soft-gate fallback（保留英文原文，已实现）
- **同时**把失败的最小 segment 抽成 `test/fixtures/resilience/` 下的 fixture，记录失败模式 + hypothesis + 现有 remedy 是否够用
- 周期性回看：新模型版本（5.5、5.6、…）能否通过这些 fixture，决定何时升级默认 / 何时收掉 bespoke patch

**收益**：
- 不再为每个 long-tail 失败立即"修死"
- fixture 库本身成为系统能力的边界文档，对未来回归可量化

**代价**：
- 不直接修任何当前失败
- 需要约束自己「不为 fixture 立即开 PR」

## 4. 推荐执行顺序

不要平行做。一次一个。

1. **本 PR**（已开始）：fixtures 落库 + 这份设计文档。**不动 src/**。让方向先沉淀下来，避免又一次"边写代码边改方向"。
2. **下一个 PR**（推荐方向 3.1）：复杂度指标加列表组维度 + JSON-blocks lane 强制路由。**单一改动，单一目标**：让 chunks 9 / 12 / 13 / 14 那些 fixture 在 short smoke 里通过率上升 ≥ 1 档。
3. **再下一个 PR**（推荐方向 3.2）：结构骨架对齐校验。同时**清理**老 dedup 函数（验证完后删）。
4. **观察期**（不做新功能）：跑两三轮真实长文 smoke，看 long-tail 失败分布是否变了；如果是同类问题反复出现，回看 §3.1/3.2 是否真到位；如果是新模式，先加 fixture，不要立即写代码。

## 5. 已合并 PR 的处置建议

| PR | 内容 | 是否过度修复 | 处置 |
|------|------|------|------|
| #91 | 列表项约束 prompt + chunk-level rescue | 否（通用规则 + 通用兜底） | 保留 |
| #94 | embedded_template_integrity hard check | **是**——把「类型签名/伪 markdown 字面保留」做成新 hard check 字段 + RepairFailureType 枚举 + audit/draft prompt 描述。这是「源文字面段必须保留」更大类的特例 | 短期保留（已合且实测有效），但 §3.2 的结构对齐校验上线后**收编**进通用机制，删 hard check 字段 |
| #95 | dedupDraftDuplicateTailListItems + prompt 第 9 条 | 灰色——函数本身是干净的纯函数，但和 #blocks / #sentences 三选一是同一类局部 patch | §3.2 上线后 **替换**（连同老两个 dedup 函数一起合并进结构对齐器） |

这是「先扩再收」的取舍：当下 #94 / #95 是真实改善，先享受；等通用机制上来后回收，让代码体量回落。

## 6. 不在本计划范围内的事

- 模型升级（gpt-5.5 → 更新版本）：等 codex CLI 跟上即可，不写代码
- TM 跨 doc 命中、fuzzy match：Phase 4 v1 已落地够用，等 v1 在生产积累足量数据再说
- analysis 的并行化：21 shards 串行是真实瓶颈但与本轮主题无关
- 列表 token 级 streaming / 部分 chunk 续译：观察期之后再判断
