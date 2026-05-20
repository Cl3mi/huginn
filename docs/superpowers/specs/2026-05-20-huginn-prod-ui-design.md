# Huginn Production UI — Design Spec

**Date:** 2026-05-20  
**Branch:** feat/phase9-ingestion-projection (base for next feature branch)  
**Goal:** Ship Huginn as a single `docker compose up` command with a browser UI for folder selection and pipeline progress, delivered privately as a Docker image to clients.

---

## 1. Scope

This spec covers the addition of a **web UI and HTTP server** to the Huginn scanner. It does not cover authentication, scan history persistence, an in-UI report viewer, or multi-user support.

Out of scope items deferred intentionally:
- Auth (private single-client delivery assumed)
- Scan history (reports are files; no DB)
- Report rendering in-browser (download links only)
- Multi-scan concurrency (one scan at a time)

---

## 2. Deployment Model

**Single `docker compose up` command.** The existing `docker-compose.yml` gains one change: the `scanner` service exposes port 3000 and runs in server mode instead of exiting after one run.

The client workflow:
1. `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d`
2. Open `http://localhost:3000` in a browser
3. Select folder, configure settings, click Start Scan
4. Watch progress live
5. Download reports when done

GPU (NVIDIA Container Toolkit) is required. The existing `docker-compose.gpu.yml` override is unchanged.

The `scanner` Docker image (`Dockerfile.scanner`) requires no changes — the server mode is a TypeScript-level change only.

---

## 3. Architecture

### 3.1 Scanner process: run-once → server mode

`src/index.ts` is replaced by a server entry point. The pipeline is extracted into a callable function rather than running at process start.

The HTTP server uses `Bun.serve()` natively — no additional web framework dependency. Five routes are handled with a simple `switch` on `request.url`. No `Hono` or `express` needed.

```
src/
  server/
    index.ts           ← HTTP server entry, health checks on startup, serves UI
    routes.ts          ← API route handlers (browse, scan, status, reports)
    sse.ts             ← Server-Sent Events broadcaster
    folder-browser.ts  ← Recursive directory listing for /api/browse
  ui/
    index.html         ← Single-page app (vanilla JS, self-contained, no build step)
  phases/              ← unchanged
  pipeline.ts          ← extracted from old index.ts: runPipeline(config) → void
  index.ts             ← entry point: import './server'
```

`pipeline.ts` wraps the existing phase sequence. It accepts a `PipelineConfig` (folder path + scan settings) and calls phases in order, emitting progress events via `sse.ts` as it goes.

### 3.2 API surface

Five endpoints, all served by the scanner container on port 3000:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves `ui/index.html` |
| `GET` | `/api/health` | Returns status of Tika + Ollama + scanner readiness |
| `GET` | `/api/browse?path=<path>` | Returns folder tree JSON for the path browser |
| `POST` | `/api/scan` | Starts a scan; body: `{folder: string, settings: ScanSettings}`; returns `{scanId}` or 409 if busy |
| `GET` | `/api/status` | SSE stream — phase progress + log lines for the active scan |
| `GET` | `/api/reports/:filename` | Streams a completed report file for download |

`ScanSettings`:
```typescript
interface ScanSettings {
  embedModel: string;       // default: "nomic-embed-text"
  chatModel: string;        // default: "llama3.1:8b"
  llmSampleRate: number;    // default: 0.05
  sectionEmbeddings: boolean; // default: false
}
```

### 3.3 Progress streaming (SSE)

The existing `logger` is extended with a progress hook. `sse.ts` maintains a list of connected SSE clients and broadcasts events. The pipeline calls `progress.emit(event)` at phase transitions and for WARN/ERROR log lines.

SSE event shapes (`phaseIndex` is execution order 0–8, not the phase number, since phase 9 runs second):
```jsonc
{"type":"phase_start",    "phase":"4-cluster",  "phaseIndex":4, "totalPhases":9}
{"type":"phase_end",      "phase":"4-cluster",  "durationMs":92140}
{"type":"log",            "level":"INFO"|"WARN"|"ERROR", "phase":"4-cluster", "message":"..."}
{"type":"scan_complete",  "scanId":"scan-xxx",  "reports":["scan-report-xxx.json","..."]}
{"type":"scan_error",     "phase":"4-cluster",  "message":"..."}
```

State lives in memory for the active scan only. No database is required.

### 3.4 Folder browser

`GET /api/browse?path=/documents` returns:
```jsonc
{
  "path": "/documents",
  "entries": [
    {"name": "project-alpha", "type": "dir", "fileCount": 31},
    {"name": "project-beta",  "type": "dir", "fileCount": 12}
  ]
}
```

The server enforces that browseable paths must be within `/documents` (the mounted volume root) — no path traversal outside that directory.

---

## 4. UI Design

Single-page app, no framework, no build step. All HTML/CSS/JS in `src/ui/index.html`. The server serves it statically. The UI uses vanilla `fetch` and `EventSource` for SSE.

Visual design matches Muninn's design system exactly:
- Colors: `--bg-base: #141517`, `--accent: #da291c`, surface/elevated/border tokens
- Typography: Barlow Condensed (headings), IBM Plex Sans (body), IBM Plex Mono (paths/code) — loaded from Google Fonts CDN
- Border radius: 4px
- Component patterns: same card, badge, button, alert, and table styles as Muninn

### 4.1 Setup screen

Two-column layout (1fr / 340px), max-width 1000px, centered:

**Left column:**
- Page title "New Scan" + subtitle
- **Documents Folder card**: path text input + Browse button + interactive folder tree (file counts per folder)
- Start Scan button (disabled if system unhealthy or no folder selected) + file count readout

**Right column:**
- **System Status card**: Tika health, Ollama chat model health, Ollama embed model health — live dots (green/red)
- **Scan Settings card**: embed model selector, chat model selector, LLM sample rate selector, section embeddings toggle

### 4.2 Progress screen

Same two-column layout:

**Left column:**
- Page title "Scan in Progress" + scan ID + elapsed timer
- **Pipeline Phases card**: progress bar (N of 9) + phase list — done (✓), running (spinner), pending (dimmed)
- **Live Log card**: scrolling log box (last ~50 lines), mono font, colour-coded by level (INFO/WARN/ERROR)

**Right column:**
- **Live Stats card**: files found, parsed, pairs scored, version pairs, references, requirements — populated as phases complete
- **Scan Info card**: folder, scan ID, start time, model config
- Abort Scan button (ghost/danger style, hover turns red border)

### 4.3 Completion screen

Same two-column layout:

**Left column:**
- Page title "Scan Complete" + duration
- **Data Quality Score card**: score/100 with mini progress bars per component (parse success, heading extraction, LLM validation, OCR coverage). Border-top uses `--success` green when score ≥ 80.
- **Summary card**: 6 key stats in a 3-column grid (files, parsed, failed, version pairs, references, requirements) + any warnings (e.g. parse failures)
- **Download Reports card**: three download rows — HTML Dashboard, Markdown Report, JSON Data — each showing file size

**Right column:**
- **Pipeline Complete card**: all 9 phases with ✓ and individual durations
- **Scan Info card**: folder, scan ID, start/end times, duration
- New Scan button (red primary, resets UI to setup screen)

### 4.4 Error state

If `scan_error` is received via SSE, the progress screen transitions to an error state:
- Phase list freezes at the failed phase (shows ✗ in red)
- Log box stays visible showing last lines
- Alert banner: "Phase X failed — see log above"
- If a partial report was written, download links still appear for whatever was generated

---

## 5. Error Handling

| Scenario | Behaviour |
|----------|-----------|
| `/api/health` polling | UI calls it on load and every 10s while on setup screen; status dots update live |
| Tika unreachable at startup | Setup screen: red dot for Tika; PDF parsing skipped warning shown; scan still allowed (existing graceful skip) |
| Ollama unreachable at startup | Setup screen: red dot for Ollama; Start Scan button disabled; error message shown |
| Folder path not found | `POST /api/scan` returns 400; UI shows inline error on path field |
| Folder contains zero supported files | `POST /api/scan` returns 400 with reason; UI shows inline error |
| Phase throws during scan | SSE emits `scan_error`; UI shows error state; partial report downloadable if written |
| Second scan requested while one running | `POST /api/scan` returns 409; UI shows "Scan already running" toast |
| Path traversal attempt in browser | `/api/browse` returns 403 for paths outside `/documents` |

---

## 6. Docker Compose changes

`docker-compose.yml` scanner service diff:

```yaml
scanner:
  # ... existing build, depends_on, volumes unchanged ...
  ports:
    - "3000:3000"          # ← new
  environment:
    - HUGINN_SERVER_PORT=3000   # ← new
    # ... existing env vars unchanged ...
  command: bun run src/index.ts  # unchanged — now starts server mode
  restart: unless-stopped        # ← changed from no restart
```

The `scanner` service no longer exits after one run; it stays up until `docker compose down`.

---

## 7. Config additions (`src/config.ts`)

Two new config keys:

```typescript
serverPort: parseInt(process.env["HUGINN_SERVER_PORT"] || "3000", 10),
documentsRoot: process.env["DOCUMENTS_ROOT"] || "/documents",  // already exists
```

The `documentsRoot` value is used as the browse root — the folder browser cannot escape it.

---

## 8. Non-goals / explicit exclusions

- No authentication or access control
- No persistent scan history (no database)
- No in-browser report rendering (download only)
- No WebSocket — SSE is sufficient for one-directional progress streaming
- No React/Svelte/Vue — vanilla JS only, no build pipeline for the UI
- No changes to the Dockerfile
- No changes to the pipeline phases themselves
- No Windows support for the client host (NVIDIA GPU runtime is Linux only)
