# יוצר קיצור דרך למערכת בשולחן העבודה, עם הלוגו של בית המדרש.
# הרצה:  powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1

$ErrorActionPreference = 'Stop'

try {
  # תיקיית הפרויקט = תיקיית האב של הסקריפט הזה
  $root   = Split-Path -Parent $PSScriptRoot
  $target = Join-Path $root 'start-windows.cmd'
  $icon   = Join-Path $root 'src\web\assets\anshei-maase.ico'

  Write-Host ''
  Write-Host "  תיקיית הפרויקט: $root"

  if (-not (Test-Path $target)) {
    Write-Host "  ✖ לא נמצא start-windows.cmd. ודאו שאתם בתיקיית הפרויקט." -ForegroundColor Red
    exit 1
  }

  # GetFolderPath מכבד הפניה של שולחן העבודה ל-OneDrive
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path $desktop)) {
    $desktop = Join-Path $env:USERPROFILE 'Desktop'
  }
  Write-Host "  שולחן העבודה: $desktop"

  $linkPath = Join-Path $desktop 'בית המדרש אנשי מעשה.lnk'

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($linkPath)
  $shortcut.TargetPath       = $target
  $shortcut.WorkingDirectory = $root
  $shortcut.Description      = 'מערכת ניהול בית המדרש אנשי מעשה'
  if (Test-Path $icon) { $shortcut.IconLocation = $icon }
  $shortcut.Save()

  if (Test-Path $linkPath) {
    Write-Host ''
    Write-Host '  ✔ קיצור הדרך נוצר בהצלחה:' -ForegroundColor Green
    Write-Host "    $linkPath" -ForegroundColor Green
    Write-Host ''
    Write-Host '  אם אינכם רואים אותו בשולחן העבודה - הקישו F5 לרענון,'
    Write-Host '  או פתחו את התיקייה שבנתיב שלמעלה.'
    Write-Host ''
  } else {
    Write-Host '  ✖ הקיצור לא נוצר, ולא התקבלה שגיאה. נסו את הדרך הידנית.' -ForegroundColor Red
    exit 1
  }
}
catch {
  Write-Host ''
  Write-Host "  ✖ שגיאה: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
  exit 1
}
