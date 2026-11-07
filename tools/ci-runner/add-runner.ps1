<#
.SYNOPSIS
  Adds one scheme's self-hosted GitHub Actions runners to this Windows PC, in the shape of Delve's delve-ci.

.DESCRIPTION
  Citadel #320, #328. Every scheme's CI runs on Cara's desktop, with runner instances of its own per repo (a
  personal GitHub account's runner serves one repo only). This script:
    1. asks Citadel which repo and label the scheme has (no token yet), and skips each instance whose folder
       or service is already here: safe to run again, and a higher -Count adds only the missing ones;
    2. asks Citadel for a registration token (about an hour, never stored; Citadel notes it in the scheme
       Taskmaster's chat), made with the scheme owner's GitHub login;
    3. downloads the stock runner and, for each missing instance, unpacks it into C:\actions-runner-<repo>
       (then -2, -3, ...), writes its .env (telemetry off, Git\bin first on PATH) and a .citadel-runner
       marker (which repo it serves: remove-runner.ps1 only ever removes folders with one), and configures it
       with the label <scheme-slug>-ci as a Windows service under NETWORK SERVICE, delayed automatic start,
       restart on failure.
  Each runner's .env also gives it tool folders of its own (mise, rustup, cargo) inside its folder: runners sharing one
  profile, as every NETWORK SERVICE runner does, broke each other's mise and cargo when jobs started at once (Peek
  Auras, 2026-11-05).

  With -Session it adds the scheme's one session runner instead, in the shape of Delve's delve-perf and Peek Auras'
  desktop runner (#370): for jobs that open windows or read the screen, which a service can't (session 0 has no
  desktop). Folder C:\actions-runner-<repo>-desktop, name <PC>-desktop, label <scheme-slug>-desktop, no service: the
  logon task "GitHub runner <scheme-slug>-desktop" starts it as the user who runs this, while they're logged on,
  through start-runner.ps1 (copied in from beside this script) on a desktop that is never shown, or on their own
  with -Visible. Re-running it with -Session rewrites the launcher and the logon task, which is how to switch
  -Visible on or off.

  It never touches another runner, never restarts or reboots the PC.
  Run it elevated (an admin PowerShell, or the CI runner agent, which runs as SYSTEM): installing a service needs it.
  -Session needs a person's elevated PowerShell, not the agent: its logon task is for whoever runs it.

.PARAMETER Scheme
  The scheme's name ("Peek Auras"), its runner label ("peek-auras-ci") or its id.

.PARAMETER CitadelUrl
  Where this PC's machine agent connects: the address the Machines page shows in a machine's setup lines.

.PARAMETER MachineToken
  That machine's token (ccm_...). Defaults to the CC_MACHINE_TOKEN environment variable. The machine must
  belong to someone in the scheme (Cara's reaches every scheme), or be lent to the scheme.

.PARAMETER Count
  How many runner instances the scheme should have here, 1 to 4 (default 1): one job runs on each at a time.

.PARAMETER Session
  Add the scheme's session runner (label <scheme-slug>-desktop) and nothing else, instead of service runners.

.PARAMETER Visible
  With -Session: run the jobs on the user's own desktop, where their windows show, instead of a hidden one. A hidden
  desktop can't be read or captured, so screen tests need this, and an unlocked session.

.EXAMPLE
  .\add-runner.ps1 -Scheme "Peek Auras" -CitadelUrl '<the address the Machines page shows>' -Count 4

.EXAMPLE
  .\add-runner.ps1 -Scheme "Peek Auras" -CitadelUrl '<the address the Machines page shows>' -Session -Visible
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Scheme,
  [Parameter(Mandatory)][string]$CitadelUrl,
  [string]$MachineToken = $env:CC_MACHINE_TOKEN,
  [string]$RunnerVersion = '2.338.0',
  # From the release notes of that version (<!-- BEGIN SHA win-x64 -->); pass both to change version.
  [string]$RunnerSha256 = 'f48e0750a21812bca5f82de5f7f5aeae71abee647fab5a582f1742d07eba455f',
  [string]$GitBin = 'C:\Program Files\Git\bin',
  [string]$RunnerName = $env:COMPUTERNAME,
  [ValidateRange(1, 4)][int]$Count = 1,
  [switch]$Session,
  [switch]$Visible
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1's progress bar makes a 100 MB download crawl.
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3

function Stop-With([string]$Why) {
  Write-Host "add-runner: $Why" -ForegroundColor Red
  exit 1
}

if (-not $MachineToken) { Stop-With 'No machine token: pass -MachineToken or set CC_MACHINE_TOKEN (Citadel Machines page, a machine''s setup lines).' }
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Stop-With 'Run this in an elevated PowerShell (Run as administrator): installing the runner service needs it.' }
if (-not (Test-Path (Join-Path $GitBin 'bash.exe'))) { Stop-With "No bash.exe in $GitBin; install Git for Windows or pass -GitBin." }
if ($Visible -and -not $Session) { Stop-With '-Visible goes with -Session.' }
if ($Session -and $PSBoundParameters.ContainsKey('Count')) { Stop-With 'A scheme has one session runner: -Session takes no -Count.' }
$launcher = Join-Path $PSScriptRoot 'start-runner.ps1'
if ($Session) {
  # SYSTEM (the runner agent) has no logon of its own, so its logon task would never start.
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -eq 'S-1-5-18') { Stop-With '-Session runs as the person whose session the runner uses, in their elevated PowerShell, not as SYSTEM.' }
  if (-not (Test-Path $launcher)) { Stop-With "No start-runner.ps1 beside this script ($launcher): download it from the same place (tools/ci-runner/README.md)." }
}
# Windows PowerShell 5.1 defaults to old TLS, which GitHub refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-RunnerToken([bool]$Mint) {
  $uri = $CitadelUrl.TrimEnd('/') + '/api/machines/runner-token'
  $body = @{ scheme = $Scheme; mint = $Mint } | ConvertTo-Json
  try {
    return Invoke-RestMethod -Method Post -Uri $uri -Body $body -ContentType 'application/json' -Headers @{ Authorization = "Bearer $MachineToken" } -UseBasicParsing
  } catch {
    $said = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { $null }
    try { $said = ($said | ConvertFrom-Json).error } catch { $null = $_ } # not JSON: keep the text as it came
    if (-not $said) { $said = $_.Exception.Message }
    Stop-With "Citadel refused: $said"
  }
}

# 1. Names first, so a re-run with nothing to add stops here without minting a token.
$names = Get-RunnerToken $false
$owner, $repoName = $names.repo -split '/', 2
$label = $names.label
if ($Session) {
  # Peek Auras' desktop runner's names (its tools/ci-win/setup-runner.ps1), so the kit's desktop.yml finds it.
  $label = $label -replace '-ci$', '-desktop'
  $task = "GitHub runner $label"
  $me = "$env:USERDOMAIN\$env:USERNAME"
  # A hidden desktop named after the label, or the user's own.
  $desktop = if ($Visible) { 'Default' } else { $label }
  # No service by this name ever exists, so only the folder says whether it's here.
  $instances = @([pscustomobject]@{ Dir = "C:\actions-runner-$repoName-desktop"; Name = "$RunnerName-desktop"; Service = "actions.runner.$owner-$repoName.$RunnerName-desktop" })
} else {
  # Instance 1 keeps #320's folder and name, so a runner added before -Count is the first of them.
  $instances = foreach ($i in 1..$Count) {
    $suffix = if ($i -eq 1) { '' } else { "-$i" }
    [pscustomobject]@{ Dir = "C:\actions-runner-$repoName$suffix"; Name = "$RunnerName$suffix"; Service = "actions.runner.$owner-$repoName.$RunnerName$suffix" }
  }
}

# Ends every process running from a runner's folder (run.cmd's cmd.exe, Runner.Listener, Runner.Worker), a job's too.
function Stop-RunnerProcess([string]$Dir) {
  Get-CimInstance -ClassName Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and (($_.ExecutablePath -and $_.ExecutablePath -like "$Dir\*") -or ($_.CommandLine -and $_.CommandLine -like "*$Dir\run.cmd*"))
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# The session runner's logon task: at each logon of $me, the launcher on its desktop, which restarts run.cmd itself and
# logs to launcher.log. Written on every -Session run, with a fresh launcher, so a re-run switches -Visible.
function Register-SessionTask([string]$Dir) {
  Copy-Item -Force $launcher (Join-Path $Dir 'start-runner.ps1')
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    # Stopping the task ends the launcher, not the run.cmd it started on its desktop, which would then run beside the new one.
    Stop-ScheduledTask -TaskName $task
    Stop-RunnerProcess $Dir
  }
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -WorkingDirectory $Dir `
    -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Dir\start-runner.ps1`" -Desktop $desktop"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $task
  $where = if ($Visible) { 'your own desktop' } else { "the hidden desktop $label" }
  Write-Host "Logon task '$task' for $me starts it on $where; it is running now (log: $Dir\launcher.log)." -ForegroundColor Green
}
$missing = @()
$taken = 0
foreach ($r in $instances) {
  $service = Get-Service -Name $r.Service -ErrorAction SilentlyContinue
  $marker = Join-Path $r.Dir '.citadel-runner'
  $theirs = $null
  if (Test-Path $marker) { try { $theirs = (Get-Content -Raw $marker | ConvertFrom-Json).repo } catch { $theirs = '(unreadable)' } }
  if ($theirs -and $theirs -ne $names.repo) {
    # Repo foo's second instance and repo foo-2's first share a folder name.
    $taken++
    Write-Host "$($r.Dir) already holds a runner for $theirs, so $($r.Name) can't go there; nothing changed for it." -ForegroundColor Red
  } elseif ($Session -and $theirs) {
    # A running launcher keeps its old copy until the task restarts it, which Register-SessionTask does.
    Write-Host "Already here: $($r.Name) in $($r.Dir); rewriting its launcher and logon task."
    Register-SessionTask $r.Dir
  } elseif ($service -or (Test-Path $r.Dir)) {
    $state = if ($service) { "service $($service.Status)" } else { 'no service' }
    Write-Host "Already here, left as it is: $($r.Name) in $($r.Dir) ($state)"
  } else {
    $missing += $r
  }
}
if (-not $missing) {
  if ($taken) { Stop-With "$taken runner(s) couldn't be added: their folders belong to another repo's runners." }
  if ($Session) { exit 0 }
  Write-Host "$($names.scheme) already has $Count runner(s) here, so nothing changed." -ForegroundColor Yellow
  Write-Host 'To start over, remove them first (remove-runner.ps1, or the ci_runners tool''s remove).'
  exit 0
}

# 2. Download the stock runner once, fresh each run, and check it before it becomes a service.
$zip = Join-Path $env:TEMP "actions-runner-win-x64-$RunnerVersion-$PID.zip"
Write-Host "Downloading runner v$RunnerVersion"
Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip" -OutFile $zip -UseBasicParsing
$hash = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
if ($hash -ne $RunnerSha256) {
  Remove-Item -Force $zip
  Stop-With "The download's SHA-256 is $hash, not $RunnerSha256 from the release notes; nothing installed."
}

$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$reg = $null
$failed = 0
try {
  foreach ($r in $missing) {
    New-Item -ItemType Directory -Path $r.Dir | Out-Null
    $configured = $false
    try {
      Expand-Archive -Path $zip -DestinationPath $r.Dir

      # 3. The runner reads .env at start: telemetry off, Git's bash first so `shell: bash` steps run, and tool
      #    folders of its own (Peek Auras' setup action, caraminden/peek-auras .github/actions/setup): runners that
      #    shared one profile replaced each other's mise.exe mid-run and lost Rust while another's rustup synced.
      @(
        'DOTNET_CLI_TELEMETRY_OPTOUT=1'
        'POWERSHELL_TELEMETRY_OPTOUT=1'
        'DOTNET_NOLOGO=1'
        "PATH=$GitBin;$machinePath"
        "MISE_DATA_DIR=$($r.Dir)\tools\mise"
        "MISE_CACHE_DIR=$($r.Dir)\tools\mise\cache"
        "MISE_STATE_DIR=$($r.Dir)\tools\mise\state"
        "RUSTUP_HOME=$($r.Dir)\tools\rustup"
        "CARGO_HOME=$($r.Dir)\tools\cargo"
      ) | Set-Content -Path (Join-Path $r.Dir '.env') -Encoding ASCII
      # Which repo this folder serves: remove-runner.ps1 acts only on folders whose marker names the scheme's repo.
      $mode = if ($Session) { 'session' } else { 'service' }
      @{ repo = $names.repo; label = $label; name = $r.Name; mode = $mode; added_at = (Get-Date).ToUniversalTime().ToString('o') } |
        ConvertTo-Json | Set-Content -Path (Join-Path $r.Dir '.citadel-runner') -Encoding ASCII

      # 4. The token, as late as possible: it lasts about an hour, and one registers every instance of this run.
      if (-not $reg) { $reg = Get-RunnerToken $true }
      Write-Host "Registering $($r.Name) on $($reg.repo) with label $label"
      Push-Location $r.Dir
      try {
        $config = @('--unattended', '--url', "https://github.com/$($reg.repo)", '--token', $reg.token, '--name', $r.Name, '--labels', $label, '--work', '_work')
        if (-not $Session) { $config += @('--runasservice', '--windowslogonaccount', 'NT AUTHORITY\NETWORK SERVICE') }
        & .\config.cmd @config
        if ($LASTEXITCODE -ne 0) { throw "config.cmd failed (exit $LASTEXITCODE)" }
      } finally {
        Pop-Location
      }
      $configured = $true
    } catch {
      $failed++
      Write-Host "$($r.Name): $($_.Exception.Message)" -ForegroundColor Red
    } finally {
      # Only a folder this run made, and only while no service points at it; once config.cmd has made the service,
      # GitHub has the runner too, and the folder stays for `config.cmd remove`.
      if (-not $configured -and (Test-Path $r.Dir)) {
        if (Get-Service -Name $r.Service -ErrorAction SilentlyContinue) {
          Write-Host "Setup failed after the service was made; $($r.Dir) stays. Look in its _diag, then remove it (remove-runner.ps1) before trying again." -ForegroundColor Yellow
        } else {
          Write-Host "Setup didn't finish; removing $($r.Dir), which this run made." -ForegroundColor Yellow
          Remove-Item -Recurse -Force $r.Dir
        }
      }
    }
    if (-not $configured) { continue }
    if ($Session) {
      try { Register-SessionTask $r.Dir } catch {
        $failed++
        Write-Host "$($r.Name) is registered on GitHub, but its logon task wasn't made: $($_.Exception.Message). Run this again to retry." -ForegroundColor Red
      }
      continue
    }

    # 5. Like delve-ci: delayed automatic start, restart on failure. config.cmd already started the service.
    $service = Get-Service -Name $r.Service -ErrorAction SilentlyContinue
    if (-not $service) {
      $failed++
      Write-Host "config.cmd finished but there is no service $($r.Service); check $($r.Dir)\_diag." -ForegroundColor Red
      continue
    }
    & sc.exe config $service.Name start= delayed-auto | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning "Couldn't set $($service.Name) to delayed automatic start (sc.exe exit $LASTEXITCODE)." }
    & sc.exe failure $service.Name reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning "Couldn't set $($service.Name) to restart on failure (sc.exe exit $LASTEXITCODE)." }
    Write-Host "Added: $($service.Name) is $((Get-Service -Name $service.Name).Status), folder $($r.Dir)" -ForegroundColor Green
  }
} finally {
  Remove-Item -Force $zip -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "  label  $label  (runs-on: [self-hosted, $label])"
Write-Host "  check  https://github.com/$($names.repo)/settings/actions/runners should list them as Idle."
if ($failed -or $taken) { Stop-With "$($failed + $taken) runner(s) weren't added; the lines above say why." }
