import { createInitialState } from "./state.ts";
import { CONFIG } from "./config.ts";
import { resolveProfile } from "./profiles/index.ts";
import { COMPANY_FILE_PATH, loadCompanyIdentity } from "./utils/company-identity.ts";
import { logger, setPhase, setProgressCallback } from "./utils/logger.ts";
import { loadDebugSettings } from "./debug/settings.ts";
import { stat } from "fs/promises";
import { checkTikaHealth } from "./parsers/tika.ts";
import { checkOllamaHealth } from "./llm/ollama.ts";
import { runHarvest } from "./phases/1-harvest.ts";
import { runParse } from "./phases/2-parse.ts";
import { runProjection } from "./phases/3-projection.ts";
import { runChunkQuality } from "./phases/4-chunk-quality.ts";
import { runFingerprint } from "./phases/5-fingerprint.ts";
import { runCluster } from "./phases/6-cluster.ts";
import { runReferences } from "./phases/7-references.ts";
import { runRequirements } from "./phases/8-requirements.ts";
import { runValidate } from "./phases/9-validate.ts";
import { runReport } from "./phases/10-report.ts";
import { randomUUID } from "crypto";
import { readdirSync } from "fs";
import type { SseEvent } from "./server/sse.ts";

export interface ScanSettings {
  embedModel: string;
  chatModel: string;
  llmSampleRate: number;
  sectionEmbeddings: boolean;
  sectorProfileId: string;  // default: "automotive_de"
}

export interface PipelineConfig {
  folder: string;
  settings: ScanSettings;
  onProgress?: (event: SseEvent) => void;
}

export interface PipelineResult {
  scanId: string;
  reportFiles: string[];
}

export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const { folder, settings, onProgress } = config;

  // Override env vars from settings for this run
  process.env["DOCUMENTS_ROOT"] = folder;
  process.env["OLLAMA_EMBED_MODEL"] = settings.embedModel;
  process.env["OLLAMA_CHAT_MODEL"] = settings.chatModel;
  process.env["LLM_SAMPLE_RATE"] = String(settings.llmSampleRate);
  process.env["SECTION_EMBEDDINGS"] = settings.sectionEmbeddings ? "1" : "0";

  const profile = resolveProfile(settings.sectorProfileId);
  const companyIdentity = loadCompanyIdentity(COMPANY_FILE_PATH);

  if (onProgress) {
    setProgressCallback((raw) => onProgress(raw as SseEvent));
  }

  const scanId = `scan-${Date.now()}-${randomUUID().slice(0, 8)}`;
  logger.info("=== Huginn pipeline start ===", { scanId, folder });

  const rootStat = await stat(folder);
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${folder}`);

  setPhase("startup");
  const tikaOk = await checkTikaHealth();
  if (!tikaOk) {
    logger.warn("Tika is not reachable — PDF parsing will be skipped", { url: CONFIG.tikaUrl });
  }

  const { ok: ollamaOk, modelsAvailable } = await checkOllamaHealth();
  const embedModel = settings.embedModel;
  const embedModelInstalled = modelsAvailable.some(
    (m) => m === embedModel || m.startsWith(embedModel.split(":")[0] + ":"),
  );
  const embedAvailable = ollamaOk && embedModelInstalled;
  if (ollamaOk && !embedModelInstalled) {
    logger.warn("Embed model not installed — semantic embeddings will be skipped", { embedModel });
  }

  const debugSettings = loadDebugSettings();
  const state = createInitialState(scanId, folder, profile, companyIdentity);
  if (debugSettings.enabled) {
    if (debugSettings.decisionAudit)   state.decisionAudit  = new Map();
    if (debugSettings.patternCoverage) state.patternCoverage = [];
    if (debugSettings.llmTrace)        state.llmTrace        = [];
    if (debugSettings.zeroOutputDocs)  state.zeroOutputDocs  = [];
  }

  const phases: Array<{ name: string; fn: () => Promise<void>; idx: number }> = [
    { name: "1-harvest",      fn: () => runHarvest(state),                idx: 0 },
    { name: "2-parse",        fn: () => runParse(state),                  idx: 1 },
    { name: "3-projection",   fn: () => runProjection(state),             idx: 2 },
    { name: "4-chunk-quality", fn: () => runChunkQuality(state, ollamaOk), idx: 3 },
    { name: "5-fingerprint",  fn: () => runFingerprint(state, embedAvailable),  idx: 4 },
    { name: "6-cluster",      fn: () => runCluster(state),                idx: 5 },
    { name: "7-references",   fn: () => runReferences(state, ollamaOk),   idx: 6 },
    { name: "8-requirements", fn: () => runRequirements(state, ollamaOk), idx: 7 },
    { name: "9-validate",     fn: () => runValidate(state),               idx: 8 },
    { name: "10-report",      fn: () => runReport(state, ollamaOk),       idx: 9 },
  ];

  // Emit a stats snapshot using state populated so far. Each phase that adds
  // a relevant count contributes its field; earlier phases keep their fields.
  const emitStats = (after: string): void => {
    if (!onProgress) return;
    const evt: { type: "stats"; filesFound?: number; parsed?: number; pairsScored?: number; versionPairs?: number; references?: number; requirements?: number } = { type: "stats" };
    // filesFound is known after harvest and onwards
    evt.filesFound = state.files.length;
    if (state.parsed.length > 0 || after !== "1-harvest") {
      evt.parsed = state.parsed.filter(p => p.parseSuccess).length;
    }
    // cluster computes pairs and version pairs
    if (after === "6-cluster" || after === "7-references" || after === "8-requirements" || after === "9-validate" || after === "10-report") {
      const eligible = state.parsed.filter(p => p.parseSuccess && p.charCount >= 200).length;
      evt.pairsScored = eligible > 1 ? (eligible * (eligible - 1)) / 2 : 0;
      evt.versionPairs = state.versionPairs.filter(p => p.confidence === "HIGH").length;
    }
    if (after === "7-references" || after === "8-requirements" || after === "9-validate" || after === "10-report") {
      evt.references = state.references.length;
    }
    if (after === "8-requirements" || after === "9-validate" || after === "10-report") {
      evt.requirements = state.requirements.length;
    }
    onProgress(evt);
  };

  for (const phase of phases) {
    const startedAt = Date.now();
    onProgress?.({ type: "phase_start", phase: phase.name, phaseIndex: phase.idx, totalPhases: 10 });
    try {
      await phase.fn();
      emitStats(phase.name);
      onProgress?.({ type: "phase_end", phase: phase.name, durationMs: Date.now() - startedAt });
    } catch (e) {
      onProgress?.({ type: "scan_error", phase: phase.name, message: String(e).slice(0, 200) });
      try {
        setPhase("emergency-report");
        await runReport(state);
      } catch { /* best-effort partial report */ }
      throw e;
    }
  }

  const reportDir = process.env["REPORT_OUTPUT"] || "/reports";
  let reportFiles: string[] = [];
  try {
    reportFiles = readdirSync(reportDir)
      .filter(f => f.endsWith(".json") || f.endsWith(".md") || f.endsWith(".html"))
      .sort()
      .slice(-4);
  } catch { /* not fatal */ }

  onProgress?.({ type: "scan_complete", scanId, reports: reportFiles });

  setProgressCallback(null);

  logger.info("=== Huginn pipeline complete ===", { scanId });
  return { scanId, reportFiles };
}
