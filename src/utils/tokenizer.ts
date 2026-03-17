// Token estimation without tiktoken dependency.
// IMP-08: Using 4.2 chars/token for German automotive text (BGE-M3 calibrated).
// German compound words (Sicherheitsanforderungen) are 1 whitespace token but 5-8 BPE tokens.
// English avg ~4.0, German technical ~4.2-4.5 due to compound words.
const CHARS_PER_TOKEN = 4.2;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Truncate text to approximately maxTokens tokens.
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = Math.ceil(maxTokens * CHARS_PER_TOKEN);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

// Split text into chunks of approximately chunkTokens tokens.
export function chunkByTokens(text: string, chunkTokens: number): string[] {
  const chunkChars = Math.ceil(chunkTokens * CHARS_PER_TOKEN);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkChars) {
    chunks.push(text.slice(i, i + chunkChars));
  }
  return chunks;
}
