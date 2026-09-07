@echo off
rem DSH-ARCHIVE one-click rollback to previous release (double-click to run)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" -Rollback
echo.
pause
