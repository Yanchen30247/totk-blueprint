@echo off
rem Start the editor and open it in the browser. Keep this window open while you use it; close it to stop.
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
"%NODE%" app\server\serve.mjs --open
if errorlevel 1 pause
