<#
  Pulls Citadel's nightly off-box backups from perigee onto this Windows desktop (#252).
  Task Scheduler runs it each morning; setup and restore steps are in deploy/desktop/README.md.

  It asks perigee for its list (SHA256SUMS), downloads each file it doesn't have yet through the
  backup key (which can only list and fetch, see deploy/offbox-serve.sh), checks every download
  against its checksum, then keeps the newest $Dailies dailies, $Weeklies weeklies and $States
  session-state copies. Contraptions' own nightly backups (#828) land in apps\<app>\<day>\, and each
  app keeps its newest $Dailies days. A run that can't reach perigee prunes nothing. It exits 1 on any failure
  or when the newest daily is over 2 days old, so Task Scheduler's "Last Run Result" shows it.
  Works in Windows PowerShell 5.1 and PowerShell 7.
#>
param(
  [string]$Dest = (Join-Path $env:USERPROFILE 'CitadelBackups'),
  [string]$Remote = 'cara@perigee.tail59477f.ts.net',
  [string]$Key = (Join-Path $env:USERPROFILE '.ssh\citadel_backup'),
  [string]$Ssh = 'ssh',
  [int]$Dailies = 14,
  [int]$Weeklies = 8,
  [int]$States = 2
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$log = Join-Path $Dest 'pull.log'
function Log([string]$m) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"
  Add-Content -LiteralPath $log -Value $line
  Write-Output $line
}

$sshArgs = @('-i', $Key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', '-o', 'ServerAliveInterval=30', $Remote)
$daily = '^coordinator-(\d{4}-\d{2}-\d{2})\.db$'
$weekly = '^coordinator-weekly-\d{4}-W\d{2}\.db$'
$state = '^state-\d{4}-\d{2}-\d{2}\.db$'
# The same rule as offbox-serve.sh: apps/<contraption>/<day>/<file>, plain names, no `..`. Checked case-sensitively.
$app = '^apps/[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?/\d{4}-\d{2}-\d{2}/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$'

function Prune([string]$pattern, [int]$keep) {
  Get-ChildItem -LiteralPath $Dest -File | Where-Object { $_.Name -match $pattern } | Sort-Object Name -Descending |
    Select-Object -Skip $keep | ForEach-Object { Remove-Item -LiteralPath $_.FullName; Log "Pruned $($_.Name)" }
}

try {
  # Leftovers of a run that died mid-download.
  Get-ChildItem -LiteralPath $Dest -File -Recurse | Where-Object { $_.Name -like '*.part*' } | Remove-Item

  $list = & $Ssh @sshArgs list
  if ($LASTEXITCODE -ne 0) { throw "couldn't reach perigee (ssh exit $LASTEXITCODE)" }

  $got = 0; $failed = 0; $offered = 0
  foreach ($line in $list) {
    if ($line -notmatch '^([0-9a-f]{64})\s+\*?(\S+)$') { continue }
    $hash = $Matches[1]; $name = $Matches[2]
    $isApp = $name -cmatch $app -and $name -notlike '*..*'
    if ($name -notmatch $daily -and $name -notmatch $weekly -and $name -notmatch $state -and -not $isApp) { Log "Skipping unexpected name $name"; continue }
    $offered++
    $target = Join-Path $Dest ($name -replace '/', [IO.Path]::DirectorySeparatorChar)
    if ($isApp) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null }
    # Same name, other checksum: perigee re-ran its backup that day, so fetch it again.
    if ((Test-Path -LiteralPath $target) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLower() -eq $hash) { continue }
    $part = "$target.part"
    # Copy ssh's stdout stream straight to the file: PowerShell pipes and Start-Process's redirect both
    # treat it as text and change the bytes.
    $argLine = (@($sshArgs) + @('get', $name) | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Ssh; $psi.Arguments = $argLine; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $err = $p.StandardError.ReadToEndAsync()
    $fs = [System.IO.File]::Create($part)
    try { $p.StandardOutput.BaseStream.CopyTo($fs) } finally { $fs.Close() }
    $p.WaitForExit()
    $sum = (Get-FileHash -Algorithm SHA256 -LiteralPath $part).Hash.ToLower()
    if ($p.ExitCode -ne 0 -or $sum -ne $hash) {
      Log "FAILED $name (ssh exit $($p.ExitCode), checksum $(if ($sum -eq $hash) { 'ok' } else { 'mismatch' })): $($err.Result.Trim())"
      Remove-Item -LiteralPath $part
      $failed++
      continue
    }
    Move-Item -Force -LiteralPath $part -Destination $target
    $got++
    Log ("Got {0} ({1:N0} MB)" -f $name, ((Get-Item -LiteralPath $target).Length / 1MB))
  }
  if ($offered -eq 0) { throw 'perigee offered no backups' }

  Prune $daily $Dailies
  Prune $weekly $Weeklies
  Prune $state $States
  # Each app keeps its newest $Dailies days. An app gone from perigee keeps what it has here.
  $apps = Join-Path $Dest 'apps'
  if (Test-Path -LiteralPath $apps) {
    foreach ($a in Get-ChildItem -LiteralPath $apps -Directory) {
      Get-ChildItem -LiteralPath $a.FullName -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' } | Sort-Object Name -Descending |
        Select-Object -Skip $Dailies | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse; Log "Pruned apps/$($a.Name)/$($_.Name)" }
    }
  }

  $newest = Get-ChildItem -LiteralPath $Dest -File | Where-Object { $_.Name -match $daily } | Sort-Object Name -Descending | Select-Object -First 1
  $newestDay = [datetime]::ParseExact(($newest.Name -replace $daily, '$1'), 'yyyy-MM-dd', $null)
  if (((Get-Date).Date - $newestDay).TotalDays -gt 2) { Log "WARNING: the newest backup is from $($newestDay.ToString('yyyy-MM-dd')); perigee's nightly backup may have stopped"; exit 1 }
  Log "Done: $got new, $failed failed, newest daily $($newest.Name)"
  if ($failed -gt 0) { exit 1 }
} catch {
  Log "FAILED: $_"
  exit 1
}
