// Mirror of muninn/packages/rag/src/ingestion/cleaner.ts.
// Sync manually when Muninn changes — see DRIFT.md.
// Only classifyBlock and BOILERPLATE_PATTERNS are used by Huginn.

export interface CleanerOptions {
  stripHeaders?: boolean;
  stripFooters?: boolean;
  stripBoilerplate?: boolean;
}

// Normalize raw text extracted by Tika (PDF/DOCX/XLSX).
// Must run before any further processing so chunks and embeddings never see corrupted input.
function normalizeExtractedText(text: string): string {
  return (
    text
      // NFKC: decompose ligatures (fi-ligature->fi, ff->ff), normalize compatibility equivalents
      .normalize("NFKC")
      // Non-characters and BOM variants that appear in corrupt PDF encodings (U+FFFD/FFFE/FFFF)
      .replace(/[�￾￿]/g, "")
      // Soft hyphen (U+00AD) — invisible discretionary hyphen, confuses tokenizers
      .replace(/­/g, "")
      // Hard line-break hyphenation from PDF layout: "Brucken-\nbau" -> "Bruckenbau"
      .replace(/([\p{L}])-\r?\n\s*([\p{L}])/gu, "$1$2")
      // ASCII C0 control chars (preserve \t=0x09, \n=0x0A, \r=0x0D)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
      // Unicode C1 control chars (common in mis-decoded Latin-1 PDFs)
      .replace(/[-]/g, " ")
      // Lone surrogates from broken UTF-16 (some older PDF generators)
      .replace(/[\uD800-\uDFFF]/g, " ")
      // Zero-width spaces, bidi overrides, word joiners, BOM (U+FEFF)
      .replace(/[​-‏‪-‮⁠-⁤﻿]/g, "")
      // Collapse runs of whitespace within a line to a single space (keep newlines)
      .replace(/[^\S\n]+/g, " ")
      // Collapse 3+ consecutive blank lines to 2
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// Patterns that identify boilerplate lines in German technical docs
const BOILERPLATE_PATTERNS = [
  /^seite\s+\d+\s*(von\s+\d+)?$/i,         // "Seite 3 von 12"
  /^-\s*\d+\s*-$/,                           // "- 3 -"
  /^\d+\s*\/\s*\d+$/,                        // "3/12"
  /^vertraulich$/i,
  /^confidential$/i,
  /^intern$/i,
  /^propriet[äa]r$/i,
  /^alle\s+rechte\s+vorbehalten/i,
  /^©\s*\d{4}/,
  /^copyright\s+\d{4}/i,
  /^stand:\s*\d{2}\.\d{2}\.\d{4}$/i,        // "Stand: 01.01.2024" in isolation
  /^(dokument|datei|version|revision)[-:\s]+[^\n]{0,30}$/i, // standalone metadata lines
];

// Patterns that identify repeated headers/footers (lines appearing frequently across pages)
const HEADER_FOOTER_MIN_OCCURRENCES = 3;

import { estimateTokens, estimateChunkTokens } from "./token-estimator.ts";

export interface CleaningAudit {
  removedBoilerplate: Array<{ line: string; pattern: string }>;
  removedRepeated: Array<{ line: string; count: number }>;
  tokensLostNormalization: number;
  tokensLostBoilerplate: number;
  tokensLostRepeated: number;
}

export async function cleanContent(
  content: string,
  _mimeType: string,
  opts: CleanerOptions = {},
): Promise<{ cleaned: string; audit: CleaningAudit }> {
  const {
    stripHeaders     = true,
    stripFooters     = true,
    stripBoilerplate = true,
  } = opts;

  // 1. Normalize first
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

  let lines = normalized.split("\n");

  // Identify repeated lines (likely headers/footers)
  const lineCounts = new Map<string, number>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 3 && trimmed.length < 120) {
      lineCounts.set(trimmed, (lineCounts.get(trimmed) ?? 0) + 1);
    }
  }

  const repeatedLinesMap = new Map<string, number>(
    [...lineCounts.entries()]
      .filter(([, count]) => count >= HEADER_FOOTER_MIN_OCCURRENCES)
  );

  const cleanedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    let removed = false;

    if (stripBoilerplate) {
      for (const re of BOILERPLATE_PATTERNS) {
        if (re.test(trimmed)) {
          audit.removedBoilerplate.push({ line: trimmed, pattern: re.source });
          audit.tokensLostBoilerplate += estimateTokens(line);
          removed = true;
          break;
        }
      }
    }

    if (!removed && (stripHeaders || stripFooters)) {
      const count = repeatedLinesMap.get(trimmed);
      if (count !== undefined) {
        if (!audit.removedRepeated.some(r => r.line === trimmed)) {
          audit.removedRepeated.push({ line: trimmed, count });
        }
        audit.tokensLostRepeated += estimateTokens(line);
        removed = true;
      }
    }

    if (!removed) {
      cleanedLines.push(line);
    }
  }

  // Collapse more than 2 consecutive blank lines to 2
  const result = cleanedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { cleaned: result, audit };
}

// Classify a single text block — used by chunker for chunk_type assignment
export function classifyBlock(text: string): "header" | "spec_value" | "table_row" | "boilerplate" | "prose" {
  const trimmed = text.trim();

  if (BOILERPLATE_PATTERNS.some((re) => re.test(trimmed))) return "boilerplate";

  // Heading: short line, possibly numbered, possibly ALL CAPS or ending with colon
  if (
    trimmed.length < 100 &&
    (/^\d+(\.\d+)*\s+\S/.test(trimmed) ||    // "3.1 Anforderungen"
     /^[A-ZÄÖÜ][A-ZÄÖÜ\s]{5,}$/.test(trimmed) || // ALL CAPS
     (/[A-ZÄÖÜ]/.test(trimmed[0] ?? "") && trimmed.endsWith(":")))
  ) {
    return "header";
  }

  // Spec value: contains numeric measurements with units
  const specValuePattern = /[\d,]+\s*(mm|cm|m|kg|g|°C|°F|%|bar|N|kN|MPa|V|A|W|Hz|rpm|μm|±|∅)/i;
  if (specValuePattern.test(trimmed) && trimmed.length < 300) return "spec_value";

  // Table row: pipe-delimited or tab-separated or consistent multi-space columns
  if (/\t/.test(trimmed) || /\|/.test(trimmed) || /  {3,}/.test(trimmed)) return "table_row";

  return "prose";
}
