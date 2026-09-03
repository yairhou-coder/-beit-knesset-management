@echo off
chcp 65001 >nul
title Import Community Members
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed.
  pause
  exit /b 1
)

echo.
echo   Updating and importing community members...
echo.
git pull --ff-only
call npm run import -- --reset

echo.
echo   Done. Refresh the browser with Ctrl+F5 to see the data.
echo.
pause
