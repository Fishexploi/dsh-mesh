<#
  Move one DSH profile from the unscoped "dsh-mesh" install to the published
  scoped package "@fishboy/dsh-mesh".

  Why this is needed: the package name changed, and cordis.patch.yml now asks
  for the module by its scoped specifier. An old install keeps the files under
  node_modules\dsh-mesh, so the row would fail to resolve on the next start.

  This script only handles local link / file installs (the ones sync\install.ps1
  creates). For an npm version install it prints the two commands to run.

  Usage:
    powershell -ExecutionPolicy Bypass -File sync\migrate-scoped.ps1
    powershell -ExecutionPolicy Bypass -File sync\migrate-scoped.ps1 -DryRun
    powershell -ExecutionPolicy Bypass -File sync\migrate-scoped.ps1 -ProfileDir "C:\Users\me\.dsh\profiles\desktop"
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
if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "profile package.json not found: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$dependencyNames = @($manifest.dependencies.PSObject.Properties.Name)
if ($dependencyNames -contains $NewName) {
  Write-Host "[skip] $NewName is already a dependency of this profile."
  exit 0
}
if ($dependencyNames -notcontains $OldName) {
  Write-Host "[skip] neither $OldName nor $NewName is a dependency of this profile."
  exit 0
}

$spec = [string]$manifest.dependencies.$OldName
Write-Host "[info] current dependency: $OldName = $spec"

$target = $null
if ($spec -like 'link:*') { $target = $spec.Substring(5) }
elseif ($spec -like 'file:*') { $target = $spec.Substring(5) }

if (-not $target) {
  Write-Host ''
  Write-Host "[manual] this profile installed a version from npm, so switch it with the plugin manager:"
  Write-Host "    dsh plugin --profile <profile> remove $OldName"
  Write-Host "    dsh plugin --profile <profile> add $NewName"
  exit 2
}

if (-not [System.IO.Path]::IsPathRooted($target)) {
  $target = Join-Path $ProfileDir $target
}
$target = (Resolve-Path -LiteralPath $target).Path
Write-Host "[info] package source: $target"

$scopeDir = Join-Path $ProfileDir 'node_modules\@fishboy'
$newPath = Join-Path $scopeDir 'dsh-mesh'
$oldPath = Join-Path $ProfileDir "node_modules\$OldName"

if ($DryRun) {
  Write-Host "[dry] would link $newPath -> $target"
  Write-Host "[dry] would set dependencies.$NewName = link:$target"
  Write-Host "[dry] would rename bundles entry $OldName -> $NewName"
  Write-Host "[dry] would remove the old link $oldPath"
  exit 0
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $ProfileDir "package.json.pre-scope-$stamp.bak"
Copy-Item -LiteralPath $manifestPath -Destination $backup
Write-Host "[ok] manifest backup: $backup"

if (-not (Test-Path -LiteralPath $scopeDir)) {
  New-Item -ItemType Directory -Path $scopeDir | Out-Null
}
if (Test-Path -LiteralPath $newPath) {
  Write-Host "[skip] $newPath already exists."
} else {
  New-Item -ItemType Junction -Path $newPath -Target $target | Out-Null
  Write-Host "[ok] linked $newPath -> $target"
}

$manifest.dependencies.PSObject.Properties.Remove($OldName) | Out-Null
$manifest.dependencies | Add-Member -NotePropertyName $NewName -NotePropertyValue ("link:" + $target.Replace('\', '/')) -Force
$bundles = @($manifest.dsh.profile.bundles) | ForEach-Object {
  if ($_ -eq $OldName) { $NewName } else { $_ }
}
$manifest.dsh.profile.bundles = @($bundles)

$json = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[ok] profile manifest now depends on $NewName"

if (Test-Path -LiteralPath $oldPath) {
  $oldItem = Get-Item -LiteralPath $oldPath -Force
  if ($oldItem.LinkType -eq 'Junction' -or $oldItem.LinkType -eq 'SymbolicLink') {
    cmd /c rmdir "$oldPath" | Out-Null
    if (Test-Path -LiteralPath $oldPath) {
      Write-Warning "could not remove the old link: $oldPath (remove it manually)"
    } else {
      Write-Host "[ok] removed the old link $oldPath"
    }
  } else {
    Write-Warning "$oldPath is a real directory, not a link, so it was left alone. Remove the unscoped copy yourself once the scoped one loads."
  }
}

Write-Host ''
Write-Host "Next: reload the plugin (or restart DSH). Verify with:"
Write-Host "    curl http://127.0.0.1:<web-port>/mesh/api/state   (node.version should be 0.3.0+)"
