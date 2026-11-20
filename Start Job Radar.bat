@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed.
  echo Opening https://nodejs.org/ — install the LTS version, then run this again.
  echo.
  start "" "https://nodejs.org/"
  pause
  exit /b 1
)
call npx tsx scripts/start.ts
pause
