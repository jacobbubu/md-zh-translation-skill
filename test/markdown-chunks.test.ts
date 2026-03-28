import test from "node:test";
import assert from "node:assert/strict";

import { planMarkdownChunks } from "../src/markdown-chunks.js";

test("planMarkdownChunks keeps top-level sections grouped by headings", () => {
  const source = [
    "# Title",
    "",
    "Intro paragraph.",
    "",
    "## First Section",
    "",
    "Alpha paragraph.",
    "",
    "## Second Section",
    "",
    "Beta paragraph.",
    ""
  ].join("\n");

  const plan = planMarkdownChunks(source);

  assert.equal(plan.documentTitle, "Title");
  assert.ok(plan.chunks.length >= 1);
  assert.deepEqual(plan.chunks[0]?.headingPath, ["Title"]);
  assert.equal(
    plan.chunks.map((chunk) => chunk.source + chunk.separatorAfter).join(""),
    source
  );
});

test("planMarkdownChunks splits oversized sections without losing heading context", () => {
  const longParagraph = "This is a very long paragraph used to force chunk splitting. ".repeat(90).trim();
  const source = [
    "# Title",
    "",
    "## Large Section",
    "",
    longParagraph,
    "",
    longParagraph,
    "",
    longParagraph,
    "",
    longParagraph,
    "",
    "## Closing Section",
    "",
    "Tail paragraph.",
    ""
  ].join("\n");

  const plan = planMarkdownChunks(source);

  assert.ok(plan.chunks.length >= 3);
  assert.deepEqual(plan.chunks[1]?.headingPath, ["Title", "Large Section"]);
  assert.deepEqual(plan.chunks.at(-1)?.headingPath, ["Title", "Closing Section"]);
  assert.equal(
    plan.chunks.map((chunk) => chunk.source + chunk.separatorAfter).join(""),
    source
  );
});
