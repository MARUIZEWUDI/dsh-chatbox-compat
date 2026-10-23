<#
.SYNOPSIS
  Remove dsh-chatbox-compat from a DeepSeek Harness profile.

.DESCRIPTION
  Deletes the junction under profiles\web\node_modules and removes the
  `chatbox-compat` entry from cordis.patch.yml (backed up first).
  Your memory file, settings and knowledge base are left untouched.
#>
param(
  [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"

if (-not $DshHome) {
  $DshHome = Join-Path $env:APPDATA "dsh-desktop\harness"
}
if (-not (Test-Path $DshHome)) { Write-Host "[x] DSH home not found: $DshHome"; exit 1 }

$profileDir = Join-Path $DshHome "profiles\web"
$pkgDir = Join-Path $profileDir "node_modules\dsh-chatbox-compat"
$patch = Join-Path $profileDir "cordis.patch.yml"

if (Test-Path $pkgDir) {
  cmd /c rmdir "$pkgDir" | Out-Null
  Write-Host "[1/2] link removed"
} else {
  Write-Host "[1/2] no link found"
}

if (Test-Path $patch) {
  $backupDir = Join-Path $DshHome "backups"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item $patch (Join-Path $backupDir ("cordis.patch." + (Get-Date -Format "yyyyMMdd-HHmmss") + ".yml"))

  $lines = ([System.IO.File]::ReadAllText($patch, [System.Text.Encoding]::UTF8)) -split "`r?`n"
  $out = New-Object System.Collections.Generic.List[string]
  $skip = $false
  foreach ($line in $lines) {
    if ($line -match "^\s*-\s*id:\s*['`"]?chatbox-compat['`"]?\s*$") { $skip = $true; continue }
    if ($skip) {
      if ($line -match "^\s*-\s") { $skip = $false } else { continue }
    }
    $out.Add($line)
  }
  [System.IO.File]::WriteAllText($patch, ($out -join "`r`n"), (New-Object System.Text.UTF8Encoding($true)))
  Write-Host "[2/2] patch entry removed (backup in $backupDir)"
}

Write-Host ""
Write-Host "Uninstalled. Restart DSH Desktop." -ForegroundColor Green
Write-Host "Kept: $DshHome\memory\MEMORY.md, chatbox-compat\settings.json, knowledge\kb.sqlite"
