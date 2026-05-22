// src/phases/3-projection.ts
import type {
  ScannerState,
  ParsedDocument,
  DocumentIngestionProjection,
  DiscoveredBoilerplatePattern,
  CorpusBoilerplateSummary,
  MuninnConfigRecommendation,
  CorpusIngestionSummary,
} from "../state.ts";
import { logger, setPhase } from "../utils/logger.ts";
import { estimateTokens, estimateChunkTokens } from "../utils/token-estimator.ts";
import { cleanContent, classifyBlock, BOILERPLATE_PATTERNS } from "../utils/cleaner.ts";
import { filterChunk } from "../utils/chunk-filter.ts";
import { scoreBlock } from "../utils/quality-scorer.ts";
import { detectDomainSignals, buildDomainProfile, type DomainSignalSample } from "../utils/domain-detector.ts";
import { _lastAccumulator } from "./2-parse.ts";

// ── Accumulator: shared state collected during Phase 2 ─────────────────────

export class ProjectionAccumulator {
  private lineDocMap = new Map<string, Set<string>>(); // normalised line → doc IDs
  private lineCount  = new Map<string, number>();      // normalised line → total occurrences
  private lineTokens = new Map<string, number>();      // normalised line → token cost
  private domainSamples: DomainSignalSample[] = [];

  addLine(raw: string, docId: string): void {
    const key = normaliseLine(raw);
    if (!key || key.length < 4 || key.length > 120) return;
    const docs = this.lineDocMap.get(key) ?? new Set();
    docs.add(docId);
    this.lineDocMap.set(key, docs);
    this.lineCount.set(key, (this.lineCount.get(key) ?? 0) + 1);
    if (!this.lineTokens.has(key)) this.lineTokens.set(key, estimateTokens(raw));
  }

  addDomainSample(sample: DomainSignalSample): void {
    this.domainSamples.push(sample);
  }

  getLineFrequencies(): Map<string, number> {
    return this.lineCount;
  }

  getCandidateLines(minDocs: number): Array<{ key: string; occurrences: number; docCount: number; tokenCost: number }> {
    return [...this.lineDocMap.entries()]
      .filter(([, docs]) => docs.size >= minDocs)
      .map(([key, docs]) => ({
        key,
        occurrences: this.lineCount.get(key) ?? 0,
        docCount: docs.size,
        tokenCost: this.lineTokens.get(key) ?? 0,
      }));
  }

  getDomainSamples(): DomainSignalSample[] {
    return this.domainSamples;
  }
}

function normaliseLine(line: string): string {
  return line.toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\b\d{1,2}[.\s]\d{1,2}[.\s]\d{2,4}\b/g, "DATE")
    .replace(/\b\d+\b/g, "N")
    .trim();
}

// ── 9a: Per-document simulation ────────────────────────────────────────────

export async function projectDocument(
  doc: ParsedDocument,
  acc: ProjectionAccumulator,
): Promise<DocumentIngestionProjection> {
  if (!doc.parseSuccess || !doc.textContent) {
    return emptyProjection(doc.id);
  }

  const text = doc.textContent;

  // 1. Token count at each cleaning stage
  const raw = estimateTokens(text);
  const { cleaned, audit } = cleanContent(text);
  const afterNormalization = Math.max(0, raw - audit.tokensLostNormalization);
  const afterCleaning      = Math.max(0, afterNormalization - audit.tokensLostBoilerplate - audit.tokensLostRepeated);

  // 2. Classify blocks and compute post-chunking token count (with compression)
  const blocks = splitIntoBlocks(cleaned);
  const blockTypeTokens = { prose: 0, header: 0, specValue: 0, tableRow: 0, boilerplate: 0 };
  let totalCompressedTokens = 0;

  for (const block of blocks) {
    const btype = classifyBlock(block);
    const btypeKey = blockTypeToKey(btype);
    const compressed = estimateChunkTokens(block, btype);
    blockTypeTokens[btypeKey] += compressed;
    totalCompressedTokens += compressed;
  }

  const afterChunking = totalCompressedTokens;

  // 3. Filter loss simulation
  const filterLoss = { byLength: 0, byLetterRatio: 0, byPunctuation: 0 };
  let passedChunks = 0;
  let failedChunks = 0;

  for (const block of blocks) {
    const result = filterChunk(block);
    if (result.passed) {
      passedChunks++;
    } else {
      failedChunks++;
      const t = estimateTokens(block);
      if (result.rejectionReason === "too_short")          filterLoss.byLength      += t;
      else if (result.rejectionReason === "low_letter_ratio") filterLoss.byLetterRatio += t;
      else if (result.rejectionReason === "high_punctuation") filterLoss.byPunctuation += t;
    }
  }

  const totalFilterLoss = filterLoss.byLength + filterLoss.byLetterRatio + filterLoss.byPunctuation;
  const afterFilter  = Math.max(0, afterChunking - totalFilterLoss);
  const embeddable   = afterFilter;

  // 4. Chunk count simulation
  const predictedChunkCount         = simulateChunkCount(doc, afterCleaning);
  const predictedFilteredChunkCount = failedChunks;

  // 5. Quality distribution (sample ≤30 blocks)
  const sampleBlocks = evenSample(blocks, 30);
  const qualityDist  = await sampleQualityDistribution(sampleBlocks, estimateChunkTokens);

  // 6. Block type distribution (0–1 shares)
  const blockTypeDistribution = totalCompressedTokens > 0
    ? {
        prose:       blockTypeTokens.prose       / totalCompressedTokens,
        header:      blockTypeTokens.header      / totalCompressedTokens,
        specValue:   blockTypeTokens.specValue   / totalCompressedTokens,
        tableRow:    blockTypeTokens.tableRow    / totalCompressedTokens,
        boilerplate: blockTypeTokens.boilerplate / totalCompressedTokens,
      }
    : { prose: 1, header: 0, specValue: 0, tableRow: 0, boilerplate: 0 };

  // 7. Accumulate corpus data (use original text so repeated/boilerplate lines are captured)
  for (const line of text.split("\n")) {
    acc.addLine(line.trim(), doc.id);
  }
  acc.addDomainSample(detectDomainSignals(text.slice(0, 8000)));

  return {
    docId: doc.id,
    tokenWaterfall: { raw, afterNormalization, afterCleaning, afterChunking, afterFilter, embeddable },
    cleaningLoss: {
      normalization: audit.tokensLostNormalization,
      boilerplate:   audit.tokensLostBoilerplate,
      repeatedLines: audit.tokensLostRepeated,
    },
    filterLoss,
    predictedChunkCount,
    predictedFilteredChunkCount,
    blockTypeDistribution,
    predictedQualityDistribution: qualityDist,
    tokenRetentionRate: raw > 0 ? embeddable / raw : 0,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function emptyProjection(docId: string): DocumentIngestionProjection {
  return {
    docId,
    tokenWaterfall: { raw: 0, afterNormalization: 0, afterCleaning: 0, afterChunking: 0, afterFilter: 0, embeddable: 0 },
    cleaningLoss: { normalization: 0, boilerplate: 0, repeatedLines: 0 },
    filterLoss: { byLength: 0, byLetterRatio: 0, byPunctuation: 0 },
    predictedChunkCount: 0,
    predictedFilteredChunkCount: 0,
    blockTypeDistribution: { prose: 1, header: 0, specValue: 0, tableRow: 0, boilerplate: 0 },
    predictedQualityDistribution: { high: 0, medium: 0, low: 0 },
    tokenRetentionRate: 0,
  };
}

function splitIntoBlocks(text: string): string[] {
  return text.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b.length > 0);
}

function blockTypeToKey(btype: string): "prose" | "header" | "specValue" | "tableRow" | "boilerplate" {
  if (btype === "spec_value") return "specValue";
  if (btype === "table_row")  return "tableRow";
  return btype as "prose" | "header" | "boilerplate";
}

function simulateChunkCount(doc: ParsedDocument, cleanedTokens: number): number {
  const CHUNK_SIZE    = 512;
  const CHUNK_OVERLAP = 64;
  const effective     = Math.max(1, CHUNK_SIZE - CHUNK_OVERLAP);

  switch (doc.recommendedChunkStrategy) {
    case "heading_sections": {
      const hCount = doc.headings.length;
      if (hCount === 0) return Math.max(1, Math.ceil(cleanedTokens / effective));
      const avgSectionTokens = cleanedTokens / hCount;
      return Math.max(1, Math.round(hCount * Math.ceil(avgSectionTokens / CHUNK_SIZE)));
    }
    case "table_rows":
      return Math.max(1, doc.tableCount * 10, Math.ceil(cleanedTokens / effective));
    default:
      return Math.max(1, Math.ceil(cleanedTokens / effective));
  }
}

function evenSample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  return Array.from({ length: max }, (_, i) => arr[Math.floor(i * step)]!);
}

async function sampleQualityDistribution(
  blocks: string[],
  _estimator: typeof estimateChunkTokens,
): Promise<{ high: number; medium: number; low: number }> {
  if (blocks.length === 0) return { high: 0, medium: 0, low: 0 };
  let highTokens = 0, medTokens = 0, lowTokens = 0, total = 0;
  for (const block of blocks) {
    const btype = classifyBlock(block);
    const tokens = estimateChunkTokens(block, btype);
    const score = await scoreBlock(block, btype, {});
    total += tokens;
    if (score >= 0.7)      highTokens += tokens;
    else if (score >= 0.4) medTokens  += tokens;
    else                   lowTokens  += tokens;
  }
  if (total === 0) return { high: 0, medium: 0, low: 0 };
  return { high: highTokens / total, medium: medTokens / total, low: lowTokens / total };
}

// ── 9b: Corpus-wide boilerplate discovery ─────────────────────────────────

const COMMON_WORDS = new Set([
  "seite","von","und","der","die","das","des","dem","den","ein","eine","eines","einer","einem","einen",
  "page","of","the","and","a","an","for","in","is","it","to","with","from","this","that",
  "stand","datum","version","revision","intern","confidential","vertraulich",
]);

function isPrivacySafe(normalizedForm: string): boolean {
  const words = normalizedForm.split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^a-zäöüß]/gi, "");
    if (clean.length > 4 && !COMMON_WORDS.has(clean.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function generateRegex(key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return "^" + escaped
    .replace(/\bdate\b/g, "\\d{2}\\.\\d{2}\\.\\d{4}")
    .replace(/\bN\b/g, "\\d+") + "$";
}

function discoverBoilerplatePatterns(
  acc: ProjectionAccumulator,
  projections: DocumentIngestionProjection[],
): { patterns: DiscoveredBoilerplatePattern[]; summary: CorpusBoilerplateSummary } {
  const candidates = acc.getCandidateLines(3);
  const patterns: DiscoveredBoilerplatePattern[] = [];
  let suppressedPatterns = 0;
  let totalTokensRecoverable = 0;

  for (const { key, occurrences, docCount, tokenCost } of candidates) {
    const alreadyCovered = BOILERPLATE_PATTERNS.some((re) => re.test(key));
    if (!isPrivacySafe(key)) {
      suppressedPatterns++;
      continue;
    }
    const normalizedForm = key.slice(0, 60);
    const tokensAtRisk = tokenCost * occurrences;
    totalTokensRecoverable += alreadyCovered ? 0 : tokensAtRisk;
    patterns.push({
      normalizedForm,
      occurrenceCount: occurrences,
      documentCount: docCount,
      suggestedRegex: generateRegex(key),
      alreadyCovered,
      tokensAtRisk,
    });
  }

  patterns.sort((a, b) => b.tokensAtRisk - a.tokensAtRisk);

  return {
    patterns,
    summary: {
      totalCandidatePatterns: patterns.length + suppressedPatterns,
      newPatterns: patterns.filter((p) => !p.alreadyCovered).length,
      suppressedPatterns,
      totalTokensRecoverable,
    },
  };
}

// ── 9c: Config recommendation engine ──────────────────────────────────────

function generateConfigRecommendations(
  state: ScannerState,
  boilerplatePatterns: DiscoveredBoilerplatePattern[],
): MuninnConfigRecommendation[] {
  const recs: MuninnConfigRecommendation[] = [];
  const projections = state.ingestionProjections;
  const totalRaw = projections.reduce((s, p) => s + p.tokenWaterfall.raw, 0);
  if (projections.length === 0 || totalRaw === 0) return recs;

  // CHUNK_SIZE: from median section token length in heading_sections docs
  const headingDocs = state.parsed.filter(
    (d) => d.parseSuccess && d.recommendedChunkStrategy === "heading_sections" && d.headings.length > 0
  );
  if (headingDocs.length >= 3) {
    const avgSectionTokens = headingDocs.map((d) => {
      const p = projections.find((pr) => pr.docId === d.id);
      if (!p || d.headings.length === 0) return 0;
      return p.tokenWaterfall.afterCleaning / d.headings.length;
    }).filter((v) => v > 0).sort((a, b) => a - b);

    const median = avgSectionTokens[Math.floor(avgSectionTokens.length / 2)] ?? 0;
    const recommended = Math.ceil(median * 1.15 / 64) * 64;
    const splitRate = avgSectionTokens.filter((t) => t > 512).length / avgSectionTokens.length;
    if (recommended !== 512) {
      recs.push({
        parameter: "CHUNK_SIZE",
        currentDefault: 512,
        recommendedValue: Math.max(256, Math.min(1024, recommended)),
        confidence: headingDocs.length >= 10 ? "HIGH" : "MEDIUM",
        reasoning: `Median section length is ${Math.round(median)} tokens; ${Math.round(splitRate * 100)}% of sections would be split at the current default of 512.`,
        evidenceDocCount: headingDocs.length,
        affectedTokenShare: projections.filter((p) => {
          const d = state.parsed.find((pd) => pd.id === p.docId);
          return d?.recommendedChunkStrategy === "heading_sections";
        }).reduce((s, p) => s + p.tokenWaterfall.raw, 0) / totalRaw,
      });
    }
  }

  // QUALITY_THRESHOLD: from quality distribution
  const allLow    = projections.reduce((s, p) => s + p.predictedQualityDistribution.low, 0)    / projections.length;
  const allMedium = projections.reduce((s, p) => s + p.predictedQualityDistribution.medium, 0) / projections.length;
  if (allLow > 0.25) {
    recs.push({
      parameter: "QUALITY_THRESHOLD",
      currentDefault: 0.4,
      recommendedValue: 0.3,
      confidence: projections.length >= 10 ? "HIGH" : "MEDIUM",
      reasoning: `${Math.round(allLow * 100)}% of content-bearing tokens score below 0.4 — lowering threshold prevents excessive chunk loss.`,
      evidenceDocCount: projections.length,
      affectedTokenShare: allLow + allMedium,
    });
  } else if (allLow < 0.05) {
    recs.push({
      parameter: "QUALITY_THRESHOLD",
      currentDefault: 0.4,
      recommendedValue: 0.5,
      confidence: projections.length >= 10 ? "HIGH" : "MEDIUM",
      reasoning: `Only ${Math.round(allLow * 100)}% of tokens score below 0.4 — raising threshold tightens retrieval quality without significant loss.`,
      evidenceDocCount: projections.length,
      affectedTokenShare: allLow,
    });
  }

  // BOILERPLATE_PATTERNS additions
  const newPatterns = boilerplatePatterns.filter((p) => !p.alreadyCovered && p.documentCount >= 5);
  if (newPatterns.length > 0) {
    const tokenShare = newPatterns.reduce((s, p) => s + p.tokensAtRisk, 0) / totalRaw;
    recs.push({
      parameter: "BOILERPLATE_PATTERNS",
      currentDefault: "12 existing patterns",
      recommendedValue: `Add ${newPatterns.length} new pattern(s)`,
      confidence: "HIGH",
      reasoning: `${newPatterns.length} client-specific boilerplate line pattern(s) found in 5+ documents (${Math.round(tokenShare * 100)}% of corpus tokens at risk).`,
      evidenceDocCount: Math.max(...newPatterns.map((p) => p.documentCount)),
      affectedTokenShare: tokenShare,
    });
  }

  // VERSION thresholds: from versionPair score histogram
  const scores = state.versionPairs.map((vp) => vp.score);
  if (scores.length >= 10) {
    const high = scores.filter((s) => s >= 10).length;
    const mid  = scores.filter((s) => s >= 5 && s < 10).length;
    const isBimodal = mid < scores.length * 0.1 && high > scores.length * 0.3;
    if (isBimodal) {
      recs.push({
        parameter: "VERSION_AUTO_THRESHOLD",
        currentDefault: 0.95,
        recommendedValue: 0.97,
        confidence: "MEDIUM",
        reasoning: `Score distribution is bimodal (${high} pairs score 10-12, ${mid} score 5-9) — raising threshold reduces false-positive auto-supersession.`,
        evidenceDocCount: state.versionPairs.length,
        affectedTokenShare: 0,
      });
    }
  }

  return recs;
}

// ── Corpus summary ─────────────────────────────────────────────────────────

function buildCorpusSummary(
  projections: DocumentIngestionProjection[],
  parsed: ScannerState["parsed"],
): CorpusIngestionSummary {
  if (projections.length === 0) {
    return {
      totalTokensRaw: 0, totalTokensEmbeddable: 0, overallRetentionRate: 0,
      lossWaterfall: [], byDocType: {}, highRiskDocs: [],
    };
  }

  const totalRaw        = projections.reduce((s, p) => s + p.tokenWaterfall.raw, 0);
  const totalEmbeddable = projections.reduce((s, p) => s + p.tokenWaterfall.embeddable, 0);

  const stageNames = ["normalization", "boilerplate + repeated lines", "chunking compression", "content filter"];
  const stageLoss: [number, number, number, number] = projections.reduce(
    (acc, p): [number, number, number, number] => [
      acc[0] + p.cleaningLoss.normalization,
      acc[1] + p.cleaningLoss.boilerplate + p.cleaningLoss.repeatedLines,
      acc[2] + Math.max(0, p.tokenWaterfall.afterCleaning - p.tokenWaterfall.afterChunking),
      acc[3] + p.filterLoss.byLength + p.filterLoss.byLetterRatio + p.filterLoss.byPunctuation,
    ],
    [0, 0, 0, 0] as [number, number, number, number],
  );

  const lossWaterfall = stageNames.map((stage, i) => ({
    stage,
    tokensLost: stageLoss[i]!,
    percentOfRaw: totalRaw > 0 ? (stageLoss[i]! / totalRaw) * 100 : 0,
  }));

  const byDocType: CorpusIngestionSummary["byDocType"] = {};
  for (const doc of parsed) {
    if (!doc.parseSuccess) continue;
    const proj = projections.find((p) => p.docId === doc.id);
    if (!proj) continue;
    const key = doc.detectedDocType ?? "other";
    const entry = byDocType[key] ?? { docCount: 0, retentionRate: 0, avgQualityHigh: 0, dominantChunkStrategy: doc.recommendedChunkStrategy, avgPredictedChunkCount: 0 };
    entry.docCount++;
    entry.retentionRate          = (entry.retentionRate * (entry.docCount - 1) + proj.tokenRetentionRate) / entry.docCount;
    entry.avgQualityHigh         = (entry.avgQualityHigh * (entry.docCount - 1) + proj.predictedQualityDistribution.high) / entry.docCount;
    entry.avgPredictedChunkCount = (entry.avgPredictedChunkCount * (entry.docCount - 1) + proj.predictedChunkCount) / entry.docCount;
    byDocType[key] = entry;
  }

  const highRiskDocs = projections
    .filter((p) => p.tokenRetentionRate < 0.5 && p.tokenWaterfall.raw > 0)
    .map((p) => {
      const cl = p.cleaningLoss;
      const fl = p.filterLoss;
      const doc = parsed.find((d) => d.id === p.docId);
      let primaryLossCause: CorpusIngestionSummary["highRiskDocs"][number]["primaryLossCause"] = "normalization";
      if (doc?.isOcrRequired) primaryLossCause = "ocr";
      else if (cl.boilerplate + cl.repeatedLines > cl.normalization && cl.boilerplate + cl.repeatedLines > (fl.byLength + fl.byLetterRatio + fl.byPunctuation)) primaryLossCause = "boilerplate";
      else if (fl.byLength + fl.byLetterRatio + fl.byPunctuation > cl.normalization) primaryLossCause = "filter";
      return { docId: p.docId, retentionRate: p.tokenRetentionRate, primaryLossCause };
    });

  return {
    totalTokensRaw: totalRaw,
    totalTokensEmbeddable: totalEmbeddable,
    overallRetentionRate: totalRaw > 0 ? totalEmbeddable / totalRaw : 0,
    lossWaterfall,
    byDocType,
    highRiskDocs,
  };
}

// ── Phase 9 main entry point ───────────────────────────────────────────────

export async function runProjection(state: ScannerState): Promise<void> {
  const acc = _lastAccumulator;
  if (!acc) {
    logger.warn("Phase 9: no accumulator from Phase 2 — skipping corpus analysis");
    return;
  }
  setPhase("3-projection");
  logger.info("Phase 9: Ingestion Projection — corpus analysis", {
    projections: state.ingestionProjections.length,
  });

  // 9b: Boilerplate discovery
  const { patterns, summary: boilerplateSummary } = discoverBoilerplatePatterns(acc, state.ingestionProjections);
  state.discoveredBoilerplatePatterns = patterns;
  logger.info("Boilerplate discovery complete", {
    candidates: boilerplateSummary.totalCandidatePatterns,
    newPatterns: boilerplateSummary.newPatterns,
    suppressed: boilerplateSummary.suppressedPatterns,
  });

  // Finalise domain profile
  const domainSamples = acc.getDomainSamples();
  const parsedLanguages = state.parsed.filter((d) => d.parseSuccess).map((d) => d.language);
  state.domainProfile = buildDomainProfile(domainSamples, parsedLanguages);
  logger.info("Domain profile finalised", {
    language: state.domainProfile.detectedLanguage,
    reqFamily: state.domainProfile.requirementLanguageFamily,
    unitFamily: state.domainProfile.dominantUnitFamily,
    profile: state.domainProfile.qualityScorerProfile,
  });

  // 9c: Config recommendations
  state.muninnConfigRecommendations = generateConfigRecommendations(state, patterns);
  logger.info("Config recommendations generated", {
    count: state.muninnConfigRecommendations.length,
  });

  // Corpus summary
  state.corpusIngestionSummary = buildCorpusSummary(state.ingestionProjections, state.parsed);
  logger.info("Corpus ingestion summary built", {
    totalTokensRaw: state.corpusIngestionSummary.totalTokensRaw,
    retentionRate: state.corpusIngestionSummary.overallRetentionRate.toFixed(2),
    highRiskDocs: state.corpusIngestionSummary.highRiskDocs.length,
  });
}
