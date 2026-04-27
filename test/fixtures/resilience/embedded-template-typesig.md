---
title: "embedded markdown template + type signature in body (chunk 7 cluster)"
notes:
  - failure: 模型把正文里嵌入的 `string` / `boolean` / 字段名 翻译成中文
  - source: spec-driven-development §How To Implement Step-by-Step（Step 1 / Data Model / API Contracts 子段）
  - existing_remedy: PR #94 加 embedded_template_integrity hard check + audit prompt 描述 + draft prompt rule。但这是「症状级补丁」——本质是结构对齐问题的特例
  - resilient_alternative: 结构对齐校验通用化后，这条 hard check 可考虑收编进通用「source 字面段必须保留」校验
---
**Step 1: The Specification Document**

Before any code, create a detailed specification. Here is the exact template I use:

**# [Feature Name] Specification**

**## 1. Overview**

[What does this feature do? 2–3 sentences]

**## 2. User Stories**

[List all user-facing scenarios]

1. User Story 1: User does X and gets Y result

2. User Story 2: User does A and gets B result

**## 3. Technical Architecture**

[Tech stack, database design, API structure]

**## 4. Data Model**

[Exact schemas]

User {

id: string (UUID)

email: string

photos: Photo[]

}

Photo {

id: string

fileName: string

uploadedAt: ISO8601 timestamp

photoTakenAt: ISO8601 timestamp

}

**## 5. API Contracts**

[Exact endpoints and responses]

POST /api/photos/upload

Request: FormData with file

Response: { photoId: string, success: boolean }
