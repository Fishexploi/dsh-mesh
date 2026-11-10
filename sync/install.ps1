[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $HOME '.dsh\profiles\desktop'),
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "找不到 DSH profile 的 package.json：$manifestPath"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $ProfileDir "package.json.mesh-sync-$stamp.bak"
Copy-Item -LiteralPath $manifestPath -Destination $backup
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path -LiteralPath $patchPath) {
  Copy-Item -LiteralPath $patchPath -Destination (Join-Path $ProfileDir "cordis.patch.yml.mesh-sync-$stamp.bak")
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
if (-not $manifest.dependencies) {
  $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
if (-not $manifest.dsh) {
  throw 'profile package.json 缺少 dsh 配置'
}
if (-not $manifest.dsh.profile) {
  $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{})
}
if (-not $manifest.dsh.profile.bundles) {
  $manifest.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @()
}

$meshSpec = 'file:' + $repoRoot.Replace('\', '/')
$dependencies = [ordered]@{
  '@fishexploi/dsh-mesh' = $meshSpec
  'dsh-mnemon' = '0.5.42'
  'dsh-pet' = '0.4.7'
  'dsh-plugin-startup-animation' = '1.31.1'
  'dshmarket' = '1.73.10'
}
foreach ($name in $dependencies.Keys) {
  $value = $dependencies[$name]
  if ($manifest.dependencies.PSObject.Properties.Name -contains $name) {
    $manifest.dependencies.$name = $value
  } else {
    $manifest.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $value
  }
}

$bundles = @($manifest.dsh.profile.bundles)
foreach ($name in @('dshmarket', 'dsh-mnemon', 'dsh-plugin-startup-animation', '@fishexploi/dsh-mesh')) {
  if ($bundles -notcontains $name) { $bundles += $name }
}
$manifest.dsh.profile.bundles = $bundles

$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding utf8

Write-Host "已更新 profile: $ProfileDir"
Write-Host "已备份原 package.json: $backup"
Write-Host "dsh-mesh -> $repoRoot"
Write-Host "bundle: $($bundles -join ', ')"

if ($SkipInstall) {
  Write-Host '已跳过 pnpm install（-SkipInstall）。'
  exit 0
}

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
  Write-Warning '没有找到 pnpm。请改用 DSH 插件管理器安装，或把 pnpm 放进 PATH 后重跑。'
  exit 2
}

Push-Location $ProfileDir
try {
  & $pnpm.Source install
  if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败，退出码 $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host '安装完成。重启 DSH 后插件才会加载。'
