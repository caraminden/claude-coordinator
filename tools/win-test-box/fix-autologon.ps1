<#
.SYNOPSIS
  For when the test box sits at its sign-in screen (#461). Run on the host, in PowerShell as
  administrator. It asks for the box's password, prints why the box isn't signing in, puts the
  autologon back (stay-signed-in.ps1, sent into the box over PowerShell Direct), restarts the box
  gracefully and says PASS or FAIL. The password is never printed or written anywhere on the host.

.DESCRIPTION
  The restart is a normal Windows restart from inside the box. Never restart the box with
  Restart-VM -Force or a plain Restart-VM: that is a hard reset, and it put the box into Automatic
  Repair on 2026-11-10.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\fix-autologon.ps1
#>
[CmdletBinding()]
param([string]$Name = 'citadel-test-vm')
$ErrorActionPreference = 'Stop'
$report = Join-Path ([Environment]::GetFolderPath('Desktop')) 'citadel-box-autologon.txt'
$cred = Get-Credential citadel
$password = $cred.GetNetworkCredential().Password
$guest = [scriptblock]::Create((Get-Content (Join-Path $PSScriptRoot 'stay-signed-in.ps1') -Raw))
function Invoke-Box([string]$Mode) { Invoke-Command -VMName $Name -Credential $cred -ScriptBlock $guest -ArgumentList $password, $Mode }
function Get-BoxState {
  Invoke-Command -VMName $Name -Credential $cred -ErrorAction Stop -ScriptBlock {
    [pscustomobject]@{
      Boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
      User = (Get-CimInstance Win32_ComputerSystem).UserName
      Shells = @(Get-Process explorer -ErrorAction SilentlyContinue).Count
    }
  }
}

"Citadel test box autologon, $((Get-Date).ToUniversalTime().ToString('u'))" | Tee-Object -FilePath $report
Invoke-Box Show | Tee-Object -FilePath $report -Append
'', '== Applying the fix' | Tee-Object -FilePath $report -Append
Invoke-Box Apply | ForEach-Object { "  $_" } | Tee-Object -FilePath $report -Append

Write-Host "`nA restart ends whatever is on the box's screen (see 'Who has the screen' above)." -ForegroundColor Yellow
if ((Read-Host 'Restart the box now, gracefully, to test the sign-in? (y/n)') -ne 'y') { Write-Host "Not restarted. The report is at $report"; exit 0 }
$before = (Get-BoxState).Boot
Invoke-Command -VMName $Name -Credential $cred -ScriptBlock { shutdown.exe /r /t 5 /c 'Citadel: testing autologon' | Out-Null }
Write-Host 'Restarting; waiting for it to come back and sign itself in (up to 10 minutes)...'
$deadline = (Get-Date).AddMinutes(10)
$upSince = $null
$verdict = 'FAIL: the box did not come back within 10 minutes. Connect to it in Hyper-V Manager and look.'
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 15
  try { $s = Get-BoxState } catch { continue }
  if ($s.Boot -le $before) { continue }
  if ($s.User -or $s.Shells) { $verdict = "PASS: the box restarted and signed itself in as $($s.User)."; break }
  if (-not $upSince) { $upSince = Get-Date }
  if (((Get-Date) - $upSince).TotalMinutes -gt 3) { $verdict = 'FAIL: the box restarted but nobody is signed in after 3 minutes.'; break }
}
'', "== Result: $verdict" | Tee-Object -FilePath $report -Append
if ($verdict -like 'FAIL*' -and $upSince) {
  '', '== After the failed restart' | Tee-Object -FilePath $report -Append
  Invoke-Box Show | Tee-Object -FilePath $report -Append
}
Write-Host "`nThe report is at $report (it holds no password)." -ForegroundColor Cyan
if ($verdict -like 'FAIL*') { exit 1 }
