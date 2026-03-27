import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { formatTranslatedBody, formatTranslatedMarkdown, reconstructMarkdown } from "../src/format.js";
import { extractFrontmatter } from "../src/markdown-protection.js";

test("formatTranslatedMarkdown normalizes mixed Chinese-English spacing and preserves frontmatter", async () => {
  const fixturePath = path.join(process.cwd(), "test", "fixtures", "mixed-layout.md");
  const source = await readFile(fixturePath, "utf8");

  const formatted = await formatTranslatedMarkdown(source, fixturePath);

  assert.match(formatted, /title: 在Azure中部署3台VM/);
  assert.match(formatted, /在 Azure 中部署 3 台 VM。/);
  assert.match(formatted, /^---/);
});

test("formatTranslatedBody formats the body and reconstructMarkdown keeps frontmatter untouched", async () => {
  const source = "---\ntitle: Hello World\ntags:\n  - ai\n---\n\n在Azure中部署3台VM。\n";
  const { frontmatter, body } = extractFrontmatter(source);
  const formattedBody = await formatTranslatedBody(body, "article.md");
  const reconstructed = reconstructMarkdown(frontmatter, formattedBody);

  assert.ok(frontmatter);
  assert.match(reconstructed, /^---\ntitle: Hello World\ntags:\n  - ai\n---\n/);
  assert.match(reconstructed, /在 Azure 中部署 3 台 VM。/);
});
