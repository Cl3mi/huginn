// Canonical types matching the actual serialized JSON from src/phases/8-report.ts
// Do NOT invent fields — every field here maps 1:1 to the serialized output.

export interface ReportData {
  scanId: string;
  startedAt: string;
  completedAt?: string;
  documentsRoot?: string;

  metadataQualityScore: {
    overall: number;           // 0–100
    interpretation: string;
    components: {
      parseSuccessRate?: number;
      headingExtractionConfidence?: number;
      requirementValidationDelta?: number;
      ocrWarningRate?: number;
      versionPairCalibrationStatus?: string;
      [key: string]: number | string | undefined;
    };
  };

  summary: {
    totalFiles: number;
    parsedFiles: number;
    parseFailures: number;
    byExtension: Record<string, number>;
    byDocType: Record<string, number>;
    byDocumentCategory: Record<string, number>;
    byOem: Record<string, number>;
    byLanguage: Record<string, number>;
    scannedPdfs: number;
    hybridPdfs: number;
    ocrRequired: number;
  };

  parseHealth: {
    failedFiles: Array<{ id: string; path: string; reason: string }>;
  };

  versionPairScoreHistogram: Record<string, number>;

  versionPairs: Array<{
    docA: string;
    docB: string;
    score: number;             // 0–12
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NOT_A_PAIR';
    likelyNewer: 'A' | 'B' | 'UNKNOWN';
    versionPairFlag?: 'template_reuse_suspected';
    signals?: {
      filenameNormalizedSimilarity: number;
      structuralMatch: boolean;
      headingMinHashJaccard: number;
      semanticCosineSimilarity: number;
      sameDirectory: boolean;
      modifiedDateDeltaDays: number;
    };
  }>;

  versionChains: string[][];

  references: Array<{
    docId: string;
    type: 'iso_norm' | 'din_norm' | 'en_norm' | 'vda_norm' | 'iatf_norm' | 'quality_spec' | 'chapter_ref' | 'doc_ref' | 'fikb' | 'kb_master';
    rawText: string;
    normalized?: string;
    sectionContext?: string;
    resolvedToDocId?: string;
    resolutionMethod?: 'exact' | 'fuzzy' | 'unresolved' | 'external_norm';
    resolutionClassification?: 'likely_missing_from_corpus' | 'likely_matcher_failure';
  }>;

  requirements: Array<{
    docId: string;
    sectionHeading: string;
    type: 'MUSS' | 'SOLL' | 'KANN' | 'INFORMATIV' | 'DEKLARATIV';
    category: 'Material' | 'Toleranz' | 'Prüfung' | 'Verpackung' | 'Lieferung' | 'Sicherheit' | 'Sonstiges';
    isSafetyRelevant: boolean;
    hasQuantitativeValue: boolean;
    linkedNorm?: string;
    source?: 'regex' | 'llm_recovery' | 'regex_unconfirmed';
  }>;

  consistencyChecks: Array<{
    checkName: string;
    passed: boolean;
    value: number;
    threshold: number;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    interpretation: string;
  }>;

  llmValidation?: {
    sampledDocIds: string[];
    regexVsLlmDelta: number;
    llmRecoveredCount?: number;
    llmRejectedCount?: number;
  };

  fingerprints?: Array<{
    docId: string;
    structural?: Record<string, number | boolean>;
    requirementDensity?: number;
    hasSemanticEmbedding?: boolean;
  }>;

  parsed?: Array<{
    id: string;
    filename: string;
    charCount?: number;
    tokenCountEstimate?: number;
    pageCount?: number;
    language?: string;
    headings?: Array<{
      level: number;
      text: string;
      numbering?: string;
      childCount: number;
      approximateTokens: number;
    }>;
    hasNumberedHeadings?: boolean;
    headingCount?: number;
    tableCount?: number;
    imageCount?: number;
    parserUsed?: string;
    isScannedPdf?: boolean;
    isOcrRequired?: boolean;
    pdfClassification?: string;
    scannedPageRatio?: number;
    parseSuccess?: boolean;
    parseFailureReason?: string;
    dateSource?: string;
    dateSignals?: {
      mtime?: string;
      ctime?: string;
      mtimeReliable?: boolean;
      documentInternalDate?: string;
      internalDateSource?: string;
      bestDate?: string;
    };
    requirementQuality?: {
      confirmed: number;
      negated: number;
      uncertain: number;
      raw: number;
    };
    recommendedChunkStrategy?: string;
    chunkStrategyReasoning?: {
      recommended: string;
      confidence: number;
      signals?: Record<string, number | boolean | string>;
    };
    requirementMetadataReliable?: boolean;
    detectedOem?: string;
    detectedDocType?: string;
  }>;

  files?: Array<{
    id: string;
    path: string;
    filename: string;
    extension: string;
    sizeBytes: number;
    sha256?: string;
    modifiedAt?: string;
    depth?: number;
    inferredCustomer?: string;
    inferredProject?: string;
    inferredDocumentCategory?: string;
  }>;
}

export const NORM_TYPES = new Set(['iso_norm', 'din_norm', 'en_norm', 'vda_norm', 'iatf_norm'] as const);
export const INTERNAL_REF_TYPES = new Set(['doc_ref', 'chapter_ref', 'fikb', 'kb_master'] as const);

export function isNormRef(type: string): boolean {
  return NORM_TYPES.has(type as never);
}

export function isResolved(resolutionMethod?: string): boolean {
  return resolutionMethod === 'exact' || resolutionMethod === 'fuzzy' || resolutionMethod === 'external_norm';
}

export function displayNormText(ref: { rawText: string; normalized?: string }): string {
  return ref.normalized ?? ref.rawText;
}
