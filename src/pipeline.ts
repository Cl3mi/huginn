import { createInitialState } from "./state.ts";
import { CONFIG } from "./config.ts";
import { logger, setPhase, setProgressCallback } from "./utils/logger.ts";
import { stat } from "fs/promises";
import { checkTikaHealth } from "./parsers/tika.ts";
import { checkOllamaHealth } from "./llm/ollama.ts";
import { runHarvest } from "./phases/1-harvest.ts";
import { runParse } from "./phases/2-parse.ts";
import { runFingerprint } from "./phases/3-fingerprint.ts";
import { runCluster } from "./phases/4-cluster.ts";
import { runReferences } from "./phases/5-references.ts";
import { runRequirements } from "./phases/6-requirements.ts";
import { runValidate } from "./phases/7-validate.ts";
import { runReport } from "./phases/8-report.ts";
import { runProjection } from "./phases/9-projection.ts";
import { randomUUID } from "crypto";
import { readdirSync } from "fs";
import type { SseEvent } from "./server/sse.ts";

export interface ScanSettings {
  embedModel: string;
  chatModel: string;
  llmSampleRate: number;
  sectionEmbeddings: boolean;
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

  const { ok: ollamaOk } = await checkOllamaHealth();

  const state = createInitialState(scanId, folder);

  const phases: Array<{ name: string; fn: () => Promise<void>; idx: number }> = [
    { name: "1-harvest",      fn: () => runHarvest(state),                idx: 0 },
    { name: "2-parse",        fn: () => runParse(state),                  idx: 1 },
    { name: "9-projection",   fn: () => runProjection(state),             idx: 2 },
    { name: "3-fingerprint",  fn: () => runFingerprint(state, ollamaOk),  idx: 3 },
    { name: "4-cluster",      fn: () => runCluster(state),                idx: 4 },
    { name: "5-references",   fn: () => runReferences(state, ollamaOk),   idx: 5 },
    { name: "6-requirements", fn: () => runRequirements(state, ollamaOk), idx: 6 },
    { name: "7-validate",     fn: () => runValidate(state),               idx: 7 },
    { name: "8-report",       fn: () => runReport(state, ollamaOk),       idx: 8 },
  ];

  for (const phase of phases) {
    onProgress?.({ type: "phase_start", phase: phase.name, phaseIndex: phase.idx, totalPhases: 9 });
    try {
      await phase.fn();
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
