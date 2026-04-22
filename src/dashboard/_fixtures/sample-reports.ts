// Sample reports for testing dashboard generation and rendering

export const MINIMAL_REPORT = {
  scanId: 'SCAN-TEST-MINIMAL-001',
  timestamp: new Date().toISOString(),
  summary: {
    totalFiles: 0,
    parsedFiles: 0,
    versionPairs: 0,
    references: 0,
    requirements: 0,
  },
  parsed: [],
  versionPairs: [],
  references: [],
  requirements: [],
  consistencyChecks: {},
};

export const BASIC_REPORT = {
  scanId: 'SCAN-NOVA-2026-04-22',
  timestamp: '2026-04-22T10:30:45Z',
  summary: {
    totalFiles: 14,
    parsedFiles: 12,
    versionPairs: 9,
    references: 23,
    requirements: 156,
    mqScore: 82,
  },
  parsed: [
    { filename: 'SRS-NOVA-v1.0.docx', language: 'en', pageCount: 45 },
    { filename: 'SRS-NOVA-v2.0.docx', language: 'en', pageCount: 52 },
    { filename: 'IRS-NOVA.docx', language: 'en', pageCount: 28 },
    { filename: 'Test-Report-NOVA.pdf', language: 'en', pageCount: 35 },
    { filename: 'FMEA-NOVA.xlsx', language: 'en', pageCount: 12 },
    { filename: 'Audit-Report-2026.pdf', language: 'en', pageCount: 18 },
    { filename: 'Deviation-List.xlsx', language: 'en', pageCount: 8 },
    { filename: 'Milestones.xlsx', language: 'en', pageCount: 5 },
    { filename: 'Risk-Register.xlsx', language: 'en', pageCount: 3 },
    { filename: 'Issue-Tracker.xlsx', language: 'en', pageCount: 4 },
    { filename: 'SRS-TITAN-DE.pdf', language: 'de', pageCount: 41 },
    { filename: 'Abweichliste-TITAN.pdf', language: 'de', pageCount: 14 },
  ],
  versionPairs: [
    { score: 11, docA: 'SRS-NOVA-v1.0.docx', docB: 'SRS-NOVA-v2.0.docx', confidence: 0.95 },
    { score: 9, docA: 'IRS-NOVA.docx', docB: 'SRS-NOVA-v2.0.docx', confidence: 0.87 },
    { score: 8, docA: 'Test-Report-NOVA.pdf', docB: 'SRS-NOVA-v2.0.docx', confidence: 0.82 },
    { score: 7, docA: 'FMEA-NOVA.xlsx', docB: 'SRS-NOVA-v2.0.docx', confidence: 0.78 },
    { score: 6, docA: 'Audit-Report-2026.pdf', docB: 'Test-Report-NOVA.pdf', confidence: 0.72 },
    { score: 5, docA: 'Deviation-List.xlsx', docB: 'FMEA-NOVA.xlsx', confidence: 0.65 },
    { score: 4, docA: 'Milestones.xlsx', docB: 'Risk-Register.xlsx', confidence: 0.58 },
    { score: 3, docA: 'Issue-Tracker.xlsx', docB: 'Risk-Register.xlsx', confidence: 0.52 },
    { score: 2, docA: 'SRS-TITAN-DE.pdf', docB: 'Abweichliste-TITAN.pdf', confidence: 0.48 },
  ],
  references: [
    { text: 'ISO 9001:2015', type: 'norm', standard: 'ISO', status: 'resolved' },
    { text: 'ISO 26262:2018', type: 'norm', standard: 'ISO', status: 'resolved' },
    { text: 'DIN EN 13523', type: 'norm', standard: 'DIN', status: 'resolved' },
    { text: 'VDA 6.3', type: 'norm', standard: 'VDA', status: 'resolved' },
    { text: 'IATF 16949:2016', type: 'norm', standard: 'IATF', status: 'resolved' },
    { text: 'Section 3.2.1', type: 'internal_ref', status: 'resolved' },
    { text: 'Appendix A', type: 'internal_ref', status: 'resolved' },
  ],
  requirements: [
    { type: 'MUSS', category: 'Material', safetyFlag: false, count: 42 },
    { type: 'SOLL', category: 'Prüfung', safetyFlag: false, count: 35 },
    { type: 'KANN', category: 'Verpackung', safetyFlag: false, count: 28 },
    { type: 'DEKLARATIV', category: 'Dokumentation', safetyFlag: true, count: 15 },
    { type: 'INFORMATIV', category: 'Referenz', safetyFlag: false, count: 36 },
  ],
  consistencyChecks: {
    parseSuccessRate: { value: 0.857, threshold: 0.8, pass: true },
    scannedPdfRatio: { value: 0.333, threshold: 0.5, pass: false },
    requirementDensity: { value: 1.56, threshold: 1.0, pass: true },
    referenceResolutionRate: { value: 0.913, threshold: 0.85, pass: true },
    versionPairRatio: { value: 0.75, threshold: 0.6, pass: true },
  },
};

export const EDGE_CASE_EMPTY = {
  scanId: 'SCAN-EMPTY-001',
  timestamp: new Date().toISOString(),
  summary: {
    totalFiles: 0,
    parsedFiles: 0,
    versionPairs: 0,
    references: 0,
    requirements: 0,
    mqScore: 0,
  },
  parsed: [],
  versionPairs: [],
  references: [],
  requirements: [],
  consistencyChecks: {},
};

export const EDGE_CASE_MIXED_LANGUAGES = {
  scanId: 'SCAN-MIXED-LANG-001',
  timestamp: '2026-04-22T14:15:30Z',
  summary: {
    totalFiles: 9,
    parsedFiles: 8,
    versionPairs: 3,
    references: 12,
    requirements: 87,
    mqScore: 65,
  },
  parsed: [
    { filename: 'doc-en.docx', language: 'en', pageCount: 25 },
    { filename: 'doc-de.pdf', language: 'de', pageCount: 32 },
    { filename: 'doc-fr.docx', language: 'fr', pageCount: 18 },
    { filename: 'doc-es.pdf', language: 'es', pageCount: 22 },
    { filename: 'doc-it.docx', language: 'it', pageCount: 15 },
    { filename: 'doc-pt.pdf', language: 'pt', pageCount: 20 },
    { filename: 'doc-zh.docx', language: 'zh', pageCount: 28 },
    { filename: 'doc-ja.pdf', language: 'ja', pageCount: 19 },
  ],
  versionPairs: [
    { score: 7, docA: 'doc-en.docx', docB: 'doc-de.pdf', confidence: 0.78 },
    { score: 5, docA: 'doc-fr.docx', docB: 'doc-es.pdf', confidence: 0.62 },
    { score: 3, docA: 'doc-it.docx', docB: 'doc-pt.pdf', confidence: 0.48 },
  ],
  references: [
    { text: 'ISO 9001', type: 'norm', status: 'resolved' },
    { text: 'Unknown Ref', type: 'norm', status: 'unresolved' },
  ],
  requirements: [
    { type: 'MUSS', category: 'Safety', safetyFlag: true, count: 25 },
    { type: 'SOLL', category: 'Performance', safetyFlag: false, count: 38 },
    { type: 'KANN', category: 'Optional', safetyFlag: false, count: 24 },
  ],
  consistencyChecks: {
    parseSuccessRate: { value: 0.889, threshold: 0.8, pass: true },
    scannedPdfRatio: { value: 0.5, threshold: 0.5, pass: true },
    requirementDensity: { value: 1.09, threshold: 1.0, pass: true },
  },
};
