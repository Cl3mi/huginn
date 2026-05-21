import { join, resolve } from "path";
import { readdirSync, readFileSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { CONFIG } from "../config.ts";
import { broadcaster } from "./sse.ts";
import type { SseEvent } from "./sse.ts";
import { browseFolder, FolderBrowseError } from "./folder-browser.ts";
import { healthState } from "./health-state.ts";
import { runPipeline } from "../pipeline.ts";
import type { ScanSettings } from "../pipeline.ts";
import { buildZip } from "./zip.ts";
import { CATALOG } from "../llm/model-catalog.ts";
import { probeHardware, rankCatalog } from "../llm/model-fit.ts";
import { pullModel, type PullController } from "../llm/model-installer.ts";
import { setupHolder, applySetupState } from "./setup-state.ts";

type ActivePull = {
  modelId: string;
  controller: PullController;
  totalBytes: number;
  completedBytes: number;
  lastEvent: "started" | "progress" | "complete" | "error";
  lastError?: string;
};

let activePull: ActivePull | null = null;

type ScanState =
  | { status: "idle" }
  | { status: "running"; scanId: string; startedAt: Date; folder: string }
  | { status: "complete"; scanId: string; reportFiles: string[] }
  | { status: "error"; scanId: string; phase: string; message: string };

let scanState: ScanState = { status: "idle" };

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

function handleHealth(): Response {
  return json({
    tikaOk: healthState.tikaOk,
    ollamaOk: healthState.ollamaOk,
    modelsAvailable: healthState.modelsAvailable,
    scanStatus: scanState.status,
  });
}

async function handleBrowse(url: URL): Promise<Response> {
  const requestedPath = url.searchParams.get("path") || CONFIG.documentsRoot;
  try {
    const result = await browseFolder(CONFIG.documentsRoot, requestedPath);
    return json(result);
  } catch (e) {
    if (e instanceof FolderBrowseError) return json({ error: e.message }, e.status);
    return json({ error: "Browse failed" }, 500);
  }
}

async function handleStartScan(req: Request): Promise<Response> {
  if (scanState.status === "running") {
    return json({ error: "scan_already_running", scanId: (scanState as { status: "running"; scanId: string }).scanId }, 409);
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

  const safeRoot = resolve(CONFIG.documentsRoot);
  const safeFolder = resolve(folder);
  if (safeFolder !== safeRoot && !safeFolder.startsWith(safeRoot + "/")) {
    return json({ error: "folder_outside_root" }, 400);
  }
  try {
    if (!statSync(safeFolder).isDirectory()) return json({ error: "not_a_directory" }, 400);
  } catch {
    return json({ error: "folder_not_found" }, 400);
  }

  const scanId = `scan-${Date.now()}-${randomUUID().slice(0, 8)}`;
  scanState = { status: "running", scanId, startedAt: new Date(), folder: safeFolder };

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
    if (scanState.status === "running") {
      scanState = { status: "error", scanId, phase: "unknown", message: "Pipeline failed" };
    }
  });

  return json({ scanId }, 202);
}

function handleStatus(): Response {
  const clientId = randomUUID();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<string>({
    start(controller) {
      broadcaster.add(clientId, controller);
      if (scanState.status === "complete") {
        controller.enqueue(`data: ${JSON.stringify({ type: "scan_complete", scanId: scanState.scanId, reports: scanState.reportFiles })}\n\n`);
      } else if (scanState.status === "error") {
        controller.enqueue(`data: ${JSON.stringify({ type: "scan_error", phase: scanState.phase, message: scanState.message })}\n\n`);
      }
      // SSE comment lines (start with `:`) are ignored by EventSource — pure keepalive.
      heartbeat = setInterval(() => {
        try { controller.enqueue(`: keepalive\n\n`); } catch { /* stream closed */ }
      }, 20_000);
    },
    cancel() {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
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

function handleReportDownload(filename: string): Response {
  if (filename.includes("/") || filename.includes("..")) {
    return json({ error: "Invalid filename" }, 400);
  }
  const filePath = join(CONFIG.reportOutput, filename);
  const safeReportDir = resolve(CONFIG.reportOutput);
  if (!resolve(filePath).startsWith(safeReportDir + "/") && resolve(filePath) !== safeReportDir) {
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
  return new Response(Bun.file(filePath), {
    headers: {
      "Content-Type": contentTypes[ext] ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(size),
      ...CORS,
    },
  });
}

function handleReportsZip(): Response {
  try {
    const safeReportDir = resolve(CONFIG.reportOutput);
    const names = readdirSync(CONFIG.reportOutput)
      .filter(f => /\.(json|md|html)$/.test(f))
      .sort()
      .reverse();

    const groups: Record<string, string> = {};
    for (const name of names) {
      const ext = name.split(".").pop()!;
      if (!groups[ext]) groups[ext] = name;
    }
    const selected = Object.values(groups);
    if (selected.length === 0) return json({ error: "No reports found" }, 404);

    const entries = selected.map(name => {
      const filePath = join(CONFIG.reportOutput, name);
      if (!resolve(filePath).startsWith(safeReportDir + "/")) {
        throw new Error("Forbidden path");
      }
      const data = readFileSync(filePath);
      const mtime = statSync(filePath).mtime;
      return { name, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), mtime };
    });

    const zipBytes = buildZip(entries);
    const stem = entries[0]!.name.replace(/\.[^.]+$/, "");
    const archiveName = `${stem}.zip`;

    return new Response(zipBytes, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${archiveName}"`,
        "Content-Length": String(zipBytes.length),
        ...CORS,
      },
    });
  } catch {
    return json({ error: "Could not build archive" }, 500);
  }
}

function handleListReports(): Response {
  try {
    const files = readdirSync(CONFIG.reportOutput)
      .filter(f => /\.(json|md|html|log)$/.test(f))
      .sort()
      .reverse()
      .slice(0, 20)
      .map(name => {
        try {
          return { name, size: statSync(join(CONFIG.reportOutput, name)).size };
        } catch { return { name, size: 0 }; }
      });
    return json({ files });
  } catch {
    return json({ files: [] });
  }
}

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
      try {
        applySetupState({
          schemaVersion: 1,
          installedChatModel: modelId,
          installedAt: new Date().toISOString(),
          fitReportAtInstall: null,
        });
      } catch (e) {
        tracker.lastEvent = "error";
        tracker.lastError = String(e).slice(0, 120);
        broadcaster.emit({ type: "model_install_error", modelId, message: tracker.lastError });
        return;
      }
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

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (path === "/api/health" && req.method === "GET") return handleHealth();
  if (path === "/api/browse" && req.method === "GET") return handleBrowse(url);
  if (path === "/api/scan" && req.method === "POST") return handleStartScan(req);
  if (path === "/api/status" && req.method === "GET") return handleStatus();
  if (path === "/api/reports" && req.method === "GET") return handleListReports();
  if (path === "/api/reports-zip" && req.method === "GET") return handleReportsZip();
  if (path === "/api/setup/status" && req.method === "GET") return handleSetupStatus();
  if (path === "/api/setup/recommendation" && req.method === "GET") return handleSetupRecommendation();
  if (path === "/api/setup/install" && req.method === "POST") return handleSetupInstall(req);
  if (path === "/api/setup/cancel" && req.method === "POST") return handleSetupCancel();

  const reportMatch = path.match(/^\/api\/reports\/(.+)$/);
  if (reportMatch && req.method === "GET") return handleReportDownload(reportMatch[1]!);

  if (req.method === "GET") {
    const uiPath = new URL("../ui/index.html", import.meta.url).pathname;
    return new Response(Bun.file(uiPath), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return json({ error: "Not found" }, 404);
}
