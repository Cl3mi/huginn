// src/debug/settings.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { CONFIG } from "../config.ts";

export interface DebugSettings {
  enabled: boolean;
  decisionAudit: boolean;    // medium privacy: heading fragment keys used as signal labels
  patternCoverage: boolean;  // low privacy: pattern names + match counts + doc IDs only
  llmTrace: boolean;         // low privacy: counts + doc IDs only, no content
  zeroOutputDocs: boolean;   // low privacy: doc IDs, counts, and inferred cause only
}

const DEFAULT: DebugSettings = {
  enabled: false,
  decisionAudit: false,
  patternCoverage: false,
  llmTrace: false,
  zeroOutputDocs: false,
};

function settingsPath(): string {
  return join(CONFIG.reportOutput, "debug-settings.json");
}

export function loadDebugSettings(): DebugSettings {
  const path = settingsPath();
  if (!existsSync(path)) return { ...DEFAULT };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DebugSettings>;
    return { ...DEFAULT, ...parsed };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveDebugSettings(settings: DebugSettings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8");
}

export function mergeDebugSettings(
  current: DebugSettings,
  patch: Partial<DebugSettings>,
): DebugSettings {
  const result = { ...current };
  for (const key of Object.keys(patch) as Array<keyof DebugSettings>) {
    if (typeof patch[key] === "boolean") {
      result[key] = patch[key] as boolean;
    }
  }
  return result;
}
