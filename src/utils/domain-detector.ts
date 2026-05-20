// src/utils/domain-detector.ts
import type { RequirementLanguageFamily, UnitFamily } from "./quality-scorer.ts";
// No import from state.ts — return type is structurally compatible, no explicit import needed.

export interface DomainSignalSample {
  reqFamilyHits: Record<RequirementLanguageFamily, number>;
  unitFamilyHits: Record<Exclude<UnitFamily, "mixed" | "none">, number>;
  refFormatHits: Record<string, number>;
}

const REQ_DETECTORS: Record<RequirementLanguageFamily, RegExp> = {
  german_modal: /\b(muss|soll|kann|darf\s+nicht)\b/gi,
  rfc2119:      /\b(MUST|SHALL|SHOULD|MAY|REQUIRED)\b/g,
  legal:        /\b(shall\s+not|is\s+obligated|warrants\s+that)\b/gi,
  french_modal: /\b(doit|devrait|peut)\b/gi,
  none:         /(?!)/g,
};

const UNIT_DETECTORS: Record<Exclude<UnitFamily, "mixed" | "none">, RegExp> = {
  mechanical: /[\d,]+\s*(mm|cm|MPa|rpm|μm|kg|°C|bar|kN)/gi,
  electrical: /[\d,]+\s*(kWh|kV|mA|Hz|V|A|W|Ω)/gi,
  pharma:     /[\d,]+\s*(mg|mL|μg|ppm|mol\/L|ng)/gi,
  financial:  /[\d,]+\s*(€|\$|£|bps)/g,
  logistics:  /[\d,]+\s*(pcs|TEU|pallets)/gi,
};

const REF_DETECTORS: Record<string, RegExp> = {
  "letter_prefix_digits": /\b[A-Z]{2,}-?\d{3,}\b/g,
  "dotted_decimal":       /\b\d{2,}\s+\d{4,}-\d+:\d{4}\b/g,
  "paragraph_number":     /§\s*\d+/g,
  "all_caps_acronym":     /\b[A-Z]{2,}-\d{1,3}-[A-Z0-9]+\b/g,
};

export function detectDomainSignals(text: string): DomainSignalSample {
  const sample = text.slice(0, 8000);
  const reqFamilyHits = {} as Record<RequirementLanguageFamily, number>;
  for (const [family, re] of Object.entries(REQ_DETECTORS)) {
    reqFamilyHits[family as RequirementLanguageFamily] = (sample.match(re) ?? []).length;
  }
  const unitFamilyHits = {} as Record<Exclude<UnitFamily, "mixed" | "none">, number>;
  for (const [family, re] of Object.entries(UNIT_DETECTORS)) {
    unitFamilyHits[family as Exclude<UnitFamily, "mixed" | "none">] = (sample.match(re) ?? []).length;
  }
  const refFormatHits: Record<string, number> = {};
  for (const [name, re] of Object.entries(REF_DETECTORS)) {
    refFormatHits[name] = (sample.match(re) ?? []).length;
  }
  return { reqFamilyHits, unitFamilyHits, refFormatHits };
}

interface DomainProfile {
  detectedLanguage: "de" | "en" | "fr" | "mixed";
  requirementLanguageFamily: RequirementLanguageFamily;
  requirementLanguageCoverage: number;
  discoveredReferenceFormats: Array<{
    pattern: string;
    occurrenceCount: number;
    documentCount: number;
    alreadyExtracted: boolean;
  }>;
  dominantUnitFamily: UnitFamily;
  unitFamilyCoverage: number;
  qualityScorerProfile: "automotive_de" | "generic_de" | "generic_en" | "adapted";
}

export function buildDomainProfile(
  samples: DomainSignalSample[],
  parsedLanguages: string[],
): DomainProfile {
  const totalReq = {} as Record<RequirementLanguageFamily, number>;
  const totalUnit = {} as Record<Exclude<UnitFamily, "mixed" | "none">, number>;
  const totalRef: Record<string, number> = {};

  for (const s of samples) {
    for (const [k, v] of Object.entries(s.reqFamilyHits)) totalReq[k as RequirementLanguageFamily] = (totalReq[k as RequirementLanguageFamily] ?? 0) + v;
    for (const [k, v] of Object.entries(s.unitFamilyHits)) totalUnit[k as Exclude<UnitFamily, "mixed" | "none">] = (totalUnit[k as Exclude<UnitFamily, "mixed" | "none">] ?? 0) + v;
    for (const [k, v] of Object.entries(s.refFormatHits)) totalRef[k] = (totalRef[k] ?? 0) + v;
  }

  const topReq = (Object.entries(totalReq) as [RequirementLanguageFamily, number][])
    .filter(([k]) => k !== "none")
    .sort(([, a], [, b]) => b - a)[0];
  const topUnit = (Object.entries(totalUnit) as [Exclude<UnitFamily, "mixed" | "none">, number][])
    .sort(([, a], [, b]) => b - a)[0];

  const requirementLanguageFamily: RequirementLanguageFamily =
    topReq && topReq[1] > 0 ? topReq[0] : "none";
  const dominantUnitFamily: UnitFamily =
    topUnit && topUnit[1] > 0 ? topUnit[0] : "none";

  const langCounts: Record<string, number> = {};
  for (const l of parsedLanguages) langCounts[l] = (langCounts[l] ?? 0) + 1;
  const topLang = Object.entries(langCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? "und";
  const detectedLanguage: "de" | "en" | "fr" | "mixed" =
    topLang.startsWith("deu") || topLang === "de" ? "de" :
    topLang.startsWith("eng") || topLang === "en" ? "en" :
    topLang.startsWith("fra") || topLang === "fr" ? "fr" : "mixed";

  const totalSamples = samples.length || 1;
  const reqCoverage = samples.filter((s) =>
    requirementLanguageFamily !== "none" && (s.reqFamilyHits[requirementLanguageFamily] ?? 0) > 0
  ).length / totalSamples;

  const unitCoverage = samples.filter((s) =>
    dominantUnitFamily !== "none" &&
    (s.unitFamilyHits[dominantUnitFamily as Exclude<UnitFamily, "mixed" | "none">] ?? 0) > 0
  ).length / totalSamples;

  const topRefs = Object.entries(totalRef)
    .filter(([, c]) => c > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([pattern, occurrenceCount]) => ({
      pattern,
      occurrenceCount,
      documentCount: samples.filter((s) => (s.refFormatHits[pattern] ?? 0) > 0).length,
      alreadyExtracted: ["letter_prefix_digits"].includes(pattern),
    }));

  const isDefault = requirementLanguageFamily === "german_modal" && dominantUnitFamily === "mechanical" && detectedLanguage === "de";
  const qualityScorerProfile: DomainProfile["qualityScorerProfile"] =
    isDefault ? "automotive_de" :
    detectedLanguage === "de" ? "generic_de" :
    detectedLanguage === "en" ? "generic_en" : "adapted";

  return {
    detectedLanguage,
    requirementLanguageFamily,
    requirementLanguageCoverage: reqCoverage,
    discoveredReferenceFormats: topRefs,
    dominantUnitFamily,
    unitFamilyCoverage: unitCoverage,
    qualityScorerProfile,
  };
}
