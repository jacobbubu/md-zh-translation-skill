import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { formatTranslatedMarkdown } from "../src/format.js";

test("formatTranslatedMarkdown normalizes mixed Chinese-English spacing and preserves frontmatter", async () => {
  const fixturePath = path.join(process.cwd(), "test", "fixtures", "mixed-layout.md");
  const source = await readFile(fixturePath, "utf8");

  const formatted = await formatTranslatedMarkdown(source, fixturePath);

  assert.match(formatted, /title: 在Azure中部署3台VM/);
  assert.match(formatted, /在 Azure 中部署 3 台 VM。/);
  assert.match(formatted, /^---/);
});
