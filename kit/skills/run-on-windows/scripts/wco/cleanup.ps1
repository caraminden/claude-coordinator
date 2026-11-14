# Undoes the WCO rig on the test box (the driver fetches it; node rig.ts down prints the build-task line that runs it):
# the rig's Edge and driver processes, the installed test apps' shortcuts, Start menu entries and uninstall
# entries, and its temp folder. Touches only what the rig made: anything whose command line names the citadel-wco
# profile folder (Edge writes --user-data-dir into an app's shortcut and uninstall command).
$ErrorActionPreference = 'Continue'
$rig = Join-Path $env:TEMP 'citadel-wco'
Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*citadel-wco*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; 'stopped ' + $_.Name + ' ' + $_.ProcessId }
Start-Sleep 2
$shell = New-Object -ComObject WScript.Shell
foreach ($p in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  Get-ChildItem -Path $p -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($shell.CreateShortcut($_.FullName).Arguments -like '*citadel-wco*') { Remove-Item -LiteralPath $_.FullName -Force; 'removed ' + $_.FullName }
    elseif ($_.Name -like 'Citadel*') { 'left (not the rig profile): ' + $_.FullName }
  }
}
$apps = Join-Path ([Environment]::GetFolderPath('Programs')) 'Edge Apps'
if ((Test-Path $apps) -and -not (Get-ChildItem $apps)) { Remove-Item -LiteralPath $apps -Force; 'removed empty ' + $apps }
Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object {
  $e = Get-ItemProperty $_.PSPath
  if ($e.UninstallString -like '*citadel-wco*') { Remove-Item -LiteralPath $_.PSPath -Recurse -Force; 'removed uninstall entry ' + $e.DisplayName }
  elseif ($e.DisplayName -like 'Citadel*') { 'left (not the rig profile): uninstall entry ' + $e.DisplayName }
}
if (Test-Path $rig) { Remove-Item -LiteralPath $rig -Recurse -Force -ErrorAction SilentlyContinue; 'removed ' + $rig + ': ' + (-not (Test-Path $rig)) }
'clean'
