// Mirror of muninn/packages/rag/src/ingestion/chunker.ts.
// Sync manually when Muninn changes — see DRIFT.md.
// Used by Huginn Phase 4 (chunk-quality) to predict what Muninn will see.

import type { RawChunk } from "./types.ts";
import { CONFIG } from "./config.ts";
import { classifyBlock } from "./cleaner.ts";

type ChunkStrategy = "sliding_window" | "semantic" | "table_rows" | "passthrough";

const MIME_STRATEGY: Record<string, ChunkStrategy> = {
  "application/pdf": "semantic",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "semantic",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "table_rows",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "sliding_window",
  "text/plain": "sliding_window",
};

function resolveStrategy(mimeType: string): ChunkStrategy {
  return MIME_STRATEGY[mimeType] ?? "sliding_window";
}

export interface ChunkInput {
  content: string;
  mimeType: string;
  documentId: string;
}

export async function chunkDocument(input: ChunkInput): Promise<RawChunk[]> {
  const strategy = resolveStrategy(input.mimeType);
  switch (strategy) {
    case "semantic":    return chunkSemantic(input.content);
    case "table_rows":  return chunkTableRows(input.content);
    default:            return chunkSlidingWindow(input.content);
  }
}

// Split by character-based sliding window with whitespace-aware boundaries.
function chunkSlidingWindow(content: string): RawChunk[] {
  if (content.length === 0) return [];

  const size = CONFIG.CHUNK_SIZE;
  const overlap = CONFIG.CHUNK_OVERLAP;
  const step = Math.max(1, size - overlap);
  const result: RawChunk[] = [];

  for (let start = 0; start < content.length; start += step) {
    let end = Math.min(start + size, content.length);

    // If not at the end of content and would cut mid-word, scan back up to 30 chars for whitespace
    if (end < content.length && content[end] !== ' ' && content[end] !== '\n' && content[end] !== '\t') {
      const scanBack = Math.max(0, end - 30);
      let lastWhitespace = -1;
      for (let i = end - 1; i >= scanBack; i--) {
        if (content[i] === ' ' || content[i] === '\n' || content[i] === '\t') {
          lastWhitespace = i;
          break;
        }
      }
      if (lastWhitespace !== -1) {
        end = lastWhitespace + 1;
      }
    }

    const text = content.slice(start, end);
    if (text.trim().length > 0) {
      result.push({ content: text, chunkIndex: result.length, chunkType: classifyBlock(text) });
    }

    if (end >= content.length) break;
  }

  return result;
}

// Split text into sentences, then group sentences into chunks up to CHUNK_SIZE chars.
// Sentence-aware splitting with overlap handling.
function chunkSemantic(content: string): RawChunk[] {
  const sentences = splitIntoSentences(content);
  if (sentences.length === 0) return [];

  const result: RawChunk[] = [];
  let buffer: string[] = [];
  let bufferChars = 0;
  let overlapSentence: string | null = null;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.join(" ");
    result.push({ content: text, chunkIndex: result.length, chunkType: classifyBlock(text) });

    // Set up overlap for next chunk
    const lastSentence = buffer[buffer.length - 1] ?? "";
    if (lastSentence.length > 0 && lastSentence.length <= CONFIG.CHUNK_OVERLAP) {
      overlapSentence = lastSentence;
    } else {
      overlapSentence = null;
    }

    buffer = [];
    bufferChars = 0;
  };

  for (const sentence of sentences) {
    // If single sentence exceeds chunk size, split it with sliding window
    if (sentence.length > CONFIG.CHUNK_SIZE) {
      flush();
      const subs = chunkSlidingWindow(sentence);
      for (const s of subs) {
        result.push({ ...s, chunkIndex: result.length });
      }
      overlapSentence = null;
      continue;
    }

    // Start new chunk with overlap sentence if available
    if (buffer.length === 0 && overlapSentence) {
      buffer.push(overlapSentence);
      bufferChars = (overlapSentence as string).length;
      overlapSentence = null;
    }

    // Check if adding this sentence would exceed chunk size
    const newChars = bufferChars + (buffer.length > 0 ? 1 : 0) + sentence.length; // +1 for space

    if (newChars > CONFIG.CHUNK_SIZE && buffer.length > 0) {
      flush();
      buffer.push(sentence);
      bufferChars = sentence.length;
    } else {
      buffer.push(sentence);
      bufferChars = newChars;
    }
  }

  flush();
  return result;
}

function splitIntoSentences(content: string): string[] {
  // First split by paragraph breaks (always end sentence groups)
  const paragraphs = content.split(/\n{2,}/);
  const sentences: string[] = [];

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) continue;

    // Split paragraph into sentences
    const parts = trimmed.split(/([.!?])\s+(?=[A-ZÄÖÜ])/);

    let currentSentence = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (i % 2 === 0) {
        // Text part
        currentSentence += part;
      } else {
        // Punctuation part
        currentSentence += part;
        if (currentSentence.trim().length > 0) {
          sentences.push(currentSentence.trim());
        }
        currentSentence = "";
      }
    }

    // Add remaining text as a sentence
    if (currentSentence.trim().length > 0) {
      sentences.push(currentSentence.trim());
    }
  }

  return sentences.filter(s => s.length > 0);
}

// Groups consecutive table-like lines together; prose sections go through sliding_window.
function chunkTableRows(content: string): RawChunk[] {
  const lines      = content.split("\n");
  const result: RawChunk[] = [];
  const tableBuf: string[] = [];
  const proseBuf: string[] = [];
  const TABLE_LINE = /\t|\||\s{3,}/;

  const getTableBufferSize = () => tableBuf.join("\n").length;

  const flushTable = () => {
    if (tableBuf.length === 0) return;
    const text = tableBuf.join("\n");
    result.push({ content: text, chunkIndex: result.length, chunkType: "table_row" });
    tableBuf.splice(0, tableBuf.length);
  };

  const flushProse = () => {
    if (proseBuf.length === 0) return;
    const text = proseBuf.join("\n").trim();
    proseBuf.splice(0, proseBuf.length);
    if (!text) return;
    for (const s of chunkSlidingWindow(text)) {
      result.push({ ...s, chunkIndex: result.length });
    }
  };

  for (const line of lines) {
    if (TABLE_LINE.test(line) && line.trim().length > 0) {
      flushProse();
      tableBuf.push(line);

      // Flush when total chars >= CHUNK_SIZE
      if (getTableBufferSize() >= CONFIG.CHUNK_SIZE) {
        flushTable();
      }
    } else {
      flushTable();
      proseBuf.push(line);
    }
  }

  flushTable();
  flushProse();
  return result;
}
