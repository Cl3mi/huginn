import { createHash } from "crypto";
import { embed } from "../../llm/ollama.ts";

export interface EmbeddingCacheStats {
  uniqueChunks: number;
  cacheHits:    number;
  cacheMisses:  number;
}

export class EmbeddingCache {
  private cache = new Map<string, Float32Array>();
  private hits = 0;
  private misses = 0;

  private key(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  async get(text: string): Promise<Float32Array> {
    const k = this.key(text);
    const cached = this.cache.get(k);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const vecs = await embed([text]);
    const vec = vecs[0];
    if (!vec) throw new Error("embed returned empty array");
    const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
    this.cache.set(k, f32);
    return f32;
  }

  stats(): EmbeddingCacheStats {
    return { uniqueChunks: this.cache.size, cacheHits: this.hits, cacheMisses: this.misses };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
