# Model Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `ollama-init` with an in-UI first-boot setup wizard that probes the host's GPU via `nvidia-smi`, recommends a chat model from a curated catalog, downloads it on demand with streamed progress, and lets users swap models later from a Settings page.

**Architecture:** Pure-data catalog + pure-function fit ranker + file-backed setup state inside the scanner container. Setup status is exposed via `/api/setup/*` HTTP endpoints and a new SSE channel for install progress. The UI has two surfaces: a first-boot wizard card that blocks the main scan flow until a model is installed, and a permanent "Settings → Model" panel for swapping models later. Auto-recovery on startup avoids re-running the wizard after container recreation when the persistent `ollama_data` volume still has a known catalog model.

**Tech Stack:** TypeScript, Bun (runtime + `bun:test` test runner), Ollama HTTP API (`/api/tags`, `/api/pull`), `nvidia-smi` for GPU detection, vanilla JS for the UI (existing `src/ui/index.html` is a single file).

---

## File Structure

**New files:**
- `src/llm/model-catalog.ts` — Pure data: the 13-entry chat model catalog with metadata.
- `src/llm/model-catalog.test.ts` — Catalog invariants (unique IDs, monotonic sizes, length limits).
- `src/llm/model-fit.ts` — Pure functions: `probeHardware()`, `rankCatalog()`, `pickRecommended()`.
- `src/llm/model-fit.test.ts` — Tests fit predicate, ranking, recommendation, `nvidia-smi` parsing.
- `src/llm/model-installer.ts` — Streams `/api/pull` from Ollama, emits progress callbacks.
- `src/llm/model-installer.test.ts` — Stream parsing tests with mocked fetch response.
- `src/server/setup-state.ts` — Reads/writes `/app/state/setup.json`, runs auto-recovery.
- `src/server/setup-state.test.ts` — Roundtrip, corrupt-file recovery, auto-recovery from Ollama tags.

**Modified files:**
- `src/server/sse.ts` — Add `model-install-*` event types to `SseEvent` union.
- `src/server/routes.ts` — Add `/api/setup/status`, `/api/setup/recommendation`, `/api/setup/install`, `/api/setup/cancel`.
- `src/server/index.ts` — Initialize setup state on startup, run auto-recovery, bind `OLLAMA_CHAT_MODEL` from setup state.
- `src/server/health-state.ts` — Add `setupReady: boolean` field.
- `src/ui/index.html` — Add `screen-setup` div with wizard card; add Settings → Model panel; wire JS to new endpoints + SSE channel.
- `docker-compose.yml` — Remove `ollama-init` service.
- `docker-compose.gpu.yml` — Add GPU device reservation for `scanner` service (so `nvidia-smi` works inside it).
- `Dockerfile.scanner` — Create `/app/state` directory.

---

## Task 1: Model Catalog

**Files:**
- Create: `src/llm/model-catalog.ts`
- Test:   `src/llm/model-catalog.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/llm/model-catalog.test.ts
import { expect, test, describe } from "bun:test";
import { CATALOG, type CatalogEntry } from "./model-catalog.ts";

describe("CATALOG", () => {
  test("has 13 entries", () => {
    expect(CATALOG.length).toBe(13);
  });

  test("all entry IDs are unique", () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all entries have notes <= 120 chars (Huginn project convention)", () => {
    for (const entry of CATALOG) {
      expect(entry.notes.length).toBeLessThanOrEqual(120);
    }
  });

  test("entries are sorted by ascending downloadSizeBytes", () => {
    for (let i = 1; i < CATALOG.length; i++) {
      expect(CATALOG[i]!.downloadSizeBytes)
        .toBeGreaterThanOrEqual(CATALOG[i - 1]!.downloadSizeBytes);
    }
  });

  test("minVramGb is 0 or >= 0.7 * raw-param-count for non-MoE entries", () => {
    for (const entry of CATALOG) {
      if (entry.family === "mixtral") continue; // MoE memory scales differently
      const numericParams = parseFloat(entry.parameterSize); // "8B" -> 8
      if (entry.minVramGb !== 0) {
        expect(entry.minVramGb).toBeGreaterThanOrEqual(numericParams * 0.7);
      }
    }
  });

  test("has at least one CPU-viable validated entry", () => {
    const cpuValidated = CATALOG.filter((e) => e.minVramGb === 0 && e.huginnValidated);
    expect(cpuValidated.length).toBeGreaterThan(0);
  });

  test("CatalogEntry shape compiles", () => {
    const entry: CatalogEntry = CATALOG[0]!;
    expect(typeof entry.id).toBe("string");
    expect(typeof entry.displayName).toBe("string");
    expect(typeof entry.huginnValidated).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/llm/model-catalog.test.ts
```

Expected: FAIL with `Cannot find module './model-catalog.ts'`.

- [ ] **Step 3: Implement the catalog**

```ts
// src/llm/model-catalog.ts
export type CatalogEntry = {
  id: string;
  displayName: string;
  family: "llama" | "qwen" | "gemma" | "phi" | "mixtral";
  parameterSize: string;   // "8B", "70B", "8x22B"
  quantization: string;    // "Q4", "FP16"
  downloadSizeBytes: number;
  minVramGb: number;       // 0 means CPU-viable
  huginnValidated: boolean;
  notes: string;           // <= 120 chars
};

const GB = 1024 * 1024 * 1024;

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "llama3.2:1b",
    displayName: "Llama 3.2 1B",
    family: "llama",
    parameterSize: "1B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(1.3 * GB),
    minVramGb: 0,
    huginnValidated: true,
    notes: "Smallest model. Fast on weak hardware. Narrative quality limited.",
  },
  {
    id: "llama3.2:3b",
    displayName: "Llama 3.2 3B",
    family: "llama",
    parameterSize: "3B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(2.0 * GB),
    minVramGb: 0,
    huginnValidated: true,
    notes: "CPU fallback. Decent quality. Good baseline for low-end hosts.",
  },
  {
    id: "phi3:mini",
    displayName: "Phi 3 Mini",
    family: "phi",
    parameterSize: "3.8B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(2.3 * GB),
    minVramGb: 0,
    huginnValidated: true,
    notes: "Strong structured output for size. Good on CPU.",
  },
  {
    id: "qwen2.5:7b",
    displayName: "Qwen 2.5 7B",
    family: "qwen",
    parameterSize: "7B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(4.4 * GB),
    minVramGb: 5,
    huginnValidated: true,
    notes: "Strong JSON adherence. Good for Phase 6 LLM validation.",
  },
  {
    id: "llama3.1:8b",
    displayName: "Llama 3.1 8B",
    family: "llama",
    parameterSize: "8B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(4.7 * GB),
    minVramGb: 6,
    huginnValidated: true,
    notes: "Prior Huginn default. Broadly safe choice.",
  },
  {
    id: "gemma2:9b",
    displayName: "Gemma 2 9B",
    family: "gemma",
    parameterSize: "9B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(5.5 * GB),
    minVramGb: 7,
    huginnValidated: true,
    notes: "Strong narrative quality. Phase 8 prose reads well.",
  },
  {
    id: "qwen2.5:14b",
    displayName: "Qwen 2.5 14B",
    family: "qwen",
    parameterSize: "14B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(8.4 * GB),
    minVramGb: 10,
    huginnValidated: true,
    notes: "Sweet spot for prosumer GPUs (RTX 3080+).",
  },
  {
    id: "qwen2.5:32b",
    displayName: "Qwen 2.5 32B",
    family: "qwen",
    parameterSize: "32B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(19 * GB),
    minVramGb: 22,
    huginnValidated: false,
    notes: "Mid-range datacenter. Untested with Huginn prompts.",
  },
  {
    id: "mixtral:8x7b",
    displayName: "Mixtral 8x7B",
    family: "mixtral",
    parameterSize: "8x7B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(26 * GB),
    minVramGb: 28,
    huginnValidated: false,
    notes: "MoE architecture. Fast inference. Untested with Huginn.",
  },
  {
    id: "llama3.3:70b",
    displayName: "Llama 3.3 70B",
    family: "llama",
    parameterSize: "70B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(40 * GB),
    minVramGb: 45,
    huginnValidated: false,
    notes: "Datacenter-grade quality. Untested with Huginn.",
  },
  {
    id: "qwen2.5:72b",
    displayName: "Qwen 2.5 72B",
    family: "qwen",
    parameterSize: "72B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(41 * GB),
    minVramGb: 46,
    huginnValidated: false,
    notes: "Strong small-batch quality. Untested with Huginn.",
  },
  {
    id: "mixtral:8x22b",
    displayName: "Mixtral 8x22B",
    family: "mixtral",
    parameterSize: "8x22B",
    quantization: "Q4",
    downloadSizeBytes: Math.round(80 * GB),
    minVramGb: 88,
    huginnValidated: false,
    notes: "High-end MoE. Untested with Huginn.",
  },
  {
    id: "llama3.3:70b-fp16",
    displayName: "Llama 3.3 70B FP16",
    family: "llama",
    parameterSize: "70B",
    quantization: "FP16",
    downloadSizeBytes: Math.round(140 * GB),
    minVramGb: 145,
    huginnValidated: false,
    notes: "Full precision. Maximum quality. Untested with Huginn.",
  },
] as const;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/llm/model-catalog.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/llm/model-catalog.ts src/llm/model-catalog.test.ts
git commit -m "feat: add curated chat model catalog with 13 entries"
```

---

## Task 2: Hardware Probe and Fit Ranker

**Files:**
- Create: `src/llm/model-fit.ts`
- Test:   `src/llm/model-fit.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/llm/model-fit.test.ts
import { expect, test, describe } from "bun:test";
import {
  parseNvidiaSmiOutput,
  fits,
  rankCatalog,
  pickRecommended,
  type DetectedHardware,
} from "./model-fit.ts";
import { CATALOG } from "./model-catalog.ts";

describe("parseNvidiaSmiOutput", () => {
  test("parses single-GPU output (MiB) to GB", () => {
    const result = parseNvidiaSmiOutput("8192\n", 0);
    expect(result.gpuAvailable).toBe(true);
    expect(result.vramGb).toBe(8);
    expect(result.detectionMethod).toBe("nvidia-smi");
  });

  test("parses multi-GPU output and uses smallest VRAM", () => {
    const result = parseNvidiaSmiOutput("24576\n8192\n16384\n", 0);
    expect(result.vramGb).toBe(8); // smallest of 24, 8, 16
  });

  test("returns CPU fallback when exit code is non-zero", () => {
    const result = parseNvidiaSmiOutput("", 127);
    expect(result.gpuAvailable).toBe(false);
    expect(result.vramGb).toBe(0);
    expect(result.detectionMethod).toBe("cpu-fallback");
  });

  test("returns CPU fallback when output is non-numeric", () => {
    const result = parseNvidiaSmiOutput("not a number\n", 0);
    expect(result.gpuAvailable).toBe(false);
    expect(result.vramGb).toBe(0);
  });

  test("rawProbeOutput is clamped to <= 120 chars", () => {
    const long = "x".repeat(500);
    const result = parseNvidiaSmiOutput(long, 1);
    expect(result.rawProbeOutput.length).toBeLessThanOrEqual(120);
  });
});

describe("fits", () => {
  test("CPU-viable entry (minVramGb=0) fits on CPU-only host", () => {
    const entry = CATALOG.find((e) => e.id === "llama3.2:3b")!;
    expect(fits(entry, { gpuAvailable: false, vramGb: 0, detectionMethod: "cpu-fallback", rawProbeOutput: "" })).toBe(true);
  });

  test("8B entry does not fit on CPU-only host", () => {
    const entry = CATALOG.find((e) => e.id === "llama3.1:8b")!;
    expect(fits(entry, { gpuAvailable: false, vramGb: 0, detectionMethod: "cpu-fallback", rawProbeOutput: "" })).toBe(false);
  });

  test("8B entry (6GB min) fits on 8GB GPU with 15% margin (6 <= 8*0.85=6.8)", () => {
    const entry = CATALOG.find((e) => e.id === "llama3.1:8b")!;
    expect(fits(entry, { gpuAvailable: true, vramGb: 8, detectionMethod: "nvidia-smi", rawProbeOutput: "" })).toBe(true);
  });

  test("9B entry (7GB min) does NOT fit on 8GB GPU with 15% margin (7 > 8*0.85=6.8)", () => {
    const entry = CATALOG.find((e) => e.id === "gemma2:9b")!;
    expect(fits(entry, { gpuAvailable: true, vramGb: 8, detectionMethod: "nvidia-smi", rawProbeOutput: "" })).toBe(false);
  });

  test("70B fp16 entry (145GB min) fits on 200GB host", () => {
    const entry = CATALOG.find((e) => e.id === "llama3.3:70b-fp16")!;
    expect(fits(entry, { gpuAvailable: true, vramGb: 200, detectionMethod: "nvidia-smi", rawProbeOutput: "" })).toBe(true);
  });
});

describe("pickRecommended", () => {
  test("picks largest validated entry that fits on CPU", () => {
    const detected: DetectedHardware = { gpuAvailable: false, vramGb: 0, detectionMethod: "cpu-fallback", rawProbeOutput: "" };
    const rec = pickRecommended(CATALOG, detected);
    expect(rec).toBeDefined();
    expect(rec!.huginnValidated).toBe(true);
    expect(rec!.minVramGb).toBe(0);
    // phi3:mini is the largest CPU-viable validated entry by downloadSize
    expect(rec!.id).toBe("phi3:mini");
  });

  test("picks largest validated entry that fits on 8GB GPU (llama3.1:8b)", () => {
    const detected: DetectedHardware = { gpuAvailable: true, vramGb: 8, detectionMethod: "nvidia-smi", rawProbeOutput: "" };
    const rec = pickRecommended(CATALOG, detected);
    expect(rec!.id).toBe("llama3.1:8b");
  });

  test("picks largest validated entry that fits on 16GB GPU (qwen2.5:14b)", () => {
    const detected: DetectedHardware = { gpuAvailable: true, vramGb: 16, detectionMethod: "nvidia-smi", rawProbeOutput: "" };
    const rec = pickRecommended(CATALOG, detected);
    expect(rec!.id).toBe("qwen2.5:14b");
  });

  test("on huge GPU, recommendation is still a validated entry (qwen2.5:14b)", () => {
    const detected: DetectedHardware = { gpuAvailable: true, vramGb: 200, detectionMethod: "nvidia-smi", rawProbeOutput: "" };
    const rec = pickRecommended(CATALOG, detected);
    expect(rec!.huginnValidated).toBe(true);
    expect(rec!.id).toBe("qwen2.5:14b"); // largest validated
  });
});

describe("rankCatalog", () => {
  test("returns at most 10 candidates", () => {
    const detected: DetectedHardware = { gpuAvailable: true, vramGb: 8, detectionMethod: "nvidia-smi", rawProbeOutput: "" };
    const ranked = rankCatalog(CATALOG, detected);
    expect(ranked.length).toBeLessThanOrEqual(10);
  });

  test("recommended entry is first", () => {
    const detected: DetectedHardware = { gpuAvailable: true, vramGb: 8, detectionMethod: "nvidia-smi", rawProbeOutput: "" };
    const ranked = rankCatalog(CATALOG, detected);
    expect(ranked[0]!.recommended).toBe(true);
  });

  test("fitting validated entries appear before fitting unvalidated", () => {
    const detected: DetectedHardware = { gpuAvailable: true, vramGb: 50, detectionMethod: "nvidia-smi", rawProbeOutput: "" };
    const ranked = rankCatalog(CATALOG, detected);
    const fittingOnly = ranked.filter((r) => r.fits);
    let seenUnvalidated = false;
    for (const entry of fittingOnly) {
      if (!entry.huginnValidated) seenUnvalidated = true;
      if (seenUnvalidated) expect(entry.huginnValidated).toBe(false);
    }
  });

  test("includes the single smallest non-fitting validated entry on 4GB GPU", () => {
    // 4GB GPU: only CPU-viable entries fit (phi3:mini, llama3.2:3b, llama3.2:1b).
    // Smallest non-fitting validated entry is qwen2.5:7b.
    const detected: DetectedHardware = { gpuAvailable: true, vramGb: 4, detectionMethod: "nvidia-smi", rawProbeOutput: "" };
    const ranked = rankCatalog(CATALOG, detected);
    const nonFitting = ranked.filter((r) => !r.fits);
    expect(nonFitting.length).toBeGreaterThanOrEqual(1);
    expect(nonFitting[0]!.id).toBe("qwen2.5:7b");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/llm/model-fit.test.ts
```

Expected: FAIL with `Cannot find module './model-fit.ts'`.

- [ ] **Step 3: Implement the fit module**

```ts
// src/llm/model-fit.ts
import { spawnSync } from "child_process";
import { CONFIG } from "../config.ts";
import type { CatalogEntry } from "./model-catalog.ts";

export type DetectedHardware = {
  gpuAvailable: boolean;
  vramGb: number;
  detectionMethod: "nvidia-smi" | "cpu-fallback";
  rawProbeOutput: string;       // <= 120 chars, for diagnostics
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
  // Fallback: smallest validated entry overall (won't normally happen — 0-vram entries always fit)
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/llm/model-fit.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/llm/model-fit.ts src/llm/model-fit.test.ts
git commit -m "feat: add nvidia-smi probe and catalog fit ranker"
```

---

## Task 3: Setup State Persistence

**Files:**
- Create: `src/server/setup-state.ts`
- Test:   `src/server/setup-state.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/server/setup-state.test.ts
import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  loadSetupState,
  saveSetupState,
  autoRecoverIfPossible,
  type SetupState,
} from "./setup-state.ts";

const TMP = "/tmp/huginn-setup-test";
const FILE = join(TMP, "setup.json");

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("loadSetupState / saveSetupState", () => {
  test("returns null when file does not exist", () => {
    expect(loadSetupState(FILE)).toBeNull();
  });

  test("round-trips a valid state", () => {
    const state: SetupState = {
      schemaVersion: 1,
      installedChatModel: "llama3.1:8b",
      installedAt: "2026-05-21T10:00:00.000Z",
      fitReportAtInstall: null,
    };
    saveSetupState(FILE, state);
    expect(existsSync(FILE)).toBe(true);
    const loaded = loadSetupState(FILE);
    expect(loaded).toEqual(state);
  });

  test("returns null and deletes corrupt JSON", () => {
    writeFileSync(FILE, "{ not valid json");
    expect(loadSetupState(FILE)).toBeNull();
    expect(existsSync(FILE)).toBe(false);
  });

  test("returns null and deletes mismatched schema version", () => {
    writeFileSync(FILE, JSON.stringify({ schemaVersion: 99, installedChatModel: "x" }));
    expect(loadSetupState(FILE)).toBeNull();
    expect(existsSync(FILE)).toBe(false);
  });
});

describe("autoRecoverIfPossible", () => {
  test("returns null when no catalog model is installed in Ollama", async () => {
    const recovered = await autoRecoverIfPossible(FILE, async () => ["random-model:1.0"]);
    expect(recovered).toBeNull();
    expect(existsSync(FILE)).toBe(false);
  });

  test("picks largest validated catalog model when multiple are installed", async () => {
    const recovered = await autoRecoverIfPossible(FILE, async () => [
      "llama3.2:3b",
      "llama3.1:8b",
      "qwen2.5:14b",
      "junk-model",
    ]);
    expect(recovered).not.toBeNull();
    expect(recovered!.installedChatModel).toBe("qwen2.5:14b"); // largest validated
    expect(existsSync(FILE)).toBe(true);
  });

  test("ignores unvalidated catalog entries during auto-recovery", async () => {
    const recovered = await autoRecoverIfPossible(FILE, async () => [
      "llama3.1:8b",
      "llama3.3:70b", // unvalidated; should not be picked
    ]);
    expect(recovered).not.toBeNull();
    expect(recovered!.installedChatModel).toBe("llama3.1:8b");
  });

  test("returns null and does not write file when Ollama tags lookup throws", async () => {
    const recovered = await autoRecoverIfPossible(FILE, async () => {
      throw new Error("ollama down");
    });
    expect(recovered).toBeNull();
    expect(existsSync(FILE)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/server/setup-state.test.ts
```

Expected: FAIL with `Cannot find module './setup-state.ts'`.

- [ ] **Step 3: Implement the setup-state module**

```ts
// src/server/setup-state.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname } from "path";
import { CATALOG } from "../llm/model-catalog.ts";
import type { DetectedHardware, RankedEntry } from "../llm/model-fit.ts";

export type SetupState = {
  schemaVersion: 1;
  installedChatModel: string | null;
  installedAt: string | null;
  fitReportAtInstall: {
    detected: DetectedHardware;
    candidates: RankedEntry[];
  } | null;
};

const CURRENT_SCHEMA_VERSION = 1;

export const SETUP_FILE_PATH = "/app/state/setup.json";

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
  };
  saveSetupState(filePath, state);
  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/server/setup-state.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/setup-state.ts src/server/setup-state.test.ts
git commit -m "feat: add setup state persistence with auto-recovery"
```

---

## Task 4: Model Installer (Streaming Pull)

**Files:**
- Create: `src/llm/model-installer.ts`
- Test:   `src/llm/model-installer.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/llm/model-installer.test.ts
import { expect, test, describe } from "bun:test";
import { parseOllamaPullLine, type PullEvent } from "./model-installer.ts";

describe("parseOllamaPullLine", () => {
  test("parses a 'pulling manifest' status line", () => {
    const ev = parseOllamaPullLine(`{"status":"pulling manifest"}`);
    expect(ev).toEqual({ type: "status", status: "pulling manifest" });
  });

  test("parses a progress line with completed/total bytes", () => {
    const line = `{"status":"pulling abc123","completed":1024,"total":2048}`;
    const ev = parseOllamaPullLine(line);
    expect(ev).toEqual({ type: "progress", completedBytes: 1024, totalBytes: 2048 });
  });

  test("parses a 'success' final line", () => {
    const ev = parseOllamaPullLine(`{"status":"success"}`);
    expect(ev).toEqual({ type: "complete" });
  });

  test("returns null for malformed JSON", () => {
    expect(parseOllamaPullLine("not json")).toBeNull();
  });

  test("returns null for empty line", () => {
    expect(parseOllamaPullLine("")).toBeNull();
  });

  test("returns an error event when error field is present", () => {
    const ev = parseOllamaPullLine(`{"error":"manifest not found"}`);
    expect(ev).toEqual({ type: "error", message: "manifest not found" });
  });

  test("clamps long error messages to <= 120 chars", () => {
    const longMsg = "x".repeat(500);
    const ev = parseOllamaPullLine(JSON.stringify({ error: longMsg }));
    expect(ev?.type).toBe("error");
    if (ev?.type === "error") {
      expect(ev.message.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("PullEvent type discriminator (compile-time)", () => {
  test("can discriminate on type field", () => {
    const events: PullEvent[] = [
      { type: "status", status: "pulling manifest" },
      { type: "progress", completedBytes: 0, totalBytes: 100 },
      { type: "complete" },
      { type: "error", message: "fail" },
    ];
    expect(events.length).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/llm/model-installer.test.ts
```

Expected: FAIL with `Cannot find module './model-installer.ts'`.

- [ ] **Step 3: Implement the installer module**

```ts
// src/llm/model-installer.ts
import { CONFIG } from "../config.ts";

export type PullEvent =
  | { type: "status"; status: string }
  | { type: "progress"; completedBytes: number; totalBytes: number }
  | { type: "complete" }
  | { type: "error"; message: string };

function clamp(s: string, max = CONFIG.maxStringLengthInReport): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function parseOllamaPullLine(line: string): PullEvent | null {
  if (!line || line.trim().length === 0) return null;
  let obj: { status?: string; completed?: number; total?: number; error?: string };
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj.error === "string") {
    return { type: "error", message: clamp(obj.error) };
  }
  if (obj.status === "success") {
    return { type: "complete" };
  }
  if (typeof obj.completed === "number" && typeof obj.total === "number") {
    return { type: "progress", completedBytes: obj.completed, totalBytes: obj.total };
  }
  if (typeof obj.status === "string") {
    return { type: "status", status: clamp(obj.status) };
  }
  return null;
}

export type PullController = {
  abort: () => void;
};

export async function pullModel(
  modelId: string,
  onEvent: (ev: PullEvent) => void,
): Promise<PullController> {
  const controller = new AbortController();
  const pc: PullController = { abort: () => controller.abort() };

  (async () => {
    try {
      const res = await fetch(`${CONFIG.ollamaUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelId, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        onEvent({ type: "error", message: clamp(`pull HTTP ${res.status}`) });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          const ev = parseOllamaPullLine(line);
          if (ev) onEvent(ev);
          nl = buffer.indexOf("\n");
        }
      }
      const tail = buffer.trim();
      if (tail) {
        const ev = parseOllamaPullLine(tail);
        if (ev) onEvent(ev);
      }
    } catch (e: unknown) {
      if (controller.signal.aborted) {
        onEvent({ type: "error", message: "cancelled" });
      } else {
        onEvent({ type: "error", message: clamp(String(e)) });
      }
    }
  })();

  return pc;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/llm/model-installer.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/llm/model-installer.ts src/llm/model-installer.test.ts
git commit -m "feat: add streaming Ollama model installer"
```

---

## Task 5: Extend SSE Event Types

**Files:**
- Modify: `src/server/sse.ts`

- [ ] **Step 1: Add install event types to the `SseEvent` union**

Replace the `SseEvent` union in `src/server/sse.ts` with this version:

```ts
export type SseEvent =
  | { type: "phase_start"; phase: string; phaseIndex: number; totalPhases: number }
  | { type: "phase_end"; phase: string; durationMs: number }
  | { type: "log"; level: "INFO" | "WARN" | "ERROR"; phase: string; message: string }
  | { type: "stats"; filesFound?: number; parsed?: number; pairsScored?: number; versionPairs?: number; references?: number; requirements?: number }
  | { type: "scan_complete"; scanId: string; reports: string[] }
  | { type: "scan_error"; phase: string; message: string }
  | { type: "model_install_started"; modelId: string }
  | { type: "model_install_progress"; modelId: string; completedBytes: number; totalBytes: number }
  | { type: "model_install_status"; modelId: string; status: string }
  | { type: "model_install_complete"; modelId: string }
  | { type: "model_install_error"; modelId: string; message: string };
```

(Leave `encodeSseEvent` and `SseBroadcaster` unchanged.)

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors (the new events are additive).

- [ ] **Step 3: Commit**

```bash
git add src/server/sse.ts
git commit -m "feat: add model-install SSE event types"
```

---

## Task 6: Add `setupReady` to Health State

**Files:**
- Modify: `src/server/health-state.ts`

- [ ] **Step 1: Add the new field**

Replace the contents of `src/server/health-state.ts` with:

```ts
export const healthState = {
  tikaOk: false,
  ollamaOk: false,
  modelsAvailable: [] as string[],
  setupReady: false,
};
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/health-state.ts
git commit -m "feat: add setupReady flag to health state"
```

---

## Task 7: Wire Setup Into Server Startup

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/server/setup-state.ts` (add `applySetupState` helper)

- [ ] **Step 1: Add `applySetupState` helper to `src/server/setup-state.ts`**

Append this function to the bottom of `src/server/setup-state.ts`:

```ts
import { healthState } from "./health-state.ts";

export function applySetupState(next: SetupState): void {
  setupHolder.current = next;
  saveSetupState(SETUP_FILE_PATH, next);
  if (next.installedChatModel) {
    process.env["OLLAMA_CHAT_MODEL"] = next.installedChatModel;
  }
  healthState.setupReady = next.installedChatModel !== null;
}
```

(Note: this re-imports the file's own existing `saveSetupState`, `setupHolder`, and `SETUP_FILE_PATH`; no need to re-import those.)

- [ ] **Step 2: Replace the contents of `src/server/index.ts`**

```ts
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { checkTikaHealth } from "../parsers/tika.ts";
import { checkOllamaHealth } from "../llm/ollama.ts";
import { runRegexTests } from "../utils/regex-patterns.ts";
import { handleRequest } from "./routes.ts";
import { healthState } from "./health-state.ts";
import {
  loadSetupState,
  autoRecoverIfPossible,
  setupHolder,
  applySetupState,
  SETUP_FILE_PATH,
} from "./setup-state.ts";

async function initSetup(): Promise<void> {
  const loaded = loadSetupState(SETUP_FILE_PATH);
  if (loaded && loaded.installedChatModel) {
    applySetupState(loaded);
    logger.info("setup state loaded from disk", { model: loaded.installedChatModel });
    return;
  }
  const recovered = await autoRecoverIfPossible(SETUP_FILE_PATH, async () => {
    const { modelsAvailable } = await checkOllamaHealth();
    return modelsAvailable;
  });
  if (recovered) {
    applySetupState(recovered);
    logger.info("setup state auto-recovered from Ollama", { model: recovered.installedChatModel });
    return;
  }
  setupHolder.current = null;
  healthState.setupReady = false;
  logger.info("setup required: no chat model installed");
}

async function start() {
  const regexResult = runRegexTests();
  if (!regexResult.passed) {
    logger.error("Regex test suite FAILED — aborting", { failures: regexResult.failures });
    process.exit(1);
  }

  const [tikaOk, { ok: ollamaOk, modelsAvailable }] = await Promise.all([
    checkTikaHealth(),
    checkOllamaHealth(),
  ]);
  healthState.tikaOk = tikaOk;
  healthState.ollamaOk = ollamaOk;
  healthState.modelsAvailable = modelsAvailable;

  if (!tikaOk) logger.warn("Tika unreachable — PDF parsing will be skipped");
  if (!ollamaOk) {
    logger.error("Ollama unreachable — aborting (hard gate)");
    process.exit(1);
  }

  await initSetup();

  setInterval(async () => {
    const [t, { ok: o, modelsAvailable: m }] = await Promise.all([
      checkTikaHealth(),
      checkOllamaHealth(),
    ]);
    healthState.tikaOk = t;
    healthState.ollamaOk = o;
    healthState.modelsAvailable = m;
  }, 30_000);

  Bun.serve({
    port: CONFIG.serverPort,
    idleTimeout: 0,
    fetch: handleRequest,
  });

  logger.info(`Huginn server ready`, { url: `http://localhost:${CONFIG.serverPort}` });
  console.log(`\n  Huginn ready → http://localhost:${CONFIG.serverPort}\n`);
  if (!healthState.setupReady) {
    console.log("  Setup required — open the UI to install a chat model.\n");
  }
}

start().catch(e => {
  console.error("Server failed to start:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run the server in offline mode to verify it boots without setup.json**

```bash
OLLAMA_URL=http://localhost:11435 bun run src/index.ts
```

Expected: aborts because Ollama is unreachable (correct — hard gate). Use CTRL+C to stop if hung.

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: wire setup state into server startup with auto-recovery"
```

---

## Task 8: Add `/api/setup/*` HTTP Endpoints

**Files:**
- Modify: `src/server/routes.ts`

- [ ] **Step 1: Add a setup module orchestrator at the top of routes.ts**

Add these imports near the top of `src/server/routes.ts`, just below the existing imports:

```ts
import { CATALOG } from "../llm/model-catalog.ts";
import { probeHardware, rankCatalog } from "../llm/model-fit.ts";
import { pullModel, type PullController } from "../llm/model-installer.ts";
import { setupHolder, applySetupState } from "./setup-state.ts";
```

- [ ] **Step 2: Add the active-pull tracker module-scope near the top of routes.ts**

Just below the imports block:

```ts
type ActivePull = {
  modelId: string;
  controller: PullController;
  totalBytes: number;
  completedBytes: number;
  lastEvent: "started" | "progress" | "complete" | "error";
  lastError?: string;
};

let activePull: ActivePull | null = null;
```

- [ ] **Step 3: Add the four setup handlers**

Add these functions to `src/server/routes.ts`, placed just above the `handleRequest` function:

```ts
function handleSetupStatus(): Response {
  const current = setupHolder.current;
  const ready = current !== null && current.installedChatModel !== null;
  return json({
    state: ready ? "ready" : "needsSetup",
    installedChatModel: ready ? current!.installedChatModel : null,
    activePull: activePull
      ? {
          modelId: activePull.modelId,
          completedBytes: activePull.completedBytes,
          totalBytes: activePull.totalBytes,
          status: activePull.lastEvent,
        }
      : null,
  });
}

function handleSetupRecommendation(): Response {
  const detected = probeHardware();
  const candidates = rankCatalog(CATALOG, detected);
  return json({
    detected,
    candidates,
  });
}

async function handleSetupInstall(req: Request): Promise<Response> {
  let body: { modelId?: string };
  try {
    body = (await req.json()) as { modelId?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const modelId = body.modelId;
  if (!modelId || typeof modelId !== "string") {
    return json({ error: "modelId is required" }, 400);
  }
  if (!CATALOG.some((e) => e.id === modelId)) {
    return json({ error: "unknown model" }, 400);
  }
  if (activePull && activePull.lastEvent !== "complete" && activePull.lastEvent !== "error") {
    if (activePull.modelId === modelId) {
      return json({ status: "already_running", modelId }, 200);
    }
    return json({ error: "another pull in progress", modelId: activePull.modelId }, 409);
  }

  const tracker: ActivePull = {
    modelId,
    controller: { abort: () => {} },
    totalBytes: 0,
    completedBytes: 0,
    lastEvent: "started",
  };
  activePull = tracker;
  broadcaster.emit({ type: "model_install_started", modelId });

  const ctl = await pullModel(modelId, (ev) => {
    if (ev.type === "status") {
      broadcaster.emit({ type: "model_install_status", modelId, status: ev.status });
    } else if (ev.type === "progress") {
      tracker.completedBytes = ev.completedBytes;
      tracker.totalBytes = ev.totalBytes;
      tracker.lastEvent = "progress";
      broadcaster.emit({
        type: "model_install_progress",
        modelId,
        completedBytes: ev.completedBytes,
        totalBytes: ev.totalBytes,
      });
    } else if (ev.type === "complete") {
      tracker.lastEvent = "complete";
      applySetupState({
        schemaVersion: 1,
        installedChatModel: modelId,
        installedAt: new Date().toISOString(),
        fitReportAtInstall: null,
      });
      broadcaster.emit({ type: "model_install_complete", modelId });
    } else if (ev.type === "error") {
      tracker.lastEvent = "error";
      tracker.lastError = ev.message;
      broadcaster.emit({ type: "model_install_error", modelId, message: ev.message });
    }
  });
  tracker.controller = ctl;

  return json({ status: "started", modelId }, 202);
}

function handleSetupCancel(): Response {
  if (!activePull || activePull.lastEvent === "complete" || activePull.lastEvent === "error") {
    return json({ status: "no_active_pull" }, 200);
  }
  activePull.controller.abort();
  return json({ status: "cancelled", modelId: activePull.modelId }, 200);
}
```

Note: routes.ts now reads the singleton via `setupHolder.current` (live reference, updates as setup state changes) and writes via `applySetupState`, both imported from `setup-state.ts`. No circular import with `server/index.ts`.

- [ ] **Step 4: Register the routes inside `handleRequest`**

In `src/server/routes.ts`, locate the `handleRequest` function. Add these route lines just below the existing `/api/reports-zip` line (before the `reportMatch` block):

```ts
  if (path === "/api/setup/status" && req.method === "GET") return handleSetupStatus();
  if (path === "/api/setup/recommendation" && req.method === "GET") return handleSetupRecommendation();
  if (path === "/api/setup/install" && req.method === "POST") return handleSetupInstall(req);
  if (path === "/api/setup/cancel" && req.method === "POST") return handleSetupCancel();
```

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes.ts
git commit -m "feat: add /api/setup endpoints (status, recommendation, install, cancel)"
```

---

## Task 9: Pipeline Guard — Refuse Scans Before Setup

**Files:**
- Modify: `src/server/routes.ts`

- [ ] **Step 1: Add the guard at the top of `handleStartScan`**

In `src/server/routes.ts`, modify the `handleStartScan` function. Add this check immediately after the `if (scanState.status === "running")` block:

```ts
  if (!setupHolder.current || setupHolder.current.installedChatModel === null) {
    return json({ error: "setup_required" }, 409);
  }
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/routes.ts
git commit -m "feat: refuse scans until setup is complete"
```

---

## Task 10: UI — First-Boot Setup Wizard Screen

**Files:**
- Modify: `src/ui/index.html`

- [ ] **Step 1: Add the setup-screen markup just inside `<body>`**

In `src/ui/index.html`, locate `<body>` (around line 152). Insert the following block immediately after the existing `.topbar` div closes and before the first existing `.screen` div:

```html
<div class="screen" id="screen-setup" style="display:none;">
  <div class="page" style="max-width:680px;">
    <div class="page-header">
      <div class="page-title">Setting up Huginn</div>
      <div class="page-subtitle" id="setup-subtitle">Detecting hardware...</div>
    </div>

    <div class="card">
      <div class="card-title">Recommended model</div>

      <div id="setup-detected" class="field-hint" style="margin-bottom:1rem;"></div>

      <div id="setup-recommended" style="display:none;">
        <div style="font-family:var(--font-heading);font-size:1.125rem;font-weight:600;margin-bottom:.25rem;" id="setup-rec-name"></div>
        <div class="field-hint" id="setup-rec-meta" style="margin-bottom:.5rem;"></div>
        <div class="field-hint" id="setup-rec-notes" style="margin-bottom:1rem;"></div>
        <div class="actions">
          <button class="btn-primary" id="btn-setup-install">Install and continue</button>
          <button class="btn-secondary" id="btn-setup-toggle-alt">Show alternatives</button>
        </div>
      </div>

      <div id="setup-alternatives" style="display:none;margin-top:1.25rem;border-top:1px solid var(--border);padding-top:1rem;"></div>

      <div id="setup-progress" style="display:none;margin-top:1rem;">
        <div class="progress-label">
          <span id="setup-progress-label">Downloading...</span>
          <span id="setup-progress-bytes">0 / 0</span>
        </div>
        <div class="progress-track"><div class="progress-fill" id="setup-progress-fill"></div></div>
        <div class="actions" style="margin-top:.75rem;">
          <button class="btn-secondary" id="btn-setup-cancel">Cancel</button>
        </div>
      </div>

      <div class="alert alert-error" id="setup-error" style="display:none;"></div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add the setup JS inside the `<script>` block**

In `src/ui/index.html`, locate the `<script>` tag (around line 369). Add this code at the top of the script (before any existing JS):

```js
// ---- Setup wizard ----
const setupEl = {
  screen: document.getElementById("screen-setup"),
  subtitle: document.getElementById("setup-subtitle"),
  detected: document.getElementById("setup-detected"),
  recommended: document.getElementById("setup-recommended"),
  recName: document.getElementById("setup-rec-name"),
  recMeta: document.getElementById("setup-rec-meta"),
  recNotes: document.getElementById("setup-rec-notes"),
  btnInstall: document.getElementById("btn-setup-install"),
  btnToggleAlt: document.getElementById("btn-setup-toggle-alt"),
  alternatives: document.getElementById("setup-alternatives"),
  progress: document.getElementById("setup-progress"),
  progressLabel: document.getElementById("setup-progress-label"),
  progressBytes: document.getElementById("setup-progress-bytes"),
  progressFill: document.getElementById("setup-progress-fill"),
  btnCancel: document.getElementById("btn-setup-cancel"),
  errorBox: document.getElementById("setup-error"),
};

let setupCandidates = [];
let setupRecommended = null;
let setupSelectedModelId = null;

function fmtGb(bytes) {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

function fmtBytes(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

async function showSetupScreen() {
  document.querySelectorAll(".screen").forEach((s) => (s.style.display = "none"));
  setupEl.screen.style.display = "block";
  setupEl.subtitle.textContent = "Detecting hardware...";
  setupEl.detected.textContent = "";
  setupEl.recommended.style.display = "none";
  setupEl.alternatives.style.display = "none";
  setupEl.progress.style.display = "none";
  setupEl.errorBox.style.display = "none";
  try {
    const res = await fetch("/api/setup/recommendation");
    const data = await res.json();
    setupCandidates = data.candidates;
    setupRecommended = data.candidates.find((c) => c.recommended) ?? null;
    setupSelectedModelId = setupRecommended?.id ?? null;
    const d = data.detected;
    const hwLine = d.gpuAvailable
      ? `Detected: NVIDIA GPU, ${d.vramGb} GB VRAM`
      : "Detected: no NVIDIA GPU — running on CPU (slower)";
    setupEl.detected.textContent = hwLine;
    setupEl.subtitle.textContent = "Pick a model to install.";
    if (setupRecommended) {
      setupEl.recName.textContent = setupRecommended.displayName;
      setupEl.recMeta.textContent = `${fmtGb(setupRecommended.downloadSizeBytes)} download · ${setupRecommended.minVramGb === 0 ? "CPU-viable" : setupRecommended.minVramGb + " GB VRAM min"}${setupRecommended.huginnValidated ? "" : " · untested with Huginn"}`;
      setupEl.recNotes.textContent = setupRecommended.notes;
      setupEl.recommended.style.display = "block";
    }
    renderSetupAlternatives();
  } catch (e) {
    setupEl.errorBox.style.display = "block";
    setupEl.errorBox.textContent = "Could not load recommendation: " + e.message;
  }
}

function renderSetupAlternatives() {
  setupEl.alternatives.innerHTML = "";
  const others = setupCandidates.filter((c) => c.id !== setupRecommended?.id);
  for (const c of others) {
    const row = document.createElement("div");
    row.style.cssText = "padding:.6rem 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.75rem;";
    const fitBadge = c.fits ? "" : ' <span style="color:var(--warning);font-size:.7rem;">needs more VRAM</span>';
    const validatedBadge = c.huginnValidated ? "" : ' <span style="color:var(--text-muted);font-size:.7rem;">untested</span>';
    row.innerHTML = `
      <div style="flex:1;">
        <div style="font-weight:500;">${c.displayName}${fitBadge}${validatedBadge}</div>
        <div class="field-hint">${fmtGb(c.downloadSizeBytes)} · ${c.minVramGb === 0 ? "CPU-viable" : c.minVramGb + " GB VRAM min"}</div>
      </div>
      <button class="btn-secondary" data-model-id="${c.id}" ${c.fits ? "" : "disabled"}>Install</button>
    `;
    row.querySelector("button").addEventListener("click", (e) => {
      const id = e.currentTarget.getAttribute("data-model-id");
      startSetupInstall(id);
    });
    setupEl.alternatives.appendChild(row);
  }
}

setupEl.btnToggleAlt?.addEventListener("click", () => {
  const showing = setupEl.alternatives.style.display === "block";
  setupEl.alternatives.style.display = showing ? "none" : "block";
  setupEl.btnToggleAlt.textContent = showing ? "Show alternatives" : "Hide alternatives";
});

setupEl.btnInstall?.addEventListener("click", () => {
  if (setupSelectedModelId) startSetupInstall(setupSelectedModelId);
});

setupEl.btnCancel?.addEventListener("click", async () => {
  try { await fetch("/api/setup/cancel", { method: "POST" }); } catch {}
});

async function startSetupInstall(modelId) {
  setupSelectedModelId = modelId;
  setupEl.errorBox.style.display = "none";
  setupEl.recommended.style.display = "none";
  setupEl.alternatives.style.display = "none";
  setupEl.progress.style.display = "block";
  const entry = setupCandidates.find((c) => c.id === modelId);
  setupEl.progressLabel.textContent = `Downloading ${entry?.displayName ?? modelId}...`;
  setupEl.progressBytes.textContent = `0 / ${fmtGb(entry?.downloadSizeBytes ?? 0)}`;
  setupEl.progressFill.style.width = "0%";
  try {
    const res = await fetch("/api/setup/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "request failed" }));
      throw new Error(err.error || "install failed");
    }
  } catch (e) {
    setupEl.errorBox.style.display = "block";
    setupEl.errorBox.textContent = "Install failed: " + e.message;
    setupEl.progress.style.display = "none";
    setupEl.recommended.style.display = "block";
  }
}

function handleSetupSseEvent(ev) {
  if (ev.type === "model_install_progress") {
    const pct = ev.totalBytes > 0 ? (ev.completedBytes / ev.totalBytes) * 100 : 0;
    setupEl.progressFill.style.width = pct.toFixed(0) + "%";
    setupEl.progressBytes.textContent = `${fmtBytes(ev.completedBytes)} / ${fmtBytes(ev.totalBytes)}`;
  } else if (ev.type === "model_install_status") {
    setupEl.progressLabel.textContent = ev.status;
  } else if (ev.type === "model_install_complete") {
    setupEl.progress.style.display = "none";
    // Transition to the main scan screen — show the existing default screen.
    setupEl.screen.style.display = "none";
    const firstScreen = document.querySelector(".screen:not(#screen-setup):not(#screen-progress):not(#screen-complete)");
    if (firstScreen) firstScreen.style.display = "block";
  } else if (ev.type === "model_install_error") {
    setupEl.errorBox.style.display = "block";
    setupEl.errorBox.textContent = "Install error: " + ev.message;
    setupEl.progress.style.display = "none";
    setupEl.recommended.style.display = "block";
  }
}

// On page load, check setup status and either show the wizard or proceed.
async function bootstrapSetup() {
  try {
    const res = await fetch("/api/setup/status");
    const data = await res.json();
    if (data.state === "needsSetup") {
      showSetupScreen();
      return false;
    }
    return true;
  } catch {
    return true; // fail open — let the user attempt to scan; backend will refuse if not ready
  }
}
```

- [ ] **Step 3: Wire `bootstrapSetup` into existing page initialization**

Locate the existing page-init code in the `<script>` block (the part that runs on DOMContentLoaded or at the bottom of the script). Wrap the existing initialization so it only runs if setup is complete. At the bottom of the `<script>`, add:

```js
(async () => {
  const ready = await bootstrapSetup();
  if (!ready) return; // wizard is showing; existing init is gated behind it
})();
```

If the existing UI's first screen is shown by default at page load (look for the markup that sets `display:block` on `#screen-config` or similar), modify that initial state so the first screen starts hidden (`style="display:none;"`) — `bootstrapSetup()` will reveal the right screen.

- [ ] **Step 4: Add SSE handling for setup events to the existing SSE handler**

Locate the existing EventSource handler in `<script>` (the one that handles `scan_complete`, `phase_start`, etc.). Add this branch near the top of its message handler:

```js
if (data.type && data.type.startsWith("model_install_")) {
  handleSetupSseEvent(data);
  return;
}
```

- [ ] **Step 5: Manually smoke-test the wizard markup compiles and is reachable**

```bash
bun run src/index.ts
```

(Requires Ollama running; if not running, the server aborts — set up Ollama or skip this step until Task 13.)

- [ ] **Step 6: Commit**

```bash
git add src/ui/index.html
git commit -m "feat: add first-boot setup wizard UI"
```

---

## Task 11: UI — Settings → Model Panel

**Files:**
- Modify: `src/ui/index.html`

- [ ] **Step 1: Add a Settings link in the topbar**

In `src/ui/index.html`, locate `.topbar-status` (around line 30 in the original CSS — find the actual usage in the body). Add a button before it:

```html
<button class="btn-secondary" id="btn-open-settings" style="margin-left:auto;">Settings</button>
```

If `.topbar-status` already has `margin-left:auto;`, remove that from the Settings button and place it just before `.topbar-status`.

- [ ] **Step 2: Add a `screen-settings` div with the model panel**

Just below the `screen-setup` div added in Task 10, insert:

```html
<div class="screen" id="screen-settings" style="display:none;">
  <div class="page" style="max-width:780px;">
    <div class="page-header" style="display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div class="page-title">Settings — Model</div>
        <div class="page-subtitle" id="settings-subtitle">—</div>
      </div>
      <button class="btn-secondary" id="btn-close-settings">Back</button>
    </div>

    <div class="card">
      <div class="card-title">Currently active</div>
      <div id="settings-current" class="field-hint">—</div>
    </div>

    <div class="card">
      <div class="card-title">Detected hardware</div>
      <div id="settings-detected" class="field-hint">—</div>
    </div>

    <div class="card">
      <div class="card-title">Available models</div>
      <div id="settings-list"></div>

      <div id="settings-progress" style="display:none;margin-top:1rem;">
        <div class="progress-label">
          <span id="settings-progress-label">Downloading...</span>
          <span id="settings-progress-bytes">0 / 0</span>
        </div>
        <div class="progress-track"><div class="progress-fill" id="settings-progress-fill"></div></div>
      </div>

      <div class="alert alert-error" id="settings-error" style="display:none;"></div>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add the settings JS to the existing `<script>` block**

Append to the top JS section:

```js
// ---- Settings page ----
const settingsEl = {
  screen: document.getElementById("screen-settings"),
  current: document.getElementById("settings-current"),
  detected: document.getElementById("settings-detected"),
  list: document.getElementById("settings-list"),
  progress: document.getElementById("settings-progress"),
  progressLabel: document.getElementById("settings-progress-label"),
  progressBytes: document.getElementById("settings-progress-bytes"),
  progressFill: document.getElementById("settings-progress-fill"),
  errorBox: document.getElementById("settings-error"),
};

let settingsCurrentModel = null;
let settingsLastScreenId = null;

async function openSettings() {
  settingsLastScreenId = null;
  document.querySelectorAll(".screen").forEach((s) => {
    if (s.style.display !== "none") settingsLastScreenId = s.id;
    s.style.display = "none";
  });
  settingsEl.screen.style.display = "block";
  settingsEl.errorBox.style.display = "none";
  settingsEl.progress.style.display = "none";
  try {
    const [statusRes, recRes] = await Promise.all([
      fetch("/api/setup/status").then((r) => r.json()),
      fetch("/api/setup/recommendation").then((r) => r.json()),
    ]);
    settingsCurrentModel = statusRes.installedChatModel;
    settingsEl.current.textContent = settingsCurrentModel
      ? `${settingsCurrentModel} (installed)`
      : "No model installed";
    const d = recRes.detected;
    settingsEl.detected.textContent = d.gpuAvailable
      ? `NVIDIA GPU, ${d.vramGb} GB VRAM`
      : "No NVIDIA GPU detected — CPU mode";
    settingsEl.list.innerHTML = "";
    for (const c of recRes.candidates) {
      const row = document.createElement("div");
      row.style.cssText = "padding:.6rem 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.75rem;";
      const isActive = c.id === settingsCurrentModel;
      const fitBadge = c.fits ? "" : ' <span style="color:var(--warning);font-size:.7rem;">needs more VRAM</span>';
      const validatedBadge = c.huginnValidated ? "" : ' <span style="color:var(--text-muted);font-size:.7rem;">untested</span>';
      const activeBadge = isActive ? ' <span style="color:var(--success);font-size:.7rem;">active</span>' : "";
      row.innerHTML = `
        <div style="flex:1;">
          <div style="font-weight:500;">${c.displayName}${activeBadge}${fitBadge}${validatedBadge}</div>
          <div class="field-hint">${fmtGb(c.downloadSizeBytes)} · ${c.minVramGb === 0 ? "CPU-viable" : c.minVramGb + " GB VRAM min"}</div>
        </div>
        <button class="btn-secondary" data-model-id="${c.id}" ${isActive || !c.fits ? "disabled" : ""}>${isActive ? "Active" : "Install"}</button>
      `;
      const btn = row.querySelector("button");
      if (!isActive && c.fits) {
        btn.addEventListener("click", (e) => {
          const id = e.currentTarget.getAttribute("data-model-id");
          startSettingsInstall(id);
        });
      }
      settingsEl.list.appendChild(row);
    }
  } catch (e) {
    settingsEl.errorBox.style.display = "block";
    settingsEl.errorBox.textContent = "Could not load settings: " + e.message;
  }
}

function closeSettings() {
  settingsEl.screen.style.display = "none";
  if (settingsLastScreenId) {
    const last = document.getElementById(settingsLastScreenId);
    if (last) last.style.display = "block";
  }
}

document.getElementById("btn-open-settings")?.addEventListener("click", openSettings);
document.getElementById("btn-close-settings")?.addEventListener("click", closeSettings);

async function startSettingsInstall(modelId) {
  settingsEl.errorBox.style.display = "none";
  settingsEl.progress.style.display = "block";
  settingsEl.progressLabel.textContent = `Downloading ${modelId}...`;
  settingsEl.progressBytes.textContent = "0 / 0";
  settingsEl.progressFill.style.width = "0%";
  try {
    const res = await fetch("/api/setup/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "request failed" }));
      throw new Error(err.error || "install failed");
    }
  } catch (e) {
    settingsEl.errorBox.style.display = "block";
    settingsEl.errorBox.textContent = "Install failed: " + e.message;
    settingsEl.progress.style.display = "none";
  }
}

function handleSettingsSseEvent(ev) {
  if (settingsEl.screen.style.display === "none") return;
  if (ev.type === "model_install_progress") {
    const pct = ev.totalBytes > 0 ? (ev.completedBytes / ev.totalBytes) * 100 : 0;
    settingsEl.progressFill.style.width = pct.toFixed(0) + "%";
    settingsEl.progressBytes.textContent = `${fmtBytes(ev.completedBytes)} / ${fmtBytes(ev.totalBytes)}`;
  } else if (ev.type === "model_install_status") {
    settingsEl.progressLabel.textContent = ev.status;
  } else if (ev.type === "model_install_complete") {
    settingsEl.progress.style.display = "none";
    openSettings(); // refresh
  } else if (ev.type === "model_install_error") {
    settingsEl.errorBox.style.display = "block";
    settingsEl.errorBox.textContent = "Install error: " + ev.message;
    settingsEl.progress.style.display = "none";
  }
}
```

- [ ] **Step 4: Route SSE events to settings handler too**

In the existing SSE message handler, change the model-install dispatch branch added in Task 10 to also notify settings:

```js
if (data.type && data.type.startsWith("model_install_")) {
  handleSetupSseEvent(data);
  handleSettingsSseEvent(data);
  return;
}
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/index.html
git commit -m "feat: add Settings model panel for swapping models"
```

---

## Task 12: Compose & Dockerfile Changes

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.gpu.yml`
- Modify: `Dockerfile.scanner`

- [ ] **Step 1: Remove the `ollama-init` service from `docker-compose.yml`**

In `docker-compose.yml`, delete the entire `ollama-init` service block (lines starting with `ollama-init:` through its `restart: "no"` line, inclusive). Also remove `ollama-init` from the `scanner.depends_on` block — replace:

```yaml
    depends_on:
      tika:
        condition: service_started
      ollama-init:
        condition: service_completed_successfully
```

with:

```yaml
    depends_on:
      tika:
        condition: service_started
      ollama:
        condition: service_healthy
```

- [ ] **Step 2: Add GPU device visibility for the scanner in `docker-compose.gpu.yml`**

Replace the entire contents of `docker-compose.gpu.yml` with:

```yaml
# GPU override — apply on NVIDIA machines:
#   docker compose -f docker-compose.yml -f docker-compose.gpu.yml up
services:
  ollama:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
  scanner:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

This gives the scanner container `nvidia-smi` access (provided by NVIDIA Container Toolkit). The scanner does not perform GPU compute — it only reads VRAM totals.

- [ ] **Step 3: Create `/app/state` in `Dockerfile.scanner`**

Replace `Dockerfile.scanner` with:

```dockerfile
FROM oven/bun:1.3
WORKDIR /app
RUN mkdir -p /app/state
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY src/ ./src/
CMD ["bun", "run", "src/index.ts"]
```

- [ ] **Step 4: Validate compose syntax**

```bash
docker compose -f docker-compose.yml config > /dev/null
docker compose -f docker-compose.yml -f docker-compose.gpu.yml config > /dev/null
```

Expected: both commands exit 0 with no errors.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.gpu.yml Dockerfile.scanner
git commit -m "feat: remove ollama-init and add scanner GPU access for nvidia-smi"
```

---

## Task 13: Run Full Test Suite and Smoke Test

**Files:** (no edits)

- [ ] **Step 1: Run all unit tests**

```bash
bun test
```

Expected: all tests pass — at minimum the four new test files (`model-catalog.test.ts`, `model-fit.test.ts`, `model-installer.test.ts`, `setup-state.test.ts`) plus the existing `folder-browser.test.ts` and `sse.test.ts`.

- [ ] **Step 2: Typecheck the whole project**

```bash
bun run typecheck
```

Expected: zero errors.

- [ ] **Step 3: Smoke test 1 — fresh install on local machine (no Docker)**

If you have Ollama running locally and no catalog model installed:

```bash
# Stop Ollama if running, wipe its model store (DESTRUCTIVE — only do this on a dev machine), restart.
# Then:
DOCUMENTS_ROOT=./_test-docs REPORT_OUTPUT=./reports OLLAMA_URL=http://localhost:11434 TIKA_URL=http://localhost:9998 bun run src/index.ts
```

Open `http://localhost:3000` in a browser. Expected:
- Setup wizard appears
- "Detected: NVIDIA GPU, N GB VRAM" or "Detected: no NVIDIA GPU"
- A recommended model is shown
- Clicking "Install and continue" shows the progress bar and updates
- After completion, the main scan screen appears

- [ ] **Step 4: Smoke test 2 — auto-recovery**

While the scanner is still running, hit Ctrl+C and restart:

```bash
DOCUMENTS_ROOT=./_test-docs REPORT_OUTPUT=./reports OLLAMA_URL=http://localhost:11434 TIKA_URL=http://localhost:9998 bun run src/index.ts
```

The wizard should NOT appear — auto-recovery picks the model from Ollama's `/api/tags` and re-saves `setup.json`.

- [ ] **Step 5: Smoke test 3 — settings model swap**

In the running UI, click "Settings". Select a different catalog model. Click "Install". Verify the progress bar fills, then the active model badge moves to the new model.

- [ ] **Step 6: Smoke test 4 — Docker compose CPU host**

```bash
DOCUMENTS_PATH=./_test-docs docker compose up
```

Open `http://localhost:3000`. Expected: wizard appears, probe reports CPU mode, recommendation is a CPU-viable model (`phi3:mini` or smaller).

- [ ] **Step 7: Smoke test 5 — Docker compose GPU host (if available)**

```bash
DOCUMENTS_PATH=./_test-docs docker compose -f docker-compose.yml -f docker-compose.gpu.yml up
```

Expected: wizard appears, probe reports correct VRAM (matches `nvidia-smi` output on the host), recommendation matches the VRAM tier.

- [ ] **Step 8: Smoke test 6 — content-leak guard still works**

Run a full pipeline scan (after model install completes). Verify the generated JSON report contains no strings longer than 120 chars (existing Phase 8 guard).

```bash
ls -1 reports/*.json | head -1 | xargs -I {} python3 -c "
import json, sys
with open('{}') as f: data = json.load(f)
def walk(o, path=''):
  if isinstance(o, str) and len(o) > 120:
    print('LEAK at', path, ':', len(o), 'chars'); sys.exit(1)
  if isinstance(o, dict):
    for k,v in o.items(): walk(v, path + '.' + k)
  if isinstance(o, list):
    for i,v in enumerate(o): walk(v, path + '[' + str(i) + ']')
walk(data)
print('OK — no leaks')
"
```

Expected: prints `OK — no leaks`.

- [ ] **Step 9: Commit any docs-only fixups**

If smoke tests revealed any minor issues that you fixed, commit them now. Otherwise skip.

---

## Task 14: Documentation Update

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update `CLAUDE.md` to reflect the new flow**

In `CLAUDE.md`, find the "External services (Docker)" section and replace this line:

```
- `ollama-init` pulls models before the scanner starts (idempotent)
```

with:

```
- Models are pulled on-demand via the in-UI setup wizard (no ollama-init service)
```

In the "Key constraints" section, find the line about Ollama being a hard gate and add a sentence:

> Add: "On first boot, no chat model is pre-installed; the UI's setup wizard handles model selection and download."

- [ ] **Step 2: Update `README.md`**

In `README.md`, find any "Quick start" or "Setup" section. Replace any reference to `ollama-init` or pre-pulled models with:

```
On first boot, open http://localhost:3000 — Huginn's setup wizard will detect your hardware, recommend a chat model from a curated catalog, and download it on demand. You can swap models later from the Settings page.
```

If the README references the `docker-compose.gpu.yml` override, no change needed — that flow is unchanged.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update for in-UI model setup wizard"
```

---

## Plan Self-Review Notes

- **Spec coverage:** Every spec section maps to at least one task:
  - §3 Deployment Model → Task 12 (compose + Dockerfile)
  - §4 Architecture / process states → Task 7 (server bootstrap)
  - §4.4 Data shapes → Tasks 1, 2, 3, 4 (catalog, fit, setup-state, installer)
  - §4.5 HTTP/SSE → Tasks 5 (sse types), 8 (routes)
  - §5 Hardware Probe → Task 2 (nvidia-smi parsing + probe)
  - §6 Catalog → Task 1
  - §7 Fit Ranking → Task 2
  - §8 UI Surfaces → Tasks 10 (wizard), 11 (settings)
  - §9 Error Paths → covered across tasks; scan refusal in Task 9; UI error handling in Tasks 10/11
  - §10 Testing → Tasks 1–4 unit tests; Task 13 manual smoke suite
  - §11 Constraints → enforced via `clamp()` in Task 2 and Task 4
  - §12 Open Questions → deferred, documented in spec
- **Placeholder scan:** No "TBD", "TODO", or "implement later" lines remain.
- **Type consistency:** `CatalogEntry`, `DetectedHardware`, `RankedEntry`, `SetupState`, `PullEvent`, and SSE event names are used consistently across all tasks.
