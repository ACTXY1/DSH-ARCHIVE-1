@echo off
rem DSH-ARCHIVE one-click update (double-click to run)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
echo.
pause
