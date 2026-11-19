<#
  Lets Citadel's "Open links in Firefox" switch (#988) work on this Windows PC. Run it once, as you (no admin).

  Firefox deleted its own firefox-bridge: link scheme in version 126, so Citadel uses one of its own,
  citadel-firefox:https://example.com. This script registers it for your user (HKCU\Software\Classes) and writes the
  small program Windows runs for it, which opens the address in Firefox and refuses anything that isn't http or https.

    powershell -NoProfile -ExecutionPolicy Bypass -File citadel-firefox-link.ps1            # set up
    powershell -NoProfile -ExecutionPolicy Bypass -File citadel-firefox-link.ps1 -Remove    # take it away again

  The browser asks once before it hands a citadel-firefox: link to Windows: tick "Always allow".
  Works in Windows PowerShell 5.1 and PowerShell 7.
#>
param(
  [switch]$Remove,
  [string]$Dir = (Join-Path $env:LOCALAPPDATA 'Citadel'),
  [string]$Scheme = 'citadel-firefox'
)
$ErrorActionPreference = 'Stop'
$handler = Join-Path $Dir 'open-in-firefox.ps1'
$key = "HKCU:\Software\Classes\$Scheme"

if ($Remove) {
  Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $handler -Force -ErrorAction SilentlyContinue
  Write-Output "Removed ${Scheme}: from this PC."
  return
}

# What Windows runs for a citadel-firefox: link. Single-quoted here-string: nothing in it is expanded now.
$program = @'
param([string]$Link)
$ErrorActionPreference = 'Stop'
$url = $Link -replace '^citadel-firefox:', ''
$uri = $null
if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin 'http', 'https') { exit 2 }
# -osint is Firefox's switch for an address that came from outside; the address is one argument, never a command line.
Start-Process -FilePath 'firefox' -ArgumentList '-osint', '-url', $uri.AbsoluteUri
'@

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Set-Content -LiteralPath $handler -Value $program -Encoding UTF8
# conhost --headless: -WindowStyle Hidden alone still flashes a console window before it hides.
$command = "conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$handler`" `"%1`""
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -LiteralPath $key -Name '(default)' -Value "URL:$Scheme"
Set-ItemProperty -LiteralPath $key -Name 'URL Protocol' -Value ''
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -LiteralPath "$key\shell\open\command" -Name '(default)' -Value $command
Write-Output "Set up ${Scheme}: for this user. Handler: $handler"
