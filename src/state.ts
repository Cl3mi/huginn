// Single source of truth passed between all phases.
// Each phase reads from previous phases' output and appends its own.

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
  depth: number;                 // directory depth from root
  pathSegments: string[];        // split path for folder structure inference
  inferredCustomer?: string;     // detected from path or content
  inferredProject?: string;      // detected from path or content
}

export interface HeadingNode {
  level: number;                 // 1-6
  text: string;                  // heading text (ONLY headings, never paragraph content)
  numbering?: string;            // "4.2.1" if detected
  childCount: number;            // number of sub-headings
  approximateTokens: number;     // estimated tokens in this section
}

export interface ParserComparison {
  officeParserChars: number;
  tikaChars: number;
  charDeltaPercent: number;
  headingCountDelta: number;
  divergenceLevel: "none" | "minor" | "major";
}

export interface ParsedDocument extends FileEntry {
  // Phase 2 output
  charCount: number;
  tokenCountEstimate: number;
  pageCount?: number;
  language: string;              // detected via franc
  headings: HeadingNode[];       // hierarchical heading tree
  hasNumberedHeadings: boolean;
  tableCount: number;
  parserUsed: "officeparser" | "tika";
  parserComparisonResult?: ParserComparison;
  isScannedPdf: boolean;
  isOcrRequired: boolean;
  // IMP-01: Three-tier PDF classification
  pdfClassification?: "fully_scanned" | "hybrid" | "native" | "not_pdf";
  imageCount?: number;           // embedded image count (PDFs only, from Tika)
  // GAP-02: Per-page scanned analysis (PDFs only)
  scannedPageRatio?: number;     // fraction of pages detected as image-only (0.0–1.0)
  scannedPageIndices?: number[]; // 1-indexed page numbers detected as image-only
  // IMP-02: Parse success tracking
  parseSuccess: boolean;         // charCount > 100
  parseFailureReason?: "empty_extraction" | "tika_error" | "zero_pages";
  // IMP-09: Date source reliability (kept for Phase 4 compatibility)
  dateSource?: "filename" | "docx_core_xml" | "pdf_metadata" | "mtime";
  // GAP-07: Consolidated date signals — used by Phase 4 for bestDate ordering
  dateSignals: DateSignals;
  // IMP-07: Requirement quality counters (set in Phase 6)
  requirementQuality?: { confirmed: number; negated: number; uncertain: number; raw: number };
  // RAG: Direct chunking strategy signal for downstream ingestion pipeline
  recommendedChunkStrategy: "heading_sections" | "table_rows" | "sliding_window";
  chunkStrategyReasoning: ChunkStrategyReasoning;
  // RAG: Whether requirement metadata from this doc is trustworthy for retrieval filtering
  requirementMetadataReliable: boolean;
  detectedOem?: "mercedes" | "bmw" | "audi" | "unknown";
  oemSource?: "folder" | "document_internal" | "reconciled"; // GAP-06
  detectedDocType?: "lastenheft" | "angebot" | "abweichliste" | "norm" | "pruefspezifikation" | "testbericht" | "sla" | "lessons_learned" | "fmea" | "audit" | "planning" | "other";
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
  mussPerPage: number;
  sollPerPage: number;
  kannPerPage: number;
  informativPerPage: number;
  quantitativeValuesPerPage: number;
  fikbReferencesPerPage: number; // OEM requirement IDs
}

export interface DocumentFingerprint {
  docId: string;
  structural: StructuralFingerprint;
  headingMinHash: Uint32Array;   // 128 hash values
  semanticEmbedding?: Float32Array; // 1024-dim BGE-M3 (optional if Ollama unavailable)
  requirementDensity: RequirementDensityVector;
  sectionEmbeddings?: Array<{ headingPath: string; embedding: Float32Array }>; // GAP-03
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
  versionPairFlag?: "template_reuse_suspected"; // IMP-03
}

export interface ExtractedReference {
  docId: string;
  type: "iso_norm" | "din_norm" | "en_norm" | "vda_norm" | "iatf_norm" | "quality_spec" | "chapter_ref" | "doc_ref" | "fikb" | "kb_master";
  rawText: string;               // exact match from regex (short string, not content)
  normalized?: string;           // LLM-normalized form, e.g. "ISO 9001:2015"
  sectionContext: string;        // heading where found (NOT paragraph text)
  resolvedToDocId?: string;      // if matched to another doc in corpus
  resolutionMethod?: "exact" | "fuzzy" | "unresolved" | "external_norm";
  resolutionClassification?: "likely_missing_from_corpus" | "likely_matcher_failure"; // GAP-04
  normalizationConfidence?: "certain" | "uncertain"; // GAP-10
}

export interface ExtractedRequirement {
  docId: string;
  sectionHeading: string;        // which section (heading only)
  type: "MUSS" | "SOLL" | "KANN" | "INFORMATIV" | "DEKLARATIV"; // GAP-01
  category: "Material" | "Toleranz" | "Prüfung" | "Verpackung" | "Lieferung" | "Sicherheit" | "Sonstiges";
  hasQuantitativeValue: boolean;
  quantitativeValueSummary?: string; // e.g. "20 N/mm²" — short, not a sentence
  linkedNorm?: string;           // if requirement references a norm
  linkedFikb?: string;           // FIKB/KB_Master number if present
  isSafetyRelevant: boolean;     // flagged if section mentions safety keywords
  source?: "regex" | "llm_recovery" | "regex_unconfirmed"; // GAP-09
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
    headingDepth: number;         // max heading level found (1–6), 0 if none
    avgTokensPerSection: number;  // 0 if no headings
    tableCount: number;
    hasNestedHeadings: boolean;   // any heading at level > 2
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

export interface ScannerState {
  scanId: string;
  startedAt: Date;
  completedAt?: Date;
  documentsRoot: string;
  files: FileEntry[];
  parsed: ParsedDocument[];
  fingerprints: DocumentFingerprint[];
  versionPairs: VersionPair[];
  versionChains: string[][];     // ordered arrays of doc IDs
  references: ExtractedReference[];
  referenceGraph: Map<string, string[]>; // docId → [referenced docIds]
  requirements: ExtractedRequirement[];
  llmValidation: {
    sampledDocIds: string[];
    regexVsLlmDelta: number;     // percentage difference
    confidenceInterval: { lower: number; upper: number };
    byDocumentType?: Record<string, { sampled: number; avgDelta: number }>; // IMP-04
    llmRecoveredCount?: number;  // GAP-09: requirements found by LLM but missed by regex
    llmRejectedCount?: number;   // GAP-09: requirements rejected by LLM but found by regex
  };
  consistencyChecks: ConsistencyCheck[];
  folderStructureInference: {
    likelyPattern: string;       // e.g. "customer/project/offer-version/docs"
    confidence: number;
    customerNames: string[];
    projectNames: string[];
  };
}

export function createInitialState(scanId: string, documentsRoot: string): ScannerState {
  return {
    scanId,
    startedAt: new Date(),
    documentsRoot,
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
    folderStructureInference: {
      likelyPattern: "unknown",
      confidence: 0,
      customerNames: [],
      projectNames: [],
    },
  };
}
