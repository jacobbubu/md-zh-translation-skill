import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type TelemetryEventType =
  | "run.start"
  | "run.end"
  | "stage.start"
  | "stage.end"
  | "stage.error"
  | "chunk.start"
  | "chunk.end"
  | "chunk.error"
  | "repair.cycle"
  | "repair.patch"
  | "gate.result"
  | "analysis.shard.start"
  | "analysis.shard.end";

export type TelemetryEvent = {
  ts: number;
  runId: string;
  type: TelemetryEventType;
  stage?: string;
  chunkId?: string;
  cycle?: number;
  durationMs?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  error?: string;
  meta?: Record<string, unknown>;
};

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
  close(): Promise<void>;
}

export const noopTelemetry: TelemetrySink = {
  emit() {
    // no-op
  },
  async close() {
    // no-op
  }
};

export function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `run_${ts}_${rand}`;
}

export function createMemoryTelemetrySink(): TelemetrySink & {
  readonly events: readonly TelemetryEvent[];
} {
  const events: TelemetryEvent[] = [];
  return {
    get events(): readonly TelemetryEvent[] {
      return events;
    },
    emit(event) {
      events.push(event);
    },
    async close() {
      // no-op
    }
  };
}

export function createJsonlTelemetrySink(filePath: string): TelemetrySink {
  const buffer: TelemetryEvent[] = [];
  let flushPromise: Promise<void> | null = null;
  let dirEnsured = false;

  async function ensureDir(): Promise<void> {
    if (dirEnsured) {
      return;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    dirEnsured = true;
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) {
      return;
    }
    await ensureDir();
    const lines = buffer.splice(0, buffer.length).map((event) => `${JSON.stringify(event)}\n`).join("");
    await appendFile(filePath, lines, "utf8");
  }

  function scheduleFlush(): void {
    if (flushPromise) {
      return;
    }
    flushPromise = (async () => {
      try {
        // Allow more events to coalesce before writing.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await flush();
      } finally {
        flushPromise = null;
        if (buffer.length > 0) {
          scheduleFlush();
        }
      }
    })();
  }

  return {
    emit(event) {
      buffer.push(event);
      scheduleFlush();
    },
    async close() {
      while (flushPromise) {
        await flushPromise;
      }
      await flush();
    }
  };
}

export function combineTelemetrySinks(...sinks: TelemetrySink[]): TelemetrySink {
  const active = sinks.filter((sink) => sink !== noopTelemetry);
  if (active.length === 0) {
    return noopTelemetry;
  }
  if (active.length === 1) {
    return active[0]!;
  }
  return {
    emit(event) {
      for (const sink of active) {
        sink.emit(event);
      }
    },
    async close() {
      await Promise.all(active.map((sink) => sink.close()));
    }
  };
}
