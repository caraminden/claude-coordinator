<#
.SYNOPSIS
  Takes Citadel's Windows test box off this PC (#369): turns the VM off, removes it and deletes its
  disk. Run in PowerShell as administrator on the host. It never restarts this PC.

.DESCRIPTION
  Its GitHub runners go Offline and stay listed on each repo's Settings, Actions, Runners page until
  removed there (or run the scheme's runner setup with -Remove inside the box first). Its machine on
  Citadel's Machines page goes offline; delete it there too.
#>
param([string]$Name = 'citadel-test-vm')
$ErrorActionPreference = 'Stop'
$vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
if (-not $vm) { Write-Host "No VM '$Name' here."; exit 0 }
$disks = @(Get-VMHardDiskDrive -VM $vm | Select-Object -ExpandProperty Path)
Write-Host "This turns off and deletes the VM '$Name' and its disk(s):`n  $($disks -join "`n  ")"
if ((Read-Host 'Type the VM name to go ahead') -ne $Name) { Write-Host 'Left as it is.'; exit 1 }
if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
Remove-VM -VM $vm -Force
foreach ($d in $disks) { Remove-Item $d -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path $PSScriptRoot "$Name.password.txt") -ErrorAction SilentlyContinue
Write-Host 'Removed. Remove its runners on GitHub and its machine on Citadel''s Machines page.'
