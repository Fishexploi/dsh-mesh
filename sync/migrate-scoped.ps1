<#
  Repair a DSH profile whose plugin files now ask for the scoped package name
  "@fishboy/dsh-mesh" while the installed copy still lives at node_modules\dsh-mesh.
  Symptom: DSH refuses to boot with
      @fishboy/dsh-mesh: import failed (see console for the import error)
  because cordis.patch.yml names the module by a specifier node cannot resolve.

  It handles both install shapes:
    * link:/file: dependency  -> links the scoped name at the same source
    * plain directory install -> moves node_modules\dsh-mesh to
                                 node_modules\@fishboy\dsh-mesh and links that
  In both cases the dependency and the bundle row are rewritten to the scoped name.

  Usage:
    powershell -ExecutionPolicy Bypass -File migrate-scoped.ps1 -DryRun
    powershell -ExecutionPolicy Bypass -File migrate-scoped.ps1

  If DSH will not start at all, pick "disable third-party plugins, back up the
  profile patch and restart" in the crash dialog first, then run this.
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $HOME '.dsh\profiles\desktop'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$OldName = 'dsh-mesh'
$NewName = '@fishboy/dsh-mesh'

$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "profile package.json not found: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$dependencyNames = @($manifest.dependencies.PSObject.Properties.Name)
$oldPath = Join-Path $ProfileDir "node_modules\$OldName"
$scopeDir = Join-Path $ProfileDir 'node_modules\@fishboy'
$newPath = Join-Path $scopeDir 'dsh-mesh'

$spec = ''
if ($dependencyNames -contains $OldName) { $spec = [string]$manifest.dependencies.$OldName }
if (-not $spec) { $spec = '' }
if ($dependencyNames -contains $NewName) { $spec = [string]$manifest.dependencies.$NewName }

Write-Host "[info] profile:    $ProfileDir"
Write-Host "[info] dependency: $(if ($dependencyNames -contains $OldName) { "$OldName = $spec" } elseif ($dependencyNames -contains $NewName) { "$NewName = $spec" } else { 'none' })"
Write-Host "[info] old folder: $oldPath $(if (Test-Path -LiteralPath $oldPath) { '(present)' } else { '(missing)' })"
Write-Host "[info] new folder: $newPath $(if (Test-Path -LiteralPath $newPath) { '(present)' } else { '(missing)' })"

$target = $null
if ($spec -like 'link:*') { $target = $spec.Substring(5) }
elseif ($spec -like 'file:*') { $target = $spec.Substring(5) }
if ($target -and -not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path $ProfileDir $target }
if ($target) {
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Warning "the dependency points at $target, which does not exist. Fix the path or reinstall the plugin."
    exit 2
  }
  $target = (Resolve-Path -LiteralPath $target).Path
}

if ($DryRun) {
  if ($target) {
    Write-Host "[dry] would link $newPath -> $target"
  } elseif (Test-Path -LiteralPath $oldPath) {
    Write-Host "[dry] would move $oldPath -> $newPath and link it"
  } else {
    Write-Host '[dry] nothing to point the scoped name at: reinstall the plugin after this.'
  }
  Write-Host "[dry] would set dependencies.$NewName and the bundle row to $NewName"
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $ProfileDir "package.json.repair-$stamp.bak"
Copy-Item -LiteralPath $manifestPath -Destination $backup
Write-Host "[ok] manifest backup: $backup"

if (-not (Test-Path -LiteralPath $scopeDir)) { New-Item -ItemType Directory -Path $scopeDir | Out-Null }

if (Test-Path -LiteralPath $newPath) {
  Write-Host "[skip] $newPath already exists"
} elseif ($target) {
  New-Item -ItemType Junction -Path $newPath -Target $target | Out-Null
  Write-Host "[ok] linked $newPath -> $target"
} elseif (Test-Path -LiteralPath $oldPath) {
  $oldItem = Get-Item -LiteralPath $oldPath -Force
  if ($oldItem.LinkType -eq 'Junction' -or $oldItem.LinkType -eq 'SymbolicLink') {
    $resolved = $oldItem.Target
    if ($resolved -is [array]) { $resolved = $resolved[0] }
    New-Item -ItemType Junction -Path $newPath -Target $resolved | Out-Null
    Write-Host "[ok] linked $newPath -> $resolved"
    $target = $resolved
  } else {
    Move-Item -LiteralPath $oldPath -Destination $newPath
    Write-Host "[ok] moved the installed copy to $newPath"
    $target = $newPath
  }
} else {
  Write-Warning 'no installed copy found; install the plugin again after this.'
}

if ($dependencyNames -contains $OldName) { $manifest.dependencies.PSObject.Properties.Remove($OldName) | Out-Null }
$specValue = if ($target) { 'link:' + ([string]$target).Replace('\', '/') } else { $spec }
$manifest.dependencies | Add-Member -NotePropertyName $NewName -NotePropertyValue $specValue -Force

if ($manifest.dsh -and $manifest.dsh.profile) {
  $manifest.dsh.profile.bundles = @(@($manifest.dsh.profile.bundles) | ForEach-Object {
    if ($_ -eq $OldName) { $NewName } else { $_ }
  })
}

$json = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[ok] profile now depends on $NewName ($specValue)"

if ((Test-Path -LiteralPath $oldPath) -and (Test-Path -LiteralPath $newPath)) {
  $oldItem = Get-Item -LiteralPath $oldPath -Force
  if ($oldItem.LinkType -eq 'Junction' -or $oldItem.LinkType -eq 'SymbolicLink') {
    cmd /c rmdir "$oldPath" | Out-Null
    Write-Host "[ok] removed the old link $oldPath"
  }
}

Write-Host ''
Write-Host 'Next: start DSH again (a full restart, not just a page reload).'
Write-Host 'Check: the Mesh panel shows the plugin version, and this node can pair again.'
