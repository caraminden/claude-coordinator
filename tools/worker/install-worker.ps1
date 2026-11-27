<#
.SYNOPSIS
  Makes this Windows PC run its owner's Citadel minions, in a WSL distro of its own (citadel-workers).

.DESCRIPTION
  Citadel Build 7. The PC's machine agent runs it when its owner presses Set up on Minion turns (public/role-setup-agent.mjs),
  with this PC's token in CC_MACHINE_TOKEN; an agent from before shows the whole command to paste. It runs in a normal
  PowerShell, as the person whose PC it is: WSL distros and the task below are each person's own. Running it
  again updates the worker and keeps its sign-ins. It:
    1. installs the distro citadel-workers (Ubuntu 24.04), if it isn't there;
    2. turns systemd-timesyncd off in it before anything else: one distro's timesyncd skews the clock every distro on
       this PC shares, CI's included (#542);
    3. runs install-worker.sh in it: no Windows drives or programs reachable from there, podman, the worker and its caps;
    4. registers the task "Citadel minion workers", which holds that distro up from your logon on.
  It changes no other distro, and never restarts WSL or the PC. Signing out of Windows stops the worker until you sign in again.
  Remove all of it:  wsl --unregister citadel-workers; Unregister-ScheduledTask 'Citadel minion workers'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^https?://[A-Za-z0-9.:-]+/?$')][string]$Url,
  [ValidateRange(1, 64)][int]$Workers = 6,
  [ValidateRange(1, 1024)][int]$Threads = 8,
  [ValidateRange(2, 4096)][int]$MemoryGB = 24,
  [ValidateRange(20, 99999)][int]$DiskGB = 60
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

$distro = 'citadel-workers'
$task = 'Citadel minion workers'
$wsl = "$env:SystemRoot\System32\wsl.exe"
$Url = $Url.TrimEnd('/')

function Stop-With([string]$Why) {
  Write-Host "install-worker: $Why" -ForegroundColor Red
  exit 1
}

# The distros' names: wsl.exe prints UTF-16.
function Get-Distro {
  @(& $wsl -l -q | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
}

$token = "$env:CC_MACHINE_TOKEN".Trim()
if ($token -notmatch '^ccm_[0-9]+_[A-Za-z0-9_-]{43}$') { Stop-With 'No machine token in CC_MACHINE_TOKEN: copy the whole command from the Machines page.' }
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($me.User.Value -eq 'S-1-5-18') { Stop-With 'Run this as the person whose PC it is, not as SYSTEM.' }
$signedIn = (Get-CimInstance Win32_ComputerSystem).UserName
if ($signedIn -and $signedIn -ne $me.Name) { Stop-With "This window runs as $($me.Name), but $signedIn is signed in, and WSL distros are each person's own. Open a normal PowerShell (not Run as administrator)." }

# 1. WSL and the distro.
$hasWsl = Test-Path $wsl
if ($hasWsl) {
  & $wsl --version | Out-Null
  $hasWsl = $LASTEXITCODE -eq 0
}
if (-not $hasWsl) { Stop-With "WSL 2 isn't installed here. In PowerShell as administrator run:  wsl --install --no-distribution  then restart the PC and run this again." }
if ((Get-Distro) -notcontains $distro) {
  Write-Host "Installing the distro $distro (about 1 GB)..."
  & $wsl --install Ubuntu-24.04 --name $distro --no-launch
  if ((Get-Distro) -notcontains $distro) { Stop-With "The distro did not install: the lines above say why. An older WSL can't name a distro:  wsl --update  then run this again." }
}

# 2. The clock, before anything else in there: masked as systemctl does it, which here works while systemd is still starting.
# No double quotes in what goes to wsl.exe: Windows PowerShell 5.1 passes them on unescaped.
& $wsl -d $distro -u root --exec /bin/sh -c 'ln -sf /dev/null /etc/systemd/system/systemd-timesyncd.service && { systemctl stop systemd-timesyncd 2>/dev/null; true; }'
if ($LASTEXITCODE -ne 0) { Stop-With "Could not turn systemd-timesyncd off in $distro, so nothing else was done there." }

# 3. The worker. Twice at most: the first run writes /etc/wsl.conf, which takes at the distro's next start.
$get = 'command -v curl >/dev/null || { apt-get update -q && apt-get install -y -q curl ca-certificates; }; curl -fsSL -o /root/install-worker.sh ' + "$Url/worker-setup/install-worker.sh"
& $wsl -d $distro -u root --exec /bin/sh -c $get
if ($LASTEXITCODE -ne 0) { Stop-With "The distro could not download $Url/worker-setup/install-worker.sh." }
# The token goes in on standard input, never on a command line other programs can read.
$run = 'read -r t; export CC_MACHINE_TOKEN=$(printf %s $t | tr -cd A-Za-z0-9_-); exec bash /root/install-worker.sh ' + "$Url --workers $Workers --threads $Threads --memory $MemoryGB --disk $DiskGB </dev/null"
$ended = 10
foreach ($try in 1, 2) {
  $token | & $wsl -d $distro -u root --exec /bin/sh -c $run
  $ended = $LASTEXITCODE
  if ($ended -ne 10) { break }
  & $wsl --terminate $distro | Out-Null
}
if ($ended -ne 0) { Stop-With "The worker's setup did not finish: the lines above say why. Running the same command again carries on from there." }

# 4. Held up from logon on: WSL stops a distro soon after the last Windows program using it ends.
$who = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless `"$wsl`" -d $distro -u root --exec /bin/sleep infinity"
$triggers = (New-ScheduledTaskTrigger -AtLogOn -User $who), (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -Force -TaskName $task -Action $action -Trigger $triggers -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $task
Write-Host "The task '$task' keeps it running while you are signed in to Windows."
