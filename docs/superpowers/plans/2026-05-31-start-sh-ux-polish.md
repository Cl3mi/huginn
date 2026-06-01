# start.sh UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `client-dist/start.sh` reliably usable by non-technical clients by improving folder selection, adding a pull progress spinner, and suppressing raw Docker errors.

**Architecture:** All changes are within a single bash script (`client-dist/start.sh`). Three functions are modified or added: `load_or_pick_folder` (rewrite), `run_pull_with_spinner` (new), and `main` (minor update for `up` error handling). No other files change.

**Tech Stack:** bash, docker compose v2

---

## File Map

| File | Change |
|------|--------|
| `client-dist/start.sh` | Rewrite `load_or_pick_folder`; add `run_pull_with_spinner`; update `main` |

---

### Task 1: Rewrite `load_or_pick_folder` with retry loop and saved-path confirmation

**Files:**
- Modify: `client-dist/start.sh` — replace `load_or_pick_folder` function (lines 82–117)

- [ ] **Step 1: Replace `load_or_pick_folder` with the new implementation**

Open `client-dist/start.sh` and replace the entire `load_or_pick_folder` function (from `load_or_pick_folder() {` through its closing `}`) with:

```bash
load_or_pick_folder() {
  local skip_saved=0

  while true; do
    local folder=""

    # Saved-path confirmation
    if [[ $skip_saved -eq 0 && -f "$CONFIG_FILE" ]]; then
      local saved
      saved="$(grep '^DOCUMENTS_PATH=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2-)"
      if [[ -n "$saved" && -d "$saved" ]]; then
        local reuse
        read -rp "Last time you used: $saved — use this again? [Y/n] " reuse
        reuse="${reuse:-Y}"
        if [[ "${reuse,,}" != "n" ]]; then
          folder="$saved"
        else
          skip_saved=1
        fi
      fi
    fi

    # GUI or text picker (skipped when reusing saved path)
    if [[ -z "$folder" ]]; then
      echo "Please select the folder containing your documents." >&2
      echo "(A folder picker window will open — check your taskbar if it does not appear in front.)" >&2
      echo "" >&2

      if folder="$(pick_folder_gui 2>/dev/null)" && [[ -n "$folder" ]]; then
        : # GUI picker succeeded
      else
        while true; do
          read -rp "Enter the full path to your documents folder: " folder
          folder="${folder/#\~/$HOME}"
          if [[ -z "$folder" ]]; then
            echo "No folder entered. Please try again." >&2
            continue
          fi
          if [[ ! -d "$folder" ]]; then
            echo "That path doesn't seem to exist. Please check and try again:" >&2
            continue
          fi
          break
        done
      fi
    fi

    # Empty folder warning
    if [[ -z "$(ls -A "$folder" 2>/dev/null)" ]]; then
      echo "" >&2
      echo "Warning: that folder appears to be empty. Huginn won't find any documents to scan." >&2
      local cont
      read -rp "Continue anyway? [y/N] " cont
      if [[ "${cont,,}" != "y" ]]; then
        continue
      fi
    fi

    echo "DOCUMENTS_PATH=$folder" > "$CONFIG_FILE"
    echo "$folder"
    return
  done
}
```

- [ ] **Step 2: Verify the new function manually — first run (no saved path)**

Delete any existing saved config, then run the script up to the folder prompt:

```bash
rm -f client-dist/.huginn
# Run and enter a non-existent path first, then a valid one
sh client-dist/start.sh
```

Expected:
1. No saved-path prompt (no `.huginn` file)
2. Text prompt appears
3. Entering a bad path (e.g. `/does/not/exist`) shows: `That path doesn't seem to exist. Please check and try again:`
4. Entering a valid path proceeds

Kill with Ctrl-C after the folder is accepted (before docker pull starts).

- [ ] **Step 3: Verify saved-path confirmation — subsequent run**

The previous run wrote `.huginn`. Run again:

```bash
sh client-dist/start.sh
```

Expected: `Last time you used: /your/path — use this again? [Y/n]`
- Press Enter → proceeds with saved path
- Enter `n` → falls through to folder picker

Kill with Ctrl-C after confirming the prompt works.

- [ ] **Step 4: Verify empty folder warning**

```bash
mkdir -p /tmp/huginn-empty-test
rm -f client-dist/.huginn
sh client-dist/start.sh
# Enter /tmp/huginn-empty-test when prompted
```

Expected:
```
Warning: that folder appears to be empty. Huginn won't find any documents to scan.
Continue anyway? [y/N]
```
- Enter `n` → loops back to folder prompt
- Enter `y` → proceeds

Kill with Ctrl-C once verified.

- [ ] **Step 5: Commit**

```bash
git add client-dist/start.sh
git commit -m "feat(start.sh): retry loop, saved-path confirmation, empty folder warning"
```

---

### Task 2: Add `run_pull_with_spinner` and wire it into `main`

**Files:**
- Modify: `client-dist/start.sh` — add new function before `main`; update `main`

- [ ] **Step 1: Add `run_pull_with_spinner` function**

In `client-dist/start.sh`, insert the following new function immediately before the `# ─── Main ───` comment block:

```bash
# ─── Pull with spinner ────────────────────────────────────────────────────────

run_pull_with_spinner() {
  local compose_file="$1"
  local log
  log="$(mktemp)"

  echo "This usually takes 3–5 minutes on first run."

  docker compose -f "$compose_file" pull >"$log" 2>&1 &
  local pull_pid=$!

  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local frame_idx=0
  local elapsed=0

  if [[ -t 1 ]]; then
    while kill -0 "$pull_pid" 2>/dev/null; do
      local mins=$(( elapsed / 60 ))
      local secs=$(( elapsed % 60 ))
      printf "\rDownloading Huginn... %dm %02ds  %s" "$mins" "$secs" "${frames[$frame_idx]}"
      frame_idx=$(( (frame_idx + 1) % ${#frames[@]} ))
      sleep 1
      elapsed=$(( elapsed + 1 ))
    done
    printf "\r%-60s\r" ""
  else
    wait "$pull_pid" || true
  fi

  local exit_code=0
  wait "$pull_pid" 2>/dev/null || exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo "ERROR: Download failed. Details:"
    cat "$log"
    rm -f "$log"
    exit 1
  fi

  echo "✓ Download complete."
  rm -f "$log"
}
```

- [ ] **Step 2: Replace the pull one-liner in `main`**

In `main`, replace:

```bash
  echo "Pulling latest Huginn image (may take a few minutes on first run)..."
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" pull --quiet
```

with:

```bash
  run_pull_with_spinner "$SCRIPT_DIR/docker-compose.yml"
```

- [ ] **Step 3: Verify spinner appears during pull**

```bash
sh client-dist/start.sh
```

When it reaches the pull step, expected output:
```
This usually takes 3–5 minutes on first run.
Downloading Huginn... 0m 03s  ⠹
```
(spinner frame and elapsed time update each second)

After pull completes:
```
✓ Download complete.
```

Kill with Ctrl-C after download if you don't want to start services.

- [ ] **Step 4: Commit**

```bash
git add client-dist/start.sh
git commit -m "feat(start.sh): animated spinner with elapsed time for docker pull"
```

---

### Task 3: Suppress stderr warnings on `docker compose up` and handle failure

**Files:**
- Modify: `client-dist/start.sh` — update `main` around the `up` call

- [ ] **Step 1: Replace the `up` one-liner in `main`**

In `main`, replace:

```bash
  echo "Starting Huginn..."
  docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d
```

with:

```bash
  echo "Starting Huginn..."
  local up_log
  up_log="$(mktemp)"
  if ! docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d 2>"$up_log"; then
    echo ""
    echo "Something went wrong. Details:"
    tail -20 "$up_log"
    rm -f "$up_log"
    exit 1
  fi
  rm -f "$up_log"
```

- [ ] **Step 2: Verify interpolation warnings are gone**

```bash
sh client-dist/start.sh
```

Expected: no `WARN[0000] The "DOCUMENTS_PATH" variable is not set` line and no `invalid spec:` line. The `up -d` step should print only the container start events to stdout.

- [ ] **Step 3: Verify the success block still prints**

After all services start, expected:
```
✓ Huginn is running!
  Open http://localhost:3000 in your browser.

  To stop Huginn:
    docker compose -f '.../docker-compose.yml' down
```

- [ ] **Step 4: Commit**

```bash
git add client-dist/start.sh
git commit -m "feat(start.sh): suppress docker compose stderr warnings, show plain error on up failure"
```
