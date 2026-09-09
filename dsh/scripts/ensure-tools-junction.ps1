# 确保 @deepseek-ai/dsh-tools 通过 junction 指向 launcher 的同一副本。
# 原因：插件 import defineTool 与 loader 的 tools 服务必须使用同一个模块实例
# （TOOL_RUNTIME_SCHEDULER 是 Symbol，两个物理副本 = 两个 Symbol，agent 工具调用会
# 报 "reading 'prepare' of undefined"）。web profile 不显式依赖 dsh-tools，天然一致；
# 本 profile 因插件需要而显式引入，须用 junction 归一到 launcher 副本。
$ErrorActionPreference = 'Stop'
$link = Join-Path $PSScriptRoot '..\node_modules\@deepseek-ai\dsh-tools'
$target = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules\@deepseek-ai\dsh-tools'

if (-not (Test-Path $target)) { throw "launcher dsh-tools not found: $target" }
if (-not (Test-Path $link)) {
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    Write-Host "created junction: $link -> $target"
} else {
    $item = Get-Item $link
    if ($item.LinkType -ne 'Junction' -or "$($item.Target)" -ne $target) {
        Remove-Item $link -Recurse -Force
        New-Item -ItemType Junction -Path $link -Target $target | Out-Null
        Write-Host "re-created junction: $link -> $target"
    } else {
        Write-Host "junction ok: $link"
    }
}
