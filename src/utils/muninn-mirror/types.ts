// Mirror of muninn/packages/core/src/types.ts (subset used by chunker).
// Sync manually when Muninn changes — see DRIFT.md.

export type ChunkType = "prose" | "header" | "spec_value" | "table_row" | "boilerplate";

export interface RawChunk {
  content: string;
  chunkIndex: number;
  chunkType: ChunkType;
}
