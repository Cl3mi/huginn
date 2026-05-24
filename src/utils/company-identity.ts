import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { CompanyIdentity } from "../profiles/types.ts";

export const COMPANY_FILE_PATH =
  process.env["COMPANY_FILE_PATH"] ?? "/app/state/company.json";

const STOP_WORDS = new Set([
  "gmbh", "ag", "ltd", "inc", "corp", "co", "plc", "se", "sa",
  "the", "and", "von", "der", "die", "das", "und",
]);

export function extractSignificantWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s\-_&,./\\]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

export function matchesCompany(text: string, identity: CompanyIdentity): boolean {
  const normalized = text.toLowerCase();
  const candidates = [identity.name, ...identity.aliases];
  for (const candidate of candidates) {
    const words = extractSignificantWords(candidate);
    if (words.length > 0 && words.some((w) => normalized.includes(w))) return true;
  }
  return false;
}

export function loadCompanyIdentity(filePath: string): CompanyIdentity | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CompanyIdentity>;
    if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) return null;
    return {
      name: parsed.name.trim(),
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases.filter((a): a is string => typeof a === "string") : [],
    };
  } catch {
    return null;
  }
}

export function saveCompanyIdentity(filePath: string, identity: CompanyIdentity): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(identity, null, 2), "utf8");
}
