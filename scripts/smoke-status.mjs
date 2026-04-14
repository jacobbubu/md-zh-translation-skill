import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const parsed = {
    runDir: null,
    statusPath: null,
    root: "/tmp/mdzh-smoke-runs",
    fixture: null,
    state: null,
    wait: false,
    intervalMs: 2000
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    switch (current) {
      case "--run-dir":
        if (!next) {
          throw new Error("--run-dir requires a path");
        }
        parsed.runDir = path.resolve(next);
        index += 1;
        break;
      case "--status":
        if (!next) {
          throw new Error("--status requires a path");
        }
        parsed.statusPath = path.resolve(next);
        index += 1;
        break;
      case "--root":
        if (!next) {
          throw new Error("--root requires a path");
        }
        parsed.root = path.resolve(next);
        index += 1;
        break;
      case "--fixture":
        if (!next || !["short", "full"].includes(next)) {
          throw new Error("--fixture requires short or full");
        }
        parsed.fixture = next;
        index += 1;
        break;
      case "--state":
        if (!next || !["running", "succeeded", "failed"].includes(next)) {
          throw new Error("--state requires running, succeeded, or failed");
        }
        parsed.state = next;
        index += 1;
        break;
      case "--wait":
        parsed.wait = true;
        break;
      case "--interval-ms":
        if (!next || Number.isNaN(Number(next))) {
          throw new Error("--interval-ms requires a number");
        }
        parsed.intervalMs = Math.max(250, Number(next));
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return parsed;
}

async function listRunDirs(root, fixture) {
  const { readdir, stat } = await import("node:fs/promises");
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (fixture && !entry.name.startsWith(`${fixture}-`)) {
      continue;
    }
    const runDir = path.join(root, entry.name);
    const statusPath = path.join(runDir, "status.json");
    try {
      const stats = await stat(statusPath);
      dirs.push({ runDir, statusPath, mtimeMs: stats.mtimeMs });
    } catch {
      // ignore incomplete dirs
    }
  }

  dirs.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return dirs;
}

async function resolveStatusPath(args) {
  if (args.statusPath) {
    return args.statusPath;
  }
  if (args.runDir) {
    return path.join(args.runDir, "status.json");
  }

  const latest = await listRunDirs(args.root, args.fixture);
  if (!args.state) {
    return latest[0]?.statusPath ?? null;
  }

  for (const item of latest) {
    try {
      const status = await readStatus(item.statusPath);
      if (status.state === args.state) {
        return item.statusPath;
      }
    } catch {
      // ignore broken status files
    }
  }

  return null;
}

async function readStatus(statusPath) {
  const raw = await readFile(statusPath, "utf8");
  return JSON.parse(raw);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  const statusPath = await resolveStatusPath(args);
  if (!statusPath) {
    process.stderr.write("No smoke status file found.\n");
    process.exit(2);
  }

  while (true) {
    const status = await readStatus(statusPath);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);

    if (!args.wait || status.state === "succeeded" || status.state === "failed") {
      process.exit(status.state === "failed" ? 1 : 0);
    }

    await sleep(args.intervalMs);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
