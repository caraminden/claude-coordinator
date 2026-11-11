<#
.SYNOPSIS
  Lists every GitHub Actions runner service and session runner on this PC: its state, folder, and whether Citadel made it.

.DESCRIPTION
  Citadel #328. Read-only: it changes nothing. A folder with a .citadel-runner marker was made by add-runner.ps1,
  and the marker says which repo it serves; any other runner (Delve's, one made by hand) shows as "not Citadel's".
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

function Get-Whose([string]$Dir) {
  $marker = Join-Path $Dir '.citadel-runner'
  if (-not (Test-Path $marker)) { return "not Citadel's" }
  try { return "Citadel's, for $((Get-Content -Raw $marker | ConvertFrom-Json).repo)" } catch { return "Citadel's (its marker doesn't read)" }
}

$services = @(Get-CimInstance -ClassName Win32_Service -Filter "Name LIKE 'actions.runner.%'" | Sort-Object Name)
# Session runners (add-runner.ps1 -Session, Peek Auras' desktop runner) have a logon task named so, not a service.
$tasks = @(Get-ScheduledTask -TaskName 'GitHub runner *' -ErrorAction SilentlyContinue | Sort-Object TaskName)
if (-not $services -and -not $tasks) {
  Write-Host 'No runner services or session runners on this PC.'
  exit 0
}
foreach ($s in $services) {
  # PathName is "C:\actions-runner-x\bin\RunnerService.exe", quoted; the runner's folder is two up.
  $exe = ($s.PathName -replace '^"([^"]+)".*$', '$1')
  $dir = Split-Path (Split-Path $exe -Parent) -Parent
  Write-Host "$($s.Name)  $($s.State), $($s.StartMode)  $dir  ($(Get-Whose $dir))"
}
foreach ($t in $tasks) {
  $dir = $t.Actions | ForEach-Object { $_.WorkingDirectory } | Where-Object { $_ } | Select-Object -First 1
  $whose = if ($dir) { Get-Whose $dir } else { "not Citadel's" }
  Write-Host "$($t.TaskName)  session, $($t.State), for $($t.Principal.UserId)  $dir  ($whose)"
}
