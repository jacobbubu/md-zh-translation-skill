import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AnchorCatalog, AnalysisAnchor, TranslationRunState } from "./translation-state.js";

export type KnownEntityDisplayPolicy =
  | "bare_english_ok"
  | "english_primary_with_cn_hint"
  | "chinese_primary_with_en_anchor"
  | "acronym_compound"
  | "no_forced_anchor";

export type KnownEntityCategory =
  | "product"
  | "company"
  | "framework"
  | "tool"
  | "package"
  | "platform"
  | "protocol"
  | "credential"
  | "concept"
  | "other";

export type KnownEntityRecord = {
  id: string;
  surface_forms: string[];
  aliases: string[];
  category: KnownEntityCategory;
  display_policy: KnownEntityDisplayPolicy;
  preferred_english: string;
  preferred_chinese_hint: string;
  family_id: string;
  notes?: string;
};

export type KnownEntitiesFile = {
  version: 1;
  entities: KnownEntityRecord[];
};

export type KnownEntityCandidateRecord = KnownEntityRecord & {
  confidence: number;
  evidence: Array<{
    chunk_id: string;
    segment_id: string;
  }>;
  source: "llm_analysis";
};

export type KnownEntityCandidatesFile = {
  version: 1;
  generated_at: string | null;
  entities: KnownEntityCandidateRecord[];
};

let cachedKnownEntities: KnownEntitiesFile | null = null;

export function loadKnownEntities(): KnownEntitiesFile {
  if (cachedKnownEntities) {
    return cachedKnownEntities;
  }

  const file = new URL("./data/known_entities.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as KnownEntitiesFile;
  cachedKnownEntities = parsed;
  return parsed;
}

export function buildKnownEntityCatalog(
  state: TranslationRunState,
  knownEntities: KnownEntitiesFile = loadKnownEntities()
): AnchorCatalog {
  const anchors: AnalysisAnchor[] = [];

  for (const entity of knownEntities.entities) {
    const sourceForms = dedupeForms(entity.surface_forms, entity.aliases, entity.preferred_english);
    const firstOccurrence = findFirstOccurrence(state, sourceForms);
    if (!firstOccurrence) {
      continue;
    }

    anchors.push({
      english: entity.preferred_english,
      chineseHint: entity.preferred_chinese_hint,
      familyKey: entity.family_id,
      displayPolicy: mapKnownPolicyToAnchorPolicy(entity.display_policy),
      firstOccurrence,
      sourceForms
    });
  }

  return {
    anchors,
    ignoredTerms: []
  };
}

export function mergeAnchorCatalogs(
  formalCatalog: AnchorCatalog,
  discoveredCatalog: AnchorCatalog
): AnchorCatalog {
  const seen = new Set<string>();
  const anchors: AnalysisAnchor[] = [];

  for (const anchor of [...formalCatalog.anchors, ...discoveredCatalog.anchors]) {
    const key = `${anchor.english.trim().toLowerCase()}::${anchor.familyKey.trim().toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    anchors.push(anchor);
  }

  return {
    anchors,
    ignoredTerms: [...formalCatalog.ignoredTerms, ...discoveredCatalog.ignoredTerms]
  };
}

export async function writeKnownEntityCandidatesIfRequested(
  catalog: AnchorCatalog,
  knownEntities: KnownEntitiesFile = loadKnownEntities()
): Promise<void> {
  const outputPath = process.env.MDZH_KNOWN_ENTITIES_CANDIDATES_PATH?.trim();
  if (!outputPath) {
    return;
  }

  const candidates = deriveKnownEntityCandidates(catalog, knownEntities);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        version: 1,
        generated_at: new Date().toISOString(),
        entities: candidates
      } satisfies KnownEntityCandidatesFile,
      null,
      2
    )}\n`,
    "utf8"
  );
}

function deriveKnownEntityCandidates(
  catalog: AnchorCatalog,
  knownEntities: KnownEntitiesFile
): KnownEntityCandidateRecord[] {
  const knownEnglish = new Set(knownEntities.entities.map((entity) => entity.preferred_english.trim().toLowerCase()));

  return catalog.anchors
    .filter((anchor) => !knownEnglish.has(anchor.english.trim().toLowerCase()))
    .map((anchor) => ({
      id: normalizeId(anchor.english),
      surface_forms: anchor.sourceForms && anchor.sourceForms.length > 0 ? [...anchor.sourceForms] : [anchor.english],
      aliases: [],
      category: "other",
      display_policy: mapAnchorPolicyToKnownPolicy(anchor.displayPolicy),
      preferred_english: anchor.english,
      preferred_chinese_hint: anchor.chineseHint,
      family_id: anchor.familyKey,
      confidence: 0.7,
      evidence: [
        {
          chunk_id: anchor.firstOccurrence.chunkId,
          segment_id: anchor.firstOccurrence.segmentId
        }
      ],
      source: "llm_analysis"
    }));
}

function mapKnownPolicyToAnchorPolicy(policy: KnownEntityDisplayPolicy) {
  switch (policy) {
    case "bare_english_ok":
      return "english-only" as const;
    case "english_primary_with_cn_hint":
      return "english-primary" as const;
    case "chinese_primary_with_en_anchor":
      return "chinese-primary" as const;
    case "acronym_compound":
      return "acronym-compound" as const;
    case "no_forced_anchor":
      return "english-only" as const;
  }
}

function mapAnchorPolicyToKnownPolicy(
  policy: AnalysisAnchor["displayPolicy"]
): KnownEntityDisplayPolicy {
  switch (policy) {
    case "english-only":
      return "bare_english_ok";
    case "english-primary":
      return "english_primary_with_cn_hint";
    case "chinese-primary":
    case "auto":
      return "chinese_primary_with_en_anchor";
    case "acronym-compound":
      return "acronym_compound";
    default:
      return "chinese_primary_with_en_anchor";
  }
}

function dedupeForms(surfaceForms: string[], aliases: string[], preferredEnglish: string): string[] {
  return [...new Set([...surfaceForms, ...aliases, preferredEnglish].map((item) => item.trim()).filter(Boolean))];
}

function findFirstOccurrence(
  state: TranslationRunState,
  forms: readonly string[]
): AnalysisAnchor["firstOccurrence"] | null {
  const orderedSegments = [...state.segments]
    .filter((segment) => segment.kind === "translatable")
    .sort((left, right) => left.order - right.order);

  for (const segment of orderedSegments) {
    if (forms.some((form) => containsWholePhrase(segment.source, form))) {
      return {
        chunkId: segment.chunkId,
        segmentId: segment.id
      };
    }
  }

  return null;
}

function containsWholePhrase(text: string, phrase: string): boolean {
  const trimmed = phrase.trim();
  if (!trimmed) {
    return false;
  }

  if (!/[A-Za-z0-9.+/_-]/.test(trimmed)) {
    return text.includes(trimmed);
  }

  const pattern = new RegExp(`(^|[^A-Za-z0-9.+/_-])${escapeRegExp(trimmed)}($|[^A-Za-z0-9.+/_-])`, "i");
  return pattern.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeId(english: string): string {
  return english.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "candidate";
}
