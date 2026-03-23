import { writeFile } from "fs";
import { join } from "path";
import { promisify } from "util";
import type { ScannerState } from "../state.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { complete } from "../llm/ollama.ts";
import {
  narrativeCorpusOverviewPrompt,
  narrativeVersionPairPrompt,
  narrativeRequirementQualityPrompt,
  narrativeChunkStrategyPrompt,
  narrativeParserReliabilityPrompt,
  narrativeReferenceGraphPrompt,
  narrativeRagSynthesisPrompt,
} from "../llm/prompts.ts";

const writeFileAsync = promisify(writeFile);

// ============================================================
// Content-safe input types (module-private)
// Content-safety rule: ONLY scores, counts, booleans, enum strings,
// filenames ≤50 chars, and pre-clamped interpretation strings.
// NEVER: heading text, requirement text, rawText from references.
// ============================================================

interface CorpusOverviewInput {
  totalFiles: number;
  parsedFiles: number;
  parseFailures: number;
  byDocType: Record<string, number>;
  byLanguage: Record<string, number>;
  byOem: Record<string, number>;
  scannedPdfCount: number;
  hybridPdfCount: number;
  metadataQualityScore: number;
  folderPattern: string;
  folderConfidence: number;
  staleDocCount: number;
  internalDateCount: number;
}

interface VersionPairEntry {
  docA: string;
  docB: string;
  score: number;
  confidence: string;
  likelyNewer: string;
  versionPairFlag?: string;
  signals: {
    filenameNormalizedSimilarity: number;
    structuralMatch: boolean;
    headingMinHashJaccard: number;
    semanticCosineSimilarity: number;
    sameDirectory: boolean;
    modifiedDateDeltaDays: number;
  };
  dateSourceA: string;
  dateSourceB: string;
  mtimeReliableA: boolean;
  mtimeReliableB: boolean;
}

interface VersionPairInput {
  totalPairs: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  topPairs: VersionPairEntry[];
  hasSemantic: boolean;
  uncalibratedWarning: true;
}

interface RequirementQualityInput {
  totalRequirements: number;
  byType: Record<string, number>;
  safetyFlaggedCount: number;
  llmValidationRan: boolean;
  regexVsLlmDelta: number;
  confidenceInterval: { lower: number; upper: number };
  byDocumentType: Record<string, { sampled: number; avgDelta: number }>;
  llmRecoveredCount: number;
  llmRejectedCount: number;
  highUncertaintyDocs: Array<{
    filename: string;
    docType: string;
    confirmed: number;
    uncertain: number;
    negated: number;
    raw: number;
  }>;
  reliableDocCount: number;
}

interface ChunkStrategyDocEntry {
  filename: string;
  docType: string;
  strategy: string;
  confidence: number;
  headingCount: number;
  headingDepth: number;
  tableCount: number;
  hasNestedHeadings: boolean;
  pdfClassification: string;
  alternativeConsidered?: string;
  alternativeReason?: string;
}

interface ChunkStrategyInput {
  byCounts: Record<string, number>;
  avgConfidenceByStrategy: Record<string, number>;
  lowConfidenceDocs: ChunkStrategyDocEntry[];
  dualStrategyDocs: ChunkStrategyDocEntry[];
  totalDocs: number;
}

interface ParserReliabilityInput {
  totalOfficeDocs: number;
  majorDivergenceCount: number;
  divergenceRate: number;
  totalPdfs: number;
  fullOcrCount: number;
  partialOcrCount: number;
  parseFailures: Array<{ filename: string; reason: string }>;
  majorDivergenceDocs: Array<{
    filename: string;
    divergenceLevel: string;
    charDeltaPercent: number;
    isOcrRequired: boolean;
    pdfClassification: string;
    scannedPageRatio: number;
  }>;
}

interface ReferenceGraphInput {
  totalRefs: number;
  byType: Record<string, number>;
  resolvedInternal: number;
  unresolvedInternal: number;
  resolutionRate: number;
  externalNormCount: number;
  missingFromCorpusCount: number;
  matcherFailureCount: number;
  topNorms: Array<{ norm: string; count: number }>;
  unresolvedDocs: Array<{ filename: string; unresolvedCount: number }>;
}

interface RagSynthesisInput {
  metadataQualityScore: number;
  parseSuccessRate: number;
  hasVersionPairs: boolean;
  highVersionPairCount: number;
  dominantChunkStrategy: string;
  lowConfidenceChunkCount: number;
  ocrRequired: boolean;
  fullOcrCount: number;
  languageMixRate: number;
  internalRefResolutionRate: number;
  missingFromCorpusCount: number;
  staleDocRate: number;
  criticalChecksFailed: number;
  warningChecksFailed: number;
  isActionable: boolean;
  failedCheckInterpretations: string[];
  ollamaWasUsed: boolean;
}

// ============================================================
// Helpers
// ============================================================

function safeFilename(filename: string): string {
  return filename.slice(0, 50);
}

function sectionPlaceholder(reason: string): string {
  return `> **Narrative unavailable:** ${reason}\n> Run with Ollama available to generate interpretive analysis.`;
}

// Inline metadata quality score computation
// Mirrors computeMetadataQualityScore() in 8-report.ts — NOT extracted to shared util
// (keeps this change purely additive with no modifications to 8-report.ts logic)
function computeInlineMetadataScore(state: ScannerState): number {
  const totalParsed = state.parsed.length;
  const successRate = totalParsed > 0
    ? state.parsed.filter((d) => d.parseSuccess).length / totalParsed
    : 1;
  const withHeadings = state.parsed.filter((d) => d.headings.length > 0).length;
  const headingConf = totalParsed > 0 ? withHeadings / totalParsed : 1;
  // P2: require >= 3 sampled docs for meaningful delta
  const reqDelta = state.llmValidation.sampledDocIds.length >= 3
    ? 1 - Math.min(state.llmValidation.regexVsLlmDelta, 1)
    : 0.5;
  const pdfs = state.parsed.filter((d) => d.extension === ".pdf");
  const ocrIssues = pdfs.filter(
    (d) => d.pdfClassification === "fully_scanned" || d.pdfClassification === "hybrid"
  ).length;
  const ocrScore = 1 - (pdfs.length > 0 ? ocrIssues / pdfs.length : 0);
  return Math.round(successRate * 30 + headingConf * 20 + reqDelta * 20 + ocrScore * 30);
}

// ============================================================
// Input builder functions (pure, no async, content-safe)
// ============================================================

function buildCorpusOverviewInput(state: ScannerState): CorpusOverviewInput {
  const byDocType: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  const byOem: Record<string, number> = {};
  for (const d of state.parsed) {
    const dt = d.detectedDocType ?? "unknown";
    byDocType[dt] = (byDocType[dt] ?? 0) + 1;
    byLanguage[d.language] = (byLanguage[d.language] ?? 0) + 1;
    const oem = d.detectedOem ?? "unknown";
    byOem[oem] = (byOem[oem] ?? 0) + 1;
  }

  const currentYear = new Date().getFullYear();
  const staleDocCount = state.parsed.filter(
    (d) => new Date(d.dateSignals.bestDate).getFullYear() <= currentYear - 3
  ).length;
  const internalDateCount = state.parsed.filter(
    (d) => d.dateSignals.documentInternalDate !== undefined
  ).length;

  return {
    totalFiles: state.files.length,
    parsedFiles: state.parsed.length,
    parseFailures: state.parsed.filter((d) => !d.parseSuccess).length,
    byDocType,
    byLanguage,
    byOem,
    scannedPdfCount: state.parsed.filter((d) => d.pdfClassification === "fully_scanned").length,
    hybridPdfCount: state.parsed.filter((d) => d.pdfClassification === "hybrid").length,
    metadataQualityScore: computeInlineMetadataScore(state),
    folderPattern: state.folderStructureInference.likelyPattern,
    folderConfidence: state.folderStructureInference.confidence,
    staleDocCount,
    internalDateCount,
  };
}

function buildVersionPairInput(state: ScannerState): VersionPairInput {
  const highCount = state.versionPairs.filter((p) => p.confidence === "HIGH").length;
  const mediumCount = state.versionPairs.filter((p) => p.confidence === "MEDIUM").length;
  const lowCount = state.versionPairs.filter((p) => p.confidence === "LOW").length;

  const topPairs: VersionPairEntry[] = state.versionPairs
    .filter((p) => p.confidence === "HIGH" || p.confidence === "MEDIUM")
    .slice(0, 5)
    .map((pair) => {
      const docADoc = state.parsed.find((d) => d.id === pair.docA);
      const docBDoc = state.parsed.find((d) => d.id === pair.docB);

      const dateSourceA = docADoc
        ? (docADoc.dateSignals.internalDateSource ??
          (docADoc.dateSignals.mtimeReliable ? "mtime" : "ctime_fallback"))
        : "unknown";
      const dateSourceB = docBDoc
        ? (docBDoc.dateSignals.internalDateSource ??
          (docBDoc.dateSignals.mtimeReliable ? "mtime" : "ctime_fallback"))
        : "unknown";

      return {
        docA: safeFilename(docADoc?.filename ?? pair.docA),
        docB: safeFilename(docBDoc?.filename ?? pair.docB),
        score: pair.score,
        confidence: pair.confidence,
        likelyNewer: pair.likelyNewer,
        signals: { ...pair.signals },
        dateSourceA,
        dateSourceB,
        mtimeReliableA: docADoc?.dateSignals.mtimeReliable ?? false,
        mtimeReliableB: docBDoc?.dateSignals.mtimeReliable ?? false,
        ...(pair.versionPairFlag !== undefined ? { versionPairFlag: pair.versionPairFlag } : {}),
      };
    });

  return {
    totalPairs: state.versionPairs.length,
    highCount,
    mediumCount,
    lowCount,
    topPairs,
    hasSemantic: state.versionPairs.some((p) => p.signals.semanticCosineSimilarity > 0),
    uncalibratedWarning: true,
  };
}

function buildRequirementQualityInput(state: ScannerState): RequirementQualityInput {
  const byType: Record<string, number> = {};
  for (const r of state.requirements) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
  }

  const highUncertaintyDocs = state.parsed
    .filter((d) => {
      const q = d.requirementQuality;
      return q !== undefined && q.uncertain > q.confirmed;
    })
    .map((d) => {
      const q = d.requirementQuality!;
      return {
        filename: safeFilename(d.filename),
        docType: d.detectedDocType ?? "unknown",
        confirmed: q.confirmed,
        uncertain: q.uncertain,
        negated: q.negated,
        raw: q.raw,
      };
    });

  return {
    totalRequirements: state.requirements.length,
    byType,
    safetyFlaggedCount: state.requirements.filter((r) => r.isSafetyRelevant).length,
    llmValidationRan: state.llmValidation.sampledDocIds.length >= 3,
    regexVsLlmDelta: state.llmValidation.regexVsLlmDelta,
    confidenceInterval: state.llmValidation.confidenceInterval,
    byDocumentType: state.llmValidation.byDocumentType ?? {},
    llmRecoveredCount: state.llmValidation.llmRecoveredCount ?? 0,
    llmRejectedCount: state.llmValidation.llmRejectedCount ?? 0,
    highUncertaintyDocs,
    reliableDocCount: state.parsed.filter((d) => d.requirementMetadataReliable).length,
  };
}

function buildChunkStrategyInput(state: ScannerState): ChunkStrategyInput {
  const byCounts: Record<string, number> = {};
  const sumConf: Record<string, number> = {};
  for (const d of state.parsed) {
    const s = d.recommendedChunkStrategy;
    byCounts[s] = (byCounts[s] ?? 0) + 1;
    sumConf[s] = (sumConf[s] ?? 0) + d.chunkStrategyReasoning.confidence;
  }

  const avgConfidenceByStrategy: Record<string, number> = {};
  for (const [s, count] of Object.entries(byCounts)) {
    avgConfidenceByStrategy[s] = (sumConf[s] ?? 0) / Math.max(count, 1);
  }

  const toDocEntry = (d: ScannerState["parsed"][number]): ChunkStrategyDocEntry => {
    const r = d.chunkStrategyReasoning;
    return {
      filename: safeFilename(d.filename),
      docType: d.detectedDocType ?? "unknown",
      strategy: d.recommendedChunkStrategy,
      confidence: r.confidence,
      headingCount: r.signals.headingCount,
      headingDepth: r.signals.headingDepth,
      tableCount: r.signals.tableCount,
      hasNestedHeadings: r.signals.hasNestedHeadings,
      pdfClassification: r.signals.pdfClassification,
      ...(r.alternativeConsidered !== undefined
        ? { alternativeConsidered: r.alternativeConsidered }
        : {}),
      ...(r.alternativeReason !== undefined ? { alternativeReason: r.alternativeReason } : {}),
    };
  };

  return {
    byCounts,
    avgConfidenceByStrategy,
    lowConfidenceDocs: state.parsed
      .filter((d) => d.chunkStrategyReasoning.confidence < 0.7)
      .slice(0, 5)
      .map(toDocEntry),
    dualStrategyDocs: state.parsed
      .filter((d) => d.chunkStrategyReasoning.alternativeConsidered !== undefined)
      .slice(0, 5)
      .map(toDocEntry),
    totalDocs: state.parsed.length,
  };
}

function buildParserReliabilityInput(state: ScannerState): ParserReliabilityInput {
  const officeDocs = state.parsed.filter((d) => d.parserComparisonResult !== undefined);
  const majorDivergenceCount = officeDocs.filter(
    (d) => d.parserComparisonResult?.divergenceLevel === "major"
  ).length;

  const parseFailures = state.parsed
    .filter((d) => !d.parseSuccess)
    .slice(0, 5)
    .map((d) => ({
      filename: safeFilename(d.filename),
      reason: d.parseFailureReason ?? "unknown",
    }));

  const majorDivergenceDocs = officeDocs
    .filter((d) => d.parserComparisonResult?.divergenceLevel === "major")
    .slice(0, 5)
    .map((d) => ({
      filename: safeFilename(d.filename),
      divergenceLevel: d.parserComparisonResult!.divergenceLevel,
      charDeltaPercent: d.parserComparisonResult!.charDeltaPercent,
      isOcrRequired: d.isOcrRequired,
      pdfClassification: d.pdfClassification ?? "not_pdf",
      scannedPageRatio: d.scannedPageRatio ?? 0,
    }));

  return {
    totalOfficeDocs: officeDocs.length,
    majorDivergenceCount,
    divergenceRate: majorDivergenceCount / Math.max(officeDocs.length, 1),
    totalPdfs: state.parsed.filter((d) => d.extension === ".pdf").length,
    fullOcrCount: state.parsed.filter((d) => (d.scannedPageRatio ?? 0) > 0.5).length,
    partialOcrCount: state.parsed.filter((d) => {
      const r = d.scannedPageRatio ?? 0;
      return r > 0.1 && r <= 0.5;
    }).length,
    parseFailures,
    majorDivergenceDocs,
  };
}

function buildReferenceGraphInput(state: ScannerState): ReferenceGraphInput {
  const byType: Record<string, number> = {};
  for (const r of state.references) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
  }

  const internalRefs = state.references.filter((r) =>
    ["doc_ref", "chapter_ref", "fikb", "kb_master"].includes(r.type)
  );
  const unresolvedInternal = internalRefs.filter(
    (r) => r.resolutionMethod === "unresolved"
  ).length;
  const resolvedInternal = internalRefs.length - unresolvedInternal;

  const normRefs = state.references.filter((r) =>
    ["iso_norm", "din_norm", "en_norm", "vda_norm", "iatf_norm"].includes(r.type)
  );
  const normCounts: Record<string, number> = {};
  for (const r of normRefs) {
    const key = r.normalized ?? r.rawText; // rawText for norms is short regex-captured string
    normCounts[key] = (normCounts[key] ?? 0) + 1;
  }
  const topNorms = Object.entries(normCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([norm, count]) => ({ norm, count }));

  const unresolvedByDoc: Record<string, number> = {};
  for (const r of internalRefs.filter((r) => r.resolutionMethod === "unresolved")) {
    const doc = state.parsed.find((d) => d.id === r.docId);
    const filename = safeFilename(doc?.filename ?? r.docId);
    unresolvedByDoc[filename] = (unresolvedByDoc[filename] ?? 0) + 1;
  }
  const unresolvedDocs = Object.entries(unresolvedByDoc)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([filename, unresolvedCount]) => ({ filename, unresolvedCount }));

  return {
    totalRefs: state.references.length,
    byType,
    resolvedInternal,
    unresolvedInternal,
    resolutionRate: resolvedInternal / Math.max(internalRefs.length, 1),
    externalNormCount: state.references.filter(
      (r) => r.resolutionMethod === "external_norm"
    ).length,
    missingFromCorpusCount: state.references.filter(
      (r) => r.resolutionClassification === "likely_missing_from_corpus"
    ).length,
    matcherFailureCount: state.references.filter(
      (r) => r.resolutionClassification === "likely_matcher_failure"
    ).length,
    topNorms,
    unresolvedDocs,
  };
}

function buildRagSynthesisInput(
  state: ScannerState,
  ollamaWasUsed: boolean
): RagSynthesisInput {
  const highVersionPairCount = state.versionPairs.filter(
    (p) => p.confidence === "HIGH"
  ).length;

  const chunkCounts: Record<string, number> = {};
  for (const d of state.parsed) {
    chunkCounts[d.recommendedChunkStrategy] =
      (chunkCounts[d.recommendedChunkStrategy] ?? 0) + 1;
  }
  const dominantChunkStrategy =
    Object.entries(chunkCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "heading_sections";

  const fullOcrCount = state.parsed.filter((d) => (d.scannedPageRatio ?? 0) > 0.5).length;

  const langMix = state.parsed.filter(
    (d) => d.language !== "deu" && d.language !== "und"
  ).length;

  const internalRefs = state.references.filter((r) =>
    ["doc_ref", "chapter_ref", "fikb", "kb_master"].includes(r.type)
  );
  const resolvedInternal = internalRefs.filter(
    (r) => r.resolutionMethod === "exact" || r.resolutionMethod === "fuzzy"
  ).length;

  const missingFromCorpusCount = state.references.filter(
    (r) => r.resolutionClassification === "likely_missing_from_corpus"
  ).length;

  const currentYear = new Date().getFullYear();
  const staleCount = state.parsed.filter(
    (d) => new Date(d.dateSignals.bestDate).getFullYear() <= currentYear - 3
  ).length;

  const criticalChecksFailed = state.consistencyChecks.filter(
    (c) => !c.passed && c.severity === "CRITICAL"
  ).length;
  const warningChecksFailed = state.consistencyChecks.filter(
    (c) => !c.passed && c.severity === "WARNING"
  ).length;

  const failedCheckInterpretations = state.consistencyChecks
    .filter((c) => !c.passed)
    .slice(0, 5)
    .map((c) => c.interpretation); // already ≤120 chars from Phase 7 clamp()

  return {
    metadataQualityScore: computeInlineMetadataScore(state),
    parseSuccessRate:
      state.parsed.filter((d) => d.parseSuccess).length /
      Math.max(state.parsed.length, 1),
    hasVersionPairs: state.versionPairs.length > 0,
    highVersionPairCount,
    dominantChunkStrategy,
    lowConfidenceChunkCount: state.parsed.filter(
      (d) => d.chunkStrategyReasoning.confidence < 0.7
    ).length,
    ocrRequired: fullOcrCount > 0,
    fullOcrCount,
    languageMixRate: langMix / Math.max(state.parsed.length, 1),
    internalRefResolutionRate: resolvedInternal / Math.max(internalRefs.length, 1),
    missingFromCorpusCount,
    staleDocRate: staleCount / Math.max(state.parsed.length, 1),
    criticalChecksFailed,
    warningChecksFailed,
    isActionable: criticalChecksFailed > 0 || fullOcrCount > 0 || missingFromCorpusCount > 0,
    failedCheckInterpretations,
    ollamaWasUsed,
  };
}

// ============================================================
// Section generators — each follows the exact same pattern:
// build input → call LLM → strip fences → length check → return
// Any failure → placeholder for that section, rest continues
// ============================================================

async function generateCorpusOverview(state: ScannerState): Promise<string> {
  try {
    const input = buildCorpusOverviewInput(state);
    const prompt = narrativeCorpusOverviewPrompt(input);
    const response = await complete(prompt, { temperature: 0.3, maxTokens: 700 });
    const cleaned = response
      .trim()
      .replace(/^```[a-z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    if (cleaned.length < 100) {
      logger.warn("Narrative section too short", { section: "corpusOverview" });
      return sectionPlaceholder("LLM returned an empty or too-short response.");
    }
    return cleaned;
  } catch (e) {
    logger.warn("Narrative section failed", { section: "corpusOverview", error: String(e) });
    return sectionPlaceholder(`LLM call failed: ${String(e).slice(0, 100)}`);
  }
}

async function generateVersionPairDecomposition(state: ScannerState): Promise<string> {
  try {
    const input = buildVersionPairInput(state);
    const prompt = narrativeVersionPairPrompt(input);
    const response = await complete(prompt, { temperature: 0.3, maxTokens: 700 });
    const cleaned = response
      .trim()
      .replace(/^```[a-z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    if (cleaned.length < 100) {
      logger.warn("Narrative section too short", { section: "versionPairDecomposition" });
      return sectionPlaceholder("LLM returned an empty or too-short response.");
    }
    return cleaned;
  } catch (e) {
    logger.warn("Narrative section failed", {
      section: "versionPairDecomposition",
      error: String(e),
    });
    return sectionPlaceholder(`LLM call failed: ${String(e).slice(0, 100)}`);
  }
}

async function generateRequirementQuality(state: ScannerState): Promise<string> {
  try {
    const input = buildRequirementQualityInput(state);
    const prompt = narrativeRequirementQualityPrompt(input);
    const response = await complete(prompt, { temperature: 0.3, maxTokens: 700 });
    const cleaned = response
      .trim()
      .replace(/^```[a-z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    if (cleaned.length < 100) {
      logger.warn("Narrative section too short", { section: "requirementQuality" });
      return sectionPlaceholder("LLM returned an empty or too-short response.");
    }
    return cleaned;
  } catch (e) {
    logger.warn("Narrative section failed", {
      section: "requirementQuality",
      error: String(e),
    });
    return sectionPlaceholder(`LLM call failed: ${String(e).slice(0, 100)}`);
  }
}

async function generateChunkStrategyRationale(state: ScannerState): Promise<string> {
  try {
    const input = buildChunkStrategyInput(state);
    const prompt = narrativeChunkStrategyPrompt(input);
    const response = await complete(prompt, { temperature: 0.3, maxTokens: 700 });
    const cleaned = response
      .trim()
      .replace(/^```[a-z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    if (cleaned.length < 100) {
      logger.warn("Narrative section too short", { section: "chunkStrategyRationale" });
      return sectionPlaceholder("LLM returned an empty or too-short response.");
    }
    return cleaned;
  } catch (e) {
    logger.warn("Narrative section failed", {
      section: "chunkStrategyRationale",
      error: String(e),
    });
    return sectionPlaceholder(`LLM call failed: ${String(e).slice(0, 100)}`);
  }
}

async function generateParserReliability(state: ScannerState): Promise<string> {
  try {
    const input = buildParserReliabilityInput(state);
    const prompt = narrativeParserReliabilityPrompt(input);
    const response = await complete(prompt, { temperature: 0.3, maxTokens: 700 });
    const cleaned = response
      .trim()
      .replace(/^```[a-z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    if (cleaned.length < 100) {
      logger.warn("Narrative section too short", { section: "parserReliability" });
      return sectionPlaceholder("LLM returned an empty or too-short response.");
    }
    return cleaned;
  } catch (e) {
    logger.warn("Narrative section failed", { section: "parserReliability", error: String(e) });
    return sectionPlaceholder(`LLM call failed: ${String(e).slice(0, 100)}`);
  }
}

async function generateReferenceGraphInterpretation(state: ScannerState): Promise<string> {
  try {
    const input = buildReferenceGraphInput(state);
    const prompt = narrativeReferenceGraphPrompt(input);
    const response = await complete(prompt, { temperature: 0.3, maxTokens: 700 });
    const cleaned = response
      .trim()
      .replace(/^```[a-z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    if (cleaned.length < 100) {
      logger.warn("Narrative section too short", { section: "referenceGraphInterpretation" });
      return sectionPlaceholder("LLM returned an empty or too-short response.");
    }
    return cleaned;
  } catch (e) {
    logger.warn("Narrative section failed", {
      section: "referenceGraphInterpretation",
      error: String(e),
    });
    return sectionPlaceholder(`LLM call failed: ${String(e).slice(0, 100)}`);
  }
}

async function generateRagSynthesis(
  state: ScannerState,
  ollamaWasUsed: boolean
): Promise<string> {
  try {
    const input = buildRagSynthesisInput(state, ollamaWasUsed);
    const prompt = narrativeRagSynthesisPrompt(input);
    const response = await complete(prompt, { temperature: 0.3, maxTokens: 700 });
    const cleaned = response
      .trim()
      .replace(/^```[a-z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    if (cleaned.length < 100) {
      logger.warn("Narrative section too short", { section: "ragSynthesis" });
      return sectionPlaceholder("LLM returned an empty or too-short response.");
    }
    return cleaned;
  } catch (e) {
    logger.warn("Narrative section failed", { section: "ragSynthesis", error: String(e) });
    return sectionPlaceholder(`LLM call failed: ${String(e).slice(0, 100)}`);
  }
}

// ============================================================
// Output file assembly
// ============================================================

const SECTION_TITLES = [
  "Corpus Overview",
  "Version Pair Signal Decomposition",
  "Requirement Extraction Quality",
  "Chunk Strategy Rationale",
  "Parser Reliability",
  "Reference Graph Interpretation",
  "RAG Readiness Synthesis",
] as const;

function buildNarrativeHeader(state: ScannerState, timestamp: string): string[] {
  return [
    "# Document Intelligence Scan — Narrative Report",
    "",
    `**Scan ID:** ${state.scanId}`,
    `**Generated:** ${state.completedAt?.toISOString() ?? "in progress"}`,
    `**Model:** ${CONFIG.ollamaChatModel}`,
    "",
    `> This report provides interpretive context for the metrics in scan-report-${timestamp}.json.`,
    `> All interpretations are model-generated. No document content was passed to the LLM.`,
    "",
    "---",
    "",
  ];
}

// ============================================================
// Exported entry point
// ============================================================

export async function runNarrative(
  state: ScannerState,
  ollamaAvailable: boolean,
  timestamp: string
): Promise<void> {
  const narrativePath = join(
    CONFIG.reportOutput,
    `scan-report-${timestamp}-narrative.md`
  );

  const lines: string[] = buildNarrativeHeader(state, timestamp);

  if (!ollamaAvailable) {
    const placeholder = sectionPlaceholder("Ollama was not available during the scan run.");
    for (const [i, title] of SECTION_TITLES.entries()) {
      lines.push(`## ${i + 1}. ${title}`, "", placeholder, "", "---", "");
    }
    lines.push(
      `*Generated by Huginn using ${CONFIG.ollamaChatModel}. Validate interpretations before architecture decisions.*`
    );
    await writeFileAsync(narrativePath, lines.join("\n"), "utf-8");
    logger.info("Narrative report written (Ollama unavailable — placeholders only)", {
      path: narrativePath,
    });
    return;
  }

  logger.info("Generating narrative report (7 sequential LLM calls)...", {
    path: narrativePath,
  });

  // Sequential — local llama3.1:8b cannot handle concurrent requests
  const sections = [
    await generateCorpusOverview(state),
    await generateVersionPairDecomposition(state),
    await generateRequirementQuality(state),
    await generateChunkStrategyRationale(state),
    await generateParserReliability(state),
    await generateReferenceGraphInterpretation(state),
    await generateRagSynthesis(state, ollamaAvailable),
  ];

  for (const [i, title] of SECTION_TITLES.entries()) {
    lines.push(`## ${i + 1}. ${title}`, "", sections[i] ?? sectionPlaceholder("Section unavailable."), "", "---", "");
  }

  lines.push(
    `*Generated by Huginn using ${CONFIG.ollamaChatModel}.*`
  );

  await writeFileAsync(narrativePath, lines.join("\n"), "utf-8");
  logger.info("Narrative report written", { path: narrativePath });
}
