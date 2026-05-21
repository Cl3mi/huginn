# Huginn Phase 9 — Ingestion Projection Design

**Date:** 2026-05-20
**Status:** Approved
**Scope:** Richer Muninn pre-configuration via token waterfall simulation, boilerplate discovery, domain signal detection, and HTML report improvements.

---

## 1. Problem Statement

Huginn is sent to a client as a standalone scanner. The client runs it on their document base and transmits the JSON report back to the developer. The developer uses that report to configure Muninn before shipping it. Currently, the report gives structural metadata (version pairs, requirement density, chunk strategy recommendations) but not the data needed to tune Muninn's ingestion parameters:

- **CHUNK_SIZE / CHUNK_OVERLAP** — set blind, discovered wrong only after ingestion
- **QUALITY_THRESHOLD** — good chunks get dropped or noise slips through without visibility
- **BOILERPLATE_PATTERNS** — client-specific headers/footers pollute chunks; the cleaner's patterns are hardcoded for German automotive

The fix: add a Phase 9 that simulates Muninn's ingestion pipeline against each document and surfaces the results as concrete, parameter-level recommendations in the JSON report and the developer-side HTML dashboard.

---

## 2. Architecture

### 2.1 Pipeline position

Phase 9a (per-document simulation) runs **inline at the end of Phase 2 (Parse)**, immediately after text extraction and before the text is discarded. This avoids any cross-phase text buffer — the projection stats are computed while the text is still in the Phase 2 loop, and only the numeric results are stored in state.

Phases 9b (boilerplate discovery) and 9c (config recommendations) run as a distinct Phase 9 step after Phase 2 completes, operating on `state.ingestionProjections` and the line-frequency data accumulated during 9a.

Phases 3–8 are unaffected. Phase 9 writes only to four new top-level state fields; it reads nothing from Phase 3+.

### 2.2 Sub-steps

```
Phase 9: Ingestion Projection
├── 9a  Per-document simulation
│   ├── Run ported cleaner (normalization + boilerplate strip + repeat-line detection)
│   ├── Classify text blocks (prose / header / spec_value / table_row / boilerplate)
│   ├── Simulate chunk count from section lengths and chunk strategy
│   ├── Predict filter losses (letter ratio / punctuation / length rules)
│   └── Sample quality scores across ≤30 evenly-spaced text blocks per document
├── 9b  Corpus-wide boilerplate discovery
│   ├── Cross-document line frequency analysis
│   ├── Candidate pattern normalisation and deduplication
│   └── Diff against existing BOILERPLATE_PATTERNS
└── 9c  Config recommendation generation
    ├── CHUNK_SIZE from median section token length
    ├── CHUNK_OVERLAP from average sentence token length
    ├── QUALITY_THRESHOLD from predicted quality distribution
    ├── BOILERPLATE_PATTERNS additions from 9b
    ├── Per-doctype chunk strategy confirmation / override
    └── VERSION_AUTO_THRESHOLD and VERSION_HITL_THRESHOLD from score histogram shape
```

### 2.3 Ported utilities (new files in `src/utils/`)

Four pure functions are ported from Muninn. They carry no Muninn dependencies and stay in sync manually — the functions are stable and infrequently changed.

| New file | Ported from | What it does |
|---|---|---|
| `src/utils/cleaner.ts` | `muninn/packages/rag/src/ingestion/cleaner.ts` | NFKC normalisation, boilerplate pattern matching, repeat-line detection. Exports `CleaningAudit`. |
| `src/utils/token-estimator.ts` | `muninn/packages/rag/src/ingestion/token-estimator.ts` | 4.5 chars/token formula with compression factors per chunk type (boilerplate 0.7×, header 0.8×). |
| `src/utils/quality-scorer.ts` | `muninn/packages/rag/src/ingestion/quality-scorer.ts` | density + coherence + specificity scoring. Adapted for domain-agnostic fallback (see §5). |
| `src/utils/chunk-filter.ts` | inline in `muninn/.../pipeline.ts` | The three-rule filter predicate: length ≥ 20, letter ratio ≥ 25%, punctuation ratio ≤ 40%. |

---

## 3. Per-document Simulation (9a)

For every document where `parseSuccess === true`, Phase 9a computes a `DocumentIngestionProjection`.

### 3.1 Token waterfall

Five stages, each measured in estimated tokens:

```
raw
  → afterNormalization      unicode cleanup, hyphenation repair, control char removal
  → afterCleaning           boilerplate patterns + repeated header/footer lines removed
  → afterChunking           compression factors applied per block type
  → afterFilter             blocks failing letter-ratio / punctuation / length rules dropped
  → embeddable              final count
```

### 3.2 State type

```typescript
interface DocumentIngestionProjection {
  docId: string
  tokenWaterfall: {
    raw: number
    afterNormalization: number
    afterCleaning: number
    afterChunking: number
    afterFilter: number
    embeddable: number
  }
  cleaningLoss: {
    normalization: number       // control chars, broken hyphens
    boilerplate: number         // matched BOILERPLATE_PATTERNS
    repeatedLines: number       // headers/footers repeating 3+ times within doc
  }
  filterLoss: {
    byLength: number            // tokens in blocks dropped for length < 20 chars
    byLetterRatio: number       // tokens dropped for < 25% letter characters
    byPunctuation: number       // tokens dropped for > 40% punctuation
  }
  predictedChunkCount: number
  predictedFilteredChunkCount: number
  blockTypeDistribution: {      // shares sum to 1.0
    prose: number
    header: number
    specValue: number
    tableRow: number
    boilerplate: number
  }
  predictedQualityDistribution: {
    high: number                // share of tokens in blocks scoring ≥ 0.7
    medium: number              // 0.4 – 0.7
    low: number                 // < 0.4
  }
  tokenRetentionRate: number    // embeddable / raw, 0–1
}
```

### 3.3 Chunk count simulation

No full chunker port is needed — arithmetic approximations per strategy:

- **`heading_sections`**: heading count × average section token size ÷ `CHUNK_SIZE`, with short-section merging (sections < 0.4 × CHUNK_SIZE merged with neighbours).
- **`sliding_window`**: `Math.ceil(cleanedTokens / (CHUNK_SIZE_TOKENS − CHUNK_OVERLAP_TOKENS))`
- **`table_rows`**: `tableCount × estimatedRowsPerTable` (estimated from character density)

### 3.4 Quality sampling

The full document is not scored block by block. Up to 30 text blocks per document are sampled (evenly spaced), classified with `classifyBlock()`, and scored with `scoreChunk()`. The distribution is interpolated from the sample. This keeps Phase 9 fast on large corpora (1000+ docs).

---

## 4. Corpus-wide Boilerplate Discovery (9b)

### 4.1 Frequency analysis

Phase 9b collects every line from every cleaned document and builds two maps:

1. **Cross-document frequency** — lines appearing in 3+ distinct documents. Almost certainly client-specific stamps (company name, project code, confidentiality notice) not covered by the current `BOILERPLATE_PATTERNS`.
2. **Within-document frequency** — lines repeating 5+ times inside a single document. Running headers/footers that Muninn's repeat-detector would catch, but surfacing them as explicit patterns avoids the runtime cost in future ingestions.

Lines are normalised before comparison: lowercased, internal whitespace collapsed, leading digits and dates stripped. This groups `"Seite 3 von 12"` and `"Seite 7 von 12"` into one candidate.

### 4.2 State type

```typescript
interface DiscoveredBoilerplatePattern {
  normalizedForm: string          // max 60 chars
  occurrenceCount: number         // total line occurrences across corpus
  documentCount: number           // distinct documents containing it
  suggestedRegex: string          // auto-generated, ready to paste into cleaner.ts
  alreadyCovered: boolean         // true if existing BOILERPLATE_PATTERNS already matches
  tokensAtRisk: number            // tokens removed corpus-wide if pattern is added
}
```

### 4.3 Regex generation

The auto-generated regex is conservative:
- Literal text is escaped and wrapped in `^...$`
- Date and number segments are replaced with `\d+` wildcards
- Sample match count shown alongside so the developer can validate before adding

### 4.4 Privacy guard

Before any pattern enters the report, a filter checks: if `normalizedForm` contains more than 4 consecutive word characters absent from a common-words allowlist, it is suppressed and counted in `suppressedPatterns`. This prevents client project names or internal codes leaking into the transmitted JSON.

### 4.5 Corpus summary

```typescript
interface CorpusBoilerplateSummary {
  totalCandidatePatterns: number
  newPatterns: number             // not yet in Muninn's cleaner
  suppressedPatterns: number      // privacy-filtered
  totalTokensRecoverable: number  // tokens currently lost to undetected boilerplate
}
```

---

## 5. Domain Signal Detection

Three auto-detection passes run before quality scoring in Phase 9a. They replace hardcoded automotive signals with corpus-derived ones.

### 5.1 Requirement language

Scans sampled prose blocks for modal structures:

| Family | Patterns |
|---|---|
| `german_modal` | `muss`, `soll`, `kann`, `darf nicht` |
| `rfc2119` | `MUST`, `SHALL`, `SHOULD`, `MAY`, `REQUIRED` |
| `french_modal` | `doit`, `devrait`, `peut` |
| `legal` | `shall not`, `is obligated to`, `warrants that` |

The dominant family becomes the active requirement language profile. The quality scorer's `coherenceScore` req bonus fires on the matching family. If no modal language is detected, the bonus is omitted.

### 5.2 Reference format detection

Broad regexes detect ID/code structure families and cluster matches:

```
Letter-prefix + digits    →  FIKB-123456, ISO-9001, VDA-6.3
All-caps acronym + num    →  FDA-21-CFR, GDPR-Art.5
Dotted decimal            →  EN 13849-1:2015
§ + number                →  §17 UStG, Art. 6 DSGVO
```

Top 5 detected formats are reported as `discoveredReferenceFormats[]`. These tell the developer which additional reference extractors Muninn needs for the client (Phase 5 currently only extracts ISO/DIN/FIKB/KB_Master).

### 5.3 Unit and measurement detection

Numeric-unit pairs are scanned and clustered by domain family:

| Family | Representative units |
|---|---|
| `mechanical` | mm, kg, MPa, rpm, °C |
| `electrical` | V, A, W, kWh, Ω |
| `pharma` | mg, mL, μg, ppm, mol/L |
| `financial` | €, $, %, bps |
| `logistics` | pcs, TEU, kg/m³ |

The detected unit family feeds directly into `specificityScore` — instead of hardcoded automotive units, scoring uses whatever family dominates the corpus.

### 5.4 Domain profile type

```typescript
interface DomainProfile {
  detectedLanguage: "de" | "en" | "fr" | "mixed"
  requirementLanguageFamily: "german_modal" | "rfc2119" | "legal" | "french_modal" | "none"
  requirementLanguageCoverage: number            // share of docs where modal language was found
  discoveredReferenceFormats: Array<{
    pattern: string                              // safe regex form, not example text
    occurrenceCount: number
    documentCount: number
    alreadyExtracted: boolean
  }>
  dominantUnitFamily: "mechanical" | "electrical" | "pharma" | "financial" | "logistics" | "mixed" | "none"
  unitFamilyCoverage: number
  qualityScorerProfile: "automotive_de" | "generic_de" | "generic_en" | "adapted"
}
```

`qualityScorerProfile: "adapted"` means domain detection overrode the hardcoded scorer signals. The narrative section explains what changed.

---

## 6. Config Recommendation Engine (9c)

Translates all projection data into a concrete, copy-pasteable list of Muninn parameter recommendations.

### 6.1 State type

```typescript
interface MuninnConfigRecommendation {
  parameter: string
  currentDefault: string | number
  recommendedValue: string | number
  confidence: "HIGH" | "MEDIUM" | "LOW"
  reasoning: string               // one sentence, stats-based, no document text
  evidenceDocCount: number
  affectedTokenShare: number      // 0–1, share of corpus tokens this affects
}
```

Confidence levels: HIGH = ≥10 docs, consistent signal. MEDIUM = 3–9 docs or moderate variance. LOW = <3 docs or conflicting signals across doc types.

### 6.2 Generated recommendations

| Parameter | Derivation |
|---|---|
| `CHUNK_SIZE` | Median section token length across heading-section docs. Recommend value = median + 15% headroom. Flag if >40% of sections would be split at current default. |
| `CHUNK_OVERLAP` | Average sentence token length × 1.5 across sampled prose blocks. |
| `CHUNK_OVERLAP` (sliding_window) | Derived separately from PPTX/plaintext files. |
| `QUALITY_THRESHOLD` | If >25% of content-bearing tokens score below 0.4 → recommend 0.3. If <5% score below 0.4 → recommend 0.5. |
| `BOILERPLATE_PATTERNS` additions | High-confidence new patterns from 9b (documentCount ≥ 5, not already covered). |
| `VERSION_AUTO_THRESHOLD` | Bimodal gap in score histogram (many 10-12, few 5-9) → recommend 0.97. Clustered middle → keep default, rely on HITL. |
| `VERSION_HITL_THRESHOLD` | Lower boundary from same histogram analysis. |

---

## 7. State Changes

### 7.1 New top-level fields on `ScannerState`

```typescript
ingestionProjections: DocumentIngestionProjection[]
corpusIngestionSummary: CorpusIngestionSummary
discoveredBoilerplatePatterns: DiscoveredBoilerplatePattern[]
muninnConfigRecommendations: MuninnConfigRecommendation[]
domainProfile: DomainProfile
```

### 7.2 `CorpusIngestionSummary`

```typescript
interface CorpusIngestionSummary {
  totalTokensRaw: number
  totalTokensEmbeddable: number
  overallRetentionRate: number
  lossWaterfall: Array<{
    stage: string
    tokensLost: number
    percentOfRaw: number
  }>
  byDocType: Record<string, {
    docCount: number
    retentionRate: number
    avgQualityHigh: number           // share of tokens scoring ≥ 0.7
    dominantChunkStrategy: string
    avgPredictedChunkCount: number
  }>
  highRiskDocs: Array<{             // docs where retentionRate < 0.5
    docId: string
    retentionRate: number
    primaryLossCause: "ocr" | "boilerplate" | "filter" | "normalization"
  }>
}
```

### 7.3 JSON report keys

Five new top-level keys added to the serialised report:

| Key | Content |
|---|---|
| `tokenProjection` | `ingestionProjections[]` — per-document waterfall |
| `corpusTokenSummary` | `CorpusIngestionSummary` |
| `boilerplateDiscovery` | `discoveredBoilerplatePatterns[]` + `CorpusBoilerplateSummary` |
| `muninnConfig` | `muninnConfigRecommendations[]` |
| `domainProfile` | `DomainProfile` |

Existing `maxStringLengthInReport: 120` guard applies to all string fields. `normalizedForm` in boilerplate patterns has its own 60-char cap. `suggestedRegex` is exempt (must be complete to be useful) but contains no document text.

---

## 8. HTML Report Improvements

The HTML generator (`src/phases/8-html.ts`) is a **new file** — the existing HTML report was manually crafted. This file needs to be created. It produces a single self-contained HTML file with all data embedded as `window.__huginnData = {...}`. It is triggered manually on the developer's machine: `bun src/phases/8-html.ts <path-to-scan-report.json>`. Three new sections are added to the HTML; two existing sections gain new columns.

### 8.1 New section: Muninn Config Recommendations

Inserted between KPI cards and Data Quality Assessment for maximum visibility.

- Card grid, one card per recommendation
- Each card: parameter name, current default → recommended value, confidence badge (HIGH green / MEDIUM amber / LOW grey), one-sentence reasoning, copy button
- Bottom of section: "Copy .env diff" button copies the full diff block to clipboard

### 8.2 New section: Ingestion Intelligence

Inserted after Document Distribution. Four panels in a 2×2 grid:

- **Token Waterfall** — horizontal stacked bar, corpus totals per stage, colour-coded by loss cause (normalization grey, boilerplate amber, filter red, OCR orange). Hover shows exact counts and % of raw.
- **Retention by Doc Type** — bar chart, bars below 60% amber, below 40% red. Click bar to filter document table.
- **Block Type Distribution** — stacked bar per doc type (prose / header / spec_value / table_row / boilerplate share).
- **Quality Score Distribution** — histogram with draggable `QUALITY_THRESHOLD` marker. Dragging updates live readout: "X% of tokens above threshold".

Below the grid: high-risk documents table (retention < 50%), showing filename, retention %, primary loss cause. Clickable to open existing document detail modal.

### 8.3 New section: Boilerplate Discovery

Inserted before Consistency Checks.

- Table sorted by `tokensAtRisk` descending
- Columns: normalised form (60-char max), documents, occurrences, tokens at risk, already covered badge, suggested regex + copy button
- "Copy all new patterns" button at top copies array for paste into `cleaner.ts`

### 8.4 Changes to existing sections

- **Document Distribution table** — two new columns: `retention %` (colour-coded) and `dominant loss cause`
- **Parse Health & OCR** — OCR warnings cross-referenced with token loss: "X scanned PDFs → estimated Y tokens unrecoverable without OCR pre-processing"
- **Data Quality gauge** — subtitle shows predicted embeddable token count alongside metadata quality score

---

## 9. Privacy Compliance

- No document text enters the report at any stage. Phase 9 computes only statistics.
- Boilerplate `normalizedForm` is capped at 60 chars and passes through the common-words privacy filter before serialisation.
- `suggestedRegex` contains only structure (character classes, anchors) — no literal corpus text beyond short common words.
- Suppressed pattern count is reported so the developer knows patterns were withheld, without revealing them.
- Existing `maxStringLengthInReport: 120` guard covers all other string fields.

---

## 10. Out of Scope

- Full chunker port (chunk count simulation uses arithmetic approximation)
- Automatic application of recommendations to Muninn (human-mediated workflow)
- Shared package between Huginn and Muninn (`@muninn/projection`) — ported utilities are maintained as independent copies
- Markdown report changes (JSON and HTML are the primary deliverables)
