<#
.SYNOPSIS
  Removes one scheme's Citadel-made GitHub Actions runners from this Windows PC.

.DESCRIPTION
  Citadel #328. It acts only on folders C:\actions-runner-* holding a .citadel-runner marker (add-runner.ps1 writes
  one) that names the scheme's repo and that the repo's runner service runs from, and never on Delve's C:\actions-runner, -2, -3, -4 or -perf, marker or not. For
  each, it asks Citadel to take the runner off GitHub, which Citadel does by the runner's name with the scheme owner's
  GitHub login, and only for a runner carrying one of the scheme's own labels; then it stops and deletes the runner's
  Windows service, ends what still runs from the folder, and deletes the folder. A runner Citadel or GitHub won't
  remove keeps its service and folder, and the script says why, so running it again finds it.
  It runs nothing from a runner's folder (#476): CI jobs can write there, and this script runs elevated, usually as
  SYSTEM, so the runner's own `config.cmd remove` is never used. The folder's files are data: the marker and .runner
  are read as JSON and nothing else is opened. The runner's name comes from its service's name
  (actions.runner.<owner>-<repo>.<name>), which only an admin can set; .runner's agentName is used only where there is
  no such name to read (a session runner, or a service name GitHub cut short at 80 characters), and Citadel is told the
  label that kind of runner carries (the scheme's, or the logon task's), so such a name can only reach a runner of
  the same kind.
  A session runner (add-runner.ps1 -Session, #370) has no service: it is removed when its logon task, "GitHub runner
  <its label>", starts it from that folder, and the task and the runner's processes go with it.
  It never touches another runner, never restarts or reboots the PC. Run it elevated (an admin PowerShell, or the
  CI runner agent, which runs as SYSTEM).

.PARAMETER Scheme
  The scheme's name, its runner label or its id.

.PARAMETER CitadelUrl
  Where this PC's machine agent connects: the address the Machines page shows in a machine's setup lines.

.PARAMETER MachineToken
  That machine's token (ccm_...). Defaults to the CC_MACHINE_TOKEN environment variable.

.EXAMPLE
  .\remove-runner.ps1 -Scheme "Peek Auras" -CitadelUrl 'http://perigee.tail59477f.ts.net:8574'
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

# Asks Citadel's runner route; throws what Citadel said when it refuses.
function Invoke-Citadel([hashtable]$Ask) {
  $uri = $CitadelUrl.TrimEnd('/') + '/api/machines/runner-token'
  $body = (@{ scheme = $Scheme } + $Ask) | ConvertTo-Json
  try {
    return Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType 'application/json' -Headers @{ Authorization = "Bearer $MachineToken" } -UseBasicParsing
  } catch {
    $said = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { $null }
    # Windows PowerShell 5.1 can leave ErrorDetails empty; what Citadel said is still on the response (#476, seen on the test box).
    if (-not $said -and $_.Exception -is [Net.WebException] -and $_.Exception.Response) {
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream.CanSeek) { $stream.Position = 0 }
        $said = (New-Object IO.StreamReader($stream)).ReadToEnd()
      } catch { $null = $_ }
    }
    try { $said = ($said | ConvertFrom-Json).error } catch { $null = $_ } # not JSON: keep the text as it came
    if (-not $said) { $said = $_.Exception.Message }
    throw "$said"
  }
}

# Ends every process running from a runner's folder (run.cmd's cmd.exe, Runner.Listener, Runner.Worker), a job's too.
function Stop-RunnerProcess([string]$Dir) {
  Get-CimInstance -ClassName Win32_Process | Where-Object {
    # Literal comparisons: -like would read a [ in the folder's name as a wildcard.
    $_.ProcessId -ne $PID -and (($_.ExecutablePath -and $_.ExecutablePath.StartsWith("$Dir\", [StringComparison]::OrdinalIgnoreCase)) -or
      ($_.CommandLine -and $_.CommandLine.IndexOf("$Dir\run.cmd", [StringComparison]::OrdinalIgnoreCase) -ge 0))
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Get-RunnerService([string]$Name) {
  # A service's name can't hold a quote, and this one came from Win32_Service.
  return Get-CimInstance -ClassName Win32_Service -Filter "Name = '$Name'"
}

# Waits up to $Seconds for the service to stop (or, with -Gone, to leave the list); false if it hasn't.
function Wait-RunnerService([string]$Name, [int]$Seconds, [switch]$Gone) {
  $until = (Get-Date).AddSeconds($Seconds)
  for (;;) {
    $s = Get-RunnerService $Name
    if (-not $s -or (-not $Gone -and $s.State -eq 'Stopped')) { return $true }
    if ((Get-Date) -ge $until) { return $false }
    Start-Sleep -Milliseconds 500
  }
}

# Deletes a folder without following a link in it: a job can leave a junction to anywhere, and Windows PowerShell 5.1's
# Remove-Item -Recurse would empty what it points at. A link is removed as a link; a read-only file (git's objects) goes too.
# shortcut: a process a job detached outside the folder (so not ended above) could swap a subfolder for a junction between
# listing and recursing; fine on a trusted-friends PC, revisit if runners ever take outside PRs.
function Remove-Tree([IO.FileSystemInfo]$Item) {
  $link = [bool]($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  if ($Item -is [IO.DirectoryInfo] -and -not $link) {
    foreach ($child in @(Get-ChildItem -LiteralPath $Item.FullName -Force)) { Remove-Tree $child }
  }
  if (-not $link -and ($Item.Attributes -band [IO.FileAttributes]::ReadOnly)) { $Item.Attributes = $Item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) }
  $Item.Delete()
}

# Delve's runners, made by hand before Citadel had markers: never these, whatever is in them.
$root = 'C:\'
$never = '', '-2', '-3', '-4', '-perf' | ForEach-Object { Join-Path $root "actions-runner$_" }

try { $names = Invoke-Citadel @{ mint = $false } } catch { Stop-With "Citadel refused: $($_.Exception.Message)" }
$mine = @(Get-ChildItem -LiteralPath $root -Directory -Filter 'actions-runner-*' | Where-Object {
    if ($never -contains $_.FullName.TrimEnd('\')) { return $false }
    $marker = Join-Path $_.FullName '.citadel-runner'
    if (-not (Test-Path -LiteralPath $marker)) { return $false }
    try { return (Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json).repo -eq $names.repo } catch { return $false }
  })
if (-not $mine) {
  Write-Host "No Citadel runner of $($names.repo) on this PC, so nothing changed."
  exit 0
}

# Anyone can make a folder in C:\ and write a marker, but only an admin makes a service: act only on a folder that the
# repo's runner service runs from, so a planted folder is never the reason a service or a GitHub runner goes.
# A session runner's stand-in for the service is its logon task "GitHub runner <label>" starting it from that folder.
# shortcut: a standard user could make such a task for themselves beside a planted folder, which a service can't be;
# fine while everyone with an account on the PC is trusted (Citadel is for friends), check the task's user is an admin if not.
$owner, $repoName = $names.repo -split '/', 2
$prefix = "actions.runner.$owner-$repoName."
$services = @{}
Get-CimInstance -ClassName Win32_Service -Filter "Name LIKE 'actions.runner.%'" |
  Where-Object { $_.Name -like "$prefix*" } |
  ForEach-Object { $services[(Split-Path (Split-Path ($_.PathName -replace '^"([^"]+)".*$', '$1') -Parent) -Parent)] = $_.Name }
$tasks = @{}
foreach ($d in $mine) {
  $m = Get-Content -Raw -LiteralPath (Join-Path $d.FullName '.citadel-runner') | ConvertFrom-Json
  if (-not ($m.PSObject.Properties['mode'] -and $m.mode -eq 'session')) { continue }
  $t = Get-ScheduledTask -TaskName "GitHub runner $($m.label)" -ErrorAction SilentlyContinue
  if ($t -and @($t.Actions | Where-Object { $_.WorkingDirectory -eq $d.FullName }).Count) { $tasks[$d.FullName] = $t.TaskName }
}
$serviced = @($services.Keys) + @($tasks.Keys)
$skipped = @($mine | Where-Object { $serviced -notcontains $_.FullName })
foreach ($d in $skipped) { Write-Host "$($d.FullName) has a marker for $($names.repo) but no runner service or logon task of that repo runs from it, so it was left alone; look at it by hand." -ForegroundColor Yellow }
$mine = @($mine | Where-Object { $serviced -contains $_.FullName })
if (-not $mine) {
  if ($skipped) { Stop-With 'Nothing removed: see above.' }
  exit 0
}

$failed = 0
foreach ($d in $mine) {
  Write-Host "Removing the runner in $($d.FullName)"
  $service = $services[$d.FullName]
  $task = $tasks[$d.FullName]

  # 1. Its name on GitHub. The service's name ends with it, and only an admin sets that; GitHub cuts a service name
  # short at 80 characters, so one that long isn't trusted for it. Then, and for a session runner, the folder's
  # .runner says: a job can write that file, but Citadel only removes a runner of this repo with the scheme's label.
  $name = if ($service -and $service.Length -lt 80) { $service.Substring($prefix.Length) } else { $null }
  if (-not $name) {
    try { $name = [string](Get-Content -Raw -LiteralPath (Join-Path $d.FullName '.runner') | ConvertFrom-Json).agentName } catch { $name = $null }
  }
  if (-not $name) {
    $failed++
    Write-Host "Can't tell the runner's name on GitHub (no readable .runner in the folder); $($d.FullName) stays. Remove the runner in the repo's settings on GitHub, then the folder by hand." -ForegroundColor Red
    continue
  }

  # 2. Off GitHub first: if that fails, nothing here has changed and running this again finds the runner.
  # With the label this kind of runner carries, from what an admin made, never from the folder: the scheme's label for
  # a service runner, the logon task's ("GitHub runner <label>") for a session runner. Citadel removes only a runner
  # carrying it, so a name a job wrote into .runner can't reach the scheme's Linux runners or, from a service runner,
  # its session runner.
  $label = if ($task) { $task.Substring('GitHub runner '.Length) } else { $names.label }
  try {
    $gone = Invoke-Citadel @{ kind = 'delete'; name = $name; label = $label }
  } catch {
    $failed++
    Write-Host "Citadel couldn't take the runner $name off GitHub: $($_.Exception.Message) $($d.FullName) stays." -ForegroundColor Red
    continue
  }
  if ($gone.removed) { Write-Host "Took the runner $name off GitHub" } else { Write-Host "GitHub no longer lists a runner $name" }

  # 3. Its service: stopped, deleted (before its processes are ended, or its restart-on-failure would start it again), gone.
  if ($service) {
    & sc.exe stop $service | Out-Null
    $null = Wait-RunnerService $service 30
    & sc.exe delete $service | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $failed++
      Write-Host "Couldn't delete the service $service (sc.exe exit $LASTEXITCODE); $($d.FullName) stays." -ForegroundColor Red
      continue
    }
    Stop-RunnerProcess $d.FullName
    if (Wait-RunnerService $service 30 -Gone) { Write-Host "Removed the service $service" }
    else { Write-Host "The service $service is marked for deletion and goes once Windows lets go of it (close Services, or at the next restart)." -ForegroundColor Yellow }
  }
  # Or its logon task. Stopping the task ends the launcher, not the run.cmd it started on its desktop.
  if ($task) {
    Stop-ScheduledTask -TaskName $task
    Stop-RunnerProcess $d.FullName
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
    Write-Host "Removed the logon task '$task'"
  }

  # 4. The folder.
  try {
    Remove-Tree $d
  } catch {
    $failed++
    Write-Host "The runner is gone, but its folder couldn't be deleted ($($_.Exception.Message)); delete $($d.FullName) by hand." -ForegroundColor Red
    continue
  }
  Write-Host "Removed $($d.FullName)" -ForegroundColor Green
}
if ($failed -or $skipped) { Stop-With "$($failed + $skipped.Count) runner folder(s) weren't removed; the lines above say why." }
