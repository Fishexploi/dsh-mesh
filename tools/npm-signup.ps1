<#
  Create an npm account through the registry API instead of the website.

  Why: www.npmjs.com is behind a bot wall that answers 403 to this network, while
  registry.npmjs.org answers normally. The registry still exposes the classic
  account endpoint (PUT /-/user/org.couchdb.user:<name>), so signup works even
  when the web signup page is blocked.

  What it does:
    1. asks for username, email and a password (typed twice, never echoed)
    2. PUTs the account to the registry
    3. on success writes //registry.npmjs.org/:_authToken=<token> to ~/.npmrc
       (your mirror default stays untouched; package.json pins the publish
       registry already)

  Usage:
    powershell -ExecutionPolicy Bypass -File tools\npm-signup.ps1 -Probe
    powershell -ExecutionPolicy Bypass -File tools\npm-signup.ps1 -UserName fishboy -Email you@example.com
#>
[CmdletBinding()]
param(
  [string]$UserName = '',
  [string]$Email = '',
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'
$Registry = 'https://registry.npmjs.org'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Invoke-RegistryPut {
  param([string]$Url, [string]$Json)

  $inFile = [System.IO.Path]::GetTempFileName()
  $outFile = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($inFile, $Json, $Utf8)
    $code = & curl.exe -s -o $outFile -w '%{http_code}' -X PUT $Url `
      -H 'content-type: application/json' --data-binary "@$inFile" --max-time 30
    $body = ''
    if (Test-Path -LiteralPath $outFile) {
      $body = (Get-Content -LiteralPath $outFile -Raw -Encoding UTF8)
    }
    return [pscustomobject]@{ Status = [int]$code; Body = $body }
  } finally {
    Remove-Item -LiteralPath $inFile, $outFile -Force -ErrorAction SilentlyContinue
  }
}

if ($Probe) {
  Write-Host '[probe] sending an intentionally invalid signup to prove the endpoint is open...'
  $result = Invoke-RegistryPut -Url "$Registry/-/user/org.couchdb.user:dshmesh-probe" `
    -Json '{"name":"dshmesh-probe","password":"x","email":"not-an-email"}'
  Write-Host ("[probe] HTTP {0}: {1}" -f $result.Status, $result.Body.Trim())
  if ($result.Status -eq 400 -and $result.Body -match 'email') {
    Write-Host '[probe] endpoint is open: it validated the address instead of blocking the request.'
    exit 0
  }
  Write-Host '[probe] unexpected answer; the endpoint may be closed or rate limited.'
  exit 1
}

if (-not $UserName) { $UserName = (Read-Host 'npm username (this also becomes your @scope)').Trim() }
if (-not $Email) { $Email = (Read-Host 'email address').Trim() }
if (-not $UserName -or -not $Email) { throw 'username and email are required' }

$secure = Read-Host 'password' -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if (-not $password) { throw 'password is required' }

$payload = @{ name = $UserName; password = $password; email = $Email } | ConvertTo-Json -Compress
$result = Invoke-RegistryPut -Url "$Registry/-/user/org.couchdb.user:$UserName" -Json $payload

if ($result.Status -ne 201) {
  Write-Host ("[fail] HTTP {0}: {1}" -f $result.Status, $result.Body.Trim())
  Write-Host 'If the message says the name is taken, pick another username and rerun; the package name follows it.'
  exit 1
}

$parsed = $null
try { $parsed = $result.Body | ConvertFrom-Json } catch { }
Write-Host "[ok] account created: $UserName"

if ($parsed -and $parsed.token) {
  $npmrc = Join-Path $HOME '.npmrc'
  $line = "//registry.npmjs.org/:_authToken=$($parsed.token)"
  $existing = @()
  if (Test-Path -LiteralPath $npmrc) { $existing = @(Get-Content -LiteralPath $npmrc) }
  $kept = $existing | Where-Object { $_ -notmatch '^\s*//registry\.npmjs\.org/:_authToken=' }
  $next = @($kept) + @($line)
  [System.IO.File]::WriteAllLines($npmrc, $next, $Utf8)
  Write-Host "[ok] token written to $npmrc (the mirror default is untouched)"
} else {
  Write-Host '[warn] the registry did not return a token; run: npm login --auth-type=legacy --registry=https://registry.npmjs.org'
}

Write-Host ''
Write-Host "Next: click the verification link npm sent to $Email, then publish:"
Write-Host '    npm publish --registry=https://registry.npmjs.org'
