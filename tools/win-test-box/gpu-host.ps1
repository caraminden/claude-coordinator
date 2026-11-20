<#
.SYNOPSIS
  Gives the test box a share of this PC's GPU (#1175): a Hyper-V GPU partition, with the GPU driver's
  files copied into the box. Run it again after every GPU driver update: that copies them again.

.DESCRIPTION
  Run on Cara's PC, in PowerShell as administrator. README.md beside this, "A GPU for jobs that ask".
  Inside the box the GPU stays off, so everything draws in software as before, until a job asks for
  it (the run-gpu task, gpu.ps1).
  1. Checks: the edition, Hyper-V, a GPU that Windows can partition, the box's settings. With
     -CheckOnly it stops here and changes nothing.
  2. Asks for the box's password (user citadel) to reach it over PowerShell Direct.
  3. Copies gpu.ps1 and add-scheme.ps1 into C:\citadel-box, and the driver's files into the box
     (C:\Windows\System32\HostDriverStore and System32). Refuses while a job has the GPU on.
  4. First time only, after asking: shuts the box down cleanly, gives it the GPU partition and starts
     it again (about 3 minutes; a job running on it then fails and is run again).
  5. Runs gpu.ps1 -Install in the box: the GPU off there, the run-gpu task in every workspace.
  GPU jobs' off switch is in Citadel, on the Machines page (Josh, 2026-11-19), not here.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\gpu-host.ps1 -CheckOnly
#>
[CmdletBinding()]
param(
  [string]$Name = 'citadel-test-box',
  # The most of each GPU resource (memory, encode, decode, compute) the partition asks for. GeForce
  # drivers aren't known to enforce it, so it's a request, not a cap (README.md).
  [ValidateRange(10, 100)][int]$SharePercent = 50,
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
function Say([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Stop-With([string]$Why) { Write-Host "`nStopped: $Why" -ForegroundColor Red; exit 1 }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Stop-With 'run this in PowerShell as administrator (right-click, Run as administrator).' }

# ---------- 1. checks ----------
Say 'Checking this PC'
$os = Get-CimInstance Win32_OperatingSystem
Write-Host "  $($os.Caption), build $($os.BuildNumber)"
if ($os.Caption -notmatch 'Pro|Enterprise|Education') { Stop-With 'GPU partitioning needs Hyper-V, which needs Windows Pro, Enterprise or Education.' }
if (-not (Get-Command Add-VMGpuPartitionAdapter -ErrorAction SilentlyContinue)) { Stop-With "Hyper-V's PowerShell module has no Add-VMGpuPartitionAdapter here, so this Windows can't partition a GPU." }
$vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
if (-not $vm) { Stop-With "there's no VM named '$Name' on this PC." }

# The GPU: a PCI display device that Windows lists as partitionable. NVIDIA first if there are several.
$parts = @(if (Get-Command Get-VMHostPartitionableGpu -ErrorAction SilentlyContinue) { Get-VMHostPartitionableGpu } else { Get-VMPartitionableGpu })
$cards = @(Get-CimInstance Win32_VideoController | Where-Object PNPDeviceID -like 'PCI\*' | Sort-Object { $_.PNPDeviceID -notlike 'PCI\VEN_10DE*' })
$card = $null; $part = $null
foreach ($c in $cards) {
  Write-Host "  GPU: $($c.Name), driver $($c.DriverVersion)$(if ($c.DriverDate) { ' of ' + $c.DriverDate.ToString('yyyy-MM-dd') })"
  # A partitionable GPU's name is its device path: \\?\PCI#VEN_..&DEV_..#<instance>#{guid}.
  $p = $parts | Where-Object { $_.Name.ToUpperInvariant().Contains(($c.PNPDeviceID -replace '\\', '#').ToUpperInvariant()) } | Select-Object -First 1
  if ($p -and -not $card) { $card = $c; $part = $p }
}
if (-not $card) {
  Stop-With @"
Windows lists $($parts.Count) partitionable GPU(s), and none is this PC's GPU, so its driver doesn't offer partitioning. Nothing was changed.
Microsoft's driver docs name a host-wide registry override for that (GpuVirtualizationFlags). It touches the GPU driver her games use, so it isn't in this script: ask on Citadel first.
"@
}
Write-Host "  $($card.Name) can be partitioned ($($part.PartitionCount) partitions)"
if ($vm.DynamicMemoryEnabled) { Stop-With "the box has dynamic memory on; a GPU partition needs it off (new-test-box.ps1 turns it off)." }
if ($vm.CheckpointType -ne 'Disabled') { Stop-With "the box has checkpoints on; a GPU partition needs them off: Set-VM -Name $Name -CheckpointType Disabled" }
$have = Get-VMGpuPartitionAdapter -VMName $Name -ErrorAction SilentlyContinue
Write-Host "  The box: $($vm.State), $(if ($have) { 'has its GPU partition already, so this run copies the driver again' } else { 'no GPU partition yet' })"

# The driver's files: whole driver-store folders go to the box's HostDriverStore, loose ones in
# System32 and SysWOW64 to the same place there. Its INF and kernel driver stay out: the box loads
# Microsoft's virtual render driver, not NVIDIA's kernel one.
$files = @(Get-CimInstance Win32_PnPSignedDriverCIMDataFile | Where-Object { $_.Antecedent.DeviceID -eq $card.PNPDeviceID } | ForEach-Object { $_.Dependent.Name })
$store = "$env:SystemRoot\System32\DriverStore\FileRepository\"
$folders = @($files | Where-Object { $_ -like "$store*" } | ForEach-Object { $store + ($_.Substring($store.Length) -split '\\')[0] } | Sort-Object -Unique)
$loose = @($files | Where-Object { $_ -notlike "$store*" -and (Split-Path $_) -in "$env:SystemRoot\System32", "$env:SystemRoot\SysWOW64" } | Where-Object { Test-Path $_ })
if (-not $folders) { Stop-With "Windows names none of $($card.Name)'s driver files in its driver store ($($files.Count) files in all), so there is nothing to copy. Nothing was changed." }
$mb = [int]((Get-ChildItem $folders -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "  Driver files to copy: $($folders.Count) driver-store folder(s), $mb MB, and $($loose.Count) loose file(s)"

if ($CheckOnly) { Write-Host "`nThis PC can give the box its GPU. Nothing was changed." -ForegroundColor Green; exit 0 }

# ---------- 2. reach the box ----------
$cred = Get-Credential -UserName citadel -Message "The test box's password (user citadel, in your password manager)"
function Connect-Box {
  if ((Get-VM -Name $Name).State -ne 'Running') { Start-VM -Name $Name }
  $until = (Get-Date).AddMinutes(6)
  while ($true) {
    try { return New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop }
    catch {
      if ($_.Exception.Message -match 'password|credential|logon failure') { Stop-With "the box refused that password: $($_.Exception.Message)" }
      if ((Get-Date) -gt $until) { Stop-With "the box didn't answer over PowerShell Direct in 6 minutes: $($_.Exception.Message)" }
      Start-Sleep -Seconds 10
    }
  }
}
function Install-InBox($Session) {
  $r = Invoke-Command -Session $Session { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\citadel-box\gpu.ps1 -Install; $LASTEXITCODE }
  $r | Select-Object -SkipLast 1 | ForEach-Object { Write-Host "  $_" }
  if ($r[-1]) { Stop-With "gpu.ps1 -Install failed in the box (above)." }
}
Say 'Reaching the box'
$s = Connect-Box
$guest, $boxAdmin = Invoke-Command -Session $s {
  (Get-CimInstance Win32_OperatingSystem).BuildNumber
  ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not $boxAdmin) { Stop-With "the session in the box isn't an administrator one, so it can't write System32. Nothing was changed." }
Write-Host "  The box runs build $guest; this PC runs $($os.BuildNumber)"
if ("$guest" -ne "$($os.BuildNumber)") { Write-Host "  (Microsoft's docs allow different builds; a community guide has seen blue screens from a mismatch. If the box crashes after this, that's the first suspect.)" }

# ---------- 3. copy ----------
Say 'Copying gpu.ps1 and add-scheme.ps1 into C:\citadel-box'
Copy-Item -ToSession $s -Path "$PSScriptRoot\gpu.ps1", "$PSScriptRoot\add-scheme.ps1" -Destination 'C:\citadel-box\' -Force
if ($have) {
  # Off unless a job is asking; a job's driver files are in use until it ends.
  Install-InBox $s
  $on = Invoke-Command -Session $s { @(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -notlike 'Microsoft *' -and $_.Status -eq 'OK' }).Count }
  if ($on) { Stop-With 'a job on the box has the GPU on right now, so its driver files are in use. Run this again in a few minutes.' }
}
Say "Copying the driver's files into the box ($mb MB; a few minutes)"
$names = @($folders | ForEach-Object { Split-Path $_ -Leaf })
$repo = 'C:\Windows\System32\HostDriverStore\FileRepository'
Invoke-Command -Session $s {
  New-Item -ItemType Directory -Force $using:repo | Out-Null
  # Folders from an older driver go. The current ones are copied over again: an earlier copy may have stopped halfway.
  Get-ChildItem $using:repo -Directory | Where-Object Name -notin $using:names | Remove-Item -Recurse -Force
}
foreach ($f in $folders) {
  Write-Host "  $(Split-Path $f -Leaf)"
  Copy-Item -ToSession $s -Path $f -Destination "$repo\" -Recurse -Force
}
foreach ($f in $loose) { Copy-Item -ToSession $s -Path $f -Destination (Split-Path $f) -Force }
Write-Host "  $($loose.Count) loose file(s) copied"

# ---------- 4. the partition: added the first time, and its share set whenever it isn't ours ----------
# Max and optimal at the share; min at 1%, so a driver that did honour it reserves next to nothing.
# [decimal]: the encode maximum is 2^64-1, past what a double holds exactly; Max's 1 is [decimal] too, or
# PowerShell picks Max(int, int) and the 2^64/100 minimum overflows it (#1175, the first run on her PC).
$values = @{}
foreach ($k in 'VRAM', 'Encode', 'Decode', 'Compute') {
  $max = [decimal]$part."MaxPartition$k"
  $values["MinPartition$k"] = [uint64][Math]::Max([decimal]1, [Math]::Floor($max / 100))
  $values["MaxPartition$k"] = [uint64][Math]::Floor($max * $SharePercent / 100)
  $values["OptimalPartition$k"] = $values["MaxPartition$k"]
}
# A run that stopped after adding the partition (or a new -SharePercent) leaves values that aren't these: set them again.
$mine = $have -and [uint64]$have.MaxPartitionVRAM -eq $values.MaxPartitionVRAM -and [uint64]$have.MaxPartitionEncode -eq $values.MaxPartitionEncode
if (-not $mine) {
  Say 'Giving the box its GPU partition'
  Write-Host '  This shuts the box down cleanly, changes its settings and starts it again: about 3 minutes.'
  Write-Host '  A CI job or minion job running on it now fails and is run again.'
  if ((Read-Host '  Go on? (y/n)') -notmatch '^y') { Stop-With 'you said no. The driver files are in the box; nothing else changed.' }
  Remove-PSSession $s
  # -Force still shuts Windows down in the box (apps get to close); -TurnOff would be the hard stop.
  Stop-VM -Name $Name -Force
  $until = (Get-Date).AddMinutes(6)
  while ((Get-VM -Name $Name).State -ne 'Off') {
    if ((Get-Date) -gt $until) { Stop-With "the box didn't shut down in 6 minutes. Look in its window (Hyper-V Manager, Connect), then run this again." }
    Start-Sleep -Seconds 5
  }
  Set-VM -Name $Name -GuestControlledCacheTypes $true -LowMemoryMappedIoSpace 3GB -HighMemoryMappedIoSpace 32GB
  if (-not $have) { Add-VMGpuPartitionAdapter -VMName $Name -InstancePath $part.Name }
  Set-VMGpuPartitionAdapter -VMName $Name @values
  Write-Host "  partition set: up to $SharePercent% of $($card.Name)"
  $s = Connect-Box
}

# ---------- 5. off in the box until a job asks ----------
Say 'Setting the switch up in the box'
Install-InBox $s
Remove-PSSession $s
Write-Host "`nDone. Tell Citadel (#1175) so a minion can check a job gets the GPU and one that doesn't still draws in software." -ForegroundColor Green
