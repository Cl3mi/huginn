// src/utils/chunk-filter.ts
export type ChunkFilterReason = "too_short" | "low_letter_ratio" | "high_punctuation";

export interface FilteredChunk {
  content: string;
  passed: boolean;
  rejectionReason?: ChunkFilterReason;
}

export function filterChunk(content: string): FilteredChunk {
  const t = content.trim();
  if (t.length < 20) {
    return { content, passed: false, rejectionReason: "too_short" };
  }
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  const total   = t.replace(/\s/g, "").length || 1;
  if (letters / total < 0.25) {
    return { content, passed: false, rejectionReason: "low_letter_ratio" };
  }
  const punct = (t.match(/[.,;:!?()\[\]{}"']/g) ?? []).length;
  if (punct / total > 0.4) {
    return { content, passed: false, rejectionReason: "high_punctuation" };
  }
  return { content, passed: true };
}
