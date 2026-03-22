import os from "node:os";
import path from "node:path";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

import { InputError } from "./errors.js";
import { resolvePackagePath } from "./package-paths.js";

export type InstallTarget = "codex" | "claude-code" | "claude-desktop" | "all";

export type InstallResult = {
  target: Exclude<InstallTarget, "all">;
  path: string;
  kind: "skill" | "config";
};

export type InstallOptions = {
  target: InstallTarget;
  pathOverride?: string;
  nodePath?: string;
};

type ClaudeDesktopConfig = {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
};

const SKILL_FOLDER_NAME = "md-zh-translation-skill";
const MCP_SERVER_NAME = "md-zh-translation";

function getDefaultCodexSkillsRoot(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return path.join(codexHome || path.join(os.homedir(), ".codex"), "skills");
}

function getDefaultClaudeCodeSkillsRoot(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

function getDefaultClaudeDesktopConfigPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (!appData) {
      throw new InputError("APPDATA is required to locate Claude Desktop on Windows.");
    }
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  throw new InputError("Claude Desktop auto-install currently supports macOS and Windows. Use --path to override.");
}

async function installCodexSkill(rootOverride?: string): Promise<InstallResult> {
  const skillsRoot = rootOverride || getDefaultCodexSkillsRoot();
  const targetDir = path.join(skillsRoot, SKILL_FOLDER_NAME);
  const targetAgentsDir = path.join(targetDir, "agents");

  await mkdir(targetAgentsDir, { recursive: true });
  await copyFile(resolvePackagePath("SKILL.md"), path.join(targetDir, "SKILL.md"));
  await copyFile(resolvePackagePath("agents", "openai.yaml"), path.join(targetAgentsDir, "openai.yaml"));

  return {
    target: "codex",
    path: targetDir,
    kind: "skill"
  };
}

async function installClaudeCodeSkill(rootOverride?: string): Promise<InstallResult> {
  const skillsRoot = rootOverride || getDefaultClaudeCodeSkillsRoot();
  const targetDir = path.join(skillsRoot, SKILL_FOLDER_NAME);

  await mkdir(targetDir, { recursive: true });
  await copyFile(resolvePackagePath("SKILL.md"), path.join(targetDir, "SKILL.md"));

  return {
    target: "claude-code",
    path: targetDir,
    kind: "skill"
  };
}

export function buildClaudeDesktopMcpConfig(nodePath = process.execPath): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: nodePath,
    args: [resolvePackagePath("dist", "src", "mcp-server.js")],
    env: {}
  };
}

async function installClaudeDesktopMcp(configPathOverride?: string, nodePath?: string): Promise<InstallResult> {
  const configPath = configPathOverride || getDefaultClaudeDesktopConfigPath();
  let current: ClaudeDesktopConfig = {};

  try {
    const raw = await readFile(configPath, "utf8");
    current = JSON.parse(raw) as ClaudeDesktopConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const next: ClaudeDesktopConfig = {
    ...current,
    mcpServers: {
      ...(current.mcpServers || {}),
      [MCP_SERVER_NAME]: buildClaudeDesktopMcpConfig(nodePath)
    }
  };

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return {
    target: "claude-desktop",
    path: configPath,
    kind: "config"
  };
}

export async function installTarget(options: InstallOptions): Promise<InstallResult[]> {
  if (options.target === "all") {
    return [
      await installCodexSkill(),
      await installClaudeCodeSkill(),
      await installClaudeDesktopMcp(undefined, options.nodePath)
    ];
  }

  if (options.target === "codex") {
    return [await installCodexSkill(options.pathOverride)];
  }

  if (options.target === "claude-code") {
    return [await installClaudeCodeSkill(options.pathOverride)];
  }

  return [await installClaudeDesktopMcp(options.pathOverride, options.nodePath)];
}
