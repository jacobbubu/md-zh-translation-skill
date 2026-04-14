import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

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
  threadId?: string;
};

export type CodexExecOptions = {
  cwd?: string;
  model: string;
  outputSchema?: Record<string, unknown>;
  onStderr?: (chunk: string) => void;
  reuseSession?: boolean;
  threadId?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  timeoutMs?: number;
};

export interface CodexExecutor {
  execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult>;
}

type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    stdio: ["pipe", "pipe", "pipe"];
  }
) => ChildProcessByStdio<Writable, Readable, Readable>;

const MAX_RETRYABLE_EXEC_FAILURES = 2;
const RETRYABLE_EXEC_FAILURE_DELAY_MS = 250;

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

function parseThreadId(jsonl: string): string | undefined {
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id.length > 0) {
        return event.thread_id;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function isRetryableCodexFailure(stderr: string): boolean {
  return (
    stderr.includes("codex_core::shell_snapshot") &&
    stderr.includes("Failed to delete shell snapshot")
  );
}

function isRetryableExecutionError(error: unknown, stderr: string): boolean {
  if (isRetryableCodexFailure(stderr)) {
    return true;
  }

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /Codex returned an empty final message\./i.test(message);
}

function isResumeThreadFailure(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /thread\/resume failed|no rollout found for thread id/i.test(message);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class DefaultCodexExecutor implements CodexExecutor {
  constructor(
    private readonly spawnFn: SpawnFn = spawn,
    private readonly sleepFn: (milliseconds: number) => Promise<void> = sleep
  ) {}

  async execute(prompt: string, options: CodexExecOptions): Promise<CodexExecResult> {
    const workingDir = options.cwd ?? process.cwd();
    let attempt = 0;
    let lastError: CodexExecutionError | null = null;

    while (attempt <= MAX_RETRYABLE_EXEC_FAILURES) {
      const tempDir = await mkdtemp(path.join(tmpdir(), "md-zh-translate-"));
      const outputPath = path.join(tempDir, "last-message.txt");
      const schemaPath = options.outputSchema ? path.join(tempDir, "output-schema.json") : null;
      let stdout = "";
      let stderr = "";

      try {
        if (schemaPath) {
          await writeFile(schemaPath, `${JSON.stringify(options.outputSchema, null, 2)}\n`, "utf8");
        }

        const args = options.threadId
          ? buildResumeArgs(options, outputPath)
          : buildExecArgs(options, workingDir, outputPath);

        if (schemaPath) {
          args.push("--output-schema", schemaPath);
        }

        args.push("-");

        const child = this.spawnFn("codex", args, {
          cwd: workingDir,
          stdio: ["pipe", "pipe", "pipe"]
        });

        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });

        child.stdin.write(prompt);
        child.stdin.end();

        const exitCode = await new Promise<number>((resolve, reject) => {
          let settled = false;
          let timeoutHandle: NodeJS.Timeout | null = null;
          let killHandle: NodeJS.Timeout | null = null;

          const cleanup = () => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
            if (killHandle) {
              clearTimeout(killHandle);
              killHandle = null;
            }
          };

          const rejectOnce = (error: Error) => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            reject(error);
          };

          const resolveOnce = (code: number) => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            resolve(code);
          };

          if (options.timeoutMs && options.timeoutMs > 0) {
            timeoutHandle = setTimeout(() => {
              child.kill("SIGTERM");
              killHandle = setTimeout(() => {
                child.kill("SIGKILL");
              }, 1000);
              rejectOnce(new CodexExecutionError(`Codex exec timed out after ${options.timeoutMs}ms.`));
            }, options.timeoutMs);
          }

          child.once("error", (error) => rejectOnce(error));
          child.once("close", (code) => resolveOnce(code ?? 1));
        });

        if (exitCode !== 0) {
          options.onStderr?.(stderr);
          const error = new CodexExecutionError(
            stderr.trim() || stdout.trim() || `codex exec exited with ${exitCode}`
          );
          if (isRetryableCodexFailure(stderr) && attempt < MAX_RETRYABLE_EXEC_FAILURES) {
            lastError = error;
            attempt += 1;
            await this.sleepFn(RETRYABLE_EXEC_FAILURE_DELAY_MS * attempt);
            continue;
          }
          throw error;
        }

        const text = (await readFile(outputPath, "utf8")).trim();
        if (!text) {
          throw new CodexExecutionError("Codex returned an empty final message.");
        }

        const threadId = parseThreadId(stdout) ?? options.threadId;

        return {
          text,
          stderr,
          jsonl: stdout,
          usage: parseUsage(stdout),
          ...(threadId ? { threadId } : {})
        };
      } catch (error) {
        if (options.threadId && isResumeThreadFailure(error)) {
          const { threadId: _threadId, ...fallbackOptions } = options;
          return this.execute(prompt, {
            ...fallbackOptions,
            reuseSession: false
          });
        }
        if (isRetryableExecutionError(error, stderr) && attempt < MAX_RETRYABLE_EXEC_FAILURES) {
          const retryableError =
            error instanceof CodexExecutionError
              ? error
              : new CodexExecutionError(error instanceof Error ? error.message : String(error));
          lastError = retryableError;
          attempt += 1;
          await this.sleepFn(RETRYABLE_EXEC_FAILURE_DELAY_MS * attempt);
          continue;
        }
        if (error instanceof CodexExecutionError) {
          lastError = error;
          throw error;
        }
        lastError = new CodexExecutionError(error instanceof Error ? error.message : String(error));
        throw lastError;
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }

    throw lastError ?? new CodexExecutionError("codex exec failed after retry.");
  }
}

function buildExecArgs(options: CodexExecOptions, workingDir: string, outputPath: string): string[] {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--disable",
    "plugins",
    "--disable",
    "shell_snapshot",
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

  if (options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }

  if (!options.reuseSession) {
    args.splice(3, 0, "--ephemeral");
  }

  return args;
}

function buildResumeArgs(options: CodexExecOptions, outputPath: string): string[] {
  if (!options.threadId) {
    throw new CodexExecutionError("Codex resume requires a threadId.");
  }

  if (options.outputSchema) {
    throw new CodexExecutionError("Codex resume does not support outputSchema.");
  }

  const args = [
    "exec",
    "resume",
    "--skip-git-repo-check",
    "--json",
    "--disable",
    "plugins",
    "--disable",
    "shell_snapshot",
    "-m",
    options.model,
    "-o",
    outputPath,
    options.threadId
  ];

  if (options.reasoningEffort) {
    args.splice(6, 0, "-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }

  return args;
}
