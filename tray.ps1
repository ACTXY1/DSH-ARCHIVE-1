# DSH-ARCHIVE 系统托盘常驻（ v3）
# 用法：由 start.ps1 自动启动；或手动 powershell -File tray.ps1
# 功能：左键单击打开控制台；右键菜单 = 打开/重启/停止服务、退出托盘。
# v3 变更：PID 文件写入提前到 Add-Type 之前（消除"托盘未就绪时关闭按钮错过清理"的竞态）。
# v2 变更：幂等（互斥锁，同一时刻只保留一个托盘实例，杜绝进程堆积）；
#          PID 记录到 dsh\data\tray.pid（两行：PID / 进程名），供 stop.ps1 与关闭按钮清理；
#          图标优先使用项目自带 assets\tray.ico，缺失时回退通用图标。

$url = 'http://127.0.0.1:3081'
$root = Split-Path $MyInvocation.MyCommand.Definition -Parent
$stopScript = Join-Path $root 'stop.ps1'
$startScript = Join-Path $root 'start.ps1'
$dataDir = Join-Path $root 'dsh\data'
$pidFile = Join-Path $dataDir 'tray.pid'
#：新版 dsh web（≥0.1.2）带浏览器鉴权，需打开 start.ps1 写入 dsh\data\web.url 的
# 带 token 地址（首次访问签发 Cookie 后普通地址亦可）；旧版 dsh 无该文件则回落纯地址。
$urlFile = Join-Path $dataDir 'web.url'
function Get-ConsoleUrl {
  try {
    $u = Get-Content $urlFile -TotalCount 1 -ErrorAction Stop
    if ($u -and $u.Trim()) { return $u.Trim() }
  } catch { }
  return $url
}

# --- 幂等：已有托盘实例则直接退出 ---
$mutex = New-Object System.Threading.Mutex($false, 'DSH-ARCHIVE-Tray-3081')
if (-not $mutex.WaitOne(0)) {
  exit 0
}

# --- 尽早记录 PID 与进程名（Add-Type 之前；否则托盘初始化需数秒，关闭按钮可能错过清理） ---
#  失败不再静默——写入诊断日志，避免 v3 竞态修复静默降级（stop.ps1/关闭按钮找不到 tray.pid）。
try {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  "$PID`npowershell" | Out-File $pidFile -Encoding ascii
} catch {
  try { Add-Content -Path (Join-Path $env:TEMP 'dsh-tray.log') -Value ("{0} tray.pid 写入失败: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message) -Encoding UTF8 } catch { }
}

#  Add-Type/初始化失败时清理 PID 文件并释放互斥锁，避免遗留过期 tray.pid
# 导致 stop.ps1/关闭按钮误判（PID 复用时可误杀无关 powershell）。
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  try { $mutex.Dispose() } catch { }
  throw
}

# --- 图标：优先项目自带 assets\tray.ico ---
$icon = $null
$iconPath = Join-Path $root 'assets\tray.ico'
if (Test-Path $iconPath) {
  try { $icon = New-Object System.Drawing.Icon($iconPath) } catch { $icon = $null }
}
if ($null -eq $icon) { $icon = [System.Drawing.SystemIcons]::Application }

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Text = 'DSH-ARCHIVE 智能体'
$tray.Icon = $icon
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('打开控制台', $null, { param($s, $e) [void][System.Diagnostics.Process]::Start((Get-ConsoleUrl)) })
$restartItem = $menu.Items.Add('重启服务', $null, {
  param($s, $e)
  Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "& '$stopScript'; Start-Sleep -Seconds 3; & '$startScript' -NoOpen -NoSync") -WindowStyle Hidden
})
$stopItem = $menu.Items.Add('停止服务', $null, {
  param($s, $e)
  Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $stopScript) -WindowStyle Hidden
})
[void]$menu.Items.Add('-')
$exitItem = $menu.Items.Add('退出托盘', $null, {
  param($s, $e)
  $tray.Visible = $false
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  [System.Windows.Forms.Application]::Exit()
})
$tray.ContextMenuStrip = $menu

$tray.Add_MouseClick({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    [void][System.Diagnostics.Process]::Start((Get-ConsoleUrl))
  }
})

[System.Windows.Forms.Application]::Run()
