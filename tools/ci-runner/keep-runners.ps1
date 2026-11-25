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
    3. in the first 30 minutes after the PC starts, starts any runner service that is set to start automatically but
       is stopped (the BIOS reboot of 2026-11-11 left them all stopped), at most once every 5 minutes each. After
       that a stopped runner stays stopped: someone stopped it, or a removal is under way.
  Ships go first (#1268; Cara, 2026-11-20, "Plan approved: build it this way"): each runner also has a slot of its
  own, a job nested in the shared one. Citadel tells the agent which runners are on a ship run (a land/ branch, any
  scheme's), and the agent writes them to ships.json beside this script with an expiry 2 minutes on. While it names
  any, every other runner's slot is held to -SqueezePercent of the whole PC, shared among those running a job; the
  ship runners keep the shared cap alone. It reads the file every 2 seconds; one that names none, or has expired
  (Citadel stopped saying so), gives every slot its normal share back.
  It holds the jobs open for as long as it runs, and ends when the agent (-AgentPid) does. It never stops, removes or
  re-registers a runner, and never restarts the PC.

  -Prove checks the mechanism on this PC instead, and touches no runner: it makes a job capped at 50% with two slots
  nested in it, one squeezed to 10% of the PC, and starts one CPU-burning process per core in each. It reports
  whether every burner is in its slot and at below-normal priority, what share of the PC each slot and the whole job
  used, and what the squeezed slot gets once its squeeze lifts. Where Git Bash is installed, it also starts a ping
  through bash in the squeezed slot and checks the ping stays there. It exits 0 when all of that holds.

.PARAMETER GitBin
  With -Prove: the folder holding Git Bash's bash.exe, as the installer was given it.

.PARAMETER CpuPercent
  The share of the whole PC (every core) all CI together may use, 1 to 100.

.PARAMETER SqueezePercent
  The share of the whole PC every runner not on a ship may use together while a ship runs, 1 to 100.

.PARAMETER CitadelSqueezePercent
  The same share while one of the ships is Citadel's own (marked first in ships.json), 1 to 100.

.PARAMETER AgentPid
  The runner agent's process id: this script ends when that process does.

.EXAMPLE
  .\keep-runners.ps1 -Prove
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 100)][int]$CpuPercent = 75,
  [ValidateRange(1, 100)][int]$SqueezePercent = 30,
  [ValidateRange(1, 100)][int]$CitadelSqueezePercent = 10,
  [int]$AgentPid = 0,
  [ValidateRange(5, 300)][int]$EverySeconds = 15,
  [string]$GitBin = 'C:\Program Files\Git\bin',
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
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);

  const uint LIMIT_PRIORITY_CLASS = 0x20, BELOW_NORMAL = 0x4000;
  const uint RATE_ENABLE = 0x1, RATE_HARD_CAP = 0x4;
  const uint SET_QUOTA = 0x100, TERMINATE = 0x1, QUERY_LIMITED = 0x1000;

  // A job that runs everything in it at below-normal priority, all of it together held to percent of every core.
  // Breakaway is not allowed: Git Bash asks for it whenever a job allows it, so every cargo a bash step started got out
  // (#1268, proven on the test box 2026-11-21); refused, it starts them in the job. A tool that demands it fails to start.
  // A name already taken opens that job and sets these limits on it again (a restarted script gets its jobs back);
  // percent 0 sets no cap.
  public static IntPtr Create(string name, int percent) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
    if (job == IntPtr.Zero) throw new Win32Exception();
    ExtendedLimit limit = new ExtendedLimit();
    limit.Basic.LimitFlags = LIMIT_PRIORITY_CLASS;
    limit.Basic.PriorityClass = BELOW_NORMAL;
    if (!SetInformationJobObject(job, 9, ref limit, Marshal.SizeOf(limit))) throw new Win32Exception();
    if (percent > 0) SetRate(job, percent * 100);
    return job;
  }

  // A hard cap in hundredths of a percent, 0 for none. In a job nested under a capped one it is a share of that one's
  // cap, not of the PC (Windows: rates are relative to the nearest parent with one).
  public static void SetRate(IntPtr job, int hundredths) {
    CpuRate rate = new CpuRate();
    if (hundredths > 0) { rate.ControlFlags = RATE_ENABLE | RATE_HARD_CAP; rate.Rate = (uint)Math.Min(10000, hundredths); }
    if (!SetInformationJobObject(job, 15, ref rate, Marshal.SizeOf(rate))) throw new Win32Exception();
  }

  // 0 when the process is in the job now; -1 when it can't be opened (it ended, or is protected); -2 when its pid now
  // belongs to a process other than the one started at `created` (a FILETIME, UTC; 0 skips the check); else the Win32
  // error of the assignment (5: it is in another job this one can't nest under).
  public static int Assign(IntPtr job, int pid, long created) {
    IntPtr p = OpenProcess(SET_QUOTA | TERMINATE | QUERY_LIMITED, false, pid);
    if (p == IntPtr.Zero) return -1;
    try {
      long start, end, kernel, user;
      if (created != 0 && (!GetProcessTimes(p, out start, out end, out kernel, out user) || Math.Abs(start - created) > 10000)) return -2;
      return AssignProcessToJobObject(job, p) ? 0 : Marshal.GetLastWin32Error();
    } finally { CloseHandle(p); }
  }

  public static void Close(IntPtr job) { CloseHandle(job); }

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
  $cap = 50
  $squeezed = 10
  $job = [CitadelCiJob]::Create([NullString]::Value, $cap)
  # Two slots, as the sweep makes them: each burner's parent goes into the shared job first, then into its slot, which
  # nests the slot there; the burners must get into both by inheritance.
  $slots = [ordered]@{ ship = [CitadelCiJob]::Create([NullString]::Value, 0); squeezed = [CitadelCiJob]::Create([NullString]::Value, 0) }
  [CitadelCiJob]::SetRate($slots.squeezed, [int]($squeezed / $cap * 10000))
  # Each parent waits before starting its children, so it is in its slot first. Each child is cmd spinning in an
  # endless loop, one core's worth, like one compiler of a parallel build.
  $burn = "Start-Sleep -Seconds 3; 1..$cores | ForEach-Object { Start-Process -FilePath `$env:ComSpec -ArgumentList '/c for /l %i in (0,0,1) do @rem' -WindowStyle Hidden }; Start-Sleep -Seconds 60"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($burn))
  $parents = @{}
  $used = @{}
  # Git Bash asks to break away whenever a job allows it (a bash step's cargo got out that way, #1268): a native program
  # it starts in the squeezed slot must stay there.
  $gitBash = Join-Path $GitBin 'bash.exe'
  $bashHeld = $null; $pings = @()
  try {
    if (Test-Path -LiteralPath $gitBash) {
      $bashParent = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList '-NoProfile', '-EncodedCommand', ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("Start-Sleep -Seconds 3; & '$gitBash' -c 'ping -n 30 127.0.0.1 >/dev/null'"))) -WindowStyle Hidden -PassThru
      foreach ($into in $job, $slots.squeezed) {
        $err = [CitadelCiJob]::Assign($into, $bashParent.Id, 0)
        if ($err) { throw "Couldn't put the test's Git Bash parent process in its job (Win32 error $err)." }
      }
    }
    foreach ($name in $slots.Keys) {
      $parents[$name] = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList '-NoProfile', '-EncodedCommand', $encoded -WindowStyle Hidden -PassThru
      foreach ($into in $job, $slots[$name]) {
        $err = [CitadelCiJob]::Assign($into, $parents[$name].Id, 0)
        if ($err) { throw "Couldn't put the test's $name parent process in its job (Win32 error $err)." }
      }
    }
    Start-Sleep -Seconds 10
    $kids = @{}
    foreach ($name in $slots.Keys) { $kids[$name] = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $($parents[$name].Id)" | Where-Object { $_.Name -eq 'cmd.exe' }) }
    $all = @($kids.ship) + @($kids.squeezed)
    $inJob = @($slots.Keys | ForEach-Object { $slot = $slots[$_]; $kids[$_] | Where-Object { [CitadelCiJob]::InJob($slot, [int]$_.ProcessId) -and [CitadelCiJob]::InJob($job, [int]$_.ProcessId) } }).Count
    $below = @($all | Where-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).PriorityClass -eq 'BelowNormal' }).Count
    if (Test-Path -LiteralPath $gitBash) {
      # bash may be slow to start on a busy PC: look for its ping for up to 15 seconds more.
      for ($wait = 0; $pings.Count -eq 0 -and $wait -le 15; $wait++) {
        if ($wait) { Start-Sleep -Seconds 1 }
        $every = @(Get-CimInstance -ClassName Win32_Process)
        $under = @($bashParent.Id)
        for ($i = 0; $i -lt $under.Count; $i++) { foreach ($c in $every | Where-Object { $_.ParentProcessId -eq $under[$i] }) { $under += [int]$c.ProcessId; if ($c.Name -eq 'PING.EXE') { $pings += $c } } }
      }
      $bashHeld = $pings.Count -gt 0 -and @($pings | Where-Object { [CitadelCiJob]::InJob($slots.squeezed, [int]$_.ProcessId) }).Count -eq $pings.Count
    }
    # The share of the whole PC each job used over 10 seconds.
    $measure = {
      $before = @{ job = [CitadelCiJob]::CpuSeconds($job) }
      foreach ($name in $slots.Keys) { $before[$name] = [CitadelCiJob]::CpuSeconds($slots[$name]) }
      $clock = [Diagnostics.Stopwatch]::StartNew()
      Start-Sleep -Seconds 10
      $out = @{ job = ([CitadelCiJob]::CpuSeconds($job) - $before.job) / ($clock.Elapsed.TotalSeconds * $cores) * 100 }
      foreach ($name in $slots.Keys) { $out[$name] = ([CitadelCiJob]::CpuSeconds($slots[$name]) - $before[$name]) / ($clock.Elapsed.TotalSeconds * $cores) * 100 }
      $out
    }
    $used = & $measure
    [CitadelCiJob]::SetRate($slots.squeezed, 0)
    Start-Sleep -Seconds 2
    $lifted = & $measure
  } finally {
    [CitadelCiJob]::Kill($job)  # a ping that got out isn't killed with it, and ends by itself within 30 seconds
  }
  $held = $kids.ship.Count -gt 0 -and $kids.squeezed.Count -gt 0 -and $inJob -eq $all.Count -and $below -eq $all.Count -and $used.job -le $cap + 5 -and
    $used.squeezed -le $squeezed + 3 -and $used.ship -ge $cap - $squeezed - 10 -and $lifted.squeezed -ge $squeezed + 10 -and $lifted.job -le $cap + 5 -and $bashHeld -ne $false
  Write-Host ("{0} of {1} burners started, {2} in the job and their slot, {3} at below-normal priority." -f $all.Count, (2 * $cores), $inJob, $below)
  Write-Host ("Squeezed: the job used {0:N1}% of the PC's {1} cores against a cap of {2}%; the ship's slot {3:N1}%, the squeezed one {4:N1}% against {5}%." -f $used.job, $cores, $cap, $used.ship, $used.squeezed, $squeezed)
  Write-Host ("Lifted: the job used {0:N1}%; the ship's slot {1:N1}%, the other {2:N1}% (it should get well over {3}% now)." -f $lifted.job, $lifted.ship, $lifted.squeezed, $squeezed)
  Write-Host $(if ($null -eq $bashHeld) { 'Git Bash: not installed here, not checked.' } elseif ($bashHeld) { 'Git Bash: the program it started stayed in its slot.' } elseif ($pings.Count) { 'Git Bash: the program it started is NOT in its slot (it broke away).' } else { "Git Bash: the ping it should have started never appeared (is $gitBash working?)." })
  Write-Host $(if ($held) { 'Held: the cap, the priority and the squeeze reach processes started inside the slots, and the squeeze lifts.' } else { 'NOT held: the lines above say which part failed.' })
  exit $(if ($held) { 0 } else { 1 })
}

$job = [CitadelCiJob]::Create('Global\CitadelCiRunners', $CpuPercent)
# Jobs it made for runner processes that were already in another job and couldn't join their slot either: each nests
# under that one with the same limits, and is never squeezed. shortcut: such a job is capped on its own, not inside
# the shared cap; fine for one session runner, revisit if most runners end up there.
$own = New-Object System.Collections.Generic.List[IntPtr]
$own.Add($job)
# Each runner's slot by its folder: @{ Key = "repo|name"; Job; Rate; Busy; Inside }.
$slots = @{}
$identity = @{}
# Runner processes left out of their slot (held by the shared job alone, a job of their own, or priority only), by pid.
$settled = @{}
$lastStart = @{}
$shipsFile = Join-Path $PSScriptRoot 'ships.json'
$ships = @()
$firstShip = $false
$said = ''
Write-Host "Holding every CI runner on this PC at below-normal priority, all of them together under $CpuPercent% of its $cores cores; while a ship runs, every other runner under $SqueezePercent% together ($CitadelSqueezePercent% while one is Citadel's)."

# A runner folder's "repo|name" from the .runner file its setup wrote, as Citadel names a ship's runner; null until it reads.
function Get-RunnerKey([string]$dir) {
  if ($identity.ContainsKey($dir)) { return $identity[$dir] }
  try {
    $conf = (Get-Content -LiteralPath (Join-Path $dir '.runner') -Raw -ErrorAction Stop).TrimStart([char]0xFEFF) | ConvertFrom-Json
    $key = '{0}|{1}' -f ([string]$conf.gitHubUrl -replace '^https://github\.com/', '').ToLowerInvariant(), ([string]$conf.agentName).ToLowerInvariant()
    $identity[$dir] = $key
    return $key
  } catch { return $null }
}

# The runners on a ship run now, as "repo|name"; none when the file names none or Citadel hasn't renewed it in time.
function Read-Ship {
  try {
    $file = Get-Content -LiteralPath $shipsFile -Raw -ErrorAction Stop | ConvertFrom-Json
    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$file.until) { return @() }
    $script:firstShip = @(@($file.ships) | Where-Object { $_.PSObject.Properties['first'] -and $_.first -eq $true }).Count -gt 0
    return @(@($file.ships) | ForEach-Object { ('{0}|{1}' -f ([string]$_.repo).ToLowerInvariant(), ([string]$_.runner).ToLowerInvariant()) } | Sort-Object -Unique)
  } catch { return @() }
}

# Each slot's cap for the ships named now: none (the shared cap alone) normally; while a ship runs, every other slot
# held so that together the busy ones use about -SqueezePercent of the PC. A slot outside the shared job (nested in
# another) gets its share of the PC itself.
function Set-SlotRate {
  # A function's one-item or empty list comes back as a lone string or nothing, which has no .Count under strict mode.
  $ships = @($ships | Where-Object { $_ })
  $others = @($slots.Values | Where-Object { $ships -notcontains $_.Key })
  $busy = [math]::Max(1, @($others | Where-Object { $_.Busy }).Count)
  $squeeze = if ($script:firstShip) { $CitadelSqueezePercent } else { $SqueezePercent }
  $share = $squeeze / $busy
  foreach ($slot in $slots.Values) {
    $rate = if ($ships.Count -and $ships -notcontains $slot.Key) { if ($slot.Inside) { $share / $CpuPercent * 10000 } else { $share * 100 } } elseif ($slot.Inside) { 0 } else { $CpuPercent * 100 }
    $rate = [int][math]::Max([math]::Min($rate, 10000), [math]::Sign($rate))
    if ($rate -eq $slot.Rate) { continue }
    try { [CitadelCiJob]::SetRate($slot.Job, $rate); $slot.Rate = $rate } catch { Write-Host "Couldn't set $($slot.Key)'s share: $($_.Exception.Message)" }
  }
  $now = if ($ships.Count) { "A ship runs on $($ships -join ', '): the $($others.Count) other runner(s) here held to $squeeze% of the PC together, about $([math]::Round($share, 1))% each of the $busy running a job." } else { 'No ship runs: every runner has its normal share again.' }
  if ($now -ne $script:said -and ($ships.Count -or $script:said)) { Write-Host $now }
  $script:said = $now
}

for (;;) {
  if ($AgentPid -and -not (Get-Process -Id $AgentPid -ErrorAction SilentlyContinue)) { exit 0 }
  try {
    $procs = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, Name, CreationDate, ExecutablePath FROM Win32_Process')
    $kids = @{}
    foreach ($p in $procs) {
      $key = [int]$p.ParentProcessId
      if (-not $kids.ContainsKey($key)) { $kids[$key] = New-Object System.Collections.Generic.List[object] }
      $kids[$key].Add($p)
    }
    # Every runner's tree, each process with the folder of the runner it came from ('' when that can't be read).
    $walk = New-Object System.Collections.Generic.Stack[object]
    foreach ($p in $procs) {
      if ($p.Name -ne 'RunnerService.exe' -and $p.Name -ne 'Runner.Listener.exe') { continue }
      $dir = if ([string]$p.ExecutablePath -match '^(.*)\\bin\\[^\\]+$') { $Matches[1] } else { '' }
      $walk.Push(@($p, $dir))
    }
    $tree = @{}
    $dirOf = @{}
    while ($walk.Count) {
      $p, $dir = $walk.Pop()
      if ($tree.ContainsKey([int]$p.ProcessId)) { continue }
      $tree[[int]$p.ProcessId] = $p
      $dirOf[[int]$p.ProcessId] = $dir
      if (-not $kids.ContainsKey([int]$p.ProcessId)) { continue }
      # A child started before its parent is one whose parent's pid was used again: not the runner's.
      foreach ($c in $kids[[int]$p.ProcessId]) { if ($c.CreationDate -ge $p.CreationDate) { $walk.Push(@($c, $dir)) } }
    }
    # Slots for the runners there now, opened by name so a restarted script gets the same ones; a gone runner's closes.
    $seen = @{}
    foreach ($id in $tree.Keys) {
      $dir = $dirOf[$id]
      $key = if ($dir) { Get-RunnerKey $dir } else { $null }
      if (-not $key) { continue }
      if (-not $slots.ContainsKey($dir)) {
        $slots[$dir] = @{ Key = $key; Job = [CitadelCiJob]::Create('Global\CitadelCiRunner-' + ($dir -replace '[^A-Za-z0-9]', '_'), 0); Rate = -1; Busy = $false; Inside = $true }
      }
      if (-not $seen.ContainsKey($dir)) { $seen[$dir] = $false }
      if ($tree[$id].Name -eq 'Runner.Worker.exe') { $seen[$dir] = $true }
    }
    foreach ($dir in @($slots.Keys)) { if (-not $seen.ContainsKey($dir)) { [CitadelCiJob]::Close($slots[$dir].Job); $slots.Remove($dir) } }

    $held = 0
    foreach ($id in $tree.Keys) {
      if ($settled.ContainsKey($id)) { continue }
      $slot = if ($slots.ContainsKey($dirOf[$id])) { $slots[$dirOf[$id]] } else { $null }
      if ($slot) {
        if ([CitadelCiJob]::InJob($slot.Job, $id)) { continue }
      } else {
        $inside = $false
        foreach ($j in $own) { if ([CitadelCiJob]::InJob($j, $id)) { $inside = $true; break } }
        if ($inside) { continue }
      }
      # Its start as the snapshot saw it, so a pid used again since is never taken for the runner's (1 ms: WMI keeps microseconds).
      $created = $tree[$id].CreationDate.ToFileTimeUtc()
      # The shared job first, then the slot: a slot's first process nests it in the shared job.
      $err = if ([CitadelCiJob]::InJob($job, $id)) { 0 } else { [CitadelCiJob]::Assign($job, $id, $created) }
      if ($err -eq 0 -and $slot) {
        $err = [CitadelCiJob]::Assign($slot.Job, $id, $created)
        if ($err -eq 0) { $held++ } elseif ($err -ne -1 -and $err -ne -2) { $settled[$id] = $true; Write-Host "$($tree[$id].Name) ($id) is under the shared cap but couldn't join its runner's slot (Win32 error $err), so a ship won't squeeze it." }
        continue
      }
      # In another job: its slot can nest there instead, if nothing is in the slot yet.
      if ($err -eq 5 -and $slot) {
        $err = [CitadelCiJob]::Assign($slot.Job, $id, $created)
        if ($err -eq 0) { $held++; continue }
      }
      if ($err -eq 5) {
        $nested = [CitadelCiJob]::Create([NullString]::Value, $CpuPercent)
        $err = [CitadelCiJob]::Assign($nested, $id, $created)
        if ($err -ne 0) { [CitadelCiJob]::Close($nested) }
        if ($err -eq 0) { $own.Add($nested); $settled[$id] = $true; Write-Host "$($tree[$id].Name) ($id) was in another job already: it has a job of its own, nested in that one, with the same limits." }
      }
      if ($err -eq 0) { $held++; continue }
      # Ended, or its pid is someone else's now: nothing of the runner's to hold.
      if ($err -eq -2) { continue }
      # It can't be opened or put in any job: lower it alone, once, if it is still the same process.
      $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
      if (-not $proc) { continue }
      # A start it can't read can't be checked: leave that process alone.
      $started = try { $proc.StartTime } catch { $null }
      if ($null -eq $started -or [math]::Abs(($started - $tree[$id].CreationDate).TotalMilliseconds) -gt 1) { continue }
      try {
        if ('Normal', 'AboveNormal', 'High' -contains [string]$proc.PriorityClass) { $proc.PriorityClass = 'BelowNormal' }
        Write-Host "$($tree[$id].Name) ($id) couldn't join a job (Win32 error $err): set to below-normal priority alone, without the cap."
      } catch {
        Write-Host "$($tree[$id].Name) ($id) couldn't join a job (Win32 error $err) or be lowered: $($_.Exception.Message)"
      }
      $settled[$id] = $true
    }
    if ($held) { Write-Host "Held $held more runner process(es)." }
    foreach ($id in @($settled.Keys)) { if (-not $tree.ContainsKey($id)) { $settled.Remove($id) } }
    # Whether each slot runs a job now, and hangs under the shared job (its cap is then a share of that one's): an
    # empty slot will when its first process joins.
    foreach ($dir in $slots.Keys) {
      $slot = $slots[$dir]
      $member = @($tree.Keys | Where-Object { $dirOf[$_] -eq $dir -and [CitadelCiJob]::InJob($slot.Job, $_) } | Select-Object -First 1)
      $slot.Inside = -not $member.Count -or [CitadelCiJob]::InJob($job, $member[0])
      $slot.Busy = $seen[$dir]
    }
    $ships = @(Read-Ship)
    Set-SlotRate

    $now = Get-Date
    # Only just after a boot: a runner stopped later was stopped by someone, or by a removal under way.
    $boot = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime
    if (($now - $boot).TotalMinutes -lt 30) {
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
    }
  } catch {
    Write-Host "A pass failed: $($_.Exception.Message)"
  }
  # A ship starting or ending shows within 2 seconds, between the sweeps.
  $next = (Get-Date).AddSeconds($EverySeconds)
  do {
    Start-Sleep -Seconds 2
    $fresh = @(Read-Ship)
    if (($fresh -join ',') -ne ($ships -join ',')) {
      $ships = $fresh
      try { Set-SlotRate } catch { Write-Host "Couldn't change the shares: $($_.Exception.Message)" }
    }
  } while ((Get-Date) -lt $next)
}
