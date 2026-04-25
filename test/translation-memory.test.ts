import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createJsonlTmStore,
  createMemoryTmStore,
  fingerprint,
  noopTmStore,
  type TmEntry
} from "../src/translation-memory.js";

function makeEntry(overrides: Partial<TmEntry> & { source: string; target: string }): TmEntry {
  return {
    fingerprint: fingerprint(overrides.source),
    hardPassed: true,
    auditedAt: 1700000000000,
    runId: "run_test",
    ...overrides
  };
}

test("fingerprint normalizes line endings and trailing whitespace", () => {
  const a = fingerprint("hello\nworld\n");
  const b = fingerprint("hello\r\nworld\r\n");
  const c = fingerprint("hello \nworld\t\n");
  assert.equal(a, b);
  assert.equal(a, c);
});

test("fingerprint is case- and punctuation-sensitive", () => {
  const lower = fingerprint("hello world.");
  const upper = fingerprint("Hello World.");
  const noPunct = fingerprint("hello world");
  assert.notEqual(lower, upper);
  assert.notEqual(lower, noPunct);
});

test("noopTmStore is a clean no-op", async () => {
  assert.equal(noopTmStore.get("anything"), null);
  await noopTmStore.put(makeEntry({ source: "x", target: "y" }));
  await noopTmStore.close();
});

test("createMemoryTmStore round-trips entries", async () => {
  const store = createMemoryTmStore();
  const entry = makeEntry({ source: "Hello World.", target: "你好世界。" });
  await store.put(entry);
  const got = store.get(entry.fingerprint);
  assert.deepEqual(got, entry);
  assert.equal(store.entries.length, 1);
});

test("createMemoryTmStore lookup miss returns null", () => {
  const store = createMemoryTmStore();
  assert.equal(store.get("missing"), null);
});

test("createMemoryTmStore put replaces an existing entry by fingerprint", async () => {
  const store = createMemoryTmStore();
  const a = makeEntry({ source: "X", target: "甲" });
  const b = makeEntry({ source: "X", target: "丙", auditedAt: 1700000001000 });
  await store.put(a);
  await store.put(b);
  assert.equal(store.entries.length, 1);
  assert.equal(store.get(a.fingerprint)?.target, "丙");
});

test("createJsonlTmStore appends one JSON object per line and rehydrates", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tm-test-"));
  try {
    const filePath = path.join(dir, "nested", "tm.jsonl");
    const store1 = await createJsonlTmStore(filePath);
    await store1.put(makeEntry({ source: "Alpha", target: "甲" }));
    await store1.put(makeEntry({ source: "Bravo", target: "乙" }));
    await store1.close();

    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 2);

    const store2 = await createJsonlTmStore(filePath);
    assert.equal(store2.get(fingerprint("Alpha"))?.target, "甲");
    assert.equal(store2.get(fingerprint("Bravo"))?.target, "乙");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createJsonlTmStore tolerates a partially written / corrupt file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tm-test-"));
  try {
    const filePath = path.join(dir, "tm.jsonl");
    // First entry valid, second entry garbage, third entry valid.
    const valid = makeEntry({ source: "Alpha", target: "甲" });
    const garbage = "{{{not json";
    const valid2 = makeEntry({ source: "Bravo", target: "乙" });
    const lines = [
      JSON.stringify(valid),
      garbage,
      JSON.stringify(valid2)
    ].join("\n") + "\n";
    await mkdtemp(path.join(tmpdir(), "tm-test-")); // ensure dir
    await (await import("node:fs/promises")).writeFile(filePath, lines, "utf8");

    const store = await createJsonlTmStore(filePath);
    assert.equal(store.get(valid.fingerprint)?.target, "甲");
    assert.equal(store.get(valid2.fingerprint)?.target, "乙");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
