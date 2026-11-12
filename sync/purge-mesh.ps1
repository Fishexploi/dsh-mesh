<#
  Remove every trace of dsh-mesh from a DSH profile, so the next install starts
  from a clean slate.

  What it removes:
    - dependency key(s) whose name ends in dsh-mesh
    - bundle row(s) whose name ends in dsh-mesh
    - top-level cordis.patch.yml entries that mention dsh-mesh
    - node_modules copies (moved aside, never deleted from disk)

  Everything is backed up first:
    package.json.repair-<stamp>.bak
    cordis.patch.yml.repair-<stamp>.bak
    node_modules\dsh-mesh.purged-<stamp>\   (or @fishboy\dsh-mesh.purged-...)

  Usage:
    powershell -ExecutionPolicy Bypass -File purge-mesh.ps1 -DryRun
    powershell -ExecutionPolicy Bypass -File purge-mesh.ps1
    powershell -ExecutionPolicy Bypass -File purge-mesh.ps1 -ProfileDir "C:\Users\me\.dsh\profiles\desktop"
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $HOME '.dsh\profiles\desktop'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "profile package.json not found: $manifestPath" }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$nm = Join-Path $ProfileDir 'node_modules'

function Test-MeshName([string]$name) { return ($name -match '(^|/)dsh-mesh$') }

$depKeys = @()
if ($manifest.dependencies) { $depKeys = @($manifest.dependencies.PSObject.Properties.Name | Where-Object { Test-MeshName $_ }) }
$bundles = @()
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) { $bundles = @($manifest.dsh.profile.bundles) }
$bundleMesh = @($bundles | Where-Object { Test-MeshName $_ })

$copies = @()
foreach ($entry in Get-ChildItem -LiteralPath $nm -Force -ErrorAction SilentlyContinue) {
  if ($entry.Name -eq 'dsh-mesh') { $copies += $entry.FullName }
  elseif ($entry.Name -like '@*' -and $entry.PSIsContainer) {
    $scoped = Join-Path $entry.FullName 'dsh-mesh'
    if (Test-Path -LiteralPath $scoped) { $copies += $scoped }
  }
}

$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$patchBlocks = 0
$patchAll = @()
if (Test-Path -LiteralPath $patchPath) {
  $patchAll = @(Get-Content -LiteralPath $patchPath -Encoding UTF8)
  $cursor = 0
  while ($cursor -lt $patchAll.Count) {
    if ($patchAll[$cursor] -match '^-\s') {
      $block = @()
      $start = $cursor
      while ($cursor -lt $patchAll.Count -and ($cursor -eq $start -or $patchAll[$cursor] -notmatch '^-\s')) {
        $block += $patchAll[$cursor]
        $cursor += 1
      }
      if (($block -join "`n") -match 'dsh-mesh') { $patchBlocks += 1 }
    } else {
      $cursor += 1
    }
  }
}

Write-Host "[info] profile: $ProfileDir"
Write-Host "[info] dependency keys: $(if ($depKeys.Count) { $depKeys -join ', ' } else { '(none)' })"
Write-Host "[info] bundle rows:    $(if ($bundleMesh.Count) { $bundleMesh -join ', ' } else { '(none)' })"
Write-Host "[info] node_modules copies: $(if ($copies.Count) { $copies -join ' | ' } else { '(none)' })"
Write-Host "[info] patch entries mentioning dsh-mesh: $patchBlocks"

if ($DryRun) {
  Write-Host '[dry] nothing was changed. Run without -DryRun to remove the items above.'
  exit 0
}

Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $ProfileDir "package.json.repair-$stamp.bak")
if (Test-Path -LiteralPath $patchPath) {
  Copy-Item -LiteralPath $patchPath -Destination (Join-Path $ProfileDir "cordis.patch.yml.repair-$stamp.bak")
}

foreach ($key in $depKeys) { $manifest.dependencies.PSObject.Properties.Remove($key) | Out-Null }
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
  $manifest.dsh.profile.bundles = @($bundles | Where-Object { -not (Test-MeshName $_) })
}

if ($patchBlocks -gt 0) {
  $kept = New-Object System.Collections.Generic.List[string]
  $cursor = 0
  $dropped = 0
  while ($cursor -lt $patchAll.Count) {
    if ($patchAll[$cursor] -match '^-\s') {
      $block = @()
      $start = $cursor
      while ($cursor -lt $patchAll.Count -and ($cursor -eq $start -or $patchAll[$cursor] -notmatch '^-\s')) {
        $block += $patchAll[$cursor]
        $cursor += 1
      }
      if (($block -join "`n") -match 'dsh-mesh') { $dropped += 1 } else { foreach ($line in $block) { $kept.Add($line) } }
    } else {
      $kept.Add($patchAll[$cursor])
      $cursor += 1
    }
  }
  [System.IO.File]::WriteAllLines($patchPath, $kept, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[ok] removed $dropped patch entry(ies)"
}

$json = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host '[ok] manifest cleaned'

$purgedRoot = Join-Path $ProfileDir 'purged'
foreach ($copy in $copies) {
  if (-not (Test-Path -LiteralPath $purgedRoot)) { New-Item -ItemType Directory -Path $purgedRoot | Out-Null }
  $relative = $copy.Substring($nm.Length).TrimStart('\', '/') -replace '[\\/]', '__'
  $aside = Join-Path $purgedRoot ($relative + '-' + $stamp)
  try {
    Move-Item -LiteralPath $copy -Destination $aside
    Write-Host "[ok] moved $copy -> $aside"
  } catch {
    Write-Warning ("could not move {0}: {1}" -f $copy, $_.Exception.Message)
  }
}

Write-Host ''
Write-Host 'Profile is clean: dsh-mesh is no longer a dependency, a bundle or on disk.'
Write-Host 'Start DSH (it should boot without the Mesh panel) and install from the local tarball.'
