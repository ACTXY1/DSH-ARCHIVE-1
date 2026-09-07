# DSH-ARCHIVE one-click start script.
# Usage: double-click "Start-DSH-ARCHIVE.cmd", or run this script in PowerShell.
# Params: -NoSync skip plugin sync; -NoOpen do not auto-open browser.
param(
  [switch]$NoSync,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $MyInvocation.MyCommand.Definition -Parent
$dshDir = Join-Path $root 'dsh'
$logDir = Join-Path $dshDir 'logs'
$port = 3081
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'archive.log'

# Port probe: .NET TcpClient (Get-NetTCPConnection is ACL-blocked on this host).
function Test-Port([int]$p) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(1500)
    if ($ok) { $c.EndConnect($iar); $c.Close() }
    return $ok
  } catch { return $false }
}

# System tray resident: tray.ps1 itself is idempotent (mutex).
function Start-Tray {
  $trayScript = Join-Path $root 'tray.ps1'
  if (Test-Path $trayScript) {
    Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $trayScript) -WindowStyle Hidden
    Write-Host '[start] system tray started (right-click tray icon to open/stop/restart)'
  }
}

Write-Host '=============================='
Write-Host '  DSH-ARCHIVE one-click start'
Write-Host '=============================='

# 1) environment checks
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  Write-Host '[start] ERROR: dsh command not found (npm install -g @deepseek-ai/dsh first)' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path (Join-Path $env:USERPROFILE '.dsh\profiles\archive'))) {
  Write-Host '[start] ERROR: archive profile not mounted (missing junction in $DSH_HOME\profiles\archive)' -ForegroundColor Red
  exit 1
}

# 2) sync project plugins (latest code + rebuild dsh-tools junction)
if (-not $NoSync) {
  Write-Host '[start] syncing project plugins...'
  & (Join-Path $dshDir 'scripts\sync-plugins.ps1')
}

# 2.5) project-bundled ollama (ready-to-use embedding ships inside the project folder).
#      OLLAMA_MODELS points inside the project folder, so the bundled instance never touches
#      a global ollama model store; if port 11434 is already served by an external ollama,
#      reuse it (no PID file is written, so stop.ps1 will not kill it).
#      Verify the 11434 listener is really an ollama process before reusing it - an
#      unrelated service on that port must not suppress the bundled ollama start.
$ollamaExe = Join-Path $root 'ollama\bin\ollama.exe'
$ollamaPidFile = Join-Path $root 'ollama\ollama.pid'
if (Test-Path $ollamaExe) {
  $env:OLLAMA_MODELS = Join-Path $root 'ollama\home\models'
  $ollamaOn11434 = $false
  $portBlocked = $false
  if (Test-Port 11434) {
    $pids = @(netstat -ano | Select-String ':11434\s' | ForEach-Object {
      if ($_ -match 'LISTENING\s+(\d+)\s*$') { [int]$Matches[1] }
    } | Select-Object -Unique)
    foreach ($p1 in $pids) {
      $op = Get-Process -Id $p1 -ErrorAction SilentlyContinue
      if ($op -and $op.ProcessName -match '^ollama') { $ollamaOn11434 = $true; break }
    }
    if ($ollamaOn11434) {
      Write-Host '[start] external ollama already listening on 11434 (reusing it)' -ForegroundColor Yellow
    } else {
      $portBlocked = $true
      Write-Host "[start] WARN: port 11434 is occupied by a non-ollama process (PID: $($pids -join ',')) - embedding unavailable until it is freed; bundled ollama NOT started (port conflict)" -ForegroundColor Yellow
    }
  }
  if (-not $portBlocked -and -not $ollamaOn11434) {
    Write-Host '[start] starting bundled ollama (models inside project folder)...'
    $ollamaLog = Join-Path $logDir 'ollama.log'
    $proc = Start-Process $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden -PassThru -RedirectStandardOutput $ollamaLog -RedirectStandardError "$ollamaLog.err"
    try { $proc.Id | Out-File $ollamaPidFile -Encoding ascii } catch { }
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      if (Test-Port 11434) { $ready = $true; break }
    }
    if ($ready) {
      Write-Host '[start] ollama ready (11434) (log: logs\ollama.log)'
      $list = (& $ollamaExe list 2>&1 | Out-String)
      if ($list -notmatch 'dmeta-embedding-zh') {
        Write-Host '[start] pulling shaw/dmeta-embedding-zh (first run, needs network)...'
        & $ollamaExe pull shaw/dmeta-embedding-zh 2>&1 | Out-Null
      }
    } else {
      Write-Host '[start] WARN: bundled ollama not ready in 30s (embedding will fail until it is)' -ForegroundColor Yellow
    }
  }
} else {
  Write-Host '[start] bundled ollama not found (skip; embedding needs an ollama on 11434)' -ForegroundColor Yellow
}

# 3) Single-instance guard: a second DSH-ARCHIVE instance sharing the same data dir
#    would split conversations/memory, so refuse to start while one is running.
#    Checks (a) PID file (dsh\data\dsh.pid, written after successful start with the
#                3081 listener PID)
#           (b) any of target port 3081 and legacy ports 3111/3113 being listened.
#    Note: RetainDB Local (dsh-mnemon memory provider) permanently listens on
#    3111/3113; detect it via its health endpoint and exempt both legacy ports.
function Test-PidAlive([int]$id) {
  try { return $null -ne (Get-Process -Id $id -ErrorAction Stop) } catch { return $false }
}
# The PID file records the 3081 listener PID at start time; after dsh exits that PID may be
# recycled by the OS to an unrelated process (e.g. RetainDB is also a node process), which
# would falsely block startup. Only trust the PID file when the process is still a node
# process AND still owns the 3081 listener.
function Test-IsDshListener([int]$id) {
  if (-not (Test-PidAlive $id)) { return $false }
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.ProcessName -ne 'node') { return $false }
  $lines = netstat -ano | Select-String (':3081\s')
  foreach ($line in $lines) {
    if ($line -match 'LISTENING\s+(\d+)\s*$' -and [int]$Matches[1] -eq $id) { return $true }
  }
  return $false
}
function Test-RetainDbHealth {
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3111/retaindb/health' -TimeoutSec 2
    return $true
  } catch { return $false }
}
$dshPidFile = Join-Path $dshDir 'data\dsh.pid'
$runningPids = @()
if (Test-Path $dshPidFile) {
  $old = (Get-Content $dshPidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($old -match '^\d+$' -and (Test-IsDshListener ([int]$old)) -and ($runningPids -notcontains ([int]$old))) { $runningPids += ([int]$old) }
}
$legacyPorts = @()
if (-not (Test-RetainDbHealth)) { $legacyPorts = @(3111, 3113) }
foreach ($p in @($port) + $legacyPorts) {
  if (Test-Port $p) {
    $found = netstat -ano | Select-String (":$p\s")
    foreach ($line in $found) {
      if ($line -match 'LISTENING\s+(\d+)\s*$') {
        $pid1 = [int]$Matches[1]
        # Only treat the listener as a running dsh instance when it is
        # really a node process; an unrelated service on the port must not block startup.
        $proc1 = Get-Process -Id $pid1 -ErrorAction SilentlyContinue
        if ($proc1 -and $proc1.ProcessName -eq 'node') {
          if ($runningPids -notcontains $pid1) { $runningPids += $pid1 }
        } elseif ($p -eq $port) {
          # Main web port occupied by an unrelated process: dsh cannot bind it, so
          # refuse to start with a clear reason instead of crashing mid-launch.
          Write-Host "[start] ERROR: port $port is already occupied by a non-node process (PID $pid1, name $($proc1.ProcessName)) - free the port first, then start again." -ForegroundColor Red
          exit 1
        } else {
          Write-Host "[start] WARN: legacy port $p is occupied by a non-node process (PID $pid1, name $($proc1.ProcessName)) - ignored (not a DSH-ARCHIVE instance)" -ForegroundColor Yellow
        }
      }
    }
  }
}
if ($runningPids.Count -gt 0) {
  Write-Host "[start] DSH-ARCHIVE already running (PID: $($runningPids -join ', ')) - do NOT start twice; multiple instances sharing data will corrupt conversations/memory." -ForegroundColor Yellow
  Write-Host '[start] To restart: run stop.ps1 first (or tray right-click Stop), then start again.' -ForegroundColor Yellow
  # Already running: still ensure the tray exists (tray.ps1 is idempotent).
  Start-Tray
  Write-Host "[start] open http://127.0.0.1:$port"
  if (-not $NoOpen) { Start-Process "http://127.0.0.1:$port" }
  exit 0
}

# 3.5) log rotation: keep archive.log under 10 MB - rename to .old on start
if (Test-Path $log) {
  $len = (Get-Item $log).Length
  if ($len -gt 10MB) {
    Move-Item $log "$log.old" -Force
    Write-Host '[start] archive.log rotated (>10MB -> archive.log.old)'
  }
}

# 4) start webui in background with log file
# Note: dsh always runs with --no-open (otherwise dsh opens a browser itself, plus this
#       script's SUCCESS branch opens another = two pages); the browser is opened exactly
#       once by this script unless -NoOpen.
# Log encoding: redirect via cmd /c - cmd writes bytes as-is, so dsh
#       UTF-8 output lands verbatim; PS 5.1 *>> would transcode to ANSI/GBK and garble it.
Write-Host "[start] starting control UI at http://127.0.0.1:$port (log: $log)"
$cmd = "dsh --profile archive --port $port --no-open >> `"$log`" 2>&1"
Start-Process cmd -ArgumentList @('/c', $cmd) -WindowStyle Hidden

# 5) wait until ready
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Port $port) { $ready = $true; break }
}
if ($ready) {
  # Record the 3081 listener PID for the next start (single-instance guard).
  try {
    $listener = @(netstat -ano | Select-String (":$port\s") | ForEach-Object {
      if ($_ -match 'LISTENING\s+(\d+)\s*$') { [int]$Matches[1] }
    } | Select-Object -Unique | Select-Object -First 1)
    if ($listener.Count -gt 0 -and $listener[0]) { $listener[0] | Out-File $dshPidFile -Encoding ascii }
  } catch { }
  # System tray resident (tray.ps1 is idempotent, keeps a single instance).
  Start-Tray
  Write-Host "[start] SUCCESS: http://127.0.0.1:$port" -ForegroundColor Green
  if (-not $NoOpen) { Start-Sleep -Seconds 2; Start-Process "http://127.0.0.1:$port" }
} else {
  Write-Host "[start] not ready in 30s; see log: $log" -ForegroundColor Yellow
  if (Test-Path $log) { Get-Content $log -Tail 20 }
}
