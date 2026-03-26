import { writeFile, mkdirSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import type { ScannerState } from "../state.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { runNarrative } from "./8-narrative.ts";

const writeFileAsync = promisify(writeFile);

// ============================================================
// CRITICAL: Hard content-leak guard
// Any string in the report longer than MAX chars → throw Error
// ============================================================
function sanitizeReport(obj: unknown, path = "root"): void {
  const MAX = CONFIG.maxStringLengthInReport;
  if (typeof obj === "string") {
    if (obj.length > MAX) {
      throw new Error(
        `Content leak guard triggered at ${path}: string length ${obj.length} > ${MAX}. Value starts with: "${obj.slice(0, 40)}..."`
      );
    }
    return;
  }
  if (Array.isArray(obj)) {
    // Check average length of string array items
    const stringItems = obj.filter((item) => typeof item === "string") as string[];
    if (stringItems.length > 0) {
      const avgLen = stringItems.reduce((s, i) => s + i.length, 0) / stringItems.length;
      if (avgLen > 80) {
        throw new Error(
          `Content leak guard triggered at ${path}: string array avg length ${avgLen.toFixed(0)} > 80`
        );
      }
    }
    obj.forEach((item, i) => sanitizeReport(item, `${path}[${i}]`));
    return;
  }
  if (obj !== null && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj)) {
      sanitizeReport(val, `${path}.${key}`);
    }
  }
}

// IMP-11: Compute metadata quality composite score (0-100)
function computeMetadataQualityScore(state: ScannerState): {
  overall: number;
  components: Record<string, number | string>;
  interpretation: string;
} {
  const totalParsed = state.parsed.length;
  // FINDING-018: empty corpus → score 0, not 90
  if (totalParsed === 0) {
    return { overall: 0, components: {}, interpretation: "No documents parsed — metrics unavailable" };
  }
  // Parse success rate (weight 30%)
  const successRate = state.parsed.filter((d) => d.parseSuccess).length / totalParsed;

  // Heading extraction confidence: rate of docs using xhtml or numbered strategy (weight 20%)
  // Proxy: docs with headings / total parsed
  const withHeadings = state.parsed.filter((d) => d.headings.length > 0).length;
  const headingConf = withHeadings / totalParsed;

  // Requirement validation delta (weight 20%) — inverted: lower delta = higher quality
  // P2: require >= 3 sampled docs for meaningful delta; fewer = unreliable measurement
  const reqDelta = state.llmValidation.sampledDocIds.length >= 3
    ? 1 - Math.min(state.llmValidation.regexVsLlmDelta, 1)
    : 0.5; // unknown if insufficient LLM validation sample

  // Version pair calibration status
  const calibrationStatus = "uncalibrated"; // until a real corpus run validates thresholds

  // OCR warning rate: (fully_scanned + hybrid) / total (weight 30%)
  const pdfs = state.parsed.filter((d) => d.extension === ".pdf");
  const ocrIssues = pdfs.filter((d) => d.pdfClassification === "fully_scanned" || d.pdfClassification === "hybrid").length;
  const ocrWarningRate = pdfs.length > 0 ? ocrIssues / pdfs.length : 0;
  const ocrScore = 1 - ocrWarningRate;

  // Weighted composite
  const overall = Math.round(
    successRate * 30 +
    headingConf * 20 +
    reqDelta * 20 +
    ocrScore * 30
  );

  let interpretation: string;
  if (overall >= 80) interpretation = "Metrics are reliable";
  else if (overall >= 60) interpretation = "Use with caution";
  else interpretation = "Architecture decisions should not be based on this report alone";

  return {
    overall,
    components: {
      parseSuccessRate: Math.round(successRate * 100),
      headingExtractionConfidence: Math.round(headingConf * 100),
      requirementValidationDelta: Math.round(reqDelta * 100),
      versionPairCalibrationStatus: calibrationStatus,
      ocrWarningRate: Math.round(ocrWarningRate * 100),
    },
    interpretation,
  };
}

// IMP-13: Score distribution histogram for version pairs
function buildScoreHistogram(pairs: ScannerState["versionPairs"]): Record<string, number> {
  const buckets: Record<string, number> = { "10-12": 0, "7-9": 0, "5-6": 0, "3-4": 0, "0-2": 0 };
  for (const p of pairs) {
    if (p.score >= 10) buckets["10-12"]!++;
    else if (p.score >= 7) buckets["7-9"]!++;
    else if (p.score >= 5) buckets["5-6"]!++;
    else if (p.score >= 3) buckets["3-4"]!++;
    else buckets["0-2"]!++;
  }
  return buckets;
}

// Serialize state to plain JSON (Map → object, TypedArrays → arrays)
function serializeState(state: ScannerState): unknown {
  const mqScore = computeMetadataQualityScore(state);
  return {
    scanId: state.scanId,
    startedAt: state.startedAt.toISOString(),
    completedAt: state.completedAt?.toISOString(),
    // FINDING-019: truncate absolute path to pass sanitizeReport 120-char guard
    documentsRoot: state.documentsRoot.slice(0, CONFIG.maxStringLengthInReport),
    metadataQualityScore: mqScore,
    summary: {
      totalFiles: state.files.length,
      parsedFiles: state.parsed.length,
      parseFailures: state.parsed.filter((d) => !d.parseSuccess).length,
      byExtension: countBy(state.files, (f) => f.extension),
      byDocType: countBy(state.parsed, (d) => d.detectedDocType ?? "unknown"),
      byDocumentCategory: countBy(state.files, (f) => f.inferredDocumentCategory ?? "unknown"),
      byOem: countBy(state.parsed, (d) => d.detectedOem ?? "unknown"),
      byLanguage: countBy(state.parsed, (d) => d.language),
      scannedPdfs: state.parsed.filter((d) => d.pdfClassification === "fully_scanned").length,
      hybridPdfs: state.parsed.filter((d) => d.pdfClassification === "hybrid").length,
      ocrRequired: state.parsed.filter((d) => d.isOcrRequired).length,
    },
    parseHealth: {
      failedFiles: state.parsed
        .filter((d) => !d.parseSuccess)
        .map((d) => ({ id: d.id, path: d.path.slice(0, CONFIG.maxStringLengthInReport), reason: d.parseFailureReason ?? "unknown" })),
    },
    folderStructureInference: state.folderStructureInference,
    files: state.files.map((f) => ({
      id: f.id,
      path: f.path.slice(0, CONFIG.maxStringLengthInReport),
      filename: f.filename.slice(0, CONFIG.maxStringLengthInReport),
      extension: f.extension,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
      modifiedAt: f.modifiedAt.toISOString(),
      depth: f.depth,
      inferredCustomer: f.inferredCustomer,
      inferredProject: f.inferredProject,
      inferredDocumentCategory: f.inferredDocumentCategory,
    })),
    parsed: state.parsed.map((d) => ({
      id: d.id,
      filename: d.filename.slice(0, CONFIG.maxStringLengthInReport),
      charCount: d.charCount,
      tokenCountEstimate: d.tokenCountEstimate,
      pageCount: d.pageCount,
      language: d.language,
      headingCount: d.headings.length,
      headings: d.headings.map((h) => ({
        level: h.level,
        text: h.text.slice(0, CONFIG.maxStringLengthInReport),
        numbering: h.numbering,
        childCount: h.childCount,
        approximateTokens: h.approximateTokens,
      })),
      hasNumberedHeadings: d.hasNumberedHeadings,
      tableCount: d.tableCount,
      parserUsed: d.parserUsed,
      parserComparisonResult: d.parserComparisonResult,
      isScannedPdf: d.isScannedPdf,
      isOcrRequired: d.isOcrRequired,
      pdfClassification: d.pdfClassification,
      imageCount: d.imageCount,
      scannedPageRatio: d.scannedPageRatio,
      scannedPageIndices: d.scannedPageIndices,
      parseSuccess: d.parseSuccess,
      parseFailureReason: d.parseFailureReason,
      dateSource: d.dateSource,
      dateSignals: d.dateSignals,
      requirementQuality: d.requirementQuality,
      recommendedChunkStrategy: d.recommendedChunkStrategy,
      chunkStrategyReasoning: d.chunkStrategyReasoning,
      requirementMetadataReliable: d.requirementMetadataReliable,
      detectedOem: d.detectedOem,
      detectedDocType: d.detectedDocType,
    })),
    versionPairScoreHistogram: buildScoreHistogram(state.versionPairs),
    fingerprints: state.fingerprints.map((fp) => ({
      docId: fp.docId,
      structural: fp.structural,
      requirementDensity: fp.requirementDensity,
      hasSemanticEmbedding: Boolean(fp.semanticEmbedding),
      // NOTE: Uint32Array and Float32Array NOT included — embeddings are computation artifacts
    })),
    versionPairs: state.versionPairs,
    versionChains: state.versionChains,
    references: state.references,
    referenceGraph: Object.fromEntries(state.referenceGraph),
    requirements: state.requirements,
    llmValidation: state.llmValidation,
    consistencyChecks: state.consistencyChecks,
  };
}

function countBy<T>(arr: T[], fn: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of arr) {
    const key = fn(item);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

// ============================================================
// GAP-05: RAG Architecture Decision prompts
// Each DEC-* decision derives a structured recommendation from scan signals
// ============================================================
function generateDecisions(state: ScannerState, push: (...l: string[]) => void): void {
  const parsed = state.parsed;
  const pdfs = parsed.filter((d) => d.extension === ".pdf");

  // DEC-CATEGORY: Document category namespace isolation (rfq vs quotation)
  const rfqCount = parsed.filter((d) => d.inferredDocumentCategory === "rfq").length;
  const quotCount = parsed.filter((d) => d.inferredDocumentCategory === "quotation").length;
  const catDetected = rfqCount > 0 || quotCount > 0;
  push("### DEC-CATEGORY: Document Category Namespace Isolation");
  if (catDetected) {
    push(`- ${rfqCount} RFQ documents, ${quotCount} quotation documents detected`);
    push(`- RFQ = incoming requirements from OEM; quotation = supplier's offer/response`);
    push(`- **Recommendation:** Implement separate vector collections or metadata namespace filter per category.`);
    push(`  Query routing must inject \`category=rfq\` or \`category=quotation\` filter based on question intent.`);
    push(`  Cross-category retrieval (e.g. "what did we offer vs what was asked?") requires explicit multi-namespace query.`);
    push(`- **Confidence:** HIGH`);
  } else {
    push(`- No rfq/quotation folder structure detected — single-namespace RAG is acceptable`);
    push(`- **Recommendation:** N/A — category-based namespace isolation not required`);
    push(`- **Confidence:** N/A`);
  }
  push("");

  // DEC-CHUNK: Chunking strategy
  const chunkCounts = { heading_sections: 0, table_rows: 0, sliding_window: 0 };
  for (const d of parsed) chunkCounts[d.recommendedChunkStrategy]++;
  const dominantChunk = Object.entries(chunkCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "heading_sections";
  const lowConfChunk = parsed.filter((d) => d.recommendedChunkStrategy === "heading_sections" && d.chunkStrategyReasoning.confidence < 0.70).length;
  push("### DEC-CHUNK: Chunking Strategy");
  push(`- ${chunkCounts.heading_sections} docs → heading_sections, ${chunkCounts.table_rows} → table_rows, ${chunkCounts.sliding_window} → sliding_window`);
  if (lowConfChunk > 0) push(`- ⚠️ ${lowConfChunk} heading_sections docs have low confidence (<70%) — may need manual strategy override`);
  push(`- **Recommendation:** Use per-document strategy from \`recommendedChunkStrategy\` field; dominant is **${dominantChunk}**.`);
  push(`- **Confidence:** ${lowConfChunk === 0 ? "HIGH" : "MEDIUM"}`);
  push("");

  // DEC-OCR: OCR requirements
  const fullOcr = parsed.filter((d) => (d.scannedPageRatio ?? 0) > 0.5).length;
  const partialOcr = parsed.filter((d) => { const r = d.scannedPageRatio ?? 0; return r > 0.1 && r <= 0.5; }).length;
  const ocrConfidence = pdfs.length > 0 ? "MEDIUM" : "HIGH";
  push("### DEC-OCR: OCR Pre-processing");
  push(`- ${pdfs.length} PDFs total: ${fullOcr} need full OCR, ${partialOcr} need partial OCR`);
  push(`- **Recommendation:** ${fullOcr > 0 ? `Apply OCR to ${fullOcr} fully-scanned PDF(s) before ingestion.` : partialOcr > 0 ? `Apply OCR to ${partialOcr} partially-scanned PDF(s).` : "No OCR pre-processing required for this corpus."}`);
  push(`- **Confidence:** ${ocrConfidence}`);
  push("");

  // DEC-DEDUP: Deduplication strategy
  const highPairs = state.versionPairs.filter((p) => p.confidence === "HIGH").length;
  const chains = state.versionChains.length;
  push("### DEC-DEDUP: Deduplication and Version Handling");
  push(`- ${highPairs} HIGH confidence version pairs, ${chains} version chain(s) detected`);
  push(`- **Recommendation:** ${highPairs > 0 ? `Implement version-aware deduplication — index ONLY the latest doc per chain (${chains} chains). Older versions stored as archives.` : "No version pairs detected — deduplication not critical, but implement as precaution."}`);
  push(`- **Confidence:** ${highPairs > 0 ? "MEDIUM — thresholds uncalibrated, manual verification recommended" : "LOW — no training data"}`);
  push("");

  // DEC-EMBED: Embedding strategy
  const langMix = parsed.filter((d) => d.language !== "deu" && d.language !== "und").length;
  const sectionEmbedEnabled = CONFIG.sectionEmbeddingsEnabled;
  const hasSectionEmbeds = state.fingerprints.some((f) => f.sectionEmbeddings && f.sectionEmbeddings.length > 0);
  push("### DEC-EMBED: Embedding Strategy");
  push(`- ${langMix} non-German documents (${(langMix / Math.max(parsed.length, 1) * 100).toFixed(0)}% of corpus)`);
  push(`- Section embeddings: ${hasSectionEmbeds ? "enabled and computed" : sectionEmbedEnabled ? "enabled but not computed" : "disabled (set SECTION_EMBEDDINGS=1 to enable)"}`);
  push(`- **Recommendation:** Use **BGE-M3** (multilingual, 1024-dim) for ${langMix > 0 ? "multilingual corpus" : "German corpus"}. ${hasSectionEmbeds ? "Section-level embeddings available for fine-grained retrieval." : "Enable SECTION_EMBEDDINGS=1 for section-level retrieval granularity."}`);
  push(`- **Confidence:** HIGH`);
  push("");

  // DEC-METADATA: Metadata reliability for filtering
  const reliableDocs = parsed.filter((d) => d.requirementMetadataReliable).length;
  const metaCheck = state.consistencyChecks.find((c) => c.checkName === "actionabilityMatrix");
  const metaReliable = metaCheck?.passed ?? false;
  push("### DEC-METADATA: Requirement Metadata for RAG Filtering");
  push(`- ${reliableDocs}/${parsed.length} documents have reliable requirement metadata`);
  push(`- LLM validation: ${state.llmValidation.sampledDocIds.length > 0 ? `delta=${(state.llmValidation.regexVsLlmDelta * 100).toFixed(0)}%` : "not run (Ollama unavailable)"}`);
  push(`- **Recommendation:** ${reliableDocs > 0 ? `Use MUSS/SOLL/KANN as retrieval filter for ${reliableDocs} reliable doc types. Exclude planning/meeting/tracker docs from metadata filtering.` : "Do not use requirement type as retrieval filter — no reliable docs found."}`);
  push(`- **Confidence:** ${metaReliable ? "MEDIUM" : "LOW — resolve consistency check failures first"}`);
  push("");

  // DEC-PARSER: Parser choice
  const officeDocs = parsed.filter((d) => d.parserComparisonResult);
  const majorDiv = officeDocs.filter((d) => d.parserComparisonResult?.divergenceLevel === "major").length;
  const divRate = officeDocs.length > 0 ? majorDiv / officeDocs.length : 0;
  push("### DEC-PARSER: Parser Configuration");
  push(`- ${officeDocs.length} Office files compared: ${majorDiv} major divergence (${(divRate * 100).toFixed(0)}%)`);
  push(`- ${pdfs.length} PDFs parsed via Tika`);
  push(`- **Recommendation:** ${divRate > 0.30 ? "Switch to Tika for ALL document types — officeparser diverges too often." : "Keep officeparser for Office files (acceptable divergence), Tika for PDFs."}`);
  push(`- **Confidence:** ${officeDocs.length >= 5 ? "HIGH" : "LOW — too few Office files for robust estimate"}`);
  push("");

  // DEC-REFS: Reference resolution strategy
  const internalRefs = state.references.filter((r) => ["doc_ref", "chapter_ref", "fikb", "kb_master"].includes(r.type));
  const resolvedRate = internalRefs.length > 0
    ? internalRefs.filter((r) => r.resolutionMethod === "exact" || r.resolutionMethod === "fuzzy").length / internalRefs.length
    : 1;
  const missingFromCorpus = state.references.filter((r) => r.resolutionClassification === "likely_missing_from_corpus").length;
  push("### DEC-REFS: Reference Resolution Strategy");
  push(`- Internal ref resolution rate: ${(resolvedRate * 100).toFixed(0)}% (${internalRefs.length} refs)`);
  if (missingFromCorpus > 0) push(`- ${missingFromCorpus} refs classified likely_missing_from_corpus`);
  push(`- **Recommendation:** ${resolvedRate < 0.40 && internalRefs.length > 0 ? `Corpus is incomplete — ${missingFromCorpus} likely missing documents. Request from client before finalizing RAG knowledge base.` : "Reference graph is reasonably complete. Enable cross-reference navigation in RAG for traceability."}`);
  push(`- **Confidence:** ${internalRefs.length === 0 ? "N/A — no internal refs found" : resolvedRate >= 0.40 ? "MEDIUM" : "LOW"}`);
  push("");
}

// ============================================================
// Markdown human report
// ============================================================
// Max filename length for markdown lines — keeps even multi-filename lines well under the 500-char guard.
const MD_FILENAME_MAX = 80;
const mdFilename = (name: string) => name.length > MD_FILENAME_MAX ? `${name.slice(0, MD_FILENAME_MAX - 1)}…` : name;

function generateMarkdown(state: ScannerState, timestamp: string): string {
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push("# Document Intelligence Scan Report", "");
  push(`**Scan ID:** ${state.scanId}`);
  push(`**Started:** ${state.startedAt.toISOString()}`);
  push(`**Completed:** ${state.completedAt?.toISOString() ?? "incomplete"}`);
  push("");

  // IMP-11: Metadata quality score — prominently placed before executive summary
  const mqScore = computeMetadataQualityScore(state);
  const mqEmoji = mqScore.overall >= 80 ? "✅" : mqScore.overall >= 60 ? "⚠️" : "❌";
  push(`## Data Quality Assessment: ${mqEmoji} ${mqScore.interpretation} (Score: ${mqScore.overall}/100)`, "");
  push(`> **Note:** ${mqScore.interpretation}. This score reflects parse success rate, heading extraction, LLM validation agreement, and OCR coverage. Architecture decisions should account for this quality level.`);
  push("");
  push("| Quality Component | Score |");
  push("|-------------------|-------|");
  push(`| Parse success rate | ${mqScore.components["parseSuccessRate"]}% (weight 30%) |`);
  push(`| Heading extraction confidence | ${mqScore.components["headingExtractionConfidence"]}% (weight 20%) |`);
  push(`| Requirement validation agreement | ${mqScore.components["requirementValidationDelta"]}% (weight 20%) |`);
  push(`| OCR coverage score | ${100 - Number(mqScore.components["ocrWarningRate"])}% (weight 30%) |`);
  push(`| Version pair calibration | ⚠️ ${mqScore.components["versionPairCalibrationStatus"]} — manual review recommended |`);
  push("");

  // Executive summary
  push("## Executive Summary", "");
  push(`| Metric | Value |`);
  push(`|--------|-------|`);
  push(`| Total files found | ${state.files.length} |`);
  push(`| Successfully parsed | ${state.parsed.length} |`);
  push(`| Version pairs detected | ${state.versionPairs.filter(p => p.confidence === "HIGH").length} (HIGH confidence) |`);
  push(`| Version chains | ${state.versionChains.length} |`);
  push(`| References extracted | ${state.references.length} |`);
  push(`| Requirements extracted | ${state.requirements.length} (reliable docs only) |`);
  push(`| Scanned PDFs (OCR needed) | ${state.parsed.filter(d => d.isOcrRequired).length} |`);
  push(`| Critical checks failed | ${state.consistencyChecks.filter(c => !c.passed && c.severity === "CRITICAL").length} |`);
  push("");

  // RAG chunking strategy summary — key output for downstream ingestion
  push("## RAG Chunking Strategy by Document", "");
  const byChunkStrategy = countBy(state.parsed, (d) => d.recommendedChunkStrategy);
  // Compute average confidence per strategy
  const avgConf = (strategy: string): string => {
    const docs = state.parsed.filter((d) => d.recommendedChunkStrategy === strategy);
    if (docs.length === 0) return "—";
    const avg = docs.reduce((s, d) => s + d.chunkStrategyReasoning.confidence, 0) / docs.length;
    return `${(avg * 100).toFixed(0)}%`;
  };
  push("| Strategy | Count | Avg Confidence | Meaning |");
  push("|----------|-------|----------------|---------|");
  if (byChunkStrategy["heading_sections"]) push(`| heading_sections | ${byChunkStrategy["heading_sections"]} | ${avgConf("heading_sections")} | Split by heading hierarchy — use section metadata for retrieval |`);
  if (byChunkStrategy["table_rows"]) push(`| table_rows | ${byChunkStrategy["table_rows"]} | ${avgConf("table_rows")} | Split by row — XLSX/matrix files, each row = one chunk |`);
  if (byChunkStrategy["sliding_window"]) push(`| sliding_window | ${byChunkStrategy["sliding_window"]} | ${avgConf("sliding_window")} | No heading structure — use overlapping windows, no section metadata |`);
  // Flag dual-strategy candidates
  const dualCandidates = state.parsed.filter((d) => d.chunkStrategyReasoning.alternativeConsidered !== undefined);
  if (dualCandidates.length > 0) {
    push("");
    push(`> ⚠️ **${dualCandidates.length} doc(s)** have a competing alternative strategy — consider dual-strategy chunking:`);
    for (const d of dualCandidates.slice(0, 5)) {
      const r = d.chunkStrategyReasoning;
      push(`> - **${mdFilename(d.filename)}**: ${r.recommended} (conf ${(r.confidence * 100).toFixed(0)}%) — alt: ${r.alternativeConsidered}: ${r.alternativeReason ?? ""}`);
    }
    if (dualCandidates.length > 5) push(`> - ...and ${dualCandidates.length - 5} more`);
  }
  push("");
  const unreliableReqDocs = state.parsed.filter(d => !d.requirementMetadataReliable && d.requirementQuality && d.requirementQuality.raw > 0);
  if (unreliableReqDocs.length > 0) {
    const shownUnreliable = unreliableReqDocs.slice(0, 5).map(d => d.filename.slice(0, 60));
    const moreUnreliable = unreliableReqDocs.length > 5 ? ` …+${unreliableReqDocs.length - 5} more` : "";
    push(`> ⚠️ **${unreliableReqDocs.length} document(s)** have requirement-type keywords but are NOT reliable for requirement metadata (wrong doc type). Do not use MUSS/SOLL/KANN as retrieval filter for: ${shownUnreliable.join(", ")}${moreUnreliable}`);
    push("");
  }

  // Document type breakdown
  push("## Document Types", "");
  const byType = countBy(state.parsed, (d) => d.detectedDocType ?? "unknown");
  push("| Type | Count |");
  push("|------|-------|");
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    push(`| ${type} | ${count} |`);
  }
  push("");

  // GAP-07: Corpus freshness profile
  push("## Corpus Freshness Profile", "");
  const currentYear = new Date().getFullYear();
  const byYear: Record<number, number> = {};
  for (const d of state.parsed) {
    const year = new Date(d.dateSignals.bestDate).getFullYear();
    byYear[year] = (byYear[year] ?? 0) + 1;
  }
  const sortedYears = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  if (sortedYears.length > 0) {
    push("| Year | Documents | Source reliability |");
    push("|------|-----------|-------------------|");
    for (const year of sortedYears) {
      const count = byYear[year] ?? 0;
      const staleMark = year <= currentYear - 3 ? " ⚠️ stale" : "";
      push(`| ${year} | ${count} |${staleMark} |`);
    }
    push("");
  }
  const staleCount = state.parsed.filter((d) => new Date(d.dateSignals.bestDate).getFullYear() <= currentYear - 3).length;
  const staleRate = state.parsed.length > 0 ? staleCount / state.parsed.length : 0;
  const internalDateCount = state.parsed.filter((d) => d.dateSignals.documentInternalDate !== undefined).length;
  push(`**Date signal quality:** ${internalDateCount}/${state.parsed.length} docs have document-internal dates (remainder uses ctime fallback).`);
  if (staleRate > 0.30) {
    push(`**Freshness recommendation:** ${(staleRate * 100).toFixed(0)}% of corpus is ≥3 years old — consider implementing time-decay scoring in RAG retrieval to downrank outdated documents.`);
  } else {
    push(`**Freshness:** ${(staleRate * 100).toFixed(0)}% of docs are ≥3 years old — corpus is relatively fresh, time-decay scoring optional.`);
  }
  push("");

  // OEM breakdown
  push("## OEM Distribution", "");
  const byOem = countBy(state.parsed, (d) => d.detectedOem ?? "unknown");
  push("| OEM | Documents |");
  push("|-----|-----------|");
  for (const [oem, count] of Object.entries(byOem).sort((a, b) => b[1] - a[1])) {
    push(`| ${oem} | ${count} |`);
  }
  push("");

  // Folder structure
  push("## Folder Structure Analysis", "");
  const fsi = state.folderStructureInference;
  push(`**Detected pattern:** ${fsi.likelyPattern} (confidence: ${(fsi.confidence * 100).toFixed(0)}%)`);
  if (fsi.customerNames.length > 0) push(`**Detected customers/OEMs:** ${fsi.customerNames.join(", ")}`);
  if (fsi.projectNames.length > 0) push(`**Detected projects:** ${fsi.projectNames.slice(0, 10).join(", ")}`);
  if (fsi.documentCategories.length > 0) push(`**Detected document categories:** ${fsi.documentCategories.join(", ")}`);
  push("");

  // Document category distribution — critical for RAG namespace isolation
  const catFiles = state.files.filter((f) => f.inferredDocumentCategory !== undefined);
  if (catFiles.length > 0) {
    push("## Document Category Distribution", "");
    push("> **RAG critical:** RFQ and quotation documents represent opposite sides of a business transaction.");
    push("> They must be indexed as **separate retrieval namespaces** — never blended without an explicit category filter.");
    push("> Mixing RFQ (OEM requirements) with quotations (supplier responses) produces contradictory retrieval results.");
    push("");

    // Per-project breakdown
    const allProjects = [...new Set(state.files.map((f) => f.inferredProject ?? "unknown"))].sort();
    const hasCategoryData = allProjects.some((proj) =>
      state.files.some((f) => f.inferredProject === proj && f.inferredDocumentCategory)
    );
    if (hasCategoryData) {
      push("| Project | RFQ | Quotation | Uncategorized | Total |");
      push("|---------|-----|-----------|---------------|-------|");
      for (const proj of allProjects) {
        const projFiles = state.files.filter((f) => f.inferredProject === proj);
        const rfqCount = projFiles.filter((f) => f.inferredDocumentCategory === "rfq").length;
        const quotCount = projFiles.filter((f) => f.inferredDocumentCategory === "quotation").length;
        const uncatCount = projFiles.filter((f) => f.inferredDocumentCategory === undefined).length;
        push(`| ${proj} | ${rfqCount} | ${quotCount} | ${uncatCount} | ${projFiles.length} |`);
      }
      push("");
    }

    const rfqTotal = state.files.filter((f) => f.inferredDocumentCategory === "rfq").length;
    const quotTotal = state.files.filter((f) => f.inferredDocumentCategory === "quotation").length;
    const uncatTotal = state.files.filter((f) => f.inferredDocumentCategory === undefined).length;
    push(`**Totals:** ${rfqTotal} RFQ, ${quotTotal} quotation, ${uncatTotal} uncategorized`);
    if (uncatTotal > 0) {
      push(`> ⚠️ **${uncatTotal} uncategorized files** — these did not match any known category folder pattern.`);
      push(`> Check folder names: RFQ folders should match \`rfq\`, quotation folders should match \`quotation(s)\` or \`Angebot(e)\`.`);
    }
    push("");
  }

  // Version chains
  push("## Version Chains Detected", "");
  if (state.versionChains.length === 0) {
    push("No version chains detected.");
  } else {
    for (const chain of state.versionChains) {
      const docNames = chain.map((id) => mdFilename(state.parsed.find((d) => d.id === id)?.filename ?? id));
      push(`- ${docNames.join(" → ")}`);
    }
  }
  push("");

  // High confidence version pairs
  const highPairs = state.versionPairs.filter(p => p.confidence === "HIGH");
  if (highPairs.length > 0) {
    push("### HIGH Confidence Version Pairs", "");
    push("| Doc A | Doc B | Score | Newer | Flag |");
    push("|-------|-------|-------|-------|------|");
    for (const pair of highPairs.slice(0, 20)) {
      const docA = mdFilename(state.parsed.find(d => d.id === pair.docA)?.filename ?? pair.docA);
      const docB = mdFilename(state.parsed.find(d => d.id === pair.docB)?.filename ?? pair.docB);
      const flag = pair.versionPairFlag === "template_reuse_suspected" ? "⚠️ template reuse" : "";
      push(`| ${docA} | ${docB} | ${pair.score}/12 | ${pair.likelyNewer} | ${flag} |`);
    }
    push("");
  }

  // IMP-13: Score distribution histogram
  push("### Version Pair Score Distribution", "");
  const histogram = buildScoreHistogram(state.versionPairs);
  const totalPairs = state.versionPairs.length;
  push("| Score Range | Count | % | Threshold |");
  push("|-------------|-------|---|-----------|");
  push(`| 10–12 | ${histogram["10-12"]} | ${totalPairs > 0 ? ((histogram["10-12"]! / totalPairs) * 100).toFixed(0) : 0}% | |`);
  push(`| 7–9 | ${histogram["7-9"]} | ${totalPairs > 0 ? ((histogram["7-9"]! / totalPairs) * 100).toFixed(0) : 0}% | ← HIGH threshold |`);
  push(`| 5–6 | ${histogram["5-6"]} | ${totalPairs > 0 ? ((histogram["5-6"]! / totalPairs) * 100).toFixed(0) : 0}% | ← MEDIUM threshold |`);
  push(`| 3–4 | ${histogram["3-4"]} | ${totalPairs > 0 ? ((histogram["3-4"]! / totalPairs) * 100).toFixed(0) : 0}% | ← LOW threshold |`);
  push(`| 0–2 | ${histogram["0-2"]} | ${totalPairs > 0 ? ((histogram["0-2"]! / totalPairs) * 100).toFixed(0) : 0}% | |`);
  push("");
  push("> ⚠️ **Note:** Thresholds (≥7 HIGH, ≥5 MEDIUM, ≥3 LOW) are **uncalibrated**. Recommend manual review of 5 HIGH pairs and 5 MEDIUM pairs before using version metadata in RAG.");
  push("");

  // Reference graph summary
  push("## Reference Graph Summary", "");
  const normRefs = state.references.filter(r => ["iso_norm","din_norm","en_norm","vda_norm","iatf_norm"].includes(r.type));
  const normCounts = countBy(normRefs, (r) => r.normalized ?? r.rawText);
  const topNorms = Object.entries(normCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topNorms.length > 0) {
    push("### Most Referenced Norms", "");
    push("| Norm | References |");
    push("|------|------------|");
    for (const [norm, count] of topNorms) {
      push(`| ${norm} | ${count} |`);
    }
    push("");
  }

  const internalRefs = state.references.filter(r => ["doc_ref", "chapter_ref", "fikb", "kb_master"].includes(r.type));
  const externalNormRefs = state.references.filter(r => r.resolutionMethod === "external_norm").length;
  const unresolvedInternal = internalRefs.filter(r => r.resolutionMethod === "unresolved").length;
  const resolvedInternal = internalRefs.length - unresolvedInternal;
  const intResRate = internalRefs.length > 0 ? resolvedInternal / internalRefs.length : 1;
  push(`**Internal reference resolution rate:** ${(intResRate * 100).toFixed(0)}% (${resolvedInternal}/${internalRefs.length} internal refs resolved)`);
  push(`**External norm references:** ${externalNormRefs} (ISO/VDA/DIN/EN/IATF — not expected to resolve to corpus docs)`);
  push("");

  // Requirement statistics
  push("## Requirement Statistics", "");
  const byReqType = countBy(state.requirements, (r) => r.type);
  const byCategory = countBy(state.requirements, (r) => r.category);
  const safetyCount = state.requirements.filter(r => r.isSafetyRelevant).length;

  push("### By Type", "");
  push("| Type | Count |");
  push("|------|-------|");
  for (const [type, count] of Object.entries(byReqType).sort((a, b) => b[1] - a[1])) {
    push(`| ${type} | ${count} |`);
  }
  push("");

  push("### By Category", "");
  push("| Category | Count |");
  push("|----------|-------|");
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    push(`| ${cat} | ${count} |`);
  }
  push(`\n**Safety-flagged requirements:** ${safetyCount}`, "");

  if (state.llmValidation.sampledDocIds.length > 0) {
    const delta = state.llmValidation.regexVsLlmDelta;
    push("### LLM Validation Results", "");
    push(`- Sample size: ${state.llmValidation.sampledDocIds.length} documents (stratified by doc type)`);
    push(`- Regex vs LLM delta: ${(delta * 100).toFixed(1)}%`);
    push(`- Confidence interval: [${(state.llmValidation.confidenceInterval.lower * 100).toFixed(1)}%, ${(state.llmValidation.confidenceInterval.upper * 100).toFixed(1)}%]`);
    if (state.llmValidation.byDocumentType && Object.keys(state.llmValidation.byDocumentType).length > 0) {
      push("");
      push("| Document Type | Sampled | Delta | Reliability |");
      push("|---------------|---------|-------|-------------|");
      for (const [type, stats] of Object.entries(state.llmValidation.byDocumentType)) {
        const reliability = stats.avgDelta > 0.25 ? "⚠️ unreliable for RAG metadata" : "✅ reliable";
        push(`| ${type} | ${stats.sampled} | ${(stats.avgDelta * 100).toFixed(0)}% | ${reliability} |`);
      }
    }
    push("");
  }

  // IMP-12: Per-document-type metric breakdown
  push("## Per Document Type Breakdown", "");
  const allDocTypes = [...new Set(state.parsed.map(d => d.detectedDocType ?? "unknown"))].sort();
  for (const docType of allDocTypes) {
    const typeDocs = state.parsed.filter(d => (d.detectedDocType ?? "unknown") === docType);
    const avgPages = typeDocs.reduce((s, d) => s + (d.pageCount ?? 0), 0) / typeDocs.length;
    const avgReqs = typeDocs.reduce((s, d) => s + (d.requirementQuality?.confirmed ?? 0), 0) / typeDocs.length;
    const langDE = typeDocs.filter(d => d.language === "deu").length / typeDocs.length;
    const scannedOrHybrid = typeDocs.filter(d => d.pdfClassification === "fully_scanned" || d.pdfClassification === "hybrid").length;
    const scannedTypeFrac = typeDocs.length > 0 ? scannedOrHybrid / typeDocs.length : 0;
    const headingConf = typeDocs.filter(d => d.headings.length > 0).length / typeDocs.length;

    push(`### ${docType} (${typeDocs.length} docs)`, "");
    push(`- Avg pages: ${avgPages.toFixed(0)}, avg confirmed requirements: ${avgReqs.toFixed(0)}, language: ${(langDE * 100).toFixed(0)}% DE`);
    push(`- Heading extraction coverage: ${(headingConf * 100).toFixed(0)}%${headingConf < 0.7 ? " ⚠️ — manual formatting suspected" : ""}`);
    push(`- Scanned/hybrid rate: ${(scannedTypeFrac * 100).toFixed(0)}%${scannedTypeFrac > 0.2 ? " ⚠️ — OCR pre-processing needed" : ""}`);

    // Chunk strategy distribution for this type
    const chunkStrategyCounts = countBy(typeDocs, (d) => d.recommendedChunkStrategy);
    const dominantStrategy = Object.entries(chunkStrategyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "sliding_window";
    const reqReliable = typeDocs.filter(d => d.requirementMetadataReliable).length;
    push(`- Chunk strategy: **${dominantStrategy}**, requirement metadata reliable: ${reqReliable}/${typeDocs.length} docs`);

    // RAG recommendation per type
    const needsOcr = scannedTypeFrac > 0.2;
    const poorHeadings = headingConf < 0.7;
    const highAvgReqs = avgReqs > 5;
    const reqMeta = reqReliable > 0 ? "✅ Use MUSS/SOLL as retrieval filter" : "❌ Do not use requirement type as filter";
    if (needsOcr || poorHeadings) {
      push(`- **RAG recommendation:** ${needsOcr ? "OCR pre-processing required. " : ""}${poorHeadings ? "Heading metadata unreliable. " : ""}Chunk strategy: ${dominantStrategy}. ${reqMeta}.`);
    } else {
      push(`- **RAG recommendation:** Chunk strategy: ${dominantStrategy}. ${reqMeta}.`);
    }
    push("");
  }

  // Consistency checks
  push("## Consistency Check Results", "");
  push("| Check | Status | Value | Severity | Notes |");
  push("|-------|--------|-------|----------|-------|");
  for (const c of state.consistencyChecks) {
    const status = c.passed ? "PASS" : "FAIL";
    const valueStr = typeof c.value === "number" ? c.value.toFixed(3) : String(c.value);
    const interp = c.interpretation.slice(0, 80);
    push(`| ${c.checkName} | ${status} | ${valueStr} | ${c.severity} | ${interp} |`);
  }
  push("");

  // Parser evaluation
  push("## Parser Evaluation (officeparser vs Tika)", "");
  const officeDocs = state.parsed.filter(d => d.parserComparisonResult);
  if (officeDocs.length > 0) {
    const majorDivergence = officeDocs.filter(d => d.parserComparisonResult?.divergenceLevel === "major").length;
    const minorDivergence = officeDocs.filter(d => d.parserComparisonResult?.divergenceLevel === "minor").length;
    push(`- Office files compared: ${officeDocs.length}`);
    push(`- Major divergence (>20% char delta): ${majorDivergence}`);
    push(`- Minor divergence (5-20%): ${minorDivergence}`);
    push(`- No divergence: ${officeDocs.length - majorDivergence - minorDivergence}`);
    push("");
    push("**Recommendation:** " + (majorDivergence / officeDocs.length > 0.30
      ? "Use Tika as primary parser for all document types — officeparser diverges too often."
      : "officeparser is reliable for this corpus. Tika recommended as fallback for PDFs."));
  } else {
    push("No Office file comparison data available.");
  }
  push("");

  // RAG pipeline recommendations
  push("## RAG Pipeline Recommendations", "");
  const scannedRate = state.parsed.filter(d => d.isScannedPdf).length / Math.max(state.parsed.filter(d => d.extension === ".pdf").length, 1);
  const divergenceRate = officeDocs.length > 0 ? officeDocs.filter(d => d.parserComparisonResult?.divergenceLevel === "major").length / officeDocs.length : 0;
  const langMix = state.parsed.filter(d => d.language !== "deu" && d.language !== "und").length / Math.max(state.parsed.length, 1);

  const recommendations: string[] = [];
  if (scannedRate > 0.20) recommendations.push(`**OCR REQUIRED:** ${(scannedRate * 100).toFixed(0)}% of PDFs are scanned. Invest in OCR preprocessing (e.g., Tesseract or commercial OCR) before RAG ingestion.`);
  if (divergenceRate > 0.30) recommendations.push(`**Parser change:** Use Tika for ALL document types — officeparser diverges in ${(divergenceRate * 100).toFixed(0)}% of Office files.`);
  if (intResRate < 0.40 && internalRefs.length > 0) recommendations.push(`**Incomplete corpus:** Only ${(intResRate * 100).toFixed(0)}% of internal references resolve to corpus documents. Request additional documents from client.`);
  if (langMix > 0.30) recommendations.push(`**Bilingual processing:** ${(langMix * 100).toFixed(0)}% non-German documents detected. Implement language-aware chunking in RAG pipeline.`);
  if (state.versionChains.length > 0) recommendations.push(`**Version-aware retrieval:** ${state.versionChains.length} version chain(s) detected. Implement version-aware ranking so newer documents take precedence.`);
  const staleDocCount = state.parsed.filter((d) => new Date(d.dateSignals.bestDate).getFullYear() <= new Date().getFullYear() - 3).length;
  const staleRatePct = state.parsed.length > 0 ? (staleDocCount / state.parsed.length) * 100 : 0;
  if (staleRatePct > 30) recommendations.push(`**Time-decay scoring:** ${staleRatePct.toFixed(0)}% of corpus is ≥3 years old. Add time-decay to retrieval scoring to downrank stale documents.`);
  if (safetyCount > 0) recommendations.push(`**Safety review:** ${safetyCount} safety-flagged requirements identified. These must be human-reviewed before any automated compliance decisions.`);
  if (recommendations.length === 0) recommendations.push("Corpus looks clean. Standard RAG pipeline should work well.");

  for (const rec of recommendations) push(`- ${rec}`);
  push("");

  // GAP-05: RAG Architecture Decisions
  push("## RAG Architecture Decisions", "");
  push("> Evidence-based decisions derived from scan signals. Each decision includes evidence, recommendation, and confidence.");
  push("");
  generateDecisions(state, push);

  // Flagged items
  push("## Items Requiring Manual Review", "");

  // IMP-02: Parse failures block
  const parseFailed = state.parsed.filter(d => !d.parseSuccess);
  if (parseFailed.length > 0) {
    push(`**Parse failures (${parseFailed.length} files — likely password-protected or corrupt):**`);
    for (const d of parseFailed.slice(0, 20)) {
      push(`- ${d.path} (${d.parseFailureReason ?? "empty_extraction"})`);
    }
    if (parseFailed.length > 20) push(`- ... and ${parseFailed.length - 20} more`);
    push("");
  }

  // GAP-02: tiered OCR breakdown using scannedPageRatio
  const fullOcrDocs = state.parsed.filter(d => (d.scannedPageRatio ?? 0) > 0.5);
  const partialOcrDocs = state.parsed.filter(d => { const r = d.scannedPageRatio ?? 0; return r > 0.1 && r <= 0.5; });
  if (fullOcrDocs.length > 0) {
    push(`**Full OCR required (>50% pages scanned — ${fullOcrDocs.length} docs):**`);
    for (const d of fullOcrDocs.slice(0, 10)) {
      const ratio = ((d.scannedPageRatio ?? 0) * 100).toFixed(0);
      push(`- ${mdFilename(d.filename)} (${ratio}% scanned)`);
    }
    if (fullOcrDocs.length > 10) push(`- ...and ${fullOcrDocs.length - 10} more`);
    push("");
  }
  if (partialOcrDocs.length > 0) {
    push(`**Partial OCR needed (10–50% pages scanned — ${partialOcrDocs.length} docs):**`);
    for (const d of partialOcrDocs.slice(0, 10)) {
      const ratio = ((d.scannedPageRatio ?? 0) * 100).toFixed(0);
      const pages = d.scannedPageIndices ? `pages: ${d.scannedPageIndices.slice(0, 5).join(", ")}${d.scannedPageIndices.length > 5 ? ` +${d.scannedPageIndices.length - 5} more` : ""}` : "page indices unavailable";
      push(`- ${mdFilename(d.filename)} (${ratio}% scanned — ${pages})`);
    }
    if (partialOcrDocs.length > 10) push(`- ...and ${partialOcrDocs.length - 10} more`);
    push("");
  }

  const critFailed = state.consistencyChecks.filter(c => !c.passed && c.severity === "CRITICAL");
  if (critFailed.length > 0) {
    push("**Critical checks failed:**");
    for (const c of critFailed) push(`- ${c.checkName}: ${c.interpretation}`);
  }
  const templateReusePairs = state.versionPairs.filter(p => p.versionPairFlag === "template_reuse_suspected" && p.confidence !== "NOT_A_PAIR");
  if (templateReusePairs.length > 0) {
    push(`\n**Template reuse suspected (${templateReusePairs.length} pairs — manual review required):**`);
    for (const pair of templateReusePairs.slice(0, 10)) {
      const docA = mdFilename(state.parsed.find(d => d.id === pair.docA)?.filename ?? pair.docA);
      const docB = mdFilename(state.parsed.find(d => d.id === pair.docB)?.filename ?? pair.docB);
      push(`- ${docA} ↔ ${docB} (score ${pair.score}/12, ${pair.confidence})`);
    }
  }
  if (parseFailed.length === 0 && fullOcrDocs.length === 0 && partialOcrDocs.length === 0 && critFailed.length === 0 && templateReusePairs.length === 0) {
    push("No critical items flagged.");
  }
  push("");

  return lines.join("\n");
}

export async function runReport(state: ScannerState, ollamaAvailable = false): Promise<void> {
  const t = logger.phaseStart("8-report");
  state.completedAt = new Date();

  const timestamp = state.startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  mkdirSync(CONFIG.reportOutput, { recursive: true });

  const jsonPath = join(CONFIG.reportOutput, `scan-report-${timestamp}.json`);
  const mdPath = join(CONFIG.reportOutput, `scan-report-${timestamp}-human.md`);

  // Serialize state
  const serialized = serializeState(state);

  // CRITICAL: hard content-leak guard
  try {
    sanitizeReport(serialized);
  } catch (e) {
    logger.error("Content leak guard TRIGGERED — aborting report write", { error: String(e) });
    throw e;
  }

  // Write JSON
  await writeFileAsync(jsonPath, JSON.stringify(serialized, null, 2), "utf-8");
  logger.info("JSON report written", { path: jsonPath });

  // Write Markdown
  const markdown = generateMarkdown(state, timestamp);
  // FINDING-005: Content-leak guard for markdown — individual lines must not exceed 500 chars.
  // (Prose lines in this report are < 300 chars; >500 indicates state-derived content leak.)
  const longLine = markdown.split("\n").find((l) => l.length > 500);
  if (longLine !== undefined) {
    logger.error("Content leak guard triggered in markdown output", { lineLength: longLine.length, lineStart: longLine.slice(0, 40) });
    throw new Error(`Markdown content-leak guard: line length ${longLine.length} > 500`);
  }
  await writeFileAsync(mdPath, markdown, "utf-8");
  logger.info("Markdown report written", { path: mdPath });

  logger.phaseEnd("8-report", t, { jsonPath, mdPath });

  // Narrative report (additive — does not affect JSON/human.md output)
  try {
    await runNarrative(state, ollamaAvailable, timestamp);
  } catch (e) {
    logger.warn("Narrative report generation failed — skipping", { error: String(e) });
  }
}
