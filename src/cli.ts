#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { CliError, InputError } from "./errors.js";
import { buildClaudeDesktopMcpConfig, installTarget, type InstallTarget } from "./install.js";
import { translateMarkdownArticle, type TranslateOptions } from "./translate.js";

export type CliIo = {
  isStdinTTY: boolean;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  readStdin: () => Promise<string>;
  writeStdout: (content: string) => void;
  writeStderr: (content: string) => void;
};

export type CliDependencies = {
  translate: (source: string, options: TranslateOptions) => Promise<{ markdown: string }>;
  version: string;
  cwd: string;
};

type ParsedArgs = {
  mode: "translate" | "install" | "mcp-config";
  inputPath?: string;
  outputPath?: string;
  installTarget?: InstallTarget;
  installPath?: string;
  strictGate: boolean;
  showHelp: boolean;
  showVersion: boolean;
};

const HELP_TEXT = `md-zh-translate

Translate an English Markdown article into polished Chinese Markdown.

Usage:
  md-zh-translate --input article.md --output article.zh.md
  md-zh-translate --input article.md
  cat article.md | md-zh-translate > article.zh.md
  md-zh-translate install codex
  md-zh-translate install claude-code
  md-zh-translate install claude-desktop
  md-zh-translate install all
  md-zh-translate mcp-config

Options:
  --input <path>   Read the source Markdown from a file. When provided, stdin is ignored.
  --output <path>  Write the final translated Markdown to a file. When omitted, output goes to stdout.
  --path <path>    Override the install destination for a single install target.
  --strict-gate    Fail hard (exit 4) when the repair loop cannot clear any hard-check, instead
                   of the default soft-gate behavior (emit degraded output, exit 0). Use in CI or
                   strict quality pipelines. MDZH_SOFT_GATE=false has the same effect.
  --help           Show this help text.
  --version        Show the CLI version.

Behavior modes:
  1. File -> file     md-zh-translate --input in.md --output out.md
  2. File -> stdout   md-zh-translate --input in.md
  3. Stdin -> stdout  cat in.md | md-zh-translate

Standard streams:
  - stdout only contains the final translated Markdown, unless --help or --version is used.
  - stderr reports progress, diagnostics, and failures.

Telemetry:
  - Set MDZH_TELEMETRY_PATH=<path> to emit JSONL run/chunk/stage/repair/gate events
    to that file. Path is resolved relative to the working directory. One line per
    event; useful for offline analysis of latency, token usage, and repair behavior.

Performance knobs:
  - MDZH_CHUNK_CONCURRENCY=<N> (default 3, max 8) runs up to N
    translateProtectedChunk calls in parallel. Result push, state mutation and
    checkpoint writes still happen in chunk-index order, so the final document
    and resume semantics are unchanged. Set to 1 to restore strict serial.
  - MDZH_REPAIR_PATCH_LANE=false disables the structured repair-target patch
    lane and forces the historical full-segment LLM rewrite for every repair.
  - MDZH_TM_PATH=<path> enables segment-level translation memory at <path>
    (JSONL). The pipeline reads cached translations on draft and writes back
    only when a chunk hard-passes. Use it to short-circuit identical re-runs
    (e.g. iterating on the same fixture). Audit and repair still run on TM
    hits, so a stale entry can't silently leak through.
  - MDZH_RESCUE_MODEL=<model-id> overrides the rescue fallback model. When a
    chunk exhausts its draft+audit+repair cycle and would otherwise throw
    HardGateError, the chunk is retried once end-to-end with this model
    substituted for both draft and post-draft. If the rescue also fails the
    original error is reported. Defaults to \`gpt-5.5\`; set to an empty
    string or \`off\` / \`none\` / \`false\` / \`0\` to disable rescue entirely.
    Trades cost & wall time for stability on flaky chunks.

Exit codes:
  0  Success (may include soft-gate degraded output; see stderr for warnings).
  2  Invalid arguments or missing input.
  3  Codex CLI execution failed.
  4  The hidden hard gate still failed after the repair loop (with --strict-gate, or when a
     structural hard-check such as protected_span_integrity or paragraph_match fails).
  5  Markdown beautification failed.

Defaults:
  - Internal model: gpt-5.4-mini
  - Internal pipeline: frozen Scheme H
  - Final Markdown is beautified with @jacobbubu/md-zh-format

Install targets:
  - codex          Install the skill into $CODEX_HOME/skills or ~/.codex/skills
  - claude-code    Install the skill into ~/.claude/skills
  - claude-desktop Install a local MCP server entry into Claude Desktop config
  - all            Install all supported targets with their default locations

MCP:
  - md-zh-translate-mcp starts the local stdio MCP server.
  - md-zh-translate mcp-config prints a reusable MCP config JSON fragment for other clients.
`;

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    mode: "translate",
    strictGate: false,
    showHelp: false,
    showVersion: false
  };

  let index = 0;
  if (argv[index] === "install") {
    parsed.mode = "install";
    index += 1;
    const target = argv[index];
    if (target && !target.startsWith("--")) {
      if (!["codex", "claude-code", "claude-desktop", "all"].includes(target)) {
        throw new InputError(`Unknown install target: ${target}`);
      }
      parsed.installTarget = target as InstallTarget;
      index += 1;
    }
  } else if (argv[index] === "mcp-config") {
    parsed.mode = "mcp-config";
    index += 1;
  }

  for (; index < argv.length; index += 1) {
    const current = argv[index];
    switch (current) {
      case "--help":
        parsed.showHelp = true;
        break;
      case "--version":
        parsed.showVersion = true;
        break;
      case "--input":
        if (argv[index + 1] == null || argv[index + 1]?.startsWith("--")) {
          throw new InputError("--input requires a file path.");
        }
        parsed.inputPath = argv[index + 1]!;
        index += 1;
        break;
      case "--output":
        if (argv[index + 1] == null || argv[index + 1]?.startsWith("--")) {
          throw new InputError("--output requires a file path.");
        }
        parsed.outputPath = argv[index + 1]!;
        index += 1;
        break;
      case "--path":
        if (argv[index + 1] == null || argv[index + 1]?.startsWith("--")) {
          throw new InputError("--path requires a file path.");
        }
        parsed.installPath = argv[index + 1]!;
        index += 1;
        break;
      case "--strict-gate":
        parsed.strictGate = true;
        break;
      default:
        throw new InputError(`Unknown argument: ${current}`);
    }
  }

  if (parsed.mode === "install" && !parsed.showHelp && !parsed.installTarget) {
    throw new InputError("Install requires a target: codex, claude-code, claude-desktop, or all.");
  }
  return parsed;
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createDefaultIo(): CliIo {
  return {
    isStdinTTY: Boolean(process.stdin.isTTY),
    readFile: (filePath) => readFile(filePath, "utf8"),
    writeFile: async (filePath, content) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    },
    readStdin: readProcessStdin,
    writeStdout: (content) => {
      process.stdout.write(content);
    },
    writeStderr: (content) => {
      process.stderr.write(content);
    }
  };
}

function createDefaultDependencies(): CliDependencies {
  return {
    translate: translateMarkdownArticle,
    version: process.env.npm_package_version ?? "0.1.0",
    cwd: process.cwd()
  };
}

function normalizeProgressMessage(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) {
    return null;
  }
  return `[md-zh-translate] ${trimmed}\n`;
}

export function resolveSoftGate(
  args: { strictGate: boolean },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (args.strictGate) {
    return false;
  }
  if (env.MDZH_SOFT_GATE === "false") {
    return false;
  }
  return true;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = createDefaultIo(),
  dependencies: CliDependencies = createDefaultDependencies()
): Promise<number> {
  try {
    const args = parseArgs(argv);

    if (args.showHelp) {
      io.writeStdout(HELP_TEXT);
      return 0;
    }

    if (args.showVersion) {
      io.writeStdout(`${dependencies.version}\n`);
      return 0;
    }

    if (args.mode === "mcp-config") {
      io.writeStdout(`${JSON.stringify(buildClaudeDesktopMcpConfig(), null, 2)}\n`);
      return 0;
    }

    if (args.mode === "install") {
      io.writeStderr("[md-zh-translate] Installing integration target(s).\n");
      const installOptions = {
        target: args.installTarget!,
        nodePath: process.execPath
      } as const;
      const results = await installTarget(
        args.installPath ? { ...installOptions, pathOverride: args.installPath } : installOptions
      );
      io.writeStdout(
        `${results.map((item) => `${item.target}\t${item.kind}\t${item.path}`).join("\n")}\n`
      );
      return 0;
    }

    const source = args.inputPath
      ? await io.readFile(args.inputPath)
      : io.isStdinTTY
        ? null
        : await io.readStdin();

    if (!source || source.trim().length === 0) {
      throw new InputError("No input Markdown provided. Use --input <path> or pipe content into stdin.");
    }

    const result = await dependencies.translate(source, {
      cwd: dependencies.cwd,
      sourcePathHint: args.inputPath ?? "stdin.md",
      softGate: resolveSoftGate(args, process.env),
      onProgress: (message) => {
        const normalized = normalizeProgressMessage(message);
        if (normalized) {
          io.writeStderr(normalized);
        }
      }
    });

    if (args.outputPath) {
      try {
        await io.writeFile(args.outputPath, `${result.markdown.trimEnd()}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CliError(`Failed to write output file ${args.outputPath}: ${message}`, 3);
      }
      io.writeStderr(`[md-zh-translate] Wrote translated Markdown to ${args.outputPath}\n`);
      return 0;
    }

    io.writeStdout(`${result.markdown.trimEnd()}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      io.writeStderr(`[md-zh-translate] ${error.message}\n`);
      return error.exitCode;
    }

    const message = error instanceof Error ? error.message : String(error);
    io.writeStderr(`[md-zh-translate] ${message}\n`);
    return 3;
  }
}

export function isMainCliModule(importMetaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMainCliModule(import.meta.url)) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
