<#
  #988: opens a page in an Edge app window, presses its button with a real key press, and the page launches
  citadel-firefox:https://example.com/?a=1&b=2#x. Run on the test box after citadel-firefox-link.ps1 set the scheme up.
  Prints the app window's title (clicked = the page stayed; PAGEHIDE or UNLOAD-PROMPT = the launch tried to leave it)
  and the command line of every firefox process, whose last arguments should be -osint -url and the exact address.
#>
param([string]$Page = (Join-Path $PSScriptRoot 't.html'))
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$uri = ([Uri](Resolve-Path -LiteralPath $Page).Path).AbsoluteUri
Start-Process -FilePath $edge -ArgumentList "--app=$uri"
Start-Sleep -Seconds 6
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Seconds 5
Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { "window: $($_.MainWindowTitle)" }
Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" | ForEach-Object { "firefox: $($_.CommandLine)" } | Select-Object -First 3
