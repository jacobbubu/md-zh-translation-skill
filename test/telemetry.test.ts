import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  combineTelemetrySinks,
  createJsonlTelemetrySink,
  createMemoryTelemetrySink,
  generateRunId,
  noopTelemetry,
  type TelemetryEvent
} from "../src/telemetry.js";

test("generateRunId returns stable-shaped identifiers", () => {
  const a = generateRunId();
  const b = generateRunId();
  assert.match(a, /^run_[a-z0-9]+_[a-z0-9]+$/);
  assert.match(b, /^run_[a-z0-9]+_[a-z0-9]+$/);
  assert.notEqual(a, b);
});

test("noopTelemetry swallows events and closes cleanly", async () => {
  noopTelemetry.emit({ ts: 1, runId: "r", type: "run.start" });
  await noopTelemetry.close();
});

test("createMemoryTelemetrySink records emitted events in order", async () => {
  const sink = createMemoryTelemetrySink();
  sink.emit({ ts: 1, runId: "r", type: "run.start" });
  sink.emit({ ts: 2, runId: "r", type: "stage.start", stage: "draft" });
  sink.emit({ ts: 3, runId: "r", type: "stage.end", stage: "draft", durationMs: 10 });

  const events = [...sink.events];
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.start", "stage.start", "stage.end"]
  );
  await sink.close();
});

test("createJsonlTelemetrySink writes one JSON object per line", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "telemetry-test-"));
  try {
    const filePath = path.join(dir, "nested", "events.jsonl");
    const sink = createJsonlTelemetrySink(filePath);
    const events: TelemetryEvent[] = [
      { ts: 1, runId: "r", type: "run.start" },
      { ts: 2, runId: "r", type: "stage.end", stage: "audit", durationMs: 5, inputTokens: 10, outputTokens: 4 },
      { ts: 3, runId: "r", type: "run.end", durationMs: 100 }
    ];
    for (const event of events) {
      sink.emit(event);
    }
    await sink.close();

    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 3);
    const parsed = lines.map((line) => JSON.parse(line)) as TelemetryEvent[];
    assert.deepEqual(parsed, events);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createJsonlTelemetrySink coalesces rapid emits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "telemetry-test-"));
  try {
    const filePath = path.join(dir, "events.jsonl");
    const sink = createJsonlTelemetrySink(filePath);
    for (let i = 0; i < 50; i += 1) {
      sink.emit({ ts: i, runId: "r", type: "stage.start", stage: "draft" });
    }
    await sink.close();
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 50);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("combineTelemetrySinks broadcasts to every active sink", async () => {
  const a = createMemoryTelemetrySink();
  const b = createMemoryTelemetrySink();
  const combined = combineTelemetrySinks(a, b, noopTelemetry);
  combined.emit({ ts: 1, runId: "r", type: "run.start" });
  combined.emit({ ts: 2, runId: "r", type: "run.end", durationMs: 1 });
  await combined.close();

  assert.equal(a.events.length, 2);
  assert.equal(b.events.length, 2);
  assert.deepEqual(
    [...a.events].map((event) => event.type),
    ["run.start", "run.end"]
  );
});

test("combineTelemetrySinks short-circuits when only noopTelemetry is provided", () => {
  const sink = combineTelemetrySinks(noopTelemetry, noopTelemetry);
  assert.equal(sink, noopTelemetry);
});

test("combineTelemetrySinks unwraps when only one active sink remains", () => {
  const memory = createMemoryTelemetrySink();
  const sink = combineTelemetrySinks(noopTelemetry, memory);
  assert.equal(sink, memory);
});
