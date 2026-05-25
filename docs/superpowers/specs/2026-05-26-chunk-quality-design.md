# Chunk Quality Score — Design Spec

**Date:** 2026-05-26
**Status:** Draft — awaiting user review
**Scope:** New scanner phase that measures the quality of chunks Muninn would produce when ingesting the scanned corpus. Combines rule-based (Tier 1) and embedding-based (Tier 2) metrics. Surfaces per-doc and corpus-level scores in JSON, human-readable Markdown, narrative Markdown, and dashboard.

---

## 1. Motivation

Huginn's job is to project what Muninn will see when it ingests a document set. Today the projection (Phase 3) approximates "chunks" with paragraph-blocks (`\n\n`-split) and scores them with a rule-only formula (`scoreBlock`). This has three problems:

1. **The strategy taxonomy diverges from Muninn.** Huginn says `heading_sections | table_rows | sliding_window`; Muninn actually uses `semantic | table_rows | sliding_window`, chosen by MIME type. Huginn's `recommendedChunkStrategy` does not predict reality.
2. **No real chunks are produced.** Paragraph-blocks are unordered, may not correspond 1:1 to chunks, and have no overlap. Metrics that depend on chunk sequence (coherence drop, intra-chunk cohesion) cannot be computed.
3. **No embedding-based signal.** Tier 2 metrics — which catch semantic discontinuities the rule layer misses — are entirely absent.

Goal: a new phase that mirrors Muninn's chunker faithfully, scores the produced chunks with Tier 1 + Tier 2 metrics, and persists only aggregates (no chunk content) to the report. Output paints a deeper picture of what Muninn's retrieval-quality ceiling actually looks like for this corpus.

## 2. Constraints

- **Single codebase, single Docker compose.** No new services; no Python sidecar.
- **TypeScript only.** Bun runtime.
- **Content-leak guard:** any serialized string ≤ 120 chars. No chunk text, sentence text, or document content in the report.
- **Ollama is the only model service.** BGE-M3 for embeddings (already used by Phase 5 fingerprint).
- **No unit-test framework.** Project convention: deterministic startup tests, gated like `runRegexTests()`.
- **Embedding budget must be adjustable** via run context (fast / normal / full).

## 3. Architecture overview

A new phase `4-chunk-quality.ts` runs after Phase 3 (projection) and before Phase 4-fingerprint (renumbered to 5). Current phases 4–9 shift +1.

Pipeline becomes:

```
1-harvest → 2-parse → 3-projection (slimmed) → 4-chunk-quality (NEW) →
5-fingerprint → 6-cluster → 7-references → 8-requirements →
9-validate → 10-html / 10-narrative / 10-report
```

The new phase orchestrates:
1. For each parsed doc with `parseSuccess && textContent`:
   1. Resolve MIME type from extension (`src/utils/muninn-mirror/mime-map.ts`).
   2. Run `cleanContent()` (already in Huginn — Phase 3 logic shared).
   3. Run mirrored Muninn `chunkDocument()` over cleaned text.
   4. Compute Tier 1 metrics per chunk.
   5. Subject to budget, embed chunks (with cache), compute Tier 2 metrics.
   6. Aggregate to per-doc summary (`mean`, `p10`, bucket counts, weakest links).
2. Aggregate per-doc summaries into corpus summary.
3. Append to `state.chunkQuality`.

### 3.1 File layout

```
src/
├── phases/
│   ├── 3-projection.ts          [SLIMMED — see §6]
│   ├── 4-chunk-quality.ts       [NEW — orchestrator]
│   ├── 5-fingerprint.ts         [renamed]
│   └── ...
└── utils/
    ├── muninn-mirror/
    │   ├── chunker.ts            # copy of muninn/.../chunker.ts + sync header
    │   ├── cleaner.ts            # copy — classifyBlock used by chunker
    │   ├── config.ts             # CHUNK_SIZE=512, CHUNK_OVERLAP=64
    │   ├── mime-map.ts           # extension → MIME (Huginn has no MIME field yet)
    │   ├── types.ts              # RawChunk, ChunkType
    │   └── DRIFT.md              # SHA-256 of each mirrored file + sync instructions
    └── chunk-quality/
        ├── tier1-rules.ts
        ├── tier2-embeddings.ts
        ├── sentence-splitter.ts  # compromise wrapper (de + en)
        ├── embedding-cache.ts
        ├── budget.ts             # CHUNK_QUALITY_BUDGET → caps
        └── tests.ts              # runChunkQualityTests() — startup gate
```

### 3.2 Phase placement rationale

After Phase 3 because Phase 3 produces the cleaned text + token-waterfall that the chunker should consume. Before Phase 5 (fingerprint) because chunk-quality may pre-warm Ollama and the embedding cache could in theory be reused for fingerprint section embeddings (out of scope for v1, but the ordering keeps the door open).

## 4. Mirroring Muninn's chunker

Copied verbatim from `~/mci/muninn/packages/rag/src/ingestion/chunker.ts` into `src/utils/muninn-mirror/chunker.ts`. Same algorithm, same constants (`CHUNK_SIZE = 512`, `CHUNK_OVERLAP = 64` — char-based, as Muninn does today, even though Tier 1 advice favors token-based; this is honest to reality, and the gap surfaces as a Tier 1 finding).

**Sync mechanism (DRIFT.md):**
- File records SHA-256 of each mirrored file and the Muninn commit hash that produced it.
- Startup test verifies the local file's SHA matches `DRIFT.md`. If diverged → log warning (not fatal; intentional sync requires updating DRIFT.md).
- Drift verification only — not auto-sync. Manual sync is on the developer when Muninn changes.

**MIME map (`mime-map.ts`):** Huginn currently keys on file extension; Muninn keys on MIME. Map extension → MIME so the same chunker switch works:

```typescript
const EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
};
```

Unknown extensions default to `text/plain` → `sliding_window`. Logged.

## 5. Metrics specification

Each per-chunk metric returns `{ score: number | null; reason?: string }` where `score ∈ [0, 1]` (1 = good). `null` means "not measurable" and is excluded from aggregates.

### 5.1 Tier 1 — Rule-based

| Metric | Per-chunk score |
|---|---|
| **sizeFit** | `1.0` if 200–550 tokens; linear falloff to `0.2` at <50 or >900 tokens. Token count via Huginn's `estimateTokens` (consistent with rest of scanner). |
| **sentenceBoundaryQuality** | Use `compromise` to detect first/last sentence completeness. `1.0` clean both ends; `0.5` one end broken; `0.0` both broken. `null` for `table_row` chunks. |
| **crossReferenceCut** | Detect anaphoric/reference token in first 80 chars: `siehe`, `vgl.`, `wie oben`, `s\.o\.`, `s\.u\.`, `dort`, `dieser/diese/dieses`. AND no antecedent in same chunk (no noun phrase or matched heading earlier in chunk). `0.0` if cut detected; `1.0` if no reference OR reference + antecedent. |
| **tableCut** | Table-row chunk that splits mid-row. Measurable only for XLSX (row boundaries known) and DOCX with `<w:tbl>` boundaries available. For PDF: `null` (not measurable). `1.0` clean, `0.0` cut. |
| **headerPollution** | Heading-only or heading-dominated chunks. Compute heading content share via `classifyBlock` per line. `1.0` if heading content ≤20%; linear falloff to `0.0` at ≥60%. |
| **contentScore** | Re-homed `scoreBlock` formula: `0.4 * density + 0.3 * coherence + 0.3 * specificity`. Domain quality signal. |

### 5.2 Tier 2 — Embedding-based

All vectors L2-normalized. Normalization asserted explicitly per chunk: `|‖v‖ - 1| < 0.001` → if exceeded, auto-normalize and log warning (`bgeM3NormalizationCheck` field aggregates these).

| Metric | Per-chunk score |
|---|---|
| **coherenceDrop** | For chunks `i, i+1` in **same doc**, drop = `1 - cos(emb_i, emb_{i+1})`. Per-doc score = `1 - mean(drop)` clipped to `[0, 1]`. Cross-doc pairs never computed (per Tier 2 advice). |
| **intraChunkCohesion** | Split chunk text at token midpoint, embed each half, score = `cos(half_a, half_b)`. **Skip if chunk <100 tokens** → `null`, excluded from aggregate. |
| **centroidDistance** | Per-doc centroid `c_d = mean(chunk_embeddings_in_doc)`. Per-chunk: `cos(emb_chunk, c_d)`. **Normalize per-doc** via z-score against that doc's own distribution; map to `[0, 1]` via `1 - clamp(\|z\|/3, 0, 1)`. |

### 5.3 Embedding cache

Keyed by `sha256(chunk.content)`. Cross-doc identical chunks share entries. `intraChunkCohesion` halves keyed by `sha256(half_text)`. Memory upper bound at `normal` mode: 20 000 chunks × 1024 floats × 4 bytes ≈ 82 MB. Released after Phase 4 completes.

### 5.4 Budget modes

Env var `CHUNK_QUALITY_BUDGET` (default `normal`):

| Mode | Max chunks/doc | Max corpus chunks | Behavior beyond cap |
|---|---|---|---|
| `fast` | 30 | 2 000 | Even-sample |
| `normal` | 200 | 20 000 | Even-sample |
| `full` | ∞ | ∞ | No caps; warning if corpus > 50 docs |

**Cap application order:**
1. Per-doc cap applied first (within each doc, even-sample chunks beyond `Max chunks/doc`).
2. If the sum across docs still exceeds `Max corpus chunks`, apply a second-pass even-sample at doc level (chunks are dropped from each doc proportionally so the total cap holds).
3. Chunks not embedded still get Tier 1 metrics; only Tier 2 metrics are skipped for them.
4. `chunkCountEmbedded` per doc reflects the count after both passes; `budgetCapHit` is `true` if either cap fired.

Escape hatch: `CHUNK_QUALITY_DISABLE=1` skips the phase entirely (empty `chunkQuality` field).

### 5.5 Composite index

Computed **per chunk** first, then aggregated to per-doc and corpus levels.

Per chunk:

```
chunkQualityIndex_chunk = 0.5 * mean(tier1_metrics_not_null for that chunk)
                       + 0.5 * mean(tier2_metrics_not_null for that chunk)
```

If Tier 2 metrics are all null for a chunk (chunk not embedded due to budget, or embedder unreachable), the chunk's index falls back to Tier 1 mean alone (no zero-padding). The doc-level `tier2: null` flag is set when this happens for *all* chunks in the doc.

Per doc: `mean` and `p10` of per-chunk indices. p10 = 10th percentile, the worst-10% sentinel — surfaces "is there a long tail of bad chunks?".

Per corpus: token-weighted mean of per-doc means (long docs weighted more, matching their effect on Muninn's retrieval).

Buckets (applied to per-chunk index): `good ≥ 0.7`, `acceptable 0.4–0.7`, `poor < 0.4`. Per-doc `bucketCounts` and corpus `bucketShare` derived from chunk-level bucket assignments.

## 6. State changes

### 6.1 New types (`src/state.ts`)

```typescript
export type ChunkQualityBudget = "fast" | "normal" | "full";

export interface ChunkQualityMetricValue {
  score: number | null;
  reason?: string;  // ≤120 chars; only when null or score < 0.4
}

export interface ChunkQualityPerDoc {
  docId: string;
  chunkCountTotal: number;
  chunkCountEmbedded: number;
  budgetMode: ChunkQualityBudget;
  budgetCapHit: boolean;
  tier1: {
    sizeFit:                  { mean: number; p10: number };
    sentenceBoundaryQuality:  { mean: number; p10: number };
    crossReferenceCut:        { mean: number; p10: number };
    tableCut:                 { mean: number | null; p10: number | null };
    headerPollution:          { mean: number; p10: number };
    contentScore:             { mean: number; p10: number };
  };
  tier2: {
    coherenceDrop:            { mean: number; p10: number } | null;
    intraChunkCohesion:       { mean: number; p10: number; nMeasurable: number } | null;  // null if no chunks ≥100 tokens
    centroidDistance:         { mean: number; p10: number };
  } | null;
  chunkQualityIndex:          { mean: number; p10: number };  // aggregated across the doc's chunks
  bucketCounts:               { good: number; acceptable: number; poor: number };
  weakestLinks:               string[];  // top 3, ≤120 chars each
}

export interface ChunkQualityCorpusSummary {
  budgetMode:               ChunkQualityBudget;
  totalChunks:              number;
  totalChunksEmbedded:      number;
  tokenWeightedIndexMean:   number;
  bucketShare:              { good: number; acceptable: number; poor: number };
  worstDocsByP10:           Array<{ docId: string; p10: number; primaryWeakness: string }>;
  weakestCorpusMetrics:     Array<{ metric: string; mean: number }>;
  embeddingsCacheStats:     { uniqueChunks: number; cacheHits: number; cacheMisses: number };
  bgeM3NormalizationCheck:  { sampleSize: number; allNormalized: boolean; maxDeviation: number };
}

export interface ChunkQualityReport {
  perDoc:      ChunkQualityPerDoc[];
  corpus:      ChunkQualityCorpusSummary;
  generatedAt: Date;
}
```

Added to `ScannerState`:

```typescript
chunkQuality: ChunkQualityReport;
```

`createInitialState()` initialises empty shell (budget `normal`, zero totals).

### 6.2 Phase 3 slim-down

- Remove `predictedQualityDistribution` from `DocumentIngestionProjection` type.
- Remove `sampleQualityDistribution()` from `3-projection.ts`.
- Remove `scoreBlock` import from `3-projection.ts`.
- `scoreBlock` stays in `src/utils/quality-scorer.ts` — imported by `4-chunk-quality.ts` for `contentScore`.
- Update `validate.ts` (now `9-validate.ts`): any check reading `predictedQualityDistribution` reads `chunkQuality.corpus.bucketShare` instead.
- Update `9-narrative.ts` (now `10-narrative.ts`) similarly.
- Update dashboard `requirements-landscape.ts` and any caller of the dropped field.

### 6.3 New consistency checks (in renumbered `9-validate.ts`)

| Check | Trigger |
|---|---|
| `chunkQualityIndex` | `tokenWeightedIndexMean < 0.5` → WARNING; `< 0.35` → CRITICAL |
| `chunkBoundaryHealth` | `sentenceBoundaryQuality.mean < 0.6` corpus-wide → INFO (suggests chunker upgrade) |
| `chunkCoherenceHealth` | `coherenceDrop.mean < 0.55` → WARNING (chunker may be cutting mid-thought) |

## 7. Report integration

### 7.1 JSON

Full `chunkQuality` object serialized via existing `sanitizeReport()`. Adds ~2–5 KB per doc.

### 7.2 Human Markdown (`scan-report-*-human.md`)

New section "## Chunk Quality" between "Ingestion Projection" and "Validation". Contents:

- 1-line headline: `Token-weighted chunk quality: 0.67 (good 51%, acceptable 32%, poor 17%)`
- Worst 5 docs by p10 (table): `docId | p10 | primaryWeakness`
- Weakest corpus metrics (table, top 3): `metric | mean`
- Budget-cap note if hit: `Note: budget=fast — 30/420 chunks/doc embedded`

### 7.3 Narrative Markdown

New section `chunkQualityNarrative` in renumbered `10-narrative.ts`. LLM prompt receives **only** corpus summary numbers + the 3 worst metric names — never chunk content. Reuses `complete()` from `src/llm/ollama.ts`. Fallback to deterministic templated paragraph on LLM failure (existing pattern).

### 7.4 Dashboard

New section between "Requirements Landscape" and "References & Graph Resolution":

- File: `src/dashboard/components/chunk-quality.ts`
- Visualisations:
  - KPI card: token-weighted chunk quality index
  - Stacked bar: bucket distribution (good/acceptable/poor)
  - Horizontal bar: weakest metrics across corpus
  - Sortable table: per-doc index + p10 + primary weakness
- Reuses `chart-config.ts` and `color-scale.ts`. No new dependencies.

## 8. Error handling & degraded modes

| Failure | Behavior |
|---|---|
| Ollama unreachable mid-run | Tier 2 disabled for remaining docs; `tier2: null`; warning logged; index falls back to Tier-1-only mean |
| BGE-M3 vector not L2-normalized | Auto-normalize; log warning; `bgeM3NormalizationCheck` records max deviation |
| `compromise` throws on input | Try/catch; chunk gets `sentenceBoundaryQuality: { score: null, reason: "splitter_failure" }` |
| Doc has <2 chunks | `coherenceDrop: null`; doc still gets index from other metrics |
| Budget cap hit | Even-sample beyond cap; `budgetCapHit: true`; narrative mentions it |
| Empty / parse-failed doc | Skip; doc not included in `chunkQuality.perDoc` |
| Drift hash mismatch on muninn-mirror | Log warning (not fatal) |

## 9. Testing strategy

Project has no unit-test framework. Per convention, add deterministic startup gate `runChunkQualityTests()` invoked from `src/index.ts` before Phase 1. Aborts on failure (same pattern as `runRegexTests()`).

Test cases (~12):

- Well-formed chunk → index ≥ 0.7
- Boilerplate-heavy chunk → index ≤ 0.3
- Cross-reference cut: `"siehe Abschnitt 4.2"` no antecedent → 0.0
- Cross-reference satisfied: `"Abschnitt 4.2 beschreibt X. Siehe oben."` → 1.0
- Sentence boundary: `"...end of thought."` → 1.0
- Sentence boundary: `"Bezugnehmend auf die"` truncated → 0.5
- Header pollution on heading-only block → score ≤ 0.2
- Token size: 300-token chunk → sizeFit = 1.0
- Token size: 50-token chunk → sizeFit ≤ 0.4
- Intra-chunk cohesion skipped for 80-token chunk → null
- Budget resolver: `BUDGET=fast` with 100 chunks → samples 30
- Drift hash: SHA-256 of `muninn-mirror/chunker.ts` matches `DRIFT.md`

Tier 2 micro-tests mock the embedder with deterministic vectors. Full Ollama integration validated by running the scanner on `_test-docs/` with expected log assertions: `coherenceDrop.mean ∈ [0.4, 0.9]`, `totalChunks > 0`.

## 10. Configuration & documentation

- `CHUNK_QUALITY_BUDGET=normal` env var (default)
- `CHUNK_QUALITY_DISABLE=1` skip phase
- Update `CLAUDE.md`:
  - Pipeline now 10 phases (was 9 conceptual phases mapped to numeric files)
  - New "Chunk Quality" subsection mirroring the "Dashboard" subsection style
  - Add muninn-mirror dir to the "Architecture" file map
- Update `MEMORY.md` references that mention phase numbering

## 11. Implementation order

For the writing-plans phase, the work decomposes naturally into independent steps:

1. Mirror Muninn `chunker.ts` / `cleaner.ts` / `config.ts` + `mime-map.ts` + DRIFT.md
2. `sentence-splitter.ts` wrapping `compromise` + part of test gate
3. State types added; `4-chunk-quality.ts` skeleton (no metrics yet, returns empty)
4. Tier 1 metric per file: sizeFit → sentenceBoundaryQuality → crossReferenceCut → tableCut → headerPollution → contentScore (re-homed)
5. `embedding-cache.ts` + `budget.ts`
6. Tier 2 metrics: coherenceDrop → intraChunkCohesion → centroidDistance
7. Composite index + per-doc aggregation + corpus summary
8. Phase 3 slim-down (delete dropped fields, update consumers)
9. Phase renumbering — concrete file moves:
   - `4-fingerprint.ts` → `5-fingerprint.ts`
   - `5-cluster.ts` → `6-cluster.ts`
   - `6-references.ts` → `7-references.ts`
   - `7-requirements.ts` → `8-requirements.ts`
   - `8-validate.ts` → `9-validate.ts`
   - `9-html.ts` → `10-html.ts`
   - `9-narrative.ts` → `10-narrative.ts`
   - `9-report.ts` → `10-report.ts`
   - Update `pipeline.ts` orchestrator, all `setPhase()` string args, and all imports
10. Report integration: JSON sanitiser smoke-test; human MD section; narrative section; dashboard component
11. Documentation: CLAUDE.md, narrative prompt addition, regenerate sample reports

## 12. Out of scope (v1)

- Replacing Muninn's chunker with the smarter algorithm (Huginn measures; Muninn keeps shipping its current chunker until findings justify changes).
- Re-using chunk embeddings in Phase 5 fingerprint (possible later; phase ordering keeps the option open).
- Per-strategy quality breakdown (semantic vs sliding_window vs table_rows). Useful but adds complexity; can ship as a follow-up if findings are interesting.
- Auto-syncing the muninn-mirror dir. Manual sync only.

## 13. Open questions / risks

- **`compromise` library size** (~150 KB). Acceptable for a CLI scanner. `sbd` is leaner (~10 KB) but English-only; not viable for German automotive corpus.
- **Char-based vs token-based CHUNK_SIZE.** Muninn uses chars. Honest reflection of reality, but Tier 1 sizeFit measures in tokens — the score will reflect that mismatch as a finding, which is the desired outcome.
- **Phase renumbering** touches many imports and the dashboard component names. The renumbering work is mechanical but spans the codebase. Step 9 in §11 may take longer than other steps.
- **DRIFT.md verification** is a soft warning, not a hard gate. If chunker drift happens silently, projections degrade silently. Mitigation: weekly manual check; consider promoting to hard gate after stability proven.
