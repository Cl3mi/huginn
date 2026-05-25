import type { RawChunk } from "../muninn-mirror/types.ts";
import { EmbeddingCache } from "./embedding-cache.ts";
import { estimateTokens } from "../token-estimator.ts";

/**
 * Cosine similarity for L2-normalized vectors (BGE-M3 default).
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return Math.max(-1, Math.min(1, dot));
}

export function l2Norm(v: Float32Array): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

export function normalize(v: Float32Array): Float32Array {
  const n = l2Norm(v);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / n;
  return out;
}

export interface NormalizationCheck {
  sampleSize:    number;
  allNormalized: boolean;
  maxDeviation:  number;
}

/**
 * coherenceDrop: per-doc score in [0, 1].
 *   drop_i = 1 - cos(emb_i, emb_{i+1})
 *   score  = 1 - mean(drop)
 * Returns null if fewer than 2 chunks.
 */
export async function coherenceDrop(
  chunks: RawChunk[],
  cache: EmbeddingCache,
  normCheck: NormalizationCheck,
): Promise<{ mean: number; p10: number } | null> {
  if (chunks.length < 2) return null;

  const drops: number[] = [];
  let prevEmb: Float32Array | null = null;

  for (const chunk of chunks) {
    let emb = await cache.get(chunk.content);
    const norm = l2Norm(emb);
    normCheck.sampleSize++;
    const dev = Math.abs(norm - 1);
    if (dev > normCheck.maxDeviation) normCheck.maxDeviation = dev;
    if (dev > 0.001) {
      normCheck.allNormalized = false;
      emb = normalize(emb);
    }

    if (prevEmb) {
      const sim = cosineSim(prevEmb, emb);
      drops.push(1 - sim);
    }
    prevEmb = emb;
  }

  if (drops.length === 0) return null;
  const sortedDrops = [...drops].sort((a, b) => a - b);
  const meanDrop = drops.reduce((s, x) => s + x, 0) / drops.length;
  const p90Drop = sortedDrops[Math.floor(0.9 * sortedDrops.length)] ?? meanDrop;
  return {
    mean: Math.max(0, Math.min(1, 1 - meanDrop)),
    p10:  Math.max(0, Math.min(1, 1 - p90Drop)),  // worst-10% drop → p10 of score
  };
}

const MIN_TOKENS_FOR_INTRA = 100;

/**
 * intraChunkCohesion: per-doc score in [0, 1].
 * For each chunk ≥ MIN_TOKENS_FOR_INTRA, split at token midpoint, embed each half,
 * score = cos(half_a, half_b). Chunks under 100 tokens skipped.
 */
export async function intraChunkCohesion(
  chunks: RawChunk[],
  cache: EmbeddingCache,
  normCheck: NormalizationCheck,
): Promise<{ mean: number; p10: number; nMeasurable: number } | null> {
  const scores: number[] = [];

  for (const chunk of chunks) {
    const tokens = estimateTokens(chunk.content);
    if (tokens < MIN_TOKENS_FOR_INTRA) continue;

    const midpoint = Math.floor(chunk.content.length / 2);
    let splitAt = midpoint;
    for (let i = 0; i < 30 && midpoint + i < chunk.content.length; i++) {
      if (chunk.content[midpoint + i] === " " || chunk.content[midpoint + i] === "\n") {
        splitAt = midpoint + i;
        break;
      }
    }
    const halfA = chunk.content.slice(0, splitAt).trim();
    const halfB = chunk.content.slice(splitAt).trim();
    if (halfA.length === 0 || halfB.length === 0) continue;

    let embA = await cache.get(halfA);
    let embB = await cache.get(halfB);

    for (const emb of [embA, embB]) {
      const dev = Math.abs(l2Norm(emb) - 1);
      normCheck.sampleSize++;
      if (dev > normCheck.maxDeviation) normCheck.maxDeviation = dev;
      if (dev > 0.001) normCheck.allNormalized = false;
    }
    embA = normalize(embA);
    embB = normalize(embB);

    scores.push(cosineSim(embA, embB));
  }

  if (scores.length === 0) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
  const p10 = sorted[Math.floor(0.1 * sorted.length)] ?? mean;
  return {
    mean: Math.max(0, Math.min(1, mean)),
    p10:  Math.max(0, Math.min(1, p10)),
    nMeasurable: scores.length,
  };
}
