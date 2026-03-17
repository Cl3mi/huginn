export const CONFIG = {
  // Paths
  documentsRoot: process.env["DOCUMENTS_ROOT"] || "/documents",
  reportOutput: process.env["REPORT_OUTPUT"] || "/reports",

  // Services
  tikaUrl: process.env["TIKA_URL"] || "http://tika:9998",
  ollamaUrl: process.env["OLLAMA_URL"] || "http://ollama:11434",
  ollamaEmbedModel: process.env["OLLAMA_EMBED_MODEL"] || "bge-m3",
  ollamaChatModel: process.env["OLLAMA_CHAT_MODEL"] || "llama3.1:8b",

  // Thresholds
  llmSampleRate: parseFloat(process.env["LLM_SAMPLE_RATE"] || "0.05"),
  parserDivergenceThreshold: 0.20,  // 20% char count difference triggers alert
  scannedPdfCharsPerPage: 100,      // below this = likely scanned
  ocrRequiredCharsPerPage: 50,      // below this = definitely needs OCR
  versionPairMinScore: 7,           // out of 12 for HIGH confidence
  embeddingBatchSize: 10,
  sectionEmbeddingsEnabled: process.env["SECTION_EMBEDDINGS"] === "1", // GAP-03: opt-in
  maxStringLengthInReport: 120,     // hard guard against content leakage

  // Supported file extensions
  officeExtensions: [".docx", ".xlsx", ".pptx"] as const,
  pdfExtensions: [".pdf"] as const,
  allExtensions: [".docx", ".xlsx", ".pptx", ".pdf"] as const,

  // OEM-specific identifier patterns (CRITICAL for requirement tracking)
  oemPatterns: {
    mercedes: {
      name: "Mercedes-Benz",
      requirementId: /\bFIKB[-\s]?\d{3,6}\b/gi,
      // FIKB = Fachinhalt Kraftstoffbehälter
      testResultStatus: /\b(i\.?\s?O\.?|n\.?\s?i\.?\s?O\.?|Abstimmung\s+erforderlich)\b/gi,
    },
    bmw: {
      name: "BMW",
      requirementId: /\bKB[-_]?Master[-_]?(?:Nummer|Nr\.?)[-\s:]?\s*\d{3,8}\b/gi,
      qualitySpec: /\bQV[-\s]?\d{3,6}\b/gi,
    },
    audi: {
      name: "Audi",
      requirementId: /\bKB[-_]?Master[-_]?(?:Nummer|Nr\.?)[-\s:]?\s*\d{3,8}\b/gi,
    },
  },
} as const;
