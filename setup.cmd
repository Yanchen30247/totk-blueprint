@echo off
rem First-time setup: asks where the game's RomFS (and optionally the saves) are, then builds the part library.
setlocal
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.15 or newer is needed / Node.js 22.15+: https://nodejs.org
  pause
  exit /b 1
)
"%NODE%" tools\setup.js %*
pause
