<#
.SYNOPSIS
  Adds one scheme's self-hosted GitHub Actions runner to this Windows PC, in the shape of Delve's delve-ci.

.DESCRIPTION
  Citadel #320. Every scheme's CI runs on Cara's desktop, one runner instance per repo (a personal GitHub
  account's runner serves one repo only). This script:
    1. asks Citadel which repo and label the scheme has (no token yet), and stops if this PC already has
       that repo's runner folder or service: safe to run again;
    2. asks Citadel for a registration token (about an hour, never stored; Citadel notes it in the scheme
       Taskmaster's chat), made with the scheme owner's GitHub login;
    3. downloads the stock runner into C:\actions-runner-<repo>, writes its .env (telemetry off, Git\bin
       first on PATH) and configures it with the label <scheme-slug>-ci as a Windows service under
       NETWORK SERVICE, delayed automatic start, restart on failure.
  It never touches another runner, never restarts or reboots the PC.
  Run it in an elevated PowerShell (Run as administrator): installing a service needs it.

.PARAMETER Scheme
  The scheme's name ("Peek Auras"), its runner label ("peek-auras-ci") or its id.

.PARAMETER CitadelUrl
  Where this PC's machine agent connects: the address the Machines page shows in a machine's setup lines.

.PARAMETER MachineToken
  That machine's token (ccm_...). Defaults to the CC_MACHINE_TOKEN environment variable. The machine must
  belong to someone in the scheme (Cara's reaches every scheme), or be lent to the scheme.

.EXAMPLE
  .\add-runner.ps1 -Scheme "Peek Auras" -CitadelUrl http://perigee:8574
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
  [string]$RunnerName = $env:COMPUTERNAME
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

# 1. Names first, so a re-run stops here without minting a token.
$names = Get-RunnerToken $false
$owner, $repoName = $names.repo -split '/', 2
$dir = "C:\actions-runner-$repoName"
$label = $names.label
$servicePattern = "actions.runner.$owner-$repoName.*"
$existing = Get-Service -Name $servicePattern -ErrorAction SilentlyContinue
if ($existing -or (Test-Path $dir)) {
  Write-Host "$($names.scheme) already has a runner here, so nothing changed:" -ForegroundColor Yellow
  if (Test-Path $dir) { Write-Host "  folder  $dir" }
  foreach ($s in $existing) { Write-Host "  service $($s.Name) ($($s.Status), $($s.StartType))" }
  Write-Host 'To start over, remove it by hand first (config.cmd remove in that folder, with a removal token from GitHub).'
  exit 0
}

# 2. Download the stock runner, fresh each run, and check it before it becomes a service.
$zip = Join-Path $env:TEMP "actions-runner-win-x64-$RunnerVersion-$PID.zip"
Write-Host "Downloading runner v$RunnerVersion"
Invoke-WebRequest -Uri "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip" -OutFile $zip -UseBasicParsing
$hash = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
if ($hash -ne $RunnerSha256) {
  Remove-Item -Force $zip
  Stop-With "The download's SHA-256 is $hash, not $RunnerSha256 from the release notes; nothing installed."
}
New-Item -ItemType Directory -Path $dir | Out-Null
$configured = $false
try {
  Expand-Archive -Path $zip -DestinationPath $dir

  # 3. The runner reads .env at start: telemetry off, and Git's bash first so `shell: bash` steps run.
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  @(
    'DOTNET_CLI_TELEMETRY_OPTOUT=1'
    'POWERSHELL_TELEMETRY_OPTOUT=1'
    'DOTNET_NOLOGO=1'
    "PATH=$GitBin;$machinePath"
  ) | Set-Content -Path (Join-Path $dir '.env') -Encoding ASCII

  # 4. The token, as late as possible: it lasts about an hour.
  $reg = Get-RunnerToken $true
  Write-Host "Registering $RunnerName on $($reg.repo) with label $label"
  Push-Location $dir
  try {
    & .\config.cmd --unattended --url "https://github.com/$($reg.repo)" --token $reg.token --name $RunnerName `
      --labels $label --work _work --runasservice --windowslogonaccount 'NT AUTHORITY\NETWORK SERVICE'
    if ($LASTEXITCODE -ne 0) { throw "config.cmd failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
  $configured = $true
} finally {
  Remove-Item -Force $zip -ErrorAction SilentlyContinue
  # Only a folder this run made, and only while no service points at it; once config.cmd has made the service,
  # GitHub has the runner too, and the folder stays for `config.cmd remove`.
  if (-not $configured -and (Test-Path $dir)) {
    if (Get-Service -Name $servicePattern -ErrorAction SilentlyContinue) {
      Write-Host "Setup failed after the service was made; $dir stays. Look in its _diag, then run config.cmd remove there (with a removal token from the repo's runner settings) before trying again." -ForegroundColor Yellow
    } else {
      Write-Host "Setup didn't finish; removing $dir, which this run made." -ForegroundColor Yellow
      Remove-Item -Recurse -Force $dir
    }
  }
}

# 5. Like delve-ci: delayed automatic start, restart on failure. config.cmd already started the service.
$service = Get-Service -Name $servicePattern -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $service) { Stop-With "config.cmd finished but no service matching $servicePattern exists; check $dir\_diag." }
& sc.exe config $service.Name start= delayed-auto | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warning "Couldn't set $($service.Name) to delayed automatic start (sc.exe exit $LASTEXITCODE)." }
& sc.exe failure $service.Name reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warning "Couldn't set $($service.Name) to restart on failure (sc.exe exit $LASTEXITCODE)." }

$service = Get-Service -Name $service.Name
Write-Host ''
Write-Host "Done: $($service.Name) is $($service.Status)." -ForegroundColor Green
Write-Host "  folder $dir"
Write-Host "  label  $label  (runs-on: [self-hosted, $label])"
Write-Host "  check  https://github.com/$($names.repo)/settings/actions/runners should list $RunnerName as Idle."
