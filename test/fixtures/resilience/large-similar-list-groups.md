---
title: "large section with multiple similar list groups (chunks 9/12/13 cluster)"
notes:
  - failure: chunk 撞「末尾凭空补 N 条 bullets，模型在多个相似列表组之间走神」
  - hypothesis: chunk size + similar list patterns → 模型注意力漂移，把前面的列表项再吐一遍
  - root-cause-direction:
      - smaller segment（按相似列表组数阈值切）
      - JSON-blocks lane 强制路由（每条 bullet 一个 block，没有自由发挥空间）
  - source: spec-driven-development §The Tools That Make Spec-Driven Development Easy
---
## The Tools That Make Spec-Driven Development Easy

To make this work, you need the right tools:

**1. Spec Kit (Open Source)**

The tool that made this possible is Spec Kit, an open-source framework that gives you templates and best practices for writing specifications.

It provides:

- Templates for specifications

- Checklists for completeness

- Examples from real projects

- Integration with GitHub (specs live in your repo)

**2. GitHub Issues With Specs**

Instead of keeping specifications in Google Docs, store them in your GitHub repo:

This way:

- Specs are version-controlled

- Linked to code that implements them

- Every PR references a spec

- Nothing gets lost

**3. TypeScript For Contracts**

From the specification, generate TypeScript types:

The specification becomes your type definitions. The code implements these types. No disconnects.
