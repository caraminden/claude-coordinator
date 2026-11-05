<#
.SYNOPSIS
  Removes one scheme's Citadel-made GitHub Actions runners from this Windows PC.

.DESCRIPTION
  Citadel #328. It acts only on folders C:\actions-runner-* holding a .citadel-runner marker (add-runner.ps1 writes
  one) that names the scheme's repo and that the repo's runner service runs from, and never on Delve's C:\actions-runner, -2, -3, -4 or -perf, marker or not. For
  each, it runs the runner's own `config.cmd remove` with a removal token Citadel mints with the scheme owner's
  GitHub login (about an hour, never stored), which takes the runner off GitHub and deletes its service, then
  deletes the folder. A runner GitHub won't remove keeps its folder, and the script says why.
  It never touches another runner, never restarts or reboots the PC. Run it elevated (an admin PowerShell, or the
  CI runner agent, which runs as SYSTEM).

.PARAMETER Scheme
  The scheme's name, its runner label or its id.

.PARAMETER CitadelUrl
  Where this PC's machine agent connects: the address the Machines page shows in a machine's setup lines.

.PARAMETER MachineToken
  That machine's token (ccm_...). Defaults to the CC_MACHINE_TOKEN environment variable.

.EXAMPLE
  .\remove-runner.ps1 -Scheme "Peek Auras" -CitadelUrl http://perigee:8574
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Scheme,
  [Parameter(Mandatory)][string]$CitadelUrl,
  [string]$MachineToken = $env:CC_MACHINE_TOKEN
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

function Stop-With([string]$Why) {
  Write-Host "remove-runner: $Why" -ForegroundColor Red
  exit 1
}

if (-not $MachineToken) { Stop-With 'No machine token: pass -MachineToken or set CC_MACHINE_TOKEN.' }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Stop-With 'Run this elevated: removing a runner service needs it.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-RunnerToken([bool]$Mint) {
  $uri = $CitadelUrl.TrimEnd('/') + '/api/machines/runner-token'
  $body = @{ scheme = $Scheme; mint = $Mint; kind = 'remove' } | ConvertTo-Json
  try {
    return Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType 'application/json' -Headers @{ Authorization = "Bearer $MachineToken" } -UseBasicParsing
  } catch {
    $said = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { $null }
    try { $said = ($said | ConvertFrom-Json).error } catch { $null = $_ } # not JSON: keep the text as it came
    if (-not $said) { $said = $_.Exception.Message }
    Stop-With "Citadel refused: $said"
  }
}

# Delve's runners, made by hand before Citadel had markers: never these, whatever is in them.
$never = 'C:\actions-runner', 'C:\actions-runner-2', 'C:\actions-runner-3', 'C:\actions-runner-4', 'C:\actions-runner-perf'

$names = Get-RunnerToken $false
$mine = @(Get-ChildItem -Path 'C:\' -Directory -Filter 'actions-runner-*' | Where-Object {
    if ($never -contains $_.FullName.TrimEnd('\')) { return $false }
    $marker = Join-Path $_.FullName '.citadel-runner'
    if (-not (Test-Path $marker)) { return $false }
    try { return (Get-Content -Raw $marker | ConvertFrom-Json).repo -eq $names.repo } catch { return $false }
  })
if (-not $mine) {
  Write-Host "No Citadel runner of $($names.repo) on this PC, so nothing changed."
  exit 0
}

# Anyone can make a folder in C:\ and write a marker, but only an admin makes a service: run config.cmd only in a folder
# that the repo's runner service runs from, so a planted folder never gets its config.cmd run as SYSTEM.
$owner, $repoName = $names.repo -split '/', 2
$serviced = @(Get-CimInstance -ClassName Win32_Service -Filter "Name LIKE 'actions.runner.%'" |
    Where-Object { $_.Name -like "actions.runner.$owner-$repoName.*" } |
    ForEach-Object { Split-Path (Split-Path ($_.PathName -replace '^"([^"]+)".*$', '$1') -Parent) -Parent })
$skipped = @($mine | Where-Object { $serviced -notcontains $_.FullName })
foreach ($d in $skipped) { Write-Host "$($d.FullName) has a marker for $($names.repo) but no runner service of that repo runs from it, so it was left alone; look at it by hand." -ForegroundColor Yellow }
$mine = @($mine | Where-Object { $serviced -contains $_.FullName })
if (-not $mine) {
  if ($skipped) { Stop-With 'Nothing removed: see above.' }
  exit 0
}

$reg = Get-RunnerToken $true
$failed = 0
foreach ($d in $mine) {
  Write-Host "Removing the runner in $($d.FullName)"
  Push-Location $d.FullName
  try {
    & .\config.cmd remove --unattended --token $reg.token
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) {
    $failed++
    Write-Host "config.cmd remove failed (exit $code); $($d.FullName) stays. Its _diag folder says why." -ForegroundColor Red
    continue
  }
  Remove-Item -Recurse -Force $d.FullName
  Write-Host "Removed $($d.FullName)" -ForegroundColor Green
}
if ($failed -or $skipped) { Stop-With "$($failed + $skipped.Count) runner folder(s) weren't removed; the lines above say why." }
