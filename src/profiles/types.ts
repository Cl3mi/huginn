import type { RequirementLanguageFamily, UnitFamily } from "../utils/quality-scorer.ts";
import type { ExtractedReference } from "../state.ts";

export type ReqType =
  | "MANDATORY"
  | "RECOMMENDED"
  | "PERMITTED"
  | "DECLARATIVE"
  | "INFORMATIVE";

export interface SectorProfile {
  id: string;
  label: string;
  description: string;
  requirementLanguageFamily: RequirementLanguageFamily;
  unitFamily: UnitFamily;
  requirementPatterns: {
    MANDATORY:   RegExp;
    RECOMMENDED: RegExp;
    PERMITTED:   RegExp;
    DECLARATIVE: RegExp;
  };
  normPattern:   RegExp;
  normCanonical: Record<string, string>;
  safetyKeywords:    RegExp;
  deliveryKeywords?: RegExp;
  classifyNormType?: (rawText: string) => ExtractedReference["type"];
  entityIdPatterns?: Array<{ pattern: RegExp; type: ExtractedReference["type"] }>;
}

export interface CompanyIdentity {
  name: string;
  aliases: string[];
}
