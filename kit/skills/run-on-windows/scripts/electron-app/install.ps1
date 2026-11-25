# Citadel's desktop app (#1186) installed the way a person does it: the first-install zip from #1148's feed on
# citadel.zip, unzipped into a temp folder, its launcher started. Prints launcher.log and whether the window came up,
# then quits it and removes what it made (shortcuts, the folder). For a picture, run it with -Keep and take one with the
# screenshot tool (no screen capture in here: Defender calls a script that downloads and captures Trojan:BAT/ScreenShoter).
#   powershell -File install.ps1 [-Url https://citadel.zip/api/desktop/2/citadel/install.zip] [-Keep]
param([string]$Url = 'https://citadel.zip/api/desktop/2/citadel/install.zip', [switch]$Keep)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Windows PowerShell's progress bar slows a 150 MB download to minutes
$dir = Join-Path $env:TEMP ('citadel-install-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $dir | Out-Null
$zip = Join-Path $dir 'install.zip'
Invoke-WebRequest -UseBasicParsing $Url -OutFile $zip
Expand-Archive $zip $dir
$app = Join-Path $dir 'citadel'
Get-ChildItem -Recurse $app | Where-Object { -not $_.PSIsContainer } | Select-Object -First 12 | ForEach-Object { $_.FullName.Substring($app.Length) }
$p = Start-Process (Join-Path $app 'citadel.exe') -PassThru
Start-Sleep 25
Write-Output '--- launcher.log'
Get-Content (Join-Path $app 'launcher.log') -ErrorAction SilentlyContinue
$w = Get-Process Citadel -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and $_.Path -like "$dir*" }
Write-Output ('--- window: ' + ($w | ForEach-Object { "$($_.MainWindowTitle) (pid $($_.Id))" }))
if ($Keep) { return }
Get-Process Citadel, citadel -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dir*" } | Stop-Process -Force
Start-Sleep 2
# Only a shortcut that points into this install's folder is ours: the box user's own Citadel.lnk stays.
$shell = New-Object -ComObject WScript.Shell
foreach ($lnk in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Citadel.lnk'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Citadel.lnk'))) {
  if ((Test-Path $lnk) -and $shell.CreateShortcut($lnk).TargetPath -like "$dir*") { Remove-Item -Force $lnk }
}
Remove-Item -Recurse -Force $dir
Write-Output 'cleaned up'
