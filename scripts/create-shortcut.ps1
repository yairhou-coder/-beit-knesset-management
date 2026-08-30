# Creates a Desktop shortcut for the management system, with the logo as its icon.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\\create-shortcut.ps1
#
# NOTE: This file is intentionally pure ASCII. Windows PowerShell 5.1 reads .ps1
# files without a BOM as ANSI, which mangles non-ASCII characters and can break
# parsing entirely. The Hebrew shortcut name is therefore built from explicit
# Unicode code points below, so the script parses correctly under any encoding.

$ErrorActionPreference = 'Stop'

try {
  $root   = Split-Path -Parent $PSScriptRoot
  $target = Join-Path $root 'start-windows.cmd'
  $icon   = Join-Path $root 'src\web\assets\anshei-maase.ico'

  Write-Host ''
  Write-Host "  Project folder : $root"

  if (-not (Test-Path $target)) {
    Write-Host '  [X] start-windows.cmd not found. Run this from the project folder.' -ForegroundColor Red
    exit 1
  }

  # GetFolderPath honours a Desktop redirected to OneDrive
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path $desktop)) {
    $desktop = Join-Path $env:USERPROFILE 'Desktop'
  }
  Write-Host "  Desktop folder : $desktop"

  # Shortcut name: "Beit HaMidrash Anshei Maase" in Hebrew letters
  $linkName = -join (@(0x05D1,0x05D9,0x05EA,0x0020,0x05D4,0x05DE,0x05D3,0x05E8,0x05E9,0x0020,0x05D0,0x05E0,0x05E9,0x05D9,0x0020,0x05DE,0x05E2,0x05E9,0x05D4) | ForEach-Object { [char]$_ })
  $linkPath = Join-Path $desktop ($linkName + '.lnk')

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($linkPath)
  $shortcut.TargetPath       = $target
  $shortcut.WorkingDirectory = $root
  $shortcut.Description      = 'Beit Midrash Anshei Maase - Management System'
  if (Test-Path $icon) { $shortcut.IconLocation = $icon }
  $shortcut.Save()

  if (Test-Path $linkPath) {
    Write-Host ''
    Write-Host '  [OK] Desktop shortcut created:' -ForegroundColor Green
    Write-Host "       $linkPath" -ForegroundColor Green
    Write-Host ''
    Write-Host '  Double-click it to start the system.'
    Write-Host '  Not visible? Press F5 on the Desktop to refresh.'
    Write-Host ''
  } else {
    Write-Host '  [X] Shortcut was not created. Use the manual method in the README.' -ForegroundColor Red
    exit 1
  }
}
catch {
  Write-Host ''
  Write-Host "  [X] Error: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
  exit 1
}
