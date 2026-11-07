# The test box's screen lock (#369), for its GitHub desktop runners. One file, C:\citadel-box\screen.lock,
# names whoever has the box's one screen: a CI desktop job, or a minion's task or screenshot through
# Citadel's machine agent (public/machine-agent.mjs, takeScreenLock, which keeps the same rules), so no
# two of them put windows on it at once.
#   -Install   adds the job hooks to every desktop runner here (C:\actions-runner-*-desktop\.env);
#              run it after adding a scheme's desktop runner, then restart the box so they read it.
#   -Take      the job-started hook: waits for the screen (up to 40 minutes), then takes it for the
#              job's Runner.Worker process.
#   -Release   the job-completed hook: lets it go if that job still holds it.
# A holder whose process is gone, a lock over 2 hours old, or an unreadable one over a minute old is
# broken and taken over. Works in Windows PowerShell 5.1 and PowerShell 7, whichever the runner picks.
param([switch]$Install, [switch]$Take, [switch]$Release)
$ErrorActionPreference = 'Stop'
$box = 'C:\citadel-box'
$lock = "$box\screen.lock"
$staleMs = 2 * 60 * 60 * 1000
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

if ($Take) {
  if (-not $worker) { Write-Host '::warning::screen-lock.ps1 found no Runner.Worker above it, so this job runs without the screen lock.'; exit 0 }
  $mine = [ordered]@{ pid = $worker; what = $what; who = $who; since = (& $now); token = "ci-$worker" } | ConvertTo-Json -Compress
  $deadline = (Get-Date).AddMinutes(40)
  $told = $false
  while ($true) {
    try {
      $f = [IO.File]::Open($lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
      try {
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($mine)
        $f.Write($bytes, 0, $bytes.Length)
      } finally { $f.Dispose() }
      Write-Host 'Took the screen lock.'
      exit 0
    } catch {
      # Someone else's lock is there; anything else (no folder, no access) is a real failure.
      if (-not (Test-Path $lock)) { throw }
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
    if (-not $stale -and (Get-Date) -gt $deadline) {
      # Past every minion job's 30-minute limit: whatever holds it is stuck, so the job goes ahead.
      Write-Host "::warning::The screen was still held after 40 minutes ($($held.what) for $($held.who)); taking it."
      $stale = $true
    }
    if ($stale) {
      # Only the lock we judged: another taker may have broken it and taken it since.
      if ((Get-Content $lock -Raw -ErrorAction SilentlyContinue) -eq $raw) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
      continue
    }
    if (-not $told) { Write-Host "Waiting for the screen: $($held.what) for $($held.who) has it."; $told = $true }
    Start-Sleep -Seconds 5
  }
}

Write-Host 'Pass -Install, -Take or -Release.'
exit 2
