import type { RawChunk } from "../muninn-mirror/types.ts";
import { EmbeddingCache } from "./embedding-cache.ts";

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
