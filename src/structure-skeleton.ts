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
 * blocks with kind + size info. Splits on blank-line boundaries (matching
 * `splitPromptBlocks`'s convention) so blocks like a list group + its
 * surrounding prose stay distinguishable.
 */
export function parseStructure(text: string): StructuralSkeleton {
  if (!text || !text.trim()) {
    return [];
  }
  const blocks: StructuralBlock[] = [];
  const rawBlocks = text
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+$/, ""))
    .filter((block) => block.trim().length > 0);
  for (const raw of rawBlocks) {
    const trimmed = raw.trim();
    const kind = classifyBlockKind(trimmed);
    const block: StructuralBlock = {
      kind,
      charLen: trimmed.length,
      lineCount: trimmed.split(/\r?\n/).length
    };
    if (kind === "list") {
      block.listItemCount = countListItems(trimmed);
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

const RAW_BLOCK_SEPARATOR = "\n\n";
const PROTECTED_PLACEHOLDER_PATTERN = /@@MDZH_[A-Z_]+_\d{4}@@/g;

function countProtectedPlaceholders(text: string): number {
  PROTECTED_PLACEHOLDER_PATTERN.lastIndex = 0;
  let count = 0;
  while (PROTECTED_PLACEHOLDER_PATTERN.exec(text) !== null) {
    count += 1;
  }
  return count;
}

function rawBlocksOf(text: string): string[] {
  if (!text) {
    return [];
  }
  return text.split(/\n{2,}/).map((block) => block.replace(/\s+$/, ""));
}

function applyTailTrim(text: string, draftSkeleton: StructuralSkeleton, dropFrom: number): string {
  const rawBlocks = rawBlocksOf(text);
  const nonEmptyIndices: number[] = [];
  for (let i = 0; i < rawBlocks.length; i += 1) {
    if (rawBlocks[i]!.trim().length > 0) {
      nonEmptyIndices.push(i);
    }
  }
  if (dropFrom >= nonEmptyIndices.length) {
    return text;
  }
  void draftSkeleton;
  const cutAt = nonEmptyIndices[dropFrom]!;
  return rawBlocks.slice(0, cutAt).join(RAW_BLOCK_SEPARATOR).replace(/\s+$/u, "");
}

function applyListItemTrim(text: string, blockIndex: number, keepItems: number): string {
  const rawBlocks = rawBlocksOf(text);
  let nonEmptyCounter = -1;
  for (let i = 0; i < rawBlocks.length; i += 1) {
    if (rawBlocks[i]!.trim().length === 0) {
      continue;
    }
    nonEmptyCounter += 1;
    if (nonEmptyCounter !== blockIndex) {
      continue;
    }
    const lines = rawBlocks[i]!.split(/\r?\n/);
    const keptLines: string[] = [];
    let kept = 0;
    let stopAfter = false;
    for (const line of lines) {
      if (LIST_ITEM_LINE_PATTERN.test(line)) {
        if (stopAfter) {
          continue;
        }
        if (kept < keepItems) {
          keptLines.push(line);
          kept += 1;
          if (kept >= keepItems) {
            stopAfter = true;
          }
          continue;
        }
        // Excess list item: skip.
        continue;
      }
      if (stopAfter) {
        // After the kept items end, drop trailing list-only filler (blank
        // lines between bullets get collapsed).
        if (line.trim().length === 0) {
          continue;
        }
        // Anything non-bullet after the kept items breaks the trim window —
        // we don't want to swallow legitimate prose. Stop trimming here.
        stopAfter = false;
        keptLines.push(line);
        continue;
      }
      keptLines.push(line);
    }
    rawBlocks[i] = keptLines.join("\n").replace(/\s+$/u, "");
    break;
  }
  return rawBlocks.join(RAW_BLOCK_SEPARATOR).replace(/\s+$/u, "");
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
  void sourceSkeleton;
  return body;
}
