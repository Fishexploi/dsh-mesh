<#
  One-shot diagnostic for a DSH profile where dsh-mesh will not load.

  It prints everything needed to tell why the plugin fails to activate:
  the profile manifest (dependencies + bundles), the profile patch file, the
  installed copies with their file sizes, and the real error from importing the
  module. The crash log only says "see console for the import error", which is
  why this reproduces the import directly.

  Usage:
    powershell -ExecutionPolicy Bypass -File diagnose-mesh.ps1
    powershell -ExecutionPolicy Bypass -File diagnose-mesh.ps1 -ProfileDir "C:\Users\me\.dsh\profiles\desktop"
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $HOME '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Continue'
$Canonical = '@fishboy/dsh-mesh'
$expected = @{ 'index.js' = 120670; 'client.js' = 50676; 'cordis.patch.yml' = 267; 'package.json' = 1380 }
# Expected sizes are for release 0.4.0; a mismatch here means an incomplete copy.

Write-Host '=== profile ==='
Write-Host $ProfileDir
$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  Write-Host 'MISSING package.json'
  exit 1
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ''
Write-Host '=== dependencies ==='
foreach ($prop in $manifest.dependencies.PSObject.Properties) {
  Write-Host ('  {0} = {1}' -f $prop.Name, $prop.Value)
}
Write-Host ''
Write-Host '=== bundles ==='
foreach ($bundle in @($manifest.dsh.profile.bundles)) { Write-Host ('  ' + $bundle) }

Write-Host ''
Write-Host '=== cordis.patch.yml ==='
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
if (Test-Path -LiteralPath $patchPath) {
  Get-Content -LiteralPath $patchPath -Encoding UTF8 | ForEach-Object { Write-Host ('  ' + $_) }
} else {
  Write-Host '  (missing)'
}

Write-Host ''
Write-Host '=== installed copies ==='
$nm = Join-Path $ProfileDir 'node_modules'
$copies = @()
$old = Join-Path $nm 'dsh-mesh'
if (Test-Path -LiteralPath $old) {
  $item = Get-Item -LiteralPath $old -Force
  $copies += [pscustomobject]@{ Path = $old; Kind = $(if ($item.LinkType) { 'link -> ' + (($item.Target | Select-Object -First 1)) } else { 'directory' }) }
}
$scopedParent = Join-Path $nm '@fishboy'
if (Test-Path -LiteralPath $scopedParent) {
  Get-ChildItem -LiteralPath $scopedParent -Force -Directory | ForEach-Object {
    $copies += [pscustomobject]@{ Path = $_.FullName; Kind = $(if ($_.LinkType) { 'link -> ' + (($_.Target | Select-Object -First 1)) } else { 'directory' }) }
  }
}
if (-not $copies.Count) { Write-Host '  (no dsh-mesh copy found)' }
foreach ($copy in $copies) {
  Write-Host ('  ' + $copy.Path)
  Write-Host ('    kind: ' + $copy.Kind)
  foreach ($name in @('package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'SECURITY.md')) {
    $file = Join-Path $copy.Path $name
    if (Test-Path -LiteralPath $file) {
      $size = (Get-Item -LiteralPath $file).Length
      $flag = ''
      if ($expected.ContainsKey($name) -and $expected[$name] -ne $size) { $flag = '  <-- size differs from 0.4.0' }
      Write-Host ('    {0,-18} {1,7} bytes{2}' -f $name, $size, $flag)
    } else {
      Write-Host ('    {0,-18} MISSING' -f $name)
    }
  }
  $pkg = Join-Path $copy.Path 'package.json'
  if (Test-Path -LiteralPath $pkg) {
    try {
      $inner = Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json
      Write-Host ('    manifest: name={0} version={1}' -f $inner.name, $inner.version)
    } catch {
      Write-Host '    manifest: unreadable'
    }
  }
}

Write-Host ''
Write-Host '=== import test ==='
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '  node is not on PATH; skip this part and paste the output above.'
} else {
  Push-Location $ProfileDir
  try {
    $code = @'
try {
  const mod = await import('@fishboy/dsh-mesh')
  console.log('IMPORT OK:', Object.keys(mod).join(','))
} catch (error) {
  console.log('IMPORT FAILED:', (error && (error.stack || error.message)) || String(error))
}
'@
    & $node.Source --input-type=module -e $code 2>&1 | ForEach-Object { Write-Host ('  ' + $_) }
  } finally {
    Pop-Location
  }
}

Write-Host ''
Write-Host 'Done. Paste this whole output; it is read-only.'
