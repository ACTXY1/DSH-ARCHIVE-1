# 确保 @deepseek-ai/dsh-tools 模块实例一致（ 独立化版）。
# 背景：插件 import defineTool 与 loader 的 tools 服务必须使用同一个物理模块实例
# （TOOL_RUNTIME_SCHEDULER 是 Symbol，两个物理副本 = 两个 Symbol，agent 工具调用会报
# "reading 'prepare' of undefined"）。
# 独立化后：项目自带引擎（node_modules\@deepseek-ai\dsh）自身依赖 dsh-tools，pnpm(hoisted)
# 将其安装在项目 node_modules\@deepseek-ai\dsh-tools（真实包）。launcher 在项目 home 下的
# 回退副本由引擎首次运行自动 heal；本脚本确保该回退副本存在并指向项目内的同一副本，
# 全程不依赖全局 dsh 或 ~/.dsh。
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent   # <项目根>
$pkg  = Join-Path $root 'dsh\node_modules\@deepseek-ai\dsh-tools'
$homeDir = Join-Path $root '.dsh-home'
$link = Join-Path $homeDir 'profiles\node_modules\@deepseek-ai\dsh-tools'

if (-not (Test-Path (Join-Path $pkg 'package.json'))) {
    throw "项目内 dsh-tools 缺失（$pkg）。请先执行：cd `"$root\dsh`" && pnpm install"
}
if (-not (Test-Path (Split-Path $link -Parent))) {
    New-Item -ItemType Directory -Force -Path (Split-Path $link -Parent) | Out-Null
}
if (-not (Test-Path $link)) {
    New-Item -ItemType Junction -Path $link -Target $pkg | Out-Null
    Write-Host "created junction: $link -> $pkg"
} else {
    $item = Get-Item $link -Force
    if ($item.LinkType -ne 'Junction') {
        Write-Host "warning: $link 不是 junction（可能是真实目录）——保持不变以防误删"
    } elseif ((($item.Target -join '') -replace '\\', '/').TrimEnd('/') -ne (($pkg -replace '\\', '/').TrimEnd('/'))) {
        & cmd /c rmdir "`"$link`"" | Out-Null
        New-Item -ItemType Junction -Path $link -Target $pkg | Out-Null
        Write-Host "re-created junction: $link -> $pkg"
    } else {
        Write-Host "junction ok: $link"
    }
}
