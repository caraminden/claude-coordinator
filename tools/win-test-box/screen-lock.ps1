# The test box's screen lock (#369), for its GitHub desktop runners. One file, C:\citadel-box\screen.lock,
# names whoever has the box's one screen: a CI desktop job, or a minion's task or screenshot through
# Citadel's machine agent (public/machine-agent.mjs, tryScreenLock and screenTurn, which keep the same rules), so no
# two of them put windows on it at once.
#   -Install   adds the job hooks to every desktop runner here (C:\actions-runner-*-desktop\.env);
#              run it after adding a scheme's desktop runner, then restart the box so they read it.
#   -Take      the job-started hook: waits for the screen (up to 40 minutes), then takes it for the
#              job's Runner.Worker process.
#   -Release   the job-completed hook: lets it go if that job still holds it.
# A holder whose process is gone, a lock over 2 hours old, or an unreadable one over a minute old is
# broken and taken over.
# The screen's one line (#1422): whoever wants the screen first puts a file in C:\citadel-box\screen-line named
# by when it arrived, and touches it every few seconds while it waits; only the first live one takes the lock,
# so CI jobs and minions are served in arrival order. A waiter whose process is gone or whose file is a minute
# old is dropped by whoever reads the line next (screenLine in machine-agent.mjs does the same).
# Works in Windows PowerShell 5.1 and PowerShell 7, whichever the runner picks.
param([switch]$Install, [switch]$Take, [switch]$Release)
$ErrorActionPreference = 'Stop'
$box = 'C:\citadel-box'
$lock = "$box\screen.lock"
$line = "$box\screen-line"
$staleMs = 2 * 60 * 60 * 1000
$lineStaleMs = 60 * 1000
$utf8 = New-Object Text.UTF8Encoding($false)
$now = { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

if ($Install) {
  $hooks = @{ 'job-started.ps1' = '-Take'; 'job-completed.ps1' = '-Release' }
  foreach ($h in $hooks.Keys) {
    # The runner runs a hook script with no arguments, so each mode gets a file of its own.
    Set-Content -Path "$box\$h" -Encoding ASCII -Value "& '$box\screen-lock.ps1' $($hooks[$h]); exit `$LASTEXITCODE"
  }
  $found = @(Get-ChildItem C:\ -Directory -Filter 'actions-runner-*-desktop')
  if (-not $found) { Write-Host "No desktop runner here yet (C:\actions-runner-*-desktop). Add the scheme's desktop runner, then run this again."; exit 0 }
  foreach ($d in $found) {
    $envFile = Join-Path $d.FullName '.env'
    $lines = @(if (Test-Path $envFile) { Get-Content $envFile | Where-Object { $_ -notmatch '^ACTIONS_RUNNER_HOOK_JOB_(STARTED|COMPLETED)=' } })
    $lines += "ACTIONS_RUNNER_HOOK_JOB_STARTED=$box\job-started.ps1", "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$box\job-completed.ps1"
    Set-Content -Path $envFile -Value $lines -Encoding ASCII
    Write-Host "  $($d.Name): hooks added"
  }
  Write-Host 'Restart the box (Restart-Computer) so the runners read them.'
  exit 0
}

# The job's Runner.Worker: alive for the whole job, gone once it ends, so a crashed job frees the screen.
function Get-Worker {
  $p = $PID
  for ($i = 0; $i -lt 10 -and $p; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
    if (-not $proc) { break }
    if ($proc.Name -eq 'Runner.Worker.exe') { return [int]$proc.ProcessId }
    $p = $proc.ParentProcessId
  }
  return $null
}
$worker = Get-Worker
$who = "GitHub Actions ($env:GITHUB_REPOSITORY)"
$what = "desktop CI job $env:GITHUB_JOB, run $env:GITHUB_RUN_ID"

function Read-Lock {
  try { return Get-Content $lock -Raw | ConvertFrom-Json } catch { return $null }
}

if ($Release) {
  $held = Read-Lock
  if ($held -and $worker -and $held.pid -eq $worker) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Write-Host 'Screen lock released.' }
  exit 0
}

function Read-Json($path) {
  try { return [IO.File]::ReadAllText($path) | ConvertFrom-Json } catch { return $null }
}

# The live waiters, in arrival order (an ordinal sort of their names, as JavaScript sorts them); dead ones are dropped.
function Get-Line {
  $names = [string[]]@(Get-ChildItem $line -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  [Array]::Sort($names, [StringComparer]::Ordinal)
  $out = @()
  foreach ($n in $names) {
    $f = Get-Item (Join-Path $line $n) -ErrorAction SilentlyContinue
    if (-not $f) { continue }
    $fresh = ((Get-Date) - $f.LastWriteTime).TotalMilliseconds -le $lineStaleMs
    $w = Read-Json $f.FullName
    if ($w -and $w.pid -is [ValueType] -and (Get-Process -Id $w.pid -ErrorAction SilentlyContinue) -and $fresh) { $out += $w }
    elseif ($w -or -not $fresh) { Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue }  # an unreadable fresh one may be mid-write
  }
  return ,$out
}

# Takes the lock for this job if it is free or broken (or, $late, whoever has it); false while someone else has it.
function Take-Lock([bool]$late) {
  for ($i = 0; $i -lt 3; $i++) {
    try {
      $f = [IO.File]::Open($lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
      try {
        # Its since is when it took the screen, so a long wait in line doesn't count toward the 2 hours.
        $taken = [ordered]@{ pid = $worker; what = $what; who = $who; since = (& $now); token = $token } | ConvertTo-Json -Compress
        $bytes = $utf8.GetBytes($taken)
        $f.Write($bytes, 0, $bytes.Length)
      } finally { $f.Dispose() }
      return $true
    } catch {
      # Someone else's lock is there (ERROR_FILE_EXISTS, 0x80070050), or was a moment ago: its holder may
      # have let go since, which the read below sees. Anything else (no folder, no access) is a real failure.
      $fileExists = $_.Exception.GetBaseException().HResult -eq -2147024816
      if (-not $fileExists -and -not (Test-Path $lock)) { throw }
    }
    $raw = Get-Content $lock -Raw -ErrorAction SilentlyContinue
    if ($null -eq $raw -and -not (Test-Path $lock)) { continue }  # let go of since we tried
    $held = Read-Lock
    $stale = if ($held -and $held.pid -is [ValueType] -and $held.since) {
      -not (Get-Process -Id $held.pid -ErrorAction SilentlyContinue) -or ((& $now) - $held.since) -gt $staleMs
    } else {
      $item = Get-Item $lock -ErrorAction SilentlyContinue
      $item -and ((Get-Date) - $item.LastWriteTime).TotalSeconds -gt 60
    }
    if (-not $stale -and $late) {
      # Past every minion job's 30-minute limit: whatever holds it is stuck, so the job goes ahead.
      Write-Host "::warning::The screen was still held after 40 minutes ($($held.what) for $($held.who)); taking it."
      $stale = $true
    }
    if (-not $stale) { return $false }
    # Only the lock we judged: another taker may have broken it and taken it since.
    if ((Get-Content $lock -Raw -ErrorAction SilentlyContinue) -eq $raw) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
  }
  return $false
}

if ($Take) {
  if (-not $worker) { Write-Host '::warning::screen-lock.ps1 found no Runner.Worker above it, so this job runs without the screen lock.'; exit 0 }
  $since = & $now
  $token = "ci-$worker"
  $mine = [ordered]@{ pid = $worker; what = $what; who = $who; since = $since; token = $token } | ConvertTo-Json -Compress
  New-Item -ItemType Directory -Force -Path $line | Out-Null
  $place = Join-Path $line ('{0:D15}-{1}.json' -f $since, $token)
  [IO.File]::WriteAllText($place, $mine, $utf8)
  $deadline = (Get-Date).AddMinutes(40)
  $told = ''
  try {
    while ($true) {
      # Touch its place so the others see it is alive; put it back if it was dropped while this was slow.
      try { if (Test-Path $place) { (Get-Item $place).LastWriteTime = Get-Date } else { [IO.File]::WriteAllText($place, $mine, $utf8) } } catch {}
      $waiters = Get-Line
      $ahead = 0
      foreach ($w in $waiters) { if ($w.token -eq $token) { break }; $ahead++ }
      $late = (Get-Date) -gt $deadline
      if (($ahead -eq 0 -or $late) -and (Take-Lock $late)) { Write-Host 'Took the screen lock.'; exit 0 }
      $held = Read-Lock
      $has = if ($held) { "$($held.what) for $($held.who) has it" } else { 'nobody has it this moment' }
      $msg = "Waiting for the screen: $has; $(if ($ahead) { "$ahead ahead of this job" } else { 'this job is next' }), $($waiters.Count) in line."
      if ($msg -ne $told) { Write-Host $msg; $told = $msg }
      Start-Sleep -Seconds 2
    }
  } finally {
    # Taken, failed or cancelled: it leaves the line either way.
    Remove-Item $place -Force -ErrorAction SilentlyContinue
  }
}

Write-Host 'Pass -Install, -Take or -Release.'
exit 2
