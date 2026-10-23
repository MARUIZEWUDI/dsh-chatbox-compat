<#
.SYNOPSIS
  Install dsh-chatbox-compat into a DeepSeek Harness profile.

.DESCRIPTION
  Links this folder into <DSH_HOME>\profiles\web\node_modules\dsh-chatbox-compat
  and appends a loader entry to profiles\web\cordis.patch.yml (backed up first).

  DSH Desktop does not ship a `dsh plugin add` CLI, so this script does what the
  CLI would do. Re-run it after moving this folder.

.PARAMETER DshHome
  Harness home. Defaults to %APPDATA%\dsh-desktop\harness.
#>
param(
  [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"

function Fail($msg) {
  Write-Host "[x] $msg" -ForegroundColor Red
  exit 1
}

if (-not $DshHome) {
  $DshHome = Join-Path $env:APPDATA "dsh-desktop\harness"
}
if (-not (Test-Path $DshHome)) {
  Fail "DSH home not found: $DshHome (install DeepSeek Harness Desktop first, or pass -DshHome)"
}

$profileDir = Join-Path $DshHome "profiles\web"
if (-not (Test-Path $profileDir)) {
  Fail "profile not found: $profileDir"
}

$pkgDir = Join-Path $profileDir "node_modules\dsh-chatbox-compat"
$patch = Join-Path $profileDir "cordis.patch.yml"
$src = $PSScriptRoot

Write-Host "DSH home : $DshHome"
Write-Host "source   : $src"
Write-Host "target   : $pkgDir"

# 0. sanity: does the host look like 0.2.x?
$manifest = Join-Path $DshHome ".desktop-install-state.json"
if (Test-Path $manifest) {
  try {
    $state = Get-Content $manifest -Raw | ConvertFrom-Json
    if ($state.harnessVersion) { Write-Host "harness  : $($state.harnessVersion)" }
  } catch {}
}

# 1. link (junction: works without admin, unlike symlinks)
if (Test-Path $pkgDir) {
  $item = Get-Item $pkgDir
  if ($item.LinkType -eq "Junction" -or $item.LinkType -eq "SymbolicLink") {
    Write-Host "[1/3] removing previous link"
    cmd /c rmdir "$pkgDir" | Out-Null
  } else {
    Fail "$pkgDir exists and is a real directory. Remove it manually, then re-run."
  }
}
New-Item -ItemType Directory -Force -Path (Split-Path $pkgDir) | Out-Null
cmd /c mklink /J "$pkgDir" "$src" | Out-Null
if (-not (Test-Path (Join-Path $pkgDir "package.json"))) { Fail "link failed" }
Write-Host "[1/3] linked"

# 2. patch entry
if (-not (Test-Path $patch)) { Fail "cordis.patch.yml missing at $patch" }
$content = [System.IO.File]::ReadAllText($patch, [System.Text.Encoding]::UTF8)
if ($content -match "(?m)^\s*-\s*id:\s*['`"]?chatbox-compat['`"]?\s*$") {
  Write-Host "[2/3] patch entry already present, skipping"
} else {
  $backupDir = Join-Path $DshHome "backups"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item $patch (Join-Path $backupDir ("cordis.patch." + (Get-Date -Format "yyyyMMdd-HHmmss") + ".yml"))

  $lines = $content -split "`r?`n"
  $insertIdx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*-\s*insert:\s*$") { $insertIdx = $i }
  }

  if ($insertIdx -ge 0) {
    # find the end of that insert block (next line starting with "- " at column 0, or EOF)
    $end = $lines.Count
    for ($i = $insertIdx + 1; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match "^-\s") { $end = $i; break }
    }
    $before = @()
    if ($end -gt 0) { $before = $lines[0..($end - 1)] }
    $after = @()
    if ($end -lt $lines.Count) { $after = $lines[$end..($lines.Count - 1)] }
    $block = @(
      "    - id: chatbox-compat",
      '      name: "dsh-chatbox-compat"'
    )
    $lines = @($before) + $block + @($after)
  } else {
    $lines = @($lines) + @(
      "",
      "- insert:",
      "    - id: chatbox-compat",
      '      name: "dsh-chatbox-compat"'
    )
  }

  [System.IO.File]::WriteAllText($patch, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($true)))
  Write-Host "[2/3] patch entry added (backup in $backupDir)"
}

# 3. settings + memory seed
$settingsDir = Join-Path $DshHome "chatbox-compat"
New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
$settingsFile = Join-Path $settingsDir "settings.json"
if (-not (Test-Path $settingsFile)) {
  [System.IO.File]::WriteAllText($settingsFile, '{"memoryEnabled":true,"disabledSkills":[],"disabledMcp":[]}', (New-Object System.Text.UTF8Encoding($true)))
}
$memFile = Join-Path $DshHome "memory\MEMORY.md"
if (-not (Test-Path $memFile)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $memFile) | Out-Null
  $seed = "# 长期记忆`r`n`r`n> Maintained by dsh-chatbox-compat.`r`n`r`n"
  [System.IO.File]::WriteAllText($memFile, $seed, (New-Object System.Text.UTF8Encoding($true)))
}
Write-Host "[3/3] settings ready"

Write-Host ""
Write-Host "Done. Restart DSH Desktop to load the plugin." -ForegroundColor Green
Write-Host "Then: composer shows [工作模式] and [打包到新对话]; memory lives in $memFile"
Write-Host "Knowledge base is empty by default - point it at a folder in the panel, or set DSH_KB_DIR."
