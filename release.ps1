# release.ps1 — full build + sign + GitHub release
# Usage:  .\release.ps1 0.2.16
# Or:     .\release.ps1          (auto-increments patch)

param(
    [string]$Version = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ROOT       = $PSScriptRoot
$CONF       = "$ROOT\src-tauri\tauri.conf.json"
$CARGO      = "$ROOT\src-tauri\Cargo.toml"
$BUNDLE_DIR = "$ROOT\src-tauri\target\release\bundle"
$REPO       = "Kevanko/codex-switcher-fork"
$INSTALL    = "C:\Users\NM\AppData\Local\Codex Switcher\codex-switcher.exe"

# ── 1. Resolve version ────────────────────────────────────────────────────────
$currentVersion = (Get-Content $CONF | ConvertFrom-Json).version
if (-not $Version) {
    $parts = $currentVersion -split '\.'
    $parts[2] = [string]([int]$parts[2] + 1)
    $Version = $parts -join '.'
}
Write-Host "==> Building v$Version  (was $currentVersion)" -ForegroundColor Cyan

# ── 2. Bump version in both files ─────────────────────────────────────────────
(Get-Content $CONF -Raw) -replace "`"version`": `"$currentVersion`"", "`"version`": `"$Version`"" |
    Set-Content $CONF -Encoding UTF8
(Get-Content $CARGO -Raw) -replace "^version = `"$currentVersion`"", "version = `"$Version`"" |
    Set-Content $CARGO -Encoding UTF8

Write-Host "==> Version bumped to $Version" -ForegroundColor Green

# ── 3. Build ──────────────────────────────────────────────────────────────────
Write-Host "==> Running tauri build..." -ForegroundColor Cyan
Push-Location $ROOT
try {
    npx tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

# ── 4. Verify signature files exist ───────────────────────────────────────────
$nsisExe = "$BUNDLE_DIR\nsis\Codex Switcher_${Version}_x64-setup.exe"
$nsisSig = "$nsisExe.sig"
$msiFile = "$BUNDLE_DIR\msi\Codex Switcher_${Version}_x64_en-US.msi"

if (-not (Test-Path $nsisSig)) {
    throw "Signature file not found: $nsisSig — check TAURI_SIGNING_PRIVATE_KEY env var"
}

# ── 5. Create latest.json ─────────────────────────────────────────────────────
$sig     = Get-Content $nsisSig -Raw
$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$dlName  = "Codex.Switcher_${Version}_x64-setup.exe"
$dlUrl   = "https://github.com/$REPO/releases/download/v$Version/$dlName"

$latestJson = [ordered]@{
    version  = $Version
    notes    = "See https://github.com/$REPO/releases/tag/v$Version"
    pub_date = $pubDate
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $sig.Trim()
            url       = $dlUrl
        }
    }
} | ConvertTo-Json -Depth 5

$latestPath = "$BUNDLE_DIR\latest.json"
$latestJson | Set-Content $latestPath -Encoding UTF8
Write-Host "==> latest.json written" -ForegroundColor Green

# ── 6. Install locally ────────────────────────────────────────────────────────
$builtExe = "$ROOT\src-tauri\target\release\codex-switcher.exe"
Stop-Process -Name "codex-switcher" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Copy-Item $builtExe $INSTALL -Force
Write-Host "==> Installed to $INSTALL" -ForegroundColor Green

# ── 7. Git commit + tag + push ────────────────────────────────────────────────
Push-Location $ROOT
try {
    git add src-tauri/tauri.conf.json src-tauri/Cargo.toml
    git commit -m "chore: bump version to $Version"
    git push origin main

    # Move tag if it already exists
    $tagExists = git tag -l "v$Version"
    if ($tagExists) {
        git tag -d "v$Version"
        git push origin ":refs/tags/v$Version"
    }
    git tag "v$Version"
    git push origin "v$Version"
    Write-Host "==> Pushed tag v$Version" -ForegroundColor Green
} finally {
    Pop-Location
}

# ── 8. GitHub release ─────────────────────────────────────────────────────────
# Delete if exists
gh release delete "v$Version" --repo $REPO --yes 2>$null

$releaseUrl = gh release create "v$Version" `
    $nsisExe `
    $msiFile `
    $latestPath `
    --repo $REPO `
    --title "v$Version" `
    --notes "Release v$Version"

Write-Host ""
Write-Host "==> Done! Release: $releaseUrl" -ForegroundColor Green
Write-Host "    Installer : $nsisExe" -ForegroundColor Gray
Write-Host "    latest.json uploaded for auto-update" -ForegroundColor Gray
