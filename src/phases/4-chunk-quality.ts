import type { ScannerState, ChunkQualityPerDoc, ChunkQualityReport } from "../state.ts";
import { logger, setPhase } from "../utils/logger.ts";
import { resolveBudget } from "../utils/chunk-quality/budget.ts";
import { EmbeddingCache } from "../utils/chunk-quality/embedding-cache.ts";
import { chunkDocument } from "../utils/muninn-mirror/chunker.ts";
import { extensionToMime } from "../utils/muninn-mirror/mime-map.ts";
import { cleanContent } from "../utils/cleaner.ts";

export async function runChunkQuality(state: ScannerState, ollamaOk: boolean): Promise<void> {
  setPhase("4-chunk-quality");

  if (process.env["CHUNK_QUALITY_DISABLE"] === "1") {
    logger.info("Phase 4: chunk-quality disabled via env var");
    return;
  }

  const budget = resolveBudget();
  state.chunkQuality.corpus.budgetMode = budget.mode;
  logger.info("Phase 4: chunk-quality start", {
    budgetMode: budget.mode,
    maxChunksPerDoc: budget.maxChunksPerDoc,
    parseSuccessful: state.parsed.filter(d => d.parseSuccess).length,
  });

  const cache = new EmbeddingCache();
  const perDoc: ChunkQualityPerDoc[] = [];

  for (const doc of state.parsed) {
    if (!doc.parseSuccess || !doc.textContent) continue;

    const mime = extensionToMime(doc.extension);
    const { cleaned } = cleanContent(doc.textContent);
    const chunks = await chunkDocument({ content: cleaned, mimeType: mime, documentId: doc.id });

    if (chunks.length === 0) continue;

    perDoc.push({
      docId: doc.id,
      chunkCountTotal: chunks.length,
      chunkCountEmbedded: 0,
      budgetMode: budget.mode,
      budgetCapHit: false,
      tier1: {
        sizeFit:                 { mean: 0, p10: 0 },
        sentenceBoundaryQuality: { mean: 0, p10: 0 },
        crossReferenceCut:       { mean: 0, p10: 0 },
        tableCut:                { mean: null, p10: null },
        headerPollution:         { mean: 0, p10: 0 },
        contentScore:            { mean: 0, p10: 0 },
      },
      tier2: null,
      chunkQualityIndex: { mean: 0, p10: 0 },
      bucketCounts: { good: 0, acceptable: 0, poor: 0 },
      weakestLinks: [],
    });
  }

  const report: ChunkQualityReport = {
    perDoc,
    corpus: {
      ...state.chunkQuality.corpus,
      totalChunks: perDoc.reduce((s, d) => s + d.chunkCountTotal, 0),
      totalChunksEmbedded: 0,
      embeddingsCacheStats: cache.stats(),
    },
    generatedAt: new Date(),
  };

  state.chunkQuality = report;

  logger.info("Phase 4: chunk-quality complete (skeleton)", {
    docs: perDoc.length,
    totalChunks: report.corpus.totalChunks,
  });

  cache.clear();
  void ollamaOk;
}
