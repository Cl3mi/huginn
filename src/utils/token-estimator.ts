export type ChunkType = "spec_value" | "prose" | "table_row" | "boilerplate" | "header";

const CHARS_PER_TOKEN = 4.5;
const WORD_BOUNDARY_BONUS = 0.5;

const COMPRESSION_FACTORS: Record<ChunkType, number> = {
  spec_value:  1.0,
  prose:       1.0,
  table_row:   1.0,
  boilerplate: 0.7,
  header:      0.8,
};

export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  const nonWhitespace = text.replace(/\s+/g, "").length;
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil((nonWhitespace + words * WORD_BOUNDARY_BONUS) / CHARS_PER_TOKEN);
}

export function estimateChunkTokens(content: string, chunkType: ChunkType | string): number {
  const base = estimateTokens(content);
  const factor = COMPRESSION_FACTORS[chunkType as ChunkType] ?? 1.0;
  return Math.ceil(base * factor);
}
