<#
  Diagnose and repair a DSH profile where dsh-mesh is installed under both the
  old unscoped name and the scoped one.

  Symptom: DSH will not boot and the crash log says
      web boot: 1 entry did not activate
      dsh-mesh: import failed
  with a renderer error
      client-modules: duplicate factory registration for "dsh-mesh"

  Cause: the profile still lists the old "dsh-mesh" bundle (or the old
  node_modules copy) next to "@fishboy/dsh-mesh". One row cannot resolve, and the
  client bundle registers its factory twice.

  Usage:
    powershell -ExecutionPolicy Bypass -File repair-profile.ps1            # report only
    powershell -ExecutionPolicy Bypass -File repair-profile.ps1 -Fix       # repair
    powershell -ExecutionPolicy Bypass -File repair-profile.ps1 -ProfileDir "C:\Users\me\.dsh\profiles\desktop" -Fix

  Nothing is deleted: a stale copy is moved aside to <node_modules>\<name>.stale-<timestamp>.
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $HOME '.dsh\profiles\desktop'),
  [switch]$Fix
)

$ErrorActionPreference = 'Stop'
$Canonical = '@fishboy/dsh-mesh'
$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "profile package.json not found: $manifestPath" }

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$nodeModules = Join-Path $ProfileDir 'node_modules'

function Get-MeshKeys($obj) {
  @($obj.PSObject.Properties.Name | Where-Object { $_ -match '(^|/)dsh-mesh$' })
}

$depKeys = if ($manifest.dependencies) { Get-MeshKeys $manifest.dependencies } else { @() }
$bundles = @()
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) { $bundles = @($manifest.dsh.profile.bundles) }
$bundleMesh = @($bundles | Where-Object { $_ -match '(^|/)dsh-mesh$' })

Write-Host "[info] profile: $ProfileDir"
Write-Host "[info] dependency keys matching dsh-mesh: $(if ($depKeys.Count) { $depKeys -join ', ' } else { '(none)' })"
foreach ($key in $depKeys) { Write-Host ("       {0} = {1}" -f $key, $manifest.dependencies.$key) }
Write-Host "[info] bundle rows matching dsh-mesh: $(if ($bundleMesh.Count) { $bundleMesh -join ', ' } else { '(none)' })"

$installed = @()
foreach ($entry in Get-ChildItem -LiteralPath $nodeModules -Force -ErrorAction SilentlyContinue) {
  if ($entry.Name -eq 'dsh-mesh') { $installed += $entry.FullName }
  elseif ($entry.Name -like '@*' -and $entry.PSIsContainer) {
    $scoped = Join-Path $entry.FullName 'dsh-mesh'
    if (Test-Path -LiteralPath $scoped) { $installed += $scoped }
  }
}
Write-Host "[info] installed copies:"
foreach ($path in $installed) {
  $item = Get-Item -LiteralPath $path -Force
  $target = ''
  if ($item.LinkType) { $target = ' -> ' + (($item.Target | Select-Object -First 1)) }
  Write-Host ("       {0}{1}" -f $path, $target)
}
if (-not $installed.Count) { Write-Host '       (none)' }

$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path -LiteralPath $patchPath) {
  $patchLines = Get-Content -LiteralPath $patchPath -Encoding UTF8 | Select-String -Pattern 'dsh-mesh'
  if ($patchLines) {
    Write-Host '[warn] cordis.patch.yml mentions dsh-mesh:'
    foreach ($line in $patchLines) { Write-Host ('       ' + $line.Line.Trim()) }
  }
}

$problems = @()
if ($bundleMesh.Count -gt 1) { $problems += 'the bundle list has more than one dsh-mesh row' }
if ($depKeys.Count -gt 1) { $problems += 'the dependency list has more than one dsh-mesh key' }
if ($installed.Count -gt 1) { $problems += 'node_modules holds more than one dsh-mesh copy' }
if ($bundleMesh.Count -eq 1 -and $bundleMesh[0] -ne $Canonical) { $problems += "the bundle row is still the old name ($($bundleMesh[0]))" }
if ($depKeys.Count -eq 1 -and $depKeys[0] -ne $Canonical) { $problems += "the dependency key is still the old name ($(@($depKeys)[0]))" }
$canonicalPath = Join-Path (Join-Path $nodeModules '@fishboy') 'dsh-mesh'
if (-not (Test-Path -LiteralPath $canonicalPath)) { $problems += "no scoped install at $canonicalPath" }

if (-not $problems.Count) {
  Write-Host '[ok] nothing to repair: exactly one scoped install and one scoped row.'
  exit 0
}

Write-Host ''
Write-Host '[findings]'
foreach ($problem in $problems) { Write-Host ('  - ' + $problem) }

if (-not $Fix) {
  Write-Host ''
  Write-Host 'Run again with -Fix to: keep only the scoped install, drop the old dependency key and bundle row, and move any stale copy aside.'
  exit 1
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $ProfileDir "package.json.repair-$stamp.bak"
Copy-Item -LiteralPath $manifestPath -Destination $backup
Write-Host "[ok] manifest backup: $backup"

# 1. Keep exactly one dependency key, and make it the scoped one.
$existingSpec = $null
foreach ($key in $depKeys) {
  if ($key -eq $Canonical) { $existingSpec = [string]$manifest.dependencies.$key }
}
if (-not $existingSpec) {
  $oldKey = $depKeys | Select-Object -First 1
  if ($oldKey) { $existingSpec = [string]$manifest.dependencies.$oldKey }
}
if (-not $existingSpec) { $existingSpec = 'link:' + ((Resolve-Path -LiteralPath $nodeModules).Path -replace '\\', '/') }

foreach ($key in $depKeys) {
  if ($key -ne $Canonical) { $manifest.dependencies.PSObject.Properties.Remove($key) | Out-Null }
}
$manifest.dependencies | Add-Member -NotePropertyName $Canonical -NotePropertyValue $existingSpec -Force

# 2. Keep exactly one bundle row, the scoped one, in its original position.
$rebuilt = @()
$placed = $false
foreach ($bundle in $bundles) {
  if ($bundle -match '(^|/)dsh-mesh$') {
    if (-not $placed) { $rebuilt += $Canonical; $placed = $true }
  } else {
    $rebuilt += $bundle
  }
}
if (-not $placed) { $rebuilt += $Canonical }
$manifest.dsh.profile.bundles = @($rebuilt)

# 3. Make sure the scoped install exists, then move the stale copy aside.
$oldPath = Join-Path $nodeModules 'dsh-mesh'
$scopeDir = Join-Path $nodeModules '@fishboy'
$consumedOld = $false
if (-not (Test-Path -LiteralPath $canonicalPath)) {
  if (-not (Test-Path -LiteralPath $oldPath)) {
    throw 'no copy to point the scoped install at; reinstall the plugin and run this again'
  }
  $oldItem = Get-Item -LiteralPath $oldPath -Force
  if (-not (Test-Path -LiteralPath $scopeDir)) { New-Item -ItemType Directory -Path $scopeDir | Out-Null }
  if ($oldItem.LinkType) {
    $target = $oldItem.Target | Select-Object -First 1
    New-Item -ItemType Junction -Path $canonicalPath -Target $target | Out-Null
    cmd /c rmdir "$oldPath" | Out-Null
    Write-Host "[ok] replaced the old link with $canonicalPath -> $target"
  } else {
    Move-Item -LiteralPath $oldPath -Destination $canonicalPath
    $manifest.dependencies | Add-Member -NotePropertyName $Canonical `
      -NotePropertyValue ('link:' + ($canonicalPath -replace '\\', '/')) -Force
    Write-Host "[ok] moved the installed copy to $canonicalPath"
  }
  $consumedOld = $true
}

if (-not $consumedOld -and (Test-Path -LiteralPath $oldPath) -and (Test-Path -LiteralPath $canonicalPath)) {
  $oldItem = Get-Item -LiteralPath $oldPath -Force
  if ($oldItem.LinkType) {
    cmd /c rmdir "$oldPath" | Out-Null
    Write-Host "[ok] removed the duplicate link $oldPath"
  } else {
    $aside = Join-Path $ProfileDir ("dsh-mesh.stale-" + $stamp)
    Move-Item -LiteralPath $oldPath -Destination $aside
    Write-Host "[ok] moved the stale copy aside to $aside"
  }
}

$json = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[ok] profile now has exactly one scoped dsh-mesh entry"
Write-Host ''
Write-Host 'Next: start DSH fully (not just a page refresh). The Mesh panel should show 0.4.0.'
