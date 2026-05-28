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
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to pull the Huginn image. Check your internet connection and license." -ForegroundColor Red
    exit 1
}

Write-Host "Starting Huginn..."
$env:DOCUMENTS_PATH = $DocsPath
docker compose -f $ComposeFile up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Failed to start Huginn. Run 'docker compose -f '$ComposeFile' logs' for details." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "✓ Huginn is running!" -ForegroundColor Green
Write-Host "  Open http://localhost:3000 in your browser."
Write-Host ""
Write-Host "  To stop Huginn:"
Write-Host "    docker compose -f '$ComposeFile' down"
Write-Host ""
