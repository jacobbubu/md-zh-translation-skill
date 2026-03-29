import { HardGateError } from "./errors.js";

export type FrontmatterSplit = {
  frontmatter: string | null;
  body: string;
};

export type ProtectedKind =
  | "code_block"
  | "link_destination"
  | "image_destination"
  | "autolink"
  | "html_attribute"
  | "html_block"
  | "inline_markdown_link"
  | "inline_code"
  | "strong_emphasis";

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
  protectedBody = protectHtmlBlocks(protectedBody, register);
  protectedBody = mapOutsideInlineCode(protectedBody, (text) => {
    let next = text;
    next = protectLinkDestinations(next, register);
    next = protectAutolinks(next, register);
    next = protectHtmlAttributes(next, register);
    return next;
  });

  return { protectedBody, spans };
}

export function protectSegmentFormattingSpans(body: string, startIndex = 1): ProtectedMarkdown {
  const spans: ProtectedSpan[] = [];

  const register = (kind: ProtectedKind, raw: string): string => {
    const id = createPlaceholder(kind, startIndex + spans.length);
    spans.push({ id, kind, raw });
    return id;
  };

  let protectedBody = mapOutsideInlineCode(body, (text) => protectInlineMarkdownLinks(text, register));
  protectedBody = protectInlineCodeSegments(protectedBody, register);

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

function mapOutsideInlineCode(input: string, transform: (text: string) => string): string {
  let output = "";
  let index = 0;
  let textStart = 0;

  while (index < input.length) {
    if (input[index] !== "`") {
      index += 1;
      continue;
    }

    output += transform(input.slice(textStart, index));

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
      index = start + tickCount;
      textStart = start;
      continue;
    }

    const raw = input.slice(start, closingIndex + tickCount);
    output += raw;
    index = closingIndex + tickCount;
    textStart = index;
  }

  output += transform(input.slice(textStart));
  return output;
}

function protectInlineCodeSegments(
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

function protectInlineMarkdownLinks(
  input: string,
  register: (kind: ProtectedKind, raw: string) => string
): string {
  return input.replace(
    /!?\[[^\]\n]+\]\(@@MDZH_(?:LINK_DESTINATION|IMAGE_DESTINATION)_\d{4,}@@\)/g,
    (raw) => register("inline_markdown_link", raw)
  );
}

function protectInlineStrongEmphasis(
  input: string,
  register: (kind: ProtectedKind, raw: string) => string
): string {
  return input
    .split(/\r?\n/)
    .map((line) => protectInlineStrongEmphasisInLine(line, register))
    .join("\n");
}

function protectInlineStrongEmphasisInLine(
  line: string,
  register: (kind: ProtectedKind, raw: string) => string
): string {
  const pattern = /(\*\*[^*\n][^*\n]{0,80}\*\*|__[^_\n][^_\n]{0,80}__)/g;
  return line.replace(pattern, (raw) => {
    const trimmedLine = line.trim();
    if (trimmedLine === raw.trim()) {
      return raw;
    }

    const content = raw.slice(2, -2).trim();
    if (!/[A-Za-z]/.test(content)) {
      return raw;
    }

    return register("strong_emphasis", raw);
  });
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

function protectAutolinks(
  input: string,
  register: (kind: ProtectedKind, raw: string) => string
): string {
  return input.replace(/<((https?:\/\/|mailto:)[^>\s]+)>/gi, (_match, raw: string) => {
    return `<${register("autolink", raw)}>`;
  });
}

function protectHtmlAttributes(
  input: string,
  register: (kind: ProtectedKind, raw: string) => string
): string {
  return input.replace(/\b(href|src|poster)=("([^"]*)"|'([^']*)')/gi, (_match, attribute: string, quoted: string, doubleQuoted?: string, singleQuoted?: string) => {
    const rawValue = doubleQuoted ?? singleQuoted ?? "";
    const quote = quoted[0] ?? '"';
    return `${attribute}=${quote}${register("html_attribute", rawValue)}${quote}`;
  });
}

function protectHtmlBlocks(
  input: string,
  register: (kind: ProtectedKind, raw: string) => string
): string {
  return input.replace(
    /<(div|section|article|details|summary|figure|figcaption|table|thead|tbody|tfoot|tr|td|th|aside|header|footer|nav)\b[\s\S]*?<\/\1>/gi,
    (raw) => register("html_block", raw)
  );
}

export function restoreMarkdownSpans(protectedBody: string, spans: ProtectedSpan[]): string {
  let output = reprotectMarkdownSpans(protectedBody, spans);

  for (const span of spans) {
    const matches = output.match(new RegExp(escapeRegex(span.id), "g")) ?? [];
    if (matches.length === 1) {
      output = output.replace(span.id, span.raw);
      continue;
    }

    if (matches.length !== 1) {
      throw new HardGateError(
        `Protected span integrity failed for ${span.id}: expected 1 placeholder occurrence, found ${matches.length}.`
      );
    }
  }

  const leftovers = output.match(/@@MDZH_[A-Z_]+_\d{4,}@@/g);
  if (leftovers && leftovers.length > 0) {
    throw new HardGateError(`Protected span integrity failed: unreplaced placeholders remained (${leftovers.join(", ")}).`);
  }

  return output;
}

export function reprotectMarkdownSpans(protectedBody: string, spans: ProtectedSpan[]): string {
  let output = protectedBody;

  for (const span of spans) {
    output = canonicalizeWrappedPlaceholder(output, span);

    const matches = output.match(new RegExp(escapeRegex(span.id), "g")) ?? [];
    if (matches.length === 1) {
      continue;
    }

    if (matches.length === 0 && isNestedInsidePresentPlaceholder(output, span, spans)) {
      continue;
    }

    if (matches.length === 0) {
      const reprotected = reprotectExpandedProtectedSpan(output, span, spans);
      if (reprotected !== null) {
        output = reprotected;
        continue;
      }
    }

    if (matches.length !== 1) {
      throw new HardGateError(
        `Protected span integrity failed for ${span.id}: expected 1 placeholder occurrence, found ${matches.length}.`
      );
    }
  }

  return output;
}

function isNestedInsidePresentPlaceholder(output: string, span: ProtectedSpan, spans: readonly ProtectedSpan[]): boolean {
  return spans.some(
    (other) => other.id !== span.id && output.includes(other.id) && other.raw.includes(span.id)
  );
}

function canonicalizeWrappedPlaceholder(output: string, span: ProtectedSpan): string {
  switch (span.kind) {
    case "inline_code":
      return replaceWrappedPlaceholder(output, span.id, ["`"]) ?? output;
    case "strong_emphasis":
      return replaceWrappedPlaceholder(output, span.id, ["**", "__"]) ?? output;
    default:
      return output;
  }
}

function reprotectExpandedProtectedSpan(
  output: string,
  span: ProtectedSpan,
  spans: readonly ProtectedSpan[]
): string | null {
  switch (span.kind) {
    case "link_destination":
    case "image_destination":
      return replaceFirstLiteral(output, `](${span.raw})`, `](${span.id})`);
    case "autolink":
      return replaceFirstLiteral(output, `<${span.raw}>`, `<${span.id}>`);
    case "html_attribute":
      for (const attribute of ["href", "src", "poster"]) {
        for (const quote of ['"', "'"]) {
          const replaced = replaceFirstLiteral(
            output,
            `${attribute}=${quote}${span.raw}${quote}`,
            `${attribute}=${quote}${span.id}${quote}`
          );
          if (replaced !== null) {
            return replaced;
          }
        }
      }
      return null;
    case "inline_markdown_link": {
      const expandedRaw = expandNestedPlaceholderRaw(span.raw, spans);
      return replaceFirstLiteral(output, expandedRaw, span.id);
    }
    case "inline_code":
    case "strong_emphasis":
      return null;
    default:
      return null;
  }
}

function replaceFirstLiteral(source: string, search: string, replacement: string): string | null {
  const index = source.indexOf(search);
  if (index < 0) {
    return null;
  }
  return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

function replaceWrappedPlaceholder(source: string, placeholder: string, wrappers: string[]): string | null {
  for (const wrapper of wrappers) {
    const wrapped = `${wrapper}${placeholder}${wrapper}`;
    const replaced = replaceFirstLiteral(source, wrapped, placeholder);
    if (replaced !== null) {
      return replaced;
    }
  }
  return null;
}

function expandNestedPlaceholderRaw(raw: string, spans: readonly ProtectedSpan[]): string {
  let expanded = raw;
  for (const nested of spans) {
    if (!expanded.includes(nested.id)) {
      continue;
    }
    expanded = expanded.replaceAll(nested.id, nested.raw);
  }
  return expanded;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
