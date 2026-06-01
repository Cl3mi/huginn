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
  local skip_saved=0

  while true; do
    local folder=""

    # Saved-path confirmation
    if [[ $skip_saved -eq 0 && -f "$CONFIG_FILE" ]]; then
      local saved
      saved="$(grep '^DOCUMENTS_PATH=' "$CONFIG_FILE" 2>/dev/null | cut -d= -f2-)"
      saved="${saved/#\~/$HOME}"
      if [[ -n "$saved" && -d "$saved" ]]; then
        local reuse
        read -rp "Last time you used: $saved — use this again? [Y/n] " reuse || true
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
          read -rp "Enter the full path to your documents folder: " folder || true
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
    if [[ -z "$(find "$folder" -maxdepth 1 -mindepth 1 -print -quit 2>/dev/null)" ]]; then
      echo "" >&2
      echo "Warning: that folder appears to be empty. Huginn won't find any documents to scan." >&2
      local cont
      read -rp "Continue anyway? [y/N] " cont || true
      if [[ "${cont,,}" != "y" ]]; then
        continue
      fi
    fi

    echo "DOCUMENTS_PATH=$folder" > "$CONFIG_FILE"
    echo "$folder"
    return
  done
}

# ─── Pull with spinner ────────────────────────────────────────────────────────

run_pull_with_spinner() {
  local compose_file="$1"
  local log
  log="$(mktemp)"
  trap 'rm -f "$log"' EXIT

  echo "This usually takes 3–5 minutes on first run."

  docker compose -f "$compose_file" pull >"$log" 2>&1 &
  local pull_pid=$!

  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local frame_idx=0
  local start=$SECONDS

  local exit_code=0
  if [[ -t 1 ]]; then
    while kill -0 "$pull_pid" 2>/dev/null; do
      local elapsed=$(( SECONDS - start ))
      local mins=$(( elapsed / 60 ))
      local secs=$(( elapsed % 60 ))
      printf "\rDownloading Huginn... %dm %02ds  %s" "$mins" "$secs" "${frames[$frame_idx]}"
      frame_idx=$(( (frame_idx + 1) % ${#frames[@]} ))
      sleep 1
    done
    printf "\r%-60s\r" ""
    wait "$pull_pid" 2>/dev/null || exit_code=$?
  else
    wait "$pull_pid" 2>/dev/null || exit_code=$?
  fi

  if [[ $exit_code -ne 0 ]]; then
    echo "ERROR: Download failed. Details:"
    cat "$log"
    exit 1
  fi

  echo "✓ Download complete."
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
  export DOCUMENTS_PATH="$docs_path"

  run_pull_with_spinner "$SCRIPT_DIR/docker-compose.yml"

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

  echo ""
  echo "✓ Huginn is running!"
  echo "  Open http://localhost:3000 in your browser."
  echo ""
  echo "  To stop Huginn:"
  echo "    docker compose -f '$SCRIPT_DIR/docker-compose.yml' down"
  echo ""
}

main "$@"
