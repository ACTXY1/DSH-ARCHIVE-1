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

# 2026-09-11：新版 dsh web（≥0.1.2）引入浏览器鉴权——dsh 启动时把带进程令牌的地址打印为
# "dsh web: http://127.0.0.1:PORT/?token=..."（archive.log）；裸开 http://127.0.0.1:PORT 会返回
# "dsh web authentication required"。这里解析日志中的该地址并持久化到 dsh\data\web.url
# （托盘/二次打开复用；首次访问签发 Cookie 后普通地址亦可访问）；旧版 dsh 无此行则回落纯地址。
function Get-WebUrl {
  $plain = "http://127.0.0.1:$port"
  $urlFile = Join-Path $dshDir 'data\web.url'
  try {
    if (Test-Path $log) {
      $m = [regex]::Match([System.IO.File]::ReadAllText($log), 'dsh web:\s*(http://[^\s`"]+)')
      if ($m.Success -and $m.Groups[1].Value) {
        $u = $m.Groups[1].Value.Trim()
        try {
          New-Item -ItemType Directory -Force -Path (Split-Path $urlFile -Parent) | Out-Null
          Set-Content -Path $urlFile -Value $u -Encoding ascii
        } catch { }
        return $u
      }
    }
    if (Test-Path $urlFile) {
      $saved = Get-Content $urlFile -TotalCount 1 -ErrorAction SilentlyContinue
      if ($saved -and $saved.Trim()) { return $saved.Trim() }
    }
  } catch { }
  return $plain
}
# 打开控制台（新版 dsh 用带 token 的地址；URL 尚未打印时稍候重读一次再打开）
function Open-Console {
  $u = Get-WebUrl
  if ($u -eq "http://127.0.0.1:$port") { Start-Sleep -Seconds 3; $u = Get-WebUrl }
  if ($u) {
    Write-Host "[start] open $u" -ForegroundColor Green
    if (-not $NoOpen) { Start-Process $u }
  }
}

# System tray resident (2026-08-30 v2): tray.ps1 itself is idempotent (mutex).
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

# 1) 环境检查（2026-09-11 独立化）：使用项目自带的 dsh 引擎，不再依赖全局 dsh 命令
$projHome  = Join-Path $root '.dsh-home'
$engineBin = Join-Path $dshDir 'node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $engineBin)) {
  Write-Host '[start] ERROR: 未找到项目自带 dsh 引擎（node_modules\@deepseek-ai\dsh）' -ForegroundColor Red
  Write-Host '[start] 请双击《首次安装或移动项目位置点我.cmd》完成依赖安装（首次需联网），或手动执行：cd dsh && pnpm install' -ForegroundColor Red
  exit 1
}

# 1.5) 项目内 profile 入口（2026-09-11 独立化）：入口一律位于项目 home 内
#      （<项目>\.dsh-home\profiles\archive -> <项目>\dsh），不再使用 ~/.dsh——也就不存在
#      "多副本共用全局入口被互相覆盖"的问题；缺失/指向错误时本脚本直接创建或修正。
#      另做数据路径自检：cordis.patch.yml 的数据路径必须全部落在本副本 dsh\data，
#      否则（git 检出/移动未归一化）自动运行一次 fix-project-location -NoPrompt 修复；
#      若残留路径指向"存在且含数据"的位置，则拒绝启动并指引（防数据被顶替）。
function Test-DataPresent([string]$dshDir) {
  $d = Join-Path $dshDir 'data'
  if (-not (Test-Path $d)) { return $false }
  $sess = Join-Path $d 'sessions'
  if ((Test-Path $sess) -and @(Get-ChildItem $sess -Recurse -File -Force -ErrorAction SilentlyContinue).Count -gt 0) { return $true }
  foreach ($name in @('settings.yaml', 'credentials.yaml', 'memory.db', 'tasks.db', 'persona.json', 'persona-history.jsonl', 'notifications.jsonl', 'evolution.jsonl', 'consistency.json', 'subconscious.json', 'ledger', 'storages')) {
    $p = Join-Path $d $name
    if (-not (Test-Path $p)) { continue }
    $it = Get-Item $p -Force
    if ($it.PSIsContainer) { if (@(Get-ChildItem $p -Recurse -File -Force -ErrorAction SilentlyContinue).Count -gt 0) { return $true } }
    elseif ($it.Length -gt 0) { return $true }
  }
  return $false
}
function Get-JunctionInfo([string]$link) {
  if (-not (Test-Path $link)) { return @{ exists = $false; isJunction = $false; target = '' } }
  $item = Get-Item $link -Force -ErrorAction SilentlyContinue
  if (($null -eq $item) -or ($item.LinkType -ne 'Junction')) { return @{ exists = $true; isJunction = $false; target = '' } }
  return @{ exists = $true; isJunction = $true; target = (($item.Target -join '') -replace '\\', '/').TrimEnd('/') }
}
function Test-JunctionPointsTo([string]$link, [string]$wantDir) {
  $j = Get-JunctionInfo $link
  if (-not $j.isJunction) { return $null }
  $want = $wantDir.TrimEnd('\').Replace('\', '/').TrimEnd('/')
  return [string]::Equals($j.target, $want, [System.StringComparison]::OrdinalIgnoreCase)
}
# 目录不存在或其中 dsh\data 为空 → 无数据可丢，指向它属"可安全自愈"
function Test-DirHealable([string]$dirPath) {
  if (-not (Test-Path $dirPath)) { return $true }
  return (-not (Test-DataPresent $dirPath))
}
$junction = Join-Path $projHome 'profiles\archive'
# 旧版 home（dsh\home）遗留清理：其中含指向 dsh 的链接，会让"整目录复制"递归/失败。
$legacyHome = Join-Path $dshDir 'home'
if (Test-Path -LiteralPath $legacyHome) {
  & cmd /c rmdir /s /q "`"$legacyHome`"" 2>$null | Out-Null
  if (-not (Test-Path -LiteralPath $legacyHome)) { Write-Host '[start] 已清理旧版 home（dsh\home）' -ForegroundColor Yellow }
}
if (Test-Path $junction) {
  $jit = Get-Item $junction -Force -ErrorAction SilentlyContinue
  if (($null -eq $jit) -or ($jit.LinkType -ne 'Junction')) {
    # 2026-09-11：文件夹被"复制"后，链接可能变成真实目录（复制工具解引用）——home 属运行时可再生
    # 产物（不含用户数据），这里直接移除并重建为链接，实现复制善后自愈。
    Write-Host "[start] profile 入口是真实目录（疑似复制所致），自动重建为链接..." -ForegroundColor Yellow
    & cmd /c rmdir /s /q "`"$junction`"" 2>$null | Out-Null
    if (Test-Path $junction) { Write-Host "[start] ERROR: 无法重建 profile 入口：$junction" -ForegroundColor Red; exit 1 }
    New-Item -ItemType Directory -Force -Path (Split-Path $junction -Parent) | Out-Null
    New-Item -ItemType Junction -Path $junction -Target $dshDir | Out-Null
    Write-Host "[start] 已重建项目内 profile 入口：$junction -> $dshDir" -ForegroundColor Green
  }
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $junction -Parent) | Out-Null
  New-Item -ItemType Junction -Path $junction -Target $dshDir | Out-Null
  Write-Host "[start] 已创建项目内 profile 入口：$junction -> $dshDir" -ForegroundColor Green
}
if (-not (Test-JunctionPointsTo $junction $dshDir)) {
  & cmd /c rmdir "`"$junction`"" 2>$null | Out-Null
  New-Item -ItemType Junction -Path $junction -Target $dshDir | Out-Null
  Write-Host "[start] 已修正项目内 profile 入口指向：$junction -> $dshDir" -ForegroundColor Yellow
}
$patchFile = Join-Path $dshDir 'cordis.patch.yml'
$dataPrefix = (($root.TrimEnd('\') -replace '\\', '/').TrimEnd('/')) + '/dsh/data'
$keyPat = '^\s*(root|path|dbPath|dataPath|dataRoot|personaPath|ledgerPath|skillsDir|notificationsPath|trajectoryPath|dshHome):\s*["'']?([A-Za-z]:[^"''#\r\n]+)'
$strayValues = @()
if (Test-Path $patchFile) {
  foreach ($line in [System.IO.File]::ReadAllLines($patchFile)) {
    if ($line -match $keyPat) {
      $v = (($Matches[2].Trim().TrimEnd('\', '/')) -replace '\\', '/')
      $okChild = [string]::Equals($v, $dataPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
                 $v.StartsWith($dataPrefix + '/', [System.StringComparison]::OrdinalIgnoreCase)
      if (-not $okChild) { $strayValues += $v }
    }
  }
}
if ($strayValues.Count -gt 0) {
  $healable = $true
  foreach ($v in $strayValues) {
    $idx = $v.IndexOf('/dsh/data')
    if ($idx -lt 0) { $healable = $false; break }
    if (-not (Test-DirHealable ($v.Substring(0, $idx) -replace '/', '\'))) { $healable = $false; break }
  }
  if ($healable) {
    Write-Host '[start] 检测到数据路径指向已失效/空白位置（文件夹被移动或更新未完成），自动归一化一次（等价于运行《首次安装或移动项目位置点我.cmd》）...' -ForegroundColor Yellow
    $fix = Join-Path $root 'fix-project-location.ps1'
    if (-not (Test-Path $fix)) {
      Write-Host '[start] ERROR: 缺少 fix-project-location.ps1，无法自动归一化。' -ForegroundColor Red
      exit 1
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $fix -NoPrompt
    if ($LASTEXITCODE -ne 0) {
      Write-Host '[start] ERROR: 自动归一化未通过，请手动双击《首次安装或移动项目位置点我.cmd》查看原因。' -ForegroundColor Red
      exit 1
    }
    $stray2 = 0
    if (Test-Path $patchFile) {
      foreach ($line in [System.IO.File]::ReadAllLines($patchFile)) {
        if ($line -match $keyPat) {
          $v = (($Matches[2].Trim().TrimEnd('\', '/')) -replace '\\', '/')
          $okChild = [string]::Equals($v, $dataPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
                     $v.StartsWith($dataPrefix + '/', [System.StringComparison]::OrdinalIgnoreCase)
          if (-not $okChild) { $stray2++ }
        }
      }
    }
    if ($stray2 -ne 0) {
      Write-Host '[start] ERROR: 自动归一化后数据路径仍不一致，请手动运行《首次安装或移动项目位置点我.cmd》检查。' -ForegroundColor Red
      exit 1
    }
    Write-Host '[start] 自动归一化完成，继续启动。' -ForegroundColor Green
  } else {
    Write-Host '[start] ERROR: 拒绝启动——dsh\cordis.patch.yml 的数据路径指向"存在且含数据"的其它位置：' -ForegroundColor Red
    $strayValues | ForEach-Object { Write-Host ('[start]     ' + $_) -ForegroundColor Red }
    Write-Host "[start] 本副本应为：$dataPrefix" -ForegroundColor Red
    Write-Host '[start] 常见情形：本目录是空白副本而数据在另一副本，或更新/移动后归一化未完成。' -ForegroundColor Yellow
    Write-Host '[start] 请到"含你数据的副本"目录启动；或在本目录运行《首次安装或移动项目位置点我.cmd》后按提示确认。' -ForegroundColor Yellow
    exit 1
  }
} else {
  Write-Host '[start] 环境自检通过（项目内引擎 + 项目内 profile 入口 + 数据路径一致）。' -ForegroundColor Green
}

# 1.6) 项目 home 的 agent preset（2026-09-11 独立化）：preset 的加载位置由 DSH_HOME 决定，
#      必须在引擎启动前就位，否则主会话会因 "preset archive-standard not found" 而 resume 失败
#      （既有安装从 ~/.dsh 迁移过来时尤其重要）。幂等：仅缺失时复制，不覆盖已有内容。
$presetSrc = Join-Path $root 'presets\archive-standard'
$presetDst = Join-Path $projHome '.agent-presets\archive-standard'
if ((Test-Path $presetSrc) -and -not (Test-Path $presetDst)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $presetDst -Parent) | Out-Null
  Copy-Item $presetSrc $presetDst -Recurse -Force
  Write-Host "[start] 已就位 agent preset 到项目 home（$presetDst）" -ForegroundColor Green
}

# 2) sync project plugins (latest code + rebuild dsh-tools junction)
if (-not $NoSync) {
  Write-Host '[start] syncing project plugins...'
  & (Join-Path $dshDir 'scripts\sync-plugins.ps1')
}

# 2.5) project-bundled ollama (2026-08-30: download-the-project = ready-to-use embedding).
#      OLLAMA_MODELS points inside the project folder, so the bundled instance never touches
#      a global ollama model store; if port 11434 is already served by an external ollama,
#      reuse it (no PID file is written, so stop.ps1 will not kill it).
#      2026-09-04 fix: verify the 11434 listener is really an ollama process before reusing
#      it - an unrelated service on that port must not suppress the bundled ollama start.
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

# 3) Single-instance guard (2026-08-31 fix: dual-instance incident - a stale instance on
#    3111/3113 was invisible to the old check that only probed 3081, so a second instance
#    started and both shared the same data dir, splitting conversations/memory).
#    Checks (a) PID file (dsh\data\dsh.pid, written after successful start with the
#                3081 listener PID)
#           (b) any of target port 3081 and legacy ports 3111/3113 being listened.
#    2026-09-04 fix: RetainDB Local (dsh-mnemon memory provider, auto-started by
#    %USERPROFILE%\.dsh\scripts\restore-dsh-services.ps1) permanently listens on
#    3111/3113, which made this guard falsely report "already running" and refuse to
#    start on 3081. Detect it via its health endpoint and exempt both legacy ports.
function Test-PidAlive([int]$id) {
  try { return $null -ne (Get-Process -Id $id -ErrorAction Stop) } catch { return $false }
}
# 2026-09-04 fix: the PID file records the 3081 listener PID at start time; after dsh exits
# that PID may be recycled by the OS to an unrelated process (e.g. RetainDB is also a node
# process), which would falsely block startup. Only trust the PID file when the process is
# still a node process AND still owns the 3081 listener.
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
        # 2026-09-04 fix: only treat the listener as a running dsh instance when it is
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
  Open-Console
  exit 0
}

# 3.5) log rotation (2026-08-30): keep archive.log under 10 MB - rename to .old on start
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
# Log encoding (2026-08-30 fix): redirect via cmd /c - cmd writes bytes as-is, so dsh
#       UTF-8 output lands verbatim; PS 5.1 *>> would transcode to ANSI/GBK and garble it.
# 2026-09-11 独立化：启动【项目自带引擎】（node <项目>\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js），
#       并通过 cmd set 只在本次子进程内注入 DSH_HOME=<项目>\.dsh-home —— 全局 dsh 与 ~/.dsh
#       的任意改动都不参与本项目运行（原 DSH 升级/卸载/家目录清理均无影响）。
Write-Host "[start] starting control UI at http://127.0.0.1:$port (log: $log)"
$cmd = "set `"DSH_HOME=$projHome`" && node `"$engineBin`" --profile archive --port $port --no-open >> `"$log`" 2>&1"
Start-Process cmd -ArgumentList @('/c', $cmd) -WindowStyle Hidden

# 5) wait until ready
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Port $port) { $ready = $true; break }
}
if ($ready) {
  # 2026-08-31 single-instance guard: record the 3081 listener PID for the next start.
  try {
    $listener = @(netstat -ano | Select-String (":$port\s") | ForEach-Object {
      if ($_ -match 'LISTENING\s+(\d+)\s*$') { [int]$Matches[1] }
    } | Select-Object -Unique | Select-Object -First 1)
    if ($listener.Count -gt 0 -and $listener[0]) { $listener[0] | Out-File $dshPidFile -Encoding ascii }
  } catch { }
  # System tray resident (2026-08-30 v2: tray.ps1 idempotent, keeps a single instance).
  Start-Tray
  Write-Host "[start] SUCCESS: http://127.0.0.1:$port" -ForegroundColor Green
  Open-Console
} else {
  Write-Host "[start] not ready in 30s; see log: $log" -ForegroundColor Yellow
  if (Test-Path $log) { Get-Content $log -Tail 20 }
}
