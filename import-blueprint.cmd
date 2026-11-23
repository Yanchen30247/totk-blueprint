@echo off
rem Open the blueprint import window (tools\import_gui.ps1).
rem Double-click it, or drop .cai files on it to have them listed and selected.
rem Command line without the window: node tools\save_inject.js <file.cai> [--slot 03] [--write]
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tools\import_gui.ps1" %*
