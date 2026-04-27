---
title: "list+summary tail duplication repro (chunks 13/14 of spec-driven-development)"
notes:
  - failure: chunk 撞「末尾重复追加 N 条 bullet + 重复收束句」
  - source: spec-driven-development-how-to-build-production-ready-apps-10x-faster-in-2026 §When NOT To Use
  - reproduction: 在小段「[导语句 + N bullets + 收束句]」组合上反复跑，模型 ≥ 1 在尾部追加重复 [bullets, summary] 整组
  - existing_remedy_does_not_catch:
      - dedupDraftDuplicateTailBlocks 按空行切块，bullets 与收束之间是否都有空行取决于段落整理时机，按 block 比对漏抓
      - dedupDraftDuplicateTailSentences 按句末标点切句，bullet 行通常没句号
      - dedupDraftDuplicateTailListItems 只识别**纯尾部** bullet 组；尾部是收束句时直接 bail
---
## When NOT To Use Spec-Driven Development

I am not saying this approach is perfect for everything:

**When Spec-Driven Development Works Best:**

- Building new features with known scope

- Team size > 2 people

- Features taking > 1 week to build

- High cost of mistakes (financial apps, healthcare)

- Multiple teams working on same feature

- Requirements are stable

**When It Is Overkill:**

- Quick prototypes (< 1 day)

- One-person solo projects with clear vision

- Highly experimental research projects

- Bug fixes or minor patches

For Memory Moments, it was perfect because:

- 50+ hours of development

- Multiple complex features (face detection, timeline logic, sharing)

- High stake of getting it wrong (users frustrated if timeline broken)
