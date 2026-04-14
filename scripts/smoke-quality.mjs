import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const parsed = {
    runDir: null,
    outputPath: null,
    fixture: "short",
    root: "/tmp/mdzh-smoke-runs"
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    switch (current) {
      case "--run-dir":
        if (!next) throw new Error("--run-dir requires a path");
        parsed.runDir = path.resolve(next);
        index += 1;
        break;
      case "--output":
        if (!next) throw new Error("--output requires a path");
        parsed.outputPath = path.resolve(next);
        index += 1;
        break;
      case "--fixture":
        if (!next || !["short", "full"].includes(next)) {
          throw new Error("--fixture requires short or full");
        }
        parsed.fixture = next;
        index += 1;
        break;
      case "--root":
        if (!next) throw new Error("--root requires a path");
        parsed.root = path.resolve(next);
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
    if (!entry.isDirectory()) continue;
    if (fixture && !entry.name.startsWith(`${fixture}-`)) continue;
    const runDir = path.join(root, entry.name);
    const outputPath = path.join(runDir, "output.md");
    try {
      const stats = await stat(outputPath);
      dirs.push({ runDir, outputPath, mtimeMs: stats.mtimeMs });
    } catch {
      // ignore runs without output
    }
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dirs;
}

async function resolveOutputPath(args) {
  if (args.outputPath) return args.outputPath;
  if (args.runDir) return path.join(args.runDir, "output.md");
  const latest = (await listRunDirs(args.root, args.fixture))[0];
  return latest?.outputPath ?? null;
}

function pushIssue(issues, category, detail, line = null) {
  issues.push({ category, detail, line });
}

function looksLikeCodeFenceLine(line) {
  return /^```/.test(line.trim());
}

function countAsciiWords(text) {
  return (text.match(/[A-Za-z]{3,}/g) ?? []).length;
}

async function main() {
  const args = parseArgs(process.argv);
  const outputPath = await resolveOutputPath(args);
  if (!outputPath) {
    process.stderr.write("No output.md found for quality check.\n");
    process.exit(2);
  }

  const markdown = await readFile(outputPath, "utf8");
  const lines = markdown.split(/\r?\n/);
  const issues = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (looksLikeCodeFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    if (/If you were to multiply this by 20/u.test(line)) {
      pushIssue(issues, "english-leak", "正文句仍为整句英文。", index + 1);
    }
    if (/Sandbox mode(?!（sandbox mode）)/u.test(line)) {
      pushIssue(issues, "anchor-leak", "正文里仍有裸英文 `Sandbox mode`。", index + 1);
    }
    if (/Prompt injection attacks）（/u.test(line) || /Supply chain attacks）（/u.test(line)) {
      pushIssue(issues, "nested-anchor", "出现英文括注重复或嵌套。", index + 1);
    }
    if (/bubblewrap（[^）]+）\s+\]/u.test(line)) {
      pushIssue(issues, "link-spacing", "链接 label 尾部多出空格。", index + 1);
    }
    if (/Claude Code Sandbox（Claude Code 沙盒） Code 的 sandbox/u.test(line)) {
      pushIssue(issues, "family-mix", "产品名与普通名词混拼。", index + 1);
    }
    if (
      !/^>/.test(line) &&
      !/^#/.test(line) &&
      !/^\s*[-*+]/.test(line) &&
      countAsciiWords(line) >= 6 &&
      !/https?:\/\//.test(line)
    ) {
      pushIssue(issues, "english-heavy-line", "非代码正文中存在明显英语泄漏。", index + 1);
    }
  }

  const report = {
    outputPath,
    pass: issues.length === 0,
    issueCount: issues.length,
    issues
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(issues.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
