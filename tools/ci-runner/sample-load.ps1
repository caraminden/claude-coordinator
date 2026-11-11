<#
.SYNOPSIS
  Prints one line of JSON about this PC's load, for the runner agent's load samples.

.DESCRIPTION
  Citadel #534. Read-only: it changes nothing and touches no runner. The runner agent (runner-agent.mjs) runs it every
  30 seconds and works the numbers out itself; this only reads what Node can't see on Windows:
    procs     every process as [pid, parent pid, path, CPU seconds so far, memory bytes]
    queue     threads waiting for a core (the processor queue length)
    quser     quser's lines, for whether a person is at the PC and how long since their last input
    hv        with Hyper-V on, the PC's true CPU % (the host's own counters leave guests out) and each VM's share,
              as the sum of its virtual processors' percentages
    temp      the hottest ACPI thermal zone in C, where the firmware reports one
    restarts  with -Restarts: when the PC came back from a restart with no clean shutdown (Kernel-Power 41),
              over the last 14 days
  Anything it can't read is null, never an error: a sample with gaps beats no sample.
#>
[CmdletBinding()]
param([switch]$Restarts)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

function Read-OrNull([scriptblock]$Block) {
  try { & $Block } catch { $null }
}

$procs = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, ExecutablePath, KernelModeTime, UserModeTime, WorkingSetSize FROM Win32_Process' | ForEach-Object {
    , @([int]$_.ProcessId, [int]$_.ParentProcessId, [string]$_.ExecutablePath, [math]::Round(([double]$_.KernelModeTime + [double]$_.UserModeTime) / 1e7, 2), [long]$_.WorkingSetSize)
  })

$queue = Read-OrNull { [int](Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_System).ProcessorQueueLength }

$quser = Read-OrNull {
  $old = $ErrorActionPreference
  # quser writes "No User exists" to stderr and exits 1 with nobody logged on: that is an answer, not an error.
  $ErrorActionPreference = 'Continue'
  try { @(& "$env:SystemRoot\System32\quser.exe" 2>$null | ForEach-Object { [string]$_ }) } finally { $ErrorActionPreference = $old }
}

$hv = Read-OrNull {
  $total = Get-CimInstance -ClassName Win32_PerfFormattedData_HvStats_HyperVHypervisorLogicalProcessor -Filter "Name = '_Total'"
  $vms = @{}
  Get-CimInstance -ClassName Win32_PerfFormattedData_HvStats_HyperVHypervisorVirtualProcessor | Where-Object { $_.Name -ne '_Total' } | ForEach-Object {
    $name = ($_.Name -split ':')[0]
    $vms[$name] = [double]$vms[$name] + [double]$_.PercentTotalRunTime
  }
  @{ total = [double]$total.PercentTotalRunTime; vms = $vms }
}

$temp = Read-OrNull {
  $zones = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature)
  if ($zones.Count) { [math]::Round((($zones | Measure-Object -Property CurrentTemperature -Maximum).Maximum / 10) - 273.15, 1) }
}

$out = @{ procs = $procs; queue = $queue; quser = $quser; hv = $hv; temp = $temp }
if ($Restarts) {
  # Get-WinEvent throws when nothing matches: no hard restarts is an empty list.
  $found = Read-OrNull {
    @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 41; StartTime = (Get-Date).AddDays(-14) } |
        ForEach-Object { $_.TimeCreated.ToUniversalTime().ToString('o') })
  }
  $out.restarts = if ($null -eq $found) { @() } else { @($found) }
}
[Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 5))
