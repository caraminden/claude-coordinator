# Citadel's desktop app (#1186) installed the way a person does it: the first-install zip from #1148's feed on
# citadel.zip, unzipped into a temp folder, its launcher started. Prints launcher.log, whether the window came up,
# and leaves a shot at %TEMP%\citadel-install.png; then quits it and removes what it made (shortcuts, the folder).
#   powershell -File install.ps1 [-Url https://citadel.zip/api/desktop/2/citadel/install.zip] [-Keep]
param([string]$Url = 'https://citadel.zip/api/desktop/2/citadel/install.zip', [switch]$Keep)
$ErrorActionPreference = 'Stop'
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
$w = Get-Process Citadel -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle }
Write-Output ('--- window: ' + ($w | ForEach-Object { "$($_.MainWindowTitle) (pid $($_.Id))" }))
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save((Join-Path $env:TEMP 'citadel-install.png'))
Write-Output ('shot ' + (Join-Path $env:TEMP 'citadel-install.png'))
if ($Keep) { return }
Get-Process Citadel, citadel -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dir*" } | Stop-Process -Force
Start-Sleep 2
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Citadel.lnk'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Citadel.lnk'), (Join-Path $env:APPDATA 'Citadel\desktop-shortcut-made')
Remove-Item -Recurse -Force $dir
Write-Output 'cleaned up'
