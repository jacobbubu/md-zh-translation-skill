---
title: "loonshots narrative paragraph hallucination (chunks 14/30/54/69/72/91/109)"
source: "loonshots.md (728 KB / 134 chunks)"
observed_runs:
  - 2026-04-29 (PR #103/#104/#105/#106): 11 fallback chunks
  - 2026-04-30 (PR #107 cleanMisbound): 7 fallback chunks (chunks 14/30/54/69/72/91/109)
  - 2026-04-30 sparse retry: 7 fallback chunks (same set, confirmed deterministic)
stable_failures:
  - chunk-14 (ONE AT A TIME, 4.3KB): paragraph repetition + missing radar/V-1 paragraphs
  - chunk-30 (JT AND LINDY, 8.2KB): English residue in segments 3-5 + missing China Clipper paragraph
  - chunk-54 (HOW TO WIN AT CHESS, 6.1KB): paragraph repetition + missing final Xerox PARC paragraph
  - chunk-69 (WHEN TERROR GOES VIRAL, 2.9KB): tail paragraph duplication + missing Joseph Smith paragraph
  - chunk-72 (THE INVISIBLE AXE, 4.3KB): wholesale duplication (paragraphs 6-9 copy paragraphs 2-5)
  - chunk-91 (DRUGS, 7.1KB): image placeholder duplication (@@MDZH_IMAGE_DESTINATION_0095@@ x2)
  - chunk-109 (Source Notes / INTRODUCTION, 10.4KB): draft returns meta/audit text instead of translation
remedies_tried_and_failed:
  - repair model default gpt-5.5 (PR #105)
  - rescue model gpt-5.5 (PR #92)
  - json-blocks no-fallback-to-freeform (PR #104)
  - cleanMisboundAnchorParens (PR #107)
  - structural skeleton aligner (PR #100/101/102)
disposition:
  - accept as model capability boundary
  - soft-gate fallback-to-source preserves structure (PR #106)
  - sparse-checkpoint-resume (PR #108) makes future retry cheap (~18 min vs ~2 hr)
  - revisit when codex CLI exposes a stronger model
---

# loonshots narrative paragraph hallucination

This fixture is a **summary marker**, not a runnable reproduction. The actual
chunks are too large (~50 KB total) to inline; they live in
`/Users/rongshen/vibe-coding/free-research/loonshots_markdown/loonshots.md`
under their respective headings (see `stable_failures` above).

## Why fixture-only, not a code fix

Every code-level remedy we have lands at this set's boundary:

- **Section reordering / paragraph dropping**: detectable by `paragraph_match`
  hard check, but neither repair (with explicit must_fix instructions) nor
  rescue (clean restart with stronger model) can recover. The model commits
  to a wrong segment shape on first draft and re-emits the same shape on
  retries, presumably because the prompt-cached context anchors it to the
  same hallucinated layout.

- **Image placeholder duplication** (chunk-91): the protected-span integrity
  check catches it but anchor injection / dedup utilities cannot remove a
  duplicate that the model placed at a structurally legitimate location.

- **Meta / audit text leakage** (chunk-109): the source is dense
  reference-style notes (book bibliography). The model interprets the
  request as "audit this" rather than "translate this" and returns control
  text. Draft contract `getDraftContractViolation` rejects each attempt;
  strict retry hits the same trap.

These failures are stable across runs (same 7 chunks fallback every time),
so the fixture's job is to:

1. Document the boundary so future contributors don't re-run the same
   patches against the same problems.
2. Provide a re-evaluation point when the underlying model improves —
   re-translate just these 7 chunks with the sparse-checkpoint-resume
   workflow (PR #108) and see whether the new model crosses the boundary.

## Sparse retry recipe

When a stronger model becomes available:

```bash
# 1. Identify the latest checkpoint key for loonshots.md
node scripts/recompute-cache-key.mjs  # or compute manually

# 2. Strip the 7 stable-failure chunks from the checkpoint
python3 -c "
import json, sys
cp_path = sys.argv[1]
with open(cp_path) as f: cp = json.load(f)
cp['completedChunks'] = [c for c in cp['completedChunks']
                          if c['chunkId'] not in
                          {'chunk-14','chunk-30','chunk-54','chunk-69',
                           'chunk-72','chunk-91','chunk-109'}]
with open(cp_path, 'w') as f: json.dump(cp, f, ensure_ascii=False)
" /tmp/mdzh-loonshots/checkpoint/<key>.json

# 3. Re-run with the new model
TRANSLATION_MODEL=<new-model> \
MDZH_CHECKPOINT_DIR=/tmp/mdzh-loonshots/checkpoint \
MDZH_ANALYSIS_CACHE_DIR=/tmp/mdzh-loonshots/analysis-cache \
MDZH_SOFT_GATE=true \
node dist/src/cli.js \
  --input /Users/rongshen/vibe-coding/free-research/loonshots_markdown/loonshots.md \
  --output /Users/rongshen/vibe-coding/free-research/loonshots_markdown/loonshots.zh.md
```

Sparse resume will reuse 127 chunks from cache and only retranslate the 7.
If any fall out of the failure set, that's a real model-capability win and
this fixture's `observed_runs` should be appended to.
