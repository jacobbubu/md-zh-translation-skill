import type { PromptSlice } from "./translation-state.js";

export type PromptAnchor = PromptSlice["requiredAnchors"][number];
type AnchorLike = Pick<PromptAnchor, "english" | "chineseHint" | "displayPolicy">;
type AnchorDisplayMode = "english-only" | "english-primary" | "chinese-primary" | "acronym-compound";
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

export function normalizeSourceSurfaceAnchorText(
  source: string,
  text: string,
  slice: PromptSlice | null
): string {
  if (!slice) {
    return text;
  }

  const anchors = dedupePromptAnchors([
    ...slice.requiredAnchors,
    ...slice.repeatAnchors,
    ...slice.establishedAnchors
  ]);
  if (anchors.length === 0) {
    return text;
  }

  const sourceLines = source.split(/\r?\n/);
  const translatedLines = text.split(/\r?\n/);
  let changed = false;

  for (let index = 0; index < Math.min(sourceLines.length, translatedLines.length); index += 1) {
    const sourceLine = sourceLines[index] ?? "";
    let translatedLine = translatedLines[index] ?? "";
    const sourceAnchors = coalesceSourceLineAnchors(
      anchors.filter((anchor) => containsWholePhrase(sourceLine, anchor.english))
    );
    if (sourceAnchors.length === 0) {
      continue;
    }

    for (const sourceAnchor of sourceAnchors) {
      const siblingVariants = anchors.filter(
        (candidate) =>
          candidate.familyId === sourceAnchor.familyId &&
          candidate.anchorId !== sourceAnchor.anchorId &&
          !containsWholePhrase(sourceLine, candidate.english)
      );

      for (const variant of siblingVariants) {
        const normalizedLine = collapseUnexpectedFamilyVariant(translatedLine, variant, sourceAnchor);
        if (normalizedLine !== translatedLine) {
          translatedLine = normalizedLine;
          changed = true;
        }
      }
    }

    translatedLines[index] = translatedLine;
  }

  return changed ? translatedLines.join("\n") : text;
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
    const lineAnchors = coalesceSourceLineAnchors(
      requiredAnchors.filter((anchor) => containsWholePhrase(sourceLine, anchor.english))
    );

    for (const anchor of lineAnchors) {
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
    const lineAnchors = coalesceSourceLineAnchors(
      requiredAnchors.filter((anchor) => containsWholePhrase(sourceLine.content, anchor.english))
    );

    let normalizedLine = translatedLine.raw;
    for (const anchor of lineAnchors) {
      if (
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
  const sourceHeadingLines = extractHeadingLikeLines(source);
  const translatedHeadingLines = extractHeadingLikeLines(text);
  let changed = false;

  for (let index = 0; index < Math.min(sourceLines.length, translatedLines.length); index += 1) {
    const sourceLine = sourceLines[index] ?? "";
    let translatedLine = translatedLines[index] ?? "";

    for (const target of targets) {
      const sourceHeading = extractHeadingLikeLine(sourceLine);
      const translatedHeading = extractHeadingLikeLine(translatedLine);
      const matchingAnchor = resolvePromptAnchorForExplicitRepair(target, slice);
      const english =
        matchingAnchor?.english ??
        target.english ??
        resolveHeadingEnglishFromSource(target.chineseHint, sourceHeadingLines, translatedHeadingLines);
      if (!english) {
        continue;
      }

      if (
        sourceHeading &&
        translatedHeading &&
        stripInlineMarkdownMarkers(translatedHeading.content).includes(target.chineseHint)
      ) {
        const normalizedHeading =
          matchingAnchor && translatedHeading.content.includes(matchingAnchor.chineseHint)
            ? injectAnchorIntoLine(translatedHeading.content, matchingAnchor)
            : normalizeHeadingRepairContent(translatedHeading.content, english);
        if (normalizedHeading !== translatedHeading.content) {
          translatedLine = translatedLine.replace(translatedHeading.content, normalizedHeading);
          changed = true;
          continue;
        }
      }

      if (
        !containsWholePhrase(sourceLine, english) ||
        !translatedLine.includes(target.chineseHint) ||
        containsWholePhrase(translatedLine, english)
      ) {
        continue;
      }

      if (matchingAnchor) {
        const normalizedLine = injectAnchorIntoLine(translatedLine, matchingAnchor);
        if (normalizedLine !== translatedLine) {
          translatedLine = normalizedLine;
          changed = true;
          continue;
        }
      }

      translatedLine = translatedLine.replace(target.chineseHint, `${target.chineseHint}（${english}）`);
      changed = true;
    }

    translatedLines[index] = translatedLine;
  }

  return changed ? translatedLines.join("\n") : text;
}

function resolveHeadingEnglishFromSource(
  chineseHint: string,
  sourceHeadingLines: readonly HeadingLine[],
  translatedHeadingLines: readonly HeadingLine[]
): string | null {
  for (let index = 0; index < Math.min(sourceHeadingLines.length, translatedHeadingLines.length); index += 1) {
    const sourceHeading = sourceHeadingLines[index];
    const translatedHeading = translatedHeadingLines[index];
    if (!sourceHeading || !translatedHeading) {
      continue;
    }

    if (
      stripInlineMarkdownMarkers(translatedHeading.content).trim() === chineseHint &&
      /[A-Za-z]/.test(sourceHeading.content)
    ) {
      return sourceHeading.content.trim();
    }
  }

  return null;
}

function normalizeHeadingRepairContent(content: string, english: string): string {
  if (!english || containsWholePhrase(content, english)) {
    return content;
  }

  const parentheticalMatch = content.match(/（([^）]*[A-Za-z][^）]*)）(?!.*（)/);
  if (!parentheticalMatch?.[1]) {
    return `${content}（${english}）`;
  }

  const inner = parentheticalMatch[1].trim();
  if (containsWholePhrase(inner, english)) {
    return content;
  }

  return content.replace(parentheticalMatch[0], `（${inner}，${english}）`);
}

function resolvePromptAnchorForExplicitRepair(
  target: ExplicitRepairTarget,
  slice: PromptSlice
): PromptAnchor | null {
  const targetEnglish = target.english?.toLowerCase();
  if (!targetEnglish) {
    return null;
  }

  const anchors = dedupePromptAnchors([
    ...slice.requiredAnchors,
    ...slice.repeatAnchors,
    ...slice.establishedAnchors
  ]);

  return (
    anchors.find(
      (anchor) =>
        anchor.english.toLowerCase() === targetEnglish &&
        anchor.chineseHint !== target.english &&
        target.chineseHint.includes(anchor.chineseHint)
    ) ?? null
  );
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

  if (display.mode === "chinese-primary" || display.mode === "acronym-compound") {
    const escapedChinese = escapeRegExp(chineseHint);
    const canonical = display.canonical;

    normalized = normalized.replace(new RegExp(`${escapedEnglish}（${escapedChinese}）`, "g"), canonical);
    normalized = normalized.replace(new RegExp(`${escapedEnglish}（${escapedEnglish}）`, "g"), canonical);
    normalized = normalized.replace(new RegExp(`${escapedChinese}（${escapedEnglish}）\\s*（${escapedEnglish}）`, "g"), canonical);
    normalized = normalized.replace(new RegExp(`${escapedChinese}（${escapedChinese}）`, "g"), canonical);
    if (display.mode === "acronym-compound") {
      normalized = normalizeAcronymCompoundParentheses(normalized, display);
    }

    if (isRepeatOrEstablished) {
      normalized = normalized.replace(new RegExp(`${escapedChinese}（${escapedEnglish}）`, "g"), chineseHint);
    }

    return normalized;
  }

  if (display.mode === "english-primary") {
    const escapedChinese = escapeRegExp(chineseHint);
    const canonical = display.canonical;

    normalized = normalized.replace(
      new RegExp(`${escapedEnglish}（${escapedChinese}\\s+${escapedEnglish}）`, "g"),
      canonical
    );
    normalized = normalized.replace(
      new RegExp(`${escapedEnglish}\\s*${escapedChinese}（${escapedEnglish}）`, "g"),
      canonical
    );
    normalized = normalized.replace(
      new RegExp(`${escapedChinese}（${escapedEnglish}）`, "g"),
      canonical
    );
    normalized = normalized.replace(new RegExp(`${escapedEnglish}（${escapedEnglish}）`, "g"), canonical);
    normalized = normalizeEmbeddedEnglishPrimaryParentheses(normalized, english, canonical);

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

function collapseUnexpectedFamilyVariant(
  text: string,
  variant: PromptAnchor,
  sourceAnchor: PromptAnchor
): string {
  const variantDisplay = resolveAnchorDisplay(variant);
  const sourceDisplay = resolveAnchorDisplay(sourceAnchor);
  let normalized = text;
  const variantSuffix = variant.english.startsWith(`${sourceAnchor.english} `)
    ? variant.english.slice(sourceAnchor.english.length).trim()
    : "";

  const replacements: Array<[string, string]> = [
    [variantDisplay.canonical, sourceDisplay.canonical],
    [`${variant.english}（${sourceAnchor.english}）`, sourceDisplay.canonical],
    [`${variant.english}（${sourceDisplay.chineseDisplay}）`, sourceDisplay.canonical],
    [`${variantDisplay.canonical}（${sourceAnchor.english}）`, sourceDisplay.canonical],
    [`${sourceDisplay.canonical}（${sourceAnchor.english}）`, sourceDisplay.canonical]
  ];

  if (variantSuffix) {
    replacements.push(
      [`${sourceDisplay.canonical} ${variantSuffix}（${sourceAnchor.english}）`, sourceDisplay.canonical],
      [`${sourceDisplay.canonical} ${variantSuffix}`, sourceDisplay.canonical]
    );
  }

  for (const [from, to] of replacements) {
    if (from && to && normalized.includes(from)) {
      normalized = normalized.split(from).join(to);
    }
  }

  if (containsWholePhrase(normalized, variant.english) && !containsWholePhrase(text, sourceAnchor.english)) {
    normalized = replaceWholePhraseOnce(normalized, variant.english, sourceDisplay.canonical);
  }

  return normalized;
}

function coalesceSourceLineAnchors(anchors: readonly PromptAnchor[]): PromptAnchor[] {
  return anchors.filter(
    (anchor) =>
      !anchors.some(
        (candidate) =>
          candidate.anchorId !== anchor.anchorId &&
          candidate.familyId === anchor.familyId &&
          candidate.english.length > anchor.english.length &&
          containsWholePhrase(candidate.english, anchor.english)
      )
  );
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

function extractHeadingLikeLine(rawLine: string): HeadingLine | null {
  const trimmed = rawLine.trim();
  if (!trimmed) {
    return null;
  }

  const atxMatch = trimmed.match(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?$/);
  if (atxMatch?.[1]) {
    return { raw: rawLine, content: atxMatch[1].trim() };
  }

  const boldMatch = trimmed.match(/^\*\*(.+)\*\*$/);
  if (boldMatch?.[1]) {
    return { raw: rawLine, content: boldMatch[1].trim() };
  }

  return null;
}

type ExplicitRepairTarget = {
  chineseHint: string;
  english: string | null;
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
    instruction.match(/首现术语\s+([A-Za-z][A-Za-z0-9 .+/_-]*)\s+未补/)?.[1]?.trim() ??
    instruction.match(/[：:]\s*([A-Za-z][A-Za-z0-9 .+/_-]*)\s+首次出现需补/)?.[1]?.trim() ??
    instruction.match(/括注“([^”]*[A-Za-z][^”]*)”/)?.[1]?.trim() ??
    instruction.match(/“([^”]*[A-Za-z][^”]*)”缺少/)?.[1]?.trim() ??
    null;
  const locationText =
    instruction.match(/位置：[^。；\n“]*“([^”]+)”/)?.[1]?.trim() ??
    instruction.match(/位置：(.+?)。问题[:：]/)?.[1]?.trim() ??
    instruction.match(/`([^`]+)`/)?.[1]?.trim() ??
    null;
  const chineseHint = locationText ? stripHeadingMarkers(stripInlineMarkdownMarkers(locationText).trim()) : null;

  if (!chineseHint) {
    return null;
  }

  return { chineseHint, english };
}

function stripInlineMarkdownMarkers(text: string): string {
  return text.replace(/[*_`~]/g, "");
}

function stripHeadingMarkers(text: string): string {
  return text.replace(/^#{1,6}\s+/, "").trim();
}

function extractHeadingLikeLines(text: string): HeadingLine[] {
  const headings: HeadingLine[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const heading = extractHeadingLikeLine(rawLine);
    if (heading) {
      headings.push(heading);
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
  const strippedEnglishSuffix = stripTrailingEnglishHint(strippedEnglishPrefix ?? chineseHint, english);
  const chineseDisplay =
    sanitizeEnglishPrimaryExplainer(strippedEnglishSuffix ?? strippedEnglishPrefix ?? chineseHint, english) ??
    strippedEnglishSuffix ??
    strippedEnglishPrefix ??
    chineseHint;
  if (anchor.displayPolicy === "acronym-compound") {
    return {
      mode: "acronym-compound",
      english,
      chineseDisplay: chineseHint,
      canonical: `${chineseHint}（${english}）`,
      repeatText: chineseHint
    };
  }
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

function stripTrailingEnglishHint(chineseHint: string, english: string): string | null {
  if (!chineseHint.toLowerCase().endsWith(english.toLowerCase())) {
    return null;
  }

  const prefix = chineseHint
    .slice(0, Math.max(0, chineseHint.length - english.length))
    .trim()
    .replace(/[（(：:，,、\-–—\s]+$/u, "")
    .trim();

  return prefix.length > 0 ? prefix : null;
}

function sanitizeEnglishPrimaryExplainer(chineseHint: string, english: string): string | null {
  const embeddedPattern = new RegExp(escapeRegExp(english), "gi");
  let normalized = chineseHint.replace(embeddedPattern, "").trim();
  normalized = normalized
    .replace(/([^\s（(])（([^（）\n]+)）/gu, "$1$2")
    .replace(/([^\s(])\(([^()\n]+)\)/g, "$1$2")
    .replace(/[（(]\s*[）)]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[（(：:，,、\-–—\s]+/u, "")
    .replace(/[）)：:，,、\-–—\s]+$/u, "")
    .trim();

  if (!normalized || normalized.toLowerCase() === english.toLowerCase()) {
    return null;
  }

  return normalized;
}

function normalizeEmbeddedEnglishPrimaryParentheses(
  text: string,
  english: string,
  canonical: string
): string {
  let cursor = 0;
  let normalized = text;

  while (cursor < normalized.length) {
    const start = normalized.indexOf(`${english}（`, cursor);
    if (start === -1) {
      break;
    }

    if (!isWholePhraseBoundary(normalized, start, english.length)) {
      cursor = start + english.length;
      continue;
    }

    const openIndex = start + english.length;
    const closeIndex = findMatchingParenIndex(normalized, openIndex, "（", "）");
    if (closeIndex === -1) {
      cursor = openIndex + 1;
      continue;
    }

    const inner = normalized.slice(openIndex + 1, closeIndex).trim();
    if (inner && inner.toLowerCase().includes(english.toLowerCase())) {
      normalized = `${normalized.slice(0, start)}${canonical}${normalized.slice(closeIndex + 1)}`;
      cursor = start + canonical.length;
      continue;
    }

    cursor = closeIndex + 1;
  }

  return normalized;
}

function normalizeAcronymCompoundParentheses(text: string, display: AnchorDisplay): string {
  const acronym = getLeadingAcronymToken(display.english);
  if (!acronym) {
    return text;
  }

  const chineseRemainder = stripLeadingAcronymFromChinese(display.chineseDisplay, acronym);
  if (!chineseRemainder) {
    return text;
  }

  const escapedAcronym = escapeRegExp(acronym);
  const escapedChineseRemainder = escapeRegExp(chineseRemainder);
  const escapedEnglish = escapeRegExp(display.english);
  const canonical = display.canonical;
  let normalized = text;

  normalized = normalized.replace(
    new RegExp(`${escapedAcronym}（${escapedAcronym}）\\s*${escapedChineseRemainder}`, "g"),
    canonical
  );
  normalized = normalized.replace(
    new RegExp(`${escapedAcronym}（${escapedEnglish}）\\s*${escapedChineseRemainder}`, "g"),
    canonical
  );
  normalized = normalized.replace(
    new RegExp(`${escapedAcronym}（${escapedAcronym}）\\s*${escapedChineseRemainder}（${escapedEnglish}）`, "g"),
    canonical
  );
  normalized = normalized.replace(
    new RegExp(`${escapeRegExp(display.chineseDisplay)}（${escapedAcronym}）`, "g"),
    canonical
  );

  return normalized;
}

function findMatchingParenIndex(
  text: string,
  openIndex: number,
  openChar: string,
  closeChar: string
): number {
  let depth = 0;

  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === openChar) {
      depth += 1;
      continue;
    }

    if (text[index] === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isWholePhraseBoundary(text: string, start: number, length: number): boolean {
  const before = start === 0 ? "" : text[start - 1] ?? "";
  const after = text[start + length] ?? "";
  const boundaryPattern = /[A-Za-z0-9.+/_-]/;

  return !boundaryPattern.test(before) && !boundaryPattern.test(after);
}

function getLeadingAcronymToken(english: string): string | null {
  const [firstToken] = english.trim().split(/\s+/);
  if (!firstToken) {
    return null;
  }

  return /^[A-Z][A-Z0-9.+/_-]{1,}$/.test(firstToken) ? firstToken : null;
}

function stripLeadingAcronymFromChinese(chineseHint: string, acronym: string): string | null {
  if (!chineseHint.startsWith(acronym)) {
    return null;
  }

  const remainder = chineseHint.slice(acronym.length).trim();
  return remainder.length > 0 ? remainder : null;
}

function shouldPreferEnglishPrimary(english: string, strippedEnglishPrefix: string | null): boolean {
  if (strippedEnglishPrefix) {
    return true;
  }

  return /^[A-Za-z0-9][A-Za-z0-9.+/_-]*$/.test(english);
}
