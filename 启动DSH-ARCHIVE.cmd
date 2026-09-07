@echo off
rem DSH-ARCHIVE one-click start (double-click to run)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
echo.
pause
