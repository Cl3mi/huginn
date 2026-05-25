# Document Origin Classification — Design Spec

**Date:** 2026-05-25  
**Status:** Approved  
**Scope:** Replace the current single-word-match origin detection with a multi-signal, evidence-accumulating classifier that produces internal / external / unknown with full audit trail.

---

## Problem

`documentOrigin` is already defined on `FileEntry` but the current logic is fragile:
- Phase 1 fires `matchesCompany(relativePath, identity)` — a single significant word anywhere in the path triggers "internal"
- Phase 2 does a fallback check on the first 2000 chars of text content
- `matchesCompany` returns a hard boolean — no confidence, no reason recorded
- A customer document that mentions the company's name once is misclassified as internal (precision failure)
- There is no way to know which documents were classified at all, or how confidently

---

## Goals

1. **Precision-first:** Never label a document "internal" without strong evidence. One stray mention is insufficient.
2. **Strong recall:** Don't leave documents as "unknown" if multiple weak signals agree.
3. **Explicit unknown state:** Ambiguous documents get "unknown" — not a forced wrong label.
4. **Full audit trail:** Every classification records exactly which signals fired and their weights.
5. **Visible quality:** The scan report and dashboard show how many docs are classified, at what confidence, and which are still unknown.

---

## Data Model

### New types in `src/state.ts`

```typescript
export interface OriginSignal {
  signal: string;                          // e.g. "path_segment_match"
  direction: "internal" | "external";
  weight: number;
}

export interface OriginClassification {
  result: "internal" | "external" | "unknown";
  internalScore: number;
  externalScore: number;
  confidence: "high" | "medium" | "low" | "none";
  signals: OriginSignal[];                 // all fired signals — never empty on classified docs
}
```

### Changes to existing types

**`FileEntry.documentOrigin`** — type widens to include the third state:
```typescript
documentOrigin?: "internal" | "external" | "unknown";
```
Still optional: parse-failed files that never reach Phase 2 stay `undefined`.

**`ParsedDocument`** — new field added:
```typescript
originClassification?: OriginClassification;
```

After Phase 2, `doc.documentOrigin` is always derived from `doc.originClassification.result`. The two are always in sync for successfully parsed documents.

---

## Signal Catalog

All signals are collected in Phase 2, after `detectedDocType` is resolved. Path-derived signals reuse fields already set by Phase 1 (`inferredCustomer`, `inferredDocumentCategory`, `pathSegments`).

### Internal signals

| Signal | Condition | Weight |
|---|---|---|
| `metadata_author_match` | DOCX `dc:creator` / `cp:lastModifiedBy` or PDF `Author` matches company name/alias | +5 |
| `metadata_company_match` | DOCX `docProps/app.xml → <Company>` matches company name/alias | +4 |
| `path_segment_match` | A significant word from company name/alias matches a **full path segment** (not substring anywhere) | +4 |
| `content_match_strong` | Company name appears ≥3× in `textContent.slice(0, 2000)` | +3 |
| `doctype_internal` | `detectedDocType` ∈ {arbeitsanweisung, protokoll, handbuch, lessons_learned, 8d_report, kontrollplan, serienfreigabe, empb, aenderungsantrag, reklamation} | +2 |
| `content_match_weak` | Company name appears 1–2× in first 2000 chars | +1 |

### External signals

| Signal | Condition | Weight |
|---|---|---|
| `oem_folder_detected` | `inferredCustomer` is set (OEM token found in path by Phase 1) | +3 |
| `doctype_external_strong` | `detectedDocType` ∈ {lastenheft, sla, norm} | +3 |
| `doc_category_rfq` | `inferredDocumentCategory` ∈ {rfq, quotation} | +2 |
| `doctype_external_weak` | `detectedDocType` ∈ {qualitätsvorgabe, pruefspezifikation} | +2 |

### Thresholds

```
internal_score >= 4  AND  internal_score > external_score  →  "internal"
external_score >= 3  AND  external_score > internal_score  →  "external"
otherwise                                                  →  "unknown"
```

**Precision guard examples:**
- `content_match_weak` (+1) alone → score 1, below threshold → **unknown** ✓
- `doctype_internal` (+2) alone → score 2, below threshold → **unknown** ✓
- `path_segment_match` (+4) alone → score 4, clears threshold → **internal** ✓
- `oem_folder_detected` (+3) alone → score 3, clears threshold → **external** ✓
- `content_match_strong` (+3) + `doctype_internal` (+2) = 5 → **internal** ✓
- `oem_folder_detected` (+3) + `doctype_external_strong` (+3) = 6 → **external** ✓

**Conflict resolution:** If both internal and external scores are set, the higher score wins provided it clears its own threshold. If scores are exactly equal → **unknown**.

### Confidence derivation

Evaluated in order — first match wins:

```
"none"   — result is "unknown"
"high"   — winning score ≥ 8, OR gap between scores ≥ 6
"medium" — winning score ≥ 5, OR gap ≥ 3
"low"    — classified (catch-all for anything that cleared threshold but didn't reach medium)
```

---

## Classification Algorithm

### New file: `src/utils/origin-classifier.ts`

Two pure exported functions, no I/O, no LLM:

```typescript
// Defined in this file (not exported to state.ts — implementation detail)
interface DocxAuthorMeta {
  creator?: string;          // dc:creator from core.xml
  lastModifiedBy?: string;   // cp:lastModifiedBy from core.xml
  company?: string;          // <Company> from app.xml
}

export function collectOriginSignals(
  doc: ParsedDocument,
  identity: CompanyIdentity,
  docxMeta?: DocxAuthorMeta,  // author/company from DOCX metadata
  pdfAuthor?: string,         // Author field from Tika PDF metadata
): OriginSignal[]

export function classifyOrigin(signals: OriginSignal[]): OriginClassification
```

`collectOriginSignals` checks all signals in the catalog, returns only fired ones. The full-segment path check replaces the old `matchesCompany(relativePath, …)` substring match.

`classifyOrigin` sums weights by direction, applies thresholds, derives confidence, returns the complete `OriginClassification`.

---

## Pipeline Changes

### New helper: `extractDocxAuthorMeta(path)` in Phase 2

Reads the DOCX zip (already opened for date extraction) and additionally extracts:
- `docProps/core.xml`: `dc:creator`, `cp:lastModifiedBy`
- `docProps/app.xml`: `<Company>`

Returns a typed `DocxAuthorMeta` object. Called alongside the existing `extractHeadingsFromDocxXml`.

For PDFs: Tika's response already contains `Author` and `Creator` fields — extract them from the existing Tika call when Tika is available (soft signal — only fires if Tika is reachable).

### Phase 1 — simplified

Remove the `matchesCompany` call and the `documentOrigin` assignment from Phase 1. Phase 1 only harvests; classification is Phase 2's responsibility. `documentOrigin` on `FileEntry` is set later.

### Phase 2 — classification consolidated

At the end of parsing each document, after `detectedDocType` is resolved:

```typescript
if (state.companyIdentity) {
  const signals = collectOriginSignals(doc, state.companyIdentity, docxMeta, pdfAuthor);
  const classification = classifyOrigin(signals);
  doc.originClassification = classification;
  doc.documentOrigin = classification.result;
}
```

The existing Phase 2 fallback loop (lines 542–551 in `2-parse.ts`) is removed entirely.

### Phase 7 — new consistency check

```
Name:       origin_classification_coverage
Value:      (internal_count + external_count) / total_parsed
Threshold:  0.70
Severity:   WARNING if < threshold, INFO otherwise
Interpretation: "X% of documents classified (Y internal, Z external, W unknown)"
```

Additional advisory (INFO only, no threshold failure): if >50% of classified documents are low-confidence, the interpretation notes "many borderline classifications — consider adding company aliases."

### Phase 8 — report serialization

`originClassification` is serialized per document in the JSON report. The `signals` array has at most 10 entries; all strings are under 120 chars. A top-level `originSummary` object is added:

```json
"originSummary": {
  "internal": 8,
  "external": 4,
  "unknown": 2,
  "classificationRate": 0.857,
  "highConfidence": 7,
  "lowConfidence": 3
}
```

The human-readable report (`-human.md`) gets a new **Document Origin Classification** section:

```markdown
## Document Origin Classification
Internal: 8 | External: 4 | Unknown: 2 (86% classified)

### Unknown documents (need review)
- doc-011  InternalDocs/Meeting Minutes.docx  — no signals fired
- doc-014  _test-docs/Drawing-Scan.pdf        — parse failure, no textContent

### Low-confidence classifications
- doc-007  Requirements/IRS.docx  — internal (score 4 vs 0) via content_match_strong+doctype_internal
```

---

## Observability — Dashboard

The existing `src/dashboard/components/document-distribution.ts` component is extended (no new file):

- **Origin Breakdown donut chart** — internal / external / unknown using existing color palette (orange/green/grey)
- **Unknown docs list** — each row shows which signals *almost* fired (e.g. "score: 1 — only content_match_weak fired")

---

## Files Changed

| File | Change |
|---|---|
| `src/state.ts` | Add `OriginSignal`, `OriginClassification` interfaces; add `originClassification?` to `ParsedDocument`; widen `documentOrigin` type |
| `src/utils/origin-classifier.ts` | **New** — `collectOriginSignals`, `classifyOrigin` |
| `src/phases/1-harvest.ts` | Remove `matchesCompany` call and `documentOrigin` assignment |
| `src/phases/2-parse.ts` | Add `extractDocxAuthorMeta`; replace fallback loop with `collectOriginSignals` + `classifyOrigin`; extract PDF author from Tika |
| `src/phases/8-validate.ts` | Add `origin_classification_coverage` consistency check |
| `src/phases/8-report.ts` | Add `originSummary` to JSON; add origin section to human.md |
| `src/dashboard/components/document-distribution.ts` | Add origin donut chart + unknown docs list |

---

## Out of Scope

- LLM-based classification for edge cases (not needed — confidence field makes ambiguity visible without LLM cost)
- Retroactive re-classification of existing scan reports
- User-override API to manually set origin on a document
