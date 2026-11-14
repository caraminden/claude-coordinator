# Undoes the WCO rig on the test box (the driver fetches it; node rig.ts down prints the build-task line that runs it):
# the rig's Edge and driver processes, the installed test apps' shortcuts, Start menu entries and uninstall
# entries, and its temp folder. Touches only what the rig made: Edge on a citadel-wco profile, apps named "Citadel preview".
$ErrorActionPreference = 'Continue'
$rig = Join-Path $env:TEMP 'citadel-wco'
Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*citadel-wco*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; 'stopped ' + $_.Name + ' ' + $_.ProcessId }
Start-Sleep 2
foreach ($p in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  Get-ChildItem -Path $p -Recurse -Filter 'Citadel preview*.lnk' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force; 'removed ' + $_.FullName }
}
$apps = Join-Path ([Environment]::GetFolderPath('Programs')) 'Edge Apps'
if ((Test-Path $apps) -and -not (Get-ChildItem $apps)) { Remove-Item -LiteralPath $apps -Force; 'removed empty ' + $apps }
Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
  Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like 'Citadel preview*' } |
  ForEach-Object { Remove-Item -LiteralPath $_.PSPath -Recurse -Force; 'removed uninstall entry ' + $_.PSChildName }
if (Test-Path $rig) { Remove-Item -LiteralPath $rig -Recurse -Force -ErrorAction SilentlyContinue; 'removed ' + $rig + ': ' + (-not (Test-Path $rig)) }
'clean'
