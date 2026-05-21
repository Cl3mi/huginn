import { spawnSync } from "child_process";
import { CONFIG } from "../config.ts";
import type { CatalogEntry } from "./model-catalog.ts";

export type DetectedHardware = {
  gpuAvailable: boolean;
  vramGb: number;
  detectionMethod: "nvidia-smi" | "cpu-fallback";
  rawProbeOutput: string;
};

export type RankedEntry = CatalogEntry & {
  fits: boolean;
  recommended: boolean;
  relevanceScore: number;
};

const VRAM_SAFETY_MARGIN = 0.85;
const MAX_UI_CANDIDATES = 10;

function clamp(s: string, max = CONFIG.maxStringLengthInReport): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function parseNvidiaSmiOutput(stdout: string, exitCode: number): DetectedHardware {
  if (exitCode !== 0) {
    return {
      gpuAvailable: false,
      vramGb: 0,
      detectionMethod: "cpu-fallback",
      rawProbeOutput: clamp(stdout.trim()),
    };
  }
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const vrams: number[] = [];
  for (const line of lines) {
    const n = Number(line);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        gpuAvailable: false,
        vramGb: 0,
        detectionMethod: "cpu-fallback",
        rawProbeOutput: clamp(stdout.trim()),
      };
    }
    vrams.push(n);
  }
  if (vrams.length === 0) {
    return {
      gpuAvailable: false,
      vramGb: 0,
      detectionMethod: "cpu-fallback",
      rawProbeOutput: clamp(stdout.trim()),
    };
  }
  const smallestMib = Math.min(...vrams);
  const vramGb = Math.round(smallestMib / 1024);
  return {
    gpuAvailable: true,
    vramGb,
    detectionMethod: "nvidia-smi",
    rawProbeOutput: clamp(stdout.trim()),
  };
}

export function probeHardware(): DetectedHardware {
  try {
    const result = spawnSync(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 5000 },
    );
    if (result.error || result.status === null) {
      return {
        gpuAvailable: false,
        vramGb: 0,
        detectionMethod: "cpu-fallback",
        rawProbeOutput: clamp(String(result.error ?? "spawn failed")),
      };
    }
    return parseNvidiaSmiOutput(result.stdout ?? "", result.status);
  } catch (e) {
    return {
      gpuAvailable: false,
      vramGb: 0,
      detectionMethod: "cpu-fallback",
      rawProbeOutput: clamp(String(e)),
    };
  }
}

export function fits(entry: CatalogEntry, detected: DetectedHardware): boolean {
  if (entry.minVramGb === 0) return true;
  if (!detected.gpuAvailable) return false;
  return entry.minVramGb <= detected.vramGb * VRAM_SAFETY_MARGIN;
}

export function pickRecommended(
  catalog: readonly CatalogEntry[],
  detected: DetectedHardware,
): CatalogEntry | undefined {
  const fittingValidated = catalog.filter((e) => e.huginnValidated && fits(e, detected));
  if (fittingValidated.length > 0) {
    return fittingValidated.reduce((a, b) => (a.downloadSizeBytes >= b.downloadSizeBytes ? a : b));
  }
  const validated = catalog.filter((e) => e.huginnValidated);
  if (validated.length === 0) return undefined;
  return validated.reduce((a, b) => (a.downloadSizeBytes <= b.downloadSizeBytes ? a : b));
}

export function rankCatalog(
  catalog: readonly CatalogEntry[],
  detected: DetectedHardware,
): RankedEntry[] {
  const recommended = pickRecommended(catalog, detected);
  const recommendedId = recommended?.id ?? null;

  const fittingValidated = catalog
    .filter((e) => fits(e, detected) && e.huginnValidated)
    .sort((a, b) => b.downloadSizeBytes - a.downloadSizeBytes);

  const fittingUnvalidated = catalog
    .filter((e) => fits(e, detected) && !e.huginnValidated)
    .sort((a, b) => b.downloadSizeBytes - a.downloadSizeBytes);

  const nonFittingValidated = catalog
    .filter((e) => !fits(e, detected) && e.huginnValidated)
    .sort((a, b) => a.downloadSizeBytes - b.downloadSizeBytes);

  const ordered: CatalogEntry[] = [];
  if (recommended) ordered.push(recommended);
  for (const e of fittingValidated) if (e.id !== recommendedId) ordered.push(e);
  for (const e of fittingUnvalidated) if (e.id !== recommendedId) ordered.push(e);
  if (nonFittingValidated.length > 0) ordered.push(nonFittingValidated[0]!);

  const ranked: RankedEntry[] = ordered.slice(0, MAX_UI_CANDIDATES).map((e, idx) => ({
    ...e,
    fits: fits(e, detected),
    recommended: e.id === recommendedId,
    relevanceScore: MAX_UI_CANDIDATES - idx,
  }));
  return ranked;
}
