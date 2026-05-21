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
    expect(result.vramGb).toBe(8);
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
    expect(rec!.id).toBe("qwen2.5:14b");
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
    const detected: DetectedHardware = { gpuAvailable: true, vramGb: 4, detectionMethod: "nvidia-smi", rawProbeOutput: "" };
    const ranked = rankCatalog(CATALOG, detected);
    const nonFitting = ranked.filter((r) => !r.fits);
    expect(nonFitting.length).toBeGreaterThanOrEqual(1);
    expect(nonFitting[0]!.id).toBe("qwen2.5:7b");
  });
});
