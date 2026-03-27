import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { isMainCliModule, runCli, type CliDependencies, type CliIo } from "../src/cli.js";

function createIo(overrides: Partial<CliIo> = {}): CliIo {
  let stdout = "";
  let stderr = "";
  return {
    isStdinTTY: true,
    readFile: async () => "",
    writeFile: async () => undefined,
    readStdin: async () => "",
    writeStdout: (content) => {
      stdout += content;
    },
    writeStderr: (content) => {
      stderr += content;
    },
    ...overrides,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    }
  } as CliIo & { stdout: string; stderr: string };
}

function createDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    version: "0.1.0",
    cwd: "/tmp",
    translate: async (source) => ({ markdown: `译文:${source}` }),
    ...overrides
  };
}

test("runCli prints detailed help to stdout", async () => {
  const io = createIo();
  const exitCode = await runCli(["--help"], io, createDependencies());

  assert.equal(exitCode, 0);
  assert.match((io as any).stdout, /Behavior modes:/);
  assert.equal((io as any).stderr, "");
});

test("runCli prefers --input over stdin", async () => {
  const io = createIo({
    isStdinTTY: false,
    readFile: async (filePath) => {
      assert.equal(filePath, "input.md");
      return "file input";
    },
    readStdin: async () => "stdin input"
  });

  let received = "";
  const exitCode = await runCli(
    ["--input", "input.md"],
    io,
    createDependencies({
      translate: async (source) => {
        received = source;
        return { markdown: "translated" };
      }
    })
  );

  assert.equal(exitCode, 0);
  assert.equal(received, "file input");
  assert.equal((io as any).stdout, "translated\n");
});

test("runCli writes progress and output file paths to stderr", async () => {
  let writtenPath = "";
  let writtenContent = "";
  const io = createIo({
    readFile: async () => "file input",
    writeFile: async (filePath, content) => {
      writtenPath = filePath;
      writtenContent = content;
    }
  });

  const exitCode = await runCli(
    ["--input", "input.md", "--output", "output.md"],
    io,
    createDependencies({
      translate: async (_source, options) => {
        options.onProgress?.("Starting translation", "draft");
        return { markdown: "translated" };
      }
    })
  );

  assert.equal(exitCode, 0);
  assert.equal(writtenPath, "output.md");
  assert.equal(writtenContent, "translated\n");
  assert.match((io as any).stderr, /Starting translation/);
  assert.match((io as any).stderr, /Wrote translated Markdown to output.md/);
  assert.equal((io as any).stdout, "");
});

test("runCli installs a Codex skill target", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "md-zh-install-cli-"));

  const io = createIo();
  const exitCode = await runCli(["install", "codex", "--path", tmp], io, createDependencies());

  assert.equal(exitCode, 0);
  assert.match((io as any).stdout, /codex\tskill\t/);
  assert.match((io as any).stderr, /Installing integration target/);
});

test("runCli prints MCP config JSON", async () => {
  const io = createIo();
  const exitCode = await runCli(["mcp-config"], io, createDependencies());

  assert.equal(exitCode, 0);
  const parsed = JSON.parse((io as any).stdout) as { command: string; args: string[] };
  assert.ok(parsed.command.length > 0);
  assert.equal(parsed.args.length, 1);
});

test("isMainCliModule matches a direct file path", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "md-zh-cli-main-"));
  const entryFile = path.join(tmp, "cli-entry.js");
  await writeFile(entryFile, "export {};\n", "utf8");

  assert.equal(isMainCliModule(pathToFileURL(entryFile).href, entryFile), true);
});

test("isMainCliModule matches a symlinked executable path", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "md-zh-cli-symlink-"));
  const entryFile = path.join(tmp, "cli-entry.js");
  const symlinkPath = path.join(tmp, "md-zh-translate");
  await writeFile(entryFile, "export {};\n", "utf8");
  await symlink(entryFile, symlinkPath);

  assert.equal(isMainCliModule(pathToFileURL(entryFile).href, symlinkPath), true);
});
