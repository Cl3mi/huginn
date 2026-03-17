# Document Intelligence Scan Report

**Scan ID:** scan-1773666225003-f83f68e3
**Started:** 2026-03-16T13:03:45.135Z
**Completed:** 2026-03-16T13:04:07.397Z

## Data Quality Assessment: ⚠️ Use with caution (Score: 78/100)

> **Note:** Use with caution. This score reflects parse success rate, heading extraction, LLM validation agreement, and OCR coverage. Architecture decisions should account for this quality level.

| Quality Component | Score |
|-------------------|-------|
| Parse success rate | 93% (weight 30%) |
| Heading extraction confidence | 71% (weight 20%) |
| Requirement validation agreement | 29% (weight 20%) |
| OCR coverage score | 100% (weight 30%) |
| Version pair calibration | ⚠️ uncalibrated — manual review recommended |

## Executive Summary

| Metric | Value |
|--------|-------|
| Total files found | 14 |
| Successfully parsed | 14 |
| Version pairs detected | 9 (HIGH confidence) |
| Version chains | 2 |
| References extracted | 29 |
| Requirements extracted | 2 (reliable docs only) |
| Scanned PDFs (OCR needed) | 0 |
| Critical checks failed | 0 |

## RAG Chunking Strategy by Document

| Strategy | Count | Avg Confidence | Meaning |
|----------|-------|----------------|---------|
| heading_sections | 10 | 74% | Split by heading hierarchy — use section metadata for retrieval |
| table_rows | 3 | 95% | Split by row — XLSX/matrix files, each row = one chunk |
| sliding_window | 1 | 75% | No heading structure — use overlapping windows, no section metadata |

> ⚠️ **5 document(s)** have requirement-type keywords but are NOT reliable for requirement metadata (wrong doc type). Do not use MUSS/SOLL/KANN as retrieval filter for: MeetingMinutes-NOVA-DesignReview-2024-07-18.pdf, NOVA-SRS-001-SystemRequirements-v2.pdf, NOVA-SRS-001-SystemRequirements-v1.pdf, NOVA-OPEN-009-IssueTracker.xlsx, NOVA-PLAN-008-RiskRegister.xlsx

## Document Types

| Type | Count |
|------|-------|
| abweichliste | 7 |
| lastenheft | 5 |
| other | 2 |

## Corpus Freshness Profile

| Year | Documents | Source reliability |
|------|-----------|-------------------|
| 2024 | 1 | |
| 2026 | 13 | |

**Date signal quality:** 1/14 docs have document-internal dates (remainder uses ctime fallback).
**Freshness:** 0% of docs are ≥3 years old — corpus is relatively fresh, time-decay scoring optional.

## OEM Distribution

| OEM | Documents |
|-----|-----------|
| unknown | 14 |

## Folder Structure Analysis

**Detected pattern:** unknown (confidence: 30%)
**Detected projects:** InternalDocs, Helios-Automotive-AG

## Version Chains Detected

- Scanned-Drawing-BatteryPack-Housing.pdf → NOVA-OPEN-009-IssueTracker.xlsx → NOVA-PLAN-007-ProjectMilestones.xlsx → NOVA-PLAN-008-RiskRegister.xlsx
- NOVA-SRS-001-SystemRequirements-v2.pdf → NOVA-SRS-001-SystemRequirements-v1.pdf → NOVA-IRS-002-InterfaceRequirements.pdf

### HIGH Confidence Version Pairs

| Doc A | Doc B | Score | Newer | Flag |
|-------|-------|-------|-------|------|
| Scanned-Drawing-BatteryPack-Housing.pdf | NOVA-OPEN-009-IssueTracker.xlsx | 8/12 | UNKNOWN |  |
| Scanned-Drawing-BatteryPack-Housing.pdf | NOVA-PLAN-007-ProjectMilestones.xlsx | 8/12 | UNKNOWN |  |
| Scanned-Drawing-BatteryPack-Housing.pdf | NOVA-PLAN-008-RiskRegister.xlsx | 8/12 | UNKNOWN |  |
| NOVA-SRS-001-SystemRequirements-v2.pdf | NOVA-SRS-001-SystemRequirements-v1.pdf | 11/12 | UNKNOWN |  |
| NOVA-SRS-001-SystemRequirements-v2.pdf | NOVA-IRS-002-InterfaceRequirements.pdf | 7/12 | A |  |
| NOVA-SRS-001-SystemRequirements-v1.pdf | NOVA-IRS-002-InterfaceRequirements.pdf | 7/12 | A |  |
| NOVA-OPEN-009-IssueTracker.xlsx | NOVA-PLAN-007-ProjectMilestones.xlsx | 9/12 | UNKNOWN |  |
| NOVA-OPEN-009-IssueTracker.xlsx | NOVA-PLAN-008-RiskRegister.xlsx | 9/12 | UNKNOWN |  |
| NOVA-PLAN-007-ProjectMilestones.xlsx | NOVA-PLAN-008-RiskRegister.xlsx | 9/12 | UNKNOWN |  |

### Version Pair Score Distribution

| Score Range | Count | % | Threshold |
|-------------|-------|---|-----------|
| 10–12 | 1 | 3% | |
| 7–9 | 8 | 21% | ← HIGH threshold |
| 5–6 | 13 | 34% | ← MEDIUM threshold |
| 3–4 | 16 | 42% | ← LOW threshold |
| 0–2 | 0 | 0% | |

> ⚠️ **Note:** Thresholds (≥7 HIGH, ≥5 MEDIUM, ≥3 LOW) are **uncalibrated**. Recommend manual review of 5 HIGH pairs and 5 MEDIUM pairs before using version metadata in RAG.

## Reference Graph Summary

### Most Referenced Norms

| Norm | References |
|------|------------|
| ISO 21434 | 6 |
| VDA 6.3:2016 | 4 |
| IATF 16949:2016 | 4 |
| ISO 26262:2018 | 4 |
| ISO 9001:2015 | 3 |
| ISO 15118 | 3 |
| ISO 5817 | 1 |
| ISO 2768 | 1 |
| ISO 9227 | 1 |
| DIN EN 10083-3 | 1 |

**Internal reference resolution rate:** 100% (0/0 internal refs resolved)
**External norm references:** 29 (ISO/VDA/DIN/EN/IATF — not expected to resolve to corpus docs)

## Requirement Statistics

### By Type

| Type | Count |
|------|-------|
| KANN | 2 |

### By Category

| Category | Count |
|----------|-------|
| Sicherheit | 2 |

**Safety-flagged requirements:** 2

### LLM Validation Results

- Sample size: 2 documents (stratified by doc type)
- Regex vs LLM delta: 71.4%
- Confidence interval: [8.8%, 100.0%]

| Document Type | Sampled | Delta | Reliability |
|---------------|---------|-------|-------------|
| lastenheft | 2 | 71% | ⚠️ unreliable for RAG metadata |

## Per Document Type Breakdown

### abweichliste (7 docs)

- Avg pages: 2, avg confirmed requirements: 0, language: 14% DE
- Heading extraction coverage: 71%
- Scanned/hybrid rate: 0%
- Chunk strategy: **heading_sections**, requirement metadata reliable: 0/7 docs
- **RAG recommendation:** Chunk strategy: heading_sections. ❌ Do not use requirement type as filter.

### lastenheft (5 docs)

- Avg pages: 3, avg confirmed requirements: 0, language: 20% DE
- Heading extraction coverage: 100%
- Scanned/hybrid rate: 0%
- Chunk strategy: **heading_sections**, requirement metadata reliable: 5/5 docs
- **RAG recommendation:** Chunk strategy: heading_sections. ✅ Use MUSS/SOLL as retrieval filter.

### other (2 docs)

- Avg pages: 1, avg confirmed requirements: 1, language: 0% DE
- Heading extraction coverage: 0% ⚠️ — manual formatting suspected
- Scanned/hybrid rate: 0%
- Chunk strategy: **sliding_window**, requirement metadata reliable: 0/2 docs
- **RAG recommendation:** Heading metadata unreliable. Chunk strategy: sliding_window. ❌ Do not use requirement type as filter.

## Consistency Check Results

| Check | Status | Value | Severity | Notes |
|-------|--------|-------|----------|-------|
| tokenSumVsFullDoc | FAIL | 1.000 | WARNING | Doc doc-001 (Scanned-Drawing-BatteryPack-Housing.pdf): heading token sum differs |
| tokenSumVsFullDoc | FAIL | 0.936 | WARNING | Doc doc-002 (MeetingMinutes-NOVA-DesignReview-2024-07-18.pdf): heading token sum |
| tokenSumVsFullDoc | FAIL | 0.930 | WARNING | Doc doc-003 (TITAN-DEV-010-Abweichliste-DE.pdf): heading token sum differs from  |
| tokenSumVsFullDoc | FAIL | 0.919 | WARNING | Doc doc-004 (TITAN-SRS-009-ChassisSpec-DE.pdf): heading token sum differs from f |
| tokenSumVsFullDoc | FAIL | 0.976 | WARNING | Doc doc-005 (NOVA-QA-006-DeviationList.pdf): heading token sum differs from full |
| tokenSumVsFullDoc | FAIL | 0.954 | WARNING | Doc doc-006 (NOVA-QA-005-SupplierAuditReport.pdf): heading token sum differs fro |
| tokenSumVsFullDoc | FAIL | 0.957 | WARNING | Doc doc-007 (NOVA-SRS-001-SystemRequirements-v2.pdf): heading token sum differs  |
| tokenSumVsFullDoc | FAIL | 0.951 | WARNING | Doc doc-008 (NOVA-SRS-001-SystemRequirements-v1.pdf): heading token sum differs  |
| tokenSumVsFullDoc | FAIL | 0.936 | WARNING | Doc doc-009 (NOVA-IRS-002-InterfaceRequirements.pdf): heading token sum differs  |
| tokenSumVsFullDoc | FAIL | 0.977 | WARNING | Doc doc-013 (NOVA-FMEA-004-FailureModeAnalysis.pdf): heading token sum differs f |
| tokenSumVsFullDoc | FAIL | 0.948 | WARNING | Doc doc-014 (NOVA-TR-003-TestReport-BMS.pdf): heading token sum differs from ful |
| tokenSumVsFullDoc | PASS | 0.000 | INFO | 3 XLSX/tabular document(s) skipped — heading token sum not applicable, use table |
| versionPairSymmetry | PASS | 0.000 | INFO | Version pair detection is symmetric |
| referenceResolutionRate | PASS | 1.000 | INFO | No internal cross-references found (29 external norm refs excluded from rate) |
| requirementDensityRange | FAIL | 0.000 | INFO | Doc doc-004 (TITAN-SRS-009-ChassisSpec-DE.pdf): classified as lastenheft but has |
| requirementDensityRange | FAIL | 0.000 | INFO | Doc doc-006 (NOVA-QA-005-SupplierAuditReport.pdf): classified as lastenheft but  |
| requirementDensityRange | FAIL | 0.000 | INFO | Doc doc-009 (NOVA-IRS-002-InterfaceRequirements.pdf): classified as lastenheft b |
| requirementDensityRange | FAIL | 0.333 | INFO | Doc doc-013 (NOVA-FMEA-004-FailureModeAnalysis.pdf): classified as lastenheft bu |
| requirementDensityRange | FAIL | 0.333 | INFO | Doc doc-014 (NOVA-TR-003-TestReport-BMS.pdf): classified as lastenheft but has o |
| parserDivergenceRate | PASS | 0.000 | INFO | 0% major parser divergence in Office files — acceptable |
| scannedPdfRate | PASS | 0.000 | INFO | All 11 PDFs are native (scannedPageRatio ≤10% per doc) |
| oemConsistency | PASS | 0.000 | INFO | Each project folder contains documents from a single OEM |
| languageMixRate | PASS | 0.857 | INFO | 86% of documents have non-German primary language — consider bilingual chunking  |
| fikbCoverage | PASS | 1.000 | INFO | 100% of FIKB/KB_Master IDs from Lastenhefte appear in Abweichlisten |
| llmValidationDelta | FAIL | 0.714 | WARNING | Regex vs LLM requirement count differs by 71% — LLM finds more requirements; reg |
| parseSuccessRate | PASS | 0.929 | INFO | 93% parse success rate (13/14 docs with charCount > 100) |
| chunkStrategyConfidence | FAIL | 2.000 | WARNING | 2 doc(s) have heading_sections recommended with confidence <70% — sparse heading |
| oemSourceConflict | PASS | 0.000 | INFO | No OEM signal conflicts between folder and document-internal detection |
| actionabilityMatrix | FAIL | 6.500 | WARNING | 13 warnings — review flagged items before finalizing RAG architecture |

## Parser Evaluation (officeparser vs Tika)

- Office files compared: 3
- Major divergence (>20% char delta): 0
- Minor divergence (5-20%): 0
- No divergence: 3

**Recommendation:** officeparser is reliable for this corpus. Tika recommended as fallback for PDFs.

## RAG Pipeline Recommendations

- **Bilingual processing:** 86% non-German documents detected. Implement language-aware chunking in RAG pipeline.
- **Version-aware retrieval:** 2 version chain(s) detected. Implement version-aware ranking so newer documents take precedence.
- **Safety review:** 2 safety-flagged requirements identified. These must be human-reviewed before any automated compliance decisions.

## RAG Architecture Decisions

> Evidence-based decisions derived from scan signals. Each decision includes evidence, recommendation, and confidence.

### DEC-CHUNK: Chunking Strategy
- 10 docs → heading_sections, 3 → table_rows, 1 → sliding_window
- ⚠️ 2 heading_sections docs have low confidence (<70%) — may need manual strategy override
- **Recommendation:** Use per-document strategy from `recommendedChunkStrategy` field; dominant is **heading_sections**.
- **Confidence:** MEDIUM

### DEC-OCR: OCR Pre-processing
- 11 PDFs total: 0 need full OCR, 0 need partial OCR
- **Recommendation:** No OCR pre-processing required for this corpus.
- **Confidence:** MEDIUM

### DEC-DEDUP: Deduplication and Version Handling
- 9 HIGH confidence version pairs, 2 version chain(s) detected
- **Recommendation:** Implement version-aware deduplication — index ONLY the latest doc per chain (2 chains). Older versions stored as archives.
- **Confidence:** MEDIUM — thresholds uncalibrated, manual verification recommended

### DEC-EMBED: Embedding Strategy
- 12 non-German documents (86% of corpus)
- Section embeddings: disabled (set SECTION_EMBEDDINGS=1 to enable)
- **Recommendation:** Use **BGE-M3** (multilingual, 1024-dim) for multilingual corpus. Enable SECTION_EMBEDDINGS=1 for section-level retrieval granularity.
- **Confidence:** HIGH

### DEC-METADATA: Requirement Metadata for RAG Filtering
- 5/14 documents have reliable requirement metadata
- LLM validation: delta=71%
- **Recommendation:** Use MUSS/SOLL/KANN as retrieval filter for 5 reliable doc types. Exclude planning/meeting/tracker docs from metadata filtering.
- **Confidence:** LOW — resolve consistency check failures first

### DEC-PARSER: Parser Configuration
- 3 Office files compared: 0 major divergence (0%)
- 11 PDFs parsed via Tika
- **Recommendation:** Keep officeparser for Office files (acceptable divergence), Tika for PDFs.
- **Confidence:** LOW — too few Office files for robust estimate

### DEC-REFS: Reference Resolution Strategy
- Internal ref resolution rate: 100% (0 refs)
- **Recommendation:** Reference graph is reasonably complete. Enable cross-reference navigation in RAG for traceability.
- **Confidence:** N/A — no internal refs found

## Items Requiring Manual Review

**Parse failures (1 files — likely password-protected or corrupt):**
- InternalDocs/Scanned-Drawing-BatteryPack-Housing.pdf (empty_extraction)

