# Undoes the WCO rig on the test box (the driver fetches it; node rig.ts down prints the build-task line that runs it):
# the rig's Edge and driver processes, the installed test apps' shortcuts, Start menu entries and uninstall
# entries, and its temp folder. Touches only what the rig made: anything whose command line names the citadel-wco
# profile folder (Edge writes --user-data-dir into an app's shortcut and uninstall command).
# Another minion's rig can be up on the box at once (each driver.mjs holds its own Edge profile, citadel-wco\edge-<driver pid>),
# so this ends only its own run: pass -Run <the rig's URL> (rig.ts down's line does) and only the driver started with that URL and
# its Edge go, and only its profile folder; the shared citadel-wco folder (this script and the driver sit in it) goes only when
# no driver is left. With no -Run, it ends every run whose driver is gone, and the others stay.
param([string]$Run = '')
$ErrorActionPreference = 'Continue'
$rig = Join-Path $env:TEMP 'citadel-wco'
$procs = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='node.exe'")
$drivers = @($procs | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*citadel-wco*driver.mjs*' })
$mine = @($drivers | Where-Object { $Run -and $_.CommandLine.Contains($Run) } | ForEach-Object { [string]$_.ProcessId })
$live = @($drivers | ForEach-Object { [string]$_.ProcessId } | Where-Object { $mine -notcontains $_ })
# Whether a command line names a run that is not ours to end: its profile belongs to another live driver.
function Others([string]$line) { if ($line -match 'citadel-wco[\\/]edge-(\d+)') { return $live -contains $Matches[1] } return $false }
$procs | Where-Object { $_.CommandLine -like '*citadel-wco*' -and -not (Others $_.CommandLine) -and ([string]$_.ProcessId -notin $live) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; 'stopped ' + $_.Name + ' ' + $_.ProcessId }
Start-Sleep 2
$shell = New-Object -ComObject WScript.Shell
foreach ($p in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  Get-ChildItem -Path $p -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    $args0 = $shell.CreateShortcut($_.FullName).Arguments
    if ($args0 -like '*citadel-wco*' -and -not (Others $args0)) { Remove-Item -LiteralPath $_.FullName -Force; 'removed ' + $_.FullName }
    elseif ($_.Name -like 'Citadel*') { 'left (not the rig profile): ' + $_.FullName }
  }
}
$apps = Join-Path ([Environment]::GetFolderPath('Programs')) 'Edge Apps'
if ((Test-Path $apps) -and -not (Get-ChildItem $apps)) { Remove-Item -LiteralPath $apps -Force; 'removed empty ' + $apps }
Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object {
  $e = Get-ItemProperty $_.PSPath
  if ($e.UninstallString -like '*citadel-wco*' -and -not (Others $e.UninstallString)) { Remove-Item -LiteralPath $_.PSPath -Recurse -Force; 'removed uninstall entry ' + $e.DisplayName }
  elseif ($e.DisplayName -like 'Citadel*') { 'left (not the rig profile): uninstall entry ' + $e.DisplayName }
}
if ($live.Count) {
  # Other drivers are up: their profiles, the driver and this script stay. Our own profiles and the dead drivers' go.
  Get-ChildItem -LiteralPath $rig -Directory -Filter 'edge-*' -ErrorAction SilentlyContinue | Where-Object { $live -notcontains ($_.Name -replace '^edge-', '') } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue; 'removed ' + $_.FullName }
  'left ' + $rig + ': another rig is running (driver ' + ($live -join ', ') + ')'
} elseif (Test-Path $rig) { Remove-Item -LiteralPath $rig -Recurse -Force -ErrorAction SilentlyContinue; 'removed ' + $rig + ': ' + (-not (Test-Path $rig)) }
'clean'
