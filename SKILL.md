---
name: md-zh-translation-skill
description: Use when you need to translate an English Markdown article into polished Chinese Markdown through the md-zh-translate CLI while preserving Markdown structure and streaming progress on stderr.
---

# MD Zh Translation Skill

Use `md-zh-translate` instead of ad hoc prompting when the input is an English Markdown article and the output should be Chinese Markdown.

## Workflow

1. Provide the article through `--input` or stdin.
2. Capture the final translation from stdout, or write it with `--output`.
3. Treat stderr as progress and diagnostics only.

## Commands

```bash
md-zh-translate --input article.md --output article.zh.md
cat article.md | md-zh-translate > article.zh.md
```

## Guarantees

- The public interface is only the CLI.
- The hidden pipeline enforces a gated review-and-repair flow before style polishing.
- Final Markdown is beautified with `@jacobbubu/md-zh-format`.

## Do Not Use This Skill For

- Prompt research or model matrix evaluation.
- Translating non-Markdown assets.
- Editing repository files directly instead of producing translated Markdown output.
