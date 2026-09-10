# ============================================================
#  push-seed.ps1 —— 首次推送种子仓库到远程（私有）
#  前置：先在 GitHub 建一个【空】私有仓库（不要勾选 README/license 等
#        任何初始化文件），仓库名建议 dsh-archive（或 DSH-ARCHIVE）。
#  用法（在项目根目录 C:/DSH-ARCHIVE 下）：
#    powershell -NoProfile -ExecutionPolicy Bypass -File push-seed.ps1
#    或直接指定 URL：
#    powershell -NoProfile -ExecutionPolicy Bypass -File push-seed.ps1 `
#        -RepoUrl https://github.com/<你的账号>/dsh-archive.git `
#        -GiteeUrl https://gitee.com/<你的账号>/dsh-archive.git   # 可选镜像
#  说明：推送走本机 git 凭据（HTTPS 凭据管理器 / SSH 均可）；
#        本脚本不接收、不保存任何 token。
# ============================================================
param(
    [string]$RepoUrl = '',
    [string]$GiteeUrl = ''
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
Push-Location $repo
try {
    Write-Host '============================================'
    Write-Host '  DSH-ARCHIVE 种子仓库推送'
    Write-Host ("  项目根：{0}" -f $repo)
    Write-Host '============================================'

    if (-not $RepoUrl) {
        $RepoUrl = Read-Host '远程私有仓库 URL（例如 https://github.com/you/dsh-archive.git）'
    }
    if (-not $RepoUrl) { throw '未提供仓库 URL，中止。' }
    if ($RepoUrl -notmatch '\.git$') { $RepoUrl += '.git' }   # 自动补 .git 后缀
    if ($GiteeUrl -and $GiteeUrl -notmatch '\.git$') { $GiteeUrl += '.git' }

    # ---- origin ----
    $has = @(git remote 2>$null) -contains 'origin'
    if ($has) {
        & git remote set-url origin $RepoUrl
        Write-Host '[OK] origin URL 已更新' -ForegroundColor Green
    } else {
        & git remote add origin $RepoUrl
        Write-Host '[OK] origin 已添加' -ForegroundColor Green
    }

    # ---- 推送 main + tags ----
    Write-Host '推送 main 分支（首次需本机 git 凭据）...' -ForegroundColor DarkYellow
    & git push -u origin main
    if ($LASTEXITCODE -ne 0) { throw 'push main 失败' }
    & git push origin --tags
    if ($LASTEXITCODE -ne 0) { throw 'push tags 失败' }

    # ---- Gitee 镜像（可选）----
    if ($GiteeUrl) {
        $hasM = @(git remote 2>$null) -contains 'mirror'
        if ($hasM) { & git remote set-url mirror $GiteeUrl } else { & git remote add mirror $GiteeUrl }
        Write-Host '推送 Gitee 镜像...' -ForegroundColor DarkYellow
        & git push mirror main --tags
        if ($LASTEXITCODE -ne 0) { Write-Host '[!] Gitee 推送失败（不影响 GitHub）' -ForegroundColor DarkYellow }
    }

    Write-Host ''
    Write-Host '============ 推送完成 ============' -ForegroundColor Green
    & git remote -v
    Write-Host ''
    Write-Host '后续每次迭代：改代码 → sync-packages.ps1 校验 → 更新 VERSION/README →' -ForegroundColor Cyan
    Write-Host '  git add -A && git commit -m "..." && git tag vYYYY-MM-DD' -ForegroundColor Cyan
    Write-Host '  git push origin main --tags    （Gitee：git push mirror main --tags）' -ForegroundColor Cyan
} finally {
    Pop-Location
}
