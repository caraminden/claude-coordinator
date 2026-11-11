<#
.SYNOPSIS
  Keeps every CI runner on this PC at below-normal priority and all of them together under a CPU cap, and starts
  runner services a reboot left stopped.

.DESCRIPTION
  Citadel #552 (Josh, 2026-11-11: "ok, CI is using my whole desktop, can we limit it a bit?", picked "Cap and
  yield"). The runner agent (runner-agent.mjs) starts it and keeps it running, as SYSTEM. Every few seconds it:
    1. finds every runner on the PC, Citadel's or not: each RunnerService.exe and Runner.Listener.exe (a service's
       or a session runner's) and every process started under them;
    2. puts any of those not yet held into one Windows job object, which runs everything in it at below-normal
       priority and holds it all together to -CpuPercent of the whole PC (a hard cap). A process started by one in
       the job is in the job from its first instruction, so a job's cargo, MSBuild, node or dotnet is held too; the
       sweep only catches what started before this script did;
    3. starts any runner service that is set to start automatically but is stopped (the BIOS reboot of 2026-11-11
       left them all stopped), at most once every 5 minutes each. To keep one stopped, set it to Manual.
  It holds the job open for as long as it runs, and ends when the agent (-AgentPid) does. It never stops, removes or
  re-registers a runner, and never restarts the PC.

  -Prove checks the mechanism on this PC instead, and touches no runner: it starts a process in a job of its own,
  capped at 25%, which starts one CPU-burning grandchild per core, then reports whether the grandchildren are in the
  job, at below-normal priority, and what share of the PC the job used. It exits 0 when all three hold.

.PARAMETER CpuPercent
  The share of the whole PC (every core) all CI together may use, 1 to 100.

.PARAMETER AgentPid
  The runner agent's process id: this script ends when that process does.

.EXAMPLE
  .\keep-runners.ps1 -Prove
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 100)][int]$CpuPercent = 75,
  [int]$AgentPid = 0,
  [ValidateRange(5, 300)][int]$EverySeconds = 15,
  [switch]$Prove
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CitadelCiJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit {
    public BasicLimit Basic; public ulong R1, R2, R3, W1, W2, W3;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct CpuRate { public uint ControlFlags; public uint Rate; }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodUserTime; public long ThisPeriodKernelTime;
    public uint PageFaults; public uint TotalProcesses; public uint ActiveProcesses; public uint TerminatedProcesses;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref CpuRate info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  const uint LIMIT_PRIORITY_CLASS = 0x20, LIMIT_BREAKAWAY_OK = 0x800, BELOW_NORMAL = 0x4000;
  const uint RATE_ENABLE = 0x1, RATE_HARD_CAP = 0x4;
  const uint SET_QUOTA = 0x100, TERMINATE = 0x1, QUERY_LIMITED = 0x1000;

  // A job that runs everything in it at below-normal priority, all of it together held to percent of every core.
  // Breakaway is allowed so a tool that asks for it still starts (it would fail otherwise); the sweep takes it back.
  public static IntPtr Create(string name, int percent) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
    if (job == IntPtr.Zero) throw new Win32Exception();
    ExtendedLimit limit = new ExtendedLimit();
    limit.Basic.LimitFlags = LIMIT_PRIORITY_CLASS | LIMIT_BREAKAWAY_OK;
    limit.Basic.PriorityClass = BELOW_NORMAL;
    if (!SetInformationJobObject(job, 9, ref limit, Marshal.SizeOf(limit))) throw new Win32Exception();
    CpuRate rate = new CpuRate();
    rate.ControlFlags = RATE_ENABLE | RATE_HARD_CAP;
    rate.Rate = (uint)(percent * 100);
    if (!SetInformationJobObject(job, 15, ref rate, Marshal.SizeOf(rate))) throw new Win32Exception();
    return job;
  }

  // 0 when the process is in the job now, else the Win32 error (5: it is in another job this one can't nest under).
  public static int Assign(IntPtr job, int pid) {
    IntPtr p = OpenProcess(SET_QUOTA | TERMINATE | QUERY_LIMITED, false, pid);
    if (p == IntPtr.Zero) return Marshal.GetLastWin32Error();
    try { return AssignProcessToJobObject(job, p) ? 0 : Marshal.GetLastWin32Error(); } finally { CloseHandle(p); }
  }

  public static bool InJob(IntPtr job, int pid) {
    IntPtr p = OpenProcess(QUERY_LIMITED, false, pid);
    if (p == IntPtr.Zero) return false;
    try { bool inside; return IsProcessInJob(p, job, out inside) && inside; } finally { CloseHandle(p); }
  }

  // CPU seconds every process that was ever in the job has used.
  public static double CpuSeconds(IntPtr job) {
    Accounting a;
    if (!QueryInformationJobObject(job, 1, out a, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
    return (a.TotalUserTime + a.TotalKernelTime) / 1e7;
  }

  public static void Kill(IntPtr job) { TerminateJobObject(job, 1); }
}
'@

$cores = [Environment]::ProcessorCount

if ($Prove) {
  $cap = 25
  $job = [CitadelCiJob]::Create([NullString]::Value, $cap)
  # The parent waits before starting its children, so it is in the job first: they must get there by inheritance.
  # Each child is cmd spinning in an endless loop, one core's worth, like one compiler of a parallel build.
  $burn = "Start-Sleep -Seconds 3; 1..$cores | ForEach-Object { Start-Process -FilePath `$env:ComSpec -ArgumentList '/c for /l %i in (0,0,1) do @rem' -WindowStyle Hidden }; Start-Sleep -Seconds 60"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($burn))
  $parent = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile', '-EncodedCommand', $encoded -WindowStyle Hidden -PassThru
  try {
    $err = [CitadelCiJob]::Assign($job, $parent.Id)
    if ($err) { throw "Couldn't put the test's parent process in its job (Win32 error $err)." }
    Start-Sleep -Seconds 8
    $kids = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $($parent.Id)" | Where-Object { $_.Name -eq 'cmd.exe' })
    $inJob = @($kids | Where-Object { [CitadelCiJob]::InJob($job, [int]$_.ProcessId) }).Count
    $below = @($kids | Where-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).PriorityClass -eq 'BelowNormal' }).Count
    $before = [CitadelCiJob]::CpuSeconds($job)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Seconds 10
    $used = ([CitadelCiJob]::CpuSeconds($job) - $before) / ($clock.Elapsed.TotalSeconds * $cores) * 100
  } finally {
    [CitadelCiJob]::Kill($job)
  }
  $held = $kids.Count -gt 0 -and $inJob -eq $kids.Count -and $below -eq $kids.Count -and $used -le $cap + 5
  Write-Host ("{0} of {1} grandchildren started, {2} in the job, {3} at below-normal priority; the job used {4:N1}% of the PC's {1} cores against a cap of {5}% (uncapped they would take about 100%)." -f $kids.Count, $cores, $inJob, $below, $used, $cap)
  Write-Host $(if ($held) { 'Held: the cap and the priority reach processes started inside the job.' } else { 'NOT held: the line above says which part failed.' })
  exit $(if ($held) { 0 } else { 1 })
}

$job = [CitadelCiJob]::Create('Global\CitadelCiRunners', $CpuPercent)
# Jobs it made for runner processes that were already in another job (a session runner's logon task puts it in one):
# each nests under that one with the same limits. shortcut: such a job is capped on its own, not inside the shared
# cap; fine for one session runner, revisit if most runners end up there.
$own = New-Object System.Collections.Generic.List[IntPtr]
$own.Add($job)
$priorityOnly = @{}
$lastStart = @{}
Write-Host "Holding every CI runner on this PC at below-normal priority, all of them together under $CpuPercent% of its $cores cores."

for (;;) {
  if ($AgentPid -and -not (Get-Process -Id $AgentPid -ErrorAction SilentlyContinue)) { exit 0 }
  try {
    $procs = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, Name, CreationDate FROM Win32_Process')
    $kids = @{}
    foreach ($p in $procs) {
      $key = [int]$p.ParentProcessId
      if (-not $kids.ContainsKey($key)) { $kids[$key] = New-Object System.Collections.Generic.List[object] }
      $kids[$key].Add($p)
    }
    $walk = New-Object System.Collections.Generic.Stack[object]
    foreach ($p in $procs) { if ($p.Name -eq 'RunnerService.exe' -or $p.Name -eq 'Runner.Listener.exe') { $walk.Push($p) } }
    $tree = @{}
    while ($walk.Count) {
      $p = $walk.Pop()
      if ($tree.ContainsKey([int]$p.ProcessId)) { continue }
      $tree[[int]$p.ProcessId] = $p
      if (-not $kids.ContainsKey([int]$p.ProcessId)) { continue }
      # A child started before its parent is one whose parent's pid was used again: not the runner's.
      foreach ($c in $kids[[int]$p.ProcessId]) { if ($c.CreationDate -ge $p.CreationDate) { $walk.Push($c) } }
    }
    $held = 0
    foreach ($id in $tree.Keys) {
      if ($priorityOnly.ContainsKey($id)) { continue }
      $inside = $false
      foreach ($j in $own) { if ([CitadelCiJob]::InJob($j, $id)) { $inside = $true; break } }
      if ($inside) { continue }
      $err = [CitadelCiJob]::Assign($job, $id)
      if ($err -eq 5) {
        $nested = [CitadelCiJob]::Create([NullString]::Value, $CpuPercent)
        $err = [CitadelCiJob]::Assign($nested, $id)
        if ($err -eq 0) { $own.Add($nested); Write-Host "$($tree[$id].Name) ($id) was in another job already: it has a job of its own, nested in that one, with the same limits." }
      }
      if ($err -eq 0) { $held++; continue }
      # It ended meanwhile (87), or can't be put in any job: lower it alone, once.
      $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
      if (-not $proc) { continue }
      try {
        if ('Normal', 'AboveNormal', 'High' -contains [string]$proc.PriorityClass) { $proc.PriorityClass = 'BelowNormal' }
        Write-Host "$($tree[$id].Name) ($id) couldn't join a job (Win32 error $err): set to below-normal priority alone, without the cap."
      } catch {
        Write-Host "$($tree[$id].Name) ($id) couldn't join a job (Win32 error $err) or be lowered: $($_.Exception.Message)"
      }
      $priorityOnly[$id] = $true
    }
    if ($held) { Write-Host "Held $held more runner process(es)." }
    foreach ($id in @($priorityOnly.Keys)) { if (-not $tree.ContainsKey($id)) { $priorityOnly.Remove($id) } }

    $now = Get-Date
    foreach ($s in @(Get-CimInstance -ClassName Win32_Service -Filter "Name LIKE 'actions.runner.%' AND StartMode = 'Auto' AND State = 'Stopped'")) {
      if ($lastStart.ContainsKey($s.Name) -and ($now - $lastStart[$s.Name]).TotalMinutes -lt 5) { continue }
      $lastStart[$s.Name] = $now
      try {
        Start-Service -Name $s.Name
        Write-Host "Started $($s.Name): it is set to start automatically but was stopped."
      } catch {
        Write-Host "Couldn't start $($s.Name): $($_.Exception.Message)"
      }
    }
  } catch {
    Write-Host "A pass failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $EverySeconds
}
