// ALL prompts centralized here. German-aware.
// Documents are primarily German; prompts request JSON-only responses.
// LLM is a validator, not the primary engine — keep prompts minimal.

// Normalize a list of raw norm strings to canonical form.
// Returns JSON mapping: { "ISO9001": "ISO 9001:2015", ... }
export function referenceNormalizationPrompt(rawNorms: string[]): string {
  const list = rawNorms.map((n) => `"${n}"`).join(", ");
  return `Du erhältst eine Liste von Norm-Referenzen aus technischen Dokumenten.
Normalisiere jede Referenz in die kanonische Form: NORM NUMMER:JAHR
Wenn kein Jahr bekannt ist, lass das Jahr weg.
Beispiele: "ISO9001" → "ISO 9001:2015", "DIN EN 13523" → "DIN EN 13523", "9001:2015" → "ISO 9001:2015"

Eingabeliste: [${list}]

Antworte NUR mit einem JSON-Objekt. Keine Erklärung, kein Markdown.
Format: { "original_string": "normalisierte_form", ... }`;
}

// Validate requirement extraction for a section of text.
// Returns JSON array of requirements found.
export function requirementValidationPrompt(sectionText: string): string {
  return `Analysiere diesen technischen Dokumentabschnitt aus einem Lastenheft.
Zähle und klassifiziere NUR die enthaltenen Anforderungen.

Abschnitt:
---
${sectionText}
---

Antworte NUR mit einem JSON-Array. Keine Erklärung, kein Markdown.
Format:
[
  {
    "type": "MUSS",
    "category": "Material",
    "has_quantitative_value": true
  }
]

Gültige type-Werte: MUSS, SOLL, KANN, INFORMATIV
Gültige category-Werte: Material, Toleranz, Prüfung, Verpackung, Lieferung, Sicherheit, Sonstiges

Wenn keine Anforderungen vorhanden sind, antworte mit: []`;
}

// Determine if two documents are different versions of the same document.
// Takes a JSON context string (metadata only, no content).
export function versionPairOutlierPrompt(contextJson: string): string {
  return `Gegeben sind die Metadaten zweier Dokumente aus einer technischen Dokumentensammlung.
Entscheide, ob es sich um verschiedene Versionen desselben Dokuments handelt.

Metadaten:
${contextJson}

Antworte NUR mit JSON. Keine Erklärung, kein Markdown.
Format:
{
  "same_document": true,
  "confidence": 0.85,
  "reason": "Gleiche Überschriftenstruktur, ähnlicher Dateiname, Datum 6 Monate auseinander"
}`;
}

// Infer document type from filename and heading list.
export function docTypeInferencePrompt(filename: string, headings: string[]): string {
  const headingList = headings.slice(0, 10).map((h) => `- ${h}`).join("\n");
  return `Klassifiziere dieses technische Dokument anhand des Dateinamens und der Überschriften.

Dateiname: ${filename}
Überschriften:
${headingList}

Mögliche Dokumenttypen:
- lastenheft: Technische Spezifikation / Anforderungsdokument / SRS / IRS vom OEM
- angebot: Angebot oder Proposal von Magna
- abweichliste: Lastenheftabweichliste mit FIKB-Nummern
- norm: ISO / DIN / EN / VDA / BMW QV Norm
- pruefspezifikation: Prüfvorschrift oder Prüfspezifikation
- testbericht: Testergebnis oder Validierungsbericht / Test Report
- fmea: Failure Mode and Effects Analysis (FMEA) Dokument
- audit: Audit-Bericht oder Auditprotokoll
- planning: Projektplanung, Meilensteinplan, Risikoregister, Issue Tracker
- sla: Service Level Agreement
- lessons_learned: Lessons Learned Dokument
- other: Sonstiges

Antworte NUR mit JSON. Keine Erklärung.
Format: { "docType": "lastenheft", "confidence": 0.9 }`;
}

// ============================================================
// Narrative report prompt functions (English output)
// Called by 8-narrative.ts with pre-sanitized metric inputs only.
// Input types defined as unknown — content-safety enforced by callers.
// ============================================================

export function narrativeCorpusOverviewPrompt(input: unknown): string {
  return `You are a technical analyst explaining a document intelligence scan to an engineer building a RAG knowledge base.

Here are the corpus metrics:
${JSON.stringify(input, null, 2)}

Write 2-3 paragraphs explaining:
- What kind of corpus this is and how well it parsed
- What the language distribution and document type mix means for RAG pipeline design
- Whether the metadata quality score is a concern, and why

Do not repeat the numbers back — explain what they imply. Write in plain English prose. No bullet points, no JSON.`;
}

export function narrativeVersionPairPrompt(input: unknown): string {
  return `You are a technical analyst explaining a document intelligence scan to an engineer building a RAG knowledge base.

Here are the version pair detection metrics:
${JSON.stringify(input, null, 2)}

Write 2-3 paragraphs explaining:
- Which signals drove each HIGH or MEDIUM confidence version pair (filename similarity, structural match, heading MinHash, semantic cosine, directory co-location, date delta)
- What each contributing signal means linguistically — e.g. high filename similarity means filenames share tokens like "v1"/"v2", high heading MinHash means document structure is nearly identical
- If no pairs were found (topPairs is empty): what the absence implies for this corpus — all unique documents, corpus too small to find pairs, or calibration needed

Do not repeat the numbers back — explain what they imply. Write in plain English prose. No bullet points, no JSON.`;
}

export function narrativeRequirementQualityPrompt(input: unknown): string {
  return `You are a technical analyst explaining a document intelligence scan to an engineer building a RAG knowledge base.

Here are the requirement extraction quality metrics:
${JSON.stringify(input, null, 2)}

Write 2-3 paragraphs explaining:
- Whether the regex-vs-LLM delta indicates the regex is too strict (LLM finds more requirements than regex) or too loose (regex has false positives that LLM rejects), and what this means for extraction reliability
- Which document types appear hardest for requirement extraction, based on uncertainty counts and delta by type
- If llmValidationRan is false: what remains unknown about extraction quality and what the delta=0 value actually means in that context

Do not repeat the numbers back — explain what they imply. Write in plain English prose. No bullet points, no JSON.`;
}

export function narrativeChunkStrategyPrompt(input: unknown): string {
  return `You are a technical analyst explaining a document intelligence scan to an engineer building a RAG knowledge base.

Here are the chunking strategy assessment metrics:
${JSON.stringify(input, null, 2)}

Write 2-3 paragraphs explaining:
- For low-confidence heading_sections docs: what it means for RAG chunking quality when heading extraction is uncertain — section boundaries may be wrong, retrieval chunks may span multiple topics
- For dual-strategy candidates: why a document triggered two competing strategies and what this implies for ingestion pipeline design
- The overall implication of the strategy distribution for downstream vector store indexing

Do not repeat the numbers back — explain what they imply. Write in plain English prose. No bullet points, no JSON.`;
}

export function narrativeParserReliabilityPrompt(input: unknown): string {
  return `You are a technical analyst explaining a document intelligence scan to an engineer building a RAG knowledge base.

Here are the parser reliability metrics:
${JSON.stringify(input, null, 2)}

Write 2-3 paragraphs explaining:
- Whether the parser divergence between officeparser and Tika is a data quality problem (content loss, encoding errors) or a structural difference (table extraction, metadata handling)
- The distinction between parse failures (files that couldn't be read at all) and OCR requirements (files that parsed but contain scanned images instead of text)
- What the OCR counts mean for the ingestion pipeline — specifically whether OCR pre-processing is a blocking dependency before RAG ingestion

Do not repeat the numbers back — explain what they imply. Write in plain English prose. No bullet points, no JSON.`;
}

export function narrativeReferenceGraphPrompt(input: unknown): string {
  return `You are a technical analyst explaining a document intelligence scan to an engineer building a RAG knowledge base.

Here are the reference graph metrics:
${JSON.stringify(input, null, 2)}

Write 2-3 paragraphs explaining:
- The distinction between references classified as likely_missing_from_corpus (documents that were referenced but not provided — action: request from client) vs likely_matcher_failure (references that exist in corpus but weren't matched — action: improve matching logic)
- What the norm reference distribution (ISO, DIN, VDA, IATF) reveals about the regulatory landscape of this corpus
- What the internal reference resolution rate means for cross-document traceability in a RAG system

Do not repeat the numbers back — explain what they imply. Write in plain English prose. No bullet points, no JSON.`;
}

export function narrativeRagSynthesisPrompt(input: unknown): string {
  return `You are a technical analyst explaining a document intelligence scan to an engineer building a RAG knowledge base.

Here is a cross-cutting summary of all scan signals:
${JSON.stringify(input, null, 2)}

Write 2-3 paragraphs providing:
- A prioritized assessment: given all signals combined, identify the single most impactful action the engineer should take before ingesting this corpus into a RAG system
- The reasoning behind this prioritization — why this action outweighs the others
- Secondary concerns that should be addressed after the primary action, in order of impact

Frame this as actionable guidance. Do not repeat the numbers back — explain what they imply. Write in plain English prose. No bullet points, no JSON.`;
}
