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
  WSL distros are each person's own, so the task runs as whoever runs this, while they're logged on, like the session
  runners. It changes nothing inside the distro, touches no runner, and never restarts or reboots the PC. No
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

Start-Sleep -Seconds 5
$running = @(& $wsl -l -v | ForEach-Object { $_ -replace "`0", '' } | Where-Object { $_ -match "\b$([regex]::Escape($Distro))\s+Running\b" })
if ($running) {
  Write-Host "Task '$task' holds $Distro up for $me, from every logon on; $Distro is Running now." -ForegroundColor Green
} else {
  Write-Host "Task '$task' is registered, but $Distro isn't Running yet: wsl -l -v shows its state, and Task Scheduler the task's last result." -ForegroundColor Yellow
}
Write-Host "Stop it:   Disable-ScheduledTask -TaskName '$task'; Stop-ScheduledTask -TaskName '$task'"
Write-Host "Remove it: Unregister-ScheduledTask -TaskName '$task' -Confirm:`$false"
