import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const defaultFullPath = path.join(repoRoot, "test/fixtures/smoke/claude-code-sandbox-full.md");
const defaultShortPath = path.join(repoRoot, "test/fixtures/smoke/claude-code-sandbox-short.md");

const shortSelection = [
  {
    start: "How to Use New Claude Code Sandbox to Autonomously Code (Without Security Disasters)",
    end: "What Sandbox Mode Protects Against"
  },
  {
    start: "What Sandbox Mode Protects Against",
    maxBlocks: 9
  },
  {
    start: "Testing Your Claude Code Sandbox Setup",
    maxBlocks: 9
  },
  {
    start: "Alternative Solutions (Windows)",
    maxBlocks: 4
  }
];

function parseArgs(argv) {
  const args = { source: null, full: defaultFullPath, short: defaultShortPath };
  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--source" && next) {
      args.source = path.resolve(next);
      index += 1;
      continue;
    }
    if (current === "--full" && next) {
      args.full = path.resolve(next);
      index += 1;
      continue;
    }
    if (current === "--short" && next) {
      args.short = path.resolve(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }
  return args;
}

function splitLines(input) {
  return input.split(/\r?\n/);
}

function isFenceStart(line) {
  return /^([ \t]{0,3})(`{3,}|~{3,})/.test(line);
}

function fenceChar(line) {
  const match = line.match(/^([ \t]{0,3})(`{3,}|~{3,})/);
  return match?.[2]?.[0] ?? null;
}

function fenceLength(line) {
  const match = line.match(/^([ \t]{0,3})(`{3,}|~{3,})/);
  return match?.[2]?.length ?? 0;
}

function isFenceEnd(line, expectedChar, expectedLength) {
  const match = line.match(/^([ \t]{0,3})(`{3,}|~{3,})[ \t]*$/);
  return !!match && match[2][0] === expectedChar && match[2].length >= expectedLength;
}

function parseBlocks(markdown) {
  const lines = splitLines(markdown);
  const blocks = [];
  let current = [];
  let inFence = false;
  let currentFenceChar = null;
  let currentFenceLength = 0;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    const content = current.join("\n").trimEnd();
    if (content.length > 0) {
      blocks.push({
        content,
        marker: extractMarker(content)
      });
    }
    current = [];
  };

  for (const line of lines) {
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }

    current.push(line);

    if (!inFence && isFenceStart(line)) {
      inFence = true;
      currentFenceChar = fenceChar(line);
      currentFenceLength = fenceLength(line);
      continue;
    }

    if (inFence && currentFenceChar && isFenceEnd(line, currentFenceChar, currentFenceLength)) {
      inFence = false;
      currentFenceChar = null;
      currentFenceLength = 0;
    }
  }

  flush();
  return blocks;
}

function extractMarker(content) {
  const trimmed = content.trim();
  if (!trimmed || trimmed.includes("\n")) {
    const lines = trimmed.split("\n");
    if (lines.length === 1) {
      return null;
    }
    const first = lines[0]?.trim() ?? "";
    if (/^#{1,6}\s+/.test(first)) {
      return normalizeMarker(first.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, ""));
    }
    if (/^\*\*[^*].*\*\*$/.test(first)) {
      return normalizeMarker(first.slice(2, -2).trim());
    }
    return null;
  }

  if (/^#{1,6}\s+/.test(trimmed)) {
    return normalizeMarker(trimmed.replace(/^#{1,6}\s+/, "").replace(/\s+#+\s*$/, ""));
  }

  if (/^\*\*[^*].*\*\*$/.test(trimmed)) {
    return normalizeMarker(trimmed.slice(2, -2).trim());
  }

  return null;
}

function normalizeMarker(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function findMarkerIndex(blocks, marker, startIndex = 0) {
  const normalized = normalizeMarker(marker);
  for (let index = startIndex; index < blocks.length; index += 1) {
    if (blocks[index]?.marker === normalized) {
      return index;
    }
  }
  return -1;
}

function selectBlocks(blocks, selections) {
  const selected = [];
  let searchStart = 0;

  for (const selection of selections) {
    const startIndex = findMarkerIndex(blocks, selection.start, searchStart);
    if (startIndex < 0) {
      throw new Error(`Start marker not found: ${selection.start}`);
    }

    let endIndex = blocks.length;
    if (selection.end) {
      endIndex = findMarkerIndex(blocks, selection.end, startIndex + 1);
    } else if (selection.maxBlocks) {
      endIndex = Math.min(blocks.length, startIndex + selection.maxBlocks);
    }

    if (selection.end && endIndex < 0) {
      throw new Error(`End marker not found: ${selection.end}`);
    }

    selected.push(...blocks.slice(startIndex, endIndex < 0 ? blocks.length : endIndex));
    searchStart = endIndex < 0 ? blocks.length : endIndex;
  }

  return selected;
}

function serializeBlocks(blocks) {
  return `${blocks.map((block) => block.content.trimEnd()).join("\n\n").trimEnd()}\n`;
}

function lineCount(text) {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

async function main() {
  const args = parseArgs(process.argv);
  const sourcePath = args.source ?? args.full;

  const source = await fs.readFile(sourcePath, "utf8");
  const blocks = parseBlocks(source);
  const shortBlocks = selectBlocks(blocks, shortSelection);

  const fullOutput = source.endsWith("\n") ? source : `${source}\n`;
  const shortOutput = serializeBlocks(shortBlocks);

  await fs.mkdir(path.dirname(args.full), { recursive: true });
  await fs.mkdir(path.dirname(args.short), { recursive: true });
  await fs.writeFile(args.full, fullOutput, "utf8");
  await fs.writeFile(args.short, shortOutput, "utf8");

  process.stdout.write(
    `full=${args.full} (${lineCount(fullOutput)} lines)\nshort=${args.short} (${lineCount(shortOutput)} lines)\n`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
