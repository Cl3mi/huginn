import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname } from "path";
import { CATALOG } from "../llm/model-catalog.ts";
import type { DetectedHardware, RankedEntry } from "../llm/model-fit.ts";
import { healthState } from "./health-state.ts";
import type { CompanyIdentity } from "../profiles/types.ts";

export type SetupState = {
  schemaVersion: 2;
  installedChatModel: string | null;
  installedAt: string | null;
  fitReportAtInstall: {
    detected: DetectedHardware;
    candidates: RankedEntry[];
  } | null;
  companyIdentity: CompanyIdentity | null;
};

const CURRENT_SCHEMA_VERSION = 2;

// Inside the scanner container the default lives in the writable layer at
// /app/state/setup.json (no bind mount). Dev runs override via SETUP_FILE_PATH.
export const SETUP_FILE_PATH = process.env["SETUP_FILE_PATH"] ?? "/app/state/setup.json";

// In-memory singleton — lives here (not in server/index.ts) to avoid the
// routes.ts -> server/index.ts -> routes.ts circular import.
export const setupHolder: { current: SetupState | null } = { current: null };

export function loadSetupState(filePath: string): SetupState | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SetupState>;
    if (parsed.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      unlinkSync(filePath);
      return null;
    }
    return parsed as SetupState;
  } catch {
    try { unlinkSync(filePath); } catch { /* ignore */ }
    return null;
  }
}

export function saveSetupState(filePath: string, state: SetupState): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
}

export async function autoRecoverIfPossible(
  filePath: string,
  listInstalledModels: () => Promise<string[]>,
): Promise<SetupState | null> {
  let installed: string[];
  try {
    installed = await listInstalledModels();
  } catch {
    return null;
  }
  const validatedIds = new Set(CATALOG.filter((e) => e.huginnValidated).map((e) => e.id));
  const matches = installed.filter((id) => validatedIds.has(id));
  if (matches.length === 0) return null;

  const matchingEntries = CATALOG.filter((e) => matches.includes(e.id));
  const largest = matchingEntries.reduce((a, b) =>
    a.downloadSizeBytes >= b.downloadSizeBytes ? a : b,
  );

  const state: SetupState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    installedChatModel: largest.id,
    installedAt: new Date().toISOString(),
    fitReportAtInstall: null,
    companyIdentity: null,
  };
  saveSetupState(filePath, state);
  return state;
}

export function applySetupState(next: SetupState): void {
  // Persist to disk first; if it throws (EACCES/ENOSPC/EROFS) leave in-memory
  // state untouched so we don't split-brain after a long install.
  saveSetupState(SETUP_FILE_PATH, next);
  setupHolder.current = next;
  if (next.installedChatModel !== null) {
    process.env["OLLAMA_CHAT_MODEL"] = next.installedChatModel;
  }
  healthState.setupReady = next.installedChatModel !== null;
}
