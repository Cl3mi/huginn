# Debug Data Enhancement — Design Spec

**Date:** 2026-05-24  
**Status:** Approved  
**Scope:** Huginn scanner — debug output layer

---

## Problem

The scan report captures aggregated outputs but discards the intermediate signals that drove each decision. When a document is misclassified, a regex pattern silently matches nothing, or the LLM validation diverges unexpectedly, there is no audit trail to trace the failure back to its cause.

## Goal

Produce a separate `scan-report-<ts>-debug.json` alongside the main report. The file contains four typed debug categories. Each category is independently toggleable via a `debug-settings.json` file that the UI can read and write. No debug data is mixed into the main report JSON.

---

## Approach: Typed per-category debug blocks on ScannerState (Approach B)

Four optional fields are added to `ScannerState`. A field being defined (`!== undefined`) is the guard — phases write to it only when it exists. `createInitialState()` initialises a field only if its category is enabled in `DebugSettings`.

---

## Debug Settings

### File location
`$REPORT_OUTPUT/debug-settings.json`

Read once at scanner startup. If absent, all categories default to `false`. The server rewrites this file on PATCH.

### Schema
```ts
interface DebugSettings {
  enabled: boolean;           // master switch — false disables all categories
  decisionAudit: boolean;     // privacy: medium — heading fragments used as signal labels
  patternCoverage: boolean;   // privacy: low — pattern names, match counts, doc IDs only
  llmTrace: boolean;          // privacy: low — counts and doc IDs only, no content
  zeroOutputDocs: boolean;    // privacy: low — doc IDs, counts, and inferred cause only
}
```

### Default (file absent or `enabled: false`)
All categories disabled. No debug file written.

---

## State Additions

In `src/state.ts`:

```ts
// Optional debug blocks — undefined = category disabled
decisionAudit?: Map<string, DecisionRecord>;   // keyed by docId; filled by phases 2, 4, 5, 6
patternCoverage?: PatternCoverageEntry[];       // filled by phases 5, 6
llmTrace?: LlmSampleRecord[];                  // filled by phase 6
zeroOutputDocs?: ZeroOutputEntry[];            // filled by phase 9 (post-hoc over state)
```

`createInitialState()` receives a `DebugSettings | null` parameter (defaults to `null`). It initialises `Map`/array fields only for enabled categories.

---

## Category Data Shapes

### `DecisionRecord`
One entry per document. Filled by Phase 2 (docType, OEM, chunk strategy), Phase 4 (fingerprint signals), Phase 5/6 (version pair signals for pairs near threshold ≥ 5).

```ts
interface DecisionRecord {
  docId: string;
  // Phase 2: document type classification
  docTypeSignals: Record<string, number | boolean>;
  // Keys are signal names (e.g. "safetyTermCount", "rpnPattern", "fmeaHeadingFound")
  // Values are counts or boolean flags — no text content
  docTypeChosen: string;
  // Phase 2: OEM detection
  oemDetected?: string;
  oemSource?: "folder" | "document_internal" | "reconciled";
  // Phase 2: chunk strategy
  chunkStrategySignals: Record<string, number | boolean>;
  chunkStrategyChosen: string;
  chunkStrategyConfidence: number;
  // Phase 5: version pair signals (only for pairs with score >= 5)
  versionPairContributions?: Array<{
    partnerDocId: string;
    score: number;
    signals: Record<string, number | boolean>;
  }>;
}
```

**Privacy note:** `docTypeSignals` and `chunkStrategySignals` keys are signal names defined in source code (e.g. `"fmeaHeadingFound"`), not heading text. Where a heading path is used as context it is capped at 40 chars.

### `PatternCoverageEntry`
One entry per named regex pattern across phases 5 (references) and 6 (requirements).

```ts
interface PatternCoverageEntry {
  patternName: string;         // e.g. "ISO_NORM", "MUSS_PATTERN"
  phase: "references" | "requirements";
  matchCount: number;          // total matches across all documents
  matchedDocIds: string[];     // doc IDs that produced at least one match
  zeroMatch: boolean;          // true when matchCount === 0
}
```

**Privacy note:** no match text stored — only counts and doc IDs.

### `LlmSampleRecord`
One entry per document sampled by Phase 6 LLM validation.

```ts
interface LlmSampleRecord {
  docId: string;
  docType: string;
  regexCount: number;          // requirements found by regex
  llmConfirmedCount: number;   // regex results confirmed by LLM
  llmRejectedCount: number;    // regex results rejected by LLM
  llmRecoveredCount: number;   // requirements found by LLM but missed by regex
  delta: number;               // abs(regexCount - confirmed) / max(regexCount, 1)
  llmCallDurationMs: number;
}
```

**Privacy note:** no prompt content, no LLM output text — only counts and timing.

### `ZeroOutputEntry`
One entry per document that produced no requirements, no references, or <10% token retention. Computed post-hoc in Phase 9.

```ts
interface ZeroOutputEntry {
  docId: string;
  docType: string;
  parseSuccess: boolean;
  requirementCount: number;
  referenceCount: number;
  tokenRetentionRate: number;
  likelyCause: "parse_failure" | "scanned_pdf" | "wrong_doc_type" | "regex_miss" | "unknown";
}
```

`likelyCause` is inferred deterministically from existing state fields, evaluated in priority order (first match wins):
1. `parse_failure` → `parseSuccess === false`
2. `scanned_pdf` → `pdfClassification === "fully_scanned"`
3. `wrong_doc_type` → `detectedDocType` is `planning | meeting | tracker | other`
4. `regex_miss` → parse succeeded, doc type would normally produce output, but none found
5. `unknown` → fallback

---

## Output File

### Written by Phase 9
`scan-report-<ts>-debug.json` — written only when `debugSettings.enabled === true` and at least one category is enabled.

### String safety
The debug file uses a relaxed string guard: no string may exceed 60 chars, except:
- `patternName` fields (exempt — these are source-code identifiers)
- `suggestedRegex` fields (exempt — regex strings can be up to 200 chars)

A dedicated `sanitizeDebugReport()` function enforces this, separate from the main `sanitizeReport()`.

### File structure
```json
{
  "scanId": "...",
  "generatedAt": "...",
  "categories": {
    "decisionAudit": { "enabled": true, "records": [...] },
    "patternCoverage": { "enabled": true, "entries": [...] },
    "llmTrace": { "enabled": false },
    "zeroOutputDocs": { "enabled": true, "entries": [...] }
  }
}
```

Disabled categories are represented as `{ "enabled": false }` with no data key.

---

## Server API

Two new routes added to `src/server/routes.ts`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/debug-settings` | Returns current `DebugSettings` object |
| `PATCH` | `/api/debug-settings` | Merges partial update, rewrites `debug-settings.json`, returns updated settings |

PATCH body is a partial `DebugSettings`. Unknown keys are ignored. Invalid values (non-boolean) are rejected with 400.

---

## UI Integration

### Settings panel
A collapsible "Debug Settings" panel in the dashboard. Shows one toggle per category with a privacy level badge (`LOW` / `MEDIUM`). Calls `PATCH /api/debug-settings` on toggle. Shows a notice: "Settings take effect on the next scan."

### Debug Report tab
Appears in the dashboard only when a `*-debug.json` file is present alongside the selected report. Contains four sub-sections:

1. **Decision Audit** — table: docId | docType | top 3 signals | chunk strategy | confidence
2. **Pattern Coverage** — table sorted by matchCount ascending; zero-match rows highlighted red
3. **LLM Trace** — per-doc bar: confirmed (green) / rejected (red) / recovered (blue); delta column
4. **Zero Output Docs** — list with likelyCause tag; sorted by tokenRetentionRate ascending

---

## Phase Touch Points

| Phase | What it writes | Condition |
|-------|---------------|-----------|
| 2 — parse | `decisionAudit[docId]` docType + OEM + chunk signals | `state.decisionAudit !== undefined` |
| 4 — fingerprint | (no new debug writes; structural signals already in fingerprint) | — |
| 5 — cluster | `decisionAudit[docId].versionPairContributions` for score ≥ 5 | `state.decisionAudit !== undefined` |
| 5 — references | `patternCoverage` per reference pattern | `state.patternCoverage !== undefined` |
| 6 — requirements | `patternCoverage` per requirement pattern; `llmTrace` per sampled doc | respective fields defined |
| 9 — report | `zeroOutputDocs` (computed post-hoc); writes debug JSON file | `debugSettings.enabled` |

---

## Out of Scope

- Hot-reload of debug settings mid-scan (settings read once at startup)
- Per-document LLM prompt/response logging (privacy risk, no agreed format)
- Debug data in the main `scan-report-<ts>.json`
- Phase performance profiling beyond existing `phaseEnd` timing in the log
