import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildKnownEntityCatalog,
  loadKnownEntities,
  mergeAnchorCatalogs,
  writeKnownEntityCandidatesIfRequested
} from "../src/known-entities.js";
import {
  applyAnchorCatalog,
  buildSegmentTaskSlice,
  createTranslationRunState,
  type AnchorCatalog
} from "../src/translation-state.js";

test("loadKnownEntities exposes the bundled formal known-entity table", () => {
  const knownEntities = loadKnownEntities();

  assert.equal(knownEntities.version, 1);
  assert.ok(knownEntities.entities.some((entity) => entity.id === "claude"));
  assert.ok(knownEntities.entities.some((entity) => entity.id === "ssh-keys"));
  assert.ok(knownEntities.entities.some((entity) => entity.id === "sandbox-mode"));
  assert.ok(knownEntities.entities.some((entity) => entity.id === "rag"));
});

test("buildKnownEntityCatalog seeds bare-english known entities before model analysis", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Tell Claude:\n\nClaude Code can also run here.",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Tell Claude:\n\nClaude Code can also run here.",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const catalog = buildKnownEntityCatalog(state);
  applyAnchorCatalog(state, catalog);
  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");

  const claude = slice.requiredAnchors.find((anchor) => anchor.english === "Claude");
  assert.ok(claude);
  assert.equal(claude.displayPolicy, "english-only");
  assert.equal(claude.requiresBilingual, false);
  assert.deepEqual(claude.allowedDisplayForms, ["Claude"]);
});

test("buildKnownEntityCatalog applies formal display policies for promoted entities", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: [
          "sandbox mode prevents prompt injection attacks.",
          "",
          "Enable YOLO mode when needed.",
          "",
          "A supply chain attacks example can appear in RAG docs and PyPI docs.",
          "",
          "pip and cargo can also access AWS credentials when allowed."
        ].join("\n"),
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: [
              "sandbox mode prevents prompt injection attacks.",
              "",
              "Enable YOLO mode when needed.",
              "",
              "A supply chain attacks example can appear in RAG docs and PyPI docs.",
              "",
              "pip and cargo can also access AWS credentials when allowed."
            ].join("\n"),
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const catalog = buildKnownEntityCatalog(state);
  applyAnchorCatalog(state, catalog);
  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");

  const sandboxMode = slice.requiredAnchors.find((anchor) => anchor.english === "sandbox mode");
  assert.ok(sandboxMode);
  assert.equal(sandboxMode.displayPolicy, "chinese-primary");

  const yoloMode = slice.requiredAnchors.find((anchor) => anchor.english === "YOLO mode");
  assert.ok(yoloMode);
  assert.equal(yoloMode.displayPolicy, "english-primary");

  const pypi = slice.requiredAnchors.find((anchor) => anchor.english === "PyPI");
  assert.ok(pypi);
  assert.equal(pypi.displayPolicy, "acronym-compound");

  const rag = slice.requiredAnchors.find((anchor) => anchor.english === "RAG");
  assert.ok(rag);
  assert.equal(rag.displayPolicy, "acronym-compound");

  const promptInjection = slice.requiredAnchors.find((anchor) => anchor.english === "prompt injection attacks");
  assert.ok(promptInjection);
  assert.equal(promptInjection.displayPolicy, "chinese-primary");

  const pip = slice.requiredAnchors.find((anchor) => anchor.english === "pip");
  assert.ok(pip);
  assert.equal(pip.displayPolicy, "english-only");

  const cargo = slice.requiredAnchors.find((anchor) => anchor.english === "cargo");
  assert.ok(cargo);
  assert.equal(cargo.displayPolicy, "english-only");

  const awsCredentials = slice.requiredAnchors.find((anchor) => anchor.english === "AWS credentials");
  assert.ok(awsCredentials);
  assert.equal(awsCredentials.displayPolicy, "acronym-compound");
});

test("buildKnownEntityCatalog matches slash-delimited bare-english tools as separate formal entities", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "- npm/pip/cargo package registries (default allowlist)\n",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "- npm/pip/cargo package registries (default allowlist)\n",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const catalog = buildKnownEntityCatalog(state);
  applyAnchorCatalog(state, catalog);
  const slice = buildSegmentTaskSlice(state, "chunk-1", "chunk-1-segment-1");

  assert.ok(slice.requiredAnchors.some((anchor) => anchor.english === "npm"));
  assert.ok(slice.requiredAnchors.some((anchor) => anchor.english === "pip"));
  assert.ok(slice.requiredAnchors.some((anchor) => anchor.english === "cargo"));
});

test("mergeAnchorCatalogs keeps formal known entities ahead of discovered duplicates", () => {
  const formalCatalog: AnchorCatalog = {
    anchors: [
      {
        english: "Claude",
        chineseHint: "Anthropic 的 AI 助手",
        familyKey: "claude",
        displayPolicy: "english-only",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        },
        sourceForms: ["Claude"]
      }
    ],
    ignoredTerms: []
  };

  const discoveredCatalog: AnchorCatalog = {
    anchors: [
      {
        english: "Claude",
        chineseHint: "Anthropic 的 AI 助手",
        familyKey: "claude",
        displayPolicy: "english-primary",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  };

  const merged = mergeAnchorCatalogs(formalCatalog, discoveredCatalog);

  assert.equal(merged.anchors.length, 1);
  assert.equal(merged.anchors[0]?.displayPolicy, "english-only");
});

test("writeKnownEntityCandidatesIfRequested persists unknown anchors into a candidate file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mdzh-known-entities-"));
  const outputPath = path.join(tempDir, "known_entities_candidates.json");
  const previous = process.env.MDZH_KNOWN_ENTITIES_CANDIDATES_PATH;
  process.env.MDZH_KNOWN_ENTITIES_CANDIDATES_PATH = outputPath;

  try {
    const result = await writeKnownEntityCandidatesIfRequested({
      anchors: [
        {
          english: "Seatbelt",
          chineseHint: "macOS 沙箱框架",
          familyKey: "seatbelt",
          displayPolicy: "english-primary",
          firstOccurrence: {
            chunkId: "chunk-2",
            segmentId: "chunk-2-segment-1"
          },
          sourceForms: ["Seatbelt"]
        }
      ],
      ignoredTerms: []
    });

    assert.equal(result.written, true);
    assert.equal(result.count, 1);
    assert.equal(result.outputPath, outputPath);

    const saved = JSON.parse(await readFile(outputPath, "utf8")) as {
      version: number;
      entities: Array<{ preferred_english: string; display_policy: string }>;
    };

    assert.equal(saved.version, 1);
    assert.equal(saved.entities[0]?.preferred_english, "Seatbelt");
    assert.equal(saved.entities[0]?.display_policy, "english_primary_with_cn_hint");
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_KNOWN_ENTITIES_CANDIDATES_PATH;
    } else {
      process.env.MDZH_KNOWN_ENTITIES_CANDIDATES_PATH = previous;
    }
  }
});
