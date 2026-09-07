@echo off
rem Stop DSH-ARCHIVE webui (port 3081) and release the port.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
pause
