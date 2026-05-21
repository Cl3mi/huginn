// src/utils/cleaner.ts
import { estimateTokens } from "./token-estimator.ts";

export interface CleaningAudit {
  removedBoilerplate: Array<{ line: string; pattern: string }>;
  removedRepeated: Array<{ line: string; count: number }>;
  tokensLostNormalization: number;
  tokensLostBoilerplate: number;
  tokensLostRepeated: number;
}

export const BOILERPLATE_PATTERNS: RegExp[] = [
  /^seite\s+\d+\s*(von\s+\d+)?$/i,
  /^-\s*\d+\s*-$/,
  /^\d+\s*\/\s*\d+$/,
  /^vertraulich$/i,
  /^confidential$/i,
  /^intern$/i,
  /^propriet[äa]r$/i,
  /^alle\s+rechte\s+vorbehalten/i,
  /^©\s*\d{4}/,
  /^copyright\s+\d{4}/i,
  /^stand:\s*\d{2}\.\d{2}\.\d{4}$/i,
  /^(dokument|datei|version|revision)[-:\s]+[^\n]{0,30}$/i,
];

const HEADER_FOOTER_MIN_OCCURRENCES = 3;

export function normalizeExtractedText(text: string): string {
  return text
    .normalize("NFKC")
    // Remove Unicode replacement character U+FFFD and BOM variants
    .replace(/�|￾|￿/g, "")
    // Remove soft hyphens (U+00AD)
    .replace(/­/g, "")
    // Repair hard hyphenation across lines: word- \n word => wordword
    .replace(/([\p{L}])-\r?\n\s*([\p{L}])/gu, "$1$2")
    // Remove C0 control characters (except \t=0x09 and \n=0x0A and \r=0x0D)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    // Remove lone surrogate code points
    .replace(/[\uD800-\uDFFF]/g, " ")
    // Collapse multiple spaces/tabs on a single line to one space
    .replace(/[^\S\n]+/g, " ")
    // Collapse 3+ consecutive newlines to exactly two
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanContent(content: string): { cleaned: string; audit: CleaningAudit } {
  const normalized = normalizeExtractedText(content);
  const tokensRaw = estimateTokens(content);
  const tokensNormalized = estimateTokens(normalized);

  const audit: CleaningAudit = {
    removedBoilerplate: [],
    removedRepeated: [],
    tokensLostNormalization: Math.max(0, tokensRaw - tokensNormalized),
    tokensLostBoilerplate: 0,
    tokensLostRepeated: 0,
  };

  const lines = normalized.split("\n");

  // Count line occurrences to detect repeated headers/footers
  const lineCounts = new Map<string, number>();
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 3 && t.length < 120) {
      lineCounts.set(t, (lineCounts.get(t) ?? 0) + 1);
    }
  }
  const repeated = new Map(
    [...lineCounts.entries()].filter(([, c]) => c >= HEADER_FOOTER_MIN_OCCURRENCES)
  );

  const cleanedLines: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let removed = false;

    for (const re of BOILERPLATE_PATTERNS) {
      if (re.test(t)) {
        audit.removedBoilerplate.push({ line: t.slice(0, 60), pattern: re.source });
        audit.tokensLostBoilerplate += estimateTokens(line);
        removed = true;
        break;
      }
    }

    if (!removed && repeated.has(t)) {
      const count = repeated.get(t)!;
      if (!audit.removedRepeated.some((r) => r.line === t)) {
        audit.removedRepeated.push({ line: t.slice(0, 60), count });
      }
      audit.tokensLostRepeated += estimateTokens(line);
      removed = true;
    }

    if (!removed) cleanedLines.push(line);
  }

  const cleaned = cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned, audit };
}

export function classifyBlock(
  text: string
): "header" | "spec_value" | "table_row" | "boilerplate" | "prose" {
  const t = text.trim();

  if (BOILERPLATE_PATTERNS.some((re) => re.test(t))) return "boilerplate";

  if (
    t.length < 100 &&
    (/^\d+(\.\d+)*\s+\S/.test(t) ||
      /^[A-ZÄÖÜ][A-ZÄÖÜ\s]{5,}$/.test(t) ||
      (/[A-ZÄÖÜ]/.test(t[0] ?? "") && t.endsWith(":")))
  )
    return "header";

  if (
    /[\d,]+\s*(mm|cm|m|kg|g|°C|°F|%|bar|N|kN|MPa|V|A|W|Hz|rpm|μm|±|∅)/i.test(t) &&
    t.length < 300
  )
    return "spec_value";

  if (/\t/.test(t) || /\|/.test(t) || / {3,}/.test(t)) return "table_row";

  return "prose";
}
