import type { PromptSlice } from "./translation-state.js";

export type PromptAnchor = PromptSlice["requiredAnchors"][number];
type AnchorLike = Pick<PromptAnchor, "english" | "chineseHint" | "displayPolicy">;
export type AnchorDisplayMode =
  | "english-only"
  | "english-primary"
  | "chinese-primary"
  | "acronym-compound";
export type AnchorDisplay = {
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

export function describeAnchorDisplay(anchor: AnchorLike): AnchorDisplay {
  return resolveAnchorDisplay(anchor);
}

export function listAllowedAnchorDisplays(anchor: AnchorLike): string[] {
  const display = resolveAnchorDisplay(anchor);
  const allowed = new Set<string>();

  if (display.canonical) {
    allowed.add(display.canonical);
  }

  if (display.mode === "english-only" && display.english) {
    allowed.add(display.english);
  }

  return [...allowed];
}

export function lineSatisfiesAnchorDisplay(text: string, anchor: AnchorLike): boolean {
  const allowedDisplays = listAllowedAnchorDisplays(anchor);
  if (allowedDisplays.some((display) => display && text.includes(display))) {
    return true;
  }

  const display = resolveAnchorDisplay(anchor);
  if (display.mode === "english-only" && display.english) {
    return containsWholePhrase(text, display.english);
  }

  return false;
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
      requiredAnchors.filter((anchor) => containsSourceAnchorPhrase(sourceLine, anchor.english))
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
  const sourceHeadingLines = extractHeadingLikeLines(source);
  const translatedHeadingLines = extractHeadingLikeLines(text);
  if (sourceHeadingLines.length === 0 || translatedHeadingLines.length === 0) {
    return text;
  }
  const operationalSourceHeadings = sourceHeadingLines
    .filter((heading) => shouldSkipWholeHeadingAnchorInjectionFromSource(heading.content))
    .map((heading) => heading.content);

  let normalized = text;

  for (const translatedHeading of translatedHeadingLines) {
    let normalizedLine = translatedHeading.raw;

    for (const operationalHeading of operationalSourceHeadings) {
      const strippedOperationalLine = stripOperationalHeadingAnchor(normalizedLine, operationalHeading);
      if (strippedOperationalLine !== normalizedLine) {
        normalizedLine = strippedOperationalLine;
        break;
      }
    }

    normalizedLine = stripRepeatedEnglishSubanchorParentheticals(normalizedLine);

    if (normalizedLine !== translatedHeading.raw) {
      normalized = normalized.replace(translatedHeading.raw, normalizedLine);
    }
  }

  for (let index = 0; index < Math.min(sourceHeadingLines.length, translatedHeadingLines.length); index += 1) {
    const sourceLine = sourceHeadingLines[index]!;
    const translatedLine = translatedHeadingLines[index]!;
    let normalizedLine = translatedLine.raw;

    const allHeadingAnchors = requiredAnchors.filter((anchor) =>
      containsSourceAnchorPhrase(sourceLine.content, anchor.english)
    );
    const lineAnchors = coalesceHeadingLineAnchors(allHeadingAnchors);
    const shadowedAnchors = getShadowedHeadingLineAnchors(allHeadingAnchors);

    for (const shadowedAnchor of shadowedAnchors) {
      normalizedLine = stripShadowedHeadingAnchor(normalizedLine, shadowedAnchor);
    }

    const templateRestoredLine = restoreHeadingTemplateLine(sourceLine, normalizedLine, lineAnchors);
    if (templateRestoredLine !== normalizedLine) {
      normalizedLine = templateRestoredLine;
    }

    for (const anchor of lineAnchors) {
      const headingEnglish = normalizeHeadingAnchorEnglishForLine(anchor.english, translatedLine.content);
      if (shouldSkipWholeHeadingAnchorInjection(sourceLine.content, anchor.english)) {
        normalizedLine = stripOperationalHeadingAnchor(normalizedLine, headingEnglish);
        continue;
      }
      if (
        !anchor.chineseHint ||
        anchor.chineseHint.toLowerCase() === headingEnglish.toLowerCase() ||
        !normalizedLine.includes(anchor.chineseHint) ||
        containsWholePhrase(normalizedLine, headingEnglish)
      ) {
        continue;
      }

      normalizedLine = normalizedLine.replace(
        anchor.chineseHint,
        `${anchor.chineseHint}（${headingEnglish}）`
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

      if (sourceHeading && translatedHeading) {
        if (shouldSkipWholeHeadingAnchorInjectionFromSource(sourceHeading.content)) {
          const strippedHeading = stripOperationalHeadingAnchor(translatedHeading.content, sourceHeading.content);
          if (strippedHeading !== translatedHeading.content) {
            translatedLine = translatedLine.replace(translatedHeading.content, strippedHeading);
            changed = true;
            continue;
          }
        }
      }

      const matchingAnchor = resolvePromptAnchorForExplicitRepair(target, slice);
      const english =
        matchingAnchor?.english ??
        target.english ??
        resolveHeadingEnglishFromSource(target.chineseHint, sourceHeadingLines, translatedHeadingLines);
      if (!english) {
        continue;
      }

      if (sourceHeading && translatedHeading) {
        if (
          stripInlineMarkdownMarkers(translatedHeading.content).includes(target.chineseHint)
        ) {
          const headingAnchors = coalesceHeadingLineAnchors(
            dedupePromptAnchors([
              ...slice.requiredAnchors,
              ...slice.repeatAnchors,
              ...slice.establishedAnchors
            ]).filter((anchor) => containsSourceAnchorPhrase(sourceHeading.content, anchor.english))
          );
          const templateRestoredHeading = restoreHeadingTemplateLine(
            sourceHeading,
            translatedLine,
            headingAnchors
          );
          if (templateRestoredHeading !== translatedLine) {
            translatedLine = templateRestoredHeading;
            changed = true;
            continue;
          }

          if (shouldSkipWholeHeadingAnchorInjection(sourceHeading.content, english)) {
            const strippedHeading = stripOperationalHeadingAnchor(translatedHeading.content, english);
            if (strippedHeading !== translatedHeading.content) {
              translatedLine = translatedLine.replace(translatedHeading.content, strippedHeading);
              changed = true;
              continue;
            }
          }

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
      }

      if (
        !containsSourceAnchorPhrase(sourceLine, english) ||
        !translatedLine.includes(target.chineseHint) ||
        containsWholePhrase(translatedLine, normalizeHeadingAnchorEnglishForLine(english, translatedLine))
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

function restoreHeadingTemplateLine(
  sourceHeading: HeadingLine,
  translatedRawLine: string,
  anchors: readonly PromptAnchor[]
): string {
  const translatedHeading = extractHeadingLikeLine(translatedRawLine);
  if (!translatedHeading || anchors.length === 0) {
    return translatedRawLine;
  }

  const exactAnchor = anchors.find(
    (anchor) =>
      normalizeAnchorEnglishForSourceMatch(sourceHeading.content) ===
      normalizeAnchorEnglishForSourceMatch(anchor.english)
  );
  if (exactAnchor) {
    const canonicalContent = buildCanonicalHeadingContent(exactAnchor, translatedHeading.content);
    if (canonicalContent && canonicalContent !== translatedHeading.content) {
      return translatedRawLine.replace(translatedHeading.content, canonicalContent);
    }
  }

  for (const anchor of anchors) {
    const suffixPrefix = extractHeadingSourcePrefix(sourceHeading.content, anchor.english);
    if (!suffixPrefix) {
      continue;
    }

    const translatedPrefix = deriveTranslatedHeadingPrefix(translatedHeading.content, anchor);
    if (!translatedPrefix) {
      continue;
    }

    const canonicalContent = `${translatedPrefix}${buildCanonicalHeadingContent(anchor, translatedHeading.content)}`;
    if (canonicalContent !== translatedHeading.content) {
      return translatedRawLine.replace(translatedHeading.content, canonicalContent);
    }
  }

  return translatedRawLine;
}

function extractHeadingSourcePrefix(sourceHeadingContent: string, english: string): string | null {
  const trimmedSource = sourceHeadingContent.trim();
  const trimmedEnglish = english.trim();
  if (!trimmedSource.toLowerCase().endsWith(trimmedEnglish.toLowerCase())) {
    return null;
  }

  const index = trimmedSource.length - trimmedEnglish.length;
  if (index <= 0) {
    return null;
  }

  const prefix = trimmedSource.slice(0, index);
  return prefix.length > 0 ? prefix : null;
}

function deriveTranslatedHeadingPrefix(content: string, anchor: PromptAnchor): string | null {
  const display = resolveAnchorDisplay(anchor);
  const candidates = [
    anchor.chineseHint,
    display.chineseDisplay,
    display.canonical,
    anchor.english
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  for (const candidate of candidates) {
    const index = content.indexOf(candidate);
    if (index > 0) {
      return content.slice(0, index);
    }
  }

  const colonMatch = content.match(/^(.*?[：:]\s*)/);
  if (colonMatch?.[1]) {
    return colonMatch[1];
  }

  return null;
}

function buildCanonicalHeadingContent(anchor: PromptAnchor, translatedHeadingContent: string): string {
  const display = resolveAnchorDisplay(anchor);
  const normalizedEnglish = normalizeHeadingAnchorEnglishForLine(anchor.english, translatedHeadingContent);

  if (display.mode === "english-only") {
    return normalizedEnglish;
  }

  if (display.mode === "english-primary") {
    return `${normalizedEnglish}（${display.chineseDisplay}）`;
  }

  if (/[：:]\s*$/.test(stripInlineMarkdownMarkers(translatedHeadingContent).trim())) {
    const bareHeadingContent = translatedHeadingContent.replace(/（[^）]*）/g, "").trim();
    return injectHeadingEnglishBeforeTrailingColon(bareHeadingContent, normalizedEnglish);
  }

  return `${display.chineseDisplay}（${normalizedEnglish}）`;
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
  const normalizedEnglish = normalizeHeadingAnchorEnglishForLine(english, content);
  if (!normalizedEnglish || containsWholePhrase(content, normalizedEnglish)) {
    return content;
  }

  const parentheticalMatch = content.match(/（([^）]*[A-Za-z][^）]*)）(?!.*（)/);
  if (!parentheticalMatch?.[1]) {
    return injectHeadingEnglishBeforeTrailingColon(content, normalizedEnglish);
  }

  const inner = parentheticalMatch[1].trim();
  if (containsWholePhrase(inner, normalizedEnglish)) {
    return content;
  }

  return content.replace(parentheticalMatch[0], `（${inner}，${normalizedEnglish}）`);
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

function coalesceHeadingLineAnchors(anchors: readonly PromptAnchor[]): PromptAnchor[] {
  return anchors.filter(
    (anchor) =>
      !anchors.some(
        (candidate) =>
          candidate.anchorId !== anchor.anchorId &&
          candidate.english.length > anchor.english.length &&
          containsWholePhrase(candidate.english, anchor.english)
      )
  );
}

function getShadowedHeadingLineAnchors(anchors: readonly PromptAnchor[]): PromptAnchor[] {
  return anchors.filter((anchor) =>
    anchors.some(
      (candidate) =>
        candidate.anchorId !== anchor.anchorId &&
        candidate.english.length > anchor.english.length &&
        containsWholePhrase(candidate.english, anchor.english)
    )
  );
}

function stripShadowedHeadingAnchor(content: string, anchor: PromptAnchor): string {
  const escapedEnglish = escapeRegExp(anchor.english.trim());
  return content
    .replace(new RegExp(`（${escapedEnglish}（[^）]+））`, "g"), " ")
    .replace(new RegExp(`（${escapedEnglish}）`, "g"), " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/（\s*）/g, "")
    .replace(/\s+([：:）])/g, "$1");
}

function stripRepeatedEnglishSubanchorParentheticals(content: string): string {
  const stripRepeated = (input: string, pattern: RegExp): string =>
    input.replace(pattern, (raw: string, englishRaw: string, ...args: unknown[]) => {
      const offset = typeof args.at(-2) === "number" ? (args.at(-2) as number) : -1;
      const english = String(englishRaw).trim();
      if (!english || offset < 0) {
        return raw;
      }

      const prefix = input.slice(0, offset);
      return containsWholePhrase(prefix, english) ? " " : raw;
    });

  return stripRepeated(
    stripRepeated(content, /（([A-Za-z][A-Za-z0-9.+/_-]*)（[^（）\n]+））/g),
    /（([A-Za-z][A-Za-z0-9.+/_-]*)）/g
  )
    .replace(/[ ]{2,}/g, " ")
    .replace(/\s+([：:）])/g, "$1")
    .trimEnd();
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
    instruction.match(/当前(?:分段)?标题“([^”]+)”/)?.[1]?.trim() ??
    instruction.match(/`([^`]+)`/)?.[1]?.trim() ??
    null;
  const chineseHint = locationText
    ? normalizeExplicitRepairChineseHint(stripHeadingMarkers(stripInlineMarkdownMarkers(locationText).trim()))
    : null;

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

function normalizeHeadingAnchorEnglishForLine(english: string, translatedHeadingContent: string): string {
  const trimmedEnglish = english.trim();
  const strippedEnglish = trimmedEnglish.replace(/[：:]+$/, "").trim();
  const normalizedHeadingContent = stripInlineMarkdownMarkers(translatedHeadingContent).trim();
  if (strippedEnglish && strippedEnglish !== trimmedEnglish && /[：:]\s*$/.test(normalizedHeadingContent)) {
    return strippedEnglish;
  }

  return trimmedEnglish;
}

function normalizeAnchorEnglishForSourceMatch(english: string): string {
  return english.trim().replace(/[：:]+$/, "").trim();
}

function containsSourceAnchorPhrase(haystack: string, needle: string): boolean {
  if (containsWholePhrase(haystack, needle)) {
    return true;
  }

  const normalizedNeedle = normalizeAnchorEnglishForSourceMatch(needle);
  return normalizedNeedle.length > 0 && normalizedNeedle !== needle && containsWholePhrase(haystack, normalizedNeedle);
}

function normalizeExplicitRepairChineseHint(text: string): string {
  return text
    .replace(/（[^）]*[A-Za-z][^）]*）(?=[：:])/g, "")
    .replace(/[：:]{2,}/g, "：")
    .replace(/\s+/g, " ")
    .trim();
}

function injectHeadingEnglishBeforeTrailingColon(content: string, english: string): string {
  const trimmed = content.trimEnd();
  const trailingColonMatch = trimmed.match(/([：:])$/);
  if (!trailingColonMatch?.[1]) {
    return `${content}（${english}）`;
  }

  const colon = trailingColonMatch[1];
  const withoutColon = trimmed.slice(0, -colon.length);
  const trailingWhitespace = content.slice(trimmed.length);
  return `${withoutColon}（${english}）${colon}${trailingWhitespace}`;
}

function shouldSkipWholeHeadingAnchorInjection(sourceHeadingContent: string, english: string): boolean {
  const normalizedSource = normalizeAnchorEnglishForSourceMatch(stripInlineMarkdownMarkers(sourceHeadingContent));
  const normalizedEnglish = normalizeAnchorEnglishForSourceMatch(english);
  if (!normalizedSource || !normalizedEnglish || normalizedSource !== normalizedEnglish) {
    return false;
  }

  const firstToken = normalizedSource.split(/\s+/)[0]?.toLowerCase() ?? "";
  return OPERATIONAL_HEADING_VERBS.has(firstToken);
}

function shouldSkipWholeHeadingAnchorInjectionFromSource(sourceHeadingContent: string): boolean {
  const normalizedSource = normalizeAnchorEnglishForSourceMatch(stripInlineMarkdownMarkers(sourceHeadingContent));
  if (!normalizedSource) {
    return false;
  }

  const firstToken = normalizedSource.split(/\s+/)[0]?.toLowerCase() ?? "";
  return OPERATIONAL_HEADING_VERBS.has(firstToken);
}

function stripOperationalHeadingAnchor(content: string, english: string): string {
  const normalizedEnglish = normalizeHeadingAnchorEnglishForLine(english, content);
  const variants = [normalizedEnglish, english.trim()].filter(Boolean);
  let normalized = content;

  for (const variant of variants) {
    const escapedVariant = escapeRegExp(variant);
    normalized = normalized.replace(new RegExp(`（${escapedVariant}[：:]*）(?=[：:])`, "g"), "");
    normalized = normalized.replace(new RegExp(`（${escapedVariant}[：:]*）`, "g"), "");
  }

  return normalized.replace(/[ ]{2,}/g, " ").replace(/：：+/g, "：").replace(/::+/g, ":");
}

const OPERATIONAL_HEADING_VERBS = new Set([
  "view",
  "edit",
  "disable",
  "enable",
  "check",
  "reset",
  "show",
  "list",
  "configure",
  "set",
  "get",
  "change",
  "update",
  "open",
  "close",
  "run",
  "create",
  "delete",
  "remove",
  "install"
]);

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
