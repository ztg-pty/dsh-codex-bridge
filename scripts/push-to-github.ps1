<#
.SYNOPSIS
  把本地仓库推送到 GitHub（自动处理代理与仓库创建）

.DESCRIPTION
  1. 可选设置代理（-Proxy）
  2. 检查 gh 登录状态；未登录则提示登录方式
  3. 若远程仓库不存在，用 gh 创建（默认 public）
  4. 推送 main 分支

.EXAMPLE
  # 直连（不需要代理）
  powershell -ExecutionPolicy Bypass -File scripts/push-to-github.ps1

  # 走本地代理（Clash / v2ray 等）
  powershell -ExecutionPolicy Bypass -File scripts/push-to-github.ps1 -Proxy "http://127.0.0.1:7890"

  # 指定仓库名 / 私有
  powershell -ExecutionPolicy Bypass -File scripts/push-to-github.ps1 -RepoName my-bridge -Private
#>

param(
  [string]$Proxy = '',
  [string]$RepoName = 'dsh-codex-bridge',
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {
  Write-Host ''
  Write-Host '=== 推送到 GitHub ===' -ForegroundColor Cyan

  # ── 1. 代理 ──
  if ($Proxy) {
    $env:HTTP_PROXY = $Proxy
    $env:HTTPS_PROXY = $Proxy
    $env:ALL_PROXY = $Proxy
    Write-Host "  已设置代理: $Proxy" -ForegroundColor Green
  } else {
    Write-Host '  未指定代理（直连）' -ForegroundColor DarkGray
  }

  # ── 2. 连通性检测 ──
  Write-Host '  检测 github.com 连通性…'
  $reachable = $false
  try {
    $null = Invoke-WebRequest -Uri 'https://api.github.com' -TimeoutSec 12 -UseBasicParsing -ErrorAction Stop
    $reachable = $true
  } catch {
    $reachable = $false
  }
  if (-not $reachable) {
    Write-Host '❌ 无法访问 github.com' -ForegroundColor Red
    Write-Host ''
    Write-Host '常见原因与处理：' -ForegroundColor Yellow
    Write-Host '  · 需要代理：先启动代理软件，再用 -Proxy 参数指定端口'
    Write-Host '      例: -Proxy "http://127.0.0.1:7890"   (Clash 默认)'
    Write-Host '      例: -Proxy "http://127.0.0.1:10809"  (v2ray 默认)'
    Write-Host '  · 或使用 GitHub Desktop 手动发布本仓库'
    exit 1
  }
  Write-Host '  ✅ github.com 可访问' -ForegroundColor Green

  # ── 3. 登录检查 ──
  $authOk = $false
  try {
    gh auth status 2>&1 | Out-Null
    $authOk = ($LASTEXITCODE -eq 0)
  } catch { $authOk = $false }

  if (-not $authOk) {
    Write-Host ''
    Write-Host '⚠️  gh CLI 未登录 GitHub' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '请任选一种方式完成登录，然后重新运行本脚本：'
    Write-Host ''
    Write-Host '  方式 A（推荐，浏览器授权）:' -ForegroundColor White
    Write-Host '    gh auth login --hostname github.com --git-protocol https --web'
    Write-Host ''
    Write-Host '  方式 B（用 Personal Access Token）:' -ForegroundColor White
    Write-Host '    1. 打开 https://github.com/settings/tokens 创建 token（勾选 repo 权限）'
    Write-Host '    2. 执行:  $env:GH_TOKEN = "ghp_xxx"'
    Write-Host '    3. 重新运行本脚本'
    exit 1
  }
  Write-Host '  ✅ gh 已登录' -ForegroundColor Green

  # ── 4. 创建远程仓库（不存在时）──
  $user = (gh api user --jq .login 2>$null)
  if (-not $user) { $user = 'unknown' }
  Write-Host "  GitHub 账号: $user"

  $remoteUrl = "https://github.com/$user/$RepoName.git"
  gh repo view "$user/$RepoName" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  远程仓库不存在，正在创建 $user/$RepoName …"
    $visibility = if ($Private) { '--private' } else { '--public' }
    gh repo create $RepoName $visibility --description 'DSH 会话桥接：Codex / DSH / WorkBuddy 三端会话互通' 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host '❌ 仓库创建失败（可能同名仓库已存在或权限不足）' -ForegroundColor Red
      exit 1
    }
    Write-Host '  ✅ 仓库已创建' -ForegroundColor Green
  } else {
    Write-Host '  ✅ 远程仓库已存在' -ForegroundColor Green
  }

  # ── 5. 推送 ──
  git remote remove origin 2>$null
  git remote add origin $remoteUrl
  Write-Host "  推送 main → $remoteUrl"
  git push -u origin main
  if ($LASTEXITCODE -ne 0) {
    Write-Host '❌ 推送失败' -ForegroundColor Red
    exit 1
  }

  Write-Host ''
  Write-Host '=== 推送完成 ===' -ForegroundColor Cyan
  Write-Host "  仓库地址: https://github.com/$user/$RepoName"
  Write-Host ''
} finally {
  Pop-Location
}
