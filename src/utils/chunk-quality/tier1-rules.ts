import type { RawChunk } from "../muninn-mirror/types.ts";
import { estimateTokens } from "../token-estimator.ts";
import { analyzeBoundaries } from "./sentence-splitter.ts";
import { classifyBlock } from "../muninn-mirror/cleaner.ts";
import { scoreBlock } from "../quality-scorer.ts";
import type { DomainHints } from "../quality-scorer.ts";

/**
 * sizeFit: 1.0 if 200–550 tokens; linear falloff to 0.2 at <50 or >900 tokens.
 */
export function sizeFit(chunk: RawChunk): number {
  const tokens = estimateTokens(chunk.content);
  if (tokens >= 200 && tokens <= 550) return 1.0;
  if (tokens < 50)  return 0.2;
  if (tokens > 900) return 0.2;
  if (tokens < 200) {
    return 0.2 + ((tokens - 50) / 150) * 0.8;
  }
  return 1.0 - ((tokens - 550) / 350) * 0.8;
}

/**
 * sentenceBoundaryQuality: cleanliness of first/last sentence boundaries.
 * Returns null for table_row chunks (boundaries don't apply).
 */
export function sentenceBoundaryQuality(chunk: RawChunk): number | null {
  if (chunk.chunkType === "table_row") return null;
  const b = analyzeBoundaries(chunk.content);
  if (!b) return null;
  const startsOk = b.first.startsCleanly;
  const endsOk = b.last.endsCleanly;
  if (startsOk && endsOk) return 1.0;
  if (startsOk || endsOk) return 0.5;
  return 0.0;
}
