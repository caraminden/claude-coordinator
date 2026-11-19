<#
  #988: opens a page in an Edge app window, presses its button with a real key press, and the page launches
  citadel-firefox:https://example.com/?a=1&b=2#x. Run on the test box after citadel-firefox-link.ps1 set the scheme up.
  Prints the app window's title (clicked = the page stayed; PAGEHIDE or UNLOAD-PROMPT = the launch tried to leave it)
  and the command line of every firefox process, whose last arguments should be -osint -url and the exact address.
#>
param([string]$Page = (Join-Path $PSScriptRoot 't.html'), [int]$ClickX = 97, [int]$ClickY = 93)
$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$uri = ([Uri](Resolve-Path -LiteralPath $Page).Path).AbsoluteUri
Start-Process -FilePath $edge -ArgumentList "--app=$uri"
Start-Sleep -Seconds 6
Add-Type -Namespace Win -Name Mouse -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);'
# A real click on the button (the app window opens at the screen's top left, the button 97,93 into it), so the page has a user gesture.
[void][Win.Mouse]::SetCursorPos($ClickX, $ClickY)
Start-Sleep -Milliseconds 300
[Win.Mouse]::mouse_event(2, 0, 0, 0, 0)
[Win.Mouse]::mouse_event(4, 0, 0, 0, 0)
Start-Sleep -Seconds 5
Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { "window: $($_.MainWindowTitle)" }
Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" | ForEach-Object { "firefox: $($_.CommandLine)" } | Select-Object -First 3
