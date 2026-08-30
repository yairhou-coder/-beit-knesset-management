# יוצר קיצור דרך למערכת בשולחן העבודה, עם הלוגו של בית המדרש.
# הרצה:  powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1

$ErrorActionPreference = 'Stop'

# תיקיית הפרויקט = תיקיית האב של הסקריפט הזה
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'start-windows.cmd'
$icon   = Join-Path $root 'src\web\assets\anshei-maase.ico'

if (-not (Test-Path $target)) {
  Write-Host "  לא נמצא הקובץ start-windows.cmd בתיקייה $root" -ForegroundColor Red
  exit 1
}

# GetFolderPath מכבד הפניה של שולחן העבודה ל-OneDrive
$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop 'בית המדרש אנשי מעשה.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath       = $target
$shortcut.WorkingDirectory = $root
$shortcut.Description      = 'מערכת ניהול בית המדרש אנשי מעשה'
if (Test-Path $icon) { $shortcut.IconLocation = $icon }
$shortcut.Save()

Write-Host ''
Write-Host '  נוצר קיצור דרך בשולחן העבודה: בית המדרש אנשי מעשה' -ForegroundColor Green
Write-Host '  לחיצה כפולה עליו מפעילה את המערכת.'
Write-Host ''
