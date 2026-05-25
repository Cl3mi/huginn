// Mirror of muninn/packages/rag/src/ingestion/token-estimator.ts.
// Sync manually when Muninn changes — see DRIFT.md.
// Included because cleaner.ts depends on it.

import type { ChunkType } from "./types.ts";

/**
 * Token estimation utility for German language text.
 * Provides estimates for token counts based on character and word analysis.
 *
 * Assumptions:
 * - German language with average of 4.5 characters per token
 * - Accounts for word boundaries and whitespace distribution
 * - Compression factors applied for boilerplate and header content
 */

const CHARS_PER_TOKEN = 4.5;
const WORD_BOUNDARY_BONUS = 0.5;

// Compression factors for different chunk types
const COMPRESSION_FACTORS: Record<ChunkType, number> = {
  spec_value: 1.0,
  prose: 1.0,
  table_row: 1.0,
  boilerplate: 0.7, // Boilerplate content compresses to 70% of token estimate
  header: 0.8,      // Header content compresses to 80% of token estimate
};

/**
 * Estimate the number of tokens in a given text.
 *
 * Calculation method:
 * 1. Count total non-whitespace characters
 * 2. Count word count (space-separated segments)
 * 3. Combine metrics: (chars + words * WORD_BOUNDARY_BONUS) / CHARS_PER_TOKEN
 * 4. Round up to nearest integer
 *
 * This accounts for the fact that German text has varying character lengths
 * per word, and word boundaries affect tokenization.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count (rounded up)
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  // Count non-whitespace characters
  const nonWhitespaceChars = text.replace(/\s+/g, '').length;

  // Count words (space-separated segments)
  const words = text.trim().split(/\s+/).filter(word => word.length > 0).length;

  // Combined estimation: character count and word boundaries
  // WORD_BOUNDARY_BONUS accounts for tokenization at word boundaries
  const combinedMetric = nonWhitespaceChars + words * WORD_BOUNDARY_BONUS;
  const estimatedTokens = combinedMetric / CHARS_PER_TOKEN;

  return Math.ceil(estimatedTokens);
}

/**
 * Estimate the number of tokens in a chunk with type-specific compression.
 *
 * Applies compression factors based on chunk type:
 * - 'boilerplate': 0.7x multiplier (repetitive, low-value content)
 * - 'header': 0.8x multiplier (structured metadata)
 * - default/other: 1.0x multiplier (no compression)
 *
 * @param content - The chunk content to estimate tokens for
 * @param chunkType - The type of chunk (standard ChunkType or custom string)
 * @returns Estimated token count after applying compression factor (rounded up)
 */
export function estimateChunkTokens(content: string, chunkType: ChunkType | string): number {
  const baseTokens = estimateTokens(content);
  const compressionFactor = COMPRESSION_FACTORS[chunkType as ChunkType] ?? 1.0;

  return Math.ceil(baseTokens * compressionFactor);
}
