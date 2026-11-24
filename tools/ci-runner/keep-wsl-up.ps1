<#
.SYNOPSIS
  Keeps the WSL distro that holds Citadel's Linux CI runners running: at every logon, and again within 5 minutes if it
  ever stops.

.DESCRIPTION
  Citadel #510. WSL stops a distro seconds after the last Windows program using it exits, and its systemd services
  (the runner agent and every Linux runner) stop with it. This registers the scheduled task "Citadel WSL runners" for
  the person who runs it: at their logon, and every 5 minutes in case it ended (IgnoreNew skips a run while one is
  going), it runs `wsl.exe -d <distro> -u root --exec /bin/sleep infinity` in a hidden console, which holds the distro
  up. Then it starts the task now.
  It also registers "Citadel WSL clock" (#900): every 5 minutes, in every distro that is running (it starts none), it
  masks systemd-timesyncd where WSL keeps the clock itself, since one distro's timesyncd skews the clock every distro
  shares, CI's included (tools/ci-runner/README.md, #542). Each distro it masks goes in
  %LOCALAPPDATA%\citadel-wsl-clock.log.
  For citadel-ci it also registers "Citadel WSL ports" (#1763): while citadel-ci runs, every 10 s, it writes how many
  Windows listening ports wslrelay holds into /run/citadel-win-ports there, and each CI suite fails if that rose across
  it (tools/ci-runner/win-ports.sh), since wslrelay once leaked them until Windows ran short (#1753).
  WSL distros are each person's own, so the task runs as whoever runs this, while they're logged on, like the session
  runners. Besides that count file it changes nothing inside the distro; it touches no runner, and never restarts or reboots the PC. No
  elevation needed.

.PARAMETER Distro
  The distro's name (default citadel-ci, what README's steps install).

.EXAMPLE
  .\keep-wsl-up.ps1
#>
[CmdletBinding()]
param(
  [string]$Distro = 'citadel-ci'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

function Stop-With([string]$Why) {
  Write-Host "keep-wsl-up: $Why" -ForegroundColor Red
  exit 1
}

# One task per distro: the emulator's (#533, -Distro citadel-android) must not replace the runners'.
$task = if ($Distro -eq 'citadel-ci') { 'Citadel WSL runners' } else { "Citadel WSL $Distro" }
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -eq 'S-1-5-18') { Stop-With 'Run this as the person whose WSL holds the distro, not as SYSTEM.' }
if (-not (Test-Path $wsl)) { Stop-With 'No wsl.exe: install WSL first (README, "Linux runners in WSL").' }
# wsl.exe -l prints UTF-16; -q lists names only.
$names = @(& $wsl -l -q | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
if ($names -notcontains $Distro) { Stop-With "There is no WSL distro $Distro for $env:USERNAME (wsl -l -q lists: $($names -join ', ')). Install it first (README, ""Linux runners in WSL"")." }

$me = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless `"$wsl`" -d $Distro -u root --exec /bin/sleep infinity"
$triggers = (New-ScheduledTaskTrigger -AtLogOn -User $me), (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -Force -TaskName $task -Action $action -Trigger $triggers -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $task

# The clock guard (#900): a new Ubuntu distro turns timesyncd on, and that alone skews CI's clock. No double quotes in
# the sh line: Windows PowerShell 5.1 passes them to wsl.exe unescaped.
$sh = 'grep -qa refclock.PHC /init 2>/dev/null || exit 0; test -e /usr/lib/systemd/system/systemd-timesyncd.service || exit 0; systemctl is-enabled systemd-timesyncd 2>/dev/null | grep -qx masked && exit 0; systemctl mask --now systemd-timesyncd >/dev/null 2>&1 && echo masked'
$guard = @"
`$w = '$wsl'; `$log = Join-Path `$env:LOCALAPPDATA 'citadel-wsl-clock.log'
foreach (`$d in @(& `$w -l --running -q | ForEach-Object { (`$_ -replace "``0", '').Trim() } | Where-Object { `$_ })) {
  if ((& `$w -d `$d -u root --exec /bin/sh -c '$sh') -eq 'masked') { Add-Content `$log "`$(Get-Date -Format s) masked systemd-timesyncd in `$d" }
}
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($guard))
$clockAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless `"$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -NonInteractive -EncodedCommand $encoded"
$clockSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -Force -TaskName 'Citadel WSL clock' -Action $clockAction -Trigger $triggers -Principal $principal -Settings $clockSettings | Out-Null
Start-ScheduledTask -TaskName 'Citadel WSL clock'

# The Windows half of the CI leak count (#1763): the distro can't see Windows, so this tells it, every 10 s, how many
# Windows listening ports wslrelay holds. The sh line keeps to single quotes and an argument with no spaces, for 5.1.
if ($Distro -eq 'citadel-ci') {
  $count = @'
$w = '__WSL__'; $d = '__DISTRO__'
while ($true) {
  if (@(& $w -l --running -q | ForEach-Object { ($_ -replace "`0", '').Trim() }) -contains $d) {
    $r = @(Get-Process wslrelay -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $l = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
    $n = @($l | Where-Object { $r -contains $_.OwningProcess }).Count
    & $w -d $d -u root --exec /bin/sh -c 'echo $1 > /run/citadel-win-ports.tmp && mv -f /run/citadel-win-ports.tmp /run/citadel-win-ports' sh "wslrelay=$n,listen=$($l.Count)"
  }
  Start-Sleep -Seconds 10
}
'@ -replace '__WSL__', $wsl -replace '__DISTRO__', $Distro
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($count))
  $portsAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless `"$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -NonInteractive -EncodedCommand $encoded"
  Register-ScheduledTask -Force -TaskName 'Citadel WSL ports' -Action $portsAction -Trigger $triggers -Principal $principal -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName 'Citadel WSL ports'
}

Start-Sleep -Seconds 5
$running = @(& $wsl -l -v | ForEach-Object { $_ -replace "`0", '' } | Where-Object { $_ -match "\b$([regex]::Escape($Distro))\s+Running\b" })
if ($running) {
  Write-Host "Task '$task' holds $Distro up for $me, from every logon on; $Distro is Running now." -ForegroundColor Green
} else {
  Write-Host "Task '$task' is registered, but $Distro isn't Running yet: wsl -l -v shows its state, and Task Scheduler the task's last result." -ForegroundColor Yellow
}
Write-Host "Stop it:   Disable-ScheduledTask -TaskName '$task'; Stop-ScheduledTask -TaskName '$task'"
Write-Host "Remove it: Unregister-ScheduledTask -TaskName '$task' -Confirm:`$false"
if ($Distro -eq 'citadel-ci') { Write-Host "Task 'Citadel WSL ports' tells $Distro every 10 s how many Windows listening ports wslrelay holds; CI fails a suite that left more (#1763)." }
Write-Host "Task 'Citadel WSL clock' masks systemd-timesyncd in any running distro every 5 minutes; what it masked: $env:LOCALAPPDATA\citadel-wsl-clock.log"
