<#
.SYNOPSIS
  卸载 / 回滚 dsh-codex-bridge

.DESCRIPTION
  1. 从 profile 的 package.json 移除依赖与 bundles 声明
  2. 删除已安装的插件目录
  3. 若指定 -BackupDir，则用该备份恢复 package.json / cordis.patch.yml

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/rollback.ps1
  powershell -ExecutionPolicy Bypass -File scripts/rollback.ps1 -BackupDir "C:\Users\me\.dsh\profiles\desktop\.codex-bridge-backup-20261018-120000"
#>

param(
  [string]$BackupDir = '',
  [string]$ProfileDir = ''
)

$ErrorActionPreference = 'Stop'

if (-not $ProfileDir) {
  $ProfileDir = if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
}
$PluginDir = Join-Path $ProfileDir 'node_modules\dsh-codex-bridge'

Write-Host ''
Write-Host '=== 回滚 DSH 会话桥接 ===' -ForegroundColor Cyan
Write-Host "  Profile: $ProfileDir"

if (-not (Test-Path $ProfileDir)) {
  Write-Host "❌ profile 不存在: $ProfileDir" -ForegroundColor Red
  exit 1
}

$PkgPath = Join-Path $ProfileDir 'package.json'

# ── 1. 优先用备份恢复 ──
if ($BackupDir -and (Test-Path $BackupDir)) {
  foreach ($pair in @(@('package.json', 'package.json'), @('cordis.patch.yml', 'cordis.patch.yml'))) {
    $src = Join-Path $BackupDir $pair[0]
    $dst = Join-Path $ProfileDir $pair[1]
    if (Test-Path $src) {
      Copy-Item $src $dst -Force
      Write-Host "  ✅ 已恢复 $($pair[1])" -ForegroundColor Green
    }
  }
} elseif (Test-Path $PkgPath) {
  # ── 2. 没有备份则从 package.json 里摘掉声明 ──
  $pkg = Get-Content $PkgPath -Raw | ConvertFrom-Json
  if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties.Name -contains 'dsh-codex-bridge') {
    $pkg.dependencies.PSObject.Properties.Remove('dsh-codex-bridge')
    Write-Host '  ✅ 已移除 dependencies 条目' -ForegroundColor Green
  }
  if ($pkg.dsh -and $pkg.dsh.bundles) {
    $bundles = @($pkg.dsh.bundles) | Where-Object { $_ -ne 'dsh-codex-bridge' }
    $pkg.dsh | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
    Write-Host '  ✅ 已移除 bundles 条目' -ForegroundColor Green
  }
  $pkg | ConvertTo-Json -Depth 30 | Out-File $PkgPath -Encoding utf8
} else {
  Write-Host '  ⚠️  未找到 package.json，跳过配置清理' -ForegroundColor Yellow
}

# ── 3. 删除插件目录 ──
if (Test-Path $PluginDir) {
  Remove-Item $PluginDir -Recurse -Force
  Write-Host "  ✅ 已删除 $PluginDir" -ForegroundColor Green
} else {
  Write-Host '  （插件目录不存在，无需删除）'
}

Write-Host ''
Write-Host '回滚完成，请重启 DSH。' -ForegroundColor Cyan
Write-Host ''
