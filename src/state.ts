// Single source of truth passed between all phases.
// Each phase reads from previous phases' output and appends its own.

import type { SectorProfile, CompanyIdentity } from "./profiles/types.ts";
import { automotiveDe } from "./profiles/automotive.ts";
import type { DecisionRecord, PatternCoverageEntry, LlmSampleRecord, ZeroOutputEntry } from "./debug/types.ts";

export interface OriginSignal {
  signal: string;                          // e.g. "path_segment_match"
  direction: "internal" | "external";
  weight: number;
}

export interface OriginClassification {
  result: "internal" | "external" | "unknown";
  internalScore: number;
  externalScore: number;
  confidence: "high" | "medium" | "low" | "none";
  signals: OriginSignal[];
}

export interface FileEntry {
  id: string;                    // sequential, e.g. "doc-001"
  path: string;                  // relative to DOCUMENTS_ROOT
  absolutePath: string;
  filename: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  modifiedAt: Date;
  createdAt: Date;
  depth: number;
  pathSegments: string[];        // split path for folder structure inference
  inferredCustomer?: string;
  inferredProject?: string;
  inferredDocumentCategory?: "rfq" | "quotation"; // detected from path segment (e.g. rfq/, quotations/)
  documentOrigin?: "internal" | "external" | "unknown";   // set by Phase 2 classifier
}

export interface HeadingNode {
  level: number;                 // 1-6
  text: string;                  // ONLY headings, never paragraph content
  numbering?: string;            // "4.2.1" if detected
  childCount: number;
  approximateTokens: number;
}

export interface ParserComparison {
  officeParserChars: number;
  tikaChars: number;
  charDeltaPercent: number;
  headingCountDelta: number;
  divergenceLevel: "none" | "minor" | "major";
}

export interface ParsedDocument extends FileEntry {
  charCount: number;
  tokenCountEstimate: number;
  pageCount?: number;
  language: string;              // detected via franc
  headings: HeadingNode[];
  hasNumberedHeadings: boolean;
  tableCount: number;
  parserUsed: "officeparser" | "tika";
  parserComparisonResult?: ParserComparison;
  isScannedPdf: boolean;
  isOcrRequired: boolean;
  // Three-tier PDF classification
  pdfClassification?: "fully_scanned" | "hybrid" | "native" | "not_pdf";
  imageCount?: number;           // embedded image count (PDFs only, from Tika)
  // Per-page scanned analysis (PDFs only)
  scannedPageRatio?: number;     // fraction of pages detected as image-only (0.0–1.0)
  scannedPageIndices?: number[]; // 1-indexed page numbers detected as image-only
  parseSuccess: boolean;
  parseFailureReason?: "empty_extraction" | "tika_error" | "zero_pages" | "garbled_encoding";
  dateSource?: "filename" | "docx_core_xml" | "pdf_metadata" | "mtime"; // kept for Phase 4 compatibility
  dateSignals: DateSignals;      // used by Phase 4 for bestDate ordering
  // Runtime cache — set in Phase 2, consumed by Phases 3/5/6. NEVER serialized to JSON.
  textContent?: string;
  // Runtime hint — set in Phase 2 from Tika PDF metadata. NEVER serialized to JSON.
  pdfAuthorHint?: string;
  // Classification result — set by Phase 2 classifier. Serialized to JSON.
  originClassification?: OriginClassification;
  requirementQuality?: { confirmed: number; negated: number; uncertain: number; raw: number }; // set in Phase 6
  // RAG: Direct chunking strategy signal for downstream ingestion pipeline
  recommendedChunkStrategy: "heading_sections" | "table_rows" | "sliding_window";
  chunkStrategyReasoning: ChunkStrategyReasoning;
  // RAG: Whether requirement metadata from this doc is trustworthy for retrieval filtering
  requirementMetadataReliable: boolean;
  detectedOem?: "mercedes" | "bmw" | "audi" | "unknown";
  oemSource?: "folder" | "document_internal" | "reconciled";
  detectedDocType?: "lastenheft" | "pflichtenheft" | "angebot" | "abweichliste" | "norm" | "qualitätsvorgabe" | "pruefspezifikation" | "testbericht" | "sla" | "lessons_learned" | "fmea" | "audit" | "planning" | "8d_report" | "empb" | "aenderungsantrag" | "kontrollplan" | "serienfreigabe" | "reklamation" | "arbeitsanweisung" | "protokoll" | "handbuch" | "other";
}

export interface StructuralFingerprint {
  h1Count: number;
  h2Count: number;
  h3Count: number;
  h4PlusCount: number;
  tableCount: number;
  pageCount: number;
  tokenCountEstimate: number;
  hasNumberedHeadings: boolean;
}

export interface RequirementDensityVector {
  mandatoryPerPage:   number;  // was mussPerPage
  recommendedPerPage: number;  // was sollPerPage
  permittedPerPage:   number;  // was kannPerPage
  informativePerPage: number;  // was informativPerPage
  quantitativeValuesPerPage: number;
  entityRefPerPage:   number;  // was fikbReferencesPerPage — generic OEM/entity IDs
}

export interface DocumentFingerprint {
  docId: string;
  structural: StructuralFingerprint;
  headingMinHash: Uint32Array;   // 128 hash values
  semanticEmbedding?: Float32Array; // 1024-dim BGE-M3 (optional if Ollama unavailable)
  requirementDensity: RequirementDensityVector;
  sectionEmbeddings?: Array<{ headingPath: string; embedding: Float32Array }>;
}

export interface VersionPair {
  docA: string;
  docB: string;
  signals: {
    filenameNormalizedSimilarity: number;
    structuralMatch: boolean;
    headingMinHashJaccard: number;
    semanticCosineSimilarity: number;
    sameDirectory: boolean;
    modifiedDateDeltaDays: number;
  };
  score: number;                 // 0-12
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NOT_A_PAIR";
  likelyNewer: "A" | "B" | "UNKNOWN";
  versionPairFlag?: "template_reuse_suspected";
}

export interface ExtractedReference {
  docId: string;
  type: "iso_norm" | "din_norm" | "en_norm" | "vda_norm" | "iatf_norm" | "quality_spec" | "chapter_ref" | "doc_ref" | "fikb" | "kb_master";
  rawText: string;               // exact match from regex (short string, not content)
  normalized?: string;           // LLM-normalized form, e.g. "ISO 9001:2015"
  sectionContext: string;        // heading where found (NOT paragraph text)
  resolvedToDocId?: string;
  resolutionMethod?: "exact" | "fuzzy" | "unresolved" | "external_norm";
  resolutionClassification?: "likely_missing_from_corpus" | "likely_matcher_failure";
  normalizationConfidence?: "certain" | "uncertain";
}

export interface ExtractedRequirement {
  docId: string;
  sectionHeading: string;        // which section (heading only)
  type: "MANDATORY" | "RECOMMENDED" | "PERMITTED" | "INFORMATIVE" | "DECLARATIVE";
  category: "Material" | "Tolerance" | "Testing" | "Packaging" | "Delivery" | "Safety" | "Other";
  hasQuantitativeValue: boolean;
  quantitativeValueCount?: number;
  quantitativeUnitTypes?: string[];  // unit type tokens, e.g. ["mm", "°C"] — no spec values
  linkedNorm?: string;
  linkedEntityRef?: string;      // OEM/entity requirement ID if present (e.g. FIKB, KB_Master)
  isSafetyRelevant: boolean;
  source?: "regex" | "llm_recovery" | "regex_unconfirmed";
}

export interface DateSignals {
  mtime: string;                    // ISO date string (filesystem mtime)
  ctime: string;                    // ISO date string (filesystem ctime)
  mtimeReliable: boolean;           // false when mtime === ctime (NTFS/SMB copy artifact)
  documentInternalDate?: string;    // ISO date found in document text or metadata
  internalDateSource?: "stand_pattern" | "revision_pattern" | "docx_core_xml" | "pdf_metadata" | "filename";
  bestDate: string;                 // Most reliable date: documentInternalDate ?? ctime
}

export interface ChunkStrategyReasoning {
  recommended: "heading_sections" | "table_rows" | "sliding_window";
  confidence: number;            // 0.0 – 1.0
  signals: {
    headingCount: number;
    headingDepth: number;         // max heading level (1-6), 0 if none
    avgTokensPerSection: number;  // 0 if no headings
    tableCount: number;
    hasNestedHeadings: boolean;
    isXlsx: boolean;
    pdfClassification: string;
  };
  alternativeConsidered?: "table_rows" | "sliding_window" | "heading_sections";
  alternativeReason?: string;    // ≤ 120 chars — why the alternative was considered
}

export interface ConsistencyCheck {
  checkName: string;
  passed: boolean;
  value: number;
  threshold: number;
  severity: "INFO" | "WARNING" | "CRITICAL";
  interpretation: string;
}

// ── Phase 4: Chunk Quality ───────────────────────────────────────────────────

export type ChunkQualityBudget = "fast" | "normal" | "full";

export interface ChunkQualityMetricValue {
  score: number | null;
  reason?: string;  // ≤120 chars; only when null or score < 0.4
}

export interface ChunkQualityPerDocTier1 {
  sizeFit:                 { mean: number; p10: number };
  sentenceBoundaryQuality: { mean: number; p10: number };
  crossReferenceCut:       { mean: number; p10: number };
  tableCut:                { mean: number | null; p10: number | null };
  headerPollution:         { mean: number; p10: number };
  contentScore:            { mean: number; p10: number };
}

export interface ChunkQualityPerDocTier2 {
  coherenceDrop:      { mean: number; p10: number } | null;
  intraChunkCohesion: { mean: number; p10: number; nMeasurable: number } | null;
  centroidDistance:   { mean: number; p10: number };
}

export interface ChunkQualityPerDoc {
  docId: string;
  chunkCountTotal:    number;
  chunkCountEmbedded: number;
  budgetMode:         ChunkQualityBudget;
  budgetCapHit:       boolean;
  tier1:              ChunkQualityPerDocTier1;
  tier2:              ChunkQualityPerDocTier2 | null;
  chunkQualityIndex:  { mean: number; p10: number };
  bucketCounts:       { good: number; acceptable: number; poor: number };
  weakestLinks:       string[];  // top 3, each ≤120 chars
}

export interface ChunkQualityCorpusSummary {
  budgetMode:              ChunkQualityBudget;
  totalChunks:             number;
  totalChunksEmbedded:     number;
  tokenWeightedIndexMean:  number;
  bucketShare:             { good: number; acceptable: number; poor: number };
  worstDocsByP10:          Array<{ docId: string; p10: number; primaryWeakness: string }>;
  weakestCorpusMetrics:    Array<{ metric: string; mean: number }>;
  embeddingsCacheStats:    { uniqueChunks: number; cacheHits: number; cacheMisses: number };
  bgeM3NormalizationCheck: { sampleSize: number; allNormalized: boolean; maxDeviation: number };
}

export interface ChunkQualityReport {
  perDoc:      ChunkQualityPerDoc[];
  corpus:      ChunkQualityCorpusSummary;
  generatedAt: Date;
}

// ── Phase 9: Ingestion Projection ────────────────────────────────────────────

export interface DocumentIngestionProjection {
  docId: string;
  tokenWaterfall: {
    raw: number;
    afterNormalization: number;
    afterCleaning: number;
    afterChunking: number;
    afterFilter: number;
    embeddable: number;
  };
  cleaningLoss: {
    normalization: number;
    boilerplate: number;
    repeatedLines: number;
  };
  filterLoss: {
    byLength: number;
    byLetterRatio: number;
    byPunctuation: number;
  };
  predictedChunkCount: number;
  predictedFilteredChunkCount: number;
  blockTypeDistribution: {
    prose: number;
    header: number;
    specValue: number;
    tableRow: number;
    boilerplate: number;
  };
  predictedQualityDistribution: {
    high: number;
    medium: number;
    low: number;
  };
  tokenRetentionRate: number;
}

export interface CorpusIngestionSummary {
  totalTokensRaw: number;
  totalTokensEmbeddable: number;
  overallRetentionRate: number;
  lossWaterfall: Array<{ stage: string; tokensLost: number; percentOfRaw: number }>;
  byDocType: Record<string, {
    docCount: number;
    retentionRate: number;
    avgQualityHigh: number;
    dominantChunkStrategy: string;
    avgPredictedChunkCount: number;
  }>;
  highRiskDocs: Array<{
    docId: string;
    retentionRate: number;
    primaryLossCause: "ocr" | "boilerplate" | "filter" | "normalization";
  }>;
}

export interface DiscoveredBoilerplatePattern {
  normalizedForm: string;
  occurrenceCount: number;
  documentCount: number;
  suggestedRegex: string;
  alreadyCovered: boolean;
  tokensAtRisk: number;
}

export interface CorpusBoilerplateSummary {
  totalCandidatePatterns: number;
  newPatterns: number;
  suppressedPatterns: number;
  totalTokensRecoverable: number;
}

export interface MuninnConfigRecommendation {
  parameter: string;
  currentDefault: string | number;
  recommendedValue: string | number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reasoning: string;
  evidenceDocCount: number;
  affectedTokenShare: number;
}

export interface DomainProfile {
  detectedLanguage: "de" | "en" | "fr" | "mixed";
  requirementLanguageFamily: "german_modal" | "rfc2119" | "legal" | "french_modal" | "none";
  requirementLanguageCoverage: number;
  discoveredReferenceFormats: Array<{
    pattern: string;
    occurrenceCount: number;
    documentCount: number;
    alreadyExtracted: boolean;
  }>;
  dominantUnitFamily: "mechanical" | "electrical" | "pharma" | "financial" | "logistics" | "mixed" | "none";
  unitFamilyCoverage: number;
  qualityScorerProfile: "automotive_de" | "generic_de" | "generic_en" | "adapted";
}

export interface ScannerState {
  scanId: string;
  startedAt: Date;
  completedAt?: Date;
  documentsRoot: string;
  sectorProfile: SectorProfile;
  companyIdentity: CompanyIdentity | null;
  files: FileEntry[];
  parsed: ParsedDocument[];
  fingerprints: DocumentFingerprint[];
  versionPairs: VersionPair[];
  versionChains: string[][];
  references: ExtractedReference[];
  referenceGraph: Map<string, string[]>; // docId → [referenced docIds]
  requirements: ExtractedRequirement[];
  llmValidation: {
    sampledDocIds: string[];
    regexVsLlmDelta: number;
    confidenceInterval: { lower: number; upper: number };
    byDocumentType?: Record<string, { sampled: number; avgDelta: number }>;
    llmRecoveredCount?: number;  // requirements found by LLM but missed by regex
    llmRejectedCount?: number;   // requirements rejected by LLM but found by regex
  };
  consistencyChecks: ConsistencyCheck[];
  // Phase 4: Chunk Quality
  chunkQuality: ChunkQualityReport;
  // Phase 9: Ingestion Projection
  ingestionProjections: DocumentIngestionProjection[];
  corpusIngestionSummary: CorpusIngestionSummary;
  discoveredBoilerplatePatterns: DiscoveredBoilerplatePattern[];
  muninnConfigRecommendations: MuninnConfigRecommendation[];
  domainProfile: DomainProfile;
  folderStructureInference: {
    likelyPattern: string;       // e.g. "project/doc-category/docs" or "customer/project/offer-version/docs"
    confidence: number;
    customerNames: string[];
    projectNames: string[];
    documentCategories: string[]; // e.g. ["rfq", "quotation"]
  };
  // Optional debug fields — undefined = category disabled for this scan
  decisionAudit?: Map<string, DecisionRecord>;
  patternCoverage?: PatternCoverageEntry[];
  llmTrace?: LlmSampleRecord[];
  zeroOutputDocs?: ZeroOutputEntry[];
}

export function createInitialState(
  scanId: string,
  documentsRoot: string,
  profile: SectorProfile = automotiveDe,
  companyIdentity: CompanyIdentity | null = null,
): ScannerState {
  return {
    scanId,
    startedAt: new Date(),
    documentsRoot,
    sectorProfile: profile,
    companyIdentity,
    files: [],
    parsed: [],
    fingerprints: [],
    versionPairs: [],
    versionChains: [],
    references: [],
    referenceGraph: new Map(),
    requirements: [],
    llmValidation: {
      sampledDocIds: [],
      regexVsLlmDelta: 0,
      confidenceInterval: { lower: 0, upper: 0 },
    },
    consistencyChecks: [],
    chunkQuality: {
      perDoc: [],
      corpus: {
        budgetMode: "normal",
        totalChunks: 0,
        totalChunksEmbedded: 0,
        tokenWeightedIndexMean: 0,
        bucketShare: { good: 0, acceptable: 0, poor: 0 },
        worstDocsByP10: [],
        weakestCorpusMetrics: [],
        embeddingsCacheStats: { uniqueChunks: 0, cacheHits: 0, cacheMisses: 0 },
        bgeM3NormalizationCheck: { sampleSize: 0, allNormalized: true, maxDeviation: 0 },
      },
      generatedAt: new Date(0),
    },
    ingestionProjections: [],
    corpusIngestionSummary: {
      totalTokensRaw: 0,
      totalTokensEmbeddable: 0,
      overallRetentionRate: 0,
      lossWaterfall: [],
      byDocType: {},
      highRiskDocs: [],
    },
    discoveredBoilerplatePatterns: [],
    muninnConfigRecommendations: [],
    domainProfile: {
      detectedLanguage: "de",
      requirementLanguageFamily: "none",
      requirementLanguageCoverage: 0,
      discoveredReferenceFormats: [],
      dominantUnitFamily: "none",
      unitFamilyCoverage: 0,
      qualityScorerProfile: "automotive_de",
    },
    folderStructureInference: {
      likelyPattern: "unknown",
      confidence: 0,
      customerNames: [],
      projectNames: [],
      documentCategories: [],
    },
  };
}
