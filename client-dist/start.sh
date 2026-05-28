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
