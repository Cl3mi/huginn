// Pure TypeScript MinHash implementation. ~60 lines. No library.
// Used for comparing document heading lists to detect version pairs.

const LARGE_PRIME = 4294967311n; // just above 2^32

function hashToken(token: string, seed: number): number {
  let h = seed ^ 0x9747b28c;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    h = Math.imul(h ^ c, 0x5bd1e995);
    h ^= h >>> 15;
  }
  // mix with seed again
  h = Math.imul(h ^ seed, 0xcc9e2d51);
  h ^= h >>> 13;
  h = Math.imul(h, 0x1b873593);
  return (h >>> 0); // unsigned 32-bit
}

// Generate numHashes different hash seeds deterministically
function generateSeeds(numHashes: number): number[] {
  const seeds: number[] = [];
  // Use linear congruential generator to produce distinct seeds
  let s = 0xdeadbeef;
  for (let i = 0; i < numHashes; i++) {
    s = Math.imul(s, 1664525) + 1013904223;
    seeds.push(s >>> 0);
  }
  return seeds;
}

const SEEDS_128 = generateSeeds(128);

/**
 * Create a MinHash signature from a list of tokens (heading strings).
 * Returns a Uint32Array of length numHashes.
 * Each position holds the minimum hash value for that hash function.
 */
export function createMinHashSignature(
  tokens: string[],
  numHashes: number = 128
): Uint32Array {
  const sig = new Uint32Array(numHashes).fill(0xffffffff);
  const seeds = numHashes === 128 ? SEEDS_128 : generateSeeds(numHashes);

  for (const token of tokens) {
    const normalized = token.toLowerCase().trim();
    if (!normalized) continue;
    for (let i = 0; i < numHashes; i++) {
      const h = hashToken(normalized, seeds[i]!);
      if (h < sig[i]!) {
        sig[i] = h;
      }
    }
  }
  return sig;
}

/**
 * Estimate Jaccard similarity between two MinHash signatures.
 * Returns a value in [0, 1].
 */
export function jaccardFromMinHash(sig1: Uint32Array, sig2: Uint32Array): number {
  if (sig1.length !== sig2.length) {
    throw new Error(`MinHash signature length mismatch: ${sig1.length} vs ${sig2.length}`);
  }
  let matches = 0;
  for (let i = 0; i < sig1.length; i++) {
    if (sig1[i] === sig2[i]) matches++;
  }
  return matches / sig1.length;
}

/**
 * Cosine similarity between two Float32Arrays (semantic embeddings).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i]! * b[i]!);
    normA += (a[i]! * a[i]!);
    normB += (b[i]! * b[i]!);
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
