import type { ChunkQualityBudget } from "../../state.ts";

export interface BudgetCaps {
  mode:             ChunkQualityBudget;
  maxChunksPerDoc:  number;  // Infinity means no cap
  maxCorpusChunks:  number;  // Infinity means no cap
}

export function resolveBudget(): BudgetCaps {
  const raw = (process.env["CHUNK_QUALITY_BUDGET"] ?? "normal").toLowerCase();
  const mode: ChunkQualityBudget =
    raw === "fast" || raw === "full" ? raw : "normal";

  switch (mode) {
    case "fast":   return { mode, maxChunksPerDoc: 30,       maxCorpusChunks: 2_000   };
    case "normal": return { mode, maxChunksPerDoc: 200,      maxCorpusChunks: 20_000  };
    case "full":   return { mode, maxChunksPerDoc: Infinity, maxCorpusChunks: Infinity };
  }
}

export function evenSample<T>(arr: T[], target: number): T[] {
  if (!isFinite(target) || arr.length <= target) return arr;
  if (target <= 0) return [];
  const step = arr.length / target;
  const out: T[] = [];
  for (let i = 0; i < target; i++) {
    const idx = Math.floor(i * step);
    const item = arr[idx];
    if (item !== undefined) out.push(item);
  }
  return out;
}
