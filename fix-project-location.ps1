# ============================================================
#  fix-project-location.ps1  （双击入口：首次安装或移动项目位置点我.cmd）
#
#  用途：项目被移动/复制到新位置后（或首次安装），一键检测当前用户环境、
#        配置项目全部前置与依赖、修复所有依赖旧位置/旧机器的问题：
#          0. 校验项目根
#          1. 环境检测：OS / PowerShell / 网络 / Node.js / npm / pnpm / 项目自带 dsh 引擎
#          2. 前置自动安装：Node.js（winget）、pnpm、项目 dsh 引擎依赖（pnpm install）；项目 home 初始化
#          3. 项目内 profile 入口（<项目>\.dsh-home\profiles\archive -> <项目>\dsh）
#          4. 项目内旧绝对路径引用重写（仅功能文件：cordis.patch.yml/脚本/配置；跳过 .md/.txt 文档与 URL，防误写）
#          5. dsh-tools junction 与 modules -> node_modules 插件同步
#          6. 数据目录存在性
#          7. profile 可加载性验证（项目引擎 + DSH_HOME=项目 home：--profile archive --dump-config）
#          8. ollama 向量模型运行时（无本机 ollama 时自动下载，首次启动自动拉取嵌入模型）
#
#  用法：双击同目录《首次安装或移动项目位置点我.cmd》；
#        或 powershell -NoProfile -ExecutionPolicy Bypass -File "fix-project-location.ps1"
#        加 -DryRun 只检查报告、不修改任何内容。
#
#  设计：脚本位置即项目根（$PSScriptRoot），不硬编码任何绝对路径，
#        因此主文件夹/分发包/新机器均可直接使用。
# ============================================================
param([switch]$DryRun, [switch]$NoPrompt)

$ErrorActionPreference = 'Stop'
# 交互收口：-NoPrompt（一键更新自动调用）时不等待回车；交互双击场景保持原样
function Read-Exit { if (-not $NoPrompt) { Read-Host '按回车退出' } }
$root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($root)) { $root = (Get-Location).Path }
$userHome = if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) { $env:USERPROFILE } else { $env:HOMEDRIVE + $env:HOMEPATH }

# ---------------- 工具函数 ----------------
function Write-Step($text) { Write-Host ("`n== " + $text) -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host ("  [OK] " + $text) -ForegroundColor Green }
function Write-Skip($text) { Write-Host ("  [--] " + $text) -ForegroundColor DarkGray }
function Write-Fix($text)  { Write-Host ("  [改] " + $text) -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host ("  [错] " + $text) -ForegroundColor Red }
function Write-Warn($text) { Write-Host ("  [!] " + $text) -ForegroundColor DarkYellow }

# 归一化路径：小写、\ -> /、去尾部分隔符（用于比较）
function Normalize-Path([string]$p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return '' }
    return (($p.Trim().TrimEnd('\', '/')) -replace '\\', '/').ToLowerInvariant()
}
# 读取 junction 目标（非 junction 返回 $null）
function Get-JunctionTarget($path) {
    $item = Get-Item $path -Force -ErrorAction SilentlyContinue
    if (-not $item -or $item.LinkType -ne 'Junction') { return $null }
    return Normalize-Path (($item.Target -join ''))
}
# 安全重建 junction（先删旧链接，不触碰目标内容）
function Set-Junction($link, $target) {
    if (Test-Path $link) {
        $item = Get-Item $link -Force
        if ($item.LinkType -ne 'Junction') {
            throw "「$link」存在但不是 junction（是真实目录），为避免误删请手动处理后再运行。"
        }
        # rmdir 只删除 reparse point 本身，不递归目标、无确认提示（Remove-Item 在非交互/悬空目标时可能弹确认框）
        & cmd /c rmdir "`"$link`"" | Out-Null
        if (Test-Path $link) { throw "删除旧联接失败：$link" }
    } else {
        $parent = Split-Path $link -Parent
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
}
# 从注册表刷新当前会话 PATH（新装软件后立即可用，无需重开窗口）
function Update-Path {
    $m = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($m, $u) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ';'
}
# 快速网络探测（TcpClient 3s 超时；Get-NetTCPConnection 在部分环境被 ACL 拦截）
function Test-TcpPort([string]$hostName, [int]$port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect($hostName, $port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(3000)
        if ($ok) { $c.EndConnect($iar) }
        $c.Close()
        return $ok
    } catch { return $false }
}
# 取工具版本（命令不存在返回 $null；存在但执行异常返回空串）
function Get-ToolVersion([string]$name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { return $null }
    try { return ((& $name --version 2>&1 | Select-Object -First 1) -join '').Trim() } catch { return '' }
}
# 解析 Node 版本是否 >= 最低要求（无法解析返回 $null）
function Test-NodeVersion([string]$verText, [version]$min) {
    $v = ($verText -replace '^v', '').Trim()
    if ($v -notmatch '^\d+\.\d+') { return $null }
    try { return ([version]$v -ge $min) } catch { return $null }
}

Write-Host '============================================================'
Write-Host '   DSH-ARCHIVE 首次安装 / 移动项目位置 一键修复'
Write-Host ("   项目根：{0}" -f $root)
if ($DryRun) { Write-Host '   模式：只检查（-DryRun，不修改）' -ForegroundColor Yellow }
Write-Host '============================================================'

# ---------------- 0. 校验项目根 ----------------
Write-Step '0/9 校验项目根'
$profilePatch = Join-Path $root 'dsh\cordis.patch.yml'
$profilePkg   = Join-Path $root 'dsh\package.json'
if (-not (Test-Path $profilePatch) -or -not (Test-Path $profilePkg)) {
    Write-Err '未找到 dsh\cordis.patch.yml / dsh\package.json，请确认脚本放在 DSH-ARCHIVE 项目根目录。'
    Read-Exit; exit 1
}
Write-Ok '识别为 DSH-ARCHIVE 项目'

# --- 服务运行检测：运行中同步插件会因文件占用失败，先提示停止（幂等保护） ---
$livePorts = @()
foreach ($probePort in @(3081, 3085)) {
    try {
        $probe = New-Object System.Net.Sockets.TcpClient
        $probeIar = $probe.BeginConnect('127.0.0.1', $probePort, $null, $null)
        $probeOk = $probeIar.AsyncWaitHandle.WaitOne(800)
        if ($probeOk) { $probe.EndConnect($probeIar); $livePorts += $probePort }
        $probe.Close()
    } catch { }
}
if ($livePorts.Count -gt 0) {
    Write-Warn ("检测到端口 {0} 有服务在监听（可能是运行中的 DSH-ARCHIVE 实例）。为避免运行中文件占用导致插件同步失败，请先双击《停止DSH-ARCHIVE.cmd》停止服务，再运行本脚本。" -f ($livePorts -join '、'))
    Read-Exit; exit 1
}

# ---------------- 1. 环境检测 ----------------
Write-Step '1/9 检测当前用户环境'
$isAdmin = [bool](([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator))
Write-Ok ('操作系统：' + [System.Environment]::OSVersion.VersionString)
Write-Ok ('PowerShell：' + $PSVersionTable.PSVersion.ToString() + $(if ($isAdmin) { '（管理员权限）' } else { '（普通权限）' }))

$netOk = Test-TcpPort 'registry.npmjs.org' 443
if ($netOk) { Write-Ok '网络：registry.npmjs.org:443 可达（npm 安装可用）' }
else { Write-Warn '网络：registry.npmjs.org:443 不可达（自动安装前置将失败，请检查网络/代理后重试）' }

$nodeVer = Get-ToolVersion 'node'
if ($null -eq $nodeVer) {
    Write-Warn 'Node.js：未安装（项目要求 ≥ 22.5；下一步将尝试自动安装）'
} else {
    $nodeOk = Test-NodeVersion $nodeVer ([version]'22.5.0')
    if ($nodeOk -eq $true)      { Write-Ok ("Node.js：" + $nodeVer + "（满足 ≥ 22.5）") }
    elseif ($nodeOk -eq $false) { Write-Warn ("Node.js：" + $nodeVer + "（低于 22.5，建议升级后再启动项目）") }
    else                        { Write-Ok ("Node.js：" + $nodeVer) }
}
$npmVer = Get-ToolVersion 'npm'
if ($null -eq $npmVer) { Write-Warn 'npm：未找到（Node.js 安装应自带 npm）' }
else { Write-Ok ("npm：" + $npmVer) }
$pnpmVer = Get-ToolVersion 'pnpm'
if ($null -eq $pnpmVer) { Write-Warn 'pnpm：未安装（下一步将尝试自动安装）' }
else { Write-Ok ("pnpm：" + $pnpmVer) }
$engineProbe = Join-Path $root 'dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (Test-Path $engineProbe) { Write-Ok '项目 dsh 引擎：已就位（自带，无需全局 dsh）' }
else { Write-Warn '项目 dsh 引擎：未安装（下一步将用 pnpm install 自动安装，首次需联网）' }

$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) { Write-Ok ("winget：" + (Get-ToolVersion 'winget') + "（Node.js 缺失时自动安装用）") }
else { Write-Skip 'winget：不可用（Node.js 缺失时将提示手动安装）' }

# ---------------- 2. 前置依赖自动安装 ----------------
Write-Step '2/9 配置前置与依赖'
if ($DryRun) {
    $missing = @()
    if ($null -eq $nodeVer) { $missing += 'Node.js' }
    if ($null -eq $pnpmVer) { $missing += 'pnpm' }
    if (-not (Test-Path $engineProbe)) { $missing += '项目 dsh 引擎' }
    if ($missing.Count -gt 0) { Write-Fix ("将安装：" + ($missing -join '、')) }
    Write-Skip '（-DryRun 不执行安装，仅报告）'
} else {
    # 2a) Node.js（缺失时用 winget 安装；user 作用域免管理员，失败再试默认作用域）
    if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) {
        if (-not $netOk) {
            Write-Err 'Node.js 缺失且网络不可达，无法自动安装。请联网后重跑本脚本，或手动安装 https://nodejs.org 后重试。'
            Read-Exit; exit 1
        }
        if (-not $winget) {
            Write-Err 'Node.js 缺失且未找到 winget。请手动下载安装 https://nodejs.org （LTS ≥ 22.5）后重跑本脚本。'
            Read-Exit; exit 1
        }
        Write-Host '   正在安装 Node.js LTS（winget）...' -ForegroundColor DarkYellow
        & winget install --id OpenJS.NodeJS.LTS -e --scope user --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) {
            Write-Host '   user 作用域未成功，尝试默认作用域（可能需要管理员 / UAC 确认）...' -ForegroundColor DarkYellow
            & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements 2>&1 | Out-Host
        }
        Update-Path
        if (Get-Command node -ErrorAction SilentlyContinue) {
            Write-Ok ('Node.js 已安装：' + (Get-ToolVersion 'node'))
            $nodeVer = Get-ToolVersion 'node'
        } else {
            Write-Err 'Node.js 安装失败。请以管理员身份重跑本脚本，或手动安装 https://nodejs.org 后重试。'
            Read-Exit; exit 1
        }
    } else {
        Write-Ok 'Node.js 已就绪'
    }

    # 2b) pnpm（npm 全局安装，用户级无需管理员）
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        if (-not $netOk) {
            Write-Err 'pnpm 缺失且网络不可达，无法自动安装。请联网后重跑本脚本。'
            Read-Exit; exit 1
        }
        Write-Host '   正在安装 pnpm（npm install -g pnpm）...' -ForegroundColor DarkYellow
        & npm install -g pnpm 2>&1 | Out-Host
        Update-Path
        if (Get-Command pnpm -ErrorAction SilentlyContinue) {
            Write-Ok ('pnpm 已安装：' + (Get-ToolVersion 'pnpm'))
            $pnpmVer = Get-ToolVersion 'pnpm'
        } else {
            Write-Err 'pnpm 安装失败。请检查 npm 全局目录权限（%AppData%\npm）后重试。'
            Read-Exit; exit 1
        }
    } else {
        Write-Ok 'pnpm 已就绪'
    }

    # 2c) 项目自带 dsh 引擎（@deepseek-ai/dsh，随 package.json 锁定；2026-09-11 起不再需要全局 dsh CLI）
    $engineBin = Join-Path $root 'dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (-not (Test-Path $engineBin)) {
        if (-not $netOk) {
            Write-Err '项目 dsh 引擎缺失且网络不可达，无法自动安装。请联网后重跑本脚本。'
            Read-Exit; exit 1
        }
        Write-Host '   正在安装项目依赖（含自带 dsh 引擎，首次需联网，请稍候）...' -ForegroundColor DarkYellow
        Push-Location (Join-Path $root 'dsh')
        try { & pnpm install --config.confirmModulesPurge=false | Out-Host } finally { Pop-Location }
        if (-not (Test-Path $engineBin)) {
            Write-Err '项目 dsh 引擎安装失败（pnpm install 未生成 node_modules\@deepseek-ai\dsh）。'
            Write-Err '请检查网络/镜像与磁盘空间后重试：cd dsh && pnpm install'
            Read-Exit; exit 1
        }
        Write-Ok '项目 dsh 引擎已安装'
    } else {
        Write-Ok '项目自带 dsh 引擎已就绪'
    }

    # 2d) 项目 home 初始化（launcher 回退副本落在项目 home；与 ~/.dsh 完全隔离）
    $projHome = Join-Path $root '.dsh-home'
    $launcherTools = Join-Path $projHome 'profiles\node_modules\@deepseek-ai\dsh-tools'
    if (-not (Test-Path $launcherTools)) {
        Write-Host '   初始化项目 home（生成 launcher 回退副本，稍候）...' -ForegroundColor DarkYellow
        $env:DSH_HOME = $projHome
        & node $engineBin --profile web --dump-config 2>&1 | Out-Null
        if (-not (Test-Path $launcherTools)) {
            Write-Err '项目 home 初始化未生成 profiles\node_modules\@deepseek-ai\dsh-tools。'
            Write-Err '请手动运行：$env:DSH_HOME="<项目>\.dsh-home"; node "<项目>\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile web --dump-config'
            Read-Exit; exit 1
        }
        Write-Ok '项目 home 初始化完成'
    }
}

# ---------------- 3. 项目引擎兜底校验 ----------------
Write-Step '3/9 校验项目 dsh 引擎'
$engineBin = Join-Path $root 'dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $engineBin)) {
    Write-Err '项目 dsh 引擎仍不可用（依赖安装未成功）。'
    Read-Exit; exit 1
}
$ev = (& node $engineBin --version 2>&1 | Select-Object -First 1)
Write-Ok ('项目 dsh 引擎：' + $ev)
$projHome = Join-Path $root '.dsh-home'
$env:DSH_HOME = $projHome   # 本次进程内注入：后续 junction / preset / dump-config 均落项目 home（不影响 ~/.dsh 与其它 dsh 环境）

# ---------------- 4. 项目内 profile 入口 ----------------
Write-Step '4/9 修复项目内 profile 入口（.dsh-home\profiles\archive）'
$junction   = Join-Path $projHome 'profiles\archive'
$juncTarget = Join-Path $root 'dsh'
$wantNorm   = Normalize-Path $juncTarget

# 旧版 home（dsh\home）遗留清理：其中含指向 dsh 的链接，会让"整目录复制"递归/失败。
$legacyHome = Join-Path $root 'dsh\home'
if (Test-Path -LiteralPath $legacyHome) {
    if ($DryRun) { Write-Fix "将清理旧版 home：$legacyHome" }
    else {
        & cmd /c rmdir /s /q "`"$legacyHome`"" 2>$null | Out-Null
        if (-not (Test-Path -LiteralPath $legacyHome)) { Write-Warn '已清理旧版 home（dsh\home）' }
    }
}

# 2026-09-11 独立化：入口位于【项目 home 内】，与其它副本、与全局 ~/.dsh 互不影响，
#   逻辑简单且幂等：缺失 → 创建；被复制成真实目录 → 自动重建（home 属可再生运行时产物）；
#   指向不对 → 直接修正回本副本（只影响本副本，不存在"抢别人入口"的问题）。
try {
    if (-not (Test-Path $junction)) {
        if ($DryRun) { Write-Fix "将创建联接：$junction -> $juncTarget" }
        else { Set-Junction $junction $juncTarget; Write-Ok "已创建联接：$junction -> $juncTarget" }
    } else {
        $item = Get-Item $junction -Force
        if ($item.LinkType -ne 'Junction') {
            if ($DryRun) { Write-Fix "将重建联接（当前是真实目录，疑似复制所致）：$junction" }
            else {
                & cmd /c rmdir /s /q "`"$junction`"" 2>$null | Out-Null
                if (Test-Path $junction) { throw "无法移除真实目录：$junction" }
                Set-Junction $junction $juncTarget
                Write-Warn "profile 入口曾为真实目录（复制所致），已重建为联接：$junction -> $juncTarget"
            }
        } elseif ((Get-JunctionTarget $junction) -eq $wantNorm) {
            Write-Ok '联接已指向正确位置（无需修改）'
        } else {
            if ($DryRun) { Write-Fix "将重建联接：$junction 现指向 $($item.Target)，应指向 $juncTarget" }
            else {
                Set-Junction $junction $juncTarget
                Write-Warn "已修正联接：$junction -> $juncTarget（本项目入口只影响本副本）"
            }
        }
    }
} catch {
    Write-Err ('处理联接失败（可能需要权限）：' + $_.Exception.Message)
    Write-Host '   可尝试：以管理员身份重新运行本脚本。' -ForegroundColor DarkYellow
    Read-Exit; exit 1
}

# ---------------- 5. 项目内绝对路径引用重写 ----------------
Write-Step '5/9 扫描并重写项目内旧绝对路径引用'
# 2026-09-05 收敛范围：只处理影响运行的配置文件/脚本/代码（cordis.patch.yml、presets、.ps1/.js/
# package.json/.cmd 等），【跳过 .md/.txt 等文档】——避免把 README/说明里的 https clone 链接或
# 示例路径误改（曾出现 README 的 httpC:/DSH-ARCHIVE-1.git 被改坏成 httpD:/cs/…）。
$textExts = '.yml','.yaml','.ps1','.json','.js','.cjs','.mjs','.cmd','.bat'
# 常量语义文件不参与改写：sync-packages.ps1 / push-seed.ps1 中的 C:/DSH-ARCHIVE 是"归一化目标常量"
# 而非失效指针（主项目与打包流程依赖它），改写会破坏打包归一化。
$skipNames = @('sync-packages.ps1', 'push-seed.ps1')
$excludeDir = '(\\\.git\\|\\\.pnpm-store\\|\\ollama\\|\\logs\\|\\backups\\|\\node_modules\\)'
$rootBS = $root.TrimEnd('\')
$rootFS = ($root.TrimEnd('\') -replace '\\', '/')
$rootNorm = Normalize-Path $root
# 匹配「盘符: 分隔符 任意路径段 DSH-ARCHIVE」（贪婪到行内最后一个 DSH-ARCHIVE），
# 用于定位项目曾经所在位置的绝对路径；路径段排除 引号/冒号/换行/尖括号/竖线/反引号
# （排除冒号可让一行里并列的多个盘符路径各自独立匹配，避免贪婪吞并）。
# 2026-09-11 重写算法加固（原"贪婪到最后一个 DSH-ARCHIVE"在项目路径本身含该词且后面还有段时
# 会把路径层层拼接成垃圾，例如 …\DSH-ARCHIVE总文件夹\_e2e\B、用户常见的 DSH-ARCHIVE-Copy）。
# 现改为"完整盘符路径 token + 三条精确规则"，严格幂等、输出统一正斜杠：
#   ① 已在当前根下            → 原样保留
#   ② 含 /dsh/data 标记       → 以当前根替换标记之前的部分（数据路径专用，最可靠）
#   ③ 否则取"最后一个含 DSH-ARCHIVE 的路径段"为旧根，且余部必须是项目内已知子路径才替换
#      （余部不认识就保留不动，宁可不改也不写坏）
# (?<![A-Za-z0-9]) 负向后顾：杜绝命中 URL 里的 "s:"/"t:"（如 https://github.com/...）。
$pathPattern = '(?<![A-Za-z0-9])([A-Za-z]):([\\/])([^":''\r\n<>|`]*)'
$knownSub = '^(dsh|modules|presets|scripts|assets|ollama|backups|node_modules|README\.md|VERSION|一键|启动|停止|首次|项目|手机|真机|start|stop|update|install|fix|rollback|verify|sync|tray|push)(\.|/|$)'

$files = @(Get-ChildItem $root -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch $excludeDir -and $textExts -contains $_.Extension.ToLowerInvariant() -and $skipNames -notcontains $_.Name })

$scanned = 0; $changed = 0
# JSON 文件里的路径以转义形式存储（盘符:\目录\...\DSH-ARCHIVE 形式）；用私有区字符保护成对反斜杠，
# 替换时输出双反斜杠新根，避免把 \\ 拆成 \ 而破坏 JSON（Bad escaped character）。
$escChar = [char]0xE000   # 私有区占位符
$escIn   = '\' + $escChar
foreach ($f in $files) {
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $isJson = ($f.Extension.ToLowerInvariant() -eq '.json')
    if ($isJson) { $text = $text.Replace('\\', $escIn) }   # \\ -> \<占位>（保留分隔符）
    $new = [regex]::Replace($text, $pathPattern, {
        param($m)
        $sep = $m.Groups[2].Value
        $tok = $m.Groups[1].Value + ':' + $sep + $m.Groups[3].Value
        # 比较/判断时把 JSON 占位符还原为反斜杠（JSON 转义不影响路径身份）
        $tokN = Normalize-Path ($tok.Replace($escChar, '\'))
        if ([string]::IsNullOrEmpty($tokN)) { return $m.Value }
        # ① 已在当前根下 → 原样保留（幂等关键）
        if ($tokN -eq $rootNorm -or $tokN.StartsWith($rootNorm + '/')) { return $m.Value }
        # ② 含 /dsh/data 标记 → 当前根 + 标记及其后（数据路径专用）
        $i = $tokN.IndexOf('/dsh/data')
        if ($i -ge 0) { return ($rootFS.TrimEnd('/') + $tokN.Substring($i)) }
        # ③ 末个含 DSH-ARCHIVE 的路径段视为旧根；余部须为项目内已知子路径，否则保持不动
        $parts = $tokN.Split('/')
        $idx = -1
        for ($k = 0; $k -lt $parts.Length; $k++) { if ($parts[$k] -like 'DSH-ARCHIVE*') { $idx = $k } }
        if ($idx -ge 0 -and ($idx + 1) -lt $parts.Length) {
            $rest = ($parts[($idx + 1)..($parts.Length - 1)] -join '/')
            if ($rest -match $knownSub) { return ($rootFS.TrimEnd('/') + '/' + $rest) }
        }
        return $m.Value
    })
    if ($isJson) { $new = $new.Replace($escIn, '\\') }   # 还原转义
    $scanned++
    if ($new -ne $text) {
        $changed++
        if ($DryRun) { Write-Fix ('将更新：' + $f.FullName.Replace($root, '')) }
        else {
            $enc = New-Object System.Text.UTF8Encoding($hasBom)
            [System.IO.File]::WriteAllBytes($f.FullName, $enc.GetBytes($new))
            Write-Fix ('已更新：' + $f.FullName.Replace($root, ''))
        }
    }
}
if ($changed -eq 0) { Write-Ok "扫描 $scanned 个文本文件，无过时路径引用（$scanned/$scanned 无需修改）" }
else { Write-Host ("  [改] 共 {0} 个文件含过时路径引用，已处理（扫描 {1} 个文件）" -f $changed, $scanned) -ForegroundColor Yellow }

# ---------------- 6. 插件依赖与同步 ----------------
Write-Step '6/9 检查插件依赖并同步'
# 6a) agent preset 随包分发：分发包携带 presets/archive-standard，首次部署时装入本机 ~/.dsh/.agent-presets/
$presetSrc = Join-Path $root 'presets\archive-standard'
$presetDst = Join-Path $projHome '.agent-presets\archive-standard'
if (-not (Test-Path $presetSrc)) {
    Write-Skip '项目内未发现 presets\archive-standard（旧版项目可能没有；若主会话需 standard 工具请补上）'
} elseif (Test-Path $presetDst) {
    Write-Ok 'agent preset archive-standard 已存在'
} else {
    if ($DryRun) { Write-Fix '将安装 agent preset archive-standard 到项目 home\.agent-presets\' }
    else {
        New-Item -ItemType Directory -Path (Split-Path $presetDst -Parent) -Force | Out-Null
        Copy-Item $presetSrc $presetDst -Recurse -Force
        Write-Ok '已安装 agent preset archive-standard'
    }
}
# 注：@deepseek-ai/dsh-base 等 bundle 由项目自带引擎（node_modules\@deepseek-ai\dsh）解析。
# 依赖完整标志 = pnpm 安装标记(.modules.yaml) + 自定义插件 + 项目 dsh 引擎三者就位。
$depMarker = Join-Path $root 'dsh\node_modules\.modules.yaml'
$depPlugin = Join-Path $root 'dsh\node_modules\dsh-archive-memory\package.json'
$depEngine = Join-Path $root 'dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $depMarker) -or -not (Test-Path $depPlugin) -or -not (Test-Path $depEngine)) {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        Write-Err 'dsh\node_modules 依赖缺失且未找到 pnpm。请先安装 pnpm，然后执行：'
        Write-Err ("cd `"$root\dsh`" && pnpm install")
        Read-Exit; exit 1
    }
    if ($DryRun) { Write-Fix '将执行 pnpm install（安装 profile 依赖）' }
    else {
        Write-Host '   正在 pnpm install（首次安装需要网络，请稍候）...' -ForegroundColor DarkYellow
        Push-Location (Join-Path $root 'dsh')
        try { & pnpm install --config.confirmModulesPurge=false | Out-Host } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { Write-Err 'pnpm install 失败，请手动重试后再运行本脚本。'; Read-Exit; exit 1 }
        Write-Ok '依赖安装完成'
    }
} else {
    Write-Ok 'profile 依赖完整（pnpm 标记 + 自定义插件 + 项目 dsh 引擎就位）'
}

$syncScript = Join-Path $root 'dsh\scripts\sync-plugins.ps1'
if (-not (Test-Path $syncScript)) {
    Write-Err '缺少 dsh\scripts\sync-plugins.ps1，项目文件不完整。'
    Read-Exit; exit 1
}
# 插件同步依赖 launcher 的 dsh-tools 回退副本（项目 home\profiles\node_modules），
# 该副本由项目引擎首次运行时自动 heal 生成；前置步骤 2d 已保证其存在。
$launcherTools = Join-Path $projHome 'profiles\node_modules\@deepseek-ai\dsh-tools'
if (-not $DryRun -and -not (Test-Path $launcherTools)) {
    Write-Err '未找到 launcher 的 dsh-tools（项目 home\profiles\node_modules\@deepseek-ai\dsh-tools）。'
    Write-Err '请先重跑本脚本（步骤 2d 会自动初始化项目 home）。'
    Read-Exit; exit 1
}
if ($DryRun -and -not (Test-Path $launcherTools)) { Write-Skip '（-DryRun：项目 home 的 launcher 回退副本将在正式运行时自动生成）' }
if ($DryRun) {
    Write-Skip '（-DryRun 跳过插件同步）'
} else {
    try {
        & $syncScript | ForEach-Object { Write-Host ('   ' + $_) }
        Write-Ok '插件已同步（含 dsh-tools junction 重建）'
    } catch {
        Write-Err ('插件同步失败：' + $_.Exception.Message)
        Read-Exit; exit 1
    }
}

# ---------------- 7. 数据目录 ----------------
Write-Step '7/9 检查数据目录'
$dataDir = Join-Path $root 'dsh\data'
foreach ($sub in @('', 'sessions', 'skills', 'storages')) {
    $p = if ($sub) { Join-Path $dataDir $sub } else { $dataDir }
    if (-not (Test-Path $p)) {
        if ($DryRun) { Write-Fix ("将创建目录：{0}" -f $p.Replace($root, '')) }
        else { New-Item -ItemType Directory -Path $p -Force | Out-Null; Write-Fix ("已创建目录：{0}" -f $p.Replace($root, '')) }
    }
}
Write-Ok '数据目录就绪（dsh\data 及其子目录）'

# ---------------- 8. 验证 ----------------
Write-Step '8/9 验证 profile 可加载'
if ($DryRun) {
    Write-Skip '（-DryRun 跳过验证）'
} else {
    $env:DSH_HOME = $projHome
    $out = & node $engineBin --profile archive --dump-config 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        Write-Ok 'profile 合成正常（项目引擎 + 项目 home：--profile archive --dump-config 成功）'
    } else {
        Write-Err 'profile 验证失败，输出如下：'
        Write-Host ($out.Substring(0, [Math]::Min(1500, $out.Length)))
        Read-Exit; exit 1
    }
}

# ---------------- 9. ollama 向量模型运行时（记忆语义检索/人格一致性/潜意识凝缩依赖向量） ----------------
Write-Step '9/9 ollama 向量模型运行时'
$ollamaExe = Join-Path $root 'ollama\bin\ollama.exe'
$dmetaShort = 'dmeta-embedding-zh'
$dmetaTag = 'shaw/dmeta-embedding-zh:latest'

function Invoke-OllamaApi([string]$apiPath, [int]$timeoutSec = 5) {
    try { return (Invoke-RestMethod -Uri ('http://127.0.0.1:11434' + $apiPath) -TimeoutSec $timeoutSec) } catch { return $null }
}
function Get-OllamaCli {
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe", $ollamaExe)) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

if (Test-Path $ollamaExe) {
    Write-Ok '项目内 ollama 已存在（启动脚本自动拉起并确保嵌入模型，无需处理）'
} elseif ($DryRun) {
    Write-Skip '（-DryRun 跳过 ollama 检测/下载）'
} else {
    $api = Invoke-OllamaApi '/api/tags'
    if ($null -ne $api) {
        # a) 本机已有 ollama 服务（11434）→ 复用外部实例，不重复下载；仅确保嵌入模型
        $hasDmeta = $false
        if ($api.models) { $hasDmeta = @($api.models | Where-Object { $_.name -like "*$dmetaShort*" }).Count -gt 0 }
        if ($hasDmeta) {
            Write-Ok '检测到本机 ollama（11434），嵌入模型 dmeta-embedding-zh 已就绪 —— 直接复用，无需下载'
        } else {
            Write-Host '  检测到本机 ollama（11434）但缺少嵌入模型，尝试自动拉取 dmeta-embedding-zh（约 390MB）…' -ForegroundColor DarkYellow
            $cli = Get-OllamaCli
            if ($cli) {
                & $cli pull $dmetaTag 2>&1 | Out-Host
                if ($LASTEXITCODE -eq 0) { Write-Ok '嵌入模型已拉取' }
                else { Write-Warn '模型拉取失败，可稍后手动执行：ollama pull shaw/dmeta-embedding-zh' }
            } else {
                Write-Warn '未找到 ollama 命令行，请稍后手动执行：ollama pull shaw/dmeta-embedding-zh'
            }
        }
    } else {
        # b) 无任何 ollama → 下载捆绑版到项目 ollama\（多源；与手机 install.sh 同思路；start.ps1 首次启动自动拉起并拉模型）
        Write-Host '  未检测到 ollama。将下载 Windows 版 ollama（约 1.3GB，需联网与耐心）；下载失败不影响其它步骤，可稍后手动放置。' -ForegroundColor DarkYellow
        $zipName = 'ollama-windows-amd64.zip'
        $zipUrl = @(
            "https://github.com/ollama/ollama/releases/download/v0.33.3/$zipName",
            "https://gh-proxy.com/https://github.com/ollama/ollama/releases/download/v0.33.3/$zipName",
            "https://ollama.com/download/$zipName"
        )
        $zipPath = Join-Path $env:TEMP ('ollama-' + [guid]::NewGuid().ToString('N') + '.zip')
        $downloaded = $false
        foreach ($u in $zipUrl) {
            Write-Host ("    下载源：{0}" -f $u)
            try {
                Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $zipPath -TimeoutSec 3600
                $downloaded = $true
                break
            } catch {
                Write-Warn ('下载失败：' + $_.Exception.Message)
                Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
            }
        }
        if ($downloaded) {
            try {
                Write-Host '  解压中（ollama-windows-amd64.zip，约需 1-3 分钟）…' -ForegroundColor DarkYellow
                Expand-Archive -Path $zipPath -DestinationPath (Join-Path $root 'ollama') -Force
                if (Test-Path $ollamaExe) {
                    Write-Ok ('ollama 就绪：' + ((& $ollamaExe --version 2>&1 | Select-Object -First 1) -join ''))
                    Write-Host '  首次启动《启动DSH-ARCHIVE.cmd》时将自动拉取嵌入模型 dmeta-embedding-zh（约 390MB）。' -ForegroundColor DarkYellow
                } else {
                    Write-Warn '解压完成但未找到 ollama\bin\ollama.exe（可能被安全软件拦截），请检查后重跑本脚本'
                }
            } catch { Write-Warn ('解压失败：' + $_.Exception.Message) }
            Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        } else {
            Write-Warn 'ollama 全部下载源失败（网络受限？）。可稍后在能联网的设备下载 ollama-windows-amd64.zip，解压出的 bin/、lib/ 放入本目录 ollama/ 后重跑本脚本。'
        }
    }
}

# ---------------- 总结 ----------------
Write-Host ''
Write-Host '============================================================'
if ($DryRun) {
    Write-Host '  检查完成（未做任何修改）。' -ForegroundColor Yellow
} else {
    Write-Host '  全部就绪！现在可以双击《启动DSH-ARCHIVE.cmd》启动项目。' -ForegroundColor Green
    Write-Host '  （启动后访问 http://127.0.0.1:3081）' -ForegroundColor Green
}
Write-Host '============================================================'
Read-Exit
