import test from "node:test";
import assert from "node:assert/strict";

import {
  extractFrontmatter,
  protectMarkdownSpans,
  protectSegmentFormattingSpans,
  reprotectMarkdownSpans,
  restoreMarkdownSpans
} from "../src/markdown-protection.js";
import { HardGateError } from "../src/errors.js";

test("extractFrontmatter preserves a valid YAML frontmatter block exactly", () => {
  const source = `---\ntitle: Hello World\ntags:\n  - ai\n---\n\n# Intro\n\nBody\n`;
  const result = extractFrontmatter(source);

  assert.equal(result.frontmatter, "---\ntitle: Hello World\ntags:\n  - ai\n---\n");
  assert.equal(result.body, "\n# Intro\n\nBody\n");
});

test("extractFrontmatter ignores an unclosed frontmatter block", () => {
  const source = `---\ntitle: Hello World\n# Intro\n\nBody\n`;
  const result = extractFrontmatter(source);

  assert.equal(result.frontmatter, null);
  assert.equal(result.body, source);
});

test("protectMarkdownSpans and restoreMarkdownSpans preserve code, inline code, and link destinations", () => {
  const source = [
    "# Intro",
    "",
    "Use `npm install` before running.",
    "",
    "```ts",
    'const url = "https://example.com";',
    "```",
    "",
    "Read [the docs](https://example.com/docs) and ![diagram](./img/demo.png).",
    ""
  ].join("\n");

  const protectedMarkdown = protectMarkdownSpans(source);

  assert.match(protectedMarkdown.protectedBody, /@@MDZH_CODE_BLOCK_0001@@/);
  assert.match(protectedMarkdown.protectedBody, /@@MDZH_LINK_DESTINATION_0002@@/);
  assert.match(protectedMarkdown.protectedBody, /@@MDZH_IMAGE_DESTINATION_0003@@/);
  assert.match(protectedMarkdown.protectedBody, /`npm install`/);
  assert.doesNotMatch(protectedMarkdown.protectedBody, /https:\/\/example\.com\/docs/);

  const restored = restoreMarkdownSpans(protectedMarkdown.protectedBody, protectedMarkdown.spans);
  assert.equal(restored, source);
});

test("protectMarkdownSpans preserves autolinks, HTML attributes, and raw HTML blocks", () => {
  const source = [
    "Visit <https://example.com/docs> and <mailto:test@example.com>.",
    "",
    '<a href="https://example.com/page" src="/img/demo.png">Example</a>',
    "",
    "<details>",
    "<summary>Keep this raw HTML block untouched</summary>",
    "<p>Even if it contains prose, do not send it into the model.</p>",
    "</details>",
    ""
  ].join("\n");

  const protectedMarkdown = protectMarkdownSpans(source);

  assert.match(protectedMarkdown.protectedBody, /@@MDZH_AUTOLINK_/);
  assert.match(protectedMarkdown.protectedBody, /href="@@MDZH_HTML_ATTRIBUTE_/);
  assert.match(protectedMarkdown.protectedBody, /src="@@MDZH_HTML_ATTRIBUTE_/);
  assert.match(protectedMarkdown.protectedBody, /@@MDZH_HTML_BLOCK_/);
  assert.doesNotMatch(protectedMarkdown.protectedBody, /https:\/\/example\.com\/docs/);
  assert.doesNotMatch(protectedMarkdown.protectedBody, /mailto:test@example\.com/);
  assert.doesNotMatch(protectedMarkdown.protectedBody, /Keep this raw HTML block untouched/);

  const restored = restoreMarkdownSpans(protectedMarkdown.protectedBody, protectedMarkdown.spans);
  assert.equal(restored, source);
});

test("protectMarkdownSpans does not rewrite inline code while still protecting URLs outside it", () => {
  const source = [
    "Keep `~/.ssh/config` and `href=\"https://example.com\"` untouched.",
    "",
    "See [docs](https://example.com/docs) for details.",
    ""
  ].join("\n");

  const protectedMarkdown = protectMarkdownSpans(source);

  assert.match(protectedMarkdown.protectedBody, /`~\/\.ssh\/config`/);
  assert.match(protectedMarkdown.protectedBody, /`href="https:\/\/example\.com"`/);
  assert.match(protectedMarkdown.protectedBody, /@@MDZH_LINK_DESTINATION_0001@@/);

  const restored = restoreMarkdownSpans(protectedMarkdown.protectedBody, protectedMarkdown.spans);
  assert.equal(restored, source);
});

test("restoreMarkdownSpans accepts raw URL-like spans that were expanded back to their original values", () => {
  const source = [
    "Read [the docs](https://example.com/docs) and <https://example.com/guide>.",
    "",
    '<a href="https://example.com/page">Example</a>',
    ""
  ].join("\n");

  const protectedMarkdown = protectMarkdownSpans(source);
  const expanded = protectedMarkdown.protectedBody
    .replace("@@MDZH_LINK_DESTINATION_0001@@", "https://example.com/docs")
    .replace("@@MDZH_AUTOLINK_0002@@", "https://example.com/guide")
    .replace("@@MDZH_HTML_ATTRIBUTE_0003@@", "https://example.com/page");

  const restored = restoreMarkdownSpans(expanded, protectedMarkdown.spans);
  assert.equal(restored, source);
});

test("reprotectMarkdownSpans folds expanded URL-like spans back into placeholders", () => {
  const source = [
    "Read [the docs](https://example.com/docs) and <https://example.com/guide>.",
    "",
    '<a href="https://example.com/page">Example</a>',
    ""
  ].join("\n");

  const protectedMarkdown = protectMarkdownSpans(source);
  const expanded = protectedMarkdown.protectedBody
    .replace("@@MDZH_LINK_DESTINATION_0001@@", "https://example.com/docs")
    .replace("@@MDZH_AUTOLINK_0002@@", "https://example.com/guide")
    .replace("@@MDZH_HTML_ATTRIBUTE_0003@@", "https://example.com/page");

  const reprotected = reprotectMarkdownSpans(expanded, protectedMarkdown.spans);
  assert.equal(reprotected, protectedMarkdown.protectedBody);
});

test("reprotectMarkdownSpans folds expanded link destinations back even when destination formatting changes", () => {
  const source =
    "This is enforced by Linux [bubblewrap ](https://example.com/bubblewrap)or [macOS](https://example.com/macos)* Seatbel*t.\n";

  const protectedMarkdown = protectMarkdownSpans(source);
  const expanded =
    "这由 Linux [bubblewrap（安全隔离组件）]( https://example.com/bubblewrap \"bubblewrap\" ) 或 [macOS（苹果操作系统）](https://example.com/macos ) *Seatbelt（安全框架）* 强制执行。\n";

  const reprotected = reprotectMarkdownSpans(expanded, protectedMarkdown.spans);

  assert.match(reprotected, /\[bubblewrap（安全隔离组件）]\( @@MDZH_LINK_DESTINATION_0001@@ "bubblewrap" \)/);
  assert.match(reprotected, /\[macOS（苹果操作系统）]\(@@MDZH_LINK_DESTINATION_0002@@ \)/);
  assert.equal(restoreMarkdownSpans(reprotected, protectedMarkdown.spans), expanded);
});

test("reprotectMarkdownSpans rebuilds a missing markdown link destination from the original label text", () => {
  const spans = [
    {
      id: "@@MDZH_LINK_DESTINATION_0001@@",
      kind: "link_destination" as const,
      raw: "https://example.com/bubblewrap",
      labelText: "bubblewrap "
    },
    {
      id: "@@MDZH_LINK_DESTINATION_0002@@",
      kind: "link_destination" as const,
      raw: "https://example.com/macos",
      labelText: "macOS"
    }
  ];

  const translated = "这由 Linux bubblewrap（安全隔离组件）或 macOS（苹果操作系统）强制执行。";
  const reprotected = reprotectMarkdownSpans(translated, spans);

  assert.match(
    reprotected,
    /\[bubblewrap（安全隔离组件）]\(@@MDZH_LINK_DESTINATION_0001@@\)或 \[macOS（苹果操作系统）]\(@@MDZH_LINK_DESTINATION_0002@@\)/
  );
  assert.equal(
    restoreMarkdownSpans(reprotected, spans),
    "这由 Linux [bubblewrap（安全隔离组件）](https://example.com/bubblewrap)或 [macOS（苹果操作系统）](https://example.com/macos)强制执行。"
  );
});

test("restoreMarkdownSpans still rejects code blocks that lost their placeholder", () => {
  const source = [
    "```ts",
    "console.log('hello');",
    "```",
    ""
  ].join("\n");

  const protectedMarkdown = protectMarkdownSpans(source);
  const expanded = protectedMarkdown.protectedBody.replace(
    "@@MDZH_CODE_BLOCK_0001@@",
    "```ts\nconsole.log('hello');\n```"
  );

  assert.throws(
    () => restoreMarkdownSpans(expanded, protectedMarkdown.spans),
    (error: unknown) => {
      assert.ok(error instanceof HardGateError);
      assert.match(error.message, /Protected span integrity failed/);
      return true;
    }
  );
});

test("protectSegmentFormattingSpans keeps inline code visible while still preserving translatable formatting", () => {
  const source = [
    "> Why is this blocked? `~/.bashrc` is sensitive.",
    "",
    "Choose **Deny** for this test.",
    "",
    "**Expected behavior:**",
    ""
  ].join("\n");

  const protectedMarkdown = protectSegmentFormattingSpans(source, 7000);

  assert.match(protectedMarkdown.protectedBody, /`~\/\.bashrc`/);
  assert.match(protectedMarkdown.protectedBody, /\*\*Deny\*\*/);
  assert.match(protectedMarkdown.protectedBody, /\*\*Expected behavior:\*\*/);
  assert.equal(restoreMarkdownSpans(protectedMarkdown.protectedBody, protectedMarkdown.spans), source);
});

test("protectSegmentFormattingSpans keeps inline markdown links visible around protected destinations", () => {
  const source = [
    "This is enforced by Linux [bubblewrap ](@@MDZH_LINK_DESTINATION_0067@@) or [macOS](@@MDZH_LINK_DESTINATION_0068@@).",
    ""
  ].join("\n");

  const protectedMarkdown = protectSegmentFormattingSpans(source, 7200);
  const nestedDestinationSpans = [
    { id: "@@MDZH_LINK_DESTINATION_0067@@", kind: "link_destination" as const, raw: "https://example.com/bubblewrap" },
    { id: "@@MDZH_LINK_DESTINATION_0068@@", kind: "link_destination" as const, raw: "https://example.com/macos" }
  ];
  const combinedSpans = [...protectedMarkdown.spans, ...nestedDestinationSpans];

  assert.equal(protectedMarkdown.spans.length, 0);
  assert.doesNotMatch(protectedMarkdown.protectedBody, /@@MDZH_INLINE_MARKDOWN_LINK_7200@@/);
  assert.match(protectedMarkdown.protectedBody, /\[bubblewrap \]\(@@MDZH_LINK_DESTINATION_0067@@\)/);
  assert.equal(
    restoreMarkdownSpans(protectedMarkdown.protectedBody, combinedSpans),
    "This is enforced by Linux [bubblewrap ](https://example.com/bubblewrap) or [macOS](https://example.com/macos).\n"
  );
});

test("protectSegmentFormattingSpans does not create local inline code placeholders", () => {
  const source = "> Why is this blocked? `~/.bashrc` is sensitive.\n";
  const protectedMarkdown = protectSegmentFormattingSpans(source, 7100);

  assert.doesNotMatch(protectedMarkdown.protectedBody, /@@MDZH_INLINE_CODE_7100@@/);
  assert.equal(protectedMarkdown.spans.some((span) => span.kind === "inline_code"), false);
  assert.equal(restoreMarkdownSpans(protectedMarkdown.protectedBody, protectedMarkdown.spans), source);
});
