import test from "node:test";
import assert from "node:assert/strict";

import {
  extractFrontmatter,
  protectMarkdownSpans,
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
