import type { ProtectedSpan } from "./markdown-protection.js";
import {
  coalesceRequiredAnchors,
  describeAnchorDisplay,
  listAllowedAnchorDisplays,
  type AnchorDisplayMode
} from "./anchor-normalization.js";

export type AuditCheckKey =
  | "paragraph_match"
  | "first_mention_bilingual"
  | "numbers_units_logic"
  | "chinese_punctuation"
  | "unit_conversion_boundary"
  | "protected_span_integrity";

export type HardCheckState = {
  pass: boolean;
  problem: string;
};

export type SegmentKind = "fixed" | "translatable";

export type ChunkPhase = "pending" | "drafting" | "auditing" | "repairing" | "styled" | "completed" | "failed";

export type SegmentPhase =
  | "pending"
  | "drafted"
  | "audited"
  | "repairing"
  | "repaired"
  | "styled"
  | "completed"
  | "failed";

export type AnchorPositionKind = "heading" | "list" | "blockquote" | "lead_in" | "paragraph" | "other";
export type AnchorDisplayPolicy =
  | "auto"
  | "acronym-compound"
  | "english-only"
  | "english-primary"
  | "chinese-primary";

export type AnchorOccurrence = {
  chunkId: string;
  segmentId: string;
  order: number;
  positionKind: AnchorPositionKind;
};

export type AnchorState = {
  id: string;
  english: string;
  chineseHint: string;
  category?: string;
  familyId: string;
  sourceForms: string[];
  displayPolicy: AnchorDisplayPolicy;
  requiresBilingual: boolean;
  firstOccurrence: AnchorOccurrence;
  mentionSegmentIds: string[];
  status: "planned" | "established";
};

export type RepairFailureType =
  | "missing_anchor"
  | "paragraph_match"
  | "numbers_units_logic"
  | "chinese_punctuation"
  | "unit_conversion_boundary"
  | "protected_span_integrity"
  | "other";

export type RepairTask = {
  id: string;
  segmentId: string;
  anchorId: string | null;
  failureType: RepairFailureType;
  locationLabel: string;
  instruction: string;
  status: "pending" | "applied" | "verified" | "failed";
};

export type SegmentAuditResult = {
  segmentId: string;
  hardChecks: Record<AuditCheckKey, HardCheckState>;
  repairTasks: RepairTask[];
  rawMustFix: string[];
};

export type DocumentState = {
  sourcePathHint: string;
  title: string | null;
  frontmatterPresent: boolean;
  chunkCount: number;
  protectedSpanCount: number;
};

export type SegmentState = {
  id: string;
  chunkId: string;
  index: number;
  order: number;
  kind: SegmentKind;
  source: string;
  separatorAfter: string;
  spanIds: string[];
  headingHints: string[];
  specialNotes: string[];
  protectedSource: string;
  currentProtectedBody: string;
  currentRestoredBody: string;
  phase: SegmentPhase;
  threadId?: string;
  lastAudit: SegmentAuditResult | null;
  repairTaskIds: string[];
};

export type ChunkState = {
  id: string;
  index: number;
  headingPath: string[];
  source: string;
  separatorAfter: string;
  segmentIds: string[];
  phase: ChunkPhase;
  finalBody: string | null;
  lastFailure: {
    summary: string;
    segments: Array<{
      segmentId: string | null;
      segmentIndex: number;
      mustFix: string[];
    }>;
  } | null;
};

export type TranslationRunState = {
  version: 1;
  document: DocumentState;
  chunks: ChunkState[];
  segments: SegmentState[];
  anchors: AnchorState[];
  repairs: RepairTask[];
  protectedSpans: ProtectedSpan[];
};

export type SegmentSeed = {
  kind: SegmentKind;
  source: string;
  separatorAfter: string;
  spanIds: string[];
  headingHints: string[];
  specialNotes: string[];
};

export type ChunkSeed = {
  source: string;
  separatorAfter: string;
  headingPath: string[];
  segments: SegmentSeed[];
};

export type CreateTranslationRunStateInput = {
  sourcePathHint: string;
  documentTitle: string | null;
  frontmatterPresent: boolean;
  protectedSpans: ProtectedSpan[];
  chunks: ChunkSeed[];
};

export type AnalysisAnchor = {
  english: string;
  chineseHint: string;
  category?: string;
  familyKey: string;
  displayPolicy?: AnchorDisplayPolicy;
  sourceForms?: string[];
  firstOccurrence: {
    chunkId: string;
    segmentId: string;
  };
};

export type AnchorCatalog = {
  anchors: AnalysisAnchor[];
  ignoredTerms: Array<{
    english: string;
    reason: string;
  }>;
};

export type PromptSlice = {
  documentTitle: string | null;
  chunkId: string;
  segmentId: string;
  chunkIndex: number;
  segmentIndex: number;
  headingPath: string[];
  headingHints: string[];
  requiredAnchors: Array<{
    anchorId: string;
    english: string;
    chineseHint: string;
    category?: string;
    familyId: string;
    requiresBilingual: boolean;
    displayPolicy: AnchorDisplayPolicy;
    allowRepeatText?: boolean;
    displayMode?: AnchorDisplayMode;
    canonicalDisplay?: string;
    allowedDisplayForms?: string[];
  }>;
  repeatAnchors: Array<{
    anchorId: string;
    english: string;
    chineseHint: string;
    category?: string;
    familyId: string;
    requiresBilingual: boolean;
    displayPolicy: AnchorDisplayPolicy;
    allowRepeatText?: boolean;
    displayMode?: AnchorDisplayMode;
    canonicalDisplay?: string;
    allowedDisplayForms?: string[];
  }>;
  establishedAnchors: Array<{
    anchorId: string;
    english: string;
    chineseHint: string;
    category?: string;
    familyId: string;
    requiresBilingual: boolean;
    displayPolicy: AnchorDisplayPolicy;
    allowRepeatText?: boolean;
    displayMode?: AnchorDisplayMode;
    canonicalDisplay?: string;
    allowedDisplayForms?: string[];
  }>;
  protectedSpanIds: string[];
  pendingRepairs: Array<{
    repairId: string;
    anchorId: string | null;
    failureType: RepairFailureType;
    locationLabel: string;
    instruction: string;
  }>;
};

export function buildLocalFallbackAnchorId(segmentId: string, english: string): string {
  return `local:${segmentId}:${normalizeLocalFallbackAnchorKey(english)}`;
}

export function createTranslationRunState(input: CreateTranslationRunStateInput): TranslationRunState {
  const chunks: ChunkState[] = [];
  const segments: SegmentState[] = [];
  let order = 0;

  for (const [chunkIndex, chunkSeed] of input.chunks.entries()) {
    const chunkId = `chunk-${chunkIndex + 1}`;
    const segmentIds: string[] = [];

    for (const [segmentIndex, segmentSeed] of chunkSeed.segments.entries()) {
      order += 1;
      const segmentId = `${chunkId}-segment-${segmentIndex + 1}`;
      segmentIds.push(segmentId);
      segments.push({
        id: segmentId,
        chunkId,
        index: segmentIndex,
        order,
        kind: segmentSeed.kind,
        source: segmentSeed.source,
        separatorAfter: segmentSeed.separatorAfter,
        spanIds: [...segmentSeed.spanIds],
        headingHints: [...segmentSeed.headingHints],
        specialNotes: [...segmentSeed.specialNotes],
        protectedSource: segmentSeed.source,
        currentProtectedBody: segmentSeed.source,
        currentRestoredBody: segmentSeed.source,
        phase: segmentSeed.kind === "fixed" ? "completed" : "pending",
        lastAudit: null,
        repairTaskIds: []
      });
    }

    chunks.push({
      id: chunkId,
      index: chunkIndex,
      headingPath: [...chunkSeed.headingPath],
      source: chunkSeed.source,
      separatorAfter: chunkSeed.separatorAfter,
      segmentIds,
      phase: "pending",
      finalBody: null,
      lastFailure: null
    });
  }

  return {
    version: 1,
    document: {
      sourcePathHint: input.sourcePathHint,
      title: input.documentTitle,
      frontmatterPresent: input.frontmatterPresent,
      chunkCount: chunks.length,
      protectedSpanCount: input.protectedSpans.length
    },
    chunks,
    segments,
    anchors: [],
    repairs: [],
    protectedSpans: [...input.protectedSpans]
  };
}

export function getChunkState(state: TranslationRunState, chunkId: string): ChunkState {
  const chunk = state.chunks.find((item) => item.id === chunkId);
  if (!chunk) {
    throw new Error(`Unknown chunk ${chunkId}`);
  }
  return chunk;
}

export function getSegmentState(state: TranslationRunState, segmentId: string): SegmentState {
  const segment = state.segments.find((item) => item.id === segmentId);
  if (!segment) {
    throw new Error(`Unknown segment ${segmentId}`);
  }
  return segment;
}

export function getChunkSegments(state: TranslationRunState, chunkId: string): SegmentState[] {
  return getChunkState(state, chunkId).segmentIds.map((segmentId) => getSegmentState(state, segmentId));
}

export function applyAnchorCatalog(state: TranslationRunState, catalog: AnchorCatalog): void {
  state.anchors = catalog.anchors
    .map((anchor, index) => buildAnchorState(state, anchor, index))
    .filter((anchor): anchor is AnchorState => anchor !== null);
}

export function buildSegmentTaskSlice(
  state: TranslationRunState,
  chunkId: string,
  segmentId: string,
  options?: {
    currentRestoredBody?: string;
  }
): PromptSlice {
  const chunk = getChunkState(state, chunkId);
  const segment = getSegmentState(state, segmentId);
  const mentionedAnchors = state.anchors.filter((anchor) => anchor.mentionSegmentIds.includes(segmentId));
  const requiredAnchors = coalesceRequiredAnchors(
    mentionedAnchors
    .filter((anchor) => anchor.firstOccurrence.segmentId === segmentId)
    .map((anchor) => toPromptAnchor(anchor, false))
  );
  const repeatAnchors = mentionedAnchors
    .filter((anchor) => anchor.firstOccurrence.order < segment.order)
    .map((anchor) => toPromptAnchor(anchor, true));
  const establishedAnchors = state.anchors
    .filter((anchor) => anchor.status === "established" && anchor.firstOccurrence.order < segment.order)
    .map((anchor) => toPromptAnchor(anchor, true))
    .slice(0, 24);
  const pendingRepairs = state.repairs
    .filter((task) => task.segmentId === segmentId && task.status === "pending")
    .map((task) => ({
      repairId: task.id,
      anchorId: task.anchorId,
      failureType: task.failureType,
      locationLabel: task.locationLabel,
      instruction: task.instruction
    }));
  const headingHintAnchors = synthesizeHeadingHintPromptAnchors(
    segmentId,
    segment.headingHints,
    options?.currentRestoredBody ?? segment.currentRestoredBody,
    [...requiredAnchors, ...repeatAnchors, ...establishedAnchors]
  );
  const localFallbackAnchors = synthesizeLocalFallbackPromptAnchors(
    segmentId,
    segment.source,
    pendingRepairs,
    [...requiredAnchors, ...repeatAnchors, ...establishedAnchors, ...headingHintAnchors]
  );

  return {
    documentTitle: state.document.title,
    chunkId,
    segmentId,
    chunkIndex: chunk.index + 1,
    segmentIndex: segment.index + 1,
    headingPath: [...chunk.headingPath],
    headingHints: [...segment.headingHints],
    requiredAnchors: coalesceRequiredAnchors([...requiredAnchors, ...headingHintAnchors, ...localFallbackAnchors]),
    repeatAnchors,
    establishedAnchors,
    protectedSpanIds: [...segment.spanIds],
    pendingRepairs
  };
}

function synthesizeHeadingHintPromptAnchors(
  segmentId: string,
  headingHints: readonly string[],
  currentRestoredBody: string,
  existingAnchors: PromptSlice["requiredAnchors"]
): PromptSlice["requiredAnchors"] {
  if (headingHints.length === 0) {
    return [];
  }

  const translatedHeadings = extractHeadingLikeContents(currentRestoredBody);
  if (translatedHeadings.length === 0) {
    return [];
  }
  const alignedTranslatedHeadings =
    translatedHeadings.length > headingHints.length
      ? translatedHeadings.slice(translatedHeadings.length - headingHints.length)
      : translatedHeadings;

  const synthesized: PromptSlice["requiredAnchors"] = [];
  const seenEnglish = new Set(existingAnchors.map((anchor) => anchor.english.trim().toLowerCase()));
  const pairCount = Math.min(headingHints.length, alignedTranslatedHeadings.length);

  for (let index = 0; index < pairCount; index += 1) {
    const sourceHeading = headingHints[index]?.trim() ?? "";
    const translatedHeading = alignedTranslatedHeadings[index]?.trim() ?? "";
    if (!sourceHeading || !translatedHeading) {
      continue;
    }

    const planningTarget = extractHeadingPlanningTarget(sourceHeading, translatedHeading);
    if (!planningTarget) {
      continue;
    }

    const { english: headingEnglish, chineseHint } = planningTarget;
    if (!headingEnglish || !chineseHint) {
      continue;
    }

    if (containsWholePhrase(translatedHeading, headingEnglish)) {
      continue;
    }

    const normalizedKey = headingEnglish.toLowerCase();
    if (seenEnglish.has(normalizedKey)) {
      continue;
    }

    synthesized.push({
      anchorId: buildLocalFallbackAnchorId(segmentId, headingEnglish),
      english: headingEnglish,
      chineseHint,
      familyId: `local:${normalizeLocalFallbackAnchorKey(headingEnglish)}`,
      requiresBilingual: true,
      displayPolicy: "chinese-primary",
      allowRepeatText: false,
      displayMode: "chinese-primary",
      canonicalDisplay: `${chineseHint}（${headingEnglish}）`,
      allowedDisplayForms: [`${chineseHint}（${headingEnglish}）`]
    });
    seenEnglish.add(normalizedKey);
  }

  return synthesized;
}

function extractHeadingPlanningTarget(
  sourceHeading: string,
  translatedHeading: string
): { english: string; chineseHint: string } | null {
  if (isStandaloneGenericStructuralHeading(sourceHeading)) {
    return null;
  }

  const mixedQualifierTarget = extractMixedQualifierHeadingPlanningTarget(sourceHeading, translatedHeading);
  if (mixedQualifierTarget) {
    return mixedQualifierTarget;
  }

  const sourceMatch = splitHeadingColonParts(sourceHeading);
  const translatedMatch = splitHeadingColonParts(translatedHeading);
  if (sourceMatch && translatedMatch) {
    const suffixEnglish = extractHeadingPlanningEnglish(sourceMatch.suffix);
    const suffixChinese = normalizeHeadingPlanningChineseHint(translatedMatch.suffix);
    if (
      suffixEnglish &&
      suffixChinese &&
      !/[A-Za-z]/.test(translatedMatch.suffix)
    ) {
      return { english: suffixEnglish, chineseHint: suffixChinese };
    }
  }

  const directEnglish = extractHeadingPlanningEnglish(sourceHeading);
  const directChinese = normalizeHeadingPlanningChineseHint(translatedHeading);
  if (directEnglish && directChinese && isPlanningEligibleHeading(sourceHeading)) {
    return { english: directEnglish, chineseHint: directChinese };
  }

  return null;
}

function extractMixedQualifierHeadingPlanningTarget(
  sourceHeading: string,
  translatedHeading: string
): { english: string; chineseHint: string } | null {
  const sourceCore = stripInlineMarkdownMarkers(sourceHeading)
    .replace(/[：:]\s*$/, "")
    .trim();
  const translatedCore = stripInlineMarkdownMarkers(translatedHeading)
    .replace(/[：:]\s*$/, "")
    .trim();

  if (!sourceCore || !translatedCore) {
    return null;
  }

  const sourceTokens = sourceCore.split(/\s+/).filter(Boolean);
  if (sourceTokens.length < 2) {
    return null;
  }

  const suffixToken = sourceTokens[sourceTokens.length - 1] ?? "";
  if (!MIXED_QUALIFIER_HEADING_SUFFIXES.has(suffixToken.toLowerCase())) {
    return null;
  }

  const prefix = sourceTokens.slice(0, -1).join(" ").trim();
  if (!prefix || !containsWholePhrase(translatedCore, prefix)) {
    return null;
  }

  const translatedSuffix = translatedCore
    .replace(new RegExp(`^${escapeRegExp(prefix)}\\s*`, "i"), "")
    .trim();
  const chineseSuffix = normalizeHeadingPlanningChineseHint(translatedSuffix);
  if (!chineseSuffix) {
    return null;
  }

  return { english: suffixToken, chineseHint: chineseSuffix };
}

export function applySegmentDraft(
  state: TranslationRunState,
  segmentId: string,
  payload: {
    protectedSource: string;
    protectedBody: string;
    restoredBody: string;
    threadId?: string;
  }
): void {
  const segment = getSegmentState(state, segmentId);
  segment.protectedSource = payload.protectedSource;
  segment.currentProtectedBody = payload.protectedBody;
  segment.currentRestoredBody = payload.restoredBody;
  segment.phase = "drafted";
  if (payload.threadId) {
    segment.threadId = payload.threadId;
  }
}

export function applySegmentAudit(state: TranslationRunState, audit: SegmentAuditResult): void {
  const segment = getSegmentState(state, audit.segmentId);
  const existingTaskIds = new Set(segment.repairTaskIds);
  for (const task of state.repairs) {
    if (existingTaskIds.has(task.id) && (task.status === "pending" || task.status === "applied")) {
      task.status = audit.repairTasks.length === 0 ? "verified" : "failed";
    }
  }

  const newTaskIds: string[] = [];
  for (const task of audit.repairTasks) {
    state.repairs.push(task);
    newTaskIds.push(task.id);
  }

  segment.lastAudit = audit;
  segment.repairTaskIds = newTaskIds;
  segment.phase = audit.repairTasks.length === 0 ? "audited" : "failed";
  markAnchorsEstablished(state, segment.id);
}

export function applyRepairResult(
  state: TranslationRunState,
  segmentId: string,
  repairTaskIds: readonly string[],
  payload: {
    protectedBody: string;
    restoredBody: string;
    threadId?: string;
  }
): void {
  const segment = getSegmentState(state, segmentId);
  segment.currentProtectedBody = payload.protectedBody;
  segment.currentRestoredBody = payload.restoredBody;
  segment.phase = "repaired";
  if (payload.threadId) {
    segment.threadId = payload.threadId;
  }

  for (const repairId of repairTaskIds) {
    const task = state.repairs.find((item) => item.id === repairId);
    if (task) {
      task.status = "applied";
    }
  }
}

export function markSegmentStyled(state: TranslationRunState, segmentId: string): void {
  const segment = getSegmentState(state, segmentId);
  segment.phase = "styled";
}

export function markChunkPhase(state: TranslationRunState, chunkId: string, phase: ChunkPhase): void {
  getChunkState(state, chunkId).phase = phase;
}

export function markChunkFailure(
  state: TranslationRunState,
  chunkId: string,
  payload: {
    summary: string;
    segments: Array<{
      segmentId: string | null;
      segmentIndex: number;
      mustFix: string[];
    }>;
  }
): void {
  const chunk = getChunkState(state, chunkId);
  chunk.phase = "failed";
  chunk.lastFailure = {
    summary: payload.summary,
    segments: payload.segments.map((segment) => ({
      segmentId: segment.segmentId,
      segmentIndex: segment.segmentIndex,
      mustFix: [...segment.mustFix]
    }))
  };
}

export function setChunkFinalBody(state: TranslationRunState, chunkId: string, body: string): void {
  const chunk = getChunkState(state, chunkId);
  chunk.finalBody = body;
  chunk.phase = "completed";
  chunk.lastFailure = null;
}

function buildAnchorState(
  state: TranslationRunState,
  anchor: AnalysisAnchor,
  index: number
): AnchorState | null {
  const firstSegment = state.segments.find((segment) => segment.id === anchor.firstOccurrence.segmentId);
  if (!firstSegment) {
    return null;
  }

  const mentionSegmentIds = state.segments
    .filter(
      (segment) =>
        segment.kind === "translatable" &&
        containsAnyAnchorText(segment.source, anchor.sourceForms ?? [anchor.english])
    )
    .map((segment) => segment.id);

  return {
    id: `anchor-${index + 1}`,
    english: anchor.english.trim(),
    chineseHint: anchor.chineseHint.trim(),
    ...(anchor.category?.trim() ? { category: anchor.category.trim() } : {}),
    familyId: anchor.familyKey.trim() || normalizeFamilyKey(anchor.english),
    sourceForms: (anchor.sourceForms ?? [anchor.english]).map((item) => item.trim()).filter(Boolean),
    displayPolicy: anchor.displayPolicy ?? inferAnchorDisplayPolicy(anchor.english.trim(), anchor.chineseHint.trim()),
    requiresBilingual:
      (anchor.displayPolicy ?? inferAnchorDisplayPolicy(anchor.english.trim(), anchor.chineseHint.trim())) !==
      "english-only",
    firstOccurrence: {
      chunkId: anchor.firstOccurrence.chunkId,
      segmentId: anchor.firstOccurrence.segmentId,
      order: firstSegment.order,
      positionKind: inferPositionKind(firstSegment)
    },
    mentionSegmentIds,
    status: "planned"
  };
}

function toPromptAnchor(anchor: AnchorState, allowRepeatText: boolean) {
  const display = describeAnchorDisplay(anchor);
  return {
    anchorId: anchor.id,
    english: anchor.english,
    chineseHint: anchor.chineseHint,
    ...(anchor.category ? { category: anchor.category } : {}),
    familyId: anchor.familyId,
    requiresBilingual: anchor.requiresBilingual,
    displayPolicy: anchor.displayPolicy,
    allowRepeatText,
    displayMode: display.mode,
    canonicalDisplay: display.canonical,
    allowedDisplayForms: listAllowedAnchorDisplays({
      ...anchor,
      allowRepeatText
    })
  };
}

function markAnchorsEstablished(state: TranslationRunState, segmentId: string): void {
  for (const anchor of state.anchors) {
    if (anchor.firstOccurrence.segmentId === segmentId) {
      anchor.status = "established";
    }
  }
}

function containsAnchorText(source: string, english: string): boolean {
  return containsAnyAnchorText(source, [english]);
}

function containsAnyAnchorText(source: string, forms: readonly string[]): boolean {
  const normalizedSource = normalizeSourceForAnchorMatching(source);
  return forms.some((form) => containsWholePhrase(normalizedSource, form));
}

function normalizeFamilyKey(english: string): string {
  return english.trim().toLowerCase();
}

function inferAnchorDisplayPolicy(english: string, chineseHint: string): AnchorDisplayPolicy {
  const englishTokens = english.trim().split(/\s+/).filter(Boolean);
  const firstEnglishToken = englishTokens[0] ?? "";
  const acronymPattern = /^[A-Z][A-Z0-9.+/_-]{1,}$/;

  if (
    englishTokens.length >= 2 &&
    acronymPattern.test(firstEnglishToken) &&
    chineseHint.startsWith(firstEnglishToken)
  ) {
    return "acronym-compound";
  }

  if (englishTokens.length >= 2 && firstEnglishToken && chineseHint.startsWith(firstEnglishToken)) {
    return "english-primary";
  }

  return "auto";
}

function inferPositionKind(segment: SegmentState): AnchorPositionKind {
  if (segment.headingHints.length > 0) {
    return "heading";
  }

  if (segment.source.split(/\r?\n/).some((line) => line.trimStart().startsWith(">"))) {
    return "blockquote";
  }

  if (segment.source.split(/\r?\n/).some((line) => /^(\s*)([-*+]|\d+\.)\s+/.test(line.trimStart()))) {
    return "list";
  }

  if (/[:：]\s*$/.test(segment.source.trim())) {
    return "lead_in";
  }

  return "paragraph";
}

function containsWholePhrase(text: string, phrase: string): boolean {
  const trimmed = phrase.trim();
  if (!trimmed) {
    return false;
  }

  if (!/[A-Za-z0-9.+/_-]/.test(trimmed)) {
    return text.includes(trimmed);
  }

  const boundaryClass = buildBoundaryClass(trimmed);
  const pattern = new RegExp(`(^|[^${boundaryClass}])${escapeRegExp(trimmed)}($|[^${boundaryClass}])`, "i");
  return pattern.test(text);
}

function normalizeSourceForAnchorMatching(source: string): string {
  return source
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildBoundaryClass(phrase: string): string {
  let allowed = "A-Za-z0-9";
  if (phrase.includes(".")) {
    allowed += "\\.";
  }
  if (phrase.includes("+")) {
    allowed += "\\+";
  }
  if (phrase.includes("/")) {
    allowed += "/";
  }
  if (phrase.includes("_")) {
    allowed += "_";
  }
  if (phrase.includes("-")) {
    allowed += "-";
  }
  return allowed;
}

function synthesizeLocalFallbackPromptAnchors(
  segmentId: string,
  segmentSource: string,
  pendingRepairs: PromptSlice["pendingRepairs"],
  existingAnchors: PromptSlice["requiredAnchors"]
): PromptSlice["requiredAnchors"] {
  const synthesized: PromptSlice["requiredAnchors"] = [];
  const seenEnglish = new Set(existingAnchors.map((anchor) => anchor.english.trim().toLowerCase()));

  for (const repair of pendingRepairs) {
    const target = extractLocalFallbackAnchorTarget(repair.locationLabel, repair.instruction);
    if (!target) {
      continue;
    }

    const normalizedEnglish = target.english.trim();
    const normalizedKey = normalizedEnglish.toLowerCase();
    if (!normalizedEnglish || seenEnglish.has(normalizedKey)) {
      continue;
    }

    if (!containsAnyAnchorText(segmentSource, [normalizedEnglish])) {
      continue;
    }

    synthesized.push({
      anchorId: buildLocalFallbackAnchorId(segmentId, normalizedEnglish),
      english: normalizedEnglish,
      chineseHint: target.chineseHint,
      familyId: `local:${normalizeLocalFallbackAnchorKey(normalizedEnglish)}`,
      requiresBilingual: target.displayPolicy !== "english-only",
      displayPolicy: target.displayPolicy,
      allowRepeatText: false,
      displayMode: target.displayPolicy === "english-only" ? "english-only" : "chinese-primary",
      canonicalDisplay:
        target.displayPolicy === "english-only"
          ? normalizedEnglish
          : `${target.chineseHint}（${normalizedEnglish}）`,
      allowedDisplayForms:
        target.displayPolicy === "english-only"
          ? [normalizedEnglish]
          : [`${target.chineseHint}（${normalizedEnglish}）`]
    });
    seenEnglish.add(normalizedKey);
  }

  return synthesized;
}

function extractLocalFallbackAnchorTarget(
  locationLabel: string,
  instruction: string
): { english: string; chineseHint: string; displayPolicy: "english-only" | "chinese-primary" } | null {
  const englishMatches = [
    ...instruction.matchAll(/`([^`\n]*[A-Za-z][^`\n]*)`/g),
    ...instruction.matchAll(/“([^”\n]*[A-Za-z][^”\n]*)”/g)
  ]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value) => !looksCodeLikeAnchorTarget(value));

  if ((locationLabel.includes("列表项") || locationLabel.includes("项目符号")) && instruction.includes("不要只写成")) {
    if (englishMatches.length === 0) {
      return null;
    }

    const longestEnglish = [...new Set(englishMatches)].sort((left, right) => right.length - left.length)[0];
    if (!longestEnglish) {
      return null;
    }

    return {
      english: longestEnglish,
      chineseHint: longestEnglish,
      displayPolicy: "english-only"
    };
  }

  if (!locationLabel.includes("标题")) {
    return null;
  }

  const headingEnglish =
    instruction.match(/关键术语\s*[`“]([^`”\n]*[A-Za-z][^`”\n]*)[`”]/)?.[1]?.trim() ??
    instruction.match(/修复目标：[^。；\n]*[`“]([^`”\n]*[A-Za-z][^`”\n]*)[`”]/)?.[1]?.trim() ??
    null;
  const locationText =
    instruction.match(/位置：\s*`([^`\n]+)`/)?.[1]?.trim() ??
    instruction.match(/位置：\s*“([^”\n]+)”/)?.[1]?.trim() ??
    instruction.match(/当前(?:分段)?标题[`“]([^`”\n]+)[`”]/)?.[1]?.trim() ??
    null;
  const chineseHint =
    locationText ? normalizeHeadingLocalFallbackChineseHint(stripInlineMarkdownMarkers(locationText)) : null;

  if (!headingEnglish || !chineseHint || /[A-Za-z]/.test(chineseHint)) {
    return null;
  }

  return {
    english: headingEnglish,
    chineseHint,
    displayPolicy: "chinese-primary"
  };
}

function looksCodeLikeAnchorTarget(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }

  return (
    trimmed.startsWith("--") ||
    trimmed.startsWith(".") ||
    trimmed.includes("/") ||
    /[(){}[\]<>]/.test(trimmed)
  );
}

function normalizeLocalFallbackAnchorKey(english: string): string {
  return english.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function stripInlineMarkdownMarkers(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

function normalizeHeadingLocalFallbackChineseHint(text: string): string {
  return text.replace(/（[\u4e00-\u9fff\s]+）\s*$/u, "").trim();
}

function extractHeadingLikeContents(text: string): string[] {
  const headings: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    const atxMatch = trimmed.match(/^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?$/);
    if (atxMatch?.[1]) {
      headings.push(atxMatch[1].trim());
      continue;
    }

    const boldMatch = trimmed.match(/^\*\*(.+)\*\*$/);
    if (boldMatch?.[1]) {
      headings.push(boldMatch[1].trim());
    }
  }

  return headings;
}

function normalizeHeadingPlanningChineseHint(text: string): string | null {
  const stripped = stripInlineMarkdownMarkers(text)
    .replace(/[：:]\s*$/, "")
    .replace(/（[\u4e00-\u9fff\s]+）\s*$/u, "")
    .trim();
  if (!stripped || /[A-Za-z]/.test(stripped)) {
    return null;
  }
  return stripped;
}

function extractHeadingPlanningEnglish(sourceHeading: string): string | null {
  const strippedQualifier = sourceHeading.replace(/\s+\(([^)]*[A-Za-z][^)]*)\)\s*$/, "").trim();
  const withoutColon = strippedQualifier.replace(/[：:]\s*$/, "").trim();
  if (!withoutColon || !/[A-Za-z]/.test(withoutColon)) {
    return null;
  }
  return withoutColon;
}

function isPlanningEligibleHeading(sourceHeading: string): boolean {
  const stripped = stripInlineMarkdownMarkers(sourceHeading).trim();
  if (!stripped || !/[A-Za-z]/.test(stripped) || shouldSkipOperationalHeadingPlanning(stripped)) {
    return false;
  }

  const withoutQualifier = stripped.replace(/\s+\(([^)]*[A-Za-z][^)]*)\)\s*$/, "").trim();
  if (
    /^[A-Za-z][A-Za-z0-9 ]{0,30}\d+\s*:\s*[A-Za-z]/.test(withoutQualifier) ||
    /^[A-Za-z][A-Za-z0-9 ]{0,30}\s*:\s*[A-Za-z]/.test(withoutQualifier)
  ) {
    return false;
  }

  const firstToken = withoutQualifier.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (QUESTION_HEADING_TOKENS.has(firstToken)) {
    return false;
  }

  const core = withoutQualifier.replace(/[：:]\s*$/, "").trim();
  const wordCount = core.split(/\s+/).filter(Boolean).length;
  if (wordCount === 1 && !/[：:()]/.test(stripped)) {
    return false;
  }

  return wordCount > 0 && wordCount <= 4;
}

function splitHeadingColonParts(text: string): { prefix: string; suffix: string } | null {
  const stripped = stripInlineMarkdownMarkers(text).trim();
  const match = stripped.match(/^(.*?[：:]\s*)(.+)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    prefix: match[1].trim(),
    suffix: match[2].trim()
  };
}

function isStandaloneGenericStructuralHeading(sourceHeading: string): boolean {
  const core = stripInlineMarkdownMarkers(sourceHeading)
    .replace(/[：:]\s*$/, "")
    .trim()
    .toLowerCase();
  return STANDALONE_GENERIC_STRUCTURAL_HEADINGS.has(core);
}

function shouldSkipOperationalHeadingPlanning(sourceHeading: string): boolean {
  const normalized = stripInlineMarkdownMarkers(sourceHeading).trim().toLowerCase();
  const firstToken = normalized.split(/\s+/)[0] ?? "";
  return OPERATIONAL_HEADING_VERBS.has(firstToken);
}

const QUESTION_HEADING_TOKENS = new Set(["how", "what", "why", "when", "where", "which"]);

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

const STANDALONE_GENERIC_STRUCTURAL_HEADINGS = new Set([
  "example",
  "examples",
  "note",
  "notes",
  "overview",
  "summary",
  "summaries"
]);

const MIXED_QUALIFIER_HEADING_SUFFIXES = new Set([
  "pattern",
  "patterns",
  "syntax",
  "rule",
  "rules",
  "type",
  "types"
]);
