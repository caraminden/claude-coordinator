# Sets the test box's Windows up from inside it (#369). new-test-box.ps1 copies it to C:\citadel-box and
# Windows runs it once at the first sign-in (the unattend file's FirstLogonCommands). Run it again by
# hand, as administrator in the box, after a failure: every step is safe to repeat.
#   - signs in as `citadel` at every start, for good, and can never lock, sleep or blank the screen;
#   - 125% display scaling, and Windows 11's rounded corners forced on (the Hyper-V display adapter
#     draws square ones otherwise);
#   - no notifications over tests, and Windows Update never restarts it while signed in;
#   - Git, Node (for Citadel's machine agent), mise and Tailscale;
#   - then restarts the box once, so the scaling takes.
# It writes each step to C:\citadel-box\guest-setup.log, then guest-setup.done, or guest-setup.failed
# with the reason, which new-test-box.ps1 waits on.
$ErrorActionPreference = 'Stop'
$box = 'C:\citadel-box'
$log = "$box\guest-setup.log"
function Log([string]$Text) { Add-Content -Path $log -Value "$(Get-Date -Format 'HH:mm:ss') $Text" }
trap {
  $why = "$($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
  Log "error: $why"
  Set-Content -Path "$box\guest-setup.failed" -Value $why
  exit 1
}
Remove-Item "$box\guest-setup.failed", "$box\guest-setup.done" -ErrorAction SilentlyContinue
function Set-Reg([string]$Key, [string]$Name, $Value, [string]$Type = 'DWord') {
  if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null }
  New-ItemProperty -Path $Key -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

Log 'Signing in by itself at every start'
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
if (Test-Path "$box\autologon.txt") {
  # shortcut: the password sits in the registry as Windows' own autologon keeps it; it's a local
  # account in a VM nobody else reaches. Sysinternals Autologon would hide it, if that ever matters.
  Set-Reg $winlogon DefaultPassword (Get-Content "$box\autologon.txt" -Raw).Trim() String
  Remove-Item "$box\autologon.txt"
}
Set-Reg $winlogon AutoAdminLogon '1' String
Set-Reg $winlogon DefaultUserName 'citadel' String
Set-Reg $winlogon DefaultDomainName $env:COMPUTERNAME String
Remove-ItemProperty -Path $winlogon -Name AutoLogonCount -ErrorAction SilentlyContinue
Remove-Item C:\Windows\Panther\unattend.xml -ErrorAction SilentlyContinue

Log 'Never locking, sleeping or blanking the screen'
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /hibernate off
powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
powercfg /setactive SCHEME_CURRENT
Set-Reg 'HKCU:\Control Panel\Desktop' ScreenSaveActive '0' String
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' NoLockScreen 1
Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' InactivityTimeoutSecs 0
# Win+L does nothing: a locked box refuses every screen read until someone signs in again.
Set-Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System' DisableLockWorkstation 1

Log 'Display at 125%, rounded corners on'
Set-Reg 'HKCU:\Control Panel\Desktop' LogPixels 120
Set-Reg 'HKCU:\Control Panel\Desktop' Win8DpiScaling 1
Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\Dwm' ForceEffectMode 2

Log 'No notifications, and no update restarts while signed in'
Set-Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' ToastEnabled 0
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' NoAutoRebootWithLoggedOnUsers 1
Set-Reg 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' ActiveHoursStart 6
Set-Reg 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' ActiveHoursEnd 23

Log 'Waiting for winget (the Store brings it in a few minutes after the first sign-in)'
$deadline = (Get-Date).AddMinutes(15)
while (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  if ((Get-Date) -gt $deadline) { throw 'winget never arrived. Update "App Installer" in the Microsoft Store, then run this again.' }
  Start-Sleep -Seconds 15
}
foreach ($id in 'Git.Git', 'OpenJS.NodeJS.LTS', 'jdx.mise', 'Tailscale.Tailscale') {
  Log "Installing $id"
  winget install --id $id --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity | Out-Null
  # -1978335189: already installed and nothing newer.
  if ($LASTEXITCODE -and $LASTEXITCODE -ne -1978335189) { throw "winget install $id failed ($LASTEXITCODE)" }
}

New-Item -ItemType Directory -Force C:\work | Out-Null
Log 'Done; restarting the box once for the scaling'
Set-Content -Path "$box\guest-setup.done" -Value (Get-Date -Format o)
Start-Sleep -Seconds 30
Restart-Computer -Force
