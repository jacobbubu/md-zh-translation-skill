---
title: "protected span placeholder lost or duplicated (chunks 10/11/13 cluster)"
notes:
  - failure: |
      Protected span integrity failed for @@MDZH_LINK_DESTINATION_xxxx@@:
      expected 1 placeholder occurrence, found 2 (duplicated)
      或 found 0（dropped）
  - hypothesis: 模型在长段或列表密集段里把链接或图片整体忽略掉，或在重组时把同一占位符 ID 复制到两个位置
  - source: spec-driven-development §How To Implement / Real Numbers / The Tools 等含 link 或 image 的 section
  - resilient_directions:
      - 占位符计数对齐校验（程序级，验前后总数；不对则触发结构错而非偷偷过）→ 已有 protected_span_integrity，但只检测 audit 报错，未在 draft / dedup 后立即验
      - 缩 segment 让占位符密集段更短
  - related_existing_check: GateAudit.hard_checks.protected_span_integrity（结构性硬错，已升级到 validateStructuralGateChecks）
---
The Memory Moments project is documented at [the project page](https://example.com/memory-moments). Below is a screenshot of the workflow:

![](https://example.com/img-flow.png)

For full details, see [the design document](https://example.com/design-doc). The workflow has three stages:

- Upload
- Process
- Display

Each stage references [its respective design section](https://example.com/design-stages).
