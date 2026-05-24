// src/debug/types.ts

export interface DecisionRecord {
  docId: string;
  // docType classification signals — all values are counts or booleans, no text content
  docTypeSignals: Record<string, number | boolean>;
  docTypeChosen: string;
  // OEM detection
  oemDetected: string;
  oemSource: string;
  // Chunk strategy (mirrors chunkStrategyReasoning.signals — no new data, surfaced for debug)
  chunkStrategyChosen: string;
  chunkStrategyConfidence: number;
  chunkStrategySignals: {
    headingCount: number;
    headingDepth: number;
    tableCount: number;
    isXlsx: boolean;
    pdfClassification: string;
  };
  // Version pair contributions: only pairs with score >= 5 (MEDIUM or HIGH)
  versionPairContributions?: Array<{
    partnerDocId: string;
    score: number;
    filenameNormalizedSimilarity: number;
    headingMinHashJaccard: number;
    semanticCosineSimilarity: number;
    structuralMatch: boolean;
    sameDirectory: boolean;
  }>;
}

export interface PatternCoverageEntry {
  patternName: string;   // source-code identifier, exempt from 60-char guard
  phase: "references" | "requirements";
  matchCount: number;
  matchedDocIds: string[];
  zeroMatch: boolean;
}

export interface LlmSampleRecord {
  docId: string;
  docType: string;
  regexCount: number;          // confirmed requirements from regex for this doc
  llmConfirmedCount: number;   // PLAUSIBLE verdicts from LLM for sampled sections
  llmRejectedCount: number;    // HIGH verdicts (LLM rejects regex count)
  llmRecoveredCount: number;   // LOW verdicts (LLM finds more than regex)
  delta: number;               // (rejected + recovered) / (confirmed + rejected + recovered)
  llmCallDurationMs: number;   // cumulative LLM time for this doc's sections
}

export interface ZeroOutputEntry {
  docId: string;
  docType: string;
  parseSuccess: boolean;
  requirementCount: number;
  referenceCount: number;
  tokenRetentionRate: number;
  likelyCause: "parse_failure" | "scanned_pdf" | "wrong_doc_type" | "regex_miss" | "unknown";
}
