import type {
  ScannerState,
  ChunkQualityPerDoc,
  ChunkQualityReport,
  ChunkQualityPerDocTier1,
  ChunkQualityPerDocTier2,
} from "../state.ts";
import { logger } from "../utils/logger.ts";
import { resolveBudget, evenSample } from "../utils/chunk-quality/budget.ts";
import { EmbeddingCache } from "../utils/chunk-quality/embedding-cache.ts";
import { chunkDocument } from "../utils/muninn-mirror/chunker.ts";
import { extensionToMime } from "../utils/muninn-mirror/mime-map.ts";
import { cleanContent } from "../utils/cleaner.ts";
import type { RawChunk } from "../utils/muninn-mirror/types.ts";
import {
  sizeFit,
  sentenceBoundaryQuality,
  crossReferenceCut,
  tableCut,
  headerPollution,
  contentScore,
} from "../utils/chunk-quality/tier1-rules.ts";
import {
  coherenceDrop,
  intraChunkCohesion,
  centroidDistance,
  type NormalizationCheck,
} from "../utils/chunk-quality/tier2-embeddings.ts";

function meanAndP10(values: number[]): { mean: number; p10: number } {
  if (values.length === 0) return { mean: 0, p10: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  const p10 = sorted[Math.floor(0.1 * sorted.length)] ?? mean;
  return { mean, p10 };
}

function meanAndP10Nullable(values: Array<number | null>): { mean: number | null; p10: number | null } {
  const filtered = values.filter((v): v is number => v !== null);
  if (filtered.length === 0) return { mean: null, p10: null };
  return meanAndP10(filtered);
}

function bucketize(score: number): "good" | "acceptable" | "poor" {
  if (score >= 0.7) return "good";
  if (score >= 0.4) return "acceptable";
  return "poor";
}

function clamp120(s: string): string {
  return s.length <= 120 ? s : s.slice(0, 117) + "...";
}

export async function runChunkQuality(state: ScannerState, ollamaOk: boolean): Promise<void> {
  const t = logger.phaseStart("4-chunk-quality");

  if (process.env["CHUNK_QUALITY_DISABLE"] === "1") {
    logger.info("chunk-quality disabled via env var");
    logger.phaseEnd("4-chunk-quality", t, { skipped: true });
    return;
  }

  const budget = resolveBudget();
  state.chunkQuality.corpus.budgetMode = budget.mode;
  logger.info("chunk-quality budget", {
    budgetMode: budget.mode,
    maxChunksPerDoc: budget.maxChunksPerDoc,
    parseSuccessful: state.parsed.filter(d => d.parseSuccess).length,
  });

  const cache = new EmbeddingCache();
  const normCheck: NormalizationCheck = { sampleSize: 0, allNormalized: true, maxDeviation: 0 };
  const perDoc: ChunkQualityPerDoc[] = [];
  let runningTotal = 0;
  let totalEmbedded = 0;
  let tier2Disabled = !ollamaOk;

  type DocChunks = { docId: string; ext: string; allChunks: RawChunk[]; sampledChunks: RawChunk[] };
  const allDocs: DocChunks[] = [];

  for (const doc of state.parsed) {
    if (!doc.parseSuccess || !doc.textContent) continue;
    const mime = extensionToMime(doc.extension);
    const { cleaned } = cleanContent(doc.textContent);
    const allChunks = await chunkDocument({ content: cleaned, mimeType: mime, documentId: doc.id });
    if (allChunks.length === 0) continue;
    const sampledChunks = evenSample(allChunks, budget.maxChunksPerDoc);
    allDocs.push({ docId: doc.id, ext: doc.extension, allChunks, sampledChunks });
    runningTotal += sampledChunks.length;
  }

  if (runningTotal > budget.maxCorpusChunks) {
    const factor = budget.maxCorpusChunks / runningTotal;
    for (const d of allDocs) {
      const target = Math.max(1, Math.floor(d.sampledChunks.length * factor));
      d.sampledChunks = evenSample(d.sampledChunks, target);
    }
    runningTotal = allDocs.reduce((s, d) => s + d.sampledChunks.length, 0);
  }
  const budgetCapHit = allDocs.some(d => d.sampledChunks.length < d.allChunks.length);

  for (const d of allDocs) {
    const doc = state.parsed.find(p => p.id === d.docId);
    if (!doc) continue;
    const hints = {
      requirementLanguageFamily: state.domainProfile.requirementLanguageFamily,
      dominantUnitFamily:        state.domainProfile.dominantUnitFamily,
    };

    const sizeFitVals       = d.allChunks.map(c => sizeFit(c));
    const sentBoundaryVals  = d.allChunks.map(c => sentenceBoundaryQuality(c)).filter((v): v is number => v !== null);
    const crossRefVals      = d.allChunks.map(c => crossReferenceCut(c));
    const tableCutVals      = d.allChunks.map(c => tableCut(c, d.ext));
    const headerPollVals    = d.allChunks.map(c => headerPollution(c));
    const contentScoreVals  = await Promise.all(d.allChunks.map(c => contentScore(c, hints)));

    const tier1: ChunkQualityPerDocTier1 = {
      sizeFit:                 meanAndP10(sizeFitVals),
      sentenceBoundaryQuality: meanAndP10(sentBoundaryVals.length > 0 ? sentBoundaryVals : [1.0]),
      crossReferenceCut:       meanAndP10(crossRefVals),
      tableCut:                meanAndP10Nullable(tableCutVals),
      headerPollution:         meanAndP10(headerPollVals),
      contentScore:            meanAndP10(contentScoreVals),
    };

    let tier2: ChunkQualityPerDocTier2 | null = null;
    if (!tier2Disabled && d.sampledChunks.length > 0) {
      try {
        const coh = await coherenceDrop(d.sampledChunks, cache, normCheck);
        const intra = await intraChunkCohesion(d.sampledChunks, cache, normCheck);
        const cent = await centroidDistance(d.sampledChunks, cache, normCheck);
        tier2 = { coherenceDrop: coh, intraChunkCohesion: intra, centroidDistance: cent };
      } catch (e) {
        logger.warn("Tier 2 failed for doc, disabling for remainder", { docId: d.docId, error: String(e).slice(0, 100) });
        tier2Disabled = true;
        tier2 = null;
      }
    }

    const sampledIdSet = new Set(d.sampledChunks.map(c => c.chunkIndex));
    const indexValues: number[] = [];
    for (const c of d.allChunks) {
      const tier1Vals: number[] = [
        sizeFit(c),
        crossReferenceCut(c),
        headerPollution(c),
        await contentScore(c, hints),
      ];
      const sbq = sentenceBoundaryQuality(c);
      if (sbq !== null) tier1Vals.push(sbq);
      const tc = tableCut(c, d.ext);
      if (tc !== null) tier1Vals.push(tc);
      const tier1Mean = tier1Vals.reduce((s, x) => s + x, 0) / tier1Vals.length;

      let composite = tier1Mean;
      if (tier2 && sampledIdSet.has(c.chunkIndex)) {
        const tier2Vals: number[] = [];
        if (tier2.coherenceDrop) tier2Vals.push(tier2.coherenceDrop.mean);
        if (tier2.intraChunkCohesion) tier2Vals.push(tier2.intraChunkCohesion.mean);
        tier2Vals.push(tier2.centroidDistance.mean);
        if (tier2Vals.length > 0) {
          const tier2Mean = tier2Vals.reduce((s, x) => s + x, 0) / tier2Vals.length;
          composite = 0.5 * tier1Mean + 0.5 * tier2Mean;
        }
      }
      indexValues.push(composite);
    }

    const chunkQualityIndex = meanAndP10(indexValues);
    const bucketCounts = { good: 0, acceptable: 0, poor: 0 };
    for (const v of indexValues) bucketCounts[bucketize(v)]++;

    const metricSnapshots: Array<[string, number]> = [
      ["sizeFit",                 tier1.sizeFit.mean],
      ["sentenceBoundaryQuality", tier1.sentenceBoundaryQuality.mean],
      ["crossReferenceCut",       tier1.crossReferenceCut.mean],
      ["headerPollution",         tier1.headerPollution.mean],
      ["contentScore",            tier1.contentScore.mean],
    ];
    if (tier1.tableCut.mean !== null) metricSnapshots.push(["tableCut", tier1.tableCut.mean]);
    if (tier2?.coherenceDrop)        metricSnapshots.push(["coherenceDrop", tier2.coherenceDrop.mean]);
    if (tier2?.intraChunkCohesion)   metricSnapshots.push(["intraChunkCohesion", tier2.intraChunkCohesion.mean]);
    if (tier2)                       metricSnapshots.push(["centroidDistance", tier2.centroidDistance.mean]);

    const weakestLinks = metricSnapshots
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3)
      .map(([name, val]) => clamp120(`${name}: ${val.toFixed(2)}`));

    perDoc.push({
      docId: d.docId,
      chunkCountTotal:    d.allChunks.length,
      chunkCountEmbedded: tier2 ? d.sampledChunks.length : 0,
      budgetMode:         budget.mode,
      budgetCapHit:       d.sampledChunks.length < d.allChunks.length,
      tier1,
      tier2,
      chunkQualityIndex,
      bucketCounts,
      weakestLinks,
    });

    totalEmbedded += tier2 ? d.sampledChunks.length : 0;
  }

  const totalChunks = perDoc.reduce((s, d) => s + d.chunkCountTotal, 0);
  const totalBuckets = perDoc.reduce(
    (acc, d) => ({
      good: acc.good + d.bucketCounts.good,
      acceptable: acc.acceptable + d.bucketCounts.acceptable,
      poor: acc.poor + d.bucketCounts.poor,
    }),
    { good: 0, acceptable: 0, poor: 0 },
  );
  const bucketShare = totalChunks > 0
    ? {
        good: totalBuckets.good / totalChunks,
        acceptable: totalBuckets.acceptable / totalChunks,
        poor: totalBuckets.poor / totalChunks,
      }
    : { good: 0, acceptable: 0, poor: 0 };

  const tokenWeightedIndexMean = totalChunks > 0
    ? perDoc.reduce((s, d) => s + d.chunkQualityIndex.mean * d.chunkCountTotal, 0) / totalChunks
    : 0;

  const worstDocsByP10 = [...perDoc]
    .sort((a, b) => a.chunkQualityIndex.p10 - b.chunkQualityIndex.p10)
    .slice(0, 5)
    .map(d => ({
      docId: d.docId,
      p10: d.chunkQualityIndex.p10,
      primaryWeakness: clamp120(d.weakestLinks[0] ?? "unknown"),
    }));

  const metricNames = [
    "sizeFit", "sentenceBoundaryQuality", "crossReferenceCut", "tableCut",
    "headerPollution", "contentScore", "coherenceDrop", "intraChunkCohesion", "centroidDistance",
  ];
  const corpusMetricMeans: Array<{ metric: string; mean: number }> = [];
  for (const name of metricNames) {
    const vals: number[] = [];
    for (const d of perDoc) {
      let v: number | null = null;
      if (name === "sizeFit") v = d.tier1.sizeFit.mean;
      else if (name === "sentenceBoundaryQuality") v = d.tier1.sentenceBoundaryQuality.mean;
      else if (name === "crossReferenceCut") v = d.tier1.crossReferenceCut.mean;
      else if (name === "tableCut") v = d.tier1.tableCut.mean;
      else if (name === "headerPollution") v = d.tier1.headerPollution.mean;
      else if (name === "contentScore") v = d.tier1.contentScore.mean;
      else if (name === "coherenceDrop") v = d.tier2?.coherenceDrop?.mean ?? null;
      else if (name === "intraChunkCohesion") v = d.tier2?.intraChunkCohesion?.mean ?? null;
      else if (name === "centroidDistance") v = d.tier2?.centroidDistance.mean ?? null;
      if (v !== null) vals.push(v);
    }
    if (vals.length > 0) {
      corpusMetricMeans.push({ metric: name, mean: vals.reduce((s, x) => s + x, 0) / vals.length });
    }
  }
  const weakestCorpusMetrics = [...corpusMetricMeans]
    .sort((a, b) => a.mean - b.mean)
    .slice(0, 3);

  const report: ChunkQualityReport = {
    perDoc,
    corpus: {
      budgetMode: budget.mode,
      totalChunks,
      totalChunksEmbedded: totalEmbedded,
      tokenWeightedIndexMean,
      bucketShare,
      worstDocsByP10,
      weakestCorpusMetrics,
      embeddingsCacheStats: cache.stats(),
      bgeM3NormalizationCheck: normCheck,
    },
    generatedAt: new Date(),
  };

  state.chunkQuality = report;

  logger.phaseEnd("4-chunk-quality", t, {
    docs: perDoc.length,
    totalChunks,
    totalEmbedded,
    indexMean: tokenWeightedIndexMean.toFixed(3),
    bucketCapHit: budgetCapHit,
    tier2Enabled: !tier2Disabled,
  });

  cache.clear();
}
