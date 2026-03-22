import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import { buildClaudeDesktopMcpConfig, installTarget } from "../src/install.js";

test("buildClaudeDesktopMcpConfig points to the packaged MCP server entry", () => {
  const config = buildClaudeDesktopMcpConfig("/custom/node");

  assert.equal(config.command, "/custom/node");
  assert.equal(config.args.length, 1);
  assert.match(config.args[0]!, /dist\/src\/mcp-server\.js$/);
});

test("installTarget installs Codex skill files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "md-zh-translate-codex-"));
  const [result] = await installTarget({
    target: "codex",
    pathOverride: tempDir
  });
  assert.ok(result);

  assert.equal(result.target, "codex");
  assert.equal(result.kind, "skill");
  const skill = await readFile(path.join(result.path, "SKILL.md"), "utf8");
  const metadata = await readFile(path.join(result.path, "agents", "openai.yaml"), "utf8");
  assert.match(skill, /md-zh-translate/);
  assert.match(metadata, /MD Zh Translate/);
});

test("installTarget installs Claude Code skill files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "md-zh-translate-claude-"));
  const [result] = await installTarget({
    target: "claude-code",
    pathOverride: tempDir
  });
  assert.ok(result);

  assert.equal(result.target, "claude-code");
  const skill = await readFile(path.join(result.path, "SKILL.md"), "utf8");
  assert.match(skill, /Use `md-zh-translate`/);
});

test("installTarget installs a Claude Desktop MCP config entry", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "md-zh-translate-desktop-"));
  const configPath = path.join(tempDir, "claude_desktop_config.json");
  const [result] = await installTarget({
    target: "claude-desktop",
    pathOverride: configPath,
    nodePath: "/custom/node"
  });
  assert.ok(result);

  assert.equal(result.target, "claude-desktop");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.equal(config.mcpServers["md-zh-translation"]!.command, "/custom/node");
  assert.match(config.mcpServers["md-zh-translation"]!.args[0]!, /mcp-server\.js$/);
});
