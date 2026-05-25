// Mirror of muninn/packages/core/src/constants.ts (subset used by chunker).
// Sync manually when Muninn changes — see DRIFT.md.

export const CONFIG = {
  CHUNK_SIZE:    Number(process.env["CHUNK_SIZE"]    ?? "512"),
  CHUNK_OVERLAP: Number(process.env["CHUNK_OVERLAP"] ?? "64"),
} as const;
