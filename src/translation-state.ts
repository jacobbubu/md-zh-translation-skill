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
export type HeadingPlanStrategy =
  | "none"
  | "concept"
  | "source-template"
  | "mixed-qualifier"
  | "natural-heading";

export type EmphasisPlanStrategy = "preserve-strong" | "none";

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

export type StructuredRepairTarget = {
  location: string;
  kind: "anchor" | "heading" | "sentence" | "blockquote" | "list_item" | "lead_in" | "block" | "other";
  currentText?: string;
  targetText?: string;
  english?: string;
  chineseHint?: string;
  forbiddenTerms?: string[];
  sourceReferenceTexts?: string[];
};

export type RepairTask = {
  id: string;
  segmentId: string;
  anchorId: string | null;
  failureType: RepairFailureType;
  locationLabel: string;
  instruction: string;
  structuredTarget?: StructuredRepairTarget;
  sentenceConstraint?: {
    quotedText?: string;
    forbiddenTerms?: string[];
    sourceReferenceTexts?: string[];
  };
  analysisPlanIds?: string[];
  analysisPlanKinds?: Array<PromptAnalysisPlan["kind"]>;
  analysisTargets?: string[];
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
  headingPlans: HeadingPlanState[];
  emphasisPlans: EmphasisPlanState[];
  blockPlans: BlockPlanState[];
  aliasPlans: AliasPlanState[];
  entityDisambiguationPlans: EntityDisambiguationPlanState[];
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
      structuredTargets?: StructuredRepairTarget[];
      sentenceConstraint?: {
        quotedText?: string;
        forbiddenTerms?: string[];
        sourceReferenceTexts?: string[];
      };
      analysisPlanIds?: string[];
      analysisTargets?: string[];
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

export type AnalysisHeadingPlan = {
  chunkId: string;
  segmentId: string;
  headingIndex?: number;
  sourceHeading: string;
  strategy: HeadingPlanStrategy;
  targetHeading?: string;
  governedTerms?: string[];
  english?: string;
  chineseHint?: string;
  category?: string;
  displayPolicy?: AnchorDisplayPolicy;
};

export type AnalysisEmphasisPlan = {
  chunkId: string;
  segmentId: string;
  emphasisIndex?: number;
  lineIndex?: number;
  sourceText: string;
  strategy: EmphasisPlanStrategy;
  targetText?: string;
  governedTerms?: string[];
};

export type AnalysisBlockPlan = {
  chunkId: string;
  segmentId: string;
  blockIndex: number;
  blockKind: PromptBlockPlan["blockKind"];
  sourceText: string;
  targetText?: string;
};

export type AnalysisAliasPlan = {
  chunkId: string;
  segmentId: string;
  lineIndex?: number;
  sourceText: string;
  currentText?: string;
  targetText: string;
  english?: string;
  chineseHint?: string;
};

export type AnalysisEntityDisambiguationPlan = {
  chunkId: string;
  segmentId: string;
  lineIndex?: number;
  sourceText: string;
  currentText?: string;
  targetText: string;
  english?: string;
  forbiddenDisplays?: string[];
};

export type AnchorCatalog = {
  anchors: AnalysisAnchor[];
  ignoredTerms: Array<{
    english: string;
    reason: string;
  }>;
  headingPlans?: AnalysisHeadingPlan[];
  emphasisPlans?: AnalysisEmphasisPlan[];
  blockPlans?: AnalysisBlockPlan[];
  aliasPlans?: AnalysisAliasPlan[];
  entityDisambiguationPlans?: AnalysisEntityDisambiguationPlan[];
};

export type HeadingPlanState = AnalysisHeadingPlan;
export type EmphasisPlanState = AnalysisEmphasisPlan;
export type BlockPlanState = AnalysisBlockPlan;
export type AliasPlanState = AnalysisAliasPlan;
export type EntityDisambiguationPlanState = AnalysisEntityDisambiguationPlan;

export type PromptAnalysisPlan = {
  id: string;
  kind: "anchor" | "heading" | "emphasis" | "block" | "alias" | "disambiguation";
  scope: "required" | "repeat" | "established" | "local";
  sourceText: string;
  currentText?: string;
  targetText?: string;
  anchorId?: string;
  blockIndex?: number;
  blockKind?: "heading" | "blockquote" | "list" | "code" | "paragraph";
  english?: string;
  chineseHint?: string;
  category?: string;
  displayPolicy?: AnchorDisplayPolicy;
  strategy?: HeadingPlanStrategy | EmphasisPlanStrategy;
  governedTerms?: string[];
  lineIndex?: number;
  forbiddenDisplays?: string[];
};

export type PromptBlockPlan = {
  blockIndex: number;
  blockKind: "heading" | "blockquote" | "list" | "code" | "paragraph";
  sourceText: string;
  targetText?: string;
};

export type PromptSlice = {
  documentTitle: string | null;
  chunkId: string;
  segmentId: string;
  chunkIndex: number;
  segmentIndex: number;
  headingPath: string[];
  headingHints: string[];
  headingPlans: Array<{
    headingIndex?: number;
    sourceHeading: string;
    strategy: HeadingPlanStrategy;
    targetHeading?: string;
    governedTerms?: string[];
    english?: string;
    chineseHint?: string;
    category?: string;
    displayPolicy?: AnchorDisplayPolicy;
  }>;
  emphasisPlans: Array<{
    emphasisIndex?: number;
    lineIndex?: number;
    sourceText: string;
    strategy: EmphasisPlanStrategy;
    targetText?: string;
    governedTerms?: string[];
  }>;
  aliasPlans: Array<{
    lineIndex?: number;
    sourceText: string;
    currentText?: string;
    targetText: string;
    english?: string;
    chineseHint?: string;
  }>;
  entityDisambiguationPlans: Array<{
    lineIndex?: number;
    sourceText: string;
    currentText?: string;
    targetText: string;
    english?: string;
    forbiddenDisplays?: string[];
  }>;
  blockPlans: PromptBlockPlan[];
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
    structuredTarget?: StructuredRepairTarget;
    sentenceConstraint?: {
      quotedText?: string;
      forbiddenTerms?: string[];
      sourceReferenceTexts?: string[];
    };
    analysisPlanIds?: string[];
    analysisPlanKinds?: Array<PromptAnalysisPlan["kind"]>;
    analysisTargets?: string[];
  }>;
  headingPlanGovernedAnchorIds: string[];
  analysisPlans: PromptAnalysisPlan[];
  analysisPlanDraft: string;
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
        headingPlans: [],
        emphasisPlans: [],
        blockPlans: [],
        aliasPlans: [],
        entityDisambiguationPlans: [],
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

  for (const segment of state.segments) {
    segment.headingPlans = [];
    segment.emphasisPlans = [];
    segment.blockPlans = [];
    segment.aliasPlans = [];
    segment.entityDisambiguationPlans = [];
  }

  for (const plan of catalog.headingPlans ?? []) {
    const segment = state.segments.find((item) => item.id === plan.segmentId);
    if (!segment) {
      continue;
    }

    segment.headingPlans.push({
      chunkId: plan.chunkId,
      segmentId: plan.segmentId,
      ...(typeof plan.headingIndex === "number" ? { headingIndex: plan.headingIndex } : {}),
      sourceHeading: plan.sourceHeading.trim(),
      strategy: plan.strategy,
      ...(plan.targetHeading?.trim() ? { targetHeading: plan.targetHeading.trim() } : {}),
      ...(Array.isArray(plan.governedTerms)
        ? {
            governedTerms: plan.governedTerms.map((term) => term.trim()).filter(Boolean)
          }
        : {}),
      ...(plan.english?.trim() ? { english: plan.english.trim() } : {}),
      ...(plan.chineseHint?.trim() ? { chineseHint: plan.chineseHint.trim() } : {}),
      ...(plan.category?.trim() ? { category: plan.category.trim() } : {}),
      ...(plan.displayPolicy ? { displayPolicy: plan.displayPolicy } : {})
    });
  }

  for (const plan of catalog.emphasisPlans ?? []) {
    const segment = state.segments.find((item) => item.id === plan.segmentId);
    if (!segment) {
      continue;
    }

    segment.emphasisPlans.push({
      chunkId: plan.chunkId,
      segmentId: plan.segmentId,
      ...(typeof plan.emphasisIndex === "number" ? { emphasisIndex: plan.emphasisIndex } : {}),
      ...(typeof plan.lineIndex === "number" ? { lineIndex: plan.lineIndex } : {}),
      sourceText: plan.sourceText.trim(),
      strategy: plan.strategy,
      ...(plan.targetText?.trim() ? { targetText: plan.targetText.trim() } : {}),
      ...(Array.isArray(plan.governedTerms)
        ? {
            governedTerms: plan.governedTerms.map((term) => term.trim()).filter(Boolean)
          }
        : {})
    });
  }

  for (const plan of catalog.blockPlans ?? []) {
    const segment = state.segments.find((item) => item.id === plan.segmentId);
    if (!segment) {
      continue;
    }

    segment.blockPlans.push({
      chunkId: plan.chunkId,
      segmentId: plan.segmentId,
      blockIndex: plan.blockIndex,
      blockKind: plan.blockKind,
      sourceText: plan.sourceText.trim(),
      ...(plan.targetText?.trim() ? { targetText: plan.targetText.trim() } : {})
    });
  }

  for (const plan of catalog.aliasPlans ?? []) {
    const segment = state.segments.find((item) => item.id === plan.segmentId);
    if (!segment) {
      continue;
    }

    segment.aliasPlans.push({
      chunkId: plan.chunkId,
      segmentId: plan.segmentId,
      ...(typeof plan.lineIndex === "number" ? { lineIndex: plan.lineIndex } : {}),
      sourceText: plan.sourceText.trim(),
      ...(plan.currentText?.trim() ? { currentText: plan.currentText.trim() } : {}),
      targetText: plan.targetText.trim(),
      ...(plan.english?.trim() ? { english: plan.english.trim() } : {}),
      ...(plan.chineseHint?.trim() ? { chineseHint: plan.chineseHint.trim() } : {})
    });
  }

  for (const plan of catalog.entityDisambiguationPlans ?? []) {
    const segment = state.segments.find((item) => item.id === plan.segmentId);
    if (!segment) {
      continue;
    }

    segment.entityDisambiguationPlans.push({
      chunkId: plan.chunkId,
      segmentId: plan.segmentId,
      ...(typeof plan.lineIndex === "number" ? { lineIndex: plan.lineIndex } : {}),
      sourceText: plan.sourceText.trim(),
      ...(plan.currentText?.trim() ? { currentText: plan.currentText.trim() } : {}),
      targetText: plan.targetText.trim(),
      ...(plan.english?.trim() ? { english: plan.english.trim() } : {}),
      ...(Array.isArray(plan.forbiddenDisplays)
        ? {
            forbiddenDisplays: plan.forbiddenDisplays.map((item) => item.trim()).filter(Boolean)
          }
        : {})
    });
  }
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
  const reconciledPlans = reconcileSegmentSemanticPlans(state, segment);
  const headingPlans = reconciledPlans.headingPlans;
  const blockPlanStates = reconciledPlans.blockPlans;
  const emphasisPlans = reconciledPlans.emphasisPlans;
  const rawMentionedAnchors = state.anchors.filter((anchor) => anchor.mentionSegmentIds.includes(segmentId));
  const disambiguationGovernedAnchorIds = collectEntityDisambiguationGovernedAnchorIds(
    segment.entityDisambiguationPlans,
    rawMentionedAnchors
  );
  const mentionedAnchors = rawMentionedAnchors.filter((anchor) => !disambiguationGovernedAnchorIds.has(anchor.id));
  const headingPlanGovernedAnchorIds = collectHeadingPlanGovernedAnchorIds(
    headingPlans,
    segment.headingHints,
    mentionedAnchors
  );
  const headingFilteredAnchors = mentionedAnchors.filter((anchor) => !headingPlanGovernedAnchorIds.has(anchor.id));
  const requiredAnchors = coalesceRequiredAnchors(
    headingFilteredAnchors
    .filter((anchor) => anchor.firstOccurrence.segmentId === segmentId)
    .map((anchor) => toPromptAnchor(anchor, false))
  );
  const repeatAnchors = headingFilteredAnchors
    .filter((anchor) => anchor.firstOccurrence.order < segment.order)
    .map((anchor) => toPromptAnchor(anchor, true));
  const establishedAnchors = state.anchors
    .filter(
      (anchor) =>
        anchor.status === "established" &&
        anchor.firstOccurrence.order < segment.order &&
        !headingPlanGovernedAnchorIds.has(anchor.id)
    )
    .map((anchor) => toPromptAnchor(anchor, true))
    .slice(0, 24);
  const rawPendingRepairs = state.repairs
    .filter((task) => task.segmentId === segmentId && task.status === "pending")
    .map((task) => ({
      repairId: task.id,
      anchorId: task.anchorId,
      failureType: task.failureType,
      locationLabel: task.locationLabel,
      instruction: task.instruction,
      ...(task.structuredTarget ? { structuredTarget: { ...task.structuredTarget } } : {}),
      ...(task.sentenceConstraint
        ? {
            sentenceConstraint: {
              ...(task.sentenceConstraint.quotedText ? { quotedText: task.sentenceConstraint.quotedText } : {}),
              ...(task.sentenceConstraint.forbiddenTerms?.length
                ? { forbiddenTerms: [...task.sentenceConstraint.forbiddenTerms] }
                : {}),
              ...(task.sentenceConstraint.sourceReferenceTexts?.length
                ? { sourceReferenceTexts: [...task.sentenceConstraint.sourceReferenceTexts] }
                : {})
            }
          }
        : {}),
      ...(task.analysisPlanIds?.length ? { analysisPlanIds: [...task.analysisPlanIds] } : {}),
      ...(task.analysisPlanKinds?.length ? { analysisPlanKinds: [...task.analysisPlanKinds] } : {}),
      ...(task.analysisTargets?.length ? { analysisTargets: [...task.analysisTargets] } : {})
    }));
  const blockPlans = blockPlanStates.length > 0 ? buildPromptBlockPlansFromState(blockPlanStates) : buildPromptBlockPlans(segment.source);
  const headingPlanAnchors = synthesizeHeadingPlanPromptAnchors(
    segmentId,
    headingPlans,
    [...requiredAnchors, ...repeatAnchors, ...establishedAnchors]
  );
  const headingHintAnchors = synthesizeHeadingHintPromptAnchors(
    segmentId,
    segment.headingHints,
    headingPlans,
    options?.currentRestoredBody ?? segment.currentRestoredBody,
    [...requiredAnchors, ...repeatAnchors, ...establishedAnchors, ...headingPlanAnchors]
  );
  const localFallbackAnchors = synthesizeLocalFallbackPromptAnchors(
    segmentId,
    segment.source,
    rawPendingRepairs,
    [...requiredAnchors, ...repeatAnchors, ...establishedAnchors, ...headingPlanAnchors, ...headingHintAnchors]
  );
  const analysisPlans = buildPromptAnalysisPlans(
    headingPlans,
    emphasisPlans,
    segment.aliasPlans,
    segment.entityDisambiguationPlans,
    blockPlans,
    coalesceRequiredAnchors([
      ...requiredAnchors,
      ...headingPlanAnchors,
      ...headingHintAnchors,
      ...localFallbackAnchors
    ]),
    repeatAnchors,
    establishedAnchors
  );
  const pendingRepairs = attachAnalysisPlansToPendingRepairs(rawPendingRepairs, analysisPlans);

  return {
    documentTitle: state.document.title,
    chunkId,
    segmentId,
    chunkIndex: chunk.index + 1,
    segmentIndex: segment.index + 1,
    headingPath: [...chunk.headingPath],
    headingHints: [...segment.headingHints],
    headingPlans: headingPlans.map((plan) => ({
      ...(typeof plan.headingIndex === "number" ? { headingIndex: plan.headingIndex } : {}),
      sourceHeading: plan.sourceHeading,
      strategy: plan.strategy,
      ...(plan.targetHeading ? { targetHeading: plan.targetHeading } : {}),
      ...(plan.governedTerms?.length ? { governedTerms: [...plan.governedTerms] } : {}),
      ...(plan.english ? { english: plan.english } : {}),
      ...(plan.chineseHint ? { chineseHint: plan.chineseHint } : {}),
      ...(plan.category ? { category: plan.category } : {}),
      ...(plan.displayPolicy ? { displayPolicy: plan.displayPolicy } : {})
    })),
    emphasisPlans: emphasisPlans.map((plan) => ({
      ...(typeof plan.emphasisIndex === "number" ? { emphasisIndex: plan.emphasisIndex } : {}),
      ...(typeof plan.lineIndex === "number" ? { lineIndex: plan.lineIndex } : {}),
      sourceText: plan.sourceText,
      strategy: plan.strategy,
      ...(plan.targetText ? { targetText: plan.targetText } : {}),
      ...(plan.governedTerms?.length ? { governedTerms: [...plan.governedTerms] } : {})
    })),
    aliasPlans: segment.aliasPlans.map((plan) => ({
      ...(typeof plan.lineIndex === "number" ? { lineIndex: plan.lineIndex } : {}),
      sourceText: plan.sourceText,
      ...(plan.currentText ? { currentText: plan.currentText } : {}),
      targetText: plan.targetText,
      ...(plan.english ? { english: plan.english } : {}),
      ...(plan.chineseHint ? { chineseHint: plan.chineseHint } : {})
    })),
    entityDisambiguationPlans: segment.entityDisambiguationPlans.map((plan) => ({
      ...(typeof plan.lineIndex === "number" ? { lineIndex: plan.lineIndex } : {}),
      sourceText: plan.sourceText,
      ...(plan.currentText ? { currentText: plan.currentText } : {}),
      targetText: plan.targetText,
      ...(plan.english ? { english: plan.english } : {}),
      ...(plan.forbiddenDisplays?.length ? { forbiddenDisplays: [...plan.forbiddenDisplays] } : {})
    })),
    blockPlans,
    requiredAnchors: coalesceRequiredAnchors([
      ...requiredAnchors,
      ...headingPlanAnchors,
      ...headingHintAnchors,
      ...localFallbackAnchors
    ]),
    repeatAnchors,
    establishedAnchors,
    protectedSpanIds: [...segment.spanIds],
    pendingRepairs,
    headingPlanGovernedAnchorIds: [...headingPlanGovernedAnchorIds],
    analysisPlans,
    analysisPlanDraft: renderPromptAnalysisPlanDraft(segmentId, analysisPlans)
  };
}

function collectEntityDisambiguationGovernedAnchorIds(
  entityDisambiguationPlans: readonly EntityDisambiguationPlanState[],
  mentionedAnchors: readonly AnchorState[]
): Set<string> {
  if (entityDisambiguationPlans.length === 0 || mentionedAnchors.length === 0) {
    return new Set();
  }

  const governedIds = new Set<string>();

  for (const plan of entityDisambiguationPlans) {
    const normalizedPlanEnglish = plan.english?.trim().toLowerCase() ?? "";
    const forbiddenDisplays = (plan.forbiddenDisplays ?? []).map((item) => item.trim()).filter(Boolean);

    for (const anchor of mentionedAnchors) {
      const normalizedAnchorEnglish = anchor.english.trim().toLowerCase();
      const anchorDisplay = describeAnchorDisplay(anchor);
      const anchorDisplays = [anchor.english, anchorDisplay.canonical, ...(anchorDisplay.repeatText ? [anchorDisplay.repeatText] : [])]
        .map((item) => item.trim())
        .filter(Boolean);

      const matchesForbiddenDisplay = forbiddenDisplays.some((display) =>
        anchorDisplays.some(
          (anchorText) =>
            normalizeAnalysisRepairMatchText(display) === normalizeAnalysisRepairMatchText(anchorText)
        )
      );
      const matchesPlanEnglish = Boolean(normalizedPlanEnglish) && normalizedPlanEnglish === normalizedAnchorEnglish;

      if (matchesForbiddenDisplay || matchesPlanEnglish) {
        governedIds.add(anchor.id);
      }
    }
  }

  return governedIds;
}

export function renderTranslationIRSidecar(state: TranslationRunState): string {
  const lines = [`<DOCUMENT title="${escapePlanDraftAttribute(state.document.title ?? "")}">`];

  for (const chunk of state.chunks) {
    lines.push(`  <CHUNK id="${chunk.id}" index="${chunk.index + 1}">`);
    for (const segmentId of chunk.segmentIds) {
      const segment = getSegmentState(state, segmentId);
      const slice = buildSegmentTaskSlice(state, chunk.id, segmentId);
      const indentedDraft = slice.analysisPlanDraft
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
      lines.push(indentedDraft);
    }
    lines.push(`  </CHUNK>`);
  }

  lines.push(`</DOCUMENT>`);
  return `${lines.join("\n")}\n`;
}

function buildPromptBlockPlans(source: string): PromptBlockPlan[] {
  return splitPromptBlocks(source).map((block, index) => ({
    blockIndex: index + 1,
    blockKind: classifyPromptBlockKind(block.content),
    sourceText: summarizePromptBlockSource(block.content)
  }));
}

function buildPromptBlockPlansFromState(blockPlans: readonly BlockPlanState[]): PromptBlockPlan[] {
  return blockPlans
    .slice()
    .sort((left, right) => left.blockIndex - right.blockIndex)
    .map((plan) => ({
      blockIndex: plan.blockIndex,
      blockKind: plan.blockKind,
      sourceText: plan.sourceText,
      ...(plan.targetText?.trim() ? { targetText: plan.targetText.trim() } : {})
    }));
}

function buildPromptAnalysisPlans(
  headingPlans: readonly HeadingPlanState[],
  emphasisPlans: readonly EmphasisPlanState[],
  aliasPlans: readonly AliasPlanState[],
  entityDisambiguationPlans: readonly EntityDisambiguationPlanState[],
  blockPlans: readonly PromptBlockPlan[],
  requiredAnchors: PromptSlice["requiredAnchors"],
  repeatAnchors: PromptSlice["repeatAnchors"],
  establishedAnchors: PromptSlice["establishedAnchors"]
): PromptAnalysisPlan[] {
  const plans: PromptAnalysisPlan[] = [];

  for (const anchor of requiredAnchors) {
    plans.push(anchorToPromptAnalysisPlan(anchor, "required"));
  }

  for (const anchor of repeatAnchors) {
    plans.push(anchorToPromptAnalysisPlan(anchor, "repeat"));
  }

  for (const anchor of establishedAnchors) {
    plans.push(anchorToPromptAnalysisPlan(anchor, "established"));
  }

  for (const plan of headingPlans) {
    plans.push({
      id: `heading:${plan.segmentId}:${plan.headingIndex ?? normalizeHeadingPlanningKey(plan.sourceHeading)}`,
      kind: "heading",
      scope: "local",
      sourceText: plan.sourceHeading,
      ...(plan.targetHeading ? { targetText: plan.targetHeading } : {}),
      ...(plan.english ? { english: plan.english } : {}),
      ...(plan.chineseHint ? { chineseHint: plan.chineseHint } : {}),
      ...(plan.category ? { category: plan.category } : {}),
      ...(plan.displayPolicy ? { displayPolicy: plan.displayPolicy } : {}),
      strategy: plan.strategy,
      ...(plan.governedTerms?.length ? { governedTerms: [...plan.governedTerms] } : {})
    });
  }

  for (const plan of emphasisPlans) {
    plans.push({
      id: `emphasis:${plan.segmentId}:${plan.emphasisIndex ?? plan.lineIndex ?? normalizeHeadingPlanningKey(plan.sourceText)}`,
      kind: "emphasis",
      scope: "local",
      sourceText: plan.sourceText,
      ...(plan.targetText ? { targetText: plan.targetText } : {}),
      strategy: plan.strategy,
      ...(plan.governedTerms?.length ? { governedTerms: [...plan.governedTerms] } : {})
    });
  }

  for (const plan of aliasPlans) {
    plans.push({
      id: `alias:${plan.segmentId}:${plan.lineIndex ?? normalizeHeadingPlanningKey(plan.sourceText)}`,
      kind: "alias",
      scope: "local",
      sourceText: plan.sourceText,
      ...(plan.currentText ? { currentText: plan.currentText } : {}),
      targetText: plan.targetText,
      ...(plan.english ? { english: plan.english } : {}),
      ...(plan.chineseHint ? { chineseHint: plan.chineseHint } : {}),
      ...(typeof plan.lineIndex === "number" ? { lineIndex: plan.lineIndex } : {})
    });
  }

  for (const plan of entityDisambiguationPlans) {
    plans.push({
      id: `disambiguation:${plan.segmentId}:${plan.lineIndex ?? normalizeHeadingPlanningKey(plan.sourceText)}`,
      kind: "disambiguation",
      scope: "local",
      sourceText: plan.sourceText,
      ...(plan.currentText ? { currentText: plan.currentText } : {}),
      targetText: plan.targetText,
      ...(plan.english ? { english: plan.english } : {}),
      ...(typeof plan.lineIndex === "number" ? { lineIndex: plan.lineIndex } : {}),
      ...(plan.forbiddenDisplays?.length ? { forbiddenDisplays: [...plan.forbiddenDisplays] } : {})
    });
  }

  for (const plan of blockPlans) {
    plans.push({
      id: `block:${plan.blockIndex}`,
      kind: "block",
      scope: "local",
      sourceText: plan.sourceText,
      ...(plan.targetText ? { targetText: plan.targetText } : {}),
      blockIndex: plan.blockIndex,
      blockKind: plan.blockKind
    });
  }

  return plans;
}

function anchorToPromptAnalysisPlan(
  anchor: PromptSlice["requiredAnchors"][number],
  scope: PromptAnalysisPlan["scope"]
): PromptAnalysisPlan {
  return {
    id: `anchor:${anchor.anchorId}`,
    kind: "anchor",
    scope,
    sourceText: anchor.english,
    ...(anchor.canonicalDisplay ? { targetText: anchor.canonicalDisplay } : {}),
    anchorId: anchor.anchorId,
    english: anchor.english,
    chineseHint: anchor.chineseHint,
    ...(anchor.category ? { category: anchor.category } : {}),
    displayPolicy: anchor.displayPolicy,
    ...(anchor.allowedDisplayForms?.length ? { governedTerms: [...anchor.allowedDisplayForms] } : {})
  };
}

function renderPromptAnalysisPlanDraft(segmentId: string, plans: readonly PromptAnalysisPlan[]): string {
  if (plans.length === 0) {
    return `<SEGMENT id="${segmentId}">\n</SEGMENT>`;
  }

  const lines = [`<SEGMENT id="${segmentId}">`];
  for (const plan of plans) {
    const attrs = [
      `id="${escapePlanDraftAttribute(plan.id)}"`,
      `kind="${plan.kind}"`,
      `scope="${plan.scope}"`
    ];
    if (plan.strategy) {
      attrs.push(`strategy="${plan.strategy}"`);
    }
    if (plan.displayPolicy) {
      attrs.push(`display="${plan.displayPolicy}"`);
    }
    if (plan.anchorId) {
      attrs.push(`anchorId="${escapePlanDraftAttribute(plan.anchorId)}"`);
    }
    if (typeof plan.blockIndex === "number") {
      attrs.push(`blockIndex="${plan.blockIndex}"`);
    }
    if (typeof plan.lineIndex === "number") {
      attrs.push(`lineIndex="${plan.lineIndex}"`);
    }
    if (plan.blockKind) {
      attrs.push(`blockKind="${plan.blockKind}"`);
    }

    const body = [
      `source="${escapePlanDraftAttribute(plan.sourceText)}"`,
      ...(plan.currentText ? [`current="${escapePlanDraftAttribute(plan.currentText)}"`] : []),
      ...(plan.targetText ? [`target="${escapePlanDraftAttribute(plan.targetText)}"`] : []),
      ...(plan.english ? [`english="${escapePlanDraftAttribute(plan.english)}"`] : []),
      ...(plan.chineseHint ? [`chinese="${escapePlanDraftAttribute(plan.chineseHint)}"`] : []),
      ...(plan.category ? [`category="${escapePlanDraftAttribute(plan.category)}"`] : []),
      ...(plan.forbiddenDisplays?.length
        ? [`forbidden="${escapePlanDraftAttribute(plan.forbiddenDisplays.join(" | "))}"`]
        : []),
      ...(plan.governedTerms?.length
        ? [`governed="${escapePlanDraftAttribute(plan.governedTerms.join(" | "))}"`]
        : [])
    ];

    lines.push(`  <PLAN ${attrs.join(" ")} ${body.join(" ")} />`);
  }
  lines.push(`</SEGMENT>`);
  return lines.join("\n");
}

function attachAnalysisPlansToPendingRepairs(
  pendingRepairs: PromptSlice["pendingRepairs"],
  analysisPlans: readonly PromptAnalysisPlan[]
): PromptSlice["pendingRepairs"] {
  return pendingRepairs.map((repair) => {
    if (repair.analysisPlanIds?.length || repair.analysisTargets?.length) {
      return repair;
    }

    const matchedPlans = findMatchingAnalysisPlansForRepair(repair, analysisPlans);
    if (matchedPlans.length === 0) {
      return repair;
    }

    const analysisTargets = matchedPlans.flatMap((plan) => collectAnalysisPlanTargetTexts(plan));
    return {
      ...repair,
      analysisPlanIds: matchedPlans.map((plan) => plan.id),
      analysisPlanKinds: [...new Set(matchedPlans.map((plan) => plan.kind))],
      analysisTargets: [...new Set(analysisTargets)]
    };
  });
}

function findMatchingAnalysisPlansForRepair(
  repair: PromptSlice["pendingRepairs"][number],
  analysisPlans: readonly PromptAnalysisPlan[]
): PromptAnalysisPlan[] {
  const instructionText = normalizeAnalysisRepairMatchText(repair.instruction);
  const locationText = normalizeAnalysisRepairMatchText(repair.locationLabel);
  return analysisPlans.filter((plan) => {
    if (plan.kind === "block" && repair.failureType !== "paragraph_match") {
      return false;
    }

    const candidates = collectAnalysisPlanTargetTexts(plan).map(normalizeAnalysisRepairMatchText);
    return candidates.some((candidate) => {
      if (!candidate) {
        return false;
      }

      return (
        instructionText.includes(candidate) ||
        candidate.includes(instructionText) ||
        locationText.includes(candidate) ||
        candidate.includes(locationText)
      );
    });
  });
}

function collectAnalysisPlanTargetTexts(plan: PromptAnalysisPlan): string[] {
  return [
    plan.sourceText,
    plan.currentText,
    plan.targetText,
    plan.english,
    plan.chineseHint,
    ...(plan.forbiddenDisplays ?? []),
    ...(plan.governedTerms ?? [])
  ].filter((value): value is string => Boolean(value?.trim()));
}

export function splitPromptBlocks(source: string): Array<{ content: string; separator: string }> {
  if (source.length === 0) {
    return [];
  }

  const blocks: Array<{ content: string; separator: string }> = [];
  const pattern = /\n{2,}/g;
  let lastIndex = 0;

  for (const match of source.matchAll(pattern)) {
    const separatorStart = match.index ?? 0;
    const content = source.slice(lastIndex, separatorStart);
    const separator = match[0];

    if (content.length === 0) {
      if (blocks.length > 0) {
        blocks[blocks.length - 1]!.separator += separator;
      }
      lastIndex = separatorStart + separator.length;
      continue;
    }

    blocks.push({ content, separator });
    lastIndex = separatorStart + separator.length;
  }

  const tail = source.slice(lastIndex);
  if (tail.length > 0 || blocks.length === 0) {
    blocks.push({ content: tail, separator: "" });
  }

  return blocks;
}

export function classifyPromptBlockKind(content: string): PromptBlockPlan["blockKind"] {
  const trimmed = content.trim();
  if (/^#{1,6}[ \t]+.+$/m.test(trimmed) || /^\*\*[^*\n].+\*\*(?:\s*(?:—|-|:).+)?$/m.test(trimmed)) {
    return "heading";
  }
  if (/^>\s?/m.test(trimmed)) {
    return "blockquote";
  }
  if (/^```/.test(trimmed)) {
    return "code";
  }
  if (/^(?:[-*+]|\d+[.)])\s+/m.test(trimmed)) {
    return "list";
  }
  return "paragraph";
}

export function summarizePromptBlockSource(content: string): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine;
}

function normalizeAnalysisRepairMatchText(text: string): string {
  return text
    .replace(/[`“”‘’"「」『』]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapePlanDraftAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function collectHeadingPlanGovernedAnchorIds(
  headingPlans: readonly HeadingPlanState[],
  headingHints: readonly string[],
  mentionedAnchors: readonly AnchorState[]
): Set<string> {
  if (headingPlans.length === 0 || headingHints.length === 0) {
    return new Set();
  }

  const governedIds = new Set<string>();

  for (const plan of headingPlans) {
    if (!plan.targetHeading?.trim()) {
      continue;
    }

    const governedTerms = (plan.governedTerms ?? []).map((term) => term.trim()).filter(Boolean);
    const sourceHeading =
      typeof plan.headingIndex === "number"
        ? headingHints[(plan.headingIndex - 1)] ?? plan.sourceHeading
        : headingHints.find(
            (heading) => normalizeHeadingPlanningKey(heading) === normalizeHeadingPlanningKey(plan.sourceHeading)
          ) ?? plan.sourceHeading;

    const normalizedSourceHeading = normalizeSourceForAnchorMatching(sourceHeading);
    for (const anchor of mentionedAnchors) {
      const sourceForms = anchor.sourceForms ?? [anchor.english];
      const governedByPlan =
        governedTerms.some((term) => sourceForms.some((form) => containsWholePhrase(term, form) || containsWholePhrase(form, term))) ||
        sourceForms.some((form) => containsWholePhrase(normalizedSourceHeading, form));
      if (governedByPlan) {
        governedIds.add(anchor.id);
      }
    }
  }

  return governedIds;
}

function reconcileSegmentSemanticPlans(
  state: TranslationRunState,
  segment: SegmentState
): { headingPlans: HeadingPlanState[]; blockPlans: BlockPlanState[]; emphasisPlans: EmphasisPlanState[] } {
  const headingPlans = segment.headingPlans.map((plan) => ({ ...plan }));
  const blockPlans = segment.blockPlans.map((plan) => ({ ...plan }));
  const emphasisPlans = segment.emphasisPlans.map((plan) => ({ ...plan }));
  const mentionedAnchors = state.anchors.filter((anchor) => anchor.mentionSegmentIds.includes(segment.id));

  for (const plan of headingPlans) {
    const sourceHeading = resolveSourceHeadingForPlan(segment.headingHints, plan);
    if (!sourceHeading) {
      continue;
    }

    const reconciledConceptTarget = reconcileConceptHeadingTarget(plan, sourceHeading);
    if (reconciledConceptTarget) {
      plan.targetHeading = reconciledConceptTarget;
      const matchingBlockPlan = findMatchingHeadingBlockPlan(blockPlans, sourceHeading, plan.headingIndex);
      if (matchingBlockPlan) {
        matchingBlockPlan.targetText = replaceHeadingBlockContent(matchingBlockPlan.sourceText, reconciledConceptTarget);
      }
    }

    const anchor = findExactHeadingAnchorForReconciliation(state.anchors, sourceHeading);
    if (!anchor || !anchor.requiresBilingual || anchor.displayPolicy === "english-only") {
      continue;
    }

    const exactEnglish = resolveExactHeadingAnchorSurface(sourceHeading, anchor);
    if (!exactEnglish) {
      continue;
    }

    if (!shouldReconcileHeadingTarget(plan, anchor, exactEnglish)) {
      continue;
    }

    const reconciledTarget = buildReconciledHeadingTarget(sourceHeading, anchor.chineseHint, exactEnglish);
    plan.targetHeading = reconciledTarget;
    plan.english = exactEnglish;
    plan.chineseHint = anchor.chineseHint;
    plan.displayPolicy = anchor.displayPolicy;
    if (!plan.category && anchor.category) {
      plan.category = anchor.category;
    }

    const matchingBlockPlan = findMatchingHeadingBlockPlan(blockPlans, sourceHeading, plan.headingIndex);
    if (matchingBlockPlan) {
      matchingBlockPlan.targetText = replaceHeadingBlockContent(matchingBlockPlan.sourceText, reconciledTarget);
    }
  }

  for (const plan of emphasisPlans) {
    if (!plan.targetText?.trim()) {
      continue;
    }
    const sourceLine = resolveSourceLineForSemanticPlan(segment.source, plan.sourceText, plan.lineIndex);
    if (!sourceLine) {
      continue;
    }
    const reconciledTarget = reconcilePlanTargetTextWithAnchors(plan.targetText, sourceLine, mentionedAnchors);
    if (reconciledTarget) {
      plan.targetText = reconciledTarget;
    }
  }

  for (const plan of blockPlans) {
    if (!plan.targetText?.trim()) {
      continue;
    }
    const reconciledTarget = reconcilePlanTargetTextWithAnchors(plan.targetText, plan.sourceText, mentionedAnchors);
    if (reconciledTarget) {
      plan.targetText = reconciledTarget;
    }
  }

  return { headingPlans, blockPlans, emphasisPlans };
}

function resolveSourceLineForSemanticPlan(
  source: string,
  sourceText: string,
  lineIndex?: number
): string | null {
  const lines = source.split(/\r?\n/);
  if (typeof lineIndex === "number" && lineIndex >= 1) {
    return lines[lineIndex - 1] ?? null;
  }

  return lines.find((line) => line.includes(sourceText)) ?? null;
}

function reconcilePlanTargetTextWithAnchors(
  targetText: string,
  sourceText: string,
  anchors: readonly AnchorState[]
): string | null {
  let next = targetText;
  let changed = false;

  for (const anchor of anchors) {
    if (!anchor.requiresBilingual || anchor.displayPolicy === "english-only") {
      continue;
    }
    if (!containsWholePhrase(sourceText, anchor.english)) {
      continue;
    }

    const canonical = describeAnchorDisplay(anchor).canonical;
    if (!canonical || next.includes(canonical)) {
      continue;
    }

    if (next.includes(anchor.chineseHint)) {
      next = replaceFirstLiteral(next, anchor.chineseHint, canonical);
      changed = true;
    }
  }

  return changed ? next : null;
}

function replaceFirstLiteral(text: string, needle: string, replacement: string): string {
  const index = text.indexOf(needle);
  if (index < 0) {
    return text;
  }
  return `${text.slice(0, index)}${replacement}${text.slice(index + needle.length)}`;
}

function reconcileConceptHeadingTarget(plan: HeadingPlanState, sourceHeading: string): string | null {
  if (plan.strategy !== "concept") {
    return null;
  }

  const english = plan.english?.trim() ?? "";
  const chineseHint = plan.chineseHint?.trim() ?? "";
  if (!english || !chineseHint) {
    return null;
  }

  const targetHeading = plan.targetHeading?.trim() ?? "";
  if (targetHeading && containsWholePhrase(targetHeading, english)) {
    return null;
  }

  if (targetHeading && normalizeHeadingPlanningKey(targetHeading) !== normalizeHeadingPlanningKey(chineseHint)) {
    return null;
  }

  return buildReconciledHeadingTarget(sourceHeading, chineseHint, english);
}

function resolveSourceHeadingForPlan(headingHints: readonly string[], plan: HeadingPlanState): string | null {
  const explicitMatch =
    headingHints.find((heading) => normalizeHeadingPlanningKey(heading) === normalizeHeadingPlanningKey(plan.sourceHeading)) ??
    null;
  if (explicitMatch) {
    return explicitMatch;
  }

  if (typeof plan.headingIndex === "number") {
    return headingHints[plan.headingIndex - 1] ?? plan.sourceHeading ?? null;
  }

  return plan.sourceHeading ?? null;
}

function findExactHeadingAnchorForReconciliation(
  anchors: readonly AnchorState[],
  sourceHeading: string
): AnchorState | null {
  const headingCore = normalizeHeadingPlanningKey(stripHeadingTrailingColon(stripInlineMarkdownMarkers(sourceHeading)));
  if (!headingCore) {
    return null;
  }

  const matches = anchors.filter((anchor) => {
    const sourceForms = anchor.sourceForms?.length ? anchor.sourceForms : [anchor.english];
    return sourceForms.some((form) => normalizeHeadingPlanningKey(stripHeadingTrailingColon(form)) === headingCore);
  });

  return matches.length === 1 ? matches[0]! : null;
}

function resolveExactHeadingAnchorSurface(sourceHeading: string, anchor: AnchorState): string | null {
  const strippedHeading = stripHeadingTrailingColon(stripInlineMarkdownMarkers(sourceHeading)).trim();
  if (!strippedHeading) {
    return null;
  }

  const headingKey = normalizeHeadingPlanningKey(strippedHeading);
  const sourceForms = anchor.sourceForms?.length ? anchor.sourceForms : [anchor.english];
  const matchedForm =
    sourceForms.find((form) => normalizeHeadingPlanningKey(stripHeadingTrailingColon(form)) === headingKey) ?? null;

  if (matchedForm) {
    return strippedHeading;
  }

  return normalizeHeadingPlanningKey(stripHeadingTrailingColon(anchor.english)) === headingKey ? strippedHeading : null;
}

function shouldReconcileHeadingTarget(
  plan: HeadingPlanState,
  anchor: AnchorState,
  exactEnglish: string
): boolean {
  if (plan.strategy === "none" || plan.strategy === "natural-heading" || plan.strategy === "source-template") {
    return false;
  }

  const targetHeading = plan.targetHeading?.trim() ?? "";
  if (!targetHeading) {
    return true;
  }

  if (containsWholePhrase(targetHeading, exactEnglish)) {
    return false;
  }

  return normalizeHeadingPlanningKey(targetHeading) === normalizeHeadingPlanningKey(anchor.chineseHint);
}

function buildReconciledHeadingTarget(sourceHeading: string, chineseHint: string, exactEnglish: string): string {
  const trailingColon = /[：:]\s*$/.test(stripInlineMarkdownMarkers(sourceHeading));
  return trailingColon ? `${chineseHint}（${exactEnglish}）：` : `${chineseHint}（${exactEnglish}）`;
}

function findMatchingHeadingBlockPlan(
  blockPlans: BlockPlanState[],
  sourceHeading: string,
  headingIndex?: number
): BlockPlanState | null {
  const headingKey = normalizeHeadingPlanningKey(stripHeadingTrailingColon(stripInlineMarkdownMarkers(sourceHeading)));
  if (!headingKey) {
    return null;
  }

  const headingBlocks = blockPlans.filter((plan) => plan.blockKind === "heading");
  if (typeof headingIndex === "number") {
    const byIndex = headingBlocks[headingIndex - 1];
    if (
      byIndex &&
      normalizeHeadingPlanningKey(stripHeadingTrailingColon(extractHeadingContentFromBlockText(byIndex.sourceText) ?? "")) ===
        headingKey
    ) {
      return byIndex;
    }
  }

  return (
    headingBlocks.find(
      (plan) =>
        normalizeHeadingPlanningKey(stripHeadingTrailingColon(extractHeadingContentFromBlockText(plan.sourceText) ?? "")) ===
        headingKey
    ) ?? null
  );
}

function extractHeadingContentFromBlockText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\n")) {
    return null;
  }

  const atxMatch = trimmed.match(/^(#{1,6}[ \t]+)(.+)$/);
  if (atxMatch) {
    return atxMatch[2]!.trim();
  }

  const boldMatch = trimmed.match(/^\*\*(.+?)\*\*$/);
  if (boldMatch) {
    return boldMatch[1]!.trim();
  }

  return null;
}

function replaceHeadingBlockContent(sourceText: string, targetHeading: string): string {
  const trimmed = sourceText.trim();
  const atxMatch = trimmed.match(/^(#{1,6}[ \t]+)(.+)$/);
  if (atxMatch) {
    return trimmed.replace(atxMatch[2]!, targetHeading);
  }

  const boldMatch = trimmed.match(/^\*\*(.+?)\*\*$/);
  if (boldMatch) {
    return trimmed.replace(boldMatch[1]!, targetHeading);
  }

  return targetHeading;
}

function stripHeadingTrailingColon(text: string): string {
  return text.replace(/[：:]\s*$/, "").trim();
}

function synthesizeHeadingHintPromptAnchors(
  segmentId: string,
  headingHints: readonly string[],
  headingPlans: readonly HeadingPlanState[],
  _currentRestoredBody: string,
  existingAnchors: PromptSlice["requiredAnchors"]
): PromptSlice["requiredAnchors"] {
  if (headingHints.length === 0 || existingAnchors.length === 0) {
    return [];
  }

  const plannedHeadingKeys = new Set(
    headingPlans.map((plan) => normalizeHeadingPlanningKey(plan.sourceHeading)).filter(Boolean)
  );
  const synthesized: PromptSlice["requiredAnchors"] = [];
  const seenEnglish = new Set(existingAnchors.map((anchor) => anchor.english.trim().toLowerCase()));

  for (const headingHint of headingHints) {
    const headingKey = normalizeHeadingPlanningKey(headingHint);
    if (!headingKey || plannedHeadingKeys.has(headingKey)) {
      continue;
    }

    const headingCore = extractHeadingPlanningEnglish(headingHint);
    if (!headingCore) {
      continue;
    }

    const matches = existingAnchors.filter((anchor) => {
      if (anchor.anchorId.startsWith("local:")) {
        return false;
      }
      return normalizeHeadingPlanningKey(anchor.english) === normalizeHeadingPlanningKey(headingCore);
    });

    if (matches.length !== 1) {
      continue;
    }

    const match = matches[0]!;
    const normalizedKey = match.english.trim().toLowerCase();
    if (seenEnglish.has(normalizedKey)) {
      continue;
    }

    synthesized.push({
      ...match,
      anchorId: buildLocalFallbackAnchorId(segmentId, `${match.english}:heading`),
      allowRepeatText: false
    });
    seenEnglish.add(normalizedKey);
  }

  return synthesized;
}

function synthesizeHeadingPlanPromptAnchors(
  segmentId: string,
  headingPlans: readonly HeadingPlanState[],
  existingAnchors: PromptSlice["requiredAnchors"]
): PromptSlice["requiredAnchors"] {
  if (headingPlans.length === 0) {
    return [];
  }

  const synthesized: PromptSlice["requiredAnchors"] = [];
  const seenEnglish = new Set(existingAnchors.map((anchor) => anchor.english.trim().toLowerCase()));

  for (const plan of headingPlans) {
    if (plan.strategy === "none" || plan.strategy === "natural-heading") {
      continue;
    }

    const english = plan.english?.trim() ?? "";
    if (!english) {
      continue;
    }

    const normalizedKey = english.toLowerCase();
    if (seenEnglish.has(normalizedKey)) {
      continue;
    }

    const displayPolicy = resolveHeadingPlanDisplayPolicy(plan);
    const chineseHint = resolveHeadingPlanChineseHint(plan, displayPolicy);
    synthesized.push({
      anchorId: buildLocalFallbackAnchorId(segmentId, english),
      english,
      chineseHint,
      ...(plan.category ? { category: plan.category } : {}),
      familyId: `local:${normalizeLocalFallbackAnchorKey(english)}`,
      requiresBilingual: displayPolicy !== "english-only",
      displayPolicy,
      allowRepeatText: false,
      displayMode: displayPolicy === "english-only" ? "english-only" : "chinese-primary",
      canonicalDisplay: displayPolicy === "english-only" ? english : `${chineseHint}（${english}）`,
      allowedDisplayForms: displayPolicy === "english-only" ? [english] : [`${chineseHint}（${english}）`]
    });
    seenEnglish.add(normalizedKey);
  }

  return synthesized;
}

function resolveHeadingPlanDisplayPolicy(plan: HeadingPlanState): AnchorDisplayPolicy {
  if (plan.displayPolicy) {
    return plan.displayPolicy;
  }
  if (plan.strategy === "source-template") {
    return "english-only";
  }
  return "chinese-primary";
}

function resolveHeadingPlanChineseHint(plan: HeadingPlanState, displayPolicy: AnchorDisplayPolicy): string {
  if (displayPolicy === "english-only") {
    return plan.chineseHint?.trim() || plan.english?.trim() || "";
  }
  return plan.chineseHint?.trim() || "";
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
      structuredTargets?: StructuredRepairTarget[];
      sentenceConstraint?: {
        quotedText?: string;
        forbiddenTerms?: string[];
        sourceReferenceTexts?: string[];
      };
      analysisPlanIds?: string[];
      analysisTargets?: string[];
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
      mustFix: [...segment.mustFix],
      ...(segment.structuredTargets?.length
        ? { structuredTargets: segment.structuredTargets.map((target) => ({ ...target })) }
        : {}),
      ...(segment.sentenceConstraint
        ? {
            sentenceConstraint: {
              ...(segment.sentenceConstraint.quotedText ? { quotedText: segment.sentenceConstraint.quotedText } : {}),
              ...(segment.sentenceConstraint.forbiddenTerms?.length
                ? { forbiddenTerms: [...segment.sentenceConstraint.forbiddenTerms] }
                : {}),
              ...(segment.sentenceConstraint.sourceReferenceTexts?.length
                ? { sourceReferenceTexts: [...segment.sentenceConstraint.sourceReferenceTexts] }
                : {})
            }
          }
        : {}),
      ...(segment.analysisPlanIds?.length ? { analysisPlanIds: [...segment.analysisPlanIds] } : {}),
      ...(segment.analysisTargets?.length ? { analysisTargets: [...segment.analysisTargets] } : {})
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
    const rawTarget =
      extractLocalFallbackAnchorTargetFromStructuredTarget(repair) ??
      extractLocalFallbackAnchorTargetFromBoundIR(repair) ??
      extractLocalFallbackAnchorTarget(repair.locationLabel, repair.instruction);
    const target = rawTarget
      ? reconcileLocalFallbackTargetWithExistingAnchors(rawTarget, existingAnchors)
      : null;
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

function reconcileLocalFallbackTargetWithExistingAnchors(
  target: { english: string; chineseHint: string; displayPolicy: "english-only" | "chinese-primary" },
  existingAnchors: PromptSlice["requiredAnchors"]
): { english: string; chineseHint: string; displayPolicy: "english-only" | "chinese-primary" } {
  const normalizedChineseHint = target.chineseHint.trim();
  const normalizedEnglish = target.english.trim();
  if (!normalizedChineseHint || !normalizedEnglish) {
    return target;
  }

  const canonicalMatch = existingAnchors
    .filter(
      (anchor) =>
        anchor.displayPolicy !== "english-only" &&
        anchor.chineseHint.trim() === normalizedChineseHint &&
        anchor.english.length > normalizedEnglish.length &&
        containsWholePhrase(anchor.english, normalizedEnglish)
    )
    .sort((left, right) => right.english.length - left.english.length)[0];

  if (!canonicalMatch) {
    return target;
  }

  return {
    english: canonicalMatch.english,
    chineseHint: canonicalMatch.chineseHint,
    displayPolicy:
      canonicalMatch.displayPolicy === "english-only" ? "english-only" : "chinese-primary"
  };
}

function extractLocalFallbackAnchorTargetFromStructuredTarget(
  repair: PromptSlice["pendingRepairs"][number]
): { english: string; chineseHint: string; displayPolicy: "english-only" | "chinese-primary" } | null {
  const target = repair.structuredTarget;
  if (!target) {
    return null;
  }

  const bilingualTarget = target.targetText?.match(/^(.+?)（([^）]+)）$/u);
  if (bilingualTarget) {
    const chineseHint = bilingualTarget[1]?.trim() ?? "";
    const english = bilingualTarget[2]?.trim() ?? "";
    if (chineseHint && english && /[\u4e00-\u9fff]/u.test(chineseHint) && !looksCodeLikeAnchorTarget(english)) {
      return {
        english,
        chineseHint,
        displayPolicy: "chinese-primary"
      };
    }
  }

  const english = target.english?.trim() ?? "";
  const chineseHint = target.chineseHint?.trim() ?? "";
  if (english && chineseHint && /[\u4e00-\u9fff]/u.test(chineseHint) && !looksCodeLikeAnchorTarget(english)) {
    return {
      english,
      chineseHint,
      displayPolicy: "chinese-primary"
    };
  }

  return null;
}

function extractLocalFallbackAnchorTargetFromBoundIR(
  repair: PromptSlice["pendingRepairs"][number]
): { english: string; chineseHint: string; displayPolicy: "english-only" | "chinese-primary" } | null {
  const targets = repair.analysisTargets ?? [];
  const bilingualTarget = targets.find((target) => /（[^）]*[A-Za-z][^）]*）/.test(target));
  if (bilingualTarget) {
    const match = bilingualTarget.match(/^(.+?)（([^）]+)）$/u);
    const chineseHint = match?.[1]?.trim() ?? "";
    const english = match?.[2]?.trim() ?? "";
    if (chineseHint && english && /[\u4e00-\u9fff]/u.test(chineseHint) && !looksCodeLikeAnchorTarget(english)) {
      return {
        english,
        chineseHint,
        displayPolicy: "chinese-primary"
      };
    }
  }

  const englishTargets = targets.filter((target) => /[A-Za-z]/.test(target) && !looksCodeLikeAnchorTarget(target));
  const chineseTargets = targets.filter((target) => /[\u4e00-\u9fff]/u.test(target) && !/[A-Za-z]/.test(target));
  const english = englishTargets.sort((left, right) => right.length - left.length)[0]?.trim();
  const chineseHint = chineseTargets.sort((left, right) => right.length - left.length)[0]?.trim();
  if (english && chineseHint) {
    return {
      english,
      chineseHint,
      displayPolicy: "chinese-primary"
    };
  }

  return null;
}

function extractLocalFallbackAnchorTarget(
  locationLabel: string,
  instruction: string
): { english: string; chineseHint: string; displayPolicy: "english-only" | "chinese-primary" } | null {
  const explicitLocalizedTarget =
    instruction.match(/(?:需补为|补齐)[“`]([^”`\n]+?)（([^）”`\n]+)）[”`]/i) ??
    instruction.match(/建立(?:合法的)?中英文(?:首现)?对应[^“`\n]*[“`]([^”`\n]+?)（([^）”`\n]+)）[”`]/i);
  if (explicitLocalizedTarget) {
    const chineseHint = stripInlineMarkdownMarkers(explicitLocalizedTarget[1] ?? "").trim();
    const english = (explicitLocalizedTarget[2] ?? "").trim();
    if (
      chineseHint &&
      english &&
      /[\u4e00-\u9fff]/u.test(chineseHint) &&
      !looksCodeLikeAnchorTarget(english)
    ) {
      return {
        english,
        chineseHint,
        displayPolicy: "chinese-primary"
      };
    }
  }

  const explicitEnglish =
    instruction.match(/(?:术语|核心术语|英文目标)\s*[“`]([^”`\n]*[A-Za-z][^”`\n]*)[”`]/)?.[1]?.trim() ??
    null;
  const explicitChinese =
    instruction.match(/为[“`]([^”`\n]+)[”`]建立(?:合法的)?中英文(?:首现)?对应/)?.[1]?.trim() ??
    instruction.match(/补成[“`]([^”`\n]+)[”`]/)?.[1]?.trim() ??
    null;
  if (explicitEnglish && explicitChinese) {
    const chineseHint = stripInlineMarkdownMarkers(explicitChinese).trim();
    if (chineseHint && /[\u4e00-\u9fff]/u.test(chineseHint) && !looksCodeLikeAnchorTarget(explicitEnglish)) {
      return {
        english: explicitEnglish,
        chineseHint,
        displayPolicy: "chinese-primary"
      };
    }
  }

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

function normalizeHeadingPlanningKey(text: string): string {
  return stripInlineMarkdownMarkers(text).replace(/\s+/g, " ").trim().toLowerCase();
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
