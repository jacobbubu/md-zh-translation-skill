import type { PromptSlice } from "./translation-state.js";

export type PromptAnchor = PromptSlice["requiredAnchors"][number];
type AnchorLike = Pick<PromptAnchor, "english" | "chineseHint">;
type AnchorDisplayMode = "english-only" | "english-primary" | "chinese-primary";
type AnchorDisplay = {
  mode: AnchorDisplayMode;
  english: string;
  chineseDisplay: string;
  canonical: string;
  repeatText: string;
};

export function coalesceRequiredAnchors(requiredAnchors: readonly PromptAnchor[]): PromptAnchor[] {
  return requiredAnchors.filter((anchor) => !isShadowedByLongerAnchor(anchor, requiredAnchors));
}

export function formatAnchorDisplay(anchor: AnchorLike): string {
  return resolveAnchorDisplay(anchor).canonical;
}

export function normalizeSegmentAnchorText(text: string, slice: PromptSlice | null): string {
  if (!slice) {
    return text;
  }

  let normalized = text;
  const requiredIds = new Set(slice.requiredAnchors.map((anchor) => anchor.anchorId));
  const repeatIds = new Set([
    ...slice.repeatAnchors.map((anchor) => anchor.anchorId),
    ...slice.establishedAnchors.map((anchor) => anchor.anchorId)
  ]);
  const anchors = dedupePromptAnchors([
    ...slice.requiredAnchors,
    ...slice.repeatAnchors,
    ...slice.establishedAnchors
  ]).sort((left, right) => right.english.length - left.english.length);

  for (const anchor of anchors) {
    normalized = normalizeSingleAnchor(
      normalized,
      anchor,
      requiredIds.has(anchor.anchorId),
      repeatIds.has(anchor.anchorId)
    );
  }

  return normalizeRepeatedEnglishParenthesesWithLocalHints(normalized);
}

export function injectPlannedAnchorText(
  source: string,
  text: string,
  slice: PromptSlice | null
): string {
  if (!slice) {
    return text;
  }

  const requiredAnchors = coalesceRequiredAnchors(dedupePromptAnchors(slice.requiredAnchors)).sort(
    (left, right) => right.english.length - left.english.length
  );
  if (requiredAnchors.length === 0) {
    return text;
  }

  const sourceLines = source.split(/\r?\n/);
  const translatedLines = text.split(/\r?\n/);
  let changed = false;

  for (let index = 0; index < Math.min(sourceLines.length, translatedLines.length); index += 1) {
    const sourceLine = sourceLines[index] ?? "";
    let translatedLine = translatedLines[index] ?? "";

    for (const anchor of requiredAnchors) {
      if (!containsWholePhrase(sourceLine, anchor.english)) {
        continue;
      }

      if (shouldSkipAnchorInjectionForCommandPhrase(sourceLine, anchor)) {
        continue;
      }

      const injectedLine = injectAnchorIntoLine(translatedLine, anchor);
      if (injectedLine !== translatedLine) {
        translatedLine = injectedLine;
        changed = true;
      }
    }

    translatedLines[index] = translatedLine;
  }

  return changed ? translatedLines.join("\n") : text;
}

export function normalizeHeadingLikeAnchorText(
  source: string,
  text: string,
  slice: PromptSlice | null
): string {
  if (!slice) {
    return text;
  }

  const requiredAnchors = dedupePromptAnchors(slice.requiredAnchors).sort(
    (left, right) => right.english.length - left.english.length
  );
  if (requiredAnchors.length === 0) {
    return text;
  }

  const sourceHeadingLines = extractHeadingLikeLines(source);
  const translatedHeadingLines = extractHeadingLikeLines(text);
  if (sourceHeadingLines.length === 0 || translatedHeadingLines.length === 0) {
    return text;
  }

  let normalized = text;

  for (let index = 0; index < Math.min(sourceHeadingLines.length, translatedHeadingLines.length); index += 1) {
    const sourceLine = sourceHeadingLines[index]!;
    const translatedLine = translatedHeadingLines[index]!;

    let normalizedLine = translatedLine.raw;
    for (const anchor of requiredAnchors) {
      if (
        !containsWholePhrase(sourceLine.content, anchor.english) ||
        !anchor.chineseHint ||
        anchor.chineseHint.toLowerCase() === anchor.english.toLowerCase() ||
        !normalizedLine.includes(anchor.chineseHint) ||
        containsWholePhrase(normalizedLine, anchor.english)
      ) {
        continue;
      }

      normalizedLine = normalizedLine.replace(
        anchor.chineseHint,
        `${anchor.chineseHint}（${anchor.english}）`
      );
    }

    if (normalizedLine !== translatedLine.raw) {
      normalized = normalized.replace(translatedLine.raw, normalizedLine);
    }
  }

  return normalized;
}

export function normalizeExplicitRepairAnchorText(
  source: string,
  text: string,
  slice: PromptSlice | null
): string {
  if (!slice || slice.pendingRepairs.length === 0) {
    return text;
  }

  const targets = slice.pendingRepairs
    .map((repair) => parseExplicitRepairTarget(repair.instruction))
    .filter((target): target is ExplicitRepairTarget => target !== null);
  if (targets.length === 0) {
    return text;
  }

  const sourceLines = source.split(/\r?\n/);
  const translatedLines = text.split(/\r?\n/);
  let changed = false;

  for (let index = 0; index < Math.min(sourceLines.length, translatedLines.length); index += 1) {
    const sourceLine = sourceLines[index] ?? "";
    let translatedLine = translatedLines[index] ?? "";

    for (const target of targets) {
      if (
        !containsWholePhrase(sourceLine, target.english) ||
        !translatedLine.includes(target.chineseHint) ||
        containsWholePhrase(translatedLine, target.english)
      ) {
        continue;
      }

      translatedLine = translatedLine.replace(
        target.chineseHint,
        `${target.chineseHint}（${target.english}）`
      );
      changed = true;
    }

    translatedLines[index] = translatedLine;
  }

  return changed ? translatedLines.join("\n") : text;
}

function normalizeSingleAnchor(
  text: string,
  anchor: PromptAnchor,
  isRequired: boolean,
  isRepeatOrEstablished: boolean
): string {
  const display = resolveAnchorDisplay(anchor);
  const english = display.english;
  const chineseHint = display.chineseDisplay;

  if (!english) {
    return text;
  }

  const escapedEnglish = escapeRegExp(english);
  let normalized = text;

  if (display.mode === "chinese-primary") {
    const escapedChinese = escapeRegExp(chineseHint);
    const canonical = display.canonical;

    normalized = normalized.replace(new RegExp(`${escapedEnglish}（${escapedChinese}）`, "g"), canonical);
    normalized = normalized.replace(new RegExp(`${escapedEnglish}（${escapedEnglish}）`, "g"), canonical);
    normalized = normalized.replace(new RegExp(`${escapedChinese}（${escapedEnglish}）\\s*（${escapedEnglish}）`, "g"), canonical);
    normalized = normalized.replace(new RegExp(`${escapedChinese}（${escapedChinese}）`, "g"), canonical);

    if (isRepeatOrEstablished) {
      normalized = normalized.replace(new RegExp(`${escapedChinese}（${escapedEnglish}）`, "g"), chineseHint);
    }

    return normalized;
  }

  if (display.mode === "english-primary") {
    const escapedChinese = escapeRegExp(chineseHint);
    const canonical = display.canonical;

    normalized = normalized.replace(
      new RegExp(`${escapedEnglish}\\s*${escapedChinese}（${escapedEnglish}）`, "g"),
      canonical
    );
    normalized = normalized.replace(
      new RegExp(`${escapedChinese}（${escapedEnglish}）`, "g"),
      canonical
    );
    normalized = normalized.replace(new RegExp(`${escapedEnglish}（${escapedEnglish}）`, "g"), canonical);

    if (isRepeatOrEstablished) {
      normalized = normalized.replace(new RegExp(`${escapedEnglish}（${escapedChinese}）`, "g"), english);
    }

    return normalized;
  }

  normalized = normalized.replace(new RegExp(`${escapedEnglish}（${escapedEnglish}）`, "g"), english);

  if (isRequired) {
    normalized = collapseRepeatedEnglishParentheses(normalized, english);
  }

  return normalized;
}

function collapseRepeatedEnglishParentheses(text: string, english: string): string {
  const escapedEnglish = escapeRegExp(english);
  return text.replace(new RegExp(`（${escapedEnglish}）\\s*（${escapedEnglish}）`, "g"), `（${english}）`);
}

function injectAnchorIntoLine(text: string, anchor: PromptAnchor): string {
  const display = resolveAnchorDisplay(anchor);

  if (!display.english || display.mode === "english-only") {
    return text;
  }

  if (display.mode === "english-primary") {
    if (text.includes(display.canonical)) {
      return text;
    }

    if (containsWholePhrase(text, display.english) && !text.includes(display.chineseDisplay)) {
      return replaceWholePhraseOnce(text, display.english, display.canonical);
    }

    if (text.includes(anchor.chineseHint)) {
      return replaceFirst(text, anchor.chineseHint, display.canonical);
    }

    if (display.chineseDisplay && text.includes(display.chineseDisplay)) {
      return replaceFirst(text, display.chineseDisplay, display.canonical);
    }

    return text;
  }

  if (text.includes(display.canonical) || containsWholePhrase(text, display.english)) {
    return text;
  }

  if (text.includes(display.chineseDisplay)) {
    return replaceFirst(text, display.chineseDisplay, display.canonical);
  }

  if (text.includes(anchor.chineseHint)) {
    return replaceFirst(text, anchor.chineseHint, display.canonical);
  }

  return text;
}

function shouldSkipAnchorInjectionForCommandPhrase(sourceLine: string, anchor: PromptAnchor): boolean {
  const trimmed = sourceLine.trim();
  const bulletMatch = trimmed.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/);
  const body = bulletMatch?.[1]?.trim();
  if (!body) {
    return false;
  }

  const english = anchor.english.trim();
  if (!english || /\s/.test(english)) {
    return false;
  }

  const withoutTrailingExplanation = body.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const leadingToken = withoutTrailingExplanation.match(/^([A-Za-z][A-Za-z0-9+._/-]*)\b/)?.[1]?.trim();
  if (!leadingToken || leadingToken.toLowerCase() !== english.toLowerCase()) {
    return false;
  }

  const remainder = withoutTrailingExplanation.slice(leadingToken.length).trim();
  if (!remainder) {
    return false;
  }

  if (remainder.includes(",")) {
    return true;
  }

  return /^[A-Za-z0-9./_-]/.test(remainder);
}

type HeadingLine = {
  raw: string;
  content: string;
};

type ExplicitRepairTarget = {
  chineseHint: string;
  english: string;
};

function parseExplicitRepairTarget(instruction: string): ExplicitRepairTarget | null {
  const match = instruction.match(/需补为“([^（”]+)（([^）]+)）”/);
  if (match?.[1] && match[2]) {
    return {
      chineseHint: match[1].trim(),
      english: match[2].trim()
    };
  }

  const english =
    instruction.match(/关键术语“([^”]*[A-Za-z][^”]*)”/)?.[1]?.trim() ??
    instruction.match(/“([^”]*[A-Za-z][^”]*)”缺少/)?.[1]?.trim() ??
    null;
  const locationText = instruction.match(/位置：[^“]*“([^”]+)”/)?.[1]?.trim() ?? null;
  const chineseHint = locationText ? stripInlineMarkdownMarkers(locationText).trim() : null;

  if (!english || !chineseHint) {
    return null;
  }

  return { chineseHint, english };
}

function stripInlineMarkdownMarkers(text: string): string {
  return text.replace(/[*_`~]/g, "");
}

function extractHeadingLikeLines(text: string): HeadingLine[] {
  const headings: HeadingLine[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    const atxMatch = trimmed.match(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?$/);
    if (atxMatch?.[1]) {
      headings.push({ raw: rawLine, content: atxMatch[1].trim() });
      continue;
    }

    const boldMatch = trimmed.match(/^\*\*(.+)\*\*$/);
    if (boldMatch?.[1]) {
      headings.push({ raw: rawLine, content: boldMatch[1].trim() });
    }
  }

  return headings;
}

function dedupePromptAnchors(anchors: readonly PromptAnchor[]): PromptAnchor[] {
  const seen = new Set<string>();
  const deduped: PromptAnchor[] = [];

  for (const anchor of anchors) {
    if (seen.has(anchor.anchorId)) {
      continue;
    }
    seen.add(anchor.anchorId);
    deduped.push(anchor);
  }

  return deduped;
}

function isShadowedByLongerAnchor(anchor: PromptAnchor, anchors: readonly PromptAnchor[]): boolean {
  const english = normalizeAnchorText(anchor.english);
  const chineseHint = normalizeAnchorText(anchor.chineseHint);

  if (!english || english !== chineseHint) {
    return false;
  }

  return anchors.some((candidate) => {
    if (candidate.anchorId === anchor.anchorId) {
      return false;
    }

    const candidateEnglish = normalizeAnchorText(candidate.english);
    if (!candidateEnglish || candidateEnglish.length <= english.length) {
      return false;
    }

    return containsWholeEnglishPhrase(candidateEnglish, english);
  });
}

function containsWholeEnglishPhrase(haystack: string, needle: string): boolean {
  const escapedNeedle = escapeRegExp(needle);
  return new RegExp(`\\b${escapedNeedle}\\b`, "i").test(haystack);
}

function containsWholePhrase(haystack: string, needle: string): boolean {
  if (/[A-Za-z]/.test(needle)) {
    return containsWholeEnglishPhrase(haystack, needle);
  }

  return haystack.includes(needle);
}

function normalizeAnchorText(value: string): string {
  return value.trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceFirst(text: string, needle: string, replacement: string): string {
  const index = text.indexOf(needle);
  if (index === -1) {
    return text;
  }
  return `${text.slice(0, index)}${replacement}${text.slice(index + needle.length)}`;
}

function replaceWholePhraseOnce(text: string, needle: string, replacement: string): string {
  if (!/[A-Za-z]/.test(needle)) {
    return replaceFirst(text, needle, replacement);
  }

  const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`);
  return text.replace(pattern, replacement);
}

function normalizeRepeatedEnglishParenthesesWithLocalHints(text: string): string {
  const localEnglishPrimary = new Map<string, string>();
  const englishPrimaryPattern = /\b([A-Za-z][A-Za-z0-9.+/_ -]{1,})（([^（）\n]+)）/g;

  for (const match of text.matchAll(englishPrimaryPattern)) {
    const english = match[1]?.trim();
    const explainer = match[2]?.trim();
    if (!english || !explainer) {
      continue;
    }
    if (english.toLowerCase() === explainer.toLowerCase()) {
      continue;
    }
    localEnglishPrimary.set(english.toLowerCase(), `${english}（${explainer}）`);
  }

  return text.replace(englishPrimaryPattern, (raw, englishRaw, innerRaw) => {
    const english = String(englishRaw).trim();
    const inner = String(innerRaw).trim();
    if (!english || !inner) {
      return raw;
    }

    if (english.toLowerCase() !== inner.toLowerCase()) {
      return raw;
    }

    const canonical = localEnglishPrimary.get(english.toLowerCase());
    return canonical ?? english;
  });
}

function resolveAnchorDisplay(anchor: AnchorLike): AnchorDisplay {
  const english = anchor.english.trim();
  const chineseHint = anchor.chineseHint.trim();

  if (!english || !chineseHint || chineseHint.toLowerCase() === english.toLowerCase()) {
    return {
      mode: "english-only",
      english,
      chineseDisplay: "",
      canonical: english,
      repeatText: english
    };
  }

  const strippedEnglishPrefix = stripLeadingEnglishHint(chineseHint, english);
  const chineseDisplay = strippedEnglishPrefix ?? chineseHint;
  if (shouldPreferEnglishPrimary(english, strippedEnglishPrefix)) {
    return {
      mode: "english-primary",
      english,
      chineseDisplay,
      canonical: `${english}（${chineseDisplay}）`,
      repeatText: english
    };
  }

  return {
    mode: "chinese-primary",
    english,
    chineseDisplay,
    canonical: `${chineseDisplay}（${english}）`,
    repeatText: chineseDisplay
  };
}

function stripLeadingEnglishHint(chineseHint: string, english: string): string | null {
  if (!chineseHint.toLowerCase().startsWith(english.toLowerCase())) {
    return null;
  }

  const suffix = chineseHint.slice(english.length).trim();
  return suffix.length > 0 ? suffix : null;
}

function shouldPreferEnglishPrimary(english: string, strippedEnglishPrefix: string | null): boolean {
  if (strippedEnglishPrefix) {
    return true;
  }

  return /^[A-Za-z0-9][A-Za-z0-9.+/_-]*$/.test(english);
}
