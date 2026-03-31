import type { ProtectedSpan } from "./markdown-protection.js";

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
  familyId: string;
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
  familyKey: string;
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
    familyId: string;
  }>;
  repeatAnchors: Array<{
    anchorId: string;
    english: string;
    chineseHint: string;
    familyId: string;
  }>;
  establishedAnchors: Array<{
    anchorId: string;
    english: string;
    chineseHint: string;
    familyId: string;
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
      finalBody: null
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
  segmentId: string
): PromptSlice {
  const chunk = getChunkState(state, chunkId);
  const segment = getSegmentState(state, segmentId);
  const mentionedAnchors = state.anchors.filter((anchor) => anchor.mentionSegmentIds.includes(segmentId));
  const requiredAnchors = mentionedAnchors
    .filter((anchor) => anchor.firstOccurrence.segmentId === segmentId)
    .map(toPromptAnchor);
  const repeatAnchors = mentionedAnchors
    .filter((anchor) => anchor.firstOccurrence.order < segment.order)
    .map(toPromptAnchor);
  const establishedAnchors = state.anchors
    .filter((anchor) => anchor.status === "established" && anchor.firstOccurrence.order < segment.order)
    .map(toPromptAnchor)
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

  return {
    documentTitle: state.document.title,
    chunkId,
    segmentId,
    chunkIndex: chunk.index + 1,
    segmentIndex: segment.index + 1,
    headingPath: [...chunk.headingPath],
    headingHints: [...segment.headingHints],
    requiredAnchors,
    repeatAnchors,
    establishedAnchors,
    protectedSpanIds: [...segment.spanIds],
    pendingRepairs
  };
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

export function setChunkFinalBody(state: TranslationRunState, chunkId: string, body: string): void {
  const chunk = getChunkState(state, chunkId);
  chunk.finalBody = body;
  chunk.phase = "completed";
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
    .filter((segment) => segment.kind === "translatable" && containsAnchorText(segment.source, anchor.english))
    .map((segment) => segment.id);

  return {
    id: `anchor-${index + 1}`,
    english: anchor.english.trim(),
    chineseHint: anchor.chineseHint.trim(),
    familyId: anchor.familyKey.trim() || normalizeFamilyKey(anchor.english),
    requiresBilingual: true,
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

function toPromptAnchor(anchor: AnchorState) {
  return {
    anchorId: anchor.id,
    english: anchor.english,
    chineseHint: anchor.chineseHint,
    familyId: anchor.familyId
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
  const normalizedSource = source.toLowerCase();
  const normalizedEnglish = english.trim().toLowerCase();
  return normalizedEnglish.length > 0 && normalizedSource.includes(normalizedEnglish);
}

function normalizeFamilyKey(english: string): string {
  return english.trim().toLowerCase();
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
