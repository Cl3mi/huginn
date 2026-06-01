#!/usr/bin/env bun
// End-to-end smoke test for the Huginn server.
// Drives setup → scan → report download → assertions through the HTTP API.
//
// Usage:
//   bun run scripts/e2e-smoke.ts
//
// Env:
//   BASE_URL          server URL (default http://localhost:3000)
//   SCAN_FOLDER       absolute path inside the container to scan (default = server's DOCUMENTS_ROOT)
//   PREFER_MODEL      model id to install if setup is needed (default: smallest ranked candidate)
//   SETUP_TIMEOUT_MS  default 600_000 (10 min — model pull can be slow on cold cache)
//   SCAN_TIMEOUT_MS   default 1_800_000 (30 min — large corpora + LLM phases)
//
// Exit codes:
//   0   smoke passed
//   1   server unreachable / setup failed / scan failed
//   2   report missing expected fields (chunkQuality, parsed[])

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const SCAN_FOLDER = process.env.SCAN_FOLDER ?? null;
const PREFER_MODEL = process.env.PREFER_MODEL ?? null;
const SETUP_TIMEOUT_MS = Number(process.env.SETUP_TIMEOUT_MS ?? 600_000);
const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS ?? 1_800_000);

function log(msg: string, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  console.log(extra ? `[${ts}] ${msg} ${JSON.stringify(extra)}` : `[${ts}] ${msg}`);
}

function fail(reason: string, code = 1): never {
  log(`FAIL: ${reason}`);
  process.exit(code);
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) fail(`GET ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`POST ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function waitForServer(deadlineMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await Bun.sleep(2_000);
  }
  fail(`server did not respond at ${BASE_URL}/api/health within ${deadlineMs}ms`);
}

// Consume the SSE stream from /api/status until a predicate matches an event or timeout expires.
async function waitForSseEvent(
  predicate: (ev: { type: string; [k: string]: unknown }) => boolean,
  timeoutMs: number,
  onEvent?: (ev: { type: string; [k: string]: unknown }) => void,
): Promise<{ type: string; [k: string]: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/api/status`, { signal: ctrl.signal });
    if (!res.ok || !res.body) fail(`SSE /api/status → ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) fail("SSE stream ended before matching event");
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          let ev: { type: string; [k: string]: unknown };
          try {
            ev = JSON.parse(payload);
          } catch {
            continue;
          }
          if (onEvent) onEvent(ev);
          if (predicate(ev)) {
            ctrl.abort();
            return ev;
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

type SetupStatus = {
  state: "ready" | "needsSetup";
  installedChatModel: string | null;
  activePull: { modelId: string; completedBytes: number; totalBytes: number; status: string } | null;
};

type Recommendation = {
  detected: Record<string, unknown>;
  candidates: Array<{ id: string; sizeBytes?: number; rank?: number }>;
};

async function ensureChatModelInstalled(): Promise<string> {
  const status = await getJson<SetupStatus>("/api/setup/status");
  if (status.state === "ready" && status.installedChatModel) {
    log(`chat model already installed`, { model: status.installedChatModel });
    return status.installedChatModel;
  }
  const rec = await getJson<Recommendation>("/api/setup/recommendation");
  if (rec.candidates.length === 0) fail("no candidate models returned by /api/setup/recommendation");

  let modelId = PREFER_MODEL ?? rec.candidates[0]!.id;
  if (PREFER_MODEL && !rec.candidates.some(c => c.id === PREFER_MODEL)) {
    log(`WARNING: PREFER_MODEL=${PREFER_MODEL} not in catalog; using first candidate ${rec.candidates[0]!.id}`);
    modelId = rec.candidates[0]!.id;
  }

  log(`installing chat model`, { modelId });
  const install = await postJson<{ status: string; modelId: string }>("/api/setup/install", { modelId });
  if (install.status !== "started" && install.status !== "already_running") {
    fail(`unexpected setup install response: ${JSON.stringify(install)}`);
  }

  // Poll setup/status until ready (the SSE stream also emits model_install_* events;
  // polling is simpler and good enough for a smoke test).
  const deadline = Date.now() + SETUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const s = await getJson<SetupStatus>("/api/setup/status");
    if (s.state === "ready" && s.installedChatModel) {
      log(`chat model installed`, { model: s.installedChatModel });
      return s.installedChatModel;
    }
    if (s.activePull) {
      const pct = s.activePull.totalBytes > 0
        ? ((s.activePull.completedBytes / s.activePull.totalBytes) * 100).toFixed(1)
        : "?";
      log(`pull progress`, { modelId: s.activePull.modelId, status: s.activePull.status, pct });
    }
    await Bun.sleep(5_000);
  }
  fail(`model install did not complete within ${SETUP_TIMEOUT_MS}ms`);
}

async function runScan(): Promise<{ scanId: string; reports: string[] }> {
  const body: { folder?: string } = SCAN_FOLDER ? { folder: SCAN_FOLDER } : {};
  log(`POST /api/scan`, body);
  const { scanId } = await postJson<{ scanId: string }>("/api/scan", body);
  log(`scan started`, { scanId });

  const ev = await waitForSseEvent(
    e => e.type === "scan_complete" || e.type === "scan_error",
    SCAN_TIMEOUT_MS,
    e => {
      if (e.type === "phase_start" || e.type === "phase_end" || e.type === "scan_progress") {
        log(`scan event`, e);
      }
    },
  );

  if (ev.type === "scan_error") {
    fail(`pipeline failed: phase=${ev.phase} message=${ev.message}`);
  }
  const reports = (ev as { reports?: string[] }).reports ?? [];
  if (reports.length === 0) fail(`scan_complete emitted no report files`);
  log(`scan complete`, { scanId, reports });
  return { scanId, reports };
}

type ReportSummary = {
  scanId: string;
  parsed?: Array<{ id: string; filename: string; charCount?: number; tokenCountEstimate?: number; parserUsed?: string }>;
  chunkQuality?: { perDoc?: unknown[]; corpus?: { totalChunks?: number } };
};

async function fetchReport(filename: string): Promise<ReportSummary> {
  const res = await fetch(`${BASE_URL}/api/reports/${encodeURIComponent(filename)}`);
  if (!res.ok) fail(`GET /api/reports/${filename} → ${res.status}`);
  return (await res.json()) as ReportSummary;
}

function assertReport(rep: ReportSummary): void {
  const parsed = rep.parsed ?? [];
  if (parsed.length === 0) fail(`report has no parsed[] entries`, 2);
  const pdfDocs = parsed.filter(p => p.filename.toLowerCase().endsWith(".pdf"));
  const pdfWithText = pdfDocs.filter(p => (p.charCount ?? 0) > 0);
  log(`parsed docs`, { total: parsed.length, pdfs: pdfDocs.length, pdfsWithText: pdfWithText.length });

  if (pdfDocs.length > 0 && pdfWithText.length === 0) {
    fail(`all PDFs parsed to empty text — native PDF parser likely broken`, 2);
  }

  const cq = rep.chunkQuality;
  if (!cq || !cq.perDoc || cq.perDoc.length === 0) {
    fail(`report has no chunkQuality.perDoc entries — chunk-quality phase did not run`, 2);
  }
  log(`chunkQuality`, { perDoc: cq.perDoc.length, totalChunks: cq.corpus?.totalChunks ?? "?" });
}

async function main(): Promise<void> {
  log(`huginn e2e smoke against ${BASE_URL}`);
  await waitForServer(60_000);
  await ensureChatModelInstalled();
  const { reports } = await runScan();
  const jsonReport = reports.find(r => r.endsWith(".json"));
  if (!jsonReport) fail(`no .json report in ${JSON.stringify(reports)}`);
  const rep = await fetchReport(jsonReport.replace(/^.*\//, ""));
  assertReport(rep);
  log(`PASS`);
}

main().catch(e => {
  fail(`uncaught: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
});
