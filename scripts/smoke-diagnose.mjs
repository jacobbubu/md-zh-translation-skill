import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const parsed = {
    runDir: null,
    statusPath: null,
    root: "/tmp/mdzh-smoke-runs",
    fixture: null,
    state: "failed"
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
      // ignore
    }
  }

  dirs.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return dirs;
}

async function readJson(jsonPath) {
  return JSON.parse(await readFile(jsonPath, "utf8"));
}

async function resolveStatusPath(args) {
  if (args.statusPath) {
    return args.statusPath;
  }
  if (args.runDir) {
    return path.join(args.runDir, "status.json");
  }

  const latest = await listRunDirs(args.root, args.fixture);
  for (const item of latest) {
    try {
      const status = await readJson(item.statusPath);
      if (status.state === args.state) {
        return item.statusPath;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function collectSignals(status, stderrText) {
  const lastEvent = `${status.lastEvent ?? ""}\n${stderrText}`.trim();
  const signals = [];

  if (/Analysis quality gate failed:/u.test(lastEvent)) {
    signals.push("analysis-quality-gate");
  }
  if (/timed out after \d+ms/u.test(lastEvent)) {
    signals.push("stage-timeout");
  }
  if (/Smoke runner terminated by SIG/u.test(lastEvent)) {
    signals.push("external-termination");
  }
  if (/Protected span integrity failed:.*hook_prompt|control text|控制文本/u.test(lastEvent)) {
    signals.push("control-plane-contamination");
  }
  if (/Protected span integrity failed:.*未出现在译文|缺失|未保留/u.test(lastEvent)) {
    signals.push("protected-span-missing");
  }
  if (/Protected span integrity failed:/u.test(lastEvent)) {
    signals.push("protected-span-corruption");
  }
  if (/Heading plan coverage:/u.test(lastEvent) && /Recovering missing heading plans/u.test(lastEvent)) {
    signals.push("heading-recovery-path");
  }
  if (/bundled audit timed out/u.test(lastEvent)) {
    signals.push("bundled-audit-timeout");
  }
  if (/repair returned invalid content|Draft contract failed|Repair contract failed/u.test(lastEvent)) {
    signals.push("freeform-contract-failure");
  }

  if (/重复译文块|与原文一致的 \d+ 段结构/u.test(lastEvent)) {
    signals.push("block-structure-drift");
  }
  if (/首次出现.*英文对照|首现.*中英对照|不能只保留中文/u.test(lastEvent)) {
    signals.push("first-mention-owner-missing");
  }
  if (/括号嵌套错误|重复括注|单层中英对照标题/u.test(lastEvent)) {
    signals.push("heading-canonicalization");
  }

  return [...new Set(signals)];
}

function recommend(signals) {
  if (signals.includes("analysis-quality-gate")) {
    return "优先收 analysis / heading-recovery 质量，不要继续跑 chunk。";
  }
  if (signals.includes("external-termination")) {
    return "先确认是否为人工中断或 runner 被杀，再决定是否重跑。";
  }
  if (signals.includes("stage-timeout")) {
    return "优先收对应 stage 的复杂度预算或降级策略，不要先盲目拉长 timeout。";
  }
  if (signals.includes("control-plane-contamination")) {
    return "优先收 draft/repair 输出层控制文本清洗与 contract gate。";
  }
  if (signals.includes("protected-span-missing")) {
    return "优先收 protected/source-shape owner，检查译文本体是否缺失或 block 被吞。";
  }
  if (signals.includes("protected-span-corruption")) {
    return "优先收 protected span restore/normalize，而不是改语义 plan。";
  }
  if (signals.includes("block-structure-drift")) {
    return "优先把当前 chunk 的多块说明段继续拆细，并把该段迁到更严格的结构化 block lane。";
  }
  if (signals.includes("first-mention-owner-missing")) {
    return "优先收 first-mention owner 执行，不要继续依赖 must_fix 文案在 repair 阶段兜底。";
  }
  if (signals.includes("heading-canonicalization")) {
    return "优先收标题 owner 的 canonical display 收敛，避免重复括注和括号嵌套。";
  }
  if (signals.includes("heading-recovery-path")) {
    return "优先收 heading recovery 和 heading owner 收敛，不要先改正文 repair。";
  }
  if (signals.includes("bundled-audit-timeout")) {
    return "优先收 bundled audit 降级与 per-segment fallback，而不是继续加更多 audit 调用。";
  }
  if (signals.includes("freeform-contract-failure")) {
    return "优先把当前段型迁到 JSON blocks 或更严格的结构化 lane。";
  }
  return "先读 stderr.log 与 state.json，确定最小失败点后再进入下一轮。";
}

async function main() {
  const args = parseArgs(process.argv);
  const statusPath = await resolveStatusPath(args);
  if (!statusPath) {
    process.stderr.write("No matching smoke status file found.\n");
    process.exit(2);
  }

  const status = await readJson(statusPath);
  const runDir = path.dirname(statusPath);
  const stderrPath = path.join(runDir, "stderr.log");
  let stderrText = "";
  try {
    stderrText = await readFile(stderrPath, "utf8");
  } catch {
    // ignore missing stderr
  }

  const signals = collectSignals(status, stderrText);
  const category = signals[0] ?? "unknown";
  const diagnosis = {
    runDir,
    statusPath,
    stderrPath,
    state: status.state,
    phase: status.phase,
    lastEvent: status.lastEvent ?? null,
    category,
    signals,
    recommendedAction: recommend(signals)
  };

  process.stdout.write(`${JSON.stringify(diagnosis, null, 2)}\n`);
  process.exit(status.state === "failed" ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
