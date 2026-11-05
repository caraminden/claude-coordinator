<#
.SYNOPSIS
  Lists every GitHub Actions runner service on this PC: its state, start type, folder, and whether Citadel made it.

.DESCRIPTION
  Citadel #328. Read-only: it changes nothing. A folder with a .citadel-runner marker was made by add-runner.ps1,
  and the marker says which repo it serves; any other runner (Delve's, one made by hand) shows as "not Citadel's".
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$services = @(Get-CimInstance -ClassName Win32_Service -Filter "Name LIKE 'actions.runner.%'" | Sort-Object Name)
if (-not $services) {
  Write-Host 'No runner services on this PC.'
  exit 0
}
foreach ($s in $services) {
  # PathName is "C:\actions-runner-x\bin\RunnerService.exe", quoted; the runner's folder is two up.
  $exe = ($s.PathName -replace '^"([^"]+)".*$', '$1')
  $dir = Split-Path (Split-Path $exe -Parent) -Parent
  $marker = Join-Path $dir '.citadel-runner'
  $whose = "not Citadel's"
  if (Test-Path $marker) {
    try { $whose = "Citadel's, for $((Get-Content -Raw $marker | ConvertFrom-Json).repo)" } catch { $whose = "Citadel's (its marker doesn't read)" }
  }
  Write-Host "$($s.Name)  $($s.State), $($s.StartMode)  $dir  ($whose)"
}
