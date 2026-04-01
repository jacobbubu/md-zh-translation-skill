import type { PromptSlice } from "./translation-state.js";

export type PromptAnchor = PromptSlice["requiredAnchors"][number];

export function coalesceRequiredAnchors(requiredAnchors: readonly PromptAnchor[]): PromptAnchor[] {
  return requiredAnchors.filter((anchor) => !isShadowedByLongerAnchor(anchor, requiredAnchors));
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

  return normalized;
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
  const english = anchor.english.trim();
  const chineseHint = anchor.chineseHint.trim();

  if (!english) {
    return text;
  }

  const escapedEnglish = escapeRegExp(english);
  const hasDistinctChineseHint =
    chineseHint.length > 0 && chineseHint.toLowerCase() !== english.toLowerCase();

  let normalized = text;

  if (hasDistinctChineseHint) {
    const escapedChinese = escapeRegExp(chineseHint);
    const canonical = `${chineseHint}（${english}）`;

    normalized = normalized.replace(new RegExp(`${escapedEnglish}（${escapedChinese}）`, "g"), canonical);
    normalized = normalized.replace(new RegExp(`${escapedEnglish}（${escapedEnglish}）`, "g"), canonical);
    normalized = normalized.replace(new RegExp(`${escapedChinese}（${escapedEnglish}）\\s*（${escapedEnglish}）`, "g"), canonical);
    normalized = normalized.replace(new RegExp(`${escapedChinese}（${escapedChinese}）`, "g"), canonical);

    if (isRepeatOrEstablished) {
      normalized = normalized.replace(new RegExp(`${escapedChinese}（${escapedEnglish}）`, "g"), chineseHint);
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
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    chineseHint: match[1].trim(),
    english: match[2].trim()
  };
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
