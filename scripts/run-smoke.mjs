import { mkdir, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const fixtures = {
  short: path.join(repoRoot, "test/fixtures/smoke/claude-code-sandbox-short.md"),
  full: path.join(repoRoot, "test/fixtures/smoke/claude-code-sandbox-full.md")
};

function parseArgs(argv) {
  const parsed = {
    fixture: "short",
    label: null,
    outputRoot: path.join("/tmp", "mdzh-smoke-runs"),
    analysisCacheDir: null,
    checkpointDir: null,
    disableAnalysisCache: false,
    disableCheckpoint: false
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    switch (current) {
      case "--fixture":
        if (!next || !["short", "full"].includes(next)) {
          throw new Error("--fixture requires short or full");
        }
        parsed.fixture = next;
        index += 1;
        break;
      case "--label":
        if (!next) {
          throw new Error("--label requires a value");
        }
        parsed.label = next;
        index += 1;
        break;
      case "--output-root":
        if (!next) {
          throw new Error("--output-root requires a path");
        }
        parsed.outputRoot = path.resolve(next);
        index += 1;
        break;
      case "--analysis-cache-dir":
        if (!next) {
          throw new Error("--analysis-cache-dir requires a path");
        }
        parsed.analysisCacheDir = path.resolve(next);
        index += 1;
        break;
      case "--checkpoint-dir":
        if (!next) {
          throw new Error("--checkpoint-dir requires a path");
        }
        parsed.checkpointDir = path.resolve(next);
        index += 1;
        break;
      case "--no-analysis-cache":
        parsed.disableAnalysisCache = true;
        break;
      case "--no-checkpoint":
        parsed.disableCheckpoint = true;
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return parsed;
}

function buildRunId(fixture, label) {
  const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replace("T", "-").replace("Z", "");
  return label ? `${fixture}-${label}` : `${fixture}-${timestamp}`;
}

function inferPhase(message) {
  if (!message) {
    return null;
  }
  if (/Analyzing document-wide anchors|analysis shard|heading-only recovery|emphasis-only recovery|Model-based anchor discovery/u.test(message)) {
    return "analysis";
  }
  if (/starting translation|draft still waiting/u.test(message)) {
    return "draft";
  }
  if (/running hard gate audit|bundled audit|post-repair audit/u.test(message)) {
    return "audit";
  }
  if (/repair cycle|repairing failed segment|repair returned invalid content/u.test(message)) {
    return "repair";
  }
  if (/Formatting translated Markdown/u.test(message)) {
    return "format";
  }
  return null;
}

async function writeStatus(statusPath, status) {
  const tempPath = `${statusPath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await rename(tempPath, statusPath);
}

async function main() {
  const args = parseArgs(process.argv);
  const fixturePath = fixtures[args.fixture];
  if (!fixturePath) {
    throw new Error(`Unknown fixture: ${args.fixture}`);
  }

  const runId = buildRunId(args.fixture, args.label);
  const outputDir = path.join(args.outputRoot, runId);
  const outputPath = path.join(outputDir, "output.md");
  const stderrPath = path.join(outputDir, "stderr.log");
  const statusPath = path.join(outputDir, "status.json");
  const debugStatePath = path.join(outputDir, "state.json");
  const debugIrPath = path.join(outputDir, "ir.md");
  const analysisCacheDir =
    args.disableAnalysisCache
      ? null
      : args.analysisCacheDir ?? path.join(repoRoot, ".cache", "smoke", args.fixture, "analysis");
  const checkpointDir =
    args.disableCheckpoint
      ? null
      : args.checkpointDir ?? path.join(repoRoot, ".cache", "smoke", args.fixture, "checkpoint");

  await mkdir(outputDir, { recursive: true });
  const stderrFile = await open(stderrPath, "w");
  const startedAt = new Date().toISOString();
  const status = {
    schemaVersion: 1,
    runId,
    fixture: args.fixture,
    inputPath: fixturePath,
    outputDir,
    outputPath,
    stderrPath,
    statusPath,
    debugStatePath,
    debugIrPath,
    analysisCacheDir,
    checkpointDir,
    pid: null,
    state: "starting",
    phase: null,
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    exitCode: null,
    signal: null,
    lastEvent: null
  };
  let statusWriteChain = Promise.resolve();
  const persistStatus = async () => {
    statusWriteChain = statusWriteChain.then(() => writeStatus(statusPath, status));
    await statusWriteChain;
  };
  await persistStatus();

  const env = {
    ...process.env,
    ...(analysisCacheDir ? { MDZH_ANALYSIS_CACHE_DIR: analysisCacheDir } : { MDZH_DISABLE_ANALYSIS_CACHE: "1" }),
    ...(checkpointDir ? { MDZH_CHECKPOINT_DIR: checkpointDir } : { MDZH_DISABLE_CHECKPOINT: "1" }),
    MDZH_DEBUG_STATE_PATH: debugStatePath,
    MDZH_DEBUG_IR_PATH: debugIrPath
  };

  process.stdout.write(
    [
      `fixture=${args.fixture}`,
      `input=${fixturePath}`,
      `output_dir=${outputDir}`,
      `output=${outputPath}`,
      `stderr=${stderrPath}`,
      `status=${statusPath}`,
      `debug_state=${debugStatePath}`,
      `debug_ir=${debugIrPath}`,
      `analysis_cache=${analysisCacheDir ?? "disabled"}`,
      `checkpoint=${checkpointDir ?? "disabled"}`
    ].join("\n") + "\n"
  );

  const child = spawn(process.execPath, [path.join(repoRoot, "dist/src/cli.js"), "--input", fixturePath, "--output", outputPath], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  status.pid = child.pid ?? null;
  status.state = "running";
  status.updatedAt = new Date().toISOString();
  await persistStatus();

  let shuttingDown = false;
  const handleTermination = async (signalName) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    status.updatedAt = new Date().toISOString();
    status.finishedAt = status.updatedAt;
    status.state = "failed";
    status.signal = signalName;
    status.exitCode = 1;
    status.lastEvent = `Smoke runner terminated by ${signalName}.`;
    await persistStatus();
    child.kill(signalName);
    process.exit(1);
  };
  process.on("SIGINT", () => {
    void handleTermination("SIGINT");
  });
  process.on("SIGTERM", () => {
    void handleTermination("SIGTERM");
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  let stderrBuffer = "";
  child.stderr.on("data", async (chunk) => {
    const text = chunk.toString("utf8");
    process.stderr.write(text);
    await stderrFile.write(text);

    stderrBuffer += text;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? "";
    const lastLine = [...lines].reverse().find((line) => line.trim().length > 0);
    if (lastLine) {
      status.lastEvent = lastLine.trim();
      status.phase = inferPhase(lastLine) ?? status.phase;
      status.updatedAt = new Date().toISOString();
      await persistStatus();
    }
  });

  const { exitCode, signal } = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, closeSignal) => resolve({ exitCode: code, signal: closeSignal }));
  });

  await stderrFile.close();
  shuttingDown = true;
  status.updatedAt = new Date().toISOString();
  status.finishedAt = status.updatedAt;
  status.exitCode = typeof exitCode === "number" ? exitCode : 1;
  status.signal = signal ?? null;
  status.state = status.exitCode === 0 ? "succeeded" : "failed";
  await persistStatus();
  process.exit(status.exitCode);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
