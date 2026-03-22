import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CodexExecutionError } from "./errors.js";

export type CodexUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type CodexExecResult = {
  text: string;
  stderr: string;
  jsonl: string;
  usage: CodexUsage;
};

export type CodexExecOptions = {
  cwd?: string;
  model: string;
  outputSchema?: Record<string, unknown>;
  onStderr?: (chunk: string) => void;
};

export interface CodexExecutor {
  execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult>;
}

function parseUsage(jsonl: string): CodexUsage {
  let latestUsage: Record<string, unknown> | null = null;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
        latestUsage = event.usage as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  const inputTokens = Number(latestUsage?.input_tokens ?? 0);
  const cachedInputTokens = Number(latestUsage?.cached_input_tokens ?? 0);
  const outputTokens = Number(latestUsage?.output_tokens ?? 0);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  };
}

export class DefaultCodexExecutor implements CodexExecutor {
  async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
    const workingDir = options.cwd ?? process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "md-zh-translate-"));
    const outputPath = path.join(tempDir, "last-message.txt");
    const schemaPath = options.outputSchema ? path.join(tempDir, "output-schema.json") : null;

    if (schemaPath) {
      await writeFile(schemaPath, `${JSON.stringify(options.outputSchema, null, 2)}\n`, "utf8");
    }

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--json",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-C",
      workingDir,
      "-m",
      options.model,
      "-o",
      outputPath
    ];

    if (schemaPath) {
      args.push("--output-schema", schemaPath);
    }

    args.push("-");

    const child = spawn("codex", args, {
      cwd: workingDir,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.stdin.write(prompt);
    child.stdin.end();

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });

    try {
      if (exitCode !== 0) {
        options.onStderr?.(stderr);
        throw new CodexExecutionError(stderr.trim() || stdout.trim() || `codex exec exited with ${exitCode}`);
      }

      const text = (await readFile(outputPath, "utf8")).trim();
      if (!text) {
        throw new CodexExecutionError("Codex returned an empty final message.");
      }

      return {
        text,
        stderr,
        jsonl: stdout,
        usage: parseUsage(stdout)
      };
    } catch (error) {
      if (error instanceof CodexExecutionError) {
        throw error;
      }
      throw new CodexExecutionError(error instanceof Error ? error.message : String(error));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
