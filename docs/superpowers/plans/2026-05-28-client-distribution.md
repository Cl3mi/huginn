# Client Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Huginn to clients as a fully protected Docker image with a one-command setup script that requires no technical knowledge.

**Architecture:** The TypeScript source is bundled → obfuscated (javascript-obfuscator) → compiled to a native binary (bun build --compile), then packaged into a slim Docker image (~100 MB, zero source files) pushed to GHCR. Clients receive a ZIP with a start script, a docker-compose.yml, and a per-client `huginn.license` token. The start script handles registry login, GUI folder selection, pull, and launch with no manual steps.

**Tech Stack:** Bun, javascript-obfuscator, Docker multi-stage builds, GHCR, GitHub Actions, Bash, PowerShell 5.1+

---

## File map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `package.json` | Add `javascript-obfuscator` to devDependencies |
| Modify | `src/server/routes.ts` | Replace runtime `Bun.file(uiPath)` with static HTML import |
| New | `Dockerfile.release` | Multi-stage: bundle → obfuscate → compile → slim runtime image |
| New | `client-dist/docker-compose.yml` | Client-facing compose (GPU always on, pre-built image, reports volume) |
| New | `client-dist/start.sh` | Linux + WSL launcher: preflight, login, GUI folder picker, pull, up |
| New | `client-dist/start.ps1` | Windows launcher: same logic in PowerShell |
| New | `.github/workflows/release.yml` | CI: build Dockerfile.release, push to GHCR on every main merge |

---

### Task 1: Embed index.html at build time and add obfuscator dependency

`src/ui/index.html` is currently read from disk at runtime via `Bun.file()`. In a compiled binary there is no source filesystem, so it must be inlined at bundle time using Bun's static import. `javascript-obfuscator` also needs to be a devDependency so it is available in the Docker build stage.

**Files:**
- Modify: `package.json`
- Modify: `src/server/routes.ts:452-455`

- [ ] **Step 1: Add javascript-obfuscator as a devDependency**

Run from `/home/clemi/huginn`:
```bash
bun add -D javascript-obfuscator
```
Expected: `package.json` gains `"javascript-obfuscator"` under `devDependencies`, `bun.lock` is updated.

- [ ] **Step 2: Verify the package installed correctly**

```bash
bunx javascript-obfuscator --version
```
Expected: prints a version string like `2.x.x`.

- [ ] **Step 3: Replace the runtime file read with a static import**

In `src/server/routes.ts`, add this import at the top of the file (after the existing imports):
```ts
import uiHtml from "../ui/index.html" with { type: "text" };
```

Then replace lines 451–455:
```ts
// OLD
  if (req.method === "GET") {
    const uiPath = new URL("../ui/index.html", import.meta.url).pathname;
    return new Response(Bun.file(uiPath), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
```
with:
```ts
// NEW
  if (req.method === "GET") {
    return new Response(uiHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
```

- [ ] **Step 4: Verify the server still starts and serves the UI**

```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/server/routes.ts
git commit -m "feat(dist): embed index.html as static import for compiled binary compatibility"
```

---

### Task 2: Create Dockerfile.release

A multi-stage Dockerfile: stage 1 (builder) installs deps, bundles, obfuscates, compiles to a native binary; stage 2 (runtime) is a slim Debian image with only the binary. The final image contains no TypeScript, no `node_modules`, no source tree.

**Files:**
- New: `Dockerfile.release`

- [ ] **Step 1: Create Dockerfile.release**

Create `/home/clemi/huginn/Dockerfile.release` with this content:

```dockerfile
# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM oven/bun:1.3 AS build
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY src/ ./src/

# Bundle TypeScript + all imports (including inlined index.html) to one JS file
RUN bun build --target=bun src/index.ts --outfile dist/bundle.js

# Obfuscate: rename vars, flatten control flow, encode strings
RUN bunx javascript-obfuscator dist/bundle.js \
      --output dist/obfuscated.js \
      --compact true \
      --string-array true \
      --string-array-encoding base64 \
      --control-flow-flattening true \
      --dead-code-injection false

# Compile to a self-contained native binary (includes Bun runtime + obfuscated source)
RUN bun build --compile dist/obfuscated.js --outfile dist/huginn

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim
COPY --from=build /app/dist/huginn /huginn
CMD ["/huginn"]
```

- [ ] **Step 2: Build the image locally to verify it compiles**

```bash
docker build -f Dockerfile.release -t huginn-release-test .
```
Expected: build completes without errors. Stage 2 is ~100–150 MB.

- [ ] **Step 3: Verify no source files exist in the final image**

```bash
docker run --rm huginn-release-test find / -name "*.ts" 2>/dev/null | head
```
Expected: no output (no `.ts` files in the image).

- [ ] **Step 4: Verify the binary exists and is executable**

```bash
docker run --rm huginn-release-test ls -lh /huginn
```
Expected: output like `-rwxr-xr-x 1 root root 85M ... /huginn`

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.release
git commit -m "feat(dist): add multi-stage release Dockerfile (bundle → obfuscate → compile)"
```

---

### Task 3: Create client-dist/docker-compose.yml

The client-facing Compose file. Differences from the dev `docker-compose.yml`:
- Scanner uses `image:` pointing to GHCR (no `build:`)
- GPU (NVIDIA) always enabled for both `ollama` and `scanner`
- `huginn_reports` volume added so scan output persists across restarts
- Merges today's `docker-compose.gpu.yml` override — clients only need one file

**Files:**
- New: `client-dist/docker-compose.yml`

- [ ] **Step 1: Create the client-dist directory and docker-compose.yml**

Create `/home/clemi/huginn/client-dist/docker-compose.yml`:

```yaml
services:
  tika:
    image: apache/tika:3.0.0.0
    hostname: tika
    extra_hosts:
      - "tika:127.0.0.1"
    environment:
      - JAVA_OPTS=-Djava.net.preferIPv4Stack=true
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    hostname: ollama
    environment:
      - OLLAMA_HOST=0.0.0.0:11434
      - OLLAMA_FLASH_ATTENTION=false
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "ollama list >/dev/null 2>&1 && bash -c '</dev/tcp/127.0.0.1/11434' 2>/dev/null"]
      interval: 5s
      timeout: 5s
      retries: 12
      start_period: 30s
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]

  ollama-init:
    image: ollama/ollama:latest
    depends_on:
      ollama:
        condition: service_healthy
    environment:
      - OLLAMA_HOST=http://ollama:11434
    entrypoint: ["/bin/sh", "-c"]
    command: ["ollama pull bge-m3"]
    restart: "no"

  scanner:
    image: ghcr.io/REPLACE_WITH_YOUR_ORG/huginn:latest
    depends_on:
      tika:
        condition: service_started
      ollama:
        condition: service_healthy
      ollama-init:
        condition: service_completed_successfully
    ports:
      - "${HUGINN_PORT:-3000}:3000"
    volumes:
      - ${DOCUMENTS_PATH}:/documents:ro
      - huginn_reports:/reports
    environment:
      - TIKA_URL=http://tika:9998
      - OLLAMA_URL=http://ollama:11434
      - OLLAMA_EMBED_MODEL=bge-m3
      - DOCUMENTS_ROOT=/documents
      - REPORT_OUTPUT=/reports
      - HUGINN_SERVER_PORT=3000
    restart: unless-stopped
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]

volumes:
  ollama_data:
  huginn_reports:
```

> **Important:** Replace `REPLACE_WITH_YOUR_ORG` with your GitHub username or org name (e.g. `ghcr.io/mycompany/huginn:latest`). Do this before shipping to any client.

- [ ] **Step 2: Validate the Compose file syntax**

```bash
docker compose -f client-dist/docker-compose.yml config --quiet
```
Expected: exits 0, no errors. (Will warn about missing `DOCUMENTS_PATH` — that's expected since it's set at runtime by the start script.)

- [ ] **Step 3: Commit**

```bash
git add client-dist/docker-compose.yml
git commit -m "feat(dist): add client-facing docker-compose (GPU always on, GHCR image, reports volume)"
```

---

### Task 4: Create client-dist/start.sh

The Linux + WSL launcher. Handles preflight, registry login, GUI folder selection (with cascading fallback), saves config between runs, pulls the latest image, and starts the stack.

**Files:**
- New: `client-dist/start.sh`

- [ ] **Step 1: Create client-dist/start.sh**

Create `/home/clemi/huginn/client-dist/start.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/.huginn"

# ─── Preflight ───────────────────────────────────────────────────────────────

check_docker() {
  if ! command -v docker &>/dev/null; then
    echo ""
    echo "ERROR: Docker is not installed."
    echo "Install Docker Desktop: https://docs.docker.com/get-docker/"
    echo ""
    exit 1
  fi
  if ! docker compose version &>/dev/null 2>&1; then
    echo ""
    echo "ERROR: Docker Compose v2 is not available."
    echo "Update Docker Desktop: https://docs.docker.com/compose/install/"
    echo ""
    exit 1
  fi
}

check_nvidia() {
  if ! docker info 2>/dev/null | grep -qi "nvidia"; then
    echo "WARNING: NVIDIA Container Toolkit not detected."
    echo "         Ollama will run on CPU only (slower inference)."
    echo "         GPU guide: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
    echo ""
  fi
}

# ─── Registry login ──────────────────────────────────────────────────────────

login_registry() {
  local license_file="$SCRIPT_DIR/huginn.license"
  if [[ ! -f "$license_file" ]]; then
    echo "ERROR: huginn.license not found."
    echo "       Contact your Huginn administrator for a license file."
    exit 1
  fi
  local token
  token="$(tr -d '[:space:]' < "$license_file")"
  if ! echo "$token" | docker login ghcr.io -u huginn-client --password-stdin 2>/dev/null; then
    echo "ERROR: Registry login failed. Your license may be expired or revoked."
    echo "       Contact your Huginn administrator."
    exit 1
  fi
}

# ─── Folder picker ───────────────────────────────────────────────────────────

pick_folder_gui() {
  # zenity — GNOME / Ubuntu / Debian
  if command -v zenity &>/dev/null; then
    zenity --file-selection --directory --title="Select your documents folder" 2>/dev/null
    return 0
  fi
  # kdialog — KDE
  if command -v kdialog &>/dev/null; then
    kdialog --getexistingdirectory "$HOME" --title "Select your documents folder" 2>/dev/null
    return 0
  fi
  # WSL2 — use Windows PowerShell FolderBrowserDialog
  if command -v powershell.exe &>/dev/null; then
    powershell.exe -NoProfile -Command "
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.Application]::EnableVisualStyles()
      \$d = New-Object System.Windows.Forms.FolderBrowserDialog
      \$d.Description = 'Select your documents folder'
      \$d.RootFolder = [System.Environment+SpecialFolder]::MyComputer
      \$null = \$d.ShowDialog()
      \$d.SelectedPath
    " 2>/dev/null | tr -d '\r\n'
    return 0
  fi
  return 1
}

load_or_pick_folder() {
  # Re-use saved path if valid
  if [[ -f "$CONFIG_FILE" ]]; then
    local saved
    saved="$(grep '^DOCUMENTS_PATH=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2-)"
    if [[ -n "$saved" && -d "$saved" ]]; then
      echo "$saved"
      return
    fi
  fi

  echo "Please select the folder containing your documents."
  echo "(A folder picker window will open — check your taskbar if it does not appear in front.)"
  echo ""

  local folder
  if folder="$(pick_folder_gui 2>/dev/null)" && [[ -n "$folder" ]]; then
    : # GUI picker succeeded
  else
    read -rp "Enter the full path to your documents folder: " folder
  fi

  if [[ -z "$folder" ]]; then
    echo "ERROR: No folder selected."
    exit 1
  fi
  if [[ ! -d "$folder" ]]; then
    echo "ERROR: '$folder' is not a valid directory."
    exit 1
  fi

  echo "DOCUMENTS_PATH=$folder" > "$CONFIG_FILE"
  echo "$folder"
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo "╔══════════════════════════════════╗"
  echo "║         Huginn Scanner           ║"
  echo "╚══════════════════════════════════╝"
  echo ""

  check_docker
  check_nvidia
  login_registry

  local docs_path
  docs_path="$(load_or_pick_folder)"

  echo "Documents folder: $docs_path"
  echo ""
  echo "Pulling latest Huginn image (may take a few minutes on first run)..."
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" pull --quiet

  echo "Starting Huginn..."
  DOCUMENTS_PATH="$docs_path" docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d

  echo ""
  echo "✓ Huginn is running!"
  echo "  Open http://localhost:3000 in your browser."
  echo ""
  echo "  To stop Huginn:"
  echo "    docker compose -f '$SCRIPT_DIR/docker-compose.yml' down"
  echo ""
}

main "$@"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x client-dist/start.sh
```

- [ ] **Step 3: Run shellcheck to catch any scripting issues**

```bash
shellcheck client-dist/start.sh
```
Expected: exits 0 with no errors or warnings. If `shellcheck` is not installed: `sudo apt install shellcheck` (or skip if unavailable).

- [ ] **Step 4: Dry-run the preflight and help sections (without a real license)**

```bash
bash -n client-dist/start.sh
```
Expected: exits 0 (syntax check passes).

- [ ] **Step 5: Commit**

```bash
git add client-dist/start.sh
git commit -m "feat(dist): add start.sh — Linux/WSL launcher with GUI folder picker and registry login"
```

---

### Task 5: Create client-dist/start.ps1

The Windows PowerShell launcher for clients using Docker Desktop (non-WSL). Same logic as `start.sh` but in PowerShell with a native `FolderBrowserDialog`.

**Files:**
- New: `client-dist/start.ps1`

- [ ] **Step 1: Create client-dist/start.ps1**

Create `/home/clemi/huginn/client-dist/start.ps1`:

```powershell
#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigFile = Join-Path $ScriptDir ".huginn"

# ─── Preflight ───────────────────────────────────────────────────────────────

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host ""
        Write-Host "ERROR: Docker is not installed." -ForegroundColor Red
        Write-Host "Install Docker Desktop: https://docs.docker.com/get-docker/"
        Write-Host ""
        exit 1
    }
    $null = docker compose version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "ERROR: Docker Compose v2 is not available." -ForegroundColor Red
        Write-Host "Update Docker Desktop: https://docs.docker.com/compose/install/"
        Write-Host ""
        exit 1
    }
}

function Test-Nvidia {
    $info = docker info 2>&1 | Out-String
    if ($info -notmatch "nvidia") {
        Write-Host "WARNING: NVIDIA Container Toolkit not detected." -ForegroundColor Yellow
        Write-Host "         Ollama will run on CPU only (slower inference)."
        Write-Host "         GPU guide: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
        Write-Host ""
    }
}

# ─── Registry login ──────────────────────────────────────────────────────────

function Invoke-RegistryLogin {
    $LicenseFile = Join-Path $ScriptDir "huginn.license"
    if (-not (Test-Path $LicenseFile)) {
        Write-Host "ERROR: huginn.license not found." -ForegroundColor Red
        Write-Host "       Contact your Huginn administrator for a license file."
        exit 1
    }
    $token = (Get-Content $LicenseFile -Raw).Trim()
    $token | docker login ghcr.io -u huginn-client --password-stdin 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Registry login failed. Your license may be expired or revoked." -ForegroundColor Red
        Write-Host "       Contact your Huginn administrator."
        exit 1
    }
}

# ─── Folder picker ───────────────────────────────────────────────────────────

function Select-Folder {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description     = "Select your documents folder"
    $dialog.RootFolder      = [System.Environment+SpecialFolder]::MyComputer
    $dialog.ShowNewFolderButton = $false
    $result = $dialog.ShowDialog()
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        return $dialog.SelectedPath
    }
    return $null
}

function Get-DocumentsPath {
    if (Test-Path $ConfigFile) {
        $line = Get-Content $ConfigFile | Where-Object { $_ -match "^DOCUMENTS_PATH=" }
        if ($line) {
            $saved = $line -replace "^DOCUMENTS_PATH=", ""
            if ($saved -and (Test-Path $saved)) { return $saved }
        }
    }

    Write-Host "Please select the folder containing your documents." -ForegroundColor Cyan
    Write-Host "(A folder picker window will open.)"
    Write-Host ""

    $folder = Select-Folder
    if (-not $folder) {
        Write-Host "ERROR: No folder selected." -ForegroundColor Red
        exit 1
    }
    "DOCUMENTS_PATH=$folder" | Set-Content $ConfigFile
    return $folder
}

# ─── Main ────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "╔══════════════════════════════════╗"
Write-Host "║         Huginn Scanner           ║"
Write-Host "╚══════════════════════════════════╝"
Write-Host ""

Assert-Docker
Test-Nvidia
Invoke-RegistryLogin

$DocsPath = Get-DocumentsPath
Write-Host "Documents folder: $DocsPath"
Write-Host ""

$ComposeFile = Join-Path $ScriptDir "docker-compose.yml"

Write-Host "Pulling latest Huginn image (may take a few minutes on first run)..."
docker compose -f $ComposeFile pull --quiet

Write-Host "Starting Huginn..."
$env:DOCUMENTS_PATH = $DocsPath
docker compose -f $ComposeFile up -d

Write-Host ""
Write-Host "✓ Huginn is running!" -ForegroundColor Green
Write-Host "  Open http://localhost:3000 in your browser."
Write-Host ""
Write-Host "  To stop Huginn:"
Write-Host "    docker compose -f '$ComposeFile' down"
Write-Host ""
```

- [ ] **Step 2: Verify the script has no syntax errors (run on any machine with PowerShell)**

On Linux with `pwsh` installed:
```bash
pwsh -NoProfile -Command "& { \$null = [System.Management.Automation.Language.Parser]::ParseFile('client-dist/start.ps1', [ref]\$null, [ref]\$null); Write-Host 'Syntax OK' }"
```
Or on Windows, open PowerShell ISE and paste the script — it will highlight syntax errors.

If `pwsh` is not available, skip this step and do a visual review of the script instead.

- [ ] **Step 3: Commit**

```bash
git add client-dist/start.ps1
git commit -m "feat(dist): add start.ps1 — Windows PowerShell launcher with FolderBrowserDialog"
```

---

### Task 6: Create .github/workflows/release.yml

GitHub Actions workflow that builds `Dockerfile.release` and pushes to GHCR on every push to `main`. Uses the built-in `GITHUB_TOKEN` — no additional secrets needed for the push.

**Files:**
- New: `.github/workflows/release.yml`

- [ ] **Step 1: Create the workflows directory and release.yml**

```bash
mkdir -p .github/workflows
```

Create `/home/clemi/huginn/.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches: [main]

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          file: Dockerfile.release
          push: true
          tags: ghcr.io/${{ github.repository_owner }}/huginn:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

> **Note:** The `cache-from`/`cache-to` lines enable GitHub Actions build cache, which significantly speeds up repeat builds (the Bun install and obfuscation steps are cached between pushes).

- [ ] **Step 2: Update client-dist/docker-compose.yml with the real image path**

Replace the placeholder `REPLACE_WITH_YOUR_ORG` in `client-dist/docker-compose.yml` with the actual GitHub username or org name. For example, if the repo is `github.com/mycompany/huginn`:

```yaml
    image: ghcr.io/mycompany/huginn:latest
```

- [ ] **Step 3: Verify the workflow YAML is valid**

```bash
docker run --rm -v "$(pwd):/workspace" cytopia/yamllint:latest /workspace/.github/workflows/release.yml
```
Expected: exits 0, no errors.

If `yamllint` Docker image is unavailable, paste the YAML into https://www.yamllint.com/ (offline alternative).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml client-dist/docker-compose.yml
git commit -m "feat(dist): add GitHub Actions release workflow — build + push to GHCR on main"
```

- [ ] **Step 5: Push to GitHub and verify the workflow triggers**

```bash
git push origin main
```

Then open `https://github.com/<your-org>/huginn/actions` and confirm the "Release" workflow starts running. First build will take ~5–10 minutes (Bun install + obfuscation + Docker layer push). Subsequent builds use the GHA cache and complete in ~2–3 minutes.

---

## Post-implementation: how to issue a client license

After the workflow has pushed the first image:

1. Go to **GitHub → Settings → Developer settings → Personal access tokens (classic)**
2. Generate a new token with scope `read:packages` only
3. Name it after the client (e.g. `client-acme-2026`)
4. Create `huginn.license` containing just the token (one line, no spaces):
   ```
   ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
5. Zip the client-dist folder contents + the license file:
   ```bash
   cd client-dist
   zip huginn-client-acme.zip docker-compose.yml start.sh start.ps1
   zip huginn-client-acme.zip ../huginn.license   # add the license separately
   ```
6. Send the ZIP to the client. They run `./start.sh` (Linux/WSL) or `.\start.ps1` (Windows).

To revoke a client: delete their token in GitHub. Their next `start.sh` run will fail with "Registry login failed."
