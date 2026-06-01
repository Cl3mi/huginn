# start.sh UX Polish — Design Spec

**Date:** 2026-05-31  
**Scope:** `client-dist/start.sh` only — no changes to docker-compose.yml, web UI, or server code  
**Target user:** Non-technical business users running Huginn for the first time or on repeat

---

## Problem

Non-technical clients struggle with the documents folder step: tilde paths not accepted, saved path reused silently with no way to change it, empty folders proceed without warning, and docker pull runs with no feedback for several minutes. Docker interpolation warnings leak through as cryptic errors.

---

## Section 1: Folder Selection

`load_or_pick_folder` becomes a retry loop.

**Saved path (subsequent runs):**
- If `.huginn` contains a valid saved path, print:
  `Last time you used: /path/to/docs — use this again? [Y/n]`
- `Y` or Enter: proceed with saved path
- `n`: clear saved value, fall through to prompting

**GUI picker:** unchanged — zenity / kdialog / PowerShell FolderBrowserDialog attempted first; on success, skip to validation.

**Text prompt fallback:**
- Loop until a valid directory is entered
- Prompt: `Enter the full path to your documents folder:`
- On invalid path: `That path doesn't seem to exist. Please check and try again:`
- Tilde expansion applied before validation: `folder="${folder/#\~/$HOME}"`

**Empty folder warning:**
- After a valid directory is confirmed, check if it is empty
- If empty: `Warning: that folder appears to be empty. Huginn won't find any documents to scan.`
- Prompt: `Continue anyway? [y/N]` — default No loops back to folder prompt

---

## Section 2: Pull Progress Spinner

**Background pull:**
- `docker compose pull` runs in the background with all output (stdout + stderr) redirected to a temp log file
- This suppresses interpolation warnings and raw progress noise

**Foreground spinner:**
- Before starting: print once `This usually takes 3–5 minutes on first run.`
- Spinner loop prints a single updating line via `\r`: `Downloading Huginn... 2m 14s  ⠸`
- Cycles through spinner frames; tracks elapsed seconds
- On success: clear line, print `✓ Download complete.`
- On failure: print log file contents so the error is still visible, then exit non-zero

---

## Section 3: Startup and Error Handling

**`docker compose up`:**
- stderr redirected to suppress interpolation warnings
- stdout kept visible (service start events)

**Success:** existing block unchanged — `✓ Huginn is running! Open http://localhost:3000 in your browser.`

**Failure:** print last 20 lines of log with header `Something went wrong. Details:` — no raw docker jargon unless there's a real error

**`DOCUMENTS_PATH` export:** exported before both `pull` and `up` (already applied in previous fix)

**Unchanged:** nvidia check, license login, success/stop instructions

---

## Out of scope

- Changes to `docker-compose.yml`, `start.ps1`, or the web UI
- A numbered wizard / step-by-step first-run mode (Option B — future iteration)
- Moving folder selection into the web UI (Option C — architecturally blocked by volume mount timing)
