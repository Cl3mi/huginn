# Client Distribution Design

**Date:** 2026-05-28
**Topic:** Shipping Huginn to clients as a protected Docker container

---

## Goals

- Clients run the full stack (Tika + Ollama + scanner) via Docker Compose on their own machine
- Source code is never visible to clients (maximum obfuscation + compiled binary)
- Setup is one command, usable by non-technical users
- Updates are the same one command

---

## What clients receive

A single ZIP file, named per client (e.g. `huginn-client-acme.zip`):

```
huginn-client-<name>.zip
├── start.sh            ← Linux + WSL launcher (install + update)
├── start.ps1           ← Windows (Docker Desktop, non-WSL) launcher
├── huginn.license      ← single-line GHCR read-only PAT, unique per client
└── docker-compose.yml  ← pre-configured, no editing needed
```

No `.env` file. No manual steps.

---

## start.sh flow

1. **Preflight checks**
   - Docker installed → friendly error with install URL if not
   - NVIDIA Container Toolkit present → warns but continues (Ollama falls back to CPU)
2. **Registry login** — reads `huginn.license` (one line), runs `docker login ghcr.io` silently
3. **Folder picker** — on first run only, shows a GUI folder dialog:
   - `zenity --file-selection --directory` (GNOME/GTK, Ubuntu/Debian)
   - `kdialog --getexistingdirectory` (KDE)
   - `powershell.exe` `FolderBrowserDialog` (WSL2 on Windows)
   - plain `read` text prompt (headless / SSH fallback)
   - Chosen path is saved to `.huginn` (hidden file, same directory as start.sh)
4. **Pull + start** — `docker compose pull` then `DOCUMENTS_PATH=<saved_path> docker compose up -d`
5. **Done message** — prints `Huginn is running! Open http://localhost:3000 in your browser.`

On every subsequent run (updates): reads saved path from `.huginn`, re-pulls `latest`, restarts. Install and update are the same command.

## start.ps1 flow (Windows native)

Same logic as `start.sh` but implemented in PowerShell:
- Uses `System.Windows.Forms.FolderBrowserDialog` for folder selection
- Saves path to `.huginn` in the same directory
- Runs `docker compose pull` and `docker compose up -d` via PowerShell

---

## Build pipeline

Runs in GitHub Actions on every push to `main`.

```
TypeScript sources
  └─ bun build --target=bun src/index.ts    →  dist/bundle.js      (bundled)
       └─ javascript-obfuscator bundle.js   →  dist/obfuscated.js  (obfuscated)
            └─ bun build --compile          →  dist/huginn         (native binary)
```

### Multi-stage Dockerfile (new `Dockerfile.release`)

```dockerfile
# Stage 1: build
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY src/ ./src/
RUN bun build --target=bun src/index.ts --outfile dist/bundle.js
RUN bunx javascript-obfuscator dist/bundle.js \
      --output dist/obfuscated.js \
      --compact true \
      --string-array true \
      --string-array-encoding base64 \
      --control-flow-flattening true
RUN bun build --compile dist/obfuscated.js --outfile dist/huginn

# Stage 2: runtime
FROM debian:bookworm-slim
COPY --from=build /app/dist/huginn /huginn
CMD ["/huginn"]
```

Final image: ~100 MB. Contains zero TypeScript, zero `node_modules`, zero source structure.

### Required code change before this works

`src/ui/index.html` is currently served from disk at runtime. The compiled binary has no filesystem, so the server must embed the HTML as a string constant using Bun's static import:

```ts
import html from "./ui/index.html" with { type: "text" };
```

Any other files read from relative paths at runtime (e.g. debug templates, profile YAMLs) need the same treatment.

---

## Registry & access control

- **Registry:** GitHub Container Registry — `ghcr.io/<org>/huginn:latest`
- **Push:** GitHub Actions workflow pushes on every `main` merge
- **Client tokens:** One read-only PAT per client, scope `read:packages` only
  - Generated in GitHub → Settings → Developer settings → Personal access tokens
  - Pasted into `huginn.license` (one line, no other content)
  - To revoke access: delete the token in GitHub

---

## Client-side docker-compose.yml

Replaces today's `docker-compose.yml` + `docker-compose.gpu.yml` with a single merged file. GPU always enabled (clients always have NVIDIA). Adds `huginn_reports` volume for report persistence.

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
    image: ghcr.io/<org>/huginn:latest
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

---

## Update story

Clients run `./start.sh` again. The script re-pulls `latest` and restarts the stack. No version numbers to track, no manual steps.

To force all clients to update: push a new image to `ghcr.io/<org>/huginn:latest`. Next time they run the script, they get the new version automatically.

---

## GitHub Actions workflow (`.github/workflows/release.yml`)

Triggers on push to `main`. The multi-stage `Dockerfile.release` handles the full build pipeline internally — no bun steps needed in CI:

1. Checkout
2. `docker login ghcr.io` (using `GITHUB_TOKEN`)
3. `docker build -f Dockerfile.release -t ghcr.io/<org>/huginn:latest .`
4. `docker push ghcr.io/<org>/huginn:latest`

---

## Files to create / change

| Action | File |
|--------|------|
| New | `Dockerfile.release` |
| New | `client-dist/start.sh` |
| New | `client-dist/start.ps1` |
| New | `client-dist/docker-compose.yml` |
| New | `.github/workflows/release.yml` |
| Modify | `src/server/routes.ts` (or wherever index.html is served) — embed HTML as static import |
| Optional cleanup | `docker-compose.gpu.yml` — content is now merged into the client compose; can be removed from the repo when convenient |

The existing `docker-compose.yml` and `Dockerfile.scanner` remain for local development.
