import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Segment-level translation memory.
 *
 * The pipeline is deterministic in its segmentation: the same source segment
 * should produce the same canonical placeholder body, and the gate audit
 * already tells us when a translation is correct. So if we have already
 * translated `segment.source` to `target` and that target passed the hard
 * gate before, we can short-circuit the entire draft + audit + repair loop
 * for that segment by just returning the stored target.
 *
 * Scope for v1:
 * - Exact match only (fingerprint = SHA1 of normalized source text).
 * - Append-only JSONL on disk; we de-dup in-memory by fingerprint.
 * - No fuzzy match, no per-document scoping. Future iterations can layer
 *   those on top by extending TmEntry with similarity metadata.
 */

export type TmEntry = {
  fingerprint: string;
  source: string;
  target: string;
  hardPassed: boolean;
  auditedAt: number;
  runId: string;
  documentTitle?: string;
};

export interface TmStore {
  get(fingerprint: string): TmEntry | null;
  put(entry: TmEntry): Promise<void>;
  close(): Promise<void>;
}

export const noopTmStore: TmStore = {
  get() {
    return null;
  },
  async put() {
    // no-op
  },
  async close() {
    // no-op
  }
};

export function fingerprint(source: string): string {
  // Normalize whitespace so trivial line-ending or tab differences don't
  // cause a miss. Keep punctuation and case — they carry meaning the model
  // would otherwise translate differently.
  const normalized = source.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  return createHash("sha1").update(normalized, "utf8").digest("hex");
}

export function createMemoryTmStore(initial: readonly TmEntry[] = []): TmStore & {
  readonly entries: readonly TmEntry[];
} {
  const map = new Map<string, TmEntry>();
  for (const entry of initial) {
    map.set(entry.fingerprint, entry);
  }
  return {
    get entries(): readonly TmEntry[] {
      return [...map.values()];
    },
    get(fp) {
      return map.get(fp) ?? null;
    },
    async put(entry) {
      map.set(entry.fingerprint, entry);
    },
    async close() {
      // no-op
    }
  };
}

export async function createJsonlTmStore(filePath: string): Promise<TmStore> {
  const map = new Map<string, TmEntry>();
  let writeChain = Promise.resolve();

  // Eagerly load existing entries; bad / incomplete lines are skipped quietly
  // so a partially-written JSONL from a crashed run doesn't poison the cache.
  try {
    const raw = await readFile(filePath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const entry = JSON.parse(trimmed) as TmEntry;
        if (
          typeof entry?.fingerprint === "string" &&
          typeof entry?.source === "string" &&
          typeof entry?.target === "string"
        ) {
          map.set(entry.fingerprint, entry);
        }
      } catch {
        // Skip unparseable line.
      }
    }
  } catch {
    // File doesn't exist yet — fine, first run.
  }

  return {
    get(fp) {
      return map.get(fp) ?? null;
    },
    async put(entry) {
      map.set(entry.fingerprint, entry);
      const append = (async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
      })();
      writeChain = writeChain.then(() => append);
      await append;
    },
    async close() {
      await writeChain;
    }
  };
}
