import type { ChunkType } from "./token-estimator.ts";

export type RequirementLanguageFamily = "german_modal" | "rfc2119" | "legal" | "french_modal" | "none";
export type UnitFamily = "mechanical" | "electrical" | "pharma" | "financial" | "logistics" | "mixed" | "none";

export interface DomainHints {
  requirementLanguageFamily?: RequirementLanguageFamily;
  dominantUnitFamily?: UnitFamily;
}

const REQ_PATTERNS: Record<RequirementLanguageFamily, RegExp> = {
  german_modal: /\b(soll|muss|darf\s+nicht|hat\s+sicherzustellen|muss\s+gewährleistet)\b/i,
  rfc2119:      /\b(MUST|SHALL|SHOULD|MAY|REQUIRED|RECOMMENDED)\b/,
  legal:        /\b(shall\s+not|is\s+obligated\s+to|warrants\s+that)\b/i,
  french_modal: /\b(doit|devrait|peut)\b/i,
  none:         /(?!)/,
};

const UNIT_PATTERNS: Record<UnitFamily, RegExp> = {
  mechanical:  /[\d,]+\s*(mm|cm|m|kg|g|°C|%|bar|N|kN|MPa|rpm|μm|±|∅)/i,
  electrical:  /[\d,]+\s*(V|A|W|kWh|Ω|Hz|kV|mA)/i,
  pharma:      /[\d,]+\s*(mg|mL|μg|ppm|mol\/L|ng|μL)/i,
  financial:   /[\d,]+\s*(€|\$|£|%|bps|bp)/,
  logistics:   /[\d,]+\s*(pcs|TEU|kg\/m³|pallets|units)/i,
  mixed:       /[\d,]+\s*[a-zA-Z°μ%€$£Ω±∅]{1,6}/,
  none:        /(?!)/,
};

const PART_NUMBER = /\b([A-Z]{2,}-?\d{3,}|KB[-_]?\d{3,}|FIKB[-\s]?\d{3,})\b/;

export async function scoreBlock(content: string, chunkType: ChunkType | string, hints: DomainHints): Promise<number> {
  if (chunkType === "boilerplate") return 0.1;

  const score = Math.min(
    1.0,
    0.4 * densityScore(content) +
    0.3 * coherenceScore(content, hints.requirementLanguageFamily ?? "none") +
    0.3 * specificityScore(content, hints.dominantUnitFamily ?? "none"),
  );

  if (chunkType === "header") return Math.min(score, 0.35);
  return Math.round(score * 1000) / 1000;
}

function densityScore(text: string): number {
  const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return 0;
  const unique = new Set(tokens).size;
  const diversity = unique / tokens.length;
  const normalized = Math.min(1.0, diversity / 0.7);
  const lengthBonus = Math.min(1.0, tokens.length / 30);
  return normalized * lengthBonus;
}

function coherenceScore(text: string, family: RequirementLanguageFamily): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 5);
  if (sentences.length === 0) return 0.3;
  const avgLen = sentences.reduce((s, sen) => s + sen.split(/\s+/).length, 0) / sentences.length;
  const lenScore = avgLen < 4 ? 0.2 : avgLen > 50 ? 0.4 : Math.min(1.0, avgLen / 15);
  const reqBonus = family !== "none" && REQ_PATTERNS[family].test(text) ? 0.15 : 0;
  return Math.min(1.0, lenScore + reqBonus);
}

function specificityScore(text: string, unitFamily: UnitFamily): number {
  let score = 0;
  const pattern = unitFamily !== "none" ? UNIT_PATTERNS[unitFamily] : UNIT_PATTERNS.mechanical;
  const unitMatches = text.match(new RegExp(pattern.source, "gi")) ?? [];
  score += Math.min(0.4, unitMatches.length * 0.1);
  if (PART_NUMBER.test(text)) score += 0.2;
  const digits = (text.match(/\d/g) ?? []).length;
  const total = text.replace(/\s/g, "").length;
  if (total > 0) score += Math.min(0.2, (digits / total) * 2);
  if (/\t/.test(text) || /\|/.test(text)) score += 0.1;
  return Math.min(1.0, score);
}
