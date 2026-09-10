# Sync local project plugins into the profile node_modules.
# Background: pnpm treats file: dependencies as hard links / static references;
# editing source files (the write tool recreates files and breaks hard links)
# leaves the profile boot loading stale inode content.
# Usage: after editing any plugin under C:/DSH-ARCHIVE\modules, run this script
# before starting the profile. Stop running dsh processes first if files lock.

$ErrorActionPreference = 'Stop'
# 先确保 dsh-tools junction（pnpm install 会清掉它；插件与 loader 必须同一模块实例）
& (Join-Path $PSScriptRoot 'ensure-tools-junction.ps1')

$profileNodeModules = Join-Path $PSScriptRoot '..\node_modules'
$moduleRoot = Join-Path $PSScriptRoot '..\..\modules'

$plugins = @(
    @{ source = (Join-Path $moduleRoot 'ledger'); target = 'dsh-archive-ledger' },
    @{ source = (Join-Path $moduleRoot 'memory'); target = 'dsh-archive-memory' },
    @{ source = (Join-Path $moduleRoot 'persona'); target = 'dsh-archive-persona' },
    @{ source = (Join-Path $moduleRoot 'clock'); target = 'dsh-archive-clock' },
    @{ source = (Join-Path $moduleRoot 'loop'); target = 'dsh-archive-loop' },
    @{ source = (Join-Path $moduleRoot 'evolution'); target = 'dsh-archive-evolution' },
    @{ source = (Join-Path $moduleRoot 'notify'); target = 'dsh-archive-notify' },
    @{ source = (Join-Path $moduleRoot 'schedule'); target = 'dsh-archive-schedule' },
    @{ source = (Join-Path $moduleRoot 'control'); target = 'dsh-archive-control' },
    @{ source = (Join-Path $moduleRoot 'consistency'); target = 'dsh-archive-consistency' },
    @{ source = (Join-Path $moduleRoot 'subconscious'); target = 'dsh-archive-subconscious' },
    @{ source = (Join-Path $moduleRoot 'web-fetch'); target = 'dsh-archive-web-fetch' },
    @{ source = (Join-Path $moduleRoot 'web-perf'); target = 'dsh-archive-web-perf' }
)

foreach ($p in $plugins) {
    $target = Join-Path $profileNodeModules $p.target
    Write-Host "syncing $($p.target) -> $target"
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Copy-Item -Path (Join-Path $p.source '*') -Destination $target -Recurse -Force
}
Write-Host 'sync done'
