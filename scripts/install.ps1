<#
.SYNOPSIS
  安装 dsh-codex-bridge 到 DSH desktop profile

.DESCRIPTION
  1. 备份 profile 的 package.json / cordis.patch.yml
  2. 复制插件构建产物到 profile 的 node_modules
  3. 把插件登记到 profile 的 dependencies 与 dsh.bundles
  4. 提示重启 DSH

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install.ps1
#>

$ErrorActionPreference = 'Stop'

# 强制 UTF-8 输出，避免中文在旧控制台下乱码
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch { }

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PluginDir = Join-Path $RepoRoot 'plugin'

# ── 定位 DSH desktop profile ──
$ProfileDir = if ($env:DSH_PROFILE_DIR) {
  $env:DSH_PROFILE_DIR
} else {
  Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
}

Write-Host ''
Write-Host '=== DSH 会话桥接 · 安装 ===' -ForegroundColor Cyan
Write-Host "  仓库目录: $RepoRoot"
Write-Host "  Profile : $ProfileDir"
Write-Host ''

if (-not (Test-Path $ProfileDir)) {
  Write-Host "❌ 未找到 DSH desktop profile: $ProfileDir" -ForegroundColor Red
  Write-Host '   请确认 DSH 桌面版已安装并至少启动过一次。' -ForegroundColor Yellow
  Write-Host '   也可用 -DSH_PROFILE_DIR 环境变量指定路径：'
  Write-Host '     $env:DSH_PROFILE_DIR = "D:\path\to\profile"'
  exit 1
}

if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) {
  Write-Host "❌ 未找到插件目录: $PluginDir" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path (Join-Path $PluginDir 'lib\index.js'))) {
  Write-Host '⚠️  未找到构建产物 lib/index.js' -ForegroundColor Yellow
  Write-Host '   尝试构建…'
  Push-Location $PluginDir
  try {
    if (-not (Test-Path 'node_modules')) { npm install }
    npm run build
  } finally {
    Pop-Location
  }
  if (-not (Test-Path (Join-Path $PluginDir 'lib\index.js'))) {
    Write-Host '❌ 构建失败，请手动运行: cd plugin; npm install; npm run build' -ForegroundColor Red
    exit 1
  }
}

# ── 备份 ──
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $ProfileDir ".codex-bridge-backup-$Stamp"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

foreach ($f in @('package.json', 'cordis.patch.yml')) {
  $src = Join-Path $ProfileDir $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $BackupDir $f) -Force }
}
Write-Host "✅ 已备份配置 → $BackupDir" -ForegroundColor Green

# ── 复制插件 ──
$TargetDir = Join-Path $ProfileDir 'node_modules\dsh-codex-bridge'
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
foreach ($item in @('lib', 'locale', 'assets')) {
  $src = Join-Path $PluginDir $item
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $TargetDir $item) -Recurse -Force
  }
}
foreach ($f in @('package.json', 'cordis.patch.yml', 'README.md')) {
  $src = Join-Path $PluginDir $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $TargetDir $f) -Force }
}
Write-Host "✅ 已复制插件 → $TargetDir" -ForegroundColor Green

# ── 登记到 profile package.json ──
$ProfilePkgPath = Join-Path $ProfileDir 'package.json'
$pkg = Get-Content $ProfilePkgPath -Raw | ConvertFrom-Json

# dependencies
if (-not $pkg.dependencies) {
  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
$depPath = "file:$($PluginDir -replace '\\', '/')"
$pkg.dependencies | Add-Member -NotePropertyName 'dsh-codex-bridge' -NotePropertyValue $depPath -Force

# dsh.bundles
if ($pkg.dsh) {
  $bundles = @($pkg.dsh.bundles)
  if ($bundles -notcontains 'dsh-codex-bridge') {
    $bundles += 'dsh-codex-bridge'
    $pkg.dsh | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
  }
} else {
  Write-Host '⚠️  profile package.json 里没有 dsh 字段，跳过 bundles 登记' -ForegroundColor Yellow
}

$pkg | ConvertTo-Json -Depth 30 | Out-File $ProfilePkgPath -Encoding utf8
Write-Host '✅ 已登记到 profile package.json' -ForegroundColor Green

Write-Host ''
Write-Host '=== 安装完成 ===' -ForegroundColor Cyan
Write-Host ''
Write-Host '下一步：' -ForegroundColor Yellow
Write-Host '  1. 完全退出 DSH 并重新启动'
Write-Host '  2. 打开 插件，找到 [会话桥接]'
Write-Host ''
Write-Host "如需回滚: powershell -ExecutionPolicy Bypass -File scripts/rollback.ps1 -BackupDir `"$BackupDir`"" -ForegroundColor DarkGray
Write-Host ''
