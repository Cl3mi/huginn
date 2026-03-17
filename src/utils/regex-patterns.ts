// All regex patterns in one file, with BUILT-IN TEST SUITE.
// Run runRegexTests() on startup — abort if any fail.

export const PATTERNS = {
  // ISO/DIN/EN norms — allow 1-6 digit numbers (VDA 6.3, ISO 9001:2015, etc.)
  norm: /\b(ISO|DIN|EN|DIN\s?EN|VDA|IATF)\s*[\d]{1,6}(?:[.,]\d+)?(?:[:\-\/]\d{1,5})?(?:[:\-]\d+)?(?!\w)/gi,

  // Quality specifications (BMW-specific)
  qualitySpec: /\bQV[-\s]?\d{3,6}(?:[-\s]v?\d+)?(?!\w)/gi,

  // FIKB references (Mercedes) — allow 2+ digits (some FIKBs are 2-digit)
  fikb: /\bFIKB[-\s]?\d{2,6}(?!\w)/gi,

  // KB_Master references (BMW/Audi) — allow space between Master and Nummer, 1+ digits
  kbMaster: /\bKB[-_]?Master[-_\s]?(?:Nummer|Nr\.?)[-\s:]*\d{1,8}(?!\w)/gi,

  // Internal chapter/section references (German technical docs)
  chapterRef: /(?:siehe|vgl\.|gemäß|laut|nach)\s+(?:Kapitel|Abschnitt|Punkt|Kap\.?)\s+[\d.]+/gi,

  // Document ID references
  docRef: /\b(?:Doc|QV|QVG|Anlage|Anhang)[-\s]?[A-Z0-9]{2,}[-\s]?\d{3,6}\b/g,

  // Revision/version markers — allow separator-free "Rev.5" form
  versionMarker: /(?:Stand|Version|Rev\.?|Revision)[:\s.]*(?:\d{4}[-\/.]\d{2}(?:[-\/.]\d{2})?|\d+)/gi,

  // Quantitative values with units — use lookahead instead of \b (works for %, °C, µm, ²)
  quantitativeValue: /\b(\d+(?:[.,]\d+)?)\s*(mm|cm|m|N\/mm²|MPa|kN|bar|°C|%|µm|nm|kg|g|l|ml)(?=\s|[,;.)\n\r]|$)/g,

  // German requirement keywords
  muss: /\b(muss|müssen|ist\s+zu|sind\s+zu|hat\s+zu|haben\s+zu|shall|must)\b/gi,
  soll: /\b(soll|sollen|sollte|sollten|should)\b/gi,
  kann: /\b(kann|können|darf|dürfen|may|can)\b/gi,
  informativ: /\b(wird|werden|ist|sind|are|is|will\s+be)\b/gi,

  // Mercedes test result status markers
  inOrder: /\bi\.?\s?O\.?\b/g,
  notInOrder: /\bn\.?\s?i\.?\s?O\.?\b/g,
  alignmentNeeded: /\bAbstimmung\s+erforderlich\b/gi,

  // Safety keywords
  safetyKeywords: /\b(sicherheitsrelevant|sicherheitskritisch|Sicherheit|FMEA|Dichtheit|dicht|Explosion|explosionsgefahr|kritisch|safety|safety-relevant)\b/gi,

  // Material keywords
  materialKeywords: /\b(Werkstoff|Material|Stahl|Aluminium|Kunststoff|Polymer|Compound|Legierung|Beschichtung|coating|steel|plastic)\b/gi,

  // Tolerance keywords
  toleranceKeywords: /\b(Toleranz|Maß|Abweichung|Grenzwert|Nominalwert|Nennwert|±|plus\s*minus|Genauigkeit|accuracy|tolerance)\b/gi,

  // Testing keywords
  testingKeywords: /\b(Prüfung|Test|Nachweis|Validierung|Verifikation|Simulation|Messung|Prüfvorschrift|Prüfspezifikation|testing|validation|verification)\b/gi,

  // Packaging keywords
  packagingKeywords: /\b(Verpackung|Ladungsträger|Sonderladungsträger|Behälter|Label|Barcode|Kennzeichnung|packaging|carrier)\b/gi,

  // Delivery/logistics keywords
  deliveryKeywords: /\b(Lieferung|Lieferant|Lieferbedingung|Incoterms|EXW|FCA|DAP|DDP|Versand|Transport|delivery|supplier)\b/gi,

  // Incoterms
  incoterms: /\b(EXW|FCA|CPT|CIP|DAP|DPU|DDP|FAS|FOB|CFR|CIF)\b/g,

  // GAP-01: Declarative requirement indicators (German: value assignment without modal verbs)
  declarative: /\b(?:beträgt|ist\s+einzuhalten|zu\s+gewährleisten|ist\s+festgelegt|ist\s+vorgeschrieben|sind\s+festgelegt|sind\s+vorgeschrieben)\b/gi,

  // Intra-corpus document IDs (e.g. NOVA-SRS-001, TITAN-IRS-002)
  intraCorpusId: /\b([A-Z]{2,8})-([A-Z]{2,6})-(\d{3,4})\b/g,

  // Requirement cross-reference IDs (e.g. REQ-001, ABW-042, SPEC-1234)
  requirementId: /\b(?:REQ|ABW|SPEC|NEED)[-_]\d{3,6}\b/g,

  // OEM name detection in paths/content
  oemNames: /\b(Mercedes|Benz|BMW|Audi|Volkswagen|VW|Porsche|Daimler|Stellantis)\b/gi,

  // Numbered heading patterns
  numberedHeading: /^(\d+(?:\.\d+)*)\s+(.+)$/m,

  // Table of contents entries
  tocEntry: /^(\d+(?:\.\d+)*)\s+(.+?)\s+\.{3,}\s*\d+$/m,
};

interface PatternTest {
  pattern: RegExp;
  positives: string[];  // must match
  negatives: string[];  // must NOT match
}

const PATTERN_TESTS: Record<string, PatternTest> = {
  norm: {
    pattern: PATTERNS.norm,
    positives: [
      "ISO 9001:2015",
      "DIN EN 13523",
      "ISO9001",
      "DIN 1055",
      "EN 1090",
      "VDA 6.3",
      "IATF 16949",
      "ISO 16949:2016",
      "DIN EN ISO 14001",
      "VDA12345",
    ],
    negatives: [
      "ISOBAR",   // not a norm
      "12345",    // bare number
      "DIN",      // norm abbreviation alone
      "EN",       // too short
      "Section 4.2",
    ],
  },
  fikb: {
    pattern: PATTERNS.fikb,
    positives: [
      "FIKB 123",
      "FIKB-4567",
      "FIKB 12345",
      "FIKB-001",
      "FIKB 999",
      "FIKB-1234",
      "FIKB 55",
      "FIKB-100",
      "FIKB 9999",
      "FIKB-20001",
    ],
    negatives: [
      "FIKB",           // no number
      "FIKBX123",       // non-separator char
      "PREFIX-FIKB-1",  // boundary test — FIKB preceded by word char
      "123",
      "KB-Master-Nummer 123",
    ],
  },
  kbMaster: {
    pattern: PATTERNS.kbMaster,
    positives: [
      "KB-Master-Nummer 12345",
      "KB_Master_Nr. 9876",
      "KB-MasterNummer 100",
      "KB_Master_Nummer: 54321",
      "KB-Master-Nr. 777",
      "KB_MasterNr 2024",
      "KB-Master Nummer 1234",
      "KB_Master-Nummer: 88888",
      "KB-MasterNr.12345",
      "KB_Master_Nummer 1",
    ],
    negatives: [
      "KB",
      "Master",
      "Nummer 12345",
      "ISO 9001",
      "FIKB-123",
    ],
  },
  quantitativeValue: {
    pattern: PATTERNS.quantitativeValue,
    positives: [
      "20 mm",
      "0.5 N/mm²",
      "100 MPa",
      "3.14 bar",
      "25 °C",
      "15 %",
      "500 µm",
      "2.5 kg",
      "1.2 l",
      "250 ml",
    ],
    negatives: [
      "20 Stück",   // not a recognized unit
      "Seite 5",
      "Version 3",
      "§ 5",
      "Item 2",
    ],
  },
  muss: {
    pattern: PATTERNS.muss,
    positives: [
      "Das Bauteil muss",
      "Die Teile müssen",
      "Das System ist zu prüfen",
      "Die Komponenten sind zu liefern",
      "Der Lieferant hat zu",
      "The part shall",
      "It must be",
      "The supplier must provide",
      "muss dicht sein",
      "shall comply with",
    ],
    negatives: [
      "Muster",       // not "muss"
      "Musst du",     // second person — edge case but acceptable
      "gemessen",
      "Maßstab",
      "Leistung",
    ],
  },
  safetyKeywords: {
    pattern: PATTERNS.safetyKeywords,
    positives: [
      "sicherheitsrelevant",
      "FMEA",
      "Dichtheit muss gewährleistet",
      "dicht sein",
      "Explosionsgefahr",
      "sicherheitskritisch",
      "safety-relevant component",
      "safety critical",
      "Kritisch für",
      "explosion risk",
    ],
    negatives: [
      "Versicherung",  // insurance, not safety
      "Gebrauchsanweisung",
      "Benutzer",
      "Lieferung",
      "Dokumentation",
    ],
  },
  declarative: {
    pattern: PATTERNS.declarative,
    positives: [
      "Der Wert beträgt 5 mm",
      "Toleranz ist einzuhalten",
      "Sicherheit zu gewährleisten",
      "Grenzwert ist festgelegt",
      "Werte sind vorgeschrieben",
    ],
    negatives: [
      "betragen die Kosten",     // different form — beträgt ≠ betragen
      "eingehalten wird",        // passive, no "ist einzuhalten"
      "Festlegung der Toleranz", // noun form, not verb
    ],
  },
  intraCorpusId: {
    pattern: PATTERNS.intraCorpusId,
    positives: [
      "NOVA-SRS-001",
      "TITAN-IRS-002",
      "BMS-REQ-0042",
      "HELIOS-DOC-100",
      "AB-XY-999",
    ],
    negatives: [
      "ISO-9001",          // middle segment is digits, not letters
      "FIKB-123",          // no middle segment
      "A-SRS-001",         // first segment only 1 char
      "AB-C-001",          // middle segment only 1 char
      "nova-srs-001",      // lowercase
    ],
  },
  requirementId: {
    pattern: PATTERNS.requirementId,
    positives: [
      "REQ-001",
      "ABW-042",
      "SPEC-1234",
      "NEED_001",
      "REQ_56789",
    ],
    negatives: [
      "req-001",     // lowercase
      "REQ001",      // no separator
      "REQ-12",      // too few digits (only 2)
      "ISO-001",     // not a requirement prefix
      "FIKB-1234",   // not a requirement prefix
    ],
  },
  versionMarker: {
    pattern: PATTERNS.versionMarker,
    positives: [
      "Stand: 2024-03",
      "Version 2",
      "Rev. 3",
      "Revision 2024/01",
      "Stand 2023.12.01",
      "Version: 1.0",
      "Rev.5",
      "Revision: 2024-01-15",
      "Stand 03/2024",
      "Version 2024-Q1",
    ],
    negatives: [
      "Standard",
      "Reversal",
      "Visualisierung",
      "Verständnis",
      "Bestimmung",
    ],
  },
};

export interface RegexTestResult {
  passed: boolean;
  failures: string[];
  testedPatterns: number;
}

export function runRegexTests(): RegexTestResult {
  const failures: string[] = [];
  let testedPatterns = 0;

  for (const [patternName, test] of Object.entries(PATTERN_TESTS)) {
    testedPatterns++;

    // Reset lastIndex for global patterns before testing
    const resetPattern = new RegExp(test.pattern.source, test.pattern.flags);

    for (const positive of test.positives) {
      resetPattern.lastIndex = 0;
      if (!resetPattern.test(positive)) {
        failures.push(`FAIL [${patternName}] should match: "${positive}"`);
      }
      resetPattern.lastIndex = 0;
    }

    for (const negative of test.negatives) {
      resetPattern.lastIndex = 0;
      if (resetPattern.test(negative)) {
        failures.push(`FAIL [${patternName}] should NOT match: "${negative}"`);
      }
      resetPattern.lastIndex = 0;
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    testedPatterns,
  };
}

// Helper: reset a global regex before use (avoids lastIndex bugs)
export function resetPattern(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

// Helper: collect all matches from text
export function findAllMatches(pattern: RegExp, text: string): string[] {
  const re = new RegExp(pattern.source, pattern.flags);
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push(m[0]);
    if (!re.global) break;
  }
  return matches;
}
