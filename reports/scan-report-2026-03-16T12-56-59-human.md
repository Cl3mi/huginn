# Document Intelligence Scan Report

**Scan ID:** scan-1773665819190-9aa87c9b
**Started:** 2026-03-16T12:56:59.201Z
**Completed:** 2026-03-16T12:56:59.416Z

## Data Quality Assessment: ⚠️ Use with caution (Score: 70/100)

> **Note:** Use with caution. This score reflects parse success rate, heading extraction, LLM validation agreement, and OCR coverage. Architecture decisions should account for this quality level.

| Quality Component | Score |
|-------------------|-------|
| Parse success rate | 100% (weight 30%) |
| Heading extraction confidence | 0% (weight 20%) |
| Requirement validation agreement | 50% (weight 20%) |
| OCR coverage score | 100% (weight 30%) |
| Version pair calibration | ⚠️ uncalibrated — manual review recommended |

## Executive Summary

| Metric | Value |
|--------|-------|
| Total files found | 14 |
| Successfully parsed | 3 |
| Version pairs detected | 0 (HIGH confidence) |
| Version chains | 0 |
| References extracted | 3 |
| Requirements extracted | 0 (reliable docs only) |
| Scanned PDFs (OCR needed) | 0 |
| Critical checks failed | 0 |

## RAG Chunking Strategy by Document

| Strategy | Count | Avg Confidence | Meaning |
|----------|-------|----------------|---------|
| table_rows | 3 | 95% | Split by row — XLSX/matrix files, each row = one chunk |

> ⚠️ **2 document(s)** have requirement-type keywords but are NOT reliable for requirement metadata (wrong doc type). Do not use MUSS/SOLL/KANN as retrieval filter for: NOVA-OPEN-009-IssueTracker.xlsx, NOVA-PLAN-008-RiskRegister.xlsx

## Document Types

| Type | Count |
|------|-------|
| abweichliste | 2 |
| other | 1 |

## Corpus Freshness Profile

| Year | Documents | Source reliability |
|------|-----------|-------------------|
| 2026 | 3 | |

**Date signal quality:** 0/3 docs have document-internal dates (remainder uses ctime fallback).
**Freshness:** 0% of docs are ≥3 years old — corpus is relatively fresh, time-decay scoring optional.

## OEM Distribution

| OEM | Documents |
|-----|-----------|
| unknown | 3 |

## Folder Structure Analysis

**Detected pattern:** unknown (confidence: 30%)
**Detected projects:** InternalDocs, Helios-Automotive-AG

## Version Chains Detected

No version chains detected.

### Version Pair Score Distribution

| Score Range | Count | % | Threshold |
|-------------|-------|---|-----------|
| 10–12 | 0 | 0% | |
| 7–9 | 0 | 0% | ← HIGH threshold |
| 5–6 | 3 | 100% | ← MEDIUM threshold |
| 3–4 | 0 | 0% | ← LOW threshold |
| 0–2 | 0 | 0% | |

> ⚠️ **Note:** Thresholds (≥7 HIGH, ≥5 MEDIUM, ≥3 LOW) are **uncalibrated**. Recommend manual review of 5 HIGH pairs and 5 MEDIUM pairs before using version metadata in RAG.

## Reference Graph Summary

### Most Referenced Norms

| Norm | References |
|------|------------|
| ISO 21434 | 3 |

**Internal reference resolution rate:** 100% (0/0 internal refs resolved)
**External norm references:** 3 (ISO/VDA/DIN/EN/IATF — not expected to resolve to corpus docs)

## Requirement Statistics

### By Type

| Type | Count |
|------|-------|

### By Category

| Category | Count |
|----------|-------|

**Safety-flagged requirements:** 0

## Per Document Type Breakdown

### abweichliste (2 docs)

- Avg pages: 0, avg confirmed requirements: 1, language: 0% DE
- Heading extraction coverage: 0% ⚠️ — manual formatting suspected
- Scanned/hybrid rate: 0%
- Chunk strategy: **table_rows**, requirement metadata reliable: 0/2 docs
- **RAG recommendation:** Heading metadata unreliable. Chunk strategy: table_rows. ❌ Do not use requirement type as filter.

### other (1 docs)

- Avg pages: 0, avg confirmed requirements: 1, language: 0% DE
- Heading extraction coverage: 0% ⚠️ — manual formatting suspected
- Scanned/hybrid rate: 0%
- Chunk strategy: **table_rows**, requirement metadata reliable: 0/1 docs
- **RAG recommendation:** Heading metadata unreliable. Chunk strategy: table_rows. ❌ Do not use requirement type as filter.

## Consistency Check Results

| Check | Status | Value | Severity | Notes |
|-------|--------|-------|----------|-------|
| tokenSumVsFullDoc | PASS | 0.000 | INFO | 3 XLSX/tabular document(s) skipped — heading token sum not applicable, use table |
| versionPairSymmetry | PASS | 0.000 | INFO | Version pair detection is symmetric |
| referenceResolutionRate | PASS | 1.000 | INFO | No internal cross-references found (3 external norm refs excluded from rate) |
| requirementDensityRange | PASS | 0.000 | INFO | Requirement density is within expected ranges for all documents |
| parserDivergenceRate | PASS | 0.000 | INFO | 0% major parser divergence in Office files — acceptable |
| scannedPdfRate | PASS | 0.000 | INFO | All 0 PDFs are native (scannedPageRatio ≤10% per doc) |
| oemConsistency | PASS | 0.000 | INFO | Each project folder contains documents from a single OEM |
| languageMixRate | PASS | 1.000 | INFO | 100% of documents have non-German primary language — consider bilingual chunking |
| parseSuccessRate | PASS | 1.000 | INFO | 100% parse success rate (3/3 docs with charCount > 100) |
| chunkStrategyConfidence | PASS | 0.000 | INFO | All heading_sections recommendations have adequate confidence |
| oemSourceConflict | PASS | 0.000 | INFO | No OEM signal conflicts between folder and document-internal detection |
| actionabilityMatrix | PASS | 0.000 | INFO | Scan results are actionable — sufficient signal quality for RAG architecture dec |

## Parser Evaluation (officeparser vs Tika)

No Office file comparison data available.

## RAG Pipeline Recommendations

- **Bilingual processing:** 100% non-German documents detected. Implement language-aware chunking in RAG pipeline.

## RAG Architecture Decisions

> Evidence-based decisions derived from scan signals. Each decision includes evidence, recommendation, and confidence.

### DEC-CHUNK: Chunking Strategy
- 0 docs → heading_sections, 3 → table_rows, 0 → sliding_window
- **Recommendation:** Use per-document strategy from `recommendedChunkStrategy` field; dominant is **table_rows**.
- **Confidence:** HIGH

### DEC-OCR: OCR Pre-processing
- 0 PDFs total: 0 need full OCR, 0 need partial OCR
- **Recommendation:** No OCR pre-processing required for this corpus.
- **Confidence:** HIGH

### DEC-DEDUP: Deduplication and Version Handling
- 0 HIGH confidence version pairs, 0 version chain(s) detected
- **Recommendation:** No version pairs detected — deduplication not critical, but implement as precaution.
- **Confidence:** LOW — no training data

### DEC-EMBED: Embedding Strategy
- 3 non-German documents (100% of corpus)
- Section embeddings: disabled (set SECTION_EMBEDDINGS=1 to enable)
- **Recommendation:** Use **BGE-M3** (multilingual, 1024-dim) for multilingual corpus. Enable SECTION_EMBEDDINGS=1 for section-level retrieval granularity.
- **Confidence:** HIGH

### DEC-METADATA: Requirement Metadata for RAG Filtering
- 0/3 documents have reliable requirement metadata
- LLM validation: not run (Ollama unavailable)
- **Recommendation:** Do not use requirement type as retrieval filter — no reliable docs found.
- **Confidence:** MEDIUM

### DEC-PARSER: Parser Configuration
- 0 Office files compared: 0 major divergence (0%)
- 0 PDFs parsed via Tika
- **Recommendation:** Keep officeparser for Office files (acceptable divergence), Tika for PDFs.
- **Confidence:** LOW — too few Office files for robust estimate

### DEC-REFS: Reference Resolution Strategy
- Internal ref resolution rate: 100% (0 refs)
- **Recommendation:** Reference graph is reasonably complete. Enable cross-reference navigation in RAG for traceability.
- **Confidence:** N/A — no internal refs found

## Items Requiring Manual Review

No critical items flagged.
