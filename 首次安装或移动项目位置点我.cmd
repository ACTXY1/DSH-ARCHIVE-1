@echo off
rem ============================================================
rem  DSH-ARCHIVE: fix project location (first install / moved).
rem  Double-click to detect the user environment, auto-install
rem  missing prerequisites (Node.js / pnpm / dsh CLI), then repair
rem  profile junction, absolute path refs, agent preset, plugin
rem  sync and profile validation.
rem  Optional argument: -DryRun (check only, no changes).
rem ============================================================
title DSH-ARCHIVE - fix project location
set "PS1=%~dp0fix-project-location.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
echo.
pause
