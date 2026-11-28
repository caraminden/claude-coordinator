<#
.SYNOPSIS
  Installs Citadel's CI runner agent on this PC, once: it then adds, lists and removes schemes' runners when Citadel asks.

.DESCRIPTION
  Citadel #328 (Josh, 2026-11-05: "Citadel installs it itself"). Nobody runs it by hand any more (One kind of machine H2,
  Cara 2026-11-26, "One agent, helpers hidden"): pressing Set up on CI runners makes the PC's machine agent write its
  elevate.ps1, which runs this, as administrator, with that PC's own token, in the one Admin PowerShell paste the
  Machines page shows. A runner agent installed the old way keeps working. Running it again updates the agent and its
  scripts to Citadel's current ones. It:
    1. checks it's elevated and that Node 18+ and Git for Windows are here;
    2. makes C:\ProgramData\citadel-runner-agent, readable and writable only by Administrators and SYSTEM, so no
       unelevated program can change what the agent runs;
    3. downloads runner-agent.mjs, add-runner.ps1, list-runners.ps1, remove-runner.ps1, sample-load.ps1,
       keep-runners.ps1 and start-runner.ps1 (the
       session runner's launcher, for add-runner.ps1 -Session by hand) from Citadel into it
       (the agent never downloads code itself: these copies are what it runs until you install again) and
       prints their SHA-256;
    4. keeps the machine token in a file there;
    5. registers the scheduled task "Citadel runner agent", run as SYSTEM with highest privileges, at startup and
       retried every 5 minutes, and starts it now: no reboot, no logon needed;
    6. waits until its log says it connected;
    7. proves the CPU cap on this PC with keep-runners.ps1 -Prove (#552): a throwaway job of CPU-burning processes,
       about 20 seconds, touching no runner.
  It registers, removes and restarts no runner; once it runs, the agent keeps every runner at below-normal priority
  (keep-runners.ps1; no CPU cap since #2262), and starts runner services that should be running. It never
  restarts or reboots the PC.

.PARAMETER CitadelUrl
  The machines address: what the Machines page shows in a machine's setup lines.

.PARAMETER MachineToken
  The token (ccm_...) of the machine you added for this agent on the Machines page. Defaults to CC_MACHINE_TOKEN.

.EXAMPLE
  .\install-runner-agent.ps1 -CitadelUrl 'http://perigee.tail59477f.ts.net:8574' -MachineToken ccm_12_...
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$CitadelUrl,
  [string]$MachineToken = $env:CC_MACHINE_TOKEN,
  [string]$GitBin = 'C:\Program Files\Git\bin'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3

function Stop-With([string]$Why) {
  Write-Host "install-runner-agent: $Why" -ForegroundColor Red
  exit 1
}

$task = 'Citadel runner agent'
$dir = Join-Path $env:ProgramData 'citadel-runner-agent'
$url = $CitadelUrl.TrimEnd('/')

# 1. What it needs.
if ($MachineToken -notmatch '^ccm_\d+_[\w-]{43}$') { Stop-With 'Pass the machine''s token (ccm_...) from the Machines page with -MachineToken.' }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Stop-With 'Run this in an elevated PowerShell (Run as administrator): the agent installs services.' }
# Not `(...).Source` on the pipeline: with nothing found that reads a property of $null, which StrictMode makes an error.
$cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$node = if ($cmd) { $cmd.Source } else { $null }
if (-not $node -or [version](& $node -v).TrimStart('v') -lt [version]'18.0') { Stop-With 'Node 18 or newer is not on PATH. Install it (winget install OpenJS.NodeJS.LTS), open a new PowerShell and run this again.' }
if (-not (Test-Path (Join-Path $GitBin 'bash.exe'))) { Stop-With "No bash.exe in $GitBin; install Git for Windows (the runners' bash steps need it) or pass -GitBin." }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# A running copy holds its old files and token: stop it before replacing them.
if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
}
Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*$dir\runner-agent.mjs*" } |
  ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }

# 2. The folder, Administrators and SYSTEM only (by SID, so a non-English Windows reads them too).
New-Item -ItemType Directory -Force -Path $dir | Out-Null
& icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-With "icacls couldn't lock $dir to Administrators and SYSTEM (exit $LASTEXITCODE)." }

# 3. The agent and its scripts, as Citadel serves them now.
$files = [ordered]@{
  'runner-agent.mjs'  = "$url/runner-agent.mjs"
  'add-runner.ps1'    = "$url/ci-runner/add-runner.ps1"
  'list-runners.ps1'  = "$url/ci-runner/list-runners.ps1"
  'remove-runner.ps1' = "$url/ci-runner/remove-runner.ps1"
  # The agent's load samples (#534): read-only.
  'sample-load.ps1'   = "$url/ci-runner/sample-load.ps1"
  # Cap and yield (#552): the agent keeps it running, holding every runner at below-normal priority (no CPU cap since #2262).
  'keep-runners.ps1'  = "$url/ci-runner/keep-runners.ps1"
  # Not the agent's: add-runner.ps1 -Session, run by hand from this folder, copies it into a session runner (#370).
  'start-runner.ps1'  = "$url/ci-runner/start-runner.ps1"
}
foreach ($name in $files.Keys) {
  $to = Join-Path $dir $name
  try {
    Invoke-WebRequest -Uri $files[$name] -OutFile $to -UseBasicParsing
  } catch {
    Stop-With "Couldn't download $($files[$name]): $($_.Exception.Message)"
  }
  Write-Host ("{0}  {1}" -f (Get-FileHash -Path $to -Algorithm SHA256).Hash.ToLower(), $name)
}

# 4. The token, in the locked folder, never on the task's command line.
$tokenFile = Join-Path $dir 'machine-token'
Set-Content -Path $tokenFile -Value $MachineToken -Encoding ASCII -NoNewline

# 5. The task: SYSTEM, highest privileges, at startup, and every 5 minutes in case it ever stops (IgnoreNew skips a
# run while one is going). No console: SYSTEM's tasks run in session 0, where nobody sees a window.
$log = Join-Path $dir 'runner-agent.log'
$action = New-ScheduledTaskAction -Execute $node -WorkingDirectory $dir -Argument "`"$dir\runner-agent.mjs`" $url --token-file `"$tokenFile`" --log `"$log`""
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$triggers = (New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
Register-ScheduledTask -Force -TaskName $task -Action $action -Principal $principal -Trigger $triggers -Settings $settings | Out-Null

# 6. Start it and watch its log.
$skip = @(Get-Content $log -ErrorAction SilentlyContinue).Count
Start-ScheduledTask -TaskName $task
Write-Host 'Started. Waiting for it to connect...'
$said = @()
foreach ($i in 1..40) {
  Start-Sleep -Milliseconds 500
  $said = @(Get-Content $log -ErrorAction SilentlyContinue | Select-Object -Skip $skip)
  if ($said -match 'Connected to |refused') { break }
}
$said | ForEach-Object { Write-Host $_ }
Write-Host ''
if ($said -match 'Connected to ') {
  Write-Host 'The runner agent is running as SYSTEM and starts again at every boot. Citadel can add schemes'' runners now.' -ForegroundColor Green
} else {
  Write-Host 'It has not connected yet: the lines above say why (nothing above means it did not start).' -ForegroundColor Yellow
}
# 7. The cap and yield (#552), proved on this PC: the agent's own copy is already holding the runners.
Write-Host ''
Write-Host 'Proving the CI cap on this PC (about 20 seconds, no runner touched)...'
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'keep-runners.ps1') -Prove -GitBin $GitBin
if ($LASTEXITCODE -ne 0) { Write-Host 'The CI cap did not hold here: paste the lines above to the minion.' -ForegroundColor Yellow }
Write-Host ''
Write-Host "Its log:   Get-Content -Wait `"$log`""
Write-Host "Stop it:   Disable-ScheduledTask -TaskName '$task'; Stop-ScheduledTask -TaskName '$task'"
Write-Host "Remove it: Unregister-ScheduledTask -TaskName '$task' -Confirm:`$false; Remove-Item -Recurse -Force `"$dir`""
Write-Host '(Removing the agent leaves every runner it added in place.)'
