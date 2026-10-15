# End-to-end update test on a real Windows machine (CI: windows-latest).
#
# For each old release: install it the way users do, seed a store holding every
# kind of data, then run the NEW installer with exactly the arguments the in-app
# updater passes (tauri-plugin-updater 2.10, installMode "passive"). Then check:
#   - the installed exe is the new version, in the same place (no second copy),
#   - it carries the bundle marker for its installer, so its own updater will
#     pick the right file next time,
#   - the updater's relaunch works and the app stays up (no crash on start),
#   - the accounts store still holds everything it had.
# Any failure exits non-zero, which blocks the release.
#
#   pwsh scripts/e2e-windows-update.ps1 -NewSetup <setup.exe> -NewMsi <.msi> -NewVersion 0.3.12 `
#        [-OldTags v0.3.9,v0.3.8] [-Repo owner/name]
param(
  [Parameter(Mandatory)] [string] $NewSetup,
  [Parameter(Mandatory)] [string] $NewMsi,
  [Parameter(Mandatory)] [string] $NewVersion,
  [string[]] $OldTags = @(),
  [string] $Repo = "Kevanko/codex-switcher-fork"
)
$ErrorActionPreference = "Stop"
$exeName = "codex-switcher.exe"
$nsisDir = Join-Path $env:LOCALAPPDATA "Codex Switcher"
$msiDir = Join-Path $env:ProgramFiles "Codex Switcher"
$storeDir = Join-Path $HOME ".codex-switcher"
$work = Join-Path ([IO.Path]::GetTempPath()) "cs-e2e"
New-Item -ItemType Directory -Force $work | Out-Null
$failures = [System.Collections.Generic.List[string]]::new()

function Fail($msg) { Write-Host "✗ $msg" -ForegroundColor Red; $failures.Add($msg) }
function Ok($msg) { Write-Host "✓ $msg" -ForegroundColor Green }

function Stop-App {
  Get-Process codex-switcher -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

function Remove-All {
  Stop-App
  $u = Join-Path $nsisDir "uninstall.exe"
  if (Test-Path $u) { Run-Installer $u @("/S") "uninstall" | Out-Null; Start-Sleep 2 }
  Get-ChildItem "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -eq "Codex Switcher" -and $_.PSChildName -match '^\{' } |
    ForEach-Object { Run-Installer msiexec.exe @("/x", $_.PSChildName, "/quiet", "/norestart") "msi uninstall" | Out-Null }
  Remove-Item -Recurse -Force $nsisDir, $msiDir -ErrorAction SilentlyContinue
}

function Seed-Store {
  New-Item -ItemType Directory -Force $storeDir | Out-Null
  # Every kind of data any version has stored, plus one field from "the future".
  @'
{"version":1,"accounts":[{"id":"e2e-1","name":"E2E Codex","email":"e2e@example.com","plan_type":"plus","provider":"codex","auth_mode":"api_key","auth_data":{"type":"api_key","key":"sk-e2e"},"created_at":"2025-01-01T00:00:00Z","future_account_field":42}],
 "active_account_id":null,"active_claude_account_id":null,"masked_account_ids":[],
 "claude_token_accounts":[{"id":"t1","name":"cli","token":"sk-ant-oat01-e2e","created_at":"2026-01-01T00:00:00Z","expires_at":"2027-01-01T00:00:00Z","plan_label":null}],
 "active_claude_token_id":null,
 "gateway_accounts":[{"id":"g1","name":"glm","base_url":"https://api.z.ai/api/anthropic","key":"k-e2e","model":null,"created_at":"2026-01-01T00:00:00Z"}],
 "active_gateway_id":null,"zcode_accounts":[],"active_zcode_account_id":null,
 "e2e_future_store_field":{"keep":"me"}}
'@ | Set-Content -Encoding utf8NoBOM (Join-Path $storeDir "accounts.json")
}

function Check-Store($label) {
  $s = Get-Content -Raw (Join-Path $storeDir "accounts.json") | ConvertFrom-Json
  foreach ($check in @(
      @{ ok = ($s.accounts | Where-Object id -eq "e2e-1"); what = "the Codex account" },
      @{ ok = ($s.claude_token_accounts | Where-Object id -eq "t1"); what = "the Claude CLI token" },
      @{ ok = ($s.gateway_accounts | Where-Object id -eq "g1"); what = "the gateway key" })) {
    if (-not $check.ok) { Fail "${label}: update lost $($check.what) from accounts.json" }
  }
}

function Run-Installer($file, [string[]]$installerArgs, $label) {
  $p = Start-Process $file -ArgumentList $installerArgs -PassThru
  if (-not $p.WaitForExit(180000)) { $p | Stop-Process -Force; throw "${label}: installer did not finish within 3 minutes" }
  return $p.ExitCode
}

function Exe-Version($path) { (Get-Item $path).VersionInfo.ProductVersion -replace '\+.*$', '' }

function Has-Marker($path, $marker) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $text = [Text.Encoding]::ASCII.GetString($bytes)
  return $text.Contains("__TAURI_BUNDLE_TYPE_VAR_$marker")
}

function Wait-App($dir, $seconds) {
  $exe = Join-Path $dir $exeName
  for ($i = 0; $i -lt $seconds; $i++) {
    $p = Get-Process codex-switcher -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
    if ($p) { return $p }
    Start-Sleep 1
  }
  return $null
}

function Assert-Running($label, $dir) {
  $p = Wait-App $dir 45
  if (-not $p) { Fail "${label}: app did not start after the update"; return }
  Start-Sleep 12 # long enough for a crash on startup to show
  $p = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
  if (-not $p -or $p.HasExited) { Fail "${label}: app exited right after starting"; return }
  Ok "${label}: app is running $(Exe-Version $p.Path)"
}

function Get-Asset($tag, $pattern) {
  $dest = Join-Path $work $tag
  New-Item -ItemType Directory -Force $dest | Out-Null
  gh release download $tag -R $Repo -p $pattern -D $dest --clobber | Out-Null
  $f = Get-ChildItem $dest -Filter $pattern | Select-Object -First 1
  if (-not $f) { throw "release $tag has no asset matching $pattern" }
  return $f.FullName
}

if ($OldTags.Count -eq 0) {
  # Newest few releases plus the oldest one on the current signing key.
  $tags = gh release list -R $Repo -L 100 --exclude-drafts --json tagName --jq '.[].tagName'
  $OldTags = @($tags | Select-Object -First 3) + @("v0.2.15") | Select-Object -Unique
}

# ── Fresh install of the new version (what a new user gets) ──────────────────
Remove-All
Run-Installer $NewSetup @("/S") "fresh install" | Out-Null
$exe = Join-Path $nsisDir $exeName
if ((Exe-Version $exe) -ne $NewVersion) { Fail "fresh NSIS install is $(Exe-Version $exe), expected $NewVersion" }
if (-not (Has-Marker $exe "NSS")) { Fail "NSIS-installed exe has no NSIS bundle marker — its updater would fetch the MSI" }
Start-Process $exe
Assert-Running "fresh install" $nsisDir

foreach ($tag in $OldTags) {
  # ── NSIS: old setup.exe → new setup.exe with the updater's arguments ───────
  $label = "$tag → $NewVersion (NSIS)"
  try {
    Remove-All; Seed-Store
    Run-Installer (Get-Asset $tag "*-setup.exe") @("/S") "$tag install" | Out-Null
    $old = Exe-Version (Join-Path $nsisDir $exeName)
    Write-Host "installed $tag as $old"
    # tauri-plugin-updater, passive NSIS: /P /R /UPDATE /ARGS
    Run-Installer $NewSetup @("/P", "/R", "/UPDATE", "/ARGS") $label | Out-Null
    $exe = Join-Path $nsisDir $exeName
    $ver = Exe-Version $exe
    if ($ver -ne $NewVersion) { Fail "${label}: installed exe is $ver, expected $NewVersion" }
    if (-not (Has-Marker $exe "NSS")) { Fail "${label}: exe lost its NSIS bundle marker" }
    if (Test-Path (Join-Path $msiDir $exeName)) { Fail "${label}: a second copy appeared in Program Files" }
    Assert-Running $label $nsisDir
    Stop-App
    Check-Store $label
  } catch { Fail "${label}: $_" }

  # ── MSI: old .msi → new .msi with the updater's arguments ─────────────────
  $label = "$tag → $NewVersion (MSI)"
  try {
    Remove-All; Seed-Store
    Run-Installer msiexec.exe @("/i", "`"$(Get-Asset $tag '*.msi')`"", "/quiet", "/norestart") "$tag msi install" | Out-Null
    # tauri-plugin-updater, passive MSI: /i <msi> /passive /promptrestart AUTOLAUNCHAPP=True LAUNCHAPPARGS=""
    $code = Run-Installer msiexec.exe @("/i", "`"$NewMsi`"", "/passive", "/promptrestart", "AUTOLAUNCHAPP=True", 'LAUNCHAPPARGS=""') $label
    if ($code -notin 0, 3010) { Fail "${label}: msiexec exited with $code" }
    $exe = Join-Path $msiDir $exeName
    $ver = Exe-Version $exe
    if ($ver -ne $NewVersion) { Fail "${label}: installed exe is $ver, expected $NewVersion" }
    if (-not (Has-Marker $exe "MSI")) { Fail "${label}: exe lost its MSI bundle marker" }
    if (-not (Wait-App $msiDir 20)) { Start-Process $exe }
    Assert-Running $label $msiDir
    Stop-App
    Check-Store $label
  } catch { Fail "${label}: $_" }
}

Remove-All
if ($failures.Count) {
  Write-Host "`n✗ $($failures.Count) Windows update check(s) failed — do not publish." -ForegroundColor Red
  exit 1
}
Write-Host "`n✓ every Windows update path to $NewVersion installs, keeps data and starts" -ForegroundColor Green
