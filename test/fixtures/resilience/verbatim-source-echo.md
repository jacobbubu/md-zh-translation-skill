---
title: "model echoes source verbatim instead of translating (chunk 5 cluster)"
notes:
  - failure: draft 直接把英文原文原样输出，repair 救不回，rescue（gpt-5.5）也 echo
  - error_message: "Repair contract failed after clean retries: draft echoed the source verbatim instead of translating."
  - hypothesis: 模型在某些段落决定「不需要翻译」（可能因为正文以专有名词 / 代码 / 命令为主，或被前面 prompt 的某条规则误触发为「保留原样」）
  - source: spec-driven-development §Real World Example: Building Memory Moments 的小节
  - resilient_directions:
      - JSON-blocks lane 给每个 block 提供更明确的 source / target 映射，避免「整段保留」的歧义
      - draft contract 里加 "整段未翻译"早期检测：在内部重试前先程序判定（已有 isSegmentStillEchoingSource，但只在 audit 阶段触发）→ 草稿阶段也并入
---
**The Bad Way (What I Used To Do)**

Day 1: "Let's start coding!"

Start building a photo upload form.

Day 3: "Wait, do we need AWS S3 or browser storage?"

Refactor everything.

Day 5: "How do we detect faces?"

Research TensorFlow.js vs Face-api.js, restart.

Day 7: "Why is the timeline showing photos from wrong dates?"

Debug date-matching logic.

Result: 2 weeks, 3 major refactors, $2000 wasted on unused AWS resources

**The Good Way (Spec-Driven)**

Instead, I spent 2 hours writing a specification that looked like this:
