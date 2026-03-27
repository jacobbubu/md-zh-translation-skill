import { HardGateError } from "./errors.js";

export type FrontmatterSplit = {
  frontmatter: string | null;
  body: string;
};

export type ProtectedKind =
  | "code_block"
  | "inline_code"
  | "link_destination"
  | "image_destination";

export type ProtectedSpan = {
  id: string;
  kind: ProtectedKind;
  raw: string;
};

export type ProtectedMarkdown = {
  protectedBody: string;
  spans: ProtectedSpan[];
};

function createPlaceholder(kind: ProtectedKind, index: number): string {
  return `@@MDZH_${kind.toUpperCase()}_${String(index).padStart(4, "0")}@@`;
}

export function extractFrontmatter(markdown: string): FrontmatterSplit {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return { frontmatter: null, body: markdown };
  }

  const openingLineEnd = markdown.indexOf("\n");
  if (openingLineEnd < 0) {
    return { frontmatter: null, body: markdown };
  }

  let offset = openingLineEnd + 1;
  while (offset < markdown.length) {
    const nextLineEnd = markdown.indexOf("\n", offset);
    const lineEnd = nextLineEnd >= 0 ? nextLineEnd + 1 : markdown.length;
    const line = markdown.slice(offset, lineEnd).replace(/\r?\n$/, "");
    if (line === "---" || line === "...") {
      return {
        frontmatter: markdown.slice(0, lineEnd),
        body: markdown.slice(lineEnd)
      };
    }
    offset = lineEnd;
  }

  return { frontmatter: null, body: markdown };
}

export function protectMarkdownSpans(body: string): ProtectedMarkdown {
  const spans: ProtectedSpan[] = [];

  const register = (kind: ProtectedKind, raw: string): string => {
    const id = createPlaceholder(kind, spans.length + 1);
    spans.push({ id, kind, raw });
    return id;
  };

  let protectedBody = body;
  protectedBody = protectFencedCodeBlocks(protectedBody, register);
  protectedBody = protectInlineCode(protectedBody, register);
  protectedBody = protectLinkDestinations(protectedBody, register);

  return { protectedBody, spans };
}

function protectFencedCodeBlocks(
  input: string,
  register: (kind: ProtectedKind, raw: string) => string
): string {
  const lines = input.split(/(?<=\n)/);
  let output = "";
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const normalizedLine = line.replace(/\r?\n$/, "");
    const opening = normalizedLine.match(/^([ \t]{0,3})(`{3,}|~{3,})(.*)$/);
    if (!opening) {
      output += line;
      index += 1;
      continue;
    }

    const fence = opening[2]!;
    const fenceChar = fence[0];
    let block = line;
    index += 1;

    while (index < lines.length) {
      const current = lines[index] ?? "";
      block += current;
      const normalizedCurrent = current.replace(/\r?\n$/, "");
      const closing = normalizedCurrent.match(/^([ \t]{0,3})(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[2]![0] === fenceChar && closing[2]!.length >= fence.length) {
        index += 1;
        break;
      }
      index += 1;
    }

    output += register("code_block", block);
  }

  return output;
}

function protectInlineCode(
  input: string,
  register: (kind: ProtectedKind, raw: string) => string
): string {
  let output = "";
  let index = 0;

  while (index < input.length) {
    if (input[index] !== "`") {
      output += input[index];
      index += 1;
      continue;
    }

    let tickCount = 1;
    while (input[index + tickCount] === "`") {
      tickCount += 1;
    }

    const fence = "`".repeat(tickCount);
    const start = index;
    index += tickCount;

    let closingIndex = -1;
    while (index < input.length) {
      if (input.slice(index, index + tickCount) === fence) {
        closingIndex = index;
        break;
      }
      index += 1;
    }

    if (closingIndex < 0) {
      output += input.slice(start, start + tickCount);
      index = start + tickCount;
      continue;
    }

    const raw = input.slice(start, closingIndex + tickCount);
    output += register("inline_code", raw);
    index = closingIndex + tickCount;
  }

  return output;
}

function protectLinkDestinations(
  input: string,
  register: (kind: ProtectedKind, raw: string) => string
): string {
  return input.replace(/(!?\[[^\]\n]*\])\(([^()\n\s][^)\n]*)\)/g, (_match, label: string, destination: string) => {
    const kind: ProtectedKind = label.startsWith("![") ? "image_destination" : "link_destination";
    return `${label}(${register(kind, destination)})`;
  });
}

export function restoreMarkdownSpans(protectedBody: string, spans: ProtectedSpan[]): string {
  let output = protectedBody;

  for (const span of spans) {
    const matches = output.match(new RegExp(span.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? [];
    if (matches.length !== 1) {
      throw new HardGateError(
        `Protected span integrity failed for ${span.id}: expected 1 placeholder occurrence, found ${matches.length}.`
      );
    }
    output = output.replace(span.id, span.raw);
  }

  const leftovers = output.match(/@@MDZH_[A-Z_]+_\d{4}@@/g);
  if (leftovers && leftovers.length > 0) {
    throw new HardGateError(`Protected span integrity failed: unreplaced placeholders remained (${leftovers.join(", ")}).`);
  }

  return output;
}
