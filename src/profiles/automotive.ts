import type { SectorProfile } from "./types.ts";
import type { ExtractedReference } from "../state.ts";

function classifyNormType(rawText: string): ExtractedReference["type"] {
  if (/^\s*VDA/i.test(rawText))  return "vda_norm";
  if (/^\s*IATF/i.test(rawText)) return "iatf_norm";
  if (/^\s*DIN/i.test(rawText))  return "din_norm";
  if (/^\s*EN\s/i.test(rawText)) return "en_norm";
  return "iso_norm";
}

// Static canonical lookup for automotive norms — copied from 6-references.ts
// AUTOMOTIVE_NORM_CANONICAL. DO NOT trim this list; it powers certain-confidence
// normalization without an LLM call.
const normCanonical: Record<string, string> = {
  "ISO 9001": "ISO 9001:2015",
  "ISO 9001:2015": "ISO 9001:2015",
  "DIN EN ISO 9001": "ISO 9001:2015",
  "EN ISO 9001": "ISO 9001:2015",
  "ISO 14001": "ISO 14001:2015",
  "ISO 14001:2015": "ISO 14001:2015",
  "ISO 45001": "ISO 45001:2018",
  "ISO 45001:2018": "ISO 45001:2018",
  "IATF 16949": "IATF 16949:2016",
  "IATF 16949:2016": "IATF 16949:2016",
  "ISO/TS 16949": "IATF 16949:2016",
  "ISO TS 16949": "IATF 16949:2016",
  "TS 16949": "IATF 16949:2016",
  "ISO 26262": "ISO 26262:2018",
  "ISO 26262:2018": "ISO 26262:2018",
  "ISO 26262-2": "ISO 26262-2:2018",
  "IEC 61508": "IEC 61508:2010",
  "IEC 61508:2010": "IEC 61508:2010",
  "ISO/IEC 61508": "IEC 61508:2010",
  "ISO 13849": "ISO 13849-1:2015",
  "ISO 13849-1": "ISO 13849-1:2015",
  "VDA 6.3": "VDA 6.3:2016",
  "VDA 6.3:2016": "VDA 6.3:2016",
  "VDA 6.1": "VDA 6.1:2016",
  "VDA 6.5": "VDA 6.5:2012",
  "VDA 4": "VDA 4:2020",
  "VDA 4.1": "VDA 4.1",
  "VDA 4.2": "VDA 4.2",
  "VDA 2": "VDA 2:2020",
  "VDA 19": "VDA 19:2010",
  "VDA 19.1": "VDA 19.1:2010",
  "ASPICE": "Automotive SPICE PAM 3.1",
  "Automotive SPICE": "Automotive SPICE PAM 3.1",
  "A-SPICE": "Automotive SPICE PAM 3.1",
  "AIAG FMEA": "AIAG & VDA FMEA Handbook 1st Edition",
  "AIAG MSA": "AIAG MSA 4th Edition",
  "AIAG APQP": "AIAG APQP 2nd Edition",
  "AIAG PPAP": "AIAG PPAP 4th Edition",
  "ISO 10204": "ISO 10204:2004",
  "DIN EN 10204": "ISO 10204:2004",
  "EN 10204": "ISO 10204:2004",
  "DIN EN 1090": "DIN EN 1090-2:2018",
  "ISO 1101": "ISO 1101:2017",
  "ISO 286": "ISO 286-1:2010",
  "REACH": "REACH Regulation (EC) 1907/2006",
  "RoHS": "RoHS Directive 2011/65/EU",
  "DIN EN 13523": "DIN EN 13523",
  "DIN 1055": "DIN 1055",
  "ISO 9241": "ISO 9241",
  "DIN EN ISO 14001": "ISO 14001:2015",
};

export const automotiveDe: SectorProfile = {
  id: "automotive_de",
  label: "Automotive (DE)",
  description: "German automotive — ISO/VDA/IATF norms, MUSS/SOLL/KANN requirements",
  requirementLanguageFamily: "german_modal",
  unitFamily: "mechanical",

  requirementPatterns: {
    MANDATORY:   /\b(muss|müssen|ist\s+zu|sind\s+zu|hat\s+zu|haben\s+zu|shall|must)\b/gi,
    RECOMMENDED: /\b(soll|sollen|sollte|sollten|should)\b/gi,
    PERMITTED:   /\b(kann|können|darf|dürfen|may|can)\b/gi,
    DECLARATIVE: /(?:\b\d[\d.,]*\s*(?:mm|cm|MPa|bar|°C|%|kN|rpm|μm|nm)\b|[A-Z]{2,4}[-_]\d{3,}(?:\s+Rev\.?\s*\d+)?)/gi,
  },

  normPattern: /\b(ISO|DIN|EN|DIN\s?EN|VDA|IATF)\s*[\d]{1,6}(?:[.,]\d+)?(?:[:\-\/]\d{1,5})?(?:[:\-]\d+)?(?!\w)/gi,
  normCanonical,

  safetyKeywords:   /\b(sicherheitsrelevant|sicherheitskritisch|Sicherheit|FMEA|Dichtheit|dicht|Explosion|explosionsgefahr|kritisch|safety|safety-relevant)\b/gi,
  deliveryKeywords: /\b(Lieferung|Lieferant|Lieferbedingung|Incoterms|EXW|FCA|DAP|DDP|Versand|Transport|delivery|supplier)\b/gi,

  classifyNormType,

  entityIdPatterns: [
    { pattern: /\bQV[-\s]?\d{3,6}(?:[-\s]v?\d+)?(?!\w)/gi,                                  type: "quality_spec" },
    { pattern: /\bFIKB[-\s]?\d{2,6}(?!\w)/gi,                                                type: "fikb" },
    { pattern: /\bKB[-_]?Master[-_\s]?(?:Nummer|Nr\.?)[-\s:]*\d{1,8}(?!\w)/gi,              type: "kb_master" },
  ],
};

// Inline integrity check — runs at import time during tests.
// Keeps profile authors honest: all required patterns must be non-empty regexes.
if (process.env["NODE_ENV"] === "test") {
  const p = automotiveDe;
  if (!p.normPattern.source || !p.safetyKeywords.source) {
    throw new Error("automotive profile: missing required pattern");
  }
}
