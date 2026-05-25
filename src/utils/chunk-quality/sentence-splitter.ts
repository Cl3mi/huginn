// Wrapper around `compromise` for sentence boundary detection.
// Used by Tier 1 sentenceBoundaryQuality metric. Handles German and English.

import nlp from "compromise";

export interface SentenceBoundary {
  text: string;
  startsCleanly: boolean;  // begins with capital letter (incl. Ä Ö Ü)
  endsCleanly:   boolean;  // ends with terminal punctuation . ! ? : ;
}

export function analyzeBoundaries(text: string): { first: SentenceBoundary; last: SentenceBoundary } | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  let sentences: string[];
  try {
    const doc = nlp(trimmed);
    sentences = doc.sentences().out("array") as string[];
  } catch {
    return null;
  }

  if (sentences.length === 0) return null;

  const firstText = sentences[0] ?? "";
  const lastText = sentences[sentences.length - 1] ?? "";

  return {
    first: {
      text: firstText,
      startsCleanly: /^[A-ZÄÖÜ]/.test(firstText),
      endsCleanly:   /[.!?:;]\s*$/.test(firstText),
    },
    last: {
      text: lastText,
      startsCleanly: /^[A-ZÄÖÜ]/.test(lastText),
      endsCleanly:   /[.!?:;]\s*$/.test(lastText),
    },
  };
}
