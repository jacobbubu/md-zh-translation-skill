import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

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

async function runCommand(command, args, cwd) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr });
    });
  });
}

function extractOutputDir(stdout) {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith("output_dir="));
  return line ? line.slice("output_dir=".length).trim() : null;
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

  const smokeArgs = ["scripts/run-smoke.mjs", "--fixture", args.fixture];
  if (args.label) {
    smokeArgs.push("--label", args.label);
  }
  if (args.outputRoot) {
    smokeArgs.push("--output-root", args.outputRoot);
  }
  if (args.analysisCacheDir) {
    smokeArgs.push("--analysis-cache-dir", args.analysisCacheDir);
  }
  if (args.checkpointDir) {
    smokeArgs.push("--checkpoint-dir", args.checkpointDir);
  }
  if (args.disableAnalysisCache) {
    smokeArgs.push("--no-analysis-cache");
  }
  if (args.disableCheckpoint) {
    smokeArgs.push("--no-checkpoint");
  }

  const smokeResult = await runCommand(process.execPath, smokeArgs, repoRoot);
  const outputDir = extractOutputDir(smokeResult.stdout);
  const statusArgs = ["scripts/smoke-status.mjs"];
  if (outputDir) {
    statusArgs.push("--run-dir", outputDir);
  } else {
    statusArgs.push("--fixture", args.fixture);
  }
  const statusResult = await runCommand(process.execPath, statusArgs, repoRoot);
  let diagnoseResult = null;
  let qualityResult = null;
  if (statusResult.exitCode !== 0) {
    const diagnoseArgs = ["scripts/smoke-diagnose.mjs"];
    if (outputDir) {
      diagnoseArgs.push("--run-dir", outputDir);
    } else {
      diagnoseArgs.push("--fixture", args.fixture, "--state", "failed");
    }
    diagnoseResult = await runCommand(process.execPath, diagnoseArgs, repoRoot);
  } else if (outputDir) {
    qualityResult = await runCommand(process.execPath, ["scripts/smoke-quality.mjs", "--run-dir", outputDir], repoRoot);
  }

  process.stdout.write(
    [
      "summary:",
      `fixture=${args.fixture}`,
      `output_dir=${outputDir ?? "unknown"}`,
      `smoke_exit=${smokeResult.exitCode}`,
      `status_exit=${statusResult.exitCode}`,
      `diagnose_exit=${diagnoseResult?.exitCode ?? "skipped"}`,
      `quality_exit=${qualityResult?.exitCode ?? "skipped"}`
    ].join("\n") + "\n"
  );

  const finalExitCode =
    smokeResult.exitCode !== 0 ? smokeResult.exitCode : qualityResult?.exitCode ?? 0;
  process.exit(finalExitCode);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
