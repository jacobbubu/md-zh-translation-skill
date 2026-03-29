import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";

import { DefaultCodexExecutor } from "../src/codex-exec.js";
import { CodexExecutionError } from "../src/errors.js";

type AttemptPlan = {
  exitCode: number;
  stderr?: string;
  stdout?: string;
  outputText?: string;
};

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: (_chunk: string) => undefined,
    end: () => undefined
  };
}

function createSpawnStub(plans: AttemptPlan[]) {
  let callCount = 0;
  const calls: readonly string[][] = [];

  return {
    spawnFn: (_command: string, args: readonly string[]) => {
      const plan = plans[callCount];
      callCount += 1;
      (calls as string[][]).push([...args]);
      assert.ok(plan, "Unexpected extra Codex execution attempt.");

      const child = new FakeChildProcess();
      const outputIndex = args.indexOf("-o");
      const outputPath = outputIndex >= 0 ? String(args[outputIndex + 1]) : null;

      queueMicrotask(async () => {
        if (plan.stdout) {
          child.stdout.emit("data", plan.stdout);
        }
        if (plan.stderr) {
          child.stderr.emit("data", plan.stderr);
        }
        if (plan.exitCode === 0 && outputPath && typeof plan.outputText === "string") {
          await writeFile(outputPath, plan.outputText, "utf8");
        }
        child.emit("close", plan.exitCode);
      });

      return child as never;
    },
    getCallCount: () => callCount,
    getCalls: () => calls
  };
}

test("DefaultCodexExecutor retries retryable shell snapshot failures", async () => {
  const stub = createSpawnStub([
    {
      exitCode: 1,
      stderr:
        '2026-03-29T15:15:09.893257Z  WARN codex_core::shell_snapshot: Failed to delete shell snapshot at "/tmp/x": Os { code: 2, kind: NotFound, message: "No such file or directory" }'
    },
    {
      exitCode: 0,
      outputText: "最终译文\n"
    }
  ]);
  const executor = new DefaultCodexExecutor(stub.spawnFn, async () => undefined);

  const result = await executor.execute("prompt", {
    model: "gpt-5.3-codex-spark"
  });

  assert.equal(result.text, "最终译文");
  assert.equal(stub.getCallCount(), 2);
});

test("DefaultCodexExecutor retries retryable shell snapshot failures when the final message is missing", async () => {
  const stub = createSpawnStub([
    {
      exitCode: 0,
      stderr:
        '2026-03-29T15:15:09.893257Z  WARN codex_core::shell_snapshot: Failed to delete shell snapshot at "/tmp/x": Os { code: 2, kind: NotFound, message: "No such file or directory" }'
    },
    {
      exitCode: 0,
      outputText: "最终译文\n"
    }
  ]);
  const executor = new DefaultCodexExecutor(stub.spawnFn, async () => undefined);

  const result = await executor.execute("prompt", {
    model: "gpt-5.3-codex-spark"
  });

  assert.equal(result.text, "最终译文");
  assert.equal(stub.getCallCount(), 2);
});

test("DefaultCodexExecutor does not retry non-retryable failures", async () => {
  const stub = createSpawnStub([
    {
      exitCode: 1,
      stderr: "network failure"
    }
  ]);
  const executor = new DefaultCodexExecutor(stub.spawnFn, async () => undefined);

  await assert.rejects(
    executor.execute("prompt", {
      model: "gpt-5.3-codex-spark"
    }),
    (error: unknown) => {
      assert.ok(error instanceof CodexExecutionError);
      assert.match(error.message, /network failure/);
      return true;
    }
  );

  assert.equal(stub.getCallCount(), 1);
});

test("DefaultCodexExecutor disables plugin loading and shell_snapshot for exec attempts", async () => {
  const stub = createSpawnStub([
    {
      exitCode: 0,
      outputText: "最终译文\n"
    }
  ]);
  const executor = new DefaultCodexExecutor(stub.spawnFn, async () => undefined);

  await executor.execute("prompt", {
    model: "gpt-5.3-codex-spark"
  });

  const firstArgs = stub.getCalls()[0] ?? [];
  assert.notEqual(firstArgs.indexOf("--disable"), -1);
  assert.notEqual(firstArgs.indexOf("plugins"), -1);
  assert.notEqual(firstArgs.indexOf("shell_snapshot"), -1);
});
