<#
.SYNOPSIS
  One-job runners in warm slot folders (runner pool P2, #2269): the SYSTEM half, which the CI runner agent runs.

.DESCRIPTION
  Citadel places each CI job on a machine and asks that machine's runner agent to start one just-in-time runner for it
  (specs/one-runner-pool.md, section 3). The agent runs this script, as SYSTEM, with one of four ops:

    Update   keeps the machine's one copy of the runner program, C:\citadel-pool\runner\<version>, at GitHub's newest
             release (checked against the SHA-256 in its release notes). Only while no slot runs, so never under a job.
    Start    makes the scheme's slot folder C:\citadel-pool\<repo>\slot-<n> if it is new (locked: SYSTEM and
             Administrators, plus modify for NETWORK SERVICE), registers that slot's task "\Citadel runner pool\<repo>
             slot <n>" as NETWORK SERVICE, and starts it. The task runs launch-slot.ps1, which fetches the runner's config
             from Citadel with the one-time id and starts the runner: so the task's stored arguments hold only the id.
    Stop     stops that slot's task and ends every NETWORK SERVICE process of it (the launcher's tree, anything running
             from the slot folder), then deletes the registration files a runner stopped before its job leaves behind.
    State    prints one JSON line per slot task: repo, slot, whether it is running.

  SYSTEM never writes inside a slot folder, which a job can write: the launcher, running as NETWORK SERVICE, links the
  slot to the runner copy and wipes the last runner's files itself. Stop's deletes remove links, never what they name.
  It never touches the standing runners (C:\actions-runner-*), never restarts the PC.

.EXAMPLE
  .\runner-slot.ps1 -Op Start -Scheme 2 -Slot 1 -Once 0123... -CitadelUrl 'http://perigee.tail59477f.ts.net:8574'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('Update', 'Start', 'Stop', 'State')][string]$Op,
  [string]$Scheme,
  [int]$Slot,
  [string]$Once,
  [string]$CitadelUrl,
  [string]$MachineToken = $env:CC_MACHINE_TOKEN,
  # Tests and the P2 proof only; the agent never passes it.
  [string]$Pool = 'C:\citadel-pool'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Stop-With([string]$Why) {
  Write-Host "runner-slot: $Why"
  exit 1
}

$TaskPath = '\Citadel runner pool\'
$NetworkService = 'S-1-5-20'
$Copies = Join-Path $Pool 'runner'

# The pool's root: SYSTEM and Administrators own it, NETWORK SERVICE may read it (the runner copy, the launcher), nobody
# else sees it. By SID, so a Windows in another language reads them too.
function Lock-Pool {
  if (-not (Test-Path -LiteralPath $Pool)) { New-Item -ItemType Directory -Path $Pool | Out-Null }
  & icacls.exe $Pool /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${NetworkService}:(OI)(CI)RX" | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-With "icacls couldn't lock $Pool (exit $LASTEXITCODE)." }
}

function Get-SlotTask {
  @(Get-ScheduledTask -TaskPath $TaskPath -ErrorAction SilentlyContinue)
}

if ($Op -eq 'State') {
  foreach ($t in Get-SlotTask) {
    if ($t.TaskName -notmatch '^(.+) slot (\d+)$') { continue }
    @{ repo = $Matches[1]; slot = [int]$Matches[2]; running = ($t.State -eq 'Running') } | ConvertTo-Json -Compress
  }
  exit 0
}

if ($Op -eq 'Update') {
  if (@(Get-SlotTask | Where-Object { $_.State -eq 'Running' }).Count) { Stop-With 'a slot is running; the copy updates only between jobs.' }
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{ 'User-Agent' = 'Citadel' } -UseBasicParsing
  $version = ([string]$release.tag_name).TrimStart('v')
  if ($version -notmatch '^\d+\.\d+\.\d+$') { Stop-With "GitHub's newest runner release has a version this script can't read: $version" }
  if (([string]$release.body) -notmatch '<!-- BEGIN SHA win-x64 -->([0-9a-f]{64})<!-- END SHA win-x64 -->') { Stop-With "runner v$version's release notes have no win-x64 SHA-256." }
  $sha = $Matches[1]
  Lock-Pool
  $current = Join-Path $Copies 'current'
  $have = if (Test-Path -LiteralPath $current) { (Get-Content -LiteralPath $current -Raw).Trim() } else { '' }
  if ($have -eq $version -and (Test-Path -LiteralPath (Join-Path $Copies "$version\bin\Runner.Listener.exe"))) {
    Write-Host "runner v$version is current"
    exit 0
  }
  New-Item -ItemType Directory -Force -Path $Copies | Out-Null
  $zip = Join-Path $env:TEMP "actions-runner-win-x64-$version-$PID.zip"
  $part = Join-Path $Copies "$version.part"
  try {
    Write-Host "Downloading runner v$version"
    Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v$version/actions-runner-win-x64-$version.zip" -OutFile $zip -UseBasicParsing
    $got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $sha) { Stop-With "the download's SHA-256 is $got, not $sha from the release notes; nothing changed." }
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $part
    $dest = Join-Path $Copies $version
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    Rename-Item -LiteralPath $part -NewName $version
    Set-Content -LiteralPath $current -Value $version -Encoding ASCII
  } finally {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  }
  # The old copies: no slot runs, and each slot links to the current one at its next start.
  Get-ChildItem -LiteralPath $Copies -Directory | Where-Object { $_.Name -ne $version } | ForEach-Object { & cmd.exe /c rmdir /s /q "`"$($_.FullName)`"" }
  Write-Host "runner v$version installed (was $(if ($have) { "v$have" } else { 'none' }))"
  exit 0
}

# Start and Stop: one slot of one scheme.
if (-not $Scheme -or $Scheme -notmatch '^\d{1,9}$') { Stop-With 'Scheme must be a scheme id.' }
if ($Slot -lt 1 -or $Slot -gt 16) { Stop-With 'Slot must be 1 to 16.' }
if (-not $CitadelUrl -or $CitadelUrl -notmatch '^https?://[^\s"''`]+$') { Stop-With 'CitadelUrl must be an http(s) address.' }
if (-not $MachineToken) { Stop-With 'No machine token: set CC_MACHINE_TOKEN (the agent does).' }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Stop-With 'Run this elevated (the agent runs as SYSTEM): it registers a task for NETWORK SERVICE.' }

# Which repo the scheme has, from Citadel (no token): the folder is named after it, so it comes from Citadel, not the ask.
try {
  $names = Invoke-RestMethod -Method Post -Uri ($CitadelUrl.TrimEnd('/') + '/api/machines/runner-token') -Body (@{ scheme = $Scheme; mint = $false } | ConvertTo-Json) -ContentType 'application/json' -Headers @{ Authorization = "Bearer $MachineToken" } -UseBasicParsing
} catch {
  $why = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
  Stop-With "Citadel wouldn't say which repo scheme $Scheme has: $why"
}
$repo = ([string]$names.repo -split '/')[-1]
if ($repo -notmatch '^[A-Za-z0-9_.-]{1,100}$' -or $repo -match '^\.+$') { Stop-With "Citadel named a repo this script won't make a folder for: $($names.repo)" }
$dir = Join-Path (Join-Path $Pool $repo) "slot-$Slot"
$name = "$repo slot $Slot"
$task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $name -ErrorAction SilentlyContinue

# Every NETWORK SERVICE process of this slot: the launcher's tree (its command line, which only this script sets, names
# the slot) and anything running from the slot folder. Never another account's: SYSTEM ends only what the slot's own did.
function Get-SlotProcess {
  $all = @(Get-CimInstance -ClassName Win32_Process)
  $ns = { param($p) try { (Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop).User -eq 'NETWORK SERVICE' } catch { $false } }
  $roots = @($all | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like "*launch-slot.ps1*-Slot `"$dir`"*" })
  $seen = @{}
  $queue = [Collections.Generic.Queue[object]]::new()
  foreach ($r in $roots) { $queue.Enqueue($r) }
  foreach ($p in $all) { if ($p.ExecutablePath -and $p.ExecutablePath.StartsWith("$dir\", [StringComparison]::OrdinalIgnoreCase)) { $queue.Enqueue($p) } }
  while ($queue.Count) {
    $p = $queue.Dequeue()
    if ($seen.ContainsKey($p.ProcessId)) { continue }
    $seen[$p.ProcessId] = $p
    foreach ($c in $all) { if ($c.ParentProcessId -eq $p.ProcessId -and $c.CreationDate -ge $p.CreationDate) { $queue.Enqueue($c) } }
  }
  @($seen.Values | Where-Object { & $ns $_ })
}

if ($Op -eq 'Stop') {
  # Found before the task stops: once the launcher is gone its children no longer lead back to it.
  # shortcut: a runner whose launcher died some other way runs from the copy, not the slot, so this misses it; it ends
  # with its job (or the 2-minute reaper's GitHub removal), and the next Start refuses nothing for it.
  $procs = Get-SlotProcess
  if ($task) { Stop-ScheduledTask -TaskPath $TaskPath -TaskName $name -ErrorAction SilentlyContinue }
  foreach ($p in $procs) { Invoke-CimMethod -InputObject $p -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }
  # The registration a runner stopped before its job leaves (P0, #2266). Remove-Item deletes a link, not what it names.
  foreach ($f in '.runner', '.credentials', '.credentials_rsaparams') {
    $path = Join-Path $dir $f
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  }
  Write-Host "stopped $name ($($procs.Count) process(es) ended)"
  exit 0
}

# Start.
if ($Once -notmatch '^[0-9a-f]{48}$') { Stop-With 'Once must be the 48-character one-time id Citadel sent.' }
if ($task -and $task.State -eq 'Running') { Stop-With "$name is still running a runner; stop it first." }
$current = Join-Path $Copies 'current'
if (-not (Test-Path -LiteralPath $current)) { Stop-With 'no runner copy on this machine yet: Update makes it.' }
$version = (Get-Content -LiteralPath $current -Raw).Trim()
if (-not (Test-Path -LiteralPath (Join-Path $Copies "$version\bin\Runner.Listener.exe"))) { Stop-With "the runner copy v$version is incomplete: run Update." }

Lock-Pool
$repoDir = Split-Path -Parent $dir
if (-not (Test-Path -LiteralPath $repoDir)) { New-Item -ItemType Directory -Path $repoDir | Out-Null }
if (-not (Test-Path -LiteralPath $dir)) {
  New-Item -ItemType Directory -Path $dir | Out-Null
  # Only on the folder this run made (no /T): what a job wrote inside is the job's.
  & icacls.exe $dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${NetworkService}:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-With "icacls couldn't set $dir's rights (exit $LASTEXITCODE)." }
}
# The launcher sits in the pool's root, which NETWORK SERVICE can read but not change.
$launcher = Join-Path $Pool 'launch-slot.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch-slot.ps1') -Destination $launcher -Force

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`" -Slot `"$dir`" -Once $Once -CitadelUrl $CitadelUrl"
$action = New-ScheduledTaskAction -Execute $ps -Argument $taskArgs -WorkingDirectory $dir
$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\NETWORK SERVICE" -LogonType ServiceAccount -RunLevel Limited
# Below normal, as keep-runners.ps1 holds the standing runners; no time limit a job could hit (GitHub's own ends it).
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -MultipleInstances IgnoreNew -Priority 7 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -Force -TaskPath $TaskPath -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskPath $TaskPath -TaskName $name

# The launcher's first lines (it starts slot.log afresh) say whether NETWORK SERVICE got its config: wait for them, so a
# refusal comes back here.
$log = Join-Path $dir 'slot.log'
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  if (-not (Test-Path -LiteralPath $log)) { continue }
  $tail = @(Get-Content -LiteralPath $log -Tail 5)
  if (-not ($tail -match " once $($Once.Substring(0, 8))")) { continue }
  $err = $tail | Where-Object { $_ -match ' error: ' } | Select-Object -Last 1
  if ($err) { Stop-With "$name's launcher failed: $($err -replace '^\S+ ', '')" }
  if ($tail -match 'starting the runner') {
    Write-Host "started $name (runner v$version)"
    exit 0
  }
}
Stop-With "$name's launcher said nothing in 20 seconds; its slot.log: $dir\slot.log"
