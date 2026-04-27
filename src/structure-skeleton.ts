/**
 * Structural skeleton aligner.
 *
 * Compares source vs draft as block-and-list-item count sequences (not text
 * similarity), and trims trailing duplicates or excess list items in draft
 * when they look like artifact regurgitation. Designed to subsume the
 * `dedupDraftDuplicate*` family and the targeted patches that grew out of
 * "draft tail repeats" failure cluster (resilience plan §3.2).
 *
 * Scope notes:
 * - This module only LOOKS at structure (kinds, counts, lengths). It does
 *   not consult lexical similarity. That's deliberate: small-segment list
 *   self-duplication can produce slightly-different translations of the same
 *   bullets, which the n-gram-based `draftBlocksLookLikeDuplicate` misses.
 * - It only TRIMS conservatively: every removed block has to shape-match an
 *   earlier block in the same skeleton, AND the resulting block count must
 *   match the source. If we can't reach that, we leave the draft alone.
 * - It does not invent content. Missing blocks are NEVER added; that's
 *   audit + repair's job.
 */

export type StructuralBlockKind = "heading" | "blockquote" | "code" | "list" | "paragraph";

export type StructuralBlock = {
  kind: StructuralBlockKind;
  charLen: number;
  lineCount: number;
  /** present only when kind === "list"; number of list items in the block */
  listItemCount?: number;
};

export type StructuralSkeleton = readonly StructuralBlock[];

const LIST_ITEM_LINE_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+\S/u;

function classifyBlockKind(content: string): StructuralBlockKind {
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

function countListItems(content: string): number {
  return content.split(/\r?\n/).filter((line) => LIST_ITEM_LINE_PATTERN.test(line)).length;
}

/**
 * Parse a markdown body into a structural skeleton: a flat sequence of
 * blocks with kind + size info. Splits on blank-line boundaries first
 * (matching `splitPromptBlocks`'s convention), then coalesces runs of
 * adjacent list-block fragments into a single logical list block.
 *
 * The coalescing step matters because the spec-driven fixture (and other
 * Medium-flavor exports) writes bullets with blank lines between each item:
 *
 *     - Specs are version-controlled
 *
 *     - Linked to code that implements them
 *
 *     - Every PR references a spec
 *
 * Naive blank-line splitting yields 3 separate `list(1)` blocks, which makes
 * "an extra bullet appeared" indistinguishable from "an extra paragraph
 * appeared at the tail". Coalescing produces one `list(3)` block instead,
 * so list count overflow gets detected directly and tail-block trimming
 * doesn't over-eagerly remove unrelated trailing prose.
 */
export function parseStructure(text: string): StructuralSkeleton {
  if (!text || !text.trim()) {
    return [];
  }
  const rawBlocks = text
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+$/, ""))
    .filter((block) => block.trim().length > 0);

  const blocks: StructuralBlock[] = [];
  for (const raw of rawBlocks) {
    const trimmed = raw.trim();
    const kind = classifyBlockKind(trimmed);
    const items = kind === "list" ? countListItems(trimmed) : 0;
    const lastBlock = blocks[blocks.length - 1];
    if (kind === "list" && lastBlock?.kind === "list") {
      lastBlock.listItemCount = (lastBlock.listItemCount ?? 0) + items;
      lastBlock.charLen += trimmed.length;
      lastBlock.lineCount += trimmed.split(/\r?\n/).length;
      continue;
    }
    const block: StructuralBlock = {
      kind,
      charLen: trimmed.length,
      lineCount: trimmed.split(/\r?\n/).length
    };
    if (kind === "list") {
      block.listItemCount = items;
    }
    blocks.push(block);
  }
  return blocks;
}

/** Two blocks shape-match when the kind is the same and the list-item / line
 *  counts are within a generous tolerance. Strict equality would over-trim
 *  (the model can split or merge a tiny line in translation); broad tolerance
 *  would under-trim (false positives on legitimate distinct content). The
 *  tolerance band is set to fit the empirical "tail block is a near-clone of
 *  an earlier block" pattern observed in spec-driven smoke runs. */
function blocksShapeMatch(a: StructuralBlock, b: StructuralBlock): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "list") {
    const aCount = a.listItemCount ?? 0;
    const bCount = b.listItemCount ?? 0;
    if (aCount === 0 || bCount === 0) {
      return false;
    }
    return aCount === bCount;
  }
  // For paragraphs / blockquotes / headings / code use line count proximity;
  // a translated paragraph is usually within ~50% line count of source.
  const minLen = Math.min(a.lineCount, b.lineCount);
  const maxLen = Math.max(a.lineCount, b.lineCount);
  if (maxLen === 0) {
    return false;
  }
  return minLen / maxLen >= 0.5;
}

/**
 * If draft has more blocks than source AND the trailing block sequence
 * shape-matches an earlier same-length sub-sequence in draft, return the
 * indices to drop. Returns null when the draft is OK or when alignment
 * would be unsafe.
 */
export function planTailTrim(
  sourceSkeleton: StructuralSkeleton,
  draftSkeleton: StructuralSkeleton
): { dropFrom: number } | null {
  if (draftSkeleton.length <= sourceSkeleton.length) {
    return null;
  }
  const excess = draftSkeleton.length - sourceSkeleton.length;
  // We only prune when EVERY excess trailing block shape-matches some
  // already-seen block in draft. Without that check we could happily delete
  // legitimate new content the source unexpectedly grew.
  const tailStart = draftSkeleton.length - excess;
  for (let offset = 0; offset < excess; offset += 1) {
    const tailBlock = draftSkeleton[tailStart + offset]!;
    let matchedEarlier = false;
    for (let earlier = 0; earlier < tailStart; earlier += 1) {
      if (blocksShapeMatch(draftSkeleton[earlier]!, tailBlock)) {
        matchedEarlier = true;
        break;
      }
    }
    if (!matchedEarlier) {
      return null;
    }
  }
  return { dropFrom: tailStart };
}

/**
 * Find non-blank lines in draft whose exact-text occurrence count exceeds
 * the same line's occurrence count in source. These are model-introduced
 * literal duplicates — typically inside code-style or pseudo-code template
 * blocks where the model accidentally re-emits a line like `fileName: string`
 * that was supposed to appear once. Returns the line indices to drop.
 *
 * Rules:
 * - Only considers lines that ALSO appear in source (count >= 1). Lines that
 *   never appear in source are likely translation-side text and are skipped
 *   to avoid misclassifying paraphrased duplicates as literal duplicates.
 * - Drops the LATER occurrences (keeps the first N where N = source count),
 *   so the original first-occurrence position stays anchored.
 *
 * Returns null when nothing needs trimming.
 */
export function planLiteralLineDedup(
  source: string,
  draft: string
): { removeAtIndices: readonly number[] } | null {
  const sourceLines = source.split(/\r?\n/);
  const draftLines = draft.split(/\r?\n/);

  const sourceCounts = new Map<string, number>();
  for (const line of sourceLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    sourceCounts.set(trimmed, (sourceCounts.get(trimmed) ?? 0) + 1);
  }

  const draftSeenCounts = new Map<string, number>();
  const removeAtIndices: number[] = [];
  for (let i = 0; i < draftLines.length; i += 1) {
    const trimmed = draftLines[i]!.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const sourceCount = sourceCounts.get(trimmed) ?? 0;
    if (sourceCount === 0) {
      continue;
    }
    const seen = (draftSeenCounts.get(trimmed) ?? 0) + 1;
    draftSeenCounts.set(trimmed, seen);
    if (seen > sourceCount) {
      removeAtIndices.push(i);
    }
  }

  if (removeAtIndices.length === 0) {
    return null;
  }
  return { removeAtIndices };
}

function applyLiteralLineDedup(text: string, removeAtIndices: readonly number[]): string {
  if (removeAtIndices.length === 0) {
    return text;
  }
  const drop = new Set(removeAtIndices);
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (drop.has(i)) {
      continue;
    }
    out.push(lines[i]!);
  }
  // Collapse double-blank-lines that the dedup might have introduced when
  // an isolated literal line (with blank lines on both sides) was dropped.
  const compacted: string[] = [];
  for (const line of out) {
    if (line.trim().length === 0 && compacted[compacted.length - 1]?.trim().length === 0) {
      continue;
    }
    compacted.push(line);
  }
  return compacted.join("\n").replace(/\s+$/u, "");
}

/**
 * Detect the case where source and draft have the same block count but a
 * specific list block in draft has MORE items than the source counterpart,
 * and the extra items appear to be a duplicate run of earlier items. Returns
 * a per-block trim plan; null when no list overflow is detected.
 */
export function planListOverflowTrim(
  sourceSkeleton: StructuralSkeleton,
  draftSkeleton: StructuralSkeleton
): { blockIndex: number; keepItems: number } | null {
  if (sourceSkeleton.length !== draftSkeleton.length) {
    return null;
  }
  for (let index = 0; index < sourceSkeleton.length; index += 1) {
    const sourceBlock = sourceSkeleton[index]!;
    const draftBlock = draftSkeleton[index]!;
    if (sourceBlock.kind !== "list" || draftBlock.kind !== "list") {
      continue;
    }
    const sourceCount = sourceBlock.listItemCount ?? 0;
    const draftCount = draftBlock.listItemCount ?? 0;
    if (sourceCount === 0 || draftCount <= sourceCount) {
      continue;
    }
    // Excess items at the tail: keep only sourceCount of them.
    return { blockIndex: index, keepItems: sourceCount };
  }
  return null;
}

const PROTECTED_PLACEHOLDER_PATTERN = /@@MDZH_[A-Z_]+_\d{4}@@/g;

function countProtectedPlaceholders(text: string): number {
  PROTECTED_PLACEHOLDER_PATTERN.lastIndex = 0;
  let count = 0;
  while (PROTECTED_PLACEHOLDER_PATTERN.exec(text) !== null) {
    count += 1;
  }
  return count;
}

type LogicalBlockRange = {
  /** index of the logical block in the skeleton (parseStructure output) */
  index: number;
  kind: StructuralBlockKind;
  startLine: number;
  /** inclusive */
  endLine: number;
};

/**
 * Walk lines and produce per-logical-block line ranges. Consecutive list
 * runs (with blank lines between them) get coalesced into one logical block,
 * matching parseStructure's coalescing rule. Used by the tail / overflow
 * trim helpers so they operate on the same boundaries the skeleton sees.
 */
function findLogicalBlockRanges(text: string): LogicalBlockRange[] {
  const lines = text.split(/\r?\n/);
  const ranges: LogicalBlockRange[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trim().length === 0) {
      i += 1;
      continue;
    }
    const runStart = i;
    const runKind = classifyBlockKind(lines[i]!);
    let runEnd = i;
    while (runEnd < lines.length && lines[runEnd]!.trim().length > 0) {
      runEnd += 1;
    }
    const last = ranges[ranges.length - 1];
    if (runKind === "list" && last?.kind === "list") {
      // Coalesce adjacent list run into the previous logical list block.
      last.endLine = runEnd - 1;
    } else {
      ranges.push({
        index: ranges.length,
        kind: runKind,
        startLine: runStart,
        endLine: runEnd - 1
      });
    }
    i = runEnd + 1;
  }
  return ranges;
}

function applyTailTrim(text: string, draftSkeleton: StructuralSkeleton, dropFrom: number): string {
  void draftSkeleton;
  const ranges = findLogicalBlockRanges(text);
  if (dropFrom >= ranges.length) {
    return text;
  }
  const cutAtLine = ranges[dropFrom]!.startLine;
  const lines = text.split(/\r?\n/);
  return lines.slice(0, cutAtLine).join("\n").replace(/\s+$/u, "");
}

function applyListItemTrim(text: string, blockIndex: number, keepItems: number): string {
  const ranges = findLogicalBlockRanges(text);
  if (blockIndex >= ranges.length || ranges[blockIndex]!.kind !== "list") {
    return text;
  }
  const target = ranges[blockIndex]!;
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let j = 0; j < target.startLine; j += 1) {
    out.push(lines[j]!);
  }
  let kept = 0;
  let trailingBlankSkipped = false;
  for (let j = target.startLine; j <= target.endLine; j += 1) {
    const line = lines[j]!;
    if (LIST_ITEM_LINE_PATTERN.test(line)) {
      if (kept < keepItems) {
        out.push(line);
        kept += 1;
        trailingBlankSkipped = false;
      }
      // else: drop excess bullet
      continue;
    }
    if (line.trim().length === 0) {
      if (kept < keepItems) {
        out.push(line);
      } else if (!trailingBlankSkipped) {
        // After we've kept the last bullet we want, drop any trailing blank
        // lines that were sitting between bullets (avoids orphan blanks).
        trailingBlankSkipped = true;
      }
      continue;
    }
    // Non-bullet, non-blank line inside what parseStructure called a list
    // block: typically a continuation line indented under a bullet. Keep
    // it iff we haven't yet hit the keep limit OR it directly follows a
    // kept bullet.
    if (kept <= keepItems) {
      out.push(line);
    }
  }
  for (let j = target.endLine + 1; j < lines.length; j += 1) {
    out.push(lines[j]!);
  }
  return out.join("\n").replace(/\s+$/u, "");
}

/**
 * Apply tail-trim and list-overflow-trim using the skeletons. Each strategy
 * is conservative; both can run in sequence (tail-trim first, then list
 * overflow on the resulting body) so list-count fixes catch what tail-trim
 * left behind. Returns the trimmed body. Idempotent — re-running has no
 * additional effect.
 */
export function alignDraftToSourceSkeleton(source: string, draft: string): string {
  if (!source || !draft) {
    return draft;
  }
  // Placeholder safety: when this aligner runs after reprotectMarkdownSpans,
  // the body carries `@@MDZH_*@@` placeholders for protected spans (links,
  // image destinations, autolinks, html attributes). Trimming a tail block
  // or list item that contains a placeholder would silently delete the
  // span and trip the downstream `protected_span_integrity` hard check.
  // Guard each trim with a count check and revert if the trim would change
  // the placeholder count.
  const draftPlaceholderCount = countProtectedPlaceholders(draft);
  let body = draft;
  let sourceSkeleton = parseStructure(source);
  let draftSkeleton = parseStructure(body);

  const tailPlan = planTailTrim(sourceSkeleton, draftSkeleton);
  if (tailPlan) {
    const candidate = applyTailTrim(body, draftSkeleton, tailPlan.dropFrom);
    if (countProtectedPlaceholders(candidate) === draftPlaceholderCount) {
      body = candidate;
      draftSkeleton = parseStructure(body);
    }
  }

  const overflowPlan = planListOverflowTrim(sourceSkeleton, draftSkeleton);
  if (overflowPlan) {
    const candidate = applyListItemTrim(body, overflowPlan.blockIndex, overflowPlan.keepItems);
    if (countProtectedPlaceholders(candidate) === draftPlaceholderCount) {
      body = candidate;
    }
  }

  // Final pass: literal-line dedup. Catches model duplicating an exact line
  // that lives outside the list / tail-block patterns (e.g., a single
  // `fileName: string` line inside an embedded type-signature template that
  // the model accidentally re-emits). Skipped when the source body itself
  // is empty.
  const literalPlan = planLiteralLineDedup(source, body);
  if (literalPlan) {
    const candidate = applyLiteralLineDedup(body, literalPlan.removeAtIndices);
    if (countProtectedPlaceholders(candidate) === draftPlaceholderCount) {
      body = candidate;
    }
  }
  void sourceSkeleton;
  return body;
}
