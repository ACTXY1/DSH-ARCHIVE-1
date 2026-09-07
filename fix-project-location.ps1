# ============================================================
#  fix-project-location.ps1  （双击入口：首次安装或移动项目位置点我.cmd）
#
#  用途：项目被移动/复制到新位置后（或首次安装），一键检测当前用户环境、
#        配置项目全部前置与依赖、修复所有依赖旧位置/旧机器的问题：
#          0. 校验项目根
#          1. 环境检测：OS / PowerShell / 网络 / Node.js / npm / pnpm / dsh CLI
#          2. 前置自动安装：Node.js（winget）、pnpm、dsh CLI、dsh 家目录初始化
#          3. ~/.dsh/profiles/archive 目录联接（junction）指向
#          4. 项目内所有绝对路径引用（cordis.patch.yml、README、脚本等）
#          5. dsh-tools junction 与 modules -> node_modules 插件同步
#          6. 数据目录存在性
#          7. profile 可加载性验证（dsh --profile archive --dump-config）
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
Write-Step '0/8 校验项目根'
$profilePatch = Join-Path $root 'dsh\cordis.patch.yml'
$profilePkg   = Join-Path $root 'dsh\package.json'
if (-not (Test-Path $profilePatch) -or -not (Test-Path $profilePkg)) {
    Write-Err '未找到 dsh\cordis.patch.yml / dsh\package.json，请确认脚本放在 DSH-ARCHIVE 项目根目录。'
    Read-Exit; exit 1
}
Write-Ok '识别为 DSH-ARCHIVE 项目'

# ---------------- 1. 环境检测 ----------------
Write-Step '1/8 检测当前用户环境'
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
$dshVer = Get-ToolVersion 'dsh'
if ($null -eq $dshVer) { Write-Warn 'dsh CLI：未安装（下一步将尝试自动安装）' }
else { Write-Ok ("dsh CLI：" + $dshVer) }

$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) { Write-Ok ("winget：" + (Get-ToolVersion 'winget') + "（Node.js 缺失时自动安装用）") }
else { Write-Skip 'winget：不可用（Node.js 缺失时将提示手动安装）' }

# ---------------- 2. 前置依赖自动安装 ----------------
Write-Step '2/8 配置前置与依赖'
if ($DryRun) {
    $missing = @()
    if ($null -eq $nodeVer) { $missing += 'Node.js' }
    if ($null -eq $pnpmVer) { $missing += 'pnpm' }
    if ($null -eq $dshVer)  { $missing += 'dsh CLI' }
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

    # 2c) dsh CLI（npm 全局安装）
    if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
        if (-not $netOk) {
            Write-Err 'dsh CLI 缺失且网络不可达，无法自动安装。请联网后重跑本脚本。'
            Read-Exit; exit 1
        }
        Write-Host '   正在安装 dsh CLI（npm install -g @deepseek-ai/dsh）...' -ForegroundColor DarkYellow
        & npm install -g @deepseek-ai/dsh 2>&1 | Out-Host
        Update-Path
        if (Get-Command dsh -ErrorAction SilentlyContinue) {
            Write-Ok ('dsh CLI 已安装：' + (Get-ToolVersion 'dsh'))
            $dshVer = Get-ToolVersion 'dsh'
        } else {
            Write-Err 'dsh CLI 安装失败。请检查 npm 全局目录权限后重试。'
            Read-Exit; exit 1
        }
    } else {
        Write-Ok 'dsh CLI 已就绪'
    }

    # 2d) dsh 家目录初始化（全新 dsh 首次运行生成 launcher 回退副本 ~/.dsh/profiles/node_modules）
    $launcherTools = Join-Path $userHome '.dsh\profiles\node_modules\@deepseek-ai\dsh-tools'
    if (-not (Test-Path $launcherTools)) {
        Write-Host '   首次初始化 dsh 家目录（生成 launcher 回退副本，稍候）...' -ForegroundColor DarkYellow
        & dsh --profile web --dump-config 2>&1 | Out-Null
        if (-not (Test-Path $launcherTools)) {
            Write-Err 'dsh 初始化未生成 ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools。'
            Write-Err '请手动运行一次：dsh --profile web --dump-config，然后重跑本脚本。'
            Read-Exit; exit 1
        }
        Write-Ok 'dsh 家目录初始化完成'
    }
}

# ---------------- 3. dsh 命令兜底校验 ----------------
Write-Step '3/8 校验 dsh 命令'
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dshCmd) {
    Write-Err 'dsh 命令仍不可用（前置安装未成功）。'
    Read-Exit; exit 1
}
Write-Ok ('dsh：' + $dshCmd.Source)

# ---------------- 4. profile junction ----------------
Write-Step '4/8 修复 ~/.dsh/profiles/archive 目录联接'
$junction   = Join-Path $userHome '.dsh\profiles\archive'
$juncTarget = Join-Path $root 'dsh'
$wantNorm   = Normalize-Path $juncTarget

try {
    if (-not (Test-Path $junction)) {
        if ($DryRun) { Write-Fix "将创建联接：$junction -> $juncTarget" }
        else { Set-Junction $junction $juncTarget; Write-Ok "已创建联接：$junction -> $juncTarget" }
    } else {
        $item = Get-Item $junction -Force
        if ($item.LinkType -ne 'Junction') {
            Write-Err "「$junction」存在但不是 junction（真实目录），请手动处理后重试。"
            Read-Exit; exit 1
        }
        if ((Get-JunctionTarget $junction) -eq $wantNorm) {
            Write-Ok '联接已指向正确位置'
        } else {
            if ($DryRun) { Write-Fix "将重建联接：$junction 现指向 $($item.Target)，应指向 $juncTarget" }
            else { Set-Junction $junction $juncTarget; Write-Ok "已重建联接：$junction -> $juncTarget" }
        }
    }
} catch {
    Write-Err ('处理联接失败（可能需要权限）：' + $_.Exception.Message)
    Write-Host '   可尝试：以管理员身份重新运行本脚本。' -ForegroundColor DarkYellow
    Read-Exit; exit 1
}

# ---------------- 5. 项目内绝对路径引用重写 ----------------
Write-Step '5/8 扫描并重写项目内旧绝对路径引用'
$textExts = '.yml','.yaml','.ps1','.md','.txt','.json','.js','.cjs','.mjs','.cmd','.bat','.html','.css','.ts','.vbs','.xml','.cfg','.conf','.ini','.properties','.env','.csv'
$excludeDir = '(\\\.git\\|\\\.pnpm-store\\|\\ollama\\|\\logs\\|\\backups\\|\\node_modules\\)'
$rootBS = $root.TrimEnd('\')
$rootFS = ($root.TrimEnd('\') -replace '\\', '/')
$rootNorm = Normalize-Path $root
# 匹配「盘符: 分隔符 任意路径段 DSH-ARCHIVE」（贪婪到行内最后一个 DSH-ARCHIVE），
# 用于定位项目曾经所在位置的绝对路径；路径段排除 引号/冒号/换行/尖括号/竖线/反引号
# （排除冒号可让一行里并列的多个盘符路径各自独立匹配，避免贪婪吞并）。
$pathPattern = '([A-Za-z]):([\\/])([^":''\r\n<>|`]*)DSH-ARCHIVE'

$files = @(Get-ChildItem $root -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch $excludeDir -and $textExts -contains $_.Extension.ToLowerInvariant() })

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
        $candRaw = $m.Groups[1].Value + ':' + $sep + $m.Groups[3].Value + 'DSH-ARCHIVE'
        # 比较时把占位符还原为反斜杠（JSON 转义不影响路径身份）
        $cand = if ($isJson) { Normalize-Path ($candRaw.Replace($escChar, '\')) } else { Normalize-Path $candRaw }
        if ($cand -eq $rootNorm) { return $m.Value }   # 已是当前根，跳过
        if ($sep -eq '/') { return $rootFS }
        if ($isJson) { return $rootBS.Replace('\', '\\') }   # JSON 里反斜杠需成对
        return $rootBS
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
Write-Step '6/8 检查插件依赖并同步'
# 6a) agent preset 随包分发：分发包携带 presets/archive-standard，首次部署时装入本机 ~/.dsh/.agent-presets/
$presetSrc = Join-Path $root 'presets\archive-standard'
$presetDst = Join-Path $userHome '.dsh\.agent-presets\archive-standard'
if (-not (Test-Path $presetSrc)) {
    Write-Skip '项目内未发现 presets\archive-standard（旧版项目可能没有；若主会话需 standard 工具请补上）'
} elseif (Test-Path $presetDst) {
    Write-Ok 'agent preset archive-standard 已存在'
} else {
    if ($DryRun) { Write-Fix '将安装 agent preset archive-standard 到 ~/.dsh/.agent-presets/' }
    else {
        New-Item -ItemType Directory -Path (Split-Path $presetDst -Parent) -Force | Out-Null
        Copy-Item $presetSrc $presetDst -Recurse -Force
        Write-Ok '已安装 agent preset archive-standard'
    }
}
# 注：@deepseek-ai/dsh-base 是 bundle（由 dsh 安装目录解析），不进 profile 的 node_modules。
# 依赖完整标志 = pnpm 安装标记(.modules.yaml) + 自定义插件已就位。
$depMarker = Join-Path $root 'dsh\node_modules\.modules.yaml'
$depPlugin = Join-Path $root 'dsh\node_modules\dsh-archive-memory\package.json'
if (-not (Test-Path $depMarker) -or -not (Test-Path $depPlugin)) {
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
    Write-Ok 'profile 依赖完整（pnpm 标记 + 自定义插件就位）'
}

$syncScript = Join-Path $root 'dsh\scripts\sync-plugins.ps1'
if (-not (Test-Path $syncScript)) {
    Write-Err '缺少 dsh\scripts\sync-plugins.ps1，项目文件不完整。'
    Read-Exit; exit 1
}
# 插件同步依赖 launcher 的 dsh-tools 回退副本（~/.dsh/profiles/node_modules），
# 该目录由 dsh 首次运行时自动维护；前置步骤 2d 已保证其存在。
$launcherTools = Join-Path $userHome '.dsh\profiles\node_modules\@deepseek-ai\dsh-tools'
if (-not (Test-Path $launcherTools)) {
    Write-Err '未找到 launcher 的 dsh-tools（~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools）。'
    Write-Err '请先运行一次任意 dsh 命令（如：dsh --profile web --dump-config）让其初始化，再重试本脚本。'
    Read-Exit; exit 1
}
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
Write-Step '7/8 检查数据目录'
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
Write-Step '8/8 验证 profile 可加载'
if ($DryRun) {
    Write-Skip '（-DryRun 跳过验证）'
} else {
    $out = & dsh --profile archive --dump-config 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) {
        Write-Ok 'profile 合成正常（dsh --profile archive --dump-config 成功）'
    } else {
        Write-Err 'profile 验证失败，输出如下：'
        Write-Host ($out.Substring(0, [Math]::Min(1500, $out.Length)))
        Read-Exit; exit 1
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
