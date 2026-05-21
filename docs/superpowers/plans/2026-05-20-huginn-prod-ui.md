# Huginn Production UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Bun HTTP server + vanilla JS single-page UI to Huginn so clients can point a browser at `http://localhost:3000`, select a folder, watch the pipeline run live, and download reports when done — all from a single `docker compose up` command.

**Architecture:** The scanner process switches from run-once to server mode. `src/index.ts` imports `src/server/index.ts`, which starts `Bun.serve()` on port 3000 and waits for scan requests via a REST API. The pipeline is extracted into `src/pipeline.ts` and called on demand. Progress is pushed to the browser via Server-Sent Events.

**Tech Stack:** Bun runtime (native `Bun.serve()`), TypeScript, vanilla JS (no framework, no build step), SSE for progress streaming. Tests use `bun:test`.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/pipeline.ts` | Callable pipeline runner; extracted from old `src/index.ts` |
| Create | `src/server/health-state.ts` | Shared mutable health status (Tika + Ollama) |
| Create | `src/server/sse.ts` | SSE broadcaster + `SseEvent` type definitions |
| Create | `src/server/sse.test.ts` | Unit tests for SSE broadcaster |
| Create | `src/server/folder-browser.ts` | `/api/browse` logic — directory tree with file counts |
| Create | `src/server/folder-browser.test.ts` | Unit tests for folder browser |
| Create | `src/server/routes.ts` | All route handlers + scan state machine |
| Create | `src/server/index.ts` | `Bun.serve()` entry, startup health checks |
| Create | `src/ui/index.html` | Single-page app: setup, progress, complete, error screens |
| Modify | `src/config.ts` | Add `serverPort` |
| Modify | `src/utils/logger.ts` | Add `setProgressCallback` hook |
| Modify | `src/index.ts` | Replace `main()` with `import './server/index.ts'` |
| Modify | `docker-compose.yml` | Add `ports: ["3000:3000"]`, `restart: unless-stopped` |

---

## Task 1: Add `serverPort` to config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add the config key**

Open `src/config.ts`. After the existing `reportOutput` line, add:

```typescript
export const CONFIG = {
  documentsRoot: process.env["DOCUMENTS_ROOT"] || "/documents",
  reportOutput: process.env["REPORT_OUTPUT"] || "/reports",
  serverPort: parseInt(process.env["HUGINN_SERVER_PORT"] || "3000", 10),  // ← add this line
  // ... rest unchanged
```

- [ ] **Step 2: Verify typecheck still passes**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add serverPort to config"
```

---

## Task 2: SSE broadcaster

**Files:**
- Create: `src/server/sse.ts`
- Create: `src/server/sse.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/sse.test.ts`:

```typescript
import { expect, test, describe } from "bun:test";
import { SseBroadcaster, encodeSseEvent } from "./sse.ts";

describe("encodeSseEvent", () => {
  test("formats a phase_start event as SSE text", () => {
    const result = encodeSseEvent({ type: "phase_start", phase: "1-harvest", phaseIndex: 0, totalPhases: 9 });
    expect(result).toBe('data: {"type":"phase_start","phase":"1-harvest","phaseIndex":0,"totalPhases":9}\n\n');
  });

  test("formats a log event as SSE text", () => {
    const result = encodeSseEvent({ type: "log", level: "WARN", phase: "2-parse", message: "Tika timeout" });
    expect(result).toBe('data: {"type":"log","level":"WARN","phase":"2-parse","message":"Tika timeout"}\n\n');
  });
});

describe("SseBroadcaster", () => {
  test("tracks added controllers", () => {
    const b = new SseBroadcaster();
    const ctrl = new AbortController();
    // ReadableStream controller mock — just needs enqueue/close
    const chunks: string[] = [];
    const fakeCtrl = { enqueue: (c: string) => chunks.push(c), close: () => {} };
    b.add("c1", fakeCtrl as unknown as ReadableStreamDefaultController<string>);
    expect(b.size).toBe(1);
    b.remove("c1");
    expect(b.size).toBe(0);
  });

  test("emit encodes and sends to all controllers", () => {
    const b = new SseBroadcaster();
    const received: string[] = [];
    const fakeCtrl = { enqueue: (c: string) => received.push(c), close: () => {} };
    b.add("c1", fakeCtrl as unknown as ReadableStreamDefaultController<string>);
    b.emit({ type: "phase_end", phase: "1-harvest", durationMs: 3000 });
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('"phase_end"');
    expect(received[0]).toContain('"durationMs":3000');
  });

  test("remove is idempotent", () => {
    const b = new SseBroadcaster();
    b.remove("nonexistent"); // must not throw
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/server/sse.test.ts
```

Expected: errors — `sse.ts` does not exist yet.

- [ ] **Step 3: Create `src/server/sse.ts`**

```typescript
// src/server/sse.ts

export type SseEvent =
  | { type: "phase_start"; phase: string; phaseIndex: number; totalPhases: number }
  | { type: "phase_end"; phase: string; durationMs: number }
  | { type: "log"; level: "INFO" | "WARN" | "ERROR"; phase: string; message: string }
  | { type: "scan_complete"; scanId: string; reports: string[] }
  | { type: "scan_error"; phase: string; message: string };

export function encodeSseEvent(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export class SseBroadcaster {
  private clients = new Map<string, ReadableStreamDefaultController<string>>();

  get size(): number {
    return this.clients.size;
  }

  add(id: string, controller: ReadableStreamDefaultController<string>): void {
    this.clients.set(id, controller);
  }

  remove(id: string): void {
    this.clients.delete(id);
  }

  emit(event: SseEvent): void {
    const encoded = encodeSseEvent(event);
    for (const [id, ctrl] of this.clients) {
      try {
        ctrl.enqueue(encoded);
      } catch {
        // Client disconnected — clean up
        this.clients.delete(id);
      }
    }
  }

  closeAll(): void {
    for (const [, ctrl] of this.clients) {
      try { ctrl.close(); } catch { /* already closed */ }
    }
    this.clients.clear();
  }
}

export const broadcaster = new SseBroadcaster();
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/server/sse.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/sse.ts src/server/sse.test.ts
git commit -m "feat: add SSE broadcaster"
```

---

## Task 3: Extend logger with progress callback

**Files:**
- Modify: `src/utils/logger.ts`

The logger's `phaseStart`, `phaseEnd`, and `log` (WARN/ERROR) methods will call an optional callback so the server can forward events to connected SSE clients without the pipeline phases needing to know about SSE.

- [ ] **Step 1: Add the callback slot to `src/utils/logger.ts`**

Add these lines after the `let logFilePath` declaration (around line 7):

```typescript
type ProgressCb = (event: Record<string, unknown>) => void;
let _progressCb: ProgressCb | null = null;

export function setProgressCallback(cb: ProgressCb | null): void {
  _progressCb = cb;
}
```

- [ ] **Step 2: Fire callback in `log()` for WARN and ERROR**

Inside the `log()` function, after the `appendFileSync` call, add:

```typescript
  if ((level === "WARN" || level === "ERROR") && _progressCb) {
    _progressCb({ type: "log", level, phase: currentPhase, message: sanitizeMessage(message) });
  }
```

- [ ] **Step 3: Fire callback in `phaseStart`**

Replace the existing `phaseStart` method:

```typescript
  phaseStart: (phase: string) => {
    setPhase(phase);
    log("INFO", `Phase started: ${phase}`);
    if (_progressCb) _progressCb({ type: "phase_start", phase });
    return Date.now();
  },
```

- [ ] **Step 4: Fire callback in `phaseEnd`**

Replace the existing `phaseEnd` method:

```typescript
  phaseEnd: (phase: string, startTime: number, extra?: unknown) => {
    const durationMs = Date.now() - startTime;
    log("INFO", `Phase completed: ${phase}`, { durationMs, ...((extra as object) ?? {}) });
    if (_progressCb) _progressCb({ type: "phase_end", phase, durationMs });
  },
```

- [ ] **Step 5: Verify typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Verify existing tests still pass**

```bash
bun test
```

Expected: all existing tests pass (the callback defaults to `null`, existing behaviour unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/utils/logger.ts
git commit -m "feat: add progress callback hook to logger"
```

---

## Task 4: Folder browser

**Files:**
- Create: `src/server/folder-browser.ts`
- Create: `src/server/folder-browser.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/server/folder-browser.test.ts`:

```typescript
import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { browseFolder, FolderBrowseError } from "./folder-browser.ts";

const TMP = "/tmp/huginn-browse-test";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, "documents", "project-alpha", "rfq"), { recursive: true });
  mkdirSync(join(TMP, "documents", "project-alpha", "quotations"), { recursive: true });
  mkdirSync(join(TMP, "documents", "project-beta"), { recursive: true });
  // Add some supported files
  writeFileSync(join(TMP, "documents", "project-alpha", "rfq", "spec.docx"), "");
  writeFileSync(join(TMP, "documents", "project-alpha", "rfq", "drawing.pdf"), "");
  writeFileSync(join(TMP, "documents", "project-alpha", "quotations", "offer.docx"), "");
  writeFileSync(join(TMP, "documents", "note.txt"), ""); // unsupported — not counted
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const ROOT = join(TMP, "documents");

describe("browseFolder", () => {
  test("lists immediate subdirectories with file counts", async () => {
    const result = await browseFolder(ROOT, ROOT);
    expect(result.path).toBe(ROOT);
    const names = result.entries.map(e => e.name).sort();
    expect(names).toEqual(["project-alpha", "project-beta"]);
    const alpha = result.entries.find(e => e.name === "project-alpha")!;
    expect(alpha.type).toBe("dir");
    // project-alpha has 3 supported files total (rfq/spec.docx, rfq/drawing.pdf, quotations/offer.docx)
    expect(alpha.fileCount).toBe(3);
  });

  test("counts only supported extensions (.docx .xlsx .pptx .pdf)", async () => {
    const result = await browseFolder(ROOT, ROOT);
    const beta = result.entries.find(e => e.name === "project-beta")!;
    expect(beta.fileCount).toBe(0); // no supported files
  });

  test("throws FolderBrowseError(403) for path outside root", async () => {
    await expect(browseFolder(ROOT, "/etc")).rejects.toThrow(FolderBrowseError);
    try {
      await browseFolder(ROOT, "/etc");
    } catch (e) {
      expect((e as FolderBrowseError).status).toBe(403);
    }
  });

  test("throws FolderBrowseError(404) for non-existent path", async () => {
    await expect(browseFolder(ROOT, join(ROOT, "does-not-exist"))).rejects.toThrow(FolderBrowseError);
    try {
      await browseFolder(ROOT, join(ROOT, "does-not-exist"));
    } catch (e) {
      expect((e as FolderBrowseError).status).toBe(404);
    }
  });

  test("resolves symlink-escaped paths as 403", async () => {
    // Path with traversal component
    await expect(browseFolder(ROOT, ROOT + "/../etc")).rejects.toThrow(FolderBrowseError);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/server/folder-browser.test.ts
```

Expected: errors — `folder-browser.ts` does not exist.

- [ ] **Step 3: Create `src/server/folder-browser.ts`**

```typescript
// src/server/folder-browser.ts
import { readdir, stat } from "fs/promises";
import { join, resolve, relative } from "path";
import { CONFIG } from "../config.ts";

const SUPPORTED = new Set([".docx", ".xlsx", ".pptx", ".pdf"]);

export class FolderBrowseError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface FolderEntry {
  name: string;
  type: "dir";
  fileCount: number; // supported files in entire subtree
}

export interface FolderBrowseResult {
  path: string;
  entries: FolderEntry[];
}

async function countSupportedFiles(dirPath: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await countSupportedFiles(join(dirPath, entry.name));
      } else if (SUPPORTED.has("." + entry.name.split(".").pop()!.toLowerCase())) {
        count++;
      }
    }
  } catch { /* unreadable dir — skip */ }
  return count;
}

export async function browseFolder(root: string, requestedPath: string): Promise<FolderBrowseResult> {
  const safeRoot = resolve(root);
  const safePath = resolve(requestedPath);

  // Path traversal guard
  if (!safePath.startsWith(safeRoot)) {
    throw new FolderBrowseError(403, `Path '${requestedPath}' is outside the documents root`);
  }

  // Existence check
  try {
    const s = await stat(safePath);
    if (!s.isDirectory()) throw new FolderBrowseError(404, `'${requestedPath}' is not a directory`);
  } catch (e) {
    if (e instanceof FolderBrowseError) throw e;
    throw new FolderBrowseError(404, `Path '${requestedPath}' not found`);
  }

  const rawEntries = await readdir(safePath, { withFileTypes: true });
  const dirs = rawEntries.filter(e => e.isDirectory());

  const entries: FolderEntry[] = await Promise.all(
    dirs.map(async (d) => ({
      name: d.name,
      type: "dir" as const,
      fileCount: await countSupportedFiles(join(safePath, d.name)),
    }))
  );

  return { path: safePath, entries };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/server/folder-browser.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/folder-browser.ts src/server/folder-browser.test.ts
git commit -m "feat: add folder browser for /api/browse"
```

---

## Task 5: Shared health state

**Files:**
- Create: `src/server/health-state.ts`

This tiny module holds the mutable health status so both `server/index.ts` (which sets it) and `server/routes.ts` (which reads it) can share it without circular imports.

- [ ] **Step 1: Create `src/server/health-state.ts`**

```typescript
// src/server/health-state.ts
export const healthState = {
  tikaOk: false,
  ollamaOk: false,
  modelsAvailable: [] as string[],
};
```

- [ ] **Step 2: Commit**

```bash
git add src/server/health-state.ts
git commit -m "feat: add shared health state module"
```

---

## Task 6: Extract pipeline runner

**Files:**
- Create: `src/pipeline.ts`
- Modify: `src/index.ts` (temporarily — will be replaced in Task 9)

The goal is to extract the phase execution loop from `src/index.ts` into a callable function. The existing `main()` should still work in run-once mode during this task (tested by running it).

- [ ] **Step 1: Create `src/pipeline.ts`**

```typescript
// src/pipeline.ts
import { createInitialState } from "./state.ts";
import { CONFIG } from "./config.ts";
import { logger, setProgressCallback } from "./utils/logger.ts";
import { stat } from "fs/promises";
import { runRegexTests } from "./utils/regex-patterns.ts";
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
import { join } from "path";
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

// Phase execution order (phase 9 runs after parse, before fingerprint)
const PHASE_EXECUTION_ORDER = [
  "1-harvest", "2-parse", "9-projection",
  "3-fingerprint", "4-cluster", "5-references",
  "6-requirements", "7-validate", "8-report",
];

export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const { folder, settings, onProgress } = config;

  // Override CONFIG values from settings for this run
  process.env["DOCUMENTS_ROOT"] = folder;
  process.env["OLLAMA_EMBED_MODEL"] = settings.embedModel;
  process.env["OLLAMA_CHAT_MODEL"] = settings.chatModel;
  process.env["LLM_SAMPLE_RATE"] = String(settings.llmSampleRate);
  process.env["SECTION_EMBEDDINGS"] = settings.sectionEmbeddings ? "1" : "0";

  // Wire progress callback into logger
  if (onProgress) {
    setProgressCallback((raw) => onProgress(raw as SseEvent));
  }

  const scanId = `scan-${Date.now()}-${randomUUID().slice(0, 8)}`;
  logger.info("=== Huginn pipeline start ===", { scanId, folder });

  // Validate folder
  const rootStat = await stat(folder);
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${folder}`);

  // Health checks
  const tikaOk = await checkTikaHealth();
  const { ok: ollamaOk } = await checkOllamaHealth();

  const state = createInitialState(scanId, folder);

  const phases = [
    { name: "1-harvest",     fn: () => runHarvest(state),                  idx: 0 },
    { name: "2-parse",       fn: () => runParse(state),                    idx: 1 },
    { name: "9-projection",  fn: () => runProjection(state),               idx: 2 },
    { name: "3-fingerprint", fn: () => runFingerprint(state, ollamaOk),    idx: 3 },
    { name: "4-cluster",     fn: () => runCluster(state),                  idx: 4 },
    { name: "5-references",  fn: () => runReferences(state, ollamaOk),     idx: 5 },
    { name: "6-requirements",fn: () => runRequirements(state, ollamaOk),   idx: 6 },
    { name: "7-validate",    fn: () => runValidate(state),                  idx: 7 },
    { name: "8-report",      fn: () => runReport(state, ollamaOk),          idx: 8 },
  ];

  for (const phase of phases) {
    onProgress?.({ type: "phase_start", phase: phase.name, phaseIndex: phase.idx, totalPhases: 9 });
    try {
      await phase.fn();
    } catch (e) {
      onProgress?.({ type: "scan_error", phase: phase.name, message: String(e).slice(0, 200) });
      try { await runReport(state); } catch { /* best-effort partial report */ }
      throw e;
    }
  }

  // Collect report files written to CONFIG.reportOutput
  const reportDir = process.env["REPORT_OUTPUT"] || "/reports";
  let reportFiles: string[] = [];
  try {
    reportFiles = readdirSync(reportDir)
      .filter(f => f.includes(scanId.slice(5, 19).replace(/-/g, "")) || f.startsWith("scan-report"))
      .slice(-4); // last few files
  } catch { /* reports dir not readable — not fatal */ }

  onProgress?.({ type: "scan_complete", scanId, reports: reportFiles });

  // Clear progress callback
  setProgressCallback(null);

  logger.info("=== Huginn pipeline complete ===", { scanId });
  return { scanId, reportFiles };
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run typecheck
```

Expected: no errors. If `setProgressCallback` import fails, confirm Task 3 (logger modification) is done.

- [ ] **Step 3: Commit**

```bash
git add src/pipeline.ts
git commit -m "feat: extract pipeline runner into callable function"
```

---

## Task 7: Route handlers

**Files:**
- Create: `src/server/routes.ts`

- [ ] **Step 1: Create `src/server/routes.ts`**

```typescript
// src/server/routes.ts
import { join, resolve } from "path";
import { readdirSync, createReadStream, statSync } from "fs";
import { randomUUID } from "crypto";
import { CONFIG } from "../config.ts";
import { broadcaster } from "./sse.ts";
import type { SseEvent } from "./sse.ts";
import { browseFolder, FolderBrowseError } from "./folder-browser.ts";
import { healthState } from "./health-state.ts";
import { runPipeline } from "../pipeline.ts";
import type { ScanSettings } from "../pipeline.ts";

// ── Scan state ────────────────────────────────────────────────────────────────
type ScanState =
  | { status: "idle" }
  | { status: "running"; scanId: string; startedAt: Date; folder: string }
  | { status: "complete"; scanId: string; reportFiles: string[] }
  | { status: "error"; scanId: string; phase: string; message: string };

let scanState: ScanState = { status: "idle" };

// ── CORS headers ──────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── Route: GET /api/health ────────────────────────────────────────────────────
function handleHealth(): Response {
  return json({
    tikaOk: healthState.tikaOk,
    ollamaOk: healthState.ollamaOk,
    modelsAvailable: healthState.modelsAvailable,
    scanStatus: scanState.status,
  });
}

// ── Route: GET /api/browse?path=... ──────────────────────────────────────────
async function handleBrowse(url: URL): Promise<Response> {
  const requestedPath = url.searchParams.get("path") || CONFIG.documentsRoot;
  try {
    const result = await browseFolder(CONFIG.documentsRoot, requestedPath);
    return json(result);
  } catch (e) {
    if (e instanceof FolderBrowseError) {
      return json({ error: e.message }, e.status);
    }
    return json({ error: "Browse failed" }, 500);
  }
}

// ── Route: POST /api/scan ─────────────────────────────────────────────────────
async function handleStartScan(req: Request): Promise<Response> {
  if (scanState.status === "running") {
    return json({ error: "scan_already_running", scanId: (scanState as { scanId: string }).scanId }, 409);
  }

  let body: { folder?: string; settings?: Partial<ScanSettings> };
  try {
    body = await req.json() as typeof body;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const folder = body.folder || CONFIG.documentsRoot;
  const settings: ScanSettings = {
    embedModel: body.settings?.embedModel || CONFIG.ollamaEmbedModel,
    chatModel: body.settings?.chatModel || CONFIG.ollamaChatModel,
    llmSampleRate: body.settings?.llmSampleRate ?? CONFIG.llmSampleRate,
    sectionEmbeddings: body.settings?.sectionEmbeddings ?? false,
  };

  // Validate folder exists and is inside documentsRoot
  const safeRoot = resolve(CONFIG.documentsRoot);
  const safeFolder = resolve(folder);
  if (!safeFolder.startsWith(safeRoot) && safeFolder !== safeRoot) {
    return json({ error: "folder_outside_root" }, 400);
  }
  try {
    const { statSync: s } = await import("fs");
    if (!s(safeFolder).isDirectory()) return json({ error: "not_a_directory" }, 400);
  } catch {
    return json({ error: "folder_not_found" }, 400);
  }

  const scanId = `scan-${Date.now()}-${randomUUID().slice(0, 8)}`;
  scanState = { status: "running", scanId, startedAt: new Date(), folder };

  // Run pipeline in background (fire-and-forget — client watches via SSE)
  runPipeline({
    folder: safeFolder,
    settings,
    onProgress: (event: SseEvent) => {
      broadcaster.emit(event);
      if (event.type === "scan_complete") {
        scanState = { status: "complete", scanId: event.scanId, reportFiles: event.reports };
      } else if (event.type === "scan_error") {
        scanState = { status: "error", scanId, phase: event.phase, message: event.message };
      }
    },
  }).catch(() => {
    // onProgress scan_error already emitted — just ensure state reflects error
    if (scanState.status === "running") {
      scanState = { status: "error", scanId, phase: "unknown", message: "Pipeline failed" };
    }
  });

  return json({ scanId }, 202);
}

// ── Route: GET /api/status (SSE) ─────────────────────────────────────────────
function handleStatus(): Response {
  const clientId = randomUUID();

  const stream = new ReadableStream<string>({
    start(controller) {
      broadcaster.add(clientId, controller);

      // Send current state immediately so reconnecting clients catch up
      if (scanState.status === "complete") {
        controller.enqueue(`data: ${JSON.stringify({ type: "scan_complete", scanId: scanState.scanId, reports: scanState.reportFiles })}\n\n`);
      } else if (scanState.status === "error") {
        controller.enqueue(`data: ${JSON.stringify({ type: "scan_error", phase: scanState.phase, message: scanState.message })}\n\n`);
      }
    },
    cancel() {
      broadcaster.remove(clientId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...CORS,
    },
  });
}

// ── Route: GET /api/reports/:filename ────────────────────────────────────────
function handleReportDownload(filename: string): Response {
  // Prevent path traversal
  if (filename.includes("/") || filename.includes("..")) {
    return json({ error: "Invalid filename" }, 400);
  }

  const filePath = join(CONFIG.reportOutput, filename);
  const safeReportDir = resolve(CONFIG.reportOutput);
  if (!resolve(filePath).startsWith(safeReportDir)) {
    return json({ error: "Forbidden" }, 403);
  }

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return json({ error: "Report not found" }, 404);
  }

  const ext = filename.split(".").pop() ?? "";
  const contentTypes: Record<string, string> = {
    json: "application/json",
    md: "text/markdown",
    html: "text/html",
    log: "text/plain",
  };

  const file = Bun.file(filePath);
  return new Response(file, {
    headers: {
      "Content-Type": contentTypes[ext] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(size),
      ...CORS,
    },
  });
}

// ── Route: GET /api/reports (list) ───────────────────────────────────────────
function handleListReports(): Response {
  try {
    const files = readdirSync(CONFIG.reportOutput)
      .filter(f => f.match(/\.(json|md|html|log)$/))
      .sort()
      .reverse()
      .slice(0, 20)
      .map(name => {
        try {
          const size = statSync(join(CONFIG.reportOutput, name)).size;
          return { name, size };
        } catch { return { name, size: 0 }; }
      });
    return json({ files });
  } catch {
    return json({ files: [] });
  }
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (path === "/api/health" && req.method === "GET") return handleHealth();
  if (path === "/api/browse" && req.method === "GET") return handleBrowse(url);
  if (path === "/api/scan" && req.method === "POST") return handleStartScan(req);
  if (path === "/api/status" && req.method === "GET") return handleStatus();
  if (path === "/api/reports" && req.method === "GET") return handleListReports();

  const reportMatch = path.match(/^\/api\/reports\/(.+)$/);
  if (reportMatch && req.method === "GET") return handleReportDownload(reportMatch[1]!);

  // Serve UI for all other GET requests (SPA fallback)
  if (req.method === "GET") {
    const uiPath = new URL("../ui/index.html", import.meta.url).pathname;
    return new Response(Bun.file(uiPath), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return json({ error: "Not found" }, 404);
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/routes.ts
git commit -m "feat: add API route handlers"
```

---

## Task 8: HTTP server entry point

**Files:**
- Create: `src/server/index.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create `src/server/index.ts`**

```typescript
// src/server/index.ts
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { checkTikaHealth } from "../parsers/tika.ts";
import { checkOllamaHealth } from "../llm/ollama.ts";
import { runRegexTests } from "../utils/regex-patterns.ts";
import { handleRequest } from "./routes.ts";
import { healthState } from "./health-state.ts";

async function start() {
  // Regex self-test — abort if broken patterns detected
  const regexResult = runRegexTests();
  if (!regexResult.passed) {
    logger.error("Regex test suite FAILED — aborting", { failures: regexResult.failures });
    process.exit(1);
  }

  // Initial health checks — populate healthState for /api/health
  const [tikaOk, { ok: ollamaOk, modelsAvailable }] = await Promise.all([
    checkTikaHealth(),
    checkOllamaHealth(),
  ]);
  healthState.tikaOk = tikaOk;
  healthState.ollamaOk = ollamaOk;
  healthState.modelsAvailable = modelsAvailable;

  if (!tikaOk) logger.warn("Tika unreachable — PDF parsing will be skipped");
  if (!ollamaOk) logger.warn("Ollama unreachable — LLM features disabled");

  // Refresh health every 30 seconds
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
    fetch: handleRequest,
  });

  logger.info(`Huginn server ready`, { url: `http://localhost:${CONFIG.serverPort}` });
  console.log(`\n  Huginn ready → http://localhost:${CONFIG.serverPort}\n`);
}

start().catch(e => {
  console.error("Server failed to start:", e);
  process.exit(1);
});
```

- [ ] **Step 2: Update `src/index.ts` to import the server**

Replace the entire content of `src/index.ts` with:

```typescript
import "./server/index.ts";
```

- [ ] **Step 3: Verify typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Test startup manually**

```bash
DOCUMENTS_ROOT=./_test-docs bun run src/index.ts
```

Expected: `Huginn ready → http://localhost:3000` printed. Open `http://localhost:3000` in browser — you should get a 200 response (even if UI file doesn't exist yet, the server is up). `Ctrl+C` to stop.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/index.ts
git commit -m "feat: add HTTP server entry point, switch index.ts to server mode"
```

---

## Task 9: UI — setup screen

**Files:**
- Create: `src/ui/index.html`

This is the full HTML file. All three screens live here, toggled by JS. Start with the setup screen. No framework, no build step — just HTML + CSS + vanilla JS served directly by the Bun server.

- [ ] **Step 1: Create `src/ui/index.html` with setup screen**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Huginn — Document Intelligence Scanner</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600&family=IBM+Plex+Mono:wght@400&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box}*{margin:0;padding:0}
:root{
  --bg-base:#141517;--bg-surface:#1e2025;--bg-elevated:#26292e;
  --border:#303338;--border-focus:#da291c;
  --text-primary:#f2f2f3;--text-secondary:#8b8d94;--text-muted:#5a5c63;
  --accent:#da291c;--accent-hover:#c42418;--accent-dim:rgba(218,41,28,.12);
  --success:#16a34a;--success-dim:rgba(22,163,74,.12);
  --warning:#d97706;--warning-dim:rgba(217,119,6,.12);
  --error:#da291c;--error-dim:rgba(218,41,28,.12);
  --font-heading:'Barlow Condensed',sans-serif;
  --font-body:'IBM Plex Sans',sans-serif;
  --font-mono:'IBM Plex Mono',monospace;
  --radius:4px;
}
html,body{height:100%;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-body);}
/* Topbar */
.topbar{height:48px;border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 1.5rem;gap:1rem;flex-shrink:0;}
.topbar-logo{font-family:var(--font-heading);font-size:1.1rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase;display:flex;align-items:center;gap:.5rem;}
.topbar-logo-mark{width:22px;height:22px;background:var(--accent);border-radius:var(--radius);display:flex;align-items:center;justify-content:center;font-size:.7rem;color:#fff;}
.topbar-sep{width:1px;height:20px;background:var(--border);}
.topbar-sub{font-size:.75rem;color:var(--text-muted);font-weight:500;}
.topbar-status{margin-left:auto;display:flex;align-items:center;gap:.5rem;font-size:.75rem;color:var(--text-muted);}
/* Page */
.page{max-width:1000px;margin:0 auto;padding:2.5rem 1.5rem;}
.page-header{margin-bottom:2rem;}
.page-title{font-family:var(--font-heading);font-size:1.875rem;font-weight:600;letter-spacing:.02em;}
.page-subtitle{color:var(--text-secondary);font-size:.875rem;margin-top:.3rem;}
/* Grid */
.grid{display:grid;grid-template-columns:1fr 340px;gap:1rem;align-items:start;}
/* Card */
.card{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;margin-bottom:1rem;}
.card:last-child{margin-bottom:0;}
.card-title{font-family:var(--font-heading);font-weight:600;font-size:.8125rem;text-transform:uppercase;letter-spacing:.1em;color:var(--text-secondary);margin-bottom:1rem;}
/* Fields */
.field{margin-bottom:1rem;}.field:last-child{margin-bottom:0;}
label{display:block;font-size:.875rem;font-weight:500;color:var(--text-secondary);margin-bottom:.375rem;}
.field-hint{font-size:.75rem;color:var(--text-muted);margin-top:.3rem;line-height:1.4;}
.path-row{display:flex;gap:.5rem;}
.path-input{flex:1;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-family:var(--font-mono);font-size:.875rem;padding:.625rem .875rem;transition:border-color .15s;}
.path-input:focus{outline:none;border-color:var(--border-focus);box-shadow:0 0 0 3px var(--accent-dim);}
.path-input::placeholder{color:var(--text-muted);}
.btn-browse{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-secondary);font-family:var(--font-body);font-size:.875rem;font-weight:500;padding:.625rem .875rem;cursor:pointer;white-space:nowrap;transition:all .15s;}
.btn-browse:hover{color:var(--text-primary);border-color:var(--text-muted);}
/* Folder tree */
.folder-tree{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.5rem;margin-top:.5rem;font-family:var(--font-mono);font-size:.8rem;max-height:260px;overflow-y:auto;}
.tree-item{display:flex;align-items:center;gap:.375rem;padding:.3rem .5rem;border-radius:var(--radius);cursor:pointer;color:var(--text-secondary);transition:background .1s,color .1s;user-select:none;}
.tree-item:hover{background:var(--bg-surface);color:var(--text-primary);}
.tree-item.selected{background:var(--accent-dim);color:var(--accent);}
.tree-icon{font-size:.75rem;width:14px;text-align:center;flex-shrink:0;}
.tree-count{margin-left:auto;color:var(--text-muted);font-size:.7rem;}
/* Checks */
.check-row{display:flex;align-items:center;gap:.625rem;padding:.45rem 0;font-size:.8125rem;}
.check-row+.check-row{border-top:1px solid var(--border);}
.check-name{color:var(--text-secondary);flex:1;}
.check-val{font-weight:500;}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}
/* Selects */
.settings-list{display:flex;flex-direction:column;gap:.75rem;}
.select-field{width:100%;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-family:var(--font-body);font-size:.875rem;padding:.5rem .75rem;appearance:none;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235a5c63'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .75rem center;padding-right:2rem;}
.select-field:focus{outline:none;border-color:var(--border-focus);}
/* Actions */
.actions{display:flex;gap:.75rem;align-items:center;margin-top:1.5rem;}
.btn-primary{background:var(--accent);border:1px solid var(--accent);color:#fff;border-radius:var(--radius);font-family:var(--font-heading);font-weight:600;font-size:.9375rem;text-transform:uppercase;letter-spacing:.06em;padding:.5625rem 1.5rem;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:.5rem;}
.btn-primary:hover:not(:disabled){background:var(--accent-hover);}
.btn-primary:disabled{opacity:.4;cursor:not-allowed;}
.btn-secondary{background:transparent;border:1px solid var(--border);color:var(--text-secondary);border-radius:var(--radius);font-family:var(--font-body);font-weight:500;font-size:.875rem;padding:.5rem 1rem;cursor:pointer;transition:all .15s;}
.btn-secondary:hover{color:var(--text-primary);border-color:var(--text-muted);}
.file-count{margin-left:auto;font-size:.8125rem;color:var(--text-muted);font-family:var(--font-mono);}
/* Alert */
.alert{padding:.75rem 1rem;border-radius:var(--radius);font-size:.8125rem;border-left:3px solid;margin-bottom:1rem;}
.alert-error{background:var(--error-dim);color:var(--error);border-left-color:var(--error);}
.alert-warning{background:var(--warning-dim);color:var(--warning);border-left-color:var(--warning);}
.alert-ok{background:var(--success-dim);color:var(--success);border-left-color:var(--success);}
/* Spinner */
@keyframes spin{to{transform:rotate(360deg)}}
.spinner{display:inline-block;width:8px;height:8px;border:1.5px solid rgba(255,255,255,.3);border-top-color:currentColor;border-radius:50%;animation:spin .7s linear infinite;}
/* Progress screen */
.progress-wrap{margin-bottom:1.25rem;}
.progress-label{display:flex;justify-content:space-between;font-size:.75rem;color:var(--text-muted);margin-bottom:.4rem;}
.progress-label span:last-child{font-family:var(--font-mono);}
.progress-track{height:4px;background:var(--bg-elevated);border-radius:2px;overflow:hidden;}
.progress-fill{height:100%;background:var(--accent);border-radius:2px;width:0%;transition:width .5s ease;}
.phase-list{display:flex;flex-direction:column;gap:2px;}
.phase-row{display:flex;align-items:center;gap:.75rem;padding:.55rem .75rem;border-radius:var(--radius);}
.phase-row.p-running{background:var(--bg-elevated);}
.phase-row.p-pending{opacity:.4;}
.phase-num{font-family:var(--font-heading);font-size:.75rem;font-weight:600;width:20px;text-align:center;flex-shrink:0;color:var(--text-muted);}
.phase-name{flex:1;font-size:.875rem;font-weight:500;}
.phase-name.p-done{color:var(--text-secondary);}
.phase-name.p-running{color:var(--text-primary);}
.phase-name.p-pending{color:var(--text-muted);}
.phase-time{font-family:var(--font-mono);font-size:.75rem;color:var(--text-muted);}
/* Log box */
.log-box{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.625rem .75rem;font-family:var(--font-mono);font-size:.75rem;height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;}
.log-line{display:flex;gap:.625rem;line-height:1.4;}
.log-ts{color:var(--text-muted);flex-shrink:0;}
.log-ph{color:var(--accent);flex-shrink:0;min-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.log-msg{color:var(--text-secondary);}
.log-line.warn .log-msg{color:var(--warning);}
.log-line.error .log-msg{color:var(--error);}
.log-line.current .log-msg{color:var(--text-primary);}
/* Stat grid */
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:.625rem;}
.stat-grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:.625rem;}
.stat-cell{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.75rem;}
.stat-label{font-family:var(--font-heading);font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted);margin-bottom:.25rem;}
.stat-val{font-family:var(--font-mono);font-size:1.25rem;color:var(--text-primary);line-height:1;}
.stat-val.warn{color:var(--warning);}
/* Complete */
.quality-card{background:var(--bg-surface);border:1px solid var(--border);border-top:2px solid var(--success);border-radius:var(--radius);padding:1.25rem;margin-bottom:1rem;}
.quality-card.poor{border-top-color:var(--warning);}
.quality-banner{display:flex;align-items:center;gap:1rem;margin-bottom:1rem;}
.quality-score-val{font-family:var(--font-mono);font-size:2.5rem;color:var(--success);line-height:1;}
.quality-score-val.poor{color:var(--warning);}
.quality-interp{font-size:.875rem;color:var(--success);margin-top:.2rem;}
.quality-interp.poor{color:var(--warning);}
.quality-bars{display:grid;grid-template-columns:auto 1fr auto;gap:.3rem .75rem;font-size:.8125rem;align-items:center;}
.qb-label{color:var(--text-muted);}
.qb-track{height:4px;background:var(--bg-elevated);border-radius:2px;overflow:hidden;}
.qb-fill{height:100%;background:var(--success);border-radius:2px;}
.qb-val{font-family:var(--font-mono);color:var(--text-secondary);}
/* Download rows */
.dl-list{display:flex;flex-direction:column;gap:.5rem;}
.dl-row{display:flex;align-items:center;gap:.75rem;padding:.75rem 1rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);text-decoration:none;color:var(--text-primary);cursor:pointer;transition:border-color .15s,background .15s;}
.dl-row:hover{border-color:var(--accent);background:var(--accent-dim);}
.dl-icon{font-size:1rem;flex-shrink:0;width:20px;text-align:center;}
.dl-info{flex:1;}
.dl-name{font-weight:500;font-size:.875rem;}
.dl-desc{font-size:.75rem;color:var(--text-muted);margin-top:.1rem;}
.dl-size{font-family:var(--font-mono);font-size:.75rem;color:var(--text-muted);}
.dl-arrow{color:var(--text-muted);}
.dl-row:hover .dl-arrow{color:var(--accent);}
/* Phase done list */
.pd-row{display:flex;align-items:center;gap:.75rem;padding:.45rem .75rem;border-radius:var(--radius);}
.pd-num{font-family:var(--font-heading);font-size:.75rem;width:20px;text-align:center;color:var(--text-muted);}
.pd-name{flex:1;font-size:.875rem;color:var(--text-secondary);}
.pd-time{font-family:var(--font-mono);font-size:.75rem;color:var(--text-muted);}
/* Abort */
.btn-abort{background:transparent;border:1px solid var(--border);color:var(--text-muted);border-radius:var(--radius);font-family:var(--font-body);font-weight:500;font-size:.875rem;padding:.5rem 1rem;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:.4rem;margin-top:1rem;}
.btn-abort:hover{color:var(--accent);border-color:var(--accent);}
/* Screen visibility */
.screen{display:none;}.screen.active{display:block;}
/* Info grid */
.info-grid{display:grid;grid-template-columns:auto 1fr;gap:.35rem .75rem;font-size:.8125rem;}
.info-label{color:var(--text-muted);}
.info-val{font-family:var(--font-mono);font-size:.75rem;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* Elapsed */
.page-header-row{display:flex;align-items:flex-start;gap:1rem;}
.elapsed{margin-left:auto;font-family:var(--font-mono);font-size:.8125rem;color:var(--text-muted);white-space:nowrap;padding-top:.25rem;}
</style>
</head>
<body>

<!-- ── Topbar ── -->
<div class="topbar">
  <div class="topbar-logo">
    <div class="topbar-logo-mark">H</div>
    HUGINN
  </div>
  <div class="topbar-sep"></div>
  <span class="topbar-sub">Document Intelligence Scanner</span>
  <div class="topbar-status" id="topbar-status">
    <div class="dot" id="topbar-dot" style="background:var(--text-muted);"></div>
    <span id="topbar-label">Checking...</span>
  </div>
</div>

<!-- ═══════════════════ SETUP SCREEN ═══════════════════ -->
<div class="screen active" id="screen-setup">
  <div class="page">
    <div class="page-header">
      <div class="page-title">New Scan</div>
      <div class="page-subtitle">Select a documents folder to begin the analysis pipeline.</div>
    </div>
    <div class="grid">
      <!-- Left -->
      <div>
        <div class="card">
          <div class="card-title">Documents Folder</div>
          <div class="field">
            <label>Path</label>
            <div class="path-row">
              <input class="path-input" id="folder-path" type="text" value="/documents" placeholder="/documents/project-name">
              <button class="btn-browse" id="btn-browse-up">↑ Up</button>
            </div>
            <div class="field-hint">Mount your folder at container start: <code style="font-family:var(--font-mono);color:var(--text-muted);">-v /host/path:/documents</code></div>
          </div>
          <div class="folder-tree" id="folder-tree">
            <div class="tree-item" style="color:var(--text-muted);font-style:italic;">Loading...</div>
          </div>
        </div>
        <div id="setup-error" class="alert alert-error" style="display:none;"></div>
        <div class="actions">
          <button class="btn-primary" id="btn-start" disabled>▶ Start Scan</button>
          <span class="file-count" id="file-count"></span>
        </div>
      </div>
      <!-- Right -->
      <div>
        <div class="card" id="system-status-card">
          <div class="card-title">System Status</div>
          <div id="health-rows">
            <div class="check-row"><div class="dot" style="background:var(--text-muted);"></div><span class="check-name">Checking...</span></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Scan Settings</div>
          <div class="settings-list">
            <div class="field">
              <label>Embed model</label>
              <select class="select-field" id="embed-model">
                <option value="nomic-embed-text">nomic-embed-text</option>
                <option value="bge-m3">bge-m3</option>
              </select>
            </div>
            <div class="field">
              <label>Chat model</label>
              <select class="select-field" id="chat-model">
                <option value="llama3.1:8b">llama3.1:8b</option>
                <option value="mistral:7b">mistral:7b</option>
              </select>
            </div>
            <div class="field">
              <label>LLM sample rate</label>
              <select class="select-field" id="sample-rate">
                <option value="0.05">5% (fast)</option>
                <option value="0.10">10%</option>
                <option value="0.25">25% (thorough)</option>
              </select>
            </div>
            <div class="field">
              <label>Section embeddings</label>
              <select class="select-field" id="section-embeddings">
                <option value="false">Disabled</option>
                <option value="true">Enabled (slower)</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ═══════════════════ PROGRESS SCREEN ═══════════════════ -->
<div class="screen" id="screen-progress">
  <div class="page">
    <div class="page-header-row page-header">
      <div>
        <div class="page-title">Scan in Progress</div>
        <div class="page-subtitle" id="progress-subtitle">—</div>
      </div>
      <div class="elapsed" id="elapsed-timer">00:00</div>
    </div>
    <div class="grid">
      <div>
        <div class="card">
          <div class="card-title">Pipeline Phases</div>
          <div class="progress-wrap">
            <div class="progress-label">
              <span id="progress-text">0 of 9 phases complete</span>
              <span id="progress-pct">0%</span>
            </div>
            <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
          </div>
          <div class="phase-list" id="phase-list"></div>
        </div>
        <div class="card">
          <div class="card-title">Live Log</div>
          <div class="log-box" id="log-box"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <div class="card-title">Live Stats</div>
          <div class="stat-grid" id="live-stats">
            <div class="stat-cell"><div class="stat-label">Files found</div><div class="stat-val" id="st-files">—</div></div>
            <div class="stat-cell"><div class="stat-label">Parsed</div><div class="stat-val" id="st-parsed">—</div></div>
            <div class="stat-cell"><div class="stat-label">Pairs scored</div><div class="stat-val" id="st-pairs">—</div></div>
            <div class="stat-cell"><div class="stat-label">Version pairs</div><div class="stat-val" id="st-vpairs">—</div></div>
            <div class="stat-cell"><div class="stat-label">References</div><div class="stat-val" id="st-refs">—</div></div>
            <div class="stat-cell"><div class="stat-label">Requirements</div><div class="stat-val" id="st-reqs">—</div></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Scan Info</div>
          <div class="info-grid" id="scan-info-grid"></div>
        </div>
        <button class="btn-abort" id="btn-abort">✕ Abort Scan</button>
      </div>
    </div>
  </div>
</div>

<!-- ═══════════════════ COMPLETE SCREEN ═══════════════════ -->
<div class="screen" id="screen-complete">
  <div class="page">
    <div class="page-header-row page-header">
      <div>
        <div class="page-title">Scan Complete</div>
        <div class="page-subtitle" id="complete-subtitle">—</div>
      </div>
      <div class="elapsed" id="complete-duration"></div>
    </div>
    <div class="grid">
      <div>
        <div class="quality-card" id="quality-card">
          <div class="card-title">Data Quality Score</div>
          <div class="quality-banner">
            <div class="quality-score-val" id="q-score">—</div>
            <div>
              <div style="font-family:var(--font-heading);font-size:.8125rem;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted);">/ 100</div>
              <div class="quality-interp" id="q-interp">—</div>
            </div>
          </div>
          <div class="quality-bars" id="q-bars"></div>
        </div>
        <div class="card">
          <div class="card-title">Summary</div>
          <div class="stat-grid-3" id="complete-stats"></div>
          <div id="complete-warnings" style="margin-top:.75rem;"></div>
        </div>
        <div class="card">
          <div class="card-title">Download Reports</div>
          <div class="dl-list" id="dl-list"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <div class="card-title">Pipeline Complete</div>
          <div id="complete-phases"></div>
        </div>
        <div class="card">
          <div class="card-title">Scan Info</div>
          <div class="info-grid" id="complete-info-grid"></div>
        </div>
        <button class="btn-primary" id="btn-new-scan" style="margin-top:1rem;">+ New Scan</button>
      </div>
    </div>
  </div>
</div>

<!-- ═══════════════════ ERROR SCREEN ═══════════════════ -->
<div class="screen" id="screen-error">
  <div class="page">
    <div class="page-header">
      <div class="page-title">Scan Failed</div>
      <div class="page-subtitle" id="error-subtitle">—</div>
    </div>
    <div class="grid">
      <div>
        <div class="alert alert-error" id="error-banner"></div>
        <div class="card">
          <div class="card-title">Pipeline Status</div>
          <div class="phase-list" id="error-phase-list"></div>
        </div>
        <div class="card">
          <div class="card-title">Last Log Lines</div>
          <div class="log-box" id="error-log-box"></div>
        </div>
        <div id="error-partial-reports" style="margin-top:1rem;"></div>
      </div>
      <div>
        <div class="card">
          <div class="card-title">Scan Info</div>
          <div class="info-grid" id="error-info-grid"></div>
        </div>
        <button class="btn-primary" id="btn-retry" style="margin-top:1rem;">↺ Try Again</button>
      </div>
    </div>
  </div>
</div>

<script>
// ── App state ──────────────────────────────────────────────────────────────
const state = {
  screen: 'setup',           // 'setup' | 'progress' | 'complete' | 'error'
  health: null,
  currentPath: '/documents',
  selectedFolder: '/documents',
  scanId: null,
  startedAt: null,
  phases: [],                // [{name, idx, status:'pending'|'running'|'done'|'error', durationMs, startedAt}]
  logs: [],                  // [{ts, level, phase, message}]
  completedPhaseCount: 0,
  reportFiles: [],
  reportData: null,          // parsed scan JSON (fetched after complete)
  errorPhase: null,
  errorMessage: null,
  elapsedInterval: null,
};

const PHASE_NAMES = [
  {name:'1-harvest',label:'Harvest'},
  {name:'2-parse',label:'Parse'},
  {name:'9-projection',label:'Projection'},
  {name:'3-fingerprint',label:'Fingerprint'},
  {name:'4-cluster',label:'Cluster'},
  {name:'5-references',label:'References'},
  {name:'6-requirements',label:'Requirements'},
  {name:'7-validate',label:'Validate'},
  {name:'8-report',label:'Report'},
];

// ── Screen switching ────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  state.screen = name;
}

// ── Health check ───────────────────────────────────────────────────────────
async function fetchHealth() {
  try {
    const r = await fetch('/api/health');
    const h = await r.json();
    state.health = h;
    renderHealth(h);
    const canScan = h.ollamaOk;
    document.getElementById('btn-start').disabled = !canScan || !state.selectedFolder;
  } catch {
    document.getElementById('health-rows').innerHTML =
      '<div class="check-row"><div class="dot" style="background:var(--error);"></div><span class="check-name" style="color:var(--error);">Server unreachable</span></div>';
  }
}

function renderHealth(h) {
  const rows = [
    {label: 'Tika (PDF parser)', ok: h.tikaOk, warnOnly: true},
    {label: `Ollama · ${h.modelsAvailable?.[0] || 'chat model'}`, ok: h.ollamaOk, warnOnly: false},
    {label: `Ollama · ${h.modelsAvailable?.[1] || 'embed model'}`, ok: h.ollamaOk, warnOnly: false},
  ];
  document.getElementById('health-rows').innerHTML = rows.map(row => {
    const color = row.ok ? 'var(--success)' : row.warnOnly ? 'var(--warning)' : 'var(--error)';
    const label = row.ok ? 'healthy' : row.warnOnly ? 'unavailable' : 'offline';
    return `<div class="check-row">
      <div class="dot" style="background:${color};"></div>
      <span class="check-name">${row.label}</span>
      <span class="check-val" style="color:${color};">${label}</span>
    </div>`;
  }).join('');

  const topDot = document.getElementById('topbar-dot');
  const topLabel = document.getElementById('topbar-label');
  if (h.ollamaOk) {
    topDot.style.background = 'var(--success)';
    topLabel.textContent = 'Ready';
    topLabel.style.color = 'var(--text-muted)';
  } else {
    topDot.style.background = 'var(--error)';
    topLabel.textContent = 'Ollama offline';
    topLabel.style.color = 'var(--error)';
  }
}

// ── Folder browser ─────────────────────────────────────────────────────────
async function loadFolder(path) {
  state.currentPath = path;
  document.getElementById('folder-path').value = path;
  document.getElementById('folder-tree').innerHTML =
    '<div class="tree-item" style="color:var(--text-muted);">Loading...</div>';

  try {
    const r = await fetch('/api/browse?path=' + encodeURIComponent(path));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Browse failed');
    renderTree(data);
    selectFolder(path, null);
  } catch (e) {
    document.getElementById('folder-tree').innerHTML =
      `<div class="tree-item" style="color:var(--error);">${e.message}</div>`;
  }
}

function renderTree(data) {
  const tree = document.getElementById('folder-tree');
  if (!data.entries.length) {
    tree.innerHTML = '<div class="tree-item" style="color:var(--text-muted);">No subdirectories</div>';
    return;
  }
  tree.innerHTML = data.entries.map(e => {
    const totalCount = e.fileCount;
    return `<div class="tree-item" onclick="selectFolder('${data.path}/${e.name}', this)" data-path="${data.path}/${e.name}">
      <span class="tree-icon">📁</span>
      <span>${e.name}/</span>
      <span class="tree-count">${totalCount} file${totalCount !== 1 ? 's' : ''}</span>
    </div>`;
  }).join('');
}

function selectFolder(path, el) {
  state.selectedFolder = path;
  document.getElementById('folder-path').value = path;
  document.querySelectorAll('.tree-item').forEach(i => i.classList.remove('selected'));
  if (el) el.classList.add('selected');
  const h = state.health;
  document.getElementById('btn-start').disabled = !(h && h.ollamaOk);

  // Count files at selected path
  fetch('/api/browse?path=' + encodeURIComponent(path))
    .then(r => r.json())
    .then(data => {
      const total = data.entries ? data.entries.reduce((s, e) => s + e.fileCount, 0) : 0;
      document.getElementById('file-count').textContent = total + ' files detected';
    }).catch(() => {});
}

document.getElementById('folder-path').addEventListener('change', e => {
  loadFolder(e.target.value);
});

document.getElementById('btn-browse-up').addEventListener('click', () => {
  const parts = state.currentPath.split('/').filter(Boolean);
  if (parts.length > 1) {
    parts.pop();
    loadFolder('/' + parts.join('/'));
  }
});

// ── Start scan ─────────────────────────────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', async () => {
  const folder = state.selectedFolder;
  const settings = {
    embedModel: document.getElementById('embed-model').value,
    chatModel: document.getElementById('chat-model').value,
    llmSampleRate: parseFloat(document.getElementById('sample-rate').value),
    sectionEmbeddings: document.getElementById('section-embeddings').value === 'true',
  };

  document.getElementById('setup-error').style.display = 'none';

  try {
    const r = await fetch('/api/scan', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({folder, settings}),
    });
    const data = await r.json();
    if (!r.ok) {
      document.getElementById('setup-error').textContent = data.error || 'Failed to start scan';
      document.getElementById('setup-error').style.display = 'block';
      return;
    }
    state.scanId = data.scanId;
    state.startedAt = new Date();
    initProgressScreen(folder, data.scanId, settings);
    connectSse();
    showScreen('progress');
  } catch (e) {
    document.getElementById('setup-error').textContent = 'Network error: ' + e.message;
    document.getElementById('setup-error').style.display = 'block';
  }
});

// ── Init ───────────────────────────────────────────────────────────────────
fetchHealth();
setInterval(fetchHealth, 10000);
loadFolder('/documents');
</script>
</body>
</html>
```

- [ ] **Step 2: Test setup screen manually**

Start the server (Task 8 must be done):

```bash
DOCUMENTS_ROOT=./_test-docs bun run src/index.ts
```

Open `http://localhost:3000`. Verify:
- Health dots appear (green or red depending on services)
- Folder tree loads showing `_test-docs` subdirectories
- Start Scan button is disabled if Ollama is offline

- [ ] **Step 3: Commit**

```bash
git add src/ui/index.html
git commit -m "feat: add UI setup screen"
```

---

## Task 10: UI — progress + complete + error screens

**Files:**
- Modify: `src/ui/index.html` (add JS for progress/complete/error screens)

- [ ] **Step 1: Add progress screen JS — append inside the `<script>` tag before the closing `</script>`**

Find the `// ── Init ────` comment in `src/ui/index.html` and insert the following **before** it:

```javascript
// ── Progress screen ────────────────────────────────────────────────────────
function initProgressScreen(folder, scanId, settings) {
  state.phases = PHASE_NAMES.map((p, i) => ({...p, idx: i, status: 'pending', durationMs: null, startedAt: null}));
  state.logs = [];
  state.completedPhaseCount = 0;
  renderPhaseList('phase-list');
  document.getElementById('progress-subtitle').textContent = folder + ' · ' + scanId;
  document.getElementById('log-box').innerHTML = '';
  document.getElementById('scan-info-grid').innerHTML = infoGrid({
    'Folder': folder,
    'Scan ID': scanId,
    'Embed model': settings.embedModel,
    'Chat model': settings.chatModel,
  });
  startElapsed();
}

function startElapsed() {
  if (state.elapsedInterval) clearInterval(state.elapsedInterval);
  state.elapsedInterval = setInterval(() => {
    if (!state.startedAt) return;
    const secs = Math.floor((Date.now() - state.startedAt) / 1000);
    const m = String(Math.floor(secs / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    const el = document.getElementById('elapsed-timer');
    if (el) el.textContent = m + ':' + s;
  }, 1000);
}

function stopElapsed() {
  if (state.elapsedInterval) { clearInterval(state.elapsedInterval); state.elapsedInterval = null; }
}

function renderPhaseList(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = state.phases.map(p => {
    const cls = p.status === 'running' ? 'p-running' : p.status === 'done' ? '' : p.status === 'error' ? '' : 'p-pending';
    const icon = p.status === 'done' ? `<span style="color:var(--success);font-size:.85rem;">✓</span>`
      : p.status === 'running' ? `<span class="spinner" style="color:var(--warning);"></span>`
      : p.status === 'error' ? `<span style="color:var(--error);font-size:.85rem;">✗</span>`
      : `<span style="color:var(--text-muted);">·</span>`;
    const time = p.durationMs != null
      ? (p.durationMs / 1000).toFixed(0) + 's'
      : p.status === 'running' ? '…' : '—';
    const nameColor = p.status === 'running' ? 'p-running' : p.status === 'done' ? 'p-done' : 'p-pending';
    return `<div class="phase-row ${cls}">
      <span class="phase-num">${p.name.split('-')[0]}</span>
      ${icon}
      <span class="phase-name ${nameColor}">${p.label}</span>
      <span class="phase-time${p.status==='running'?' running':''}">${time}</span>
    </div>`;
  }).join('');
}

function addLog(ts, level, phase, message) {
  state.logs.push({ts, level, phase, message});
  if (state.logs.length > 200) state.logs.shift();
  const box = document.getElementById('log-box');
  if (!box) return;
  const cls = level === 'WARN' ? 'warn' : level === 'ERROR' ? 'error' : '';
  const div = document.createElement('div');
  div.className = 'log-line ' + cls;
  div.innerHTML = `<span class="log-ts">${ts}</span><span class="log-ph">${phase}</span><span class="log-msg">${message}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function infoGrid(pairs) {
  return Object.entries(pairs).map(([k,v]) =>
    `<span class="info-label">${k}</span><span class="info-val">${v}</span>`
  ).join('');
}

// ── SSE connection ─────────────────────────────────────────────────────────
function connectSse() {
  const es = new EventSource('/api/status');
  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    const now = new Date().toLocaleTimeString('de-DE', {hour12: false});

    if (event.type === 'phase_start') {
      const p = state.phases[event.phaseIndex];
      if (p) { p.status = 'running'; p.startedAt = Date.now(); }
      renderPhaseList('phase-list');
      addLog(now, 'INFO', event.phase, 'Phase started');
      updateTopbarRunning(event.phaseIndex);

    } else if (event.type === 'phase_end') {
      const p = state.phases.find(x => x.name === event.phase);
      if (p) { p.status = 'done'; p.durationMs = event.durationMs; }
      state.completedPhaseCount++;
      const pct = Math.round((state.completedPhaseCount / 9) * 100);
      document.getElementById('progress-fill').style.width = pct + '%';
      document.getElementById('progress-text').textContent = state.completedPhaseCount + ' of 9 phases complete';
      document.getElementById('progress-pct').textContent = pct + '%';
      renderPhaseList('phase-list');

    } else if (event.type === 'log') {
      addLog(now, event.level, event.phase, event.message);

    } else if (event.type === 'scan_complete') {
      stopElapsed();
      state.reportFiles = event.reports;
      es.close();
      // Fetch report JSON to populate quality score
      const jsonFile = event.reports.find(f => f.endsWith('.json') && !f.endsWith('-human.md'));
      if (jsonFile) {
        fetch('/api/reports/' + jsonFile)
          .then(r => r.json())
          .then(data => { state.reportData = data; renderCompleteScreen(event.scanId); })
          .catch(() => renderCompleteScreen(event.scanId));
      } else {
        renderCompleteScreen(event.scanId);
      }
      showScreen('complete');

    } else if (event.type === 'scan_error') {
      stopElapsed();
      const p = state.phases.find(x => x.name === event.phase);
      if (p) p.status = 'error';
      state.errorPhase = event.phase;
      state.errorMessage = event.message;
      renderPhaseList('error-phase-list');
      document.getElementById('error-log-box').innerHTML = document.getElementById('log-box').innerHTML;
      document.getElementById('error-banner').textContent = 'Phase ' + event.phase + ' failed: ' + event.message;
      document.getElementById('error-subtitle').textContent = state.scanId;
      document.getElementById('error-info-grid').innerHTML = infoGrid({'Scan ID': state.scanId, 'Failed at': event.phase});
      es.close();
      showScreen('error');
    }
  };
  es.onerror = () => {
    if (state.screen === 'progress') {
      addLog(new Date().toLocaleTimeString(), 'WARN', 'network', 'SSE connection lost — reconnecting...');
    }
  };
}

function updateTopbarRunning(phaseIndex) {
  const dot = document.getElementById('topbar-dot');
  const label = document.getElementById('topbar-label');
  dot.style.background = 'var(--warning)';
  label.textContent = 'Running — Phase ' + (phaseIndex + 1) + ' of 9';
  label.style.color = 'var(--warning)';
}

document.getElementById('btn-abort').addEventListener('click', () => {
  // Abort is client-side only — reload page to reset (server scan will finish/error naturally)
  if (confirm('Abort scan? The pipeline will continue running until the current phase completes.')) {
    location.reload();
  }
});

// ── Complete screen ────────────────────────────────────────────────────────
function renderCompleteScreen(scanId) {
  const d = state.reportData;
  const duration = state.startedAt
    ? ((Date.now() - state.startedAt) / 1000).toFixed(0) + 's total'
    : '—';
  document.getElementById('complete-subtitle').textContent = scanId;
  document.getElementById('complete-duration').textContent = duration;

  // Quality score
  if (d && d.metadataQualityScore) {
    const mq = d.metadataQualityScore;
    const poor = mq.overall < 60;
    document.getElementById('q-score').textContent = mq.overall;
    document.getElementById('q-score').className = 'quality-score-val' + (poor ? ' poor' : '');
    document.getElementById('q-interp').textContent = mq.interpretation;
    document.getElementById('q-interp').className = 'quality-interp' + (poor ? ' poor' : '');
    if (poor) document.getElementById('quality-card').classList.add('poor');
    const c = mq.components || {};
    document.getElementById('q-bars').innerHTML = [
      ['Parse success', c.parseSuccessRate],
      ['Heading extraction', c.headingExtractionConfidence],
      ['LLM validation', c.requirementValidationDelta],
      ['OCR coverage', 100 - (c.ocrWarningRate || 0)],
    ].map(([label, val]) =>
      `<span class="qb-label">${label}</span>
       <div class="qb-track"><div class="qb-fill" style="width:${val || 0}%;"></div></div>
       <span class="qb-val">${val != null ? val + '%' : '—'}</span>`
    ).join('');
  } else {
    document.getElementById('q-score').textContent = '—';
    document.getElementById('q-interp').textContent = 'Report data unavailable';
  }

  // Summary stats
  const s = d && d.summary ? d.summary : {};
  document.getElementById('complete-stats').innerHTML = [
    ['Files', s.totalFiles ?? '—'],
    ['Parsed', s.parsedFiles ?? '—'],
    ['Failed', s.parseFailures ?? '—'],
    ['Version pairs', d ? (d.versionPairs || []).filter(p => p.confidence === 'HIGH').length : '—'],
    ['References', d ? (d.references || []).length : '—'],
    ['Requirements', d ? (d.requirements || []).length : '—'],
  ].map(([label, val]) =>
    `<div class="stat-cell"><div class="stat-label">${label}</div><div class="stat-val">${val}</div></div>`
  ).join('');

  // Phase timing
  document.getElementById('complete-phases').innerHTML =
    '<div style="display:flex;flex-direction:column;gap:2px;">' +
    state.phases.map(p =>
      `<div class="pd-row">
        <span class="pd-num">${p.name.split('-')[0]}</span>
        <span style="color:var(--success);font-size:.85rem;">✓</span>
        <span class="pd-name">${p.label}</span>
        <span class="pd-time">${p.durationMs != null ? (p.durationMs/1000).toFixed(0)+'s' : '—'}</span>
      </div>`
    ).join('') + '</div>';

  // Scan info
  document.getElementById('complete-info-grid').innerHTML = infoGrid({
    'Scan ID': scanId,
    'Completed': new Date().toLocaleTimeString(),
    'Duration': duration,
  });

  // Download links
  fetch('/api/reports')
    .then(r => r.json())
    .then(data => {
      const files = (data.files || []).filter(f =>
        f.name.endsWith('.json') || f.name.endsWith('.md') || f.name.endsWith('.html')
      ).slice(0, 3);
      document.getElementById('dl-list').innerHTML = files.map(f => {
        const ext = f.name.split('.').pop();
        const icons = {json: '{ }', md: '📄', html: '📊'};
        const descs = {json: 'Full structured output for downstream processing', md: 'Human-readable summary with all recommendations', html: 'Interactive report with charts and tables'};
        const names = {json: 'JSON Data', md: 'Markdown Report', html: 'HTML Dashboard'};
        const size = f.size > 1048576 ? (f.size/1048576).toFixed(1)+' MB' : Math.round(f.size/1024)+' KB';
        return `<a class="dl-row" href="/api/reports/${f.name}" download="${f.name}">
          <span class="dl-icon">${icons[ext]||'📎'}</span>
          <div class="dl-info">
            <div class="dl-name">${names[ext]||f.name}</div>
            <div class="dl-desc">${descs[ext]||f.name}</div>
          </div>
          <span class="dl-size">${size}</span>
          <span class="dl-arrow">↓</span>
        </a>`;
      }).join('');
    }).catch(() => {
      document.getElementById('dl-list').innerHTML = '<div style="color:var(--text-muted);font-size:.875rem;">Could not list reports.</div>';
    });

  // Topbar
  document.getElementById('topbar-dot').style.background = 'var(--success)';
  document.getElementById('topbar-label').textContent = 'Scan complete';
  document.getElementById('topbar-label').style.color = 'var(--text-muted)';
}

document.getElementById('btn-new-scan').addEventListener('click', () => {
  state.reportData = null; state.scanId = null; state.startedAt = null;
  state.phases = []; state.logs = []; state.completedPhaseCount = 0;
  fetchHealth(); loadFolder(state.selectedFolder || '/documents');
  showScreen('setup');
});

document.getElementById('btn-retry').addEventListener('click', () => {
  state.errorPhase = null; state.errorMessage = null;
  fetchHealth(); showScreen('setup');
});
```

- [ ] **Step 2: Test progress screen manually**

With the server running and real documents in `_test-docs`:
- Start a scan from the setup screen
- Verify phases animate as they complete
- Verify log lines stream in
- After completion, verify quality score and download links appear

- [ ] **Step 3: Commit**

```bash
git add src/ui/index.html
git commit -m "feat: add progress, complete, and error screens to UI"
```

---

## Task 11: Docker Compose update

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Update scanner service in `docker-compose.yml`**

Replace the `scanner:` service block with:

```yaml
  scanner:
    build:
      context: .
      dockerfile: Dockerfile.scanner
    depends_on:
      tika:
        condition: service_started
      ollama-init:
        condition: service_completed_successfully
    volumes:
      - ${DOCUMENTS_PATH:-./documents}:/documents:ro
      - ./reports:/reports
    ports:
      - "${HUGINN_PORT:-3000}:3000"
    environment:
      - TIKA_URL=http://tika:9998
      - OLLAMA_URL=http://ollama:11434
      - OLLAMA_EMBED_MODEL=nomic-embed-text
      - OLLAMA_CHAT_MODEL=llama3.1:8b
      - DOCUMENTS_ROOT=/documents
      - REPORT_OUTPUT=/reports
      - LLM_SAMPLE_RATE=0.05
      - HUGINN_SERVER_PORT=3000
    command: bun run src/index.ts
    restart: unless-stopped
```

Key changes:
- Added `ports: ["${HUGINN_PORT:-3000}:3000"]` (port configurable via env var)
- Changed `restart: "no"` → `restart: unless-stopped`
- Added `HUGINN_SERVER_PORT=3000`
- Changed volume default from `./_test-docs` to `./documents` (cleaner for client delivery)

- [ ] **Step 2: Create `./documents/.gitkeep`** (so the default mount target exists in the repo)

```bash
mkdir -p documents && touch documents/.gitkeep
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml documents/.gitkeep
git commit -m "feat: expose port 3000 and add restart policy to scanner service"
```

---

## Task 12: End-to-end smoke test

**Prerequisite:** GPU machine with Docker + NVIDIA Container Toolkit + populated `documents/` folder with at least 5 supported files (`.docx`, `.pdf`, etc.).

- [ ] **Step 1: Build and start the stack**

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d
```

Expected: all 4 services start (tika, ollama, ollama-init, scanner).

- [ ] **Step 2: Wait for models to download (first run only)**

```bash
docker compose logs -f ollama-init
```

Expected: `success` for both `ollama pull nomic-embed-text` and `ollama pull llama3.1:8b`.

- [ ] **Step 3: Verify server is up**

```bash
curl http://localhost:3000/api/health
```

Expected: `{"tikaOk":true,"ollamaOk":true,"modelsAvailable":[...],"scanStatus":"idle"}`

- [ ] **Step 4: Open UI and run a scan**

Open `http://localhost:3000` in a browser.
- Verify both Tika and Ollama show green dots
- Select the documents folder from the tree
- Click Start Scan
- Verify phase progress animates through all 9 phases
- Verify live log shows real log lines (phase names, counts)

- [ ] **Step 5: Verify report downloads**

After scan completes:
- Click the HTML Dashboard download — verify it opens as a valid HTML report
- Click JSON Data download — verify it's valid JSON with `scanId`, `summary`, `versionPairs`, etc.

- [ ] **Step 6: Verify second scan works**

Click "New Scan", select the same folder, start again.

Expected: second scan runs cleanly (no port conflicts, no stale state).

- [ ] **Step 7: Commit final state and tag**

```bash
git add -A
git commit -m "chore: smoke test complete — huginn prod UI ready"
```

---

## Self-review notes

- **Spec §3.3:** `phaseIndex` in SSE events uses execution order (0–8), not phase number. Task 6 (`pipeline.ts`) implements this correctly with the `idx` field.
- **Spec §4.1:** Folder tree shows file counts — implemented in `folder-browser.ts` `countSupportedFiles()`.
- **Spec §5:** All 7 error scenarios are covered across Tasks 7 (routes), 8 (server), and 10 (UI).
- **Spec §6:** Docker changes are in Task 11.
- **Spec §7:** `serverPort` config is in Task 1.
- **Missing from spec:** `/api/reports` (list endpoint) — added to routes.ts in Task 7; used by complete screen to populate download links.
- **`setProgressCallback` import** in Task 6 — requires Task 3 (logger modification) to be done first. Tasks 1→2→3→4→5→6→7→8→9→10→11→12 must run in order.
