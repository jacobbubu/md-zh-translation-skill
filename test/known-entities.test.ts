import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildKnownEntityCatalog,
  loadKnownEntities,
  mergeAnchorCatalogs,
  normalizeDiscoveredAnchorCatalog,
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
  assert.ok(knownEntities.entities.some((entity) => entity.id === "git"));
  assert.ok(knownEntities.entities.some((entity) => entity.id === "linux"));
  assert.ok(knownEntities.entities.some((entity) => entity.id === "macos"));
  assert.ok(knownEntities.entities.some((entity) => entity.id === "anthropic"));
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
          "pip and cargo can also access AWS credentials when allowed, and the npm registry can be queried.",
          "",
          "Git operations run alongside Linux and macOS and differ from Windows, while Anthropic ships tooling for Node.js and Python.",
          "",
          "Linux bubblewrap works with Seatbelt in related sandbox setups."
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
              "pip and cargo can also access AWS credentials when allowed, and the npm registry can be queried.",
              "",
              "Git operations run alongside Linux and macOS and differ from Windows, while Anthropic ships tooling for Node.js and Python.",
              "",
              "Linux bubblewrap works with Seatbelt in related sandbox setups."
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

  const npmRegistry = slice.requiredAnchors.find((anchor) => anchor.english === "npm registry");
  assert.ok(npmRegistry);
  assert.equal(npmRegistry.displayPolicy, "chinese-primary");

  const bubblewrap = slice.requiredAnchors.find((anchor) => anchor.english === "bubblewrap");
  assert.ok(bubblewrap);
  assert.equal(bubblewrap.displayPolicy, "english-primary");

  const seatbelt = slice.requiredAnchors.find((anchor) => anchor.english === "Seatbelt");
  assert.ok(seatbelt);
  assert.equal(seatbelt.displayPolicy, "english-primary");

  const awsCredentials = slice.requiredAnchors.find((anchor) => anchor.english === "AWS credentials");
  assert.ok(awsCredentials);
  assert.equal(awsCredentials.displayPolicy, "acronym-compound");

  for (const english of ["Git", "Linux", "macOS", "Windows", "Anthropic", "Node.js", "Python"]) {
    const anchor = slice.requiredAnchors.find((item) => item.english === english);
    assert.ok(anchor, `${english} should be present in required anchors`);
    assert.equal(anchor.displayPolicy, "english-only");
    assert.deepEqual(anchor.allowedDisplayForms, [english]);
  }
});

test("buildKnownEntityCatalog preserves the source surface form for formal known entities", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Prompt injection attacks can be blocked.\n",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Prompt injection attacks can be blocked.\n",
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
  const anchor = catalog.anchors.find((item) => item.familyKey === "prompt_injection_attacks");

  assert.ok(anchor);
  assert.equal(anchor.english, "Prompt injection attacks");
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

test("mergeAnchorCatalogs dedupes same english surface forms even when family keys differ", () => {
  const formalCatalog: AnchorCatalog = {
    anchors: [
      {
        english: "YOLO mode",
        chineseHint: "YOLO 模式",
        familyKey: "yolo_mode",
        displayPolicy: "english-primary",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        },
        sourceForms: ["YOLO mode"]
      }
    ],
    ignoredTerms: []
  };

  const discoveredCatalog: AnchorCatalog = {
    anchors: [
      {
        english: "YOLO mode",
        chineseHint: "YOLO 模式",
        familyKey: "yolo mode",
        displayPolicy: "acronym-compound",
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        },
        sourceForms: ["YOLO mode"]
      }
    ],
    ignoredTerms: []
  };

  const merged = mergeAnchorCatalogs(formalCatalog, discoveredCatalog);

  assert.equal(merged.anchors.length, 1);
  assert.equal(merged.anchors[0]?.displayPolicy, "english-primary");
  assert.equal(merged.anchors[0]?.familyKey, "yolo_mode");
});

test("normalizeDiscoveredAnchorCatalog promotes a heading surface over an earlier paraphrase", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "- Accidental destruction can happen when cleanup commands are misunderstood.\n",
        separatorAfter: "\n\n",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "- Accidental destruction can happen when cleanup commands are misunderstood.\n",
            separatorAfter: "\n\n",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      },
      {
        source: [
          "### Accidental Destructive Operations",
          "",
          "Filesystem isolation prevents modifications outside the designated safe zone."
        ].join("\n"),
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: [
              "### Accidental Destructive Operations",
              "",
              "Filesystem isolation prevents modifications outside the designated safe zone."
            ].join("\n"),
            separatorAfter: "",
            spanIds: [],
            headingHints: ["Accidental Destructive Operations"],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const normalized = normalizeDiscoveredAnchorCatalog(state, {
    anchors: [
      {
        english: "Accidental destruction",
        chineseHint: "意外破坏",
        familyKey: "accidental destruction",
        displayPolicy: "chinese-primary",
        sourceForms: ["Accidental destruction", "Accidental Destructive Operations"],
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  });

  assert.equal(normalized.anchors[0]?.english, "Accidental Destructive Operations");
  assert.equal(normalized.anchors[0]?.familyKey, "accidental destructive operations");
  assert.deepEqual(normalized.anchors[0]?.firstOccurrence, {
    chunkId: "chunk-2",
    segmentId: "chunk-2-segment-1"
  });
});

test("normalizeDiscoveredAnchorCatalog rejects discovered CLI flag anchors", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "The `--dangerously-skip-permissions` flag exists as an escape hatch.\n",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "The `--dangerously-skip-permissions` flag exists as an escape hatch.\n",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const normalized = normalizeDiscoveredAnchorCatalog(state, {
    anchors: [
      {
        english: "--dangerously-skip-permissions flag",
        chineseHint: "跳过权限标志",
        familyKey: "dangerously-skip-permissions-flag",
        displayPolicy: "english-primary",
        sourceForms: ["--dangerously-skip-permissions flag"],
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  });

  assert.equal(normalized.anchors.length, 0);
  assert.deepEqual(normalized.ignoredTerms, [
    {
      english: "--dangerously-skip-permissions flag",
      reason: "code-like surface form should not be promoted into anchor catalog"
    }
  ]);
});

test("normalizeDiscoveredAnchorCatalog rejects discovered config-path anchors", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Open .claude/settings.json to configure the sandbox.\n",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Open .claude/settings.json to configure the sandbox.\n",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const normalized = normalizeDiscoveredAnchorCatalog(state, {
    anchors: [
      {
        english: ".claude/settings.json",
        chineseHint: "沙盒配置文件",
        familyKey: "claude-settings-json",
        displayPolicy: "english-primary",
        sourceForms: [".claude/settings.json"],
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  });

  assert.equal(normalized.anchors.length, 0);
  assert.deepEqual(normalized.ignoredTerms, [
    {
      english: ".claude/settings.json",
      reason: "code-like surface form should not be promoted into anchor catalog"
    }
  ]);
});

test("normalizeDiscoveredAnchorCatalog rejects anchors whose chineseHint sandwiches an english subtoken", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Instead, we use a **Schema-First Extraction** method.\n",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Instead, we use a **Schema-First Extraction** method.\n",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const normalized = normalizeDiscoveredAnchorCatalog(state, {
    anchors: [
      {
        english: "Schema-First Extraction",
        chineseHint: "先 Schema 抽取",
        familyKey: "schema-first-extraction",
        displayPolicy: "acronym-compound",
        sourceForms: ["Schema-First Extraction"],
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  });

  assert.equal(normalized.anchors.length, 0);
  assert.deepEqual(normalized.ignoredTerms, [
    {
      english: "Schema-First Extraction",
      reason:
        "chineseHint sandwiches an english subtoken of the anchor, which breaks bold / bilingual rendering"
    }
  ]);
});

test("normalizeDiscoveredAnchorCatalog keeps anchors with an english prefix followed by Chinese", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "Try Claude Code today.\n",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "Try Claude Code today.\n",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const normalized = normalizeDiscoveredAnchorCatalog(state, {
    anchors: [
      {
        english: "Claude Code",
        chineseHint: "Claude 代码",
        familyKey: "claude-code",
        displayPolicy: "english-primary",
        sourceForms: ["Claude Code"],
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  });

  assert.equal(normalized.anchors.length, 1);
  assert.equal(normalized.anchors[0]?.english, "Claude Code");
  assert.deepEqual(normalized.ignoredTerms, []);
});

test("normalizeDiscoveredAnchorCatalog keeps anchors whose chineseHint contains no english", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "SLMs can index your corpus locally.\n",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "SLMs can index your corpus locally.\n",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const normalized = normalizeDiscoveredAnchorCatalog(state, {
    anchors: [
      {
        english: "SLMs",
        chineseHint: "小语言模型",
        familyKey: "slms",
        displayPolicy: "acronym-compound",
        sourceForms: ["SLMs"],
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  });

  assert.equal(normalized.anchors.length, 1);
  assert.equal(normalized.anchors[0]?.english, "SLMs");
  assert.deepEqual(normalized.ignoredTerms, []);
});

test("normalizeDiscoveredAnchorCatalog keeps anchors whose hint english is unrelated to the anchor english", () => {
  const state = createTranslationRunState({
    sourcePathHint: "sample.md",
    documentTitle: "Sample",
    frontmatterPresent: false,
    protectedSpans: [],
    chunks: [
      {
        source: "This paper covers Knowledge Graphs end-to-end.\n",
        separatorAfter: "",
        headingPath: ["Sample"],
        segments: [
          {
            kind: "translatable",
            source: "This paper covers Knowledge Graphs end-to-end.\n",
            separatorAfter: "",
            spanIds: [],
            headingHints: [],
            specialNotes: []
          }
        ]
      }
    ]
  });

  const normalized = normalizeDiscoveredAnchorCatalog(state, {
    anchors: [
      {
        english: "Knowledge Graphs",
        chineseHint: "知识图谱（KG）汇总",
        familyKey: "knowledge-graphs",
        displayPolicy: "chinese-primary",
        sourceForms: ["Knowledge Graphs"],
        firstOccurrence: {
          chunkId: "chunk-1",
          segmentId: "chunk-1-segment-1"
        }
      }
    ],
    ignoredTerms: []
  });

  assert.equal(normalized.anchors.length, 1);
  assert.equal(normalized.anchors[0]?.english, "Knowledge Graphs");
  assert.deepEqual(normalized.ignoredTerms, []);
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
          english: "Firejail",
          chineseHint: "Linux 沙箱工具",
          familyKey: "firejail",
          displayPolicy: "english-primary",
          firstOccurrence: {
            chunkId: "chunk-2",
            segmentId: "chunk-2-segment-1"
          },
          sourceForms: ["Firejail"]
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
    assert.equal(saved.entities[0]?.preferred_english, "Firejail");
    assert.equal(saved.entities[0]?.display_policy, "english_primary_with_cn_hint");
  } finally {
    if (previous === undefined) {
      delete process.env.MDZH_KNOWN_ENTITIES_CANDIDATES_PATH;
    } else {
      process.env.MDZH_KNOWN_ENTITIES_CANDIDATES_PATH = previous;
    }
  }
});
