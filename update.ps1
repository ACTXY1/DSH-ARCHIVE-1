# ============================================================
#  update.ps1 —— DSH-ARCHIVE 一键更新 / 一键回滚（Windows）
#
#  双击入口：《一键更新.cmd》（更新到最新） / 《一键回滚.cmd》（回退上一发布版）
#  手动：
#    powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1
#    powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Rollback
#    powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1 -Rollback -TargetTag v2026-09-01
#  开发/测试开关：-NoFetch（跳过 fetch） -NoStop（不停服） -NoFix（跳过 fix 步骤） -NoStart（更新后不启动）
#
#  流程：互斥 → 校验项目根 → 校验 git → fetch（失败不打断服务）→ 版本比较
#        （已最新则退出）→ 备份本地改动 → 停服 → 强制检出 → 依赖变更检测+install
#        → preset 强制同步 → fix-project-location（路径归一化/junction/依赖兜底/验证）
#        → 摘要 → 启动
#
#  数据安全：dsh\data、ollama、backups 为 untracked，强制检出绝不触碰；
#            本地对共享代码的改动自动备份为 .patch（backups\update-backup\）。
# ============================================================
param(
    [switch]$Rollback,
    [string]$TargetTag = '',
    [switch]$NoFetch,    # 开发测试：跳过 git fetch（使用本地已有 origin/main 引用）
    [switch]$NoStop,     # 开发测试：不停止服务
    [switch]$NoFix,      # 开发测试：跳过 fix-project-location
    [switch]$NoStart     # 开发测试：更新后不启动
)

# PS 5.1 关键行为：EAP='Stop' 下原生 stderr 一旦被重定向（2>&1/2>$null/*>）或管道化，
# 会被当作终止性错误误抛（git 的 CRLF 警告也会触发）。因此全脚本用 'Continue' +
# 显式 $LASTEXITCODE 检查；需要硬失败的关键 cmdlet 单独加 -ErrorAction Stop。
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot

function Write-Step($t) { Write-Host ("`n== " + $t) -ForegroundColor Cyan }
function Write-Ok($t)   { Write-Host ("  [OK] " + $t) -ForegroundColor Green }
function Write-Warn($t) { Write-Host ("  [!] " + $t) -ForegroundColor DarkYellow }
function Write-Err($t)  { Write-Host ("  [错] " + $t) -ForegroundColor Red }

# 执行原生命令：2>&1 捕获输出回显，返回真实退出码（EAP=Continue 下不误抛、码可靠）
function Exec-Native([scriptblock]$cmd) {
    $out = & $cmd 2>&1
    $code = $LASTEXITCODE
    foreach ($line in $out) { Write-Host ("  " + $line) }
    return $code
}

# 路径归一化到统一记号（比较用）：把「盘符:...DSH-ARCHIVE」路径换成 <ROOT>，行尾不敏感
function Convert-PathToCanon([string]$text) {
    $esc = [char]0xE000
    $t = $text.Replace('\\', '\' + $esc)
    $t = [regex]::Replace($t, '([A-Za-z]):([\\/])([^":''\r\n<>|`]*)DSH-ARCHIVE', { param($m) '<ROOT>' })
    $t = $t.Replace('\' + $esc, '\\')
    return ($t -replace "`r`n", "`n")
}

# 手机专属剔除（与 sync-packages 的 Windows 打包剔除同一逻辑）
$mobBlockMarker = '# [手机分发包专属'
$mobDepLine = '"dsh-archive-mobile-ui": "file:../modules/mobile-ui",'
function Remove-MobileBlock([string]$text) {
    $idx = $text.IndexOf($mobBlockMarker)
    if ($idx -lt 0) { return $text }
    return $text.Substring(0, $idx).TrimEnd("`r", "`n") + "`r`n"
}
function Remove-MobileDep([string]$text) {
    return $text -replace ('[ \t]*' + [regex]::Escape($mobDepLine) + '(\r\n|\n)'), ''
}

# 取 HEAD 版本文件内容（cmd /c 原生重定向取原始字节——PS 管道会按控制台编码转码中文致乱码）
function Get-HeadText([string]$rel) {
    $tmp = Join-Path $env:TEMP ("dsh-head-" + [guid]::NewGuid().ToString('N'))
    cmd /c "git -C `"$root`" show `"HEAD:$rel`" > `"$tmp`" 2>nul"
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp)) { return $null }
    $t = [System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    return $t
}

# 判断某文件是否为"真实改动"（非归一化伪差异 / 非设计性平台剔除）
function Test-RealChange([string]$rel) {
    if ($wasStripped -and $rel -like 'modules/mobile-ui/*') { return $false }   # Windows 包设计剔除
    $wf = Join-Path $root $rel
    if (-not (Test-Path $wf)) { return $true }   # 删除 = 真实改动
    $ext = [System.IO.Path]::GetExtension($rel.Replace('/', '\')).ToLowerInvariant()
    if ($ext -notin @('.yml', '.yaml', '.ps1', '.md', '.txt', '.json', '.js', '.cjs', '.mjs', '.cmd', '.bat', '.sh', '.html', '.css', '.ts', '.vbs', '.xml', '.cfg', '.conf', '.ini', '.properties', '.env', '.csv')) { return $true }
    $head = Get-HeadText $rel
    if ($null -eq $head) { return $true }   # HEAD 无此文件（新增）
    if ($wasStripped) {
        # 对 HEAD 侧套用与打包相同的剔除，比较才一致
        if ($rel -eq 'dsh/cordis.patch.yml') { $head = Remove-MobileBlock $head }
        if ($rel -eq 'dsh/package.json')     { $head = Remove-MobileDep $head }
    }
    $a = Convert-PathToCanon ([System.IO.File]::ReadAllText($wf))
    $b = Convert-PathToCanon $head
    return ($a -cne $b)
}

# 读取当前版本（VERSION 文件优先，缺失则取最近 tag）
function Get-Version {
    $v = Get-Content (Join-Path $root 'VERSION') -Raw -ErrorAction SilentlyContinue
    if ($v -and $v.Trim()) { return $v.Trim() }
    return (& git -C $root describe --tags --abbrev=0 2>$null | Select-Object -First 1)
}

# 追加更新日志（dsh\logs\update.log）
function Write-Log([string]$msg) {
    try {
        $logDir = Join-Path $root 'dsh\logs'
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        [System.IO.File]::AppendAllText((Join-Path $logDir 'update.log'),
            ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) + "`r`n",
            (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# ---- 代理支持（2026-09-03）：git 不读 Windows 系统代理——开着 v2rayN/Clash 等代理软件时，
#      若只设了系统代理（或仅监听 socks 口），git fetch 仍直连必失败。解析顺序：
#      ①环境变量 → ②git 全局/本地 http.proxy（显式空值=强制直连）→ ③Windows 系统代理。
#      纯 host:port 无法判断协议 → 先探测端口协议（socks5h / http），避免把 socks 口当 http 用。
#      返回 @{ args = git 附加参数数组; text = 展示文本 } ----
function Get-GitProxy {
    $proxy = $null
    foreach ($k in @('HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy')) {
        $v = (Get-Item ("env:$k") -ErrorAction SilentlyContinue).Value
        if ($v) { $proxy = $v; break }
    }
    if (-not $proxy) {
        $g = (& git config --get http.proxy 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0) {
            if ([string]::IsNullOrEmpty($g)) { return @{ args = @(); text = '已按 git 配置强制直连' } }
            $proxy = $g
        }
    }
    if (-not $proxy) {
        $reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($reg.ProxyEnable -and $reg.ProxyServer) { $proxy = [string]$reg.ProxyServer }
    }
    if (-not $proxy) { return @{ args = @(); text = '未配置代理（git 直连）' } }
    # 归一化：无 scheme 时先解 IE 多段式（http=..;https=..），取 https 段优先，再探测协议
    if ($proxy -notmatch '^[a-zA-Z][a-zA-Z0-9+.\-]*://') {
        $segs = @($proxy -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $kv = @{}; $plain = @()
        foreach ($s in $segs) {
            if ($s -match '^([a-zA-Z]+)=(.*)$') { $kv[$Matches[1].ToLower()] = $Matches[2].Trim() }
            else { $plain += $s }
        }
        $proxy = if ($kv['https']) { $kv['https'] } elseif ($kv['http']) { $kv['http'] } elseif ($kv['socks']) { $kv['socks'] } else { $plain[0] }
        if (-not $proxy) { return @{ args = @(); text = '未配置代理（git 直连）' } }
        $proxy = $proxy -replace '^[a-zA-Z][a-zA-Z0-9+.\-]*://', ''
    }
    if ($proxy -match '^socks5://') {
        $proxy = 'socks5h://' + $proxy.Substring(9)   # socks5 改远端 DNS：防本地 DNS 污染把 github 解析到假 IP
    } elseif ($proxy -notmatch '^[a-zA-Z][a-zA-Z0-9+.\-]*://') {
        $scheme = Test-ProxyProtocol $proxy
        $proxy = ($(if ($scheme) { $scheme } else { 'http' })) + '://' + $proxy
    }
    return @{ args = @('-c', "http.proxy=$proxy", '-c', "https.proxy=$proxy"); text = "代理 $proxy（自动识别）" }
}

# 探测代理端口协议：socks5 握手成功（05 00）→'socks5h'；http CONNECT 回 HTTP/1.x 状态行 →'http'；否则 $null
function Test-ProxyProtocol([string]$server) {
    $idx = $server.LastIndexOf(':')
    if ($idx -le 0) { return $null }
    $h = $server.Substring(0, $idx)
    $port = [int]$server.Substring($idx + 1)
    if ($h.StartsWith('[') -and $h.EndsWith(']')) { $h = $h.Substring(1, $h.Length - 2) }
    if (-not $port) { return $null }
    $tcp = $null
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect($h, $port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(1500)) { return $null }
        $tcp.EndConnect($iar)
        $ns = $tcp.GetStream()
        $ns.ReadTimeout = 2000; $ns.WriteTimeout = 2000
        # ① socks5 握手（发 05 01 00，期待回 05 00）
        $ns.Write([byte[]](0x05,0x01,0x00), 0, 3); $ns.Flush()
        $resp = New-Object byte[] 2
        if ($ns.Read($resp, 0, 2) -eq 2 -and $resp[0] -eq 0x05 -and $resp[1] -eq 0x00) { return 'socks5h' }
        # ② http CONNECT 探测（代理会回 HTTP/1.x 状态行）
        $req = [System.Text.Encoding]::ASCII.GetBytes("CONNECT github.com:443 HTTP/1.1`r`nHost: github.com:443`r`n`r`n")
        $ns.Write($req, 0, $req.Length); $ns.Flush()
        $buf = New-Object byte[] 512
        $n = $ns.Read($buf, 0, 512)
        if ($n -gt 0 -and [System.Text.Encoding]::ASCII.GetString($buf, 0, $n) -match '^HTTP/1\.[01] \d{3}') { return 'http' }
    } catch { return $null }
    finally { if ($tcp) { try { $tcp.Close() } catch { } } }
    return $null
}

# ---------- 0. 单实例互斥（防双击/并发误操作） ----------
$mutex = $null
try { $mutex = New-Object System.Threading.Mutex($false, 'DSH-ARCHIVE-Update') } catch { }
if ($mutex -and -not $mutex.WaitOne(0)) {
    Write-Err '已有更新/回滚正在进行，请稍后再试。'
    exit 1
}
try {

    Write-Host '============================================'
    Write-Host ('  DSH-ARCHIVE ' + $(if ($Rollback) { '一键回滚' } else { '一键更新' }))
    Write-Host ("  项目根：{0}" -f $root)
    Write-Host '============================================'

    # ---------- 1. 校验项目根（防脚本被复制/挪到别处） ----------
    if (-not (Test-Path (Join-Path $root 'dsh\cordis.patch.yml')) -or -not (Test-Path (Join-Path $root 'dsh\package.json'))) {
        Write-Err '未识别为 DSH-ARCHIVE 项目根。请把《一键更新.cmd》《一键回滚.cmd》与 update.ps1 放在项目根目录（与 dsh/ 文件夹同级）再运行。'
        exit 1
    }

    # ---------- 2. 校验 git 与仓库 ----------
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Err '未检测到 git。请先安装 Git for Windows（winget install Git.Git 或 https://git-scm.com）后重试。'
        exit 1
    }
    if (-not (Test-Path (Join-Path $root '.git'))) {
        Write-Err '缺少仓库元数据（.git 不存在）。请重新领取最新分发包，或联系开发者获取更新地址。'
        exit 1
    }
    $code = Exec-Native { git -C $root remote get-url origin }
    if ($code -ne 0) {
        Write-Err '未配置远程仓库 origin。请重新领取分发包，或手动执行：git remote add origin <仓库地址>'
        exit 1
    }

    $oldVer = Get-Version
    $cur = (& git -C $root rev-parse HEAD 2>$null).Trim()

    # 识别"Windows 已剔除 mobile-ui 的分发包"（无 modules\mobile-ui）：更新后需重新剔除，
    # 且备份/比较时把 mobile-ui 相关差异视为设计性剔除而非用户改动
    $wasStripped = -not (Test-Path (Join-Path $root 'modules\mobile-ui'))

    # ---------- 3. fetch（失败不打扰正在运行的服务） ----------
    if (-not $NoFetch) {
        Write-Step '拉取远程更新（git fetch）'
        $gitProxy = Get-GitProxy
        $gitProxyArgs = $gitProxy.args
        if ($gitProxy.text) { Write-Host ("  git 网络通道：" + $gitProxy.text) }
        $code = Exec-Native { git @gitProxyArgs -C $root fetch origin }
        if ($code -ne 0) {
            Write-Err ("拉取失败：网络不通或凭据无效（" + $gitProxy.text + "）。服务未受影响，可稍后重试。")
            Write-Log ("更新中止：git fetch 失败（" + $gitProxy.text + "）")
            exit 1
        }
    } else {
        Write-Step '跳过 fetch（-NoFetch，测试用：使用本地已有 origin/main 引用）'
    }

    # ---------- 4. 确定目标版本 ----------
    if (-not $Rollback) {
        $new = (& git -C $root rev-parse origin/main 2>$null).Trim()
        if (-not $new) {
            Write-Err '远程仓库没有 main 分支（远程为空或未推送？）。'
            exit 1
        }
        if ($cur -eq $new) {
            Write-Ok ("已是最新版本（{0}），无需更新。" -f $oldVer)
            exit 0
        }
        # 方向守卫：本地领先远程（如开发者忘了 push）→ 拒绝"降级更新"
        $ahead = (& git -C $root rev-list --count "$new..$cur" 2>$null | Select-Object -First 1).Trim()
        if ([int]$ahead -gt 0) {
            Write-Err "本地存在 $ahead 个远程没有的提交（可能是开发者本机忘了推送）。为避免降级，已中止更新。"
            Write-Host '  请先推送本地提交：git push origin main，再重试一键更新。' -ForegroundColor DarkYellow
            exit 1
        }
        $target = 'origin/main'
        $mode = '更新'
    } else {
        if ($TargetTag) {
            $code = Exec-Native { git -C $root rev-parse "$TargetTag" }
            if ($code -ne 0) { Write-Err ("标签不存在：{0}" -f $TargetTag); exit 1 }
        } else {
            $tags = @(& git -C $root tag -l 'v*' | Sort-Object -Descending)
            if ($tags.Count -lt 2) { Write-Err '没有可回退的历史版本（仅有一个发布标签）。'; exit 1 }
            $TargetTag = $tags[1]   # 跳过最新，取上一个发布版
        }
        $target = $TargetTag
        $mode = "回滚到 $TargetTag"
    }
    Write-Step ("目标：{0}" -f $target)

    # ---------- 5. 备份本地对共享代码的改动（防自定义配置被覆盖丢失） ----------
    # 过滤"归一化伪差异"：分发包内容按平台预归一化（路径改写），与 git HEAD 内容天然不同，
    # git status 恒显示 modified——这类差异不是用户改动，不备份不警告。
    $dirty = @(& git -C $root -c core.quotepath=false status --porcelain |
        Where-Object { $_ -notmatch '^\?\?' } |
        Where-Object { Test-RealChange ($_.Substring(3).Trim('"')) })
    if ($dirty.Count -gt 0) {
        $bkDir = Join-Path $root 'backups\update-backup'
        New-Item -ItemType Directory -Path $bkDir -Force | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $patch = Join-Path $bkDir ("{0}-changes.patch" -f $stamp)
        [System.IO.File]::WriteAllText($patch, (& git -C $root diff 2>$null | Out-String), (New-Object System.Text.UTF8Encoding($false)))
        if (-not (Test-Path $patch)) {
            Write-Warn '本地改动备份写入失败（backups\update-backup\），继续更新但无法恢复这些改动。'
        } else {
            Write-Warn ("检测到 {0} 个对共享代码的本地改动，已备份：{1}" -f $dirty.Count, $patch.Replace($root, '.'))
        }
        Write-Warn '强制检出将覆盖这些改动；用户数据（dsh\data、ollama、backups）不受影响。'
    }

    # ---------- 6. 停止服务 ----------
    if (-not $NoStop) {
        Write-Step '停止服务'
        $stop = Join-Path $root 'stop.ps1'
        if (Test-Path $stop) {
            $code = Exec-Native { powershell -NoProfile -ExecutionPolicy Bypass -File $stop }
            if ($code -ne 0) { Write-Warn '停止服务未完全成功（端口仍占用？），继续尝试更新。' }
        }
    }

    # ---------- 7. 强制检出（tracked 覆盖；untracked 用户数据保留） ----------
    Write-Step ("{0}：检出 {1}" -f $mode, $target)
    # 强制检出并使 main 分支指向目标（HEAD 始终在 main 上，避免 detached HEAD）
    $code = Exec-Native { git -C $root checkout -f -B main $target }
    if ($code -ne 0) { throw "git checkout 失败（$target）" }

    # 平台形态保持：Windows 已剔除 mobile-ui 的分发包，检出会还原手机代码 → 重新剔除
    if ($wasStripped -and (Test-Path (Join-Path $root 'modules\mobile-ui'))) {
        Write-Step '重新剔除手机专属 mobile-ui（保持 Windows 包形态）'
        Remove-Item (Join-Path $root 'modules\mobile-ui') -Recurse -Force -ErrorAction SilentlyContinue
        $cp = Join-Path $root 'dsh\cordis.patch.yml'
        if (Test-Path $cp) {
            $t = [System.IO.File]::ReadAllText($cp)
            $nt = Remove-MobileBlock $t
            if ($nt -cne $t) { [System.IO.File]::WriteAllText($cp, $nt, (New-Object System.Text.UTF8Encoding($false))) }
        }
        $pj = Join-Path $root 'dsh\package.json'
        if (Test-Path $pj) {
            $t = [System.IO.File]::ReadAllText($pj)
            $nt = Remove-MobileDep $t
            if ($nt -cne $t) { [System.IO.File]::WriteAllText($pj, $nt, (New-Object System.Text.UTF8Encoding($false))) }
        }
    }

    # ---------- 8. 依赖变更检测（package.json / lock 有变才 install） ----------
    $depChanged = @(& git -C $root diff --name-only $cur $target -- dsh/package.json dsh/pnpm-lock.yaml)
    if ($depChanged.Count -gt 0) {
        Write-Step '依赖清单已变更，执行 pnpm install'
        Push-Location (Join-Path $root 'dsh')
        try {
            $code = Exec-Native { pnpm install --config.confirmModulesPurge=false }
            if ($code -ne 0) { throw 'pnpm install 失败' }
        } finally { Pop-Location }
        $ej = Join-Path $root 'dsh\scripts\ensure-tools-junction.ps1'
        if (Test-Path $ej) {
            $code = Exec-Native { powershell -NoProfile -ExecutionPolicy Bypass -File $ej }
        }
    }

    # ---------- 9. agent preset 强制同步（fix 的"存在即跳过"在更新场景不够） ----------
    # 2026-09-11 独立化：preset 目标改为【项目 home】内的 .agent-presets（不再写 ~/.dsh）。
    $presetSrc = Join-Path $root 'presets\archive-standard'
    if (Test-Path $presetSrc) {
        $presetDst = Join-Path $root '.dsh-home\.agent-presets\archive-standard'
        New-Item -ItemType Directory -Path (Split-Path $presetDst -Parent) -Force -ErrorAction SilentlyContinue | Out-Null
        if (Test-Path $presetDst) { Remove-Item $presetDst -Recurse -Force -ErrorAction SilentlyContinue }
        Copy-Item $presetSrc $presetDst -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $presetDst) { Write-Ok 'agent preset 已同步（项目 home）' }
        else { Write-Warn 'agent preset 同步失败（.dsh-home\.agent-presets），更新继续。' }
    }

    # ---------- 10. 位置归一化 + 依赖兜底 + 插件同步 + 验证（复用 fix，-NoPrompt 免交互） ----------
    if (-not $NoFix) {
        $fix = Join-Path $root 'fix-project-location.ps1'
        if (Test-Path $fix) {
            Write-Step '运行位置归一化与完整性修复（fix-project-location -NoPrompt）'
            $code = Exec-Native { powershell -NoProfile -ExecutionPolicy Bypass -File $fix -NoPrompt }
            # 2026-09-05：fix 失败(含 junction 防呆中止/归一化未完成)必须中止更新，不能再启动服务——
            # 否则 cordis.patch.yml 可能残留仓库标准路径 C:/DSH-ARCHIVE，服务会把数据读写到错误位置，
            # 表现为"重进后对话记录与模型提供商配置为空"。
            if ($code -ne 0) { throw '位置归一化(fix)未通过——数据根可能未修正，已中止以免读写错位数据。请按上方提示处理后重试，或回滚。' }
        }
    }

    # ---------- 11. 摘要 + 日志 + 启动 ----------
    $newVer = Get-Version
    Write-Step '完成'
    Write-Ok ("新版本：{0}" -f $newVer)
    if (-not $Rollback) {
        $log = @(& git -C $root log --oneline --no-decorate "$cur..$target")
        if ($log.Count -gt 0) {
            Write-Host '  更新内容：'
            $log | ForEach-Object { Write-Host ("    " + $_) }
        }
    }
    if (-not $NoStart) {
        $start = Join-Path $root 'start.ps1'
        if (Test-Path $start) {
            Write-Step '启动服务'
            $code = Exec-Native { powershell -NoProfile -ExecutionPolicy Bypass -File $start }
        }
    }
    Write-Log ("{0} 完成（{1} -> {2}，版本 {3}）" -f $mode, $cur, $target, $newVer)
    Write-Host '============================================'
    Write-Host ('  ' + $mode + '完成！') -ForegroundColor Green
    Write-Host '  如需撤销本次变更：双击《一键回滚.cmd》' -ForegroundColor DarkYellow
    Write-Host '============================================'

} catch {
    Write-Log ("异常类型：" + $_.Exception.GetType().FullName)
    Write-Log ("堆栈：" + $_.ScriptStackTrace)
    Write-Err ('更新失败：' + $_.Exception.Message)
    Write-Host '  请重试；若反复失败，双击《一键回滚.cmd》回到上一版本。' -ForegroundColor DarkYellow
    Write-Log ("{0} 失败：{1}" -f $(if ($Rollback) { '回滚' } else { '更新' }), $_.Exception.Message)
    exit 1
} finally {
    if ($mutex) { try { $mutex.ReleaseMutex() } catch { }; try { $mutex.Dispose() } catch { } }
}
