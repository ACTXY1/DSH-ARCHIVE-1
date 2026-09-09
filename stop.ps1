# DSH-ARCHIVE stop script: stop the webui listening on the project port.
# Usage: powershell -File stop.ps1            (default port 3081)
#        powershell -File stop.ps1 -Port 3081
# Note: kept pure ASCII (no BOM) so PS 5.1 reads it safely in any codepage.
param(
  [int]$Port = 3081
)
$ErrorActionPreference = 'Continue'

function Test-Port([int]$p) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(1500)
    if ($ok) { $c.EndConnect($iar); $c.Close() }
    return $ok
  } catch { return $false }
}

Write-Host "Stopping DSH-ARCHIVE webui on port $Port ..."

# Find the PID(s) listening on the port (Get-NetTCPConnection is ACL-blocked on this host).
$found = @()
try {
  $lines = netstat -ano | Select-String (":$Port\s")
  foreach ($line in $lines) {
    if ($line -match 'LISTENING\s+(\d+)\s*$') {
      $pid1 = [int]$Matches[1]
      if ($found -notcontains $pid1) { $found += $pid1 }
    }
  }
} catch { Write-Host "netstat failed: $_" }

if ($found.Count -eq 0) {
  Write-Host "No process listening on port $Port (already stopped)."
} else {
  foreach ($p in $found) {
    # 2026-09-04 fix: verify the listener is really a node process (dsh runs on node)
    # before killing, mirroring the ollama/tray process-name checks below - prevents
    # killing an unrelated service that happens to occupy the port.
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.ProcessName -ne 'node') {
      Write-Host "WARN: PID $p on port $Port is not a node process (name: $($proc.ProcessName)) - skipping to avoid killing an unrelated service."
      continue
    }
    Write-Host "Killing PID $p (whole process tree) ..."
    taskkill /PID $p /T /F 2>&1 | ForEach-Object { Write-Host "  $_" }
  }
}

# Stop the project-bundled ollama, but ONLY when this project started it (PID file exists).
# An external ollama on 11434 is never touched (start.ps1 writes no PID file in that case).
$ollamaPidFile = Join-Path (Split-Path $MyInvocation.MyCommand.Definition -Parent) 'ollama\ollama.pid'
if (Test-Path $ollamaPidFile) {
  $opid = Get-Content $ollamaPidFile -ErrorAction SilentlyContinue
  if ($opid -match '^\d+$') {
    # 2026-08-30 审计修复：进程名校验（与 tray 路径一致）——PID 文件可能过期、PID 被系统复用时
    # 避免 taskkill 误杀无关进程；校验不通过时打印 WARN 而非静默。
    $op = Get-Process -Id ([int]$opid) -ErrorAction SilentlyContinue
    if ($op -and $op.ProcessName -match '^ollama') {
      Write-Host "Stopping bundled ollama (PID $opid) ..."
      taskkill /PID ([int]$opid) /T /F 2>&1 | ForEach-Object { Write-Host "  $_" }
    } else {
      Write-Host "WARN: ollama PID $opid 不存在或进程名不匹配（可能是过期 PID 文件），跳过停止"
    }
  }
  Remove-Item $ollamaPidFile -Force -ErrorAction SilentlyContinue
}

# Stop the tray resident (tray.pid written by tray.ps1 as two lines: PID / process name).
# Both file-name and live-process-name checks guard against PID reuse.
# Note: legacy tray instances started before v2 (no pid file) were cleaned up once manually.
$trayPidFile = Join-Path (Split-Path $MyInvocation.MyCommand.Definition -Parent) 'dsh\data\tray.pid'
if (Test-Path $trayPidFile) {
  $trayLines = @(Get-Content $trayPidFile -ErrorAction SilentlyContinue)
  $tpid = $trayLines[0]
  $tname = $trayLines[1]
  if ($tpid -match '^\d+$' -and $tname -eq 'powershell') {
    $tp = Get-Process -Id ([int]$tpid) -ErrorAction SilentlyContinue
    if ($tp -and $tp.ProcessName -eq 'powershell') {
      Write-Host "Stopping tray resident (PID $tpid) ..."
      Stop-Process -Id ([int]$tpid) -Force -ErrorAction SilentlyContinue
    }
  }
  Remove-Item $trayPidFile -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2
if (Test-Port $Port) {
  Write-Host "WARN: port $Port still listening after kill. Remaining node processes:"
  Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, StartTime | Format-Table -AutoSize | Out-String | Write-Host
  exit 1
} else {
  # 2026-08-31 single-instance guard: remove the PID file so the next start can launch.
  $pidFile = Join-Path (Split-Path $MyInvocation.MyCommand.Definition -Parent) 'dsh\data\dsh.pid'
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "SUCCESS: DSH-ARCHIVE webui stopped (port $Port released)."
  exit 0
}
