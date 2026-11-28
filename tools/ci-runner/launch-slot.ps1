# One-job runner launcher (runner pool P2, #2269): the low-rights half. runner-slot.ps1 -Op Start registers a slot's task
# that runs this as NETWORK SERVICE, from C:\citadel-pool\launch-slot.ps1, which that account can read but not change:
#   powershell.exe -File launch-slot.ps1 -Slot <slot folder> -Once <one-time id> -CitadelUrl <machines url>
# It readies the slot (wipes the last runner's registration files, links bin and externals to the machine's one runner
# copy, copies the copy's own root files, writes .env with the slot's tool homes), then swaps the one-time id for the
# runner's just-in-time config at Citadel and starts the runner with it in ACTIONS_RUNNER_INPUT_JITCONFIG, never on a
# command line or in a file (the runner reads the variable and clears it from its own environment). The runner writes
# its own .runner and .credentials into the slot for the job's length (spec section 3.4) and ends after one job.
# Each step goes to <slot>\slot.log (started afresh, the last run's kept as slot.prev.log), the runner's own output to
# <slot>\runner-console.log: the agent reads both.
param(
  [Parameter(Mandatory)][string]$Slot,
  [Parameter(Mandatory)][string]$Once,
  [Parameter(Mandatory)][string]$CitadelUrl,
  [string]$GitBin = 'C:\Program Files\Git\bin'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$ProgressPreference = 'SilentlyContinue'
$log = Join-Path $Slot 'slot.log'
function Log([string]$Text) { Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $Text" }
if (Test-Path -LiteralPath $log) { Move-Item -LiteralPath $log -Destination (Join-Path $Slot 'slot.prev.log') -Force }
Log "launcher once $($Once.Substring(0, [Math]::Min(8, $Once.Length))): $env:USERDOMAIN\$env:USERNAME, pid $PID"
try {
  $pool = Split-Path -Parent (Split-Path -Parent $Slot)
  $version = (Get-Content -LiteralPath (Join-Path $pool 'runner\current') -Raw).Trim()
  $copy = Join-Path $pool "runner\$version"

  # A runner stopped before its job leaves its registration behind (P0, #2266): never start on top of it. The last run's
  # console goes too, so the agent never reads its job as this runner's.
  foreach ($f in '.runner', '.credentials', '.credentials_rsaparams', 'runner-console.log') {
    $p = Join-Path $Slot $f
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
  }
  # Two runners in one folder clash (P0): each slot links to the one copy and keeps its own root files.
  foreach ($d in 'bin', 'externals') {
    $p = Join-Path $Slot $d
    $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType -eq 'Junction' -and @($item.Target)[0] -eq (Join-Path $copy $d)) { continue }
    # rmdir takes a junction off without touching what it names, and a real folder's links too.
    if ($item) { & cmd.exe /c rmdir /s /q "`"$p`"" }
    & cmd.exe /c mklink /J "`"$p`"" "`"$(Join-Path $copy $d)`"" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "couldn't link $d to the runner copy v$version" }
  }
  Get-ChildItem -LiteralPath $copy -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Slot $_.Name) -Force }
  # Telemetry off, Git's bash first, and tool homes of the slot's own (add-runner.ps1's, #370), so jobs at once in two
  # slots never share a mise or a cargo.
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  @(
    'DOTNET_CLI_TELEMETRY_OPTOUT=1'
    'POWERSHELL_TELEMETRY_OPTOUT=1'
    'DOTNET_NOLOGO=1'
    "PATH=$GitBin;$machinePath"
    "MISE_DATA_DIR=$Slot\tools\mise"
    "MISE_CACHE_DIR=$Slot\tools\mise\cache"
    "MISE_STATE_DIR=$Slot\tools\mise\state"
    "RUSTUP_HOME=$Slot\tools\rustup"
    "CARGO_HOME=$Slot\tools\cargo"
  ) | Set-Content -LiteralPath (Join-Path $Slot '.env') -Encoding ASCII

  # The config, once: Citadel hands it to whoever holds the id first, then forgets it.
  $uri = $CitadelUrl.TrimEnd('/') + '/api/machines/runner-jit'
  try {
    $config = Invoke-RestMethod -Method Post -Uri $uri -Body (@{ once = $Once } | ConvertTo-Json) -ContentType 'application/json' -UseBasicParsing
  } catch {
    $why = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    throw "Citadel didn't hand over the runner's config: $why"
  }
  if ($config -isnot [string] -or $config -notmatch '^[A-Za-z0-9+/=]{100,}$') { throw "Citadel's answer isn't a runner config" }
  $env:ACTIONS_RUNNER_INPUT_JITCONFIG = $config
  Remove-Variable config
  Log "runner v$version, starting the runner"
  & cmd.exe /c "`"$Slot\run.cmd`" > `"$Slot\runner-console.log`" 2>&1"
  $code = $LASTEXITCODE
  $env:ACTIONS_RUNNER_INPUT_JITCONFIG = $null
  Log "runner exited $code"
  exit $code
} catch {
  Log "error: $($_.Exception.Message)"
  exit 1
}
