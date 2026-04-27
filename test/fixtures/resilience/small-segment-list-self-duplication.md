---
title: "small-segment list self-duplication (chunks 9 segment 2 in spec5)"
notes:
  - failure: 即使 segment 极小（1 段导语 + 2 条 bullets），模型仍然在末尾追加重复的 2 条 bullets，把列表数变成 4 条
  - source: spec-driven §How To Implement，threshold=2 拆出来的小 segment
  - existing_remedies_did_not_catch:
      - 缩小 segment（PR #97/#98 把 chunk 9 从 2 段拆成 3 段）→ segment 2 已经只有 1 导语 + 2 bullets，仍失败
      - dedupDraftDuplicateTailListItems（PR #95）→ 应能匹配 source 2 / draft 4 的情况，但实测此次未生效；候选原因：duplicate bullets 的译文措辞每次略不同，draftBlocksLookLikeDuplicate 的 55% n-gram 阈值未达
      - rescue 模型 gpt-5.5 → 也同样追加
  - meta_signal: 这是 LLM 在「小 list followed by self」模式上的固有倾向，单纯靠继续缩 segment / 加 dedup 无法根治
  - resilient_direction:
      - resilience plan §3.2 结构骨架对齐：parseStructure 在 source / draft 比对时直接看 list 项数，不依赖文本相似度。source 2 vs draft 4 → 强信号，砍尾 / 报 audit fail
      - 收编后 dedupDraftDuplicateTailListItems / dedupDraftDuplicateTailBlocks / dedupDraftDuplicateTailSentences 可一并删除
---
**Step 5: Code Becomes Implementation, Not Discovery**

When you code from a spec, you are not discovering the design mid-project. You are simply implementing what has already been decided. This means:

- No debates about architecture during coding (already settled in spec)

- No surprise features requested mid-sprint (spec is locked)
