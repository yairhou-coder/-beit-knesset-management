@echo off
chcp 65001 >nul
title Beit Midrash Anshei Maase - Management System
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Opening the download page...
  echo   Install the LTS version, then run this file again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

node scripts\launch.mjs

if errorlevel 1 pause
