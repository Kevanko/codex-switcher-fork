# release.ps1 — full build + sign + GitHub release + local install
# Usage:  .\release.ps1          (auto-increments patch version)
#         .\release.ps1 0.2.16   (explicit version)

param([string]$Version = "")

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Helper: write file as UTF-8 WITHOUT BOM (critical for JSON/TOML/CONF files)
function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $enc = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

$ROOT       = $PSScriptRoot
$CONF       = "$ROOT\src-tauri\tauri.conf.json"
$CARGO      = "$ROOT\src-tauri\Cargo.toml"
$BUNDLE_DIR = "$ROOT\src-tauri\target\release\bundle"
$REPO       = "Kevanko/codex-switcher-fork"

# ── 1. Resolve version ────────────────────────────────────────────────────────
$currentVersion = (Get-Content $CONF -Raw | ConvertFrom-Json).version
if (-not $Version) {
    $parts    = $currentVersion -split '\.'
    $parts[2] = [string]([int]$parts[2] + 1)
    $Version  = $parts -join '.'
}
Write-Host "==> Building v$Version  (was $currentVersion)" -ForegroundColor Cyan

# ── 2. Bump version — write back WITHOUT BOM ──────────────────────────────────
$confContent  = [System.IO.File]::ReadAllText($CONF)
$cargoContent = [System.IO.File]::ReadAllText($CARGO)

# Remove any existing BOM before replacing
$confContent  = $confContent.TrimStart([char]0xFEFF)
$cargoContent = $cargoContent.TrimStart([char]0xFEFF)

$confContent  = $confContent  -replace "`"version`": `"$currentVersion`"", "`"version`": `"$Version`""
$cargoContent = $cargoContent -replace "^version = `"$currentVersion`"", "version = `"$Version`""

Write-Utf8NoBom $CONF  $confContent
Write-Utf8NoBom $CARGO $cargoContent
Write-Host "==> Version bumped to $Version" -ForegroundColor Green

# ── 3. Build (signing key must be in env) ─────────────────────────────────────
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    throw "TAURI_SIGNING_PRIVATE_KEY is not set. Cannot produce updater signatures."
}
Write-Host "==> Running tauri build..." -ForegroundColor Cyan
Push-Location $ROOT
try {
    npx tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

# ── 4. Locate build artifacts ─────────────────────────────────────────────────
$nsisExeOrig = "$BUNDLE_DIR\nsis\Codex Switcher_${Version}_x64-setup.exe"
$nsisSigOrig = "$nsisExeOrig.sig"
$msiFileOrig = "$BUNDLE_DIR\msi\Codex Switcher_${Version}_x64_en-US.msi"
$msiSigOrig  = "$msiFileOrig.sig"

foreach ($f in @($nsisExeOrig, $nsisSigOrig, $msiFileOrig)) {
    if (-not (Test-Path $f)) { throw "Expected file not found: $f" }
}
if (-not (Test-Path $nsisSigOrig)) {
    throw "No .sig file — TAURI_SIGNING_PRIVATE_KEY may be wrong or missing."
}

# Rename with dots so GitHub download URL has no spaces
$nsisExeDot = "$BUNDLE_DIR\nsis\Codex.Switcher_${Version}_x64-setup.exe"
$nsisSigDot = "$nsisExeDot.sig"
$msiFileDot = "$BUNDLE_DIR\msi\Codex.Switcher_${Version}_x64_en-US.msi"
$msiSigDot  = "$msiFileDot.sig"

Copy-Item $nsisExeOrig $nsisExeDot -Force
Copy-Item $nsisSigOrig $nsisSigDot -Force
Copy-Item $msiFileOrig $msiFileDot -Force
if (Test-Path $msiSigOrig) { Copy-Item $msiSigOrig $msiSigDot -Force }

# ── 5. Create latest.json — NO BOM, compact ───────────────────────────────────
$sig     = ([System.IO.File]::ReadAllText($nsisSigOrig)).Trim()
$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$dlUrl   = "https://github.com/$REPO/releases/download/v$Version/Codex.Switcher_${Version}_x64-setup.exe"

$latestObj = [ordered]@{
    version   = $Version
    notes     = "See https://github.com/$REPO/releases/tag/v$Version"
    pub_date  = $pubDate
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $sig
            url       = $dlUrl
        }
    }
}

# ConvertTo-Json -Compress = no extra whitespace; Write-Utf8NoBom = no BOM
$latestJsonContent = $latestObj | ConvertTo-Json -Depth 5 -Compress
$latestJsonPath    = "$ROOT\latest.json"
Write-Utf8NoBom $latestJsonPath $latestJsonContent

# Sanity check: first byte must be '{' (0x7B), not BOM (0xEF)
$firstByte = ([System.IO.File]::ReadAllBytes($latestJsonPath))[0]
if ($firstByte -ne 0x7B) { throw "latest.json has BOM or wrong encoding (first byte: 0x$($firstByte.ToString('X2')))" }
Write-Host "==> latest.json OK (no BOM, first byte 0x7B)" -ForegroundColor Green

# ── 6. Install locally via silent NSIS installer ──────────────────────────────
Write-Host "==> Installing locally..." -ForegroundColor Cyan
Stop-Process -Name "codex-switcher" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
Start-Process -FilePath $nsisExeOrig -ArgumentList "/S" -Wait
Write-Host "==> Installed locally" -ForegroundColor Green

# ── 7. Git commit + tag + push ────────────────────────────────────────────────
Push-Location $ROOT
try {
    git add src-tauri/tauri.conf.json src-tauri/Cargo.toml
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) {
        git commit -m "chore: bump version to $Version"
    }
    git push origin main

    # Recreate tag
    $tagExists = git tag -l "v$Version"
    if ($tagExists) {
        git tag -d "v$Version"
        git push origin ":refs/tags/v$Version" 2>$null
    }
    git tag "v$Version"
    git push origin "v$Version"
    Write-Host "==> Pushed tag v$Version" -ForegroundColor Green
} finally {
    Pop-Location
}

# ── 8. GitHub release ─────────────────────────────────────────────────────────
gh release delete "v$Version" --repo $REPO --yes 2>$null

$releaseUrl = gh release create "v$Version" `
    $nsisExeDot `
    $nsisSigDot `
    $msiFileDot `
    $latestJsonPath `
    --repo $REPO `
    --title "v$Version" `
    --notes "Release v$Version — see changelog in commit history."

if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }

Write-Host ""
Write-Host "==> Done!" -ForegroundColor Green
Write-Host "    Release  : $releaseUrl" -ForegroundColor Cyan
Write-Host "    Installer: $nsisExeDot" -ForegroundColor Gray
Write-Host "    latest.json: no BOM, compact JSON, URL matches asset name" -ForegroundColor Gray
