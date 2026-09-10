# ============================================================
#  sync-packages.ps1  ——  三包一致性校验 + 分发包生成
#  用途（一键更新方案A的发布侧配套）：
#    check（默认）：以主文件夹 Git 仓库（唯一事实源）为准，
#      对比 Windows 分发包 / 手机分发包的共享代码一致性。
#      自动容忍三处已声明平台差异：
#        a) 路径内容差异（仓库=当前主目录路径；分发包预归一化 C:/DSH-ARCHIVE）
#        b) 手机包缺少根级平台脚本（.cmd/.ps1/tray.ps1，用户  要求）
#        c) Windows 包剔除手机专属 mobile-ui（模块目录 + cordis.patch.yml 专属块
#           + package.json 依赖行，用户  决策 B）
#      忽略运行时目录（data/logs/node_modules/.pnpm-store/ollama/backups）。
#    build -Platform win|mobile|both：
#      用仓库内容重建分发包的代码部分（保留包内 data/ollama/backups 用户数据）：
#        1. 复制全部已跟踪文件
#        2. 文本文件路径预归一化为 C:/DSH-ARCHIVE（与现分发包形态一致）
#        3. mobile 删除根级 .cmd/.ps1/tray.ps1（保持手机包形态）
#        4. win 剔除手机专属 mobile-ui（模块目录 + patch 块 + 依赖行）
#    pure：
#      把 Windows 分发包的代码同步到发布版（分发包\DSH-ARCHIVE，公开发仓库源），
#      并做「发布纯净化」——剥离注释里的开发痕迹（日期、批次标记、阶段编号等），
#      只改注释、保留功能句；只更新发布版已有的文件（不新增 docs/research/介绍文本），
#      README.md 为发布版自有文档，不参与同步。
#  用法：
#    powershell -NoProfile -ExecutionPolicy Bypass -File sync-packages.ps1            # 只校验
#    powershell -NoProfile -ExecutionPolicy Bypass -File sync-packages.ps1 -Action build -Platform win
#    powershell -NoProfile -ExecutionPolicy Bypass -File sync-packages.ps1 -Action build -Platform both
#    powershell -NoProfile -ExecutionPolicy Bypass -File sync-packages.ps1 -Action pure
# ============================================================
param(
    [ValidateSet('check', 'build', 'pure')][string]$Action = 'check',
    [ValidateSet('win', 'mobile', 'both')][string]$Platform = 'both'
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$top  = Split-Path $repo -Parent
$winPkg = Join-Path $top 'DSH-ARCHIVE - 分发包'
$mobPkg = Join-Path $top 'DSH-ARCHIVE - 分发包（手机）'
$purePkg = Join-Path $top '分发包\DSH-ARCHIVE'

$canonical = '<ARC_ROOT>'            # 归一化比较用的统一路径记号
$normTarget = 'C:/DSH-ARCHIVE'       # 分发包预归一化目标
$textExts = '.yml','.yaml','.ps1','.md','.txt','.json','.js','.cjs','.mjs','.cmd','.bat','.html','.css','.ts','.vbs','.xml','.cfg','.conf','.ini','.properties','.env','.csv','.sh'
$mobDrop = @('.cmd', '.ps1')         # 手机包根级删除的 Windows 平台脚本扩展名
$winDropDir = 'modules/mobile-ui/'   # Windows 包剔除的手机专属模块目录
$mobBlockMarker = '# [手机分发包专属' # cordis.patch.yml 手机专属块起始标记（约定恒在文件尾部）
$mobDepLine = '"dsh-archive-mobile-ui": "file:../modules/mobile-ui",'  # package.json 手机专属依赖行

function Get-TrackedFiles {
    # core.quotepath=false：中文文件名按原始 UTF-8 输出，不做八进制转义
    $out = & git -C $repo -c core.quotepath=false ls-files 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'git ls-files 失败（仓库未初始化？）' }
    return @($out)
}

# git 相对路径带 /，.NET 路径 API 不认——统一转 \ 再取扩展名
function Get-Ext([string]$p) {
    return [System.IO.Path]::GetExtension($p.Replace('/', '\')).ToLowerInvariant()
}

# 路径重写核心：把「盘符:...DSH-ARCHIVE」路径替换为 $replacement
# （逻辑移植自 fix-project-location.ps1 第 5 步，含 JSON 转义保护与 BOM 保留）
function Convert-Paths([string]$text, [string]$isJson, [string]$replacement) {
    $escChar = [char]0xE000
    $escIn = '\' + $escChar
    if ($isJson) { $text = $text.Replace('\\', $escIn) }
    $pattern = '([A-Za-z]):([\\/])([^":''\r\n<>|`]*)DSH-ARCHIVE'
    $new = [regex]::Replace($text, $pattern, {
        param($m)
        if ($m.Groups[2].Value -eq '/') { return $replacement }
        if ($isJson) { return $replacement.Replace('\', '\\') }
        return $replacement
    })
    if ($isJson) { $new = $new.Replace($escIn, '\\') }
    return $new
}

function Read-Text($path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    return ,@($text, $hasBom)
}

# 归一化到统一记号（比较用）：把两边路径都换成 <ARC_ROOT>；行尾不敏感（CRLF 视为 LF）
function Get-Normalized-Text([string]$text, [string]$ext) {
    if ($textExts -contains $ext) {
        $norm = Convert-Paths $text ($ext -eq '.json') $canonical
        # 换行不敏感：先折叠双 CR 残留（\r\r\n 编辑产物），再统一 CRLF/LF
        $norm = $norm -replace "`r`r`n", "`r`n" -replace "`r`n", "`n"
        return $norm
    }
    return $null   # 二进制：调用方按字节比较
}
function Get-Normalized($path) {
    $ext = Get-Ext $path
    $r = Read-Text $path
    return Get-Normalized-Text $r[0] $ext
}

function Compare-File($repoFile, $pkgFile, $label, [bool]$isWin) {
    # 返回 $true = 一致
    $ext = Get-Ext $repoFile
    if ($isWin -and $repoFile -like "$winDropDir*") { return @($true, '') }   # win 白名单：手机专属模块
    if (-not (Test-Path $pkgFile)) { return @($false, "缺失: $label") }
    if ($textExts -contains $ext) {
        $ra = Read-Text (Join-Path $repo $repoFile)
        $ta = $ra[0]
        if ($isWin) {
            if ($repoFile -eq 'dsh/cordis.patch.yml') { $ta = Remove-MobileBlock $ta }
            if ($repoFile -eq 'dsh/package.json')     { $ta = Remove-MobileDep $ta }
        }
        $a = Get-Normalized-Text $ta $ext
        $b = Get-Normalized $pkgFile
        if ($null -eq $a -or $null -eq $b) { return @($false, "读取失败: $label") }
        if ($a -ceq $b) { return @($true, '') }
        return @($false, "内容不一致: $label")
    } else {
        $ba = [System.IO.File]::ReadAllBytes((Join-Path $repo $repoFile))
        $bb = [System.IO.File]::ReadAllBytes($pkgFile)
        if ($ba.Length -ne $bb.Length) { return @($false, "二进制不一致: $label") }
        for ($i = 0; $i -lt $ba.Length; $i++) { if ($ba[$i] -ne $bb[$i]) { return @($false, "二进制不一致: $label") } }
        return @($true, '')
    }
}

function Test-MobileDrop($rel) {
    # 手机包允许缺少的根级 Windows 平台脚本
    if ($rel -notmatch '^[^/\\]+$') { return $false }
    $ext = Get-Ext $rel
    return ($mobDrop -contains $ext) -or $rel -eq 'tray.ps1'
}

# Windows 包剔除：mobile-ui 专属块（cordis.patch.yml 尾部）与专属依赖行（package.json）
function Remove-MobileBlock([string]$text) {
    $idx = $text.IndexOf($mobBlockMarker)
    if ($idx -lt 0) { return $text }
    return $text.Substring(0, $idx).TrimEnd("`r", "`n") + "`r`n"
}
function Remove-MobileDep([string]$text) {
    # 带行首缩进一并删除（否则会残留缩进、把下一行缩进翻倍）
    $pat = '[ \t]*' + [regex]::Escape($mobDepLine) + '(\r\n|\n)'
    return $text -replace $pat, ''
}

# ---------- 发布纯净化：剥离注释中的开发痕迹 ----------
# 处理两类注释：整行注释（普通语言的 # / ; / rem 行，JS 的 // 行与 /* */ 块内行，按块状态判定，
# 避免把模板字符串里的 Markdown 内容误当注释）与行尾注释（只改注释部分，代码部分逐字符保留）。
$plainMarkers = @('#', ';', ';;', 'rem ', 'REM ', 'rem' + [char]9)
$emptyComment = @('//', '#', ';', ';;')

function Get-CommentFlags([string[]]$lines, [string]$ext) {
    # 返回与行一一对应的布尔数组（$true = 整行注释）
    $isJs = ($ext -in '.js', '.cjs', '.mjs')
    $flags = New-Object System.Collections.Generic.List[bool]
    $inBlock = $false
    foreach ($l in $lines) {
        $core = $l.TrimEnd("`r")
        $trim = $core.Trim()
        $c = $false
        if ($isJs) {
            if ($inBlock) { $c = $true }
            if ($trim.StartsWith('//')) { $c = $true }
            if ($trim.StartsWith('/*')) {
                $c = $true
                if (-not $trim.Contains('*/')) { $inBlock = $true }
            }
            if ($inBlock -and $core.Contains('*/')) { $inBlock = $false }
        } else {
            foreach ($m in $plainMarkers) { if ($trim.StartsWith($m)) { $c = $true; break } }
        }
        $flags.Add($c) | Out-Null
    }
    return ,$flags
}

# 行尾注释定位：返回注释起始下标（找不到返回 -1）。
# 保护：① // 前是冒号（http://）时跳过；② 标记前的引号必须成对，否则可能在字符串内；
#       JS 只认 //（JS 里的 # 是私有字段，不能当注释）。
function Find-CommentMark([string]$line, [string]$ext) {
    $isJs = ($ext -in '.js', '.cjs', '.mjs')
    $marks = if ($isJs) { @('//') } else { @('#') }
    foreach ($m in $marks) {
        $i = $line.IndexOf($m)
        while ($i -ge 0) {
            $ok = $true
            if ($m -eq '//' -and $i -gt 0 -and $line[$i - 1] -eq ':') { $ok = $false }
            if ($ok) {
                $pre = $line.Substring(0, $i)
                foreach ($q in @([char]39, [char]34, [char]96)) {
                    if ((($pre.Split($q).Count - 1) % 2) -ne 0) { $ok = $false; break }
                }
            }
            if ($ok) { return $i }
            $i = $line.IndexOf($m, $i + $m.Length)
        }
    }
    return -1
}

function Get-CleanComment([string]$line) {
    $t = $line
    # 括号内只含日期的整体删除（先做，避免删日期后留下空括号）；不做通用空括号清理，
    # 否则会把正文里的 provide() 这类写法也删掉
    $t = [regex]::Replace($t, '[（(【]\s*\d{4}-\d{2}-\d{2}(-\d+)?\s*[）)】]', '')
    $t = [regex]::Replace($t, '\d{4}-\d{2}-\d{2}(-\d+)?', '')      # 其余日期（含 -序号）
    $t = [regex]::Replace($t, '\[阶段[^\]]*\]', '')                # 方括号阶段标记
    $t = [regex]::Replace($t, '\[迭代[^\]]*\]', '')                # 方括号批次标记
    $t = $t -replace '审计修复\s*[：:]?\s*', ''                     # 修复说明前缀
    $t = $t -replace '审计\s*[：:]?\s*', ''                         # 记录说明前缀
    $t = $t -replace 'BUG\s*修复\s*[：:]?\s*', ''                  # 缺陷修复前缀
    $t = [regex]::Replace($t, '迭代\s*[：:]\s*', '')                # 批次标记词
    $t = [regex]::Replace($t, '阶段[一二三四五六七八九十]+([·.][0-9a-zA-Z]+)?(起|开始|以来|至|到)?\s*[：:]?\s*', '')  # 阶段编号（含 ·小节）
    $t = $t -replace '（\s*[：:，,、]\s*', '（' -replace '\s*[：:，,、]\s*）', '）'
    $t = $t -replace '\s+([：:])', '$1' -replace '([：:])\s*[：:]', '$1'
    return $t.TrimEnd()
}

# 逐行处理整行注释；返回 净化后文本 / 改写行数 / 删除行数
function Get-PurifiedText([string]$text, [string]$ext) {
    $lines = $text -split "`n"
    $flags = Get-CommentFlags $lines $ext
    $out = New-Object System.Collections.Generic.List[string]
    $changed = 0; $dropped = 0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $core = $lines[$i].TrimEnd("`r")
        if (-not $flags[$i]) {
            $mk = Find-CommentMark $core $ext
            if ($mk -lt 0) { $out.Add($core) | Out-Null; continue }
            $new = $core.Substring(0, $mk) + (Get-CleanComment $core.Substring($mk))
            if ($new -cne $core) { $changed++ }
            $out.Add($new) | Out-Null
            continue
        }
        $new = Get-CleanComment $core
        if ($new -cne $core) { $changed++ }
        if ($emptyComment -contains $new.Trim()) { $dropped++; continue }
        $out.Add($new) | Out-Null
    }
    return ,@(($out -join "`n"), $changed, $dropped)
}

# 代码序列（整行注释剔除、行尾注释只保留代码部分）：用于"净化只动注释"的自检
function Get-CodeLines([string]$text, [string]$ext) {
    $lines = $text -split "`n"
    $flags = Get-CommentFlags $lines $ext
    $keep = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($flags[$i]) { continue }
        $core = $lines[$i].TrimEnd("`r")
        $mk = Find-CommentMark $core $ext
        if ($mk -ge 0) { $keep.Add($core.Substring(0, $mk).TrimEnd()) | Out-Null } else { $keep.Add($core) | Out-Null }
    }
    return ($keep -join "`n")
}

function Test-SameBytes([byte[]]$a, [byte[]]$b) {
    if ($a.Length -ne $b.Length) { return $false }
    for ($i = 0; $i -lt $a.Length; $i++) { if ($a[$i] -ne $b[$i]) { return $false } }
    return $true
}

# ================= check =================
if ($Action -eq 'check') {
    Write-Host '== 三包一致性校验（仓库为准）=='
    $dirty = @(git -C $repo status --porcelain)
    if ($dirty.Count -gt 0) {
        Write-Host ("  [!] 警告：仓库工作树有 {0} 个未提交改动，校验基于当前工作树内容。" -f $dirty.Count) -ForegroundColor DarkYellow
    }
    foreach ($pkg in @(@{Path=$winPkg; Name='Windows 分发包'; Drop=$false}, @{Path=$mobPkg; Name='手机分发包'; Drop=$true})) {
        Write-Host ("-- {0} --" -f $pkg.Name)
        if (-not (Test-Path $pkg.Path)) { Write-Host '  [错] 包目录不存在' -ForegroundColor Red; continue }
        $issues = @(); $ok = 0
        foreach ($rel in Get-TrackedFiles) {
            if ($pkg.Drop -and (Test-MobileDrop $rel)) { continue }
            $r = Compare-File $rel (Join-Path $pkg.Path $rel) $rel (-not $pkg.Drop)
            if ($r[0]) { $ok++ } else { $issues += $r[1] }
        }
        Write-Host ("  一致 {0} 个文件" -f $ok) -ForegroundColor Green
        if ($issues.Count -gt 0) {
            Write-Host ("  [!] {0} 个差异/缺失：" -f $issues.Count) -ForegroundColor Yellow
            $issues | Select-Object -First 30 | ForEach-Object { Write-Host ('     ' + $_) }
            if ($issues.Count -gt 30) { Write-Host ("     ... 其余 {0} 条略" -f ($issues.Count - 30)) }
        } else {
            Write-Host '  共享代码与仓库完全一致' -ForegroundColor Green
        }
    }
    Write-Host '== 校验完成 =='
    exit 0
}

# ================= build =================
if ($Action -eq 'build') {
    $dirty = @(git -C $repo status --porcelain)
    if ($dirty.Count -gt 0) {
        Write-Host ("  [!] 警告：仓库工作树有 {0} 个未提交改动，打包内容以当前工作树为准（建议先提交再打包）。" -f $dirty.Count) -ForegroundColor DarkYellow
    }
    $targets = @()
    if ($Platform -in 'win', 'both') { $targets += @{Path=$winPkg; Name='Windows 分发包'; Drop=$false; StripWin=$true} }
    if ($Platform -in 'mobile', 'both') { $targets += @{Path=$mobPkg; Name='手机分发包'; Drop=$true; StripWin=$false} }

    foreach ($pkg in $targets) {
        Write-Host ("== 生成 {0} -> {1} ==" -f $pkg.Name, $pkg.Path)
        if (-not (Test-Path $pkg.Path)) { New-Item -ItemType Directory -Path $pkg.Path -Force | Out-Null }
        $copied = 0; $rewritten = 0
        foreach ($rel in Get-TrackedFiles) {
            $src = Join-Path $repo $rel
            $dst = Join-Path $pkg.Path $rel
            New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
            $ext = Get-Ext $rel
            if ($textExts -contains $ext) {
                $r = Read-Text $src
                $new = Convert-Paths $r[0] ($ext -eq '.json') $normTarget
                if ($new -cne $r[0]) { $rewritten++ }
                # 统一行尾：先折叠双 CR 残留，再默认 LF；Windows 平台脚本（.cmd/.ps1/.bat/.vbs）转 CRLF
                $new = $new -replace "`r`r`n", "`r`n" -replace "`r`n", "`n"
                if ($ext -in '.cmd', '.ps1', '.bat', '.vbs') { $new = $new -replace "`n", "`r`n" }
                $enc = New-Object System.Text.UTF8Encoding($r[1])
                [System.IO.File]::WriteAllBytes($dst, $enc.GetBytes($new))
            } else {
                Copy-Item $src $dst -Force
            }
            $copied++
        }
        if ($pkg.Drop) {
            foreach ($rel in Get-TrackedFiles) {
                if (Test-MobileDrop $rel) {
                    $f = Join-Path $pkg.Path $rel
                    if (Test-Path $f) { Remove-Item $f -Force }
                }
            }
            Write-Host ("  已删除根级 Windows 平台脚本（保持手机包形态）") -ForegroundColor DarkYellow
        }
        if ($pkg.StripWin) {
            # 剔除手机专属 mobile-ui：模块目录 + patch 块 + 依赖行
            $mDir = Join-Path $pkg.Path ($winDropDir.Replace('/', '\'))
            if (Test-Path $mDir) { Remove-Item $mDir -Recurse -Force }
            foreach ($rel in @('dsh/cordis.patch.yml', 'dsh/package.json')) {
                $f = Join-Path $pkg.Path ($rel.Replace('/', '\'))
                if (-not (Test-Path $f)) { continue }
                $r = Read-Text $f
                $t = if ($rel -eq 'dsh/cordis.patch.yml') { Remove-MobileBlock $r[0] } else { Remove-MobileDep $r[0] }
                if ($t -cne $r[0]) {
                    $enc = New-Object System.Text.UTF8Encoding($r[1])
                    [System.IO.File]::WriteAllBytes($f, $enc.GetBytes($t))
                }
            }
            Write-Host ("  已剔除手机专属 mobile-ui（模块+patch+依赖，保持 Windows 包形态）") -ForegroundColor DarkYellow
        }
        Write-Host ("  已复制 {0} 个文件（其中 {1} 个文本文件路径已归一化为 {2}）" -f $copied, $rewritten, $normTarget) -ForegroundColor Green
        Write-Host ("  包内 data/ollama/backups 未触碰（用户数据保留）") -ForegroundColor Green
    }
    Write-Host '== 打包完成；建议随后运行 check 复核 =='
    exit 0
}

# ================= pure（发布纯净化） =================
if ($Action -eq 'pure') {
    Write-Host '== 发布纯净化：Windows 分发包 -> 发布版（剥离注释开发痕迹）=='
    if (-not (Test-Path $winPkg))  { Write-Host '  [错] Windows 分发包不存在，请先 build' -ForegroundColor Red; exit 1 }
    if (-not (Test-Path $purePkg)) { Write-Host '  [错] 发布版目录不存在' -ForegroundColor Red; exit 1 }
    $skipDir = '\\(\.git|ollama|backups|\.pnpm-store|node_modules|data|logs)(\\|$)'
    $updated = @(); $missing = 0; $same = 0; $cleanedLines = 0; $droppedLines = 0; $badCode = @()
    $files = Get-ChildItem $winPkg -Recurse -File -Force | Where-Object { $_.FullName -notmatch $skipDir }
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($winPkg.Length).TrimStart('\')
        if ((Split-Path $rel -Leaf) -eq 'README.md') { continue }   # 发布版自有 README，不参与同步
        $dst = Join-Path $purePkg $rel
        if (-not (Test-Path -LiteralPath $dst)) { $missing++; continue }   # 不新增文件（保持发布形态）
        $ext = Get-Ext $rel
        $isText = ($textExts -contains $ext) -or ((Split-Path $rel -Leaf) -eq '.gitignore')
        if ($isText -and ($ext -notin '.json', '.md')) {
            $r = Read-Text $f.FullName
            $p = Get-PurifiedText $r[0] $ext
            $new = $p[0]
            # 自检：注释以外的部分必须与源逐字符一致
            if ((Get-CodeLines $r[0] $ext) -cne (Get-CodeLines $new $ext)) { $badCode += $rel; continue }
            $new = $new -replace "`r`r`n", "`r`n" -replace "`r`n", "`n"
            if ($ext -in '.cmd', '.ps1', '.bat', '.vbs') { $new = $new -replace "`n", "`r`n" }
            $enc = New-Object System.Text.UTF8Encoding($r[1])
            $bytes = $enc.GetBytes($new)
            if (Test-SameBytes $bytes ([System.IO.File]::ReadAllBytes($dst))) { $same++; continue }
            [System.IO.File]::WriteAllBytes($dst, $bytes)
            $updated += $rel; $cleanedLines += $p[1]; $droppedLines += $p[2]
        } else {
            $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
            if (Test-SameBytes $bytes ([System.IO.File]::ReadAllBytes($dst))) { $same++; continue }
            [System.IO.File]::WriteAllBytes($dst, $bytes)
            $updated += $rel
        }
    }
    Write-Host '-- 已更新到发布版 --' -ForegroundColor Green
    $updated | ForEach-Object { Write-Host ('   ' + $_) }
    Write-Host ("  更新 {0} 个文件；注释净化 {1} 行、删除空注释 {2} 行；未变化 {3} 个；发布版未收录 {4} 个（不新增）" -f $updated.Count, $cleanedLines, $droppedLines, $same, $missing) -ForegroundColor Green
    if ($badCode.Count -gt 0) { Write-Host ("  [错] 以下文件的非注释行发生变化（已跳过）：" + ($badCode -join ', ')) -ForegroundColor Red }

    # 语法自检：JS 用 node --check，PS1 用 PS 解析器（原生命令的错误输出不能走管道，
    # 否则 PS5.1 在 EAP=Stop 下会把 stderr 当终止性错误抛出）
    $jsBad = 0; $jsN = 0; $psBad = 0; $psN = 0
    $eapPrev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    foreach ($rel in $updated) {
        $ext = Get-Ext $rel
        $full = Join-Path $purePkg $rel
        if ($ext -in '.js', '.cjs', '.mjs') {
            $jsN++
            $null = & node --check $full 2>&1
            if ($LASTEXITCODE -ne 0) { $jsBad++; Write-Host ("  [错] node --check 失败: " + $rel) -ForegroundColor Red }
        } elseif ($ext -eq '.ps1') {
            $psN++
            $tok = $null; $err = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile($full, [ref]$tok, [ref]$err)
            if ($err -and $err.Count -gt 0) { $psBad++; Write-Host ("  [错] PS 解析失败: " + $rel) -ForegroundColor Red }
        }
    }
    $ErrorActionPreference = $eapPrev
    Write-Host ("  语法自检：JS {0} 个（失败 {1}）；PS1 {2} 个（失败 {3}）" -f $jsN, $jsBad, $psN, $psBad) -ForegroundColor Green
    Write-Host '== 发布纯净化完成；请随后在发布版仓库提交并推送 =='
    exit 0
}
