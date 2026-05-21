# Model Setup & Hardware-Adaptive LLM Selection — Design Spec

**Date:** 2026-05-21
**Goal:** Replace the hardcoded `ollama-init` model pull with an in-UI first-boot wizard that detects host hardware, recommends an appropriate chat model from a curated catalog, downloads it on demand, and lets the user swap models later from a Settings page.

---

## 1. Scope

This spec covers a new model-setup flow that becomes the single way Huginn acquires its chat model. It is in scope to remove the `ollama-init` service and to add hardware probing, model catalog, model installer, and the corresponding UI surfaces.

**In scope:**
- Removal of `ollama-init` compose service
- Hardware probe (NVIDIA-first; CPU fallback) inside the scanner container
- Curated model catalog with relevance ranking
- First-boot setup wizard in the UI
- Persistent "Settings → Model" page for swapping models later
- Pull-progress streaming over SSE
- Auto-recovery on container recreation when Ollama already has a known catalog model installed

**Out of scope:**
- Swapping the embedding model (kept fixed; auto-pulled in background)
- Bench-marking models against the customer's actual document corpus
- Telemetry / phone-home of selected models
- Multi-language model picker UX (catalog metadata is English-only)
- Air-gapped first-boot (Ollama's model pull requires internet, same as today)
- Non-NVIDIA GPU detection (AMD/ROCm/Apple Silicon under Docker fall back to CPU)

---

## 2. Motivation

The current setup ships a single hardcoded chat model (`llama3.1:8b`, ~5 GB) via the `ollama-init` service. This is a poor turnkey UX for two reasons:

1. **One-size-fits-none.** Hosts vary from CPU-only laptops to multi-GPU workstations with 140 GB+ VRAM. A fixed 8B model is too slow on the small end and leaves quality on the table on the big end.
2. **No feedback during pull.** `ollama-init` runs silently in the background. On slow connections the customer sees nothing happening for 10+ minutes, no progress, no indication of what's being downloaded.

Replacing this with an in-UI flow gives:
- An appropriate model for the actual hardware (small model on CPU host, large model on big-GPU host)
- Visible progress during download
- A path to swap models later without touching the compose file or the container

The customer's manual workflow does not change: they still download `docker-compose.yml` (and optionally `docker-compose.gpu.yml`) and run `docker compose up`. The setup wizard appears once in the browser on first visit.

---

## 3. Deployment Model

### 3.1 Compose files

- `docker-compose.yml` — primary; works on every host as CPU-only.
- `docker-compose.gpu.yml` — override; **kept**; adds NVIDIA GPU access to the `ollama` and `scanner` services (the scanner gains GPU device visibility solely so `nvidia-smi` can report VRAM during the hardware probe).

### 3.2 Removed services

- `ollama-init` is deleted from `docker-compose.yml`. Models are no longer pre-pulled at compose time. The `ollama_data` named volume is unchanged.

### 3.3 Customer workflow after change

CPU host:
```
docker compose up
```

NVIDIA GPU host:
```
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up
```

In both cases, the customer then opens `http://localhost:3000` and is presented with the first-boot setup card. After the model installs, they proceed to the normal scan UI.

---

## 4. Architecture

### 4.1 Process states

The scanner process now has three relevant states:

| State | Trigger | UI response |
|---|---|---|
| `bootstrapping` | Ollama health check in progress | UI shows "Connecting to Ollama..." |
| `needsSetup` | Ollama healthy, but no catalog chat model installed and no `setup.json` | UI renders the setup wizard |
| `ready` | A catalog chat model is installed and recorded in `setup.json` | UI renders the normal scan flow |

The Ollama-unreachable hard-gate behavior is preserved: if Ollama cannot be reached at startup, the scanner still exits with code 1.

### 4.2 New / changed files

```
src/llm/
  model-catalog.ts          # NEW - hardcoded catalog of chat models
  model-fit.ts              # NEW - hardware probe + fit ranking
  model-installer.ts        # NEW - streamed pull from Ollama, progress events
  ollama.ts                 # CHANGED - reads OLLAMA_CHAT_MODEL from setup state, not env

src/server/
  setup-state.ts            # NEW - reads/writes /app/state/setup.json, in-memory cache
  routes.ts                 # CHANGED - adds /api/setup/* endpoints
  sse.ts                    # CHANGED - adds model-install-progress channel

src/ui/
  index.html                # CHANGED - first-boot card, Settings model panel,
                            #           install progress indicator

src/index.ts                # CHANGED - no abort when chat model missing;
                            #           enters needsSetup state instead

docker-compose.yml          # CHANGED - remove ollama-init service
docker-compose.gpu.yml      # CHANGED - add GPU device visibility for scanner
                            #           (so nvidia-smi works inside the container)
Dockerfile.scanner          # UNCHANGED
```

### 4.3 Persistent state

`setup.json` is written to `/app/state/setup.json` inside the scanner container. **No new mount or volume is added.** When the container is recreated, `setup.json` is wiped.

Auto-recovery handles this: on startup, if `setup.json` is missing, the scanner calls Ollama `/api/tags`. If any catalog model is already installed (via the persistent `ollama_data` named volume), the scanner selects the largest `huginnValidated` entry from that intersection, writes a fresh `setup.json`, and transitions directly to `ready` — the wizard does not appear.

The wizard appears exactly once per customer install, even across `docker compose down && up` cycles. It only reappears if the user explicitly removes the `ollama_data` volume.

### 4.4 Data shapes

```ts
// src/llm/model-catalog.ts
type CatalogEntry = {
  id: string;              // Ollama model ID, e.g. "llama3.1:8b"
  displayName: string;
  family: "llama" | "qwen" | "gemma" | "phi" | "mixtral";
  parameterSize: string;   // "8B", "70B", "8x22B"
  quantization: string;    // "Q4", "FP16"
  downloadSizeBytes: number;
  minVramGb: number;       // 0 means CPU-viable
  huginnValidated: boolean;
  notes: string;           // <= 120 chars per Huginn project convention
};

// src/llm/model-fit.ts
type DetectedHardware = {
  gpuAvailable: boolean;
  vramGb: number;          // 0 if no GPU detected
  detectionMethod: "nvidia-smi" | "cpu-fallback";
  rawProbeOutput: string;  // for diagnostics, <= 120 chars
};

type FitReport = {
  detected: DetectedHardware;
  candidates: Array<CatalogEntry & {
    fits: boolean;
    recommended: boolean;
    relevanceScore: number;
  }>;
};

// src/server/setup-state.ts -> /app/state/setup.json
type SetupState = {
  schemaVersion: 1;
  installedChatModel: string | null;
  installedAt: string | null;       // ISO timestamp
  fitReportAtInstall: FitReport | null;
};
```

### 4.5 HTTP / SSE surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/setup/status` | Returns `{ state: "needsSetup" \| "ready", installedChatModel? }` |
| GET | `/api/setup/recommendation` | Runs probe + fit, returns `FitReport` with top 10 candidates by relevance |
| POST | `/api/setup/install` | Body `{ modelId }`; starts a pull. Idempotent: if a pull for that model is already in progress, returns the existing job ID |
| GET | `/api/setup/install-progress` | SSE stream emitting `{ status, completedBytes, totalBytes, error? }` events for the active pull |
| POST | `/api/setup/cancel` | Cancels an in-progress pull (graceful — Ollama itself will keep partial blobs but the scanner stops reporting) |

The scan-related endpoints from the existing prod-UI spec remain unchanged; they simply refuse to start a scan if `state !== "ready"`.

---

## 5. Hardware Probe

### 5.1 Mechanism

Inside the scanner container, run:

```bash
nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits
```

- Exit code 0 with numeric output → parse as MiB, convert to GB, set `gpuAvailable: true`, `detectionMethod: "nvidia-smi"`.
- Non-zero exit or missing binary → set `gpuAvailable: false`, `vramGb: 0`, `detectionMethod: "cpu-fallback"`.

If the host has multiple GPUs, `nvidia-smi` returns one line per GPU. We use the **smallest** GPU's VRAM (conservative — Ollama may not be able to split a model across GPUs reliably).

### 5.2 Why no probe model

An earlier iteration considered pulling a small chat model (`tinyllama:1.1b`) just to query `/api/ps` for VRAM. That was discarded: it adds a 640 MB disk hit on a setup the user may abandon, takes 30+ seconds on slow networks, and gives less precise data than `nvidia-smi` (which reports total VRAM, not just what a particular model needs).

### 5.3 Edge cases

| Scenario | Probe result | Recommendation behavior |
|---|---|---|
| NVIDIA GPU, GPU compose override applied | `vramGb: <actual>` | Recommend largest validated model that fits with 15% safety margin |
| NVIDIA GPU host, but user forgot GPU override | `vramGb: 0` | Recommend small model; user can re-run setup from Settings after fixing compose |
| CPU-only host | `vramGb: 0` | Recommend small CPU-viable model with "may be slow" note |
| AMD ROCm / Apple Silicon under Docker | `vramGb: 0` | Same as CPU fallback (Ollama does not pass GPU through to Docker on these platforms) |
| Multi-GPU NVIDIA | smallest GPU's VRAM | Conservative fit |

---

## 6. Model Catalog

### 6.1 Initial entries

The catalog ships in `src/llm/model-catalog.ts` with the following entries:

| ID | Params | Quant | Download (GB) | Min VRAM (GB) | Validated | Notes |
|---|---|---|---|---|---|---|
| `llama3.2:1b` | 1B | Q4 | 1.3 | 0 | yes | Smallest, fast on weak hardware |
| `llama3.2:3b` | 3B | Q4 | 2.0 | 0 | yes | CPU fallback, decent quality |
| `phi3:mini` | 3.8B | Q4 | 2.3 | 0 | yes | Strong structured output for size |
| `qwen2.5:7b` | 7B | Q4 | 4.4 | 5 | yes | Strong JSON adherence |
| `llama3.1:8b` | 8B | Q4 | 4.7 | 6 | yes | Prior default, broadly safe |
| `gemma2:9b` | 9B | Q4 | 5.5 | 7 | yes | Strong narrative quality |
| `qwen2.5:14b` | 14B | Q4 | 8.4 | 10 | yes | Sweet spot for prosumer GPUs |
| `qwen2.5:32b` | 32B | Q4 | 19 | 22 | no | Good mid-range |
| `mixtral:8x7b` | 47B (MoE) | Q4 | 26 | 28 | no | Fast inference for size |
| `llama3.3:70b` | 70B | Q4 | 40 | 45 | no | Datacenter-grade quality |
| `qwen2.5:72b` | 72B | Q4 | 41 | 46 | no | Best small-batch quality |
| `mixtral:8x22b` | 141B (MoE) | Q4 | 80 | 88 | no | High-end MoE |
| `llama3.3:70b-fp16` | 70B | FP16 | 140 | 145 | no | Full precision, max quality |

`huginnValidated: true` means Huginn's prompts (`src/llm/prompts.ts`) have been smoke-tested with this model and yield well-formed JSON / coherent narrative. Untested entries are listed for users with large hardware but only validated entries can be the system's *recommended* pick. The UI displays an "untested with Huginn" badge on un-validated entries.

### 6.2 Catalog tests

Each catalog entry is unit-tested for:
- Unique `id`
- `notes` length <= 120 chars (Huginn project convention)
- Monotonic ordering by `downloadSizeBytes`
- `minVramGb` is either 0 or >= `parameterSize * 0.7` (sanity check against typo errors)

### 6.3 Updating the catalog

Catalog updates require a new Huginn release. There is no runtime catalog refresh from `ollama.com`. This is deliberate: the project is offline-first for everything except the initial model pull, and a runtime registry query introduces unpredictable model behavior that could silently break Phase 6 (LLM validation) or Phase 8 (narrative).

---

## 7. Fit Ranking

### 7.1 Fit predicate

```
entry.fits = (entry.minVramGb === 0)
          || (entry.minVramGb <= detected.vramGb * 0.85)   // 15% safety margin
```

The 15% margin reserves headroom for OS overhead, Ollama's runtime allocation patterns, and parallel host processes.

### 7.2 Recommendation pick

Among `fits === true` entries:
- If at least one `huginnValidated` entry fits, recommend the **largest validated** entry.
- Otherwise recommend the smallest validated entry (degraded but safe).

This biases toward quality without ever recommending an unvalidated model as a default.

### 7.3 Relevance ranking (top 10 in UI)

The UI shows at most 10 entries, ordered:

1. **Recommended** (always first)
2. **Other fitting validated entries**, descending by `parameterSize`
3. **Fitting un-validated entries**, descending by `parameterSize` (badged "untested")
4. **The single smallest non-fitting validated entry**, badged "needs more VRAM" — informs the user what's just out of reach without flooding the list
5. Remaining entries are omitted from the default top-10 but reachable via a "Show all models" expander (advanced)

This gives the user a focused list while preserving the option to override.

---

## 8. UI Surfaces

### 8.1 First-boot setup wizard

Triggered when `GET /api/setup/status` returns `state: "needsSetup"`.

Single card centered on the page:

```
+---------------------------------------------------------------+
| Setting up Huginn                                             |
|                                                               |
| Detected hardware: NVIDIA GPU, 8 GB VRAM                      |
|                                                               |
| Recommended model: Llama 3.1 8B (4.7 GB download)             |
| Sweet spot for your hardware. Prior default in Huginn.        |
|                                                               |
|              [  Install and continue  ]                       |
|                                                               |
|              [ Show alternatives ]                            |
+---------------------------------------------------------------+
```

"Show alternatives" expands the card into a vertically scrollable list of the 9 other ranked candidates. Each row shows: display name, download size, min VRAM, "untested with Huginn" badge if applicable, and a small Install button.

During pull, the card replaces the buttons with a progress bar:

```
+---------------------------------------------------------------+
| Downloading Llama 3.1 8B...                                   |
|                                                               |
|  [################------------------]  42%                    |
|  1.97 GB / 4.70 GB                                            |
|                                                               |
|              [ Cancel ]                                       |
+---------------------------------------------------------------+
```

On completion, the card disappears and the UI navigates to the normal scan flow.

### 8.2 Settings → Model page

Always available once setup is complete, via a "Settings" link in the UI header.

Layout:
- "Currently installed: <model name> (installed <date>)"
- "Detected hardware: <summary>" (re-runs probe on page open)
- Full top-10 list, same as the wizard, with the currently-installed entry visually marked
- Per-row Install button for any model not currently active
- "Make active" button for any model that's already installed (no pull needed, just rebind)

Switching the active model:
1. If the target model is already in Ollama (`/api/tags`), just update `setup.json` and rebind `CONFIG.ollamaChatModel` in-process. No pull.
2. If not present, run the install flow, then rebind.

### 8.3 Progress streaming

The install card subscribes to `/api/setup/install-progress` (SSE). Events:

```ts
type InstallEvent =
  | { type: "pull-started"; modelId: string; totalBytes: number }
  | { type: "pull-progress"; completedBytes: number; totalBytes: number }
  | { type: "pull-complete"; modelId: string }
  | { type: "pull-error"; message: string };   // message <= 120 chars
```

The scanner subscribes to Ollama's `/api/pull` streaming response on the server side and re-emits a throttled (~ every 500 ms) progress event to all connected SSE clients. Multiple browser tabs see the same progress.

---

## 9. Error Paths

| Failure | Detection | UI response |
|---|---|---|
| Ollama unreachable at scanner startup | `checkOllamaHealth()` returns ok=false | Scanner exits with code 1 (unchanged from today) |
| Ollama goes down mid-pull | SSE stream from Ollama errors | Emit `pull-error`, UI shows error + Retry button |
| No internet on first boot | Ollama's `/api/pull` returns network error | Same `pull-error` path with "Check internet connection" hint |
| Disk full mid-pull | Ollama returns 500 with disk error | Same `pull-error` path with disk-full hint |
| `nvidia-smi` present but errors | Probe falls back to CPU mode | No UI error; recommendation is conservative |
| User closes browser mid-pull | Server-side pull continues | Reconnecting UI resumes the SSE stream |
| User picks an un-validated model | None — allowed | "untested with Huginn" badge remains visible after install |
| User selects model that exceeds host VRAM | Allowed (user override) | Install completes; first scan may OOM. We surface OOM at scan time with a "your selected model may be too large for this hardware" hint pointing to Settings |
| `setup.json` corrupt / unparseable | JSON.parse throws on startup | Log warning, delete `setup.json`, re-run auto-recovery |

---

## 10. Testing

### 10.1 Unit tests (new — Bun test runner)

- `src/llm/model-catalog.test.ts` — catalog invariants from section 6.2
- `src/llm/model-fit.test.ts` — fit predicate and recommendation pick against synthetic `DetectedHardware` inputs (CPU-only, 4 GB, 8 GB, 24 GB, 80 GB, 140 GB)
- `src/llm/model-fit.probe.test.ts` — probe parsing for representative `nvidia-smi` outputs (single GPU, multi-GPU, error output, missing binary mocked via PATH override)
- `src/server/setup-state.test.ts` — read/write round-trip, corrupt-file recovery, auto-recovery from Ollama tags

### 10.2 Smoke tests (manual, documented in spec)

1. **Fresh install on CPU host:** main compose file only. Verify wizard appears, probe reports CPU, recommendation is `llama3.2:3b` or smaller, install completes, scan runs.
2. **Fresh install on GPU host with override:** verify probe reports correct VRAM, recommendation matches expected tier.
3. **Container restart with `ollama_data` intact:** verify wizard does NOT appear, scanner auto-recovers chat model from Ollama's installed list.
4. **Container restart with `ollama_data` wiped:** verify wizard reappears as on fresh install.
5. **Mid-pull tab close:** close browser during pull, reopen, verify progress resumes.
6. **Model swap from Settings:** install a second model, switch active, run a scan, verify the new model is used (check log lines).

### 10.3 Regex test suite

The startup `runRegexTests()` gate is unaffected by this change.

---

## 11. Constraints & Conventions

- All strings flowing into `setup.json` or any API response are clamped to <= 120 chars per the `maxStringLengthInReport` Huginn convention.
- `exactOptionalPropertyTypes: true` — use spread for optional fields in `FitReport` and `SetupState`.
- All catalog metadata is hardcoded TypeScript; no runtime catalog refresh from external sources.
- No new bind mounts or named volumes added to compose files.
- Ollama remains a hard gate at scanner startup.
- The embedding model (`nomic-embed-text`) is auto-pulled in the background the first time Phase 3 requests an embedding; never user-visible.

---

## 12. Open Questions / Deferred

- **Multi-GPU split inference:** currently we use the smallest GPU's VRAM and pick a single-GPU model. If multi-GPU model sharding becomes important, the fit logic and catalog will need extension (per-entry `multiGpuCapable` flag, sum-of-VRAM consideration).
- **Telemetry of selected models:** would be useful for tuning the catalog but adds a network egress the offline-first ethos prohibits. Deferred.
- **Validation of additional catalog entries:** the `huginnValidated: false` entries should be validated and the flag flipped in a follow-up PR after manual smoke tests.
- **Air-gapped install path:** today's customer needs internet on first boot to pull the model. A pre-baked image with a model included is a separate feature.
