import { buildGateAuditPrompt, buildInitialPrompt, buildRepairPrompt, buildStylePolishPrompt } from "./internal/prompts/scheme-h.js";
import { DefaultCodexExecutor, type CodexExecutor } from "./codex-exec.js";
import { FormattingError, HardGateError } from "./errors.js";
import { formatTranslatedBody, reconstructMarkdown } from "./format.js";
import { extractFrontmatter, protectMarkdownSpans, restoreMarkdownSpans } from "./markdown-protection.js";

const DEFAULT_MODEL = "gpt-5.4-mini";
const MAX_REPAIR_CYCLES = 2;

type AuditCheckKey =
  | "paragraph_match"
  | "first_mention_bilingual"
  | "numbers_units_logic"
  | "chinese_punctuation"
  | "unit_conversion_boundary";

export type GateAudit = {
  hard_checks: Record<AuditCheckKey, { pass: boolean; problem: string }>;
  must_fix: string[];
};

export type TranslateProgress =
  | "draft"
  | "audit"
  | "repair"
  | "style"
  | "format";

export type TranslateOptions = {
  cwd?: string;
  sourcePathHint?: string;
  model?: string;
  executor?: CodexExecutor;
  formatter?: typeof formatTranslatedBody;
  onProgress?: (message: string, stage: TranslateProgress) => void;
};

export type TranslateResult = {
  markdown: string;
  model: string;
  repairCyclesUsed: number;
  styleApplied: boolean;
  gateAudit: GateAudit;
};

const GATE_AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hard_checks", "must_fix"],
  properties: {
    hard_checks: {
      type: "object",
      additionalProperties: false,
      required: [
        "paragraph_match",
        "first_mention_bilingual",
        "numbers_units_logic",
        "chinese_punctuation",
        "unit_conversion_boundary"
      ],
      properties: {
        paragraph_match: auditItemSchema(),
        first_mention_bilingual: auditItemSchema(),
        numbers_units_logic: auditItemSchema(),
        chinese_punctuation: auditItemSchema(),
        unit_conversion_boundary: auditItemSchema()
      }
    },
    must_fix: {
      type: "array",
      items: {
        type: "string"
      }
    }
  }
} as const;

function auditItemSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["pass", "problem"],
    properties: {
      pass: { type: "boolean" },
      problem: { type: "string" }
    }
  };
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const firstFenceEnd = trimmed.indexOf("\n");
    const lastFenceStart = trimmed.lastIndexOf("```");
    if (firstFenceEnd >= 0 && lastFenceStart > firstFenceEnd) {
      return trimmed.slice(firstFenceEnd + 1, lastFenceStart).trim();
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new HardGateError("Gate audit did not return a JSON object.");
  }
  return trimmed.slice(start, end + 1);
}

export function parseGateAudit(text: string): GateAudit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch (error) {
    throw new HardGateError(error instanceof Error ? error.message : String(error));
  }

  if (!parsed || typeof parsed !== "object") {
    throw new HardGateError("Gate audit JSON is not an object.");
  }

  const data = parsed as Record<string, unknown>;
  const hardChecks = data.hard_checks;
  const mustFix = data.must_fix;
  const keys: AuditCheckKey[] = [
    "paragraph_match",
    "first_mention_bilingual",
    "numbers_units_logic",
    "chinese_punctuation",
    "unit_conversion_boundary"
  ];

  if (!hardChecks || typeof hardChecks !== "object") {
    throw new HardGateError("Gate audit JSON is missing hard_checks.");
  }

  for (const key of keys) {
    const item = (hardChecks as Record<string, unknown>)[key];
    if (!item || typeof item !== "object") {
      throw new HardGateError(`Gate audit JSON is missing hard_checks.${key}.`);
    }
    const typed = item as Record<string, unknown>;
    if (typeof typed.pass !== "boolean" || typeof typed.problem !== "string") {
      throw new HardGateError(`Gate audit JSON has an invalid hard_checks.${key} entry.`);
    }
  }

  if (!Array.isArray(mustFix) || !mustFix.every((item) => typeof item === "string")) {
    throw new HardGateError("Gate audit JSON must_fix must be an array of strings.");
  }

  return {
    hard_checks: hardChecks as GateAudit["hard_checks"],
    must_fix: mustFix.map((item) => item.trim()).filter(Boolean)
  };
}

function isHardPass(audit: GateAudit): boolean {
  return Object.values(audit.hard_checks).every((item) => item.pass);
}

function report(options: TranslateOptions, stage: TranslateProgress, message: string): void {
  options.onProgress?.(message, stage);
}

export async function translateMarkdownArticle(source: string, options: TranslateOptions = {}): Promise<TranslateResult> {
  const executor = options.executor ?? new DefaultCodexExecutor();
  const formatter = options.formatter ?? formatTranslatedBody;
  const model = options.model ?? (process.env.TRANSLATION_MODEL?.trim() || DEFAULT_MODEL);
  const cwd = options.cwd ?? process.cwd();
  const sourcePathHint = options.sourcePathHint ?? "article.md";
  const { frontmatter, body } = extractFrontmatter(source);
  const { protectedBody, spans } = protectMarkdownSpans(body);

  report(options, "draft", `Starting translation with model ${model}.`);
  const draftResult = await executor.execute(buildInitialPrompt(protectedBody), {
    cwd,
    model,
    onStderr: (chunk) => report(options, "draft", chunk.trim())
  });
  let currentTranslation = draftResult.text.trim();

  report(options, "audit", "Running hard gate audit.");
  let auditResult = await executor.execute(buildGateAuditPrompt(protectedBody, currentTranslation), {
    cwd,
    model,
    outputSchema: GATE_AUDIT_SCHEMA,
    onStderr: (chunk) => report(options, "audit", chunk.trim())
  });
  let gateAudit = parseGateAudit(auditResult.text);
  let repairCyclesUsed = 0;

  while (!isHardPass(gateAudit) && repairCyclesUsed < MAX_REPAIR_CYCLES && gateAudit.must_fix.length > 0) {
    repairCyclesUsed += 1;
    report(options, "repair", `Repair cycle ${repairCyclesUsed} of ${MAX_REPAIR_CYCLES}.`);
    const repairResult = await executor.execute(buildRepairPrompt(protectedBody, currentTranslation, gateAudit.must_fix), {
      cwd,
      model,
      onStderr: (chunk) => report(options, "repair", chunk.trim())
    });
    currentTranslation = repairResult.text.trim();

    report(options, "audit", `Rechecking hard gate after repair cycle ${repairCyclesUsed}.`);
    auditResult = await executor.execute(buildGateAuditPrompt(protectedBody, currentTranslation), {
      cwd,
      model,
      outputSchema: GATE_AUDIT_SCHEMA,
      onStderr: (chunk) => report(options, "audit", chunk.trim())
    });
    gateAudit = parseGateAudit(auditResult.text);
  }

  if (!isHardPass(gateAudit)) {
    const remaining = gateAudit.must_fix.length > 0 ? gateAudit.must_fix.join(" | ") : "Gate audit still failed after the repair loop.";
    throw new HardGateError(`Hard gate failed after ${repairCyclesUsed} repair cycle(s): ${remaining}`);
  }

  report(options, "style", "Applying style polish after hard gate pass.");
  const styleResult = await executor.execute(buildStylePolishPrompt(protectedBody, currentTranslation), {
    cwd,
    model,
    onStderr: (chunk) => report(options, "style", chunk.trim())
  });

  const restoredBody = restoreMarkdownSpans(styleResult.text.trim(), spans);
  report(options, "format", "Formatting translated Markdown.");
  try {
    const formattedBody = await formatter(restoredBody, sourcePathHint);
    const markdown = reconstructMarkdown(frontmatter, formattedBody);
    return {
      markdown,
      model,
      repairCyclesUsed,
      styleApplied: true,
      gateAudit
    };
  } catch (error) {
    throw new FormattingError(error instanceof Error ? error.message : String(error));
  }
}
