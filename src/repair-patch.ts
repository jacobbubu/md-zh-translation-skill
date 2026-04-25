import type { RepairTask } from "./translation-state.js";

/**
 * Programmatic application of structured repair patches.
 *
 * The hard gate audit already produces `repair_targets` with explicit
 * `currentText` / `targetText` for many failures. Historically we still asked
 * the LLM to rewrite the whole segment to apply them, which is both slow and
 * the dominant source of "repair caused unrelated drift". When the patch can
 * be applied as a literal, unique replacement on the protected body, the LLM
 * call adds nothing — we can apply the change ourselves and leave the rest of
 * the segment untouched, by construction.
 *
 * This module is intentionally conservative:
 * - The patch applies only when `currentText` matches exactly once.
 * - Patches must not introduce or break protected-span placeholders
 *   (`@@MDZH_*@@`).
 * - Anything else (multiple matches, missing currentText, placeholder issues)
 *   is left to the LLM repair lane.
 */

const PROTECTED_PLACEHOLDER_PATTERN = /@@MDZH_[A-Z_]+_\d{4}@@/g;

export type PatchSkipReason =
  | "no_structured_target"
  | "missing_current_or_target"
  | "current_not_found"
  | "current_text_ambiguous"
  | "current_contains_placeholder"
  | "target_contains_placeholder"
  | "target_changes_placeholder_count";

export type PatchAttemptOutcome =
  | { status: "applied"; taskId: string; before: string; after: string }
  | { status: "skipped"; taskId: string; reason: PatchSkipReason };

export type RepairPatchResult = {
  patchedBody: string;
  appliedTaskIds: string[];
  remainingTasks: RepairTask[];
  attempts: PatchAttemptOutcome[];
};

function countPlaceholders(text: string): number {
  PROTECTED_PLACEHOLDER_PATTERN.lastIndex = 0;
  let count = 0;
  while (PROTECTED_PLACEHOLDER_PATTERN.exec(text) !== null) {
    count += 1;
  }
  return count;
}

function containsPlaceholder(text: string): boolean {
  PROTECTED_PLACEHOLDER_PATTERN.lastIndex = 0;
  return PROTECTED_PLACEHOLDER_PATTERN.test(text);
}

function uniqueIndexOf(haystack: string, needle: string): number {
  const first = haystack.indexOf(needle);
  if (first < 0) {
    return -1;
  }
  const second = haystack.indexOf(needle, first + needle.length);
  if (second >= 0) {
    return -2;
  }
  return first;
}

/**
 * Try to apply each task's `structuredTarget` as a literal patch on the
 * protected body. Tasks that can't be applied safely are returned unchanged
 * for the LLM repair lane to handle.
 */
export function applyStructuredRepairPatches(
  protectedBody: string,
  tasks: readonly RepairTask[]
): RepairPatchResult {
  const attempts: PatchAttemptOutcome[] = [];
  const appliedTaskIds: string[] = [];
  const remainingTasks: RepairTask[] = [];
  let body = protectedBody;

  for (const task of tasks) {
    const target = task.structuredTarget;
    if (!target) {
      attempts.push({ status: "skipped", taskId: task.id, reason: "no_structured_target" });
      remainingTasks.push(task);
      continue;
    }

    const currentText = target.currentText?.trim() ?? "";
    const targetText = target.targetText?.trim() ?? "";
    if (!currentText || !targetText || currentText === targetText) {
      attempts.push({ status: "skipped", taskId: task.id, reason: "missing_current_or_target" });
      remainingTasks.push(task);
      continue;
    }

    if (containsPlaceholder(currentText)) {
      attempts.push({ status: "skipped", taskId: task.id, reason: "current_contains_placeholder" });
      remainingTasks.push(task);
      continue;
    }
    if (containsPlaceholder(targetText)) {
      attempts.push({ status: "skipped", taskId: task.id, reason: "target_contains_placeholder" });
      remainingTasks.push(task);
      continue;
    }

    const matchIndex = uniqueIndexOf(body, currentText);
    if (matchIndex === -1) {
      attempts.push({ status: "skipped", taskId: task.id, reason: "current_not_found" });
      remainingTasks.push(task);
      continue;
    }
    if (matchIndex === -2) {
      attempts.push({ status: "skipped", taskId: task.id, reason: "current_text_ambiguous" });
      remainingTasks.push(task);
      continue;
    }

    const before = body.slice(0, matchIndex);
    const after = body.slice(matchIndex + currentText.length);
    const next = before + targetText + after;

    if (countPlaceholders(next) !== countPlaceholders(body)) {
      attempts.push({ status: "skipped", taskId: task.id, reason: "target_changes_placeholder_count" });
      remainingTasks.push(task);
      continue;
    }

    body = next;
    appliedTaskIds.push(task.id);
    attempts.push({ status: "applied", taskId: task.id, before: currentText, after: targetText });
  }

  return {
    patchedBody: body,
    appliedTaskIds,
    remainingTasks,
    attempts
  };
}
