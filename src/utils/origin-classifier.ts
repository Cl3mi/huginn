import { matchesCompany, extractSignificantWords } from "./company-identity.ts";
import type { ParsedDocument, OriginSignal, OriginClassification } from "../state.ts";
import type { CompanyIdentity } from "../profiles/types.ts";

export interface DocxAuthorMeta {
  creator?: string;
  lastModifiedBy?: string;
  company?: string;
}

// Single lookup — each doctype maps to at most one signal, making overlaps impossible by construction.
type DetectedDocType = NonNullable<ParsedDocument["detectedDocType"]>;
const DOCTYPE_SIGNALS: Partial<Record<DetectedDocType, OriginSignal>> = {
  "arbeitsanweisung":   { signal: "doctype_internal",        direction: "internal", weight: 2 },
  "protokoll":          { signal: "doctype_internal",        direction: "internal", weight: 2 },
  "handbuch":           { signal: "doctype_internal",        direction: "internal", weight: 2 },
  "lessons_learned":    { signal: "doctype_internal",        direction: "internal", weight: 2 },
  "8d_report":          { signal: "doctype_internal",        direction: "internal", weight: 2 },
  "kontrollplan":       { signal: "doctype_internal",        direction: "internal", weight: 2 },
  "serienfreigabe":     { signal: "doctype_internal",        direction: "internal", weight: 2 },
  "empb":               { signal: "doctype_internal",        direction: "internal", weight: 2 },
  "aenderungsantrag":   { signal: "doctype_internal",        direction: "internal", weight: 2 },
  "reklamation":        { signal: "doctype_internal",        direction: "internal", weight: 2 },
  "fmea":               { signal: "doctype_internal",        direction: "internal", weight: 2 },
  "lastenheft":         { signal: "doctype_external_strong", direction: "external", weight: 3 },
  "sla":                { signal: "doctype_external_strong", direction: "external", weight: 3 },
  "norm":               { signal: "doctype_external_strong", direction: "external", weight: 3 },
  "qualitätsvorgabe":   { signal: "doctype_external_weak",   direction: "external", weight: 2 },
  "pruefspezifikation": { signal: "doctype_external_weak",   direction: "external", weight: 2 },
};

function countCompanyMentions(text: string, identity: CompanyIdentity): number {
  const normalized = text.toLowerCase();
  const allWords = [...new Set([identity.name, ...identity.aliases].flatMap(extractSignificantWords))];
  return allWords.reduce((sum, w) => {
    let count = 0; let pos = 0;
    while ((pos = normalized.indexOf(w, pos)) !== -1) { count++; pos += w.length; }
    return sum + count;
  }, 0);
}

export function collectOriginSignals(
  doc: ParsedDocument,
  identity: CompanyIdentity,
  docxMeta?: DocxAuthorMeta,
  pdfAuthor?: string,
): OriginSignal[] {
  const signals: OriginSignal[] = [];

  const authorFields = [docxMeta?.creator, docxMeta?.lastModifiedBy, pdfAuthor]
    .filter((f): f is string => typeof f === "string" && f.length > 0);
  if (authorFields.some(f => matchesCompany(f, identity))) {
    signals.push({ signal: "metadata_author_match", direction: "internal", weight: 5 });
  }

  if (docxMeta?.company && matchesCompany(docxMeta.company, identity)) {
    signals.push({ signal: "metadata_company_match", direction: "internal", weight: 4 });
  }

  const identityWords = new Set([identity.name, ...identity.aliases].flatMap(extractSignificantWords));
  const dirSegments = doc.pathSegments.slice(0, -1);
  if (dirSegments.some(seg => extractSignificantWords(seg).some(w => identityWords.has(w)))) {
    signals.push({ signal: "path_segment_match", direction: "internal", weight: 4 });
  }

  const sample = (doc.textContent ?? "").slice(0, 2000);
  if (sample.length > 0) {
    const count = countCompanyMentions(sample, identity);
    if (count >= 3)      signals.push({ signal: "content_match_strong", direction: "internal", weight: 3 });
    else if (count >= 1) signals.push({ signal: "content_match_weak",   direction: "internal", weight: 1 });
  }

  if (doc.detectedDocType) {
    const dts = DOCTYPE_SIGNALS[doc.detectedDocType];
    if (dts) signals.push({ ...dts });
  }
  if (doc.inferredCustomer) {
    signals.push({ signal: "oem_folder_detected", direction: "external", weight: 3 });
  }
  if (doc.inferredDocumentCategory === "rfq" || doc.inferredDocumentCategory === "quotation") {
    signals.push({ signal: "doc_category_rfq", direction: "external", weight: 2 });
  }

  return signals;
}

export function classifyOrigin(signals: OriginSignal[]): OriginClassification {
  const internalScore = signals.filter(s => s.direction === "internal").reduce((sum, s) => sum + s.weight, 0);
  const externalScore = signals.filter(s => s.direction === "external").reduce((sum, s) => sum + s.weight, 0);

  let result: "internal" | "external" | "unknown";
  // Thresholds are intentionally asymmetric: internal requires ≥ 4, external requires ≥ 3.
  // Internal threshold is higher because a precision error (labelling a customer doc "internal")
  // is more harmful than leaving a borderline doc as "unknown".
  if      (internalScore >= 4 && internalScore > externalScore) result = "internal";
  else if (externalScore >= 3 && externalScore > internalScore) result = "external";
  else                                                           result = "unknown";

  const winnerScore = result === "internal" ? internalScore : result === "external" ? externalScore : 0;

  let confidence: OriginClassification["confidence"];
  if      (result === "unknown") confidence = "none";
  else if (winnerScore >= 8)     confidence = "high";
  else if (winnerScore >= 5)     confidence = "medium";
  else                           confidence = "low";

  return { result, internalScore, externalScore, confidence, signals };
}
