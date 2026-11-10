# Keeps the test box signed in as `citadel` across every restart (#461). Runs inside the box, as
# administrator: guest-setup.ps1 calls it when the box is built, and fix-autologon.ps1 sends it in from
# the host when the box is found at the sign-in screen.
#   -Mode Apply (default): the password never expires; it is stored as the LSA secret Winlogon reads
#       (what Sysinternals Autologon does) and as the registry value; Windows' own sign-in after an
#       update (ARSO) is off; and Windows Update is told not to restart a signed-in box.
#       With no -Password everything but the stored password is set.
#   -Mode Show: prints what decides whether the box signs in, and changes nothing.
# Why: on 2026-11-10 an update's restart left AutoAdminLogon 0, DefaultDomainName '.' and no
# password in both places, and the box sat at the sign-in screen for 8 hours. That is what Windows'
# one-time sign-in after an update leaves behind when it cleans up, so it is switched off here.
param([string]$Password, [ValidateSet('Apply', 'Show')][string]$Mode = 'Apply')
$ErrorActionPreference = 'Stop'
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
$system = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$au = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
$ux = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CitadelLsa {
  [StructLayout(LayoutKind.Sequential)] struct US { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OA { public int Length; public IntPtr Root; public IntPtr Name; public uint Attributes; public IntPtr Sd; public IntPtr Qos; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref OA oa, uint access, out IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr handle, ref US key, ref US data);
  [DllImport("advapi32.dll")] static extern uint LsaRetrievePrivateData(IntPtr handle, ref US key, out IntPtr data);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaFreeMemory(IntPtr p);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  static US Str(string s) { US u = new US(); u.Buffer = Marshal.StringToHGlobalUni(s); u.Length = (ushort)(s.Length * 2); u.MaximumLength = (ushort)(s.Length * 2 + 2); return u; }
  static IntPtr Open(uint access) {
    OA oa = new OA(); oa.Length = Marshal.SizeOf(typeof(OA)); IntPtr h;
    uint st = LsaOpenPolicy(IntPtr.Zero, ref oa, access, out h);
    if (st != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(st));
    return h;
  }
  // null when the secret does not exist
  public static string Get(string key) {
    IntPtr h = Open(0x4); US k = Str(key); IntPtr data = IntPtr.Zero;
    try {
      uint st = LsaRetrievePrivateData(h, ref k, out data);
      if (st == 0xC0000034) return null;
      if (st != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(st));
      if (data == IntPtr.Zero) return "";
      US u = (US)Marshal.PtrToStructure(data, typeof(US));
      return u.Buffer == IntPtr.Zero ? "" : Marshal.PtrToStringUni(u.Buffer, u.Length / 2);
    } finally { if (data != IntPtr.Zero) LsaFreeMemory(data); Marshal.FreeHGlobal(k.Buffer); LsaClose(h); }
  }
  public static void Set(string key, string value) {
    IntPtr h = Open(0x20); US k = Str(key); US v = Str(value);
    try {
      uint st = LsaStorePrivateData(h, ref k, ref v);
      if (st != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(st));
    } finally { Marshal.FreeHGlobal(k.Buffer); Marshal.FreeHGlobal(v.Buffer); LsaClose(h); }
  }
}
'@

function Set-Reg([string]$Key, [string]$Name, $Value, [string]$Type = 'DWord') {
  if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null }
  New-ItemProperty -Path $Key -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

if ($Mode -eq 'Show') {
  $ErrorActionPreference = 'Continue'
  function Head([string]$t) { ''; "== $t" }
  function Invoke-Safely([scriptblock]$b) { try { & $b } catch { "  (could not read: $($_.Exception.Message))" } }
  function Reg([string]$key, [string[]]$names) {
    $p = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    foreach ($n in $names) {
      $v = if ($p) { $p.$n } else { $null }
      "  {0,-34} {1}" -f $n, $(if ($null -eq $v) { '(not set)' } else { "'$v'" })
    }
  }
  # Never the password itself: only whether one is stored and whether it is the one typed.
  function Get-SecretState([string]$name, $stored) {
    $state = if ($null -eq $stored) { 'MISSING' }
    elseif (-not $stored) { 'BLANK' }
    elseif (-not $Password) { 'present' }
    elseif ($stored -ceq $Password) { 'present, matches the password you typed' }
    else { 'present, DIFFERENT from the password you typed' }
    "  {0,-34} {1}" -f $name, $state
  }
  Head 'Windows'
  Invoke-Safely {
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $os = Get-CimInstance Win32_OperatingSystem
    $user = (Get-CimInstance Win32_ComputerSystem).UserName
    "  $($os.Caption) $($cv.DisplayVersion), build $($cv.CurrentBuild).$($cv.UBR)"
    "  last boot $($os.LastBootUpTime.ToUniversalTime().ToString('u')), now $((Get-Date).ToUniversalTime().ToString('u')), time zone $((Get-TimeZone).Id)"
    "  signed in at the console: $(if ($user) { $user } else { 'nobody' })"
  }
  Head 'Autologon (Winlogon). It needs AutoAdminLogon 1 and a stored password'
  Reg $winlogon 'AutoAdminLogon', 'DefaultUserName', 'DefaultDomainName', 'AutoLogonCount', 'AutoLogonSID', 'LegalNoticeCaption', 'LegalNoticeText'
  Invoke-Safely { Get-SecretState 'DefaultPassword (registry)' (Get-ItemProperty $winlogon -ErrorAction SilentlyContinue).DefaultPassword }
  Invoke-Safely { Get-SecretState 'DefaultPassword (LSA secret)' ([CitadelLsa]::Get('DefaultPassword')) }
  Head 'Things that switch autologon off'
  Reg $system 'DisableAutomaticRestartSignOn', 'LegalNoticeCaption', 'LegalNoticeText'
  "  {0,-34} {1}" -f 'EAS policies key', $(if (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Control\EAS\Policies') { 'PRESENT (blocks autologon)' } else { '(not there)' })
  Invoke-Safely { Get-LocalUser citadel | ForEach-Object { "  citadel: enabled $($_.Enabled), password last set $($_.PasswordLastSet), expires $(if ($_.PasswordExpires) { $_.PasswordExpires } else { 'never' })" } }
  Head 'Restarts and shutdowns (System log, newest first; 41 and 6008 are hard resets)'
  Invoke-Safely {
    Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 1074, 6008, 41 } -MaxEvents 12 -ErrorAction Stop |
      ForEach-Object { "  $($_.TimeCreated.ToUniversalTime().ToString('u')) [$($_.Id)] $((($_.Message -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 3) -join ' | ')" }
  }
  Head 'Failed sign-ins (Security 4625, newest first)'
  Invoke-Safely {
    $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 } -MaxEvents 8 -ErrorAction SilentlyContinue)
    if (-not $ev) { '  none logged' }
    foreach ($e in $ev) {
      $f = @{}; foreach ($d in ([xml]$e.ToXml()).Event.EventData.Data) { $f[$d.Name] = $d.'#text' }
      "  $($e.TimeCreated.ToUniversalTime().ToString('u')) user '$($f.TargetUserName)' type $($f.LogonType) status $($f.Status) sub $($f.SubStatus) by $($f.ProcessName)"
    }
  }
  Head 'Windows Update'
  Reg $au 'NoAutoRebootWithLoggedOnUsers', 'AUOptions', 'ScheduledInstallDay', 'ScheduledInstallTime'
  Reg $ux 'ActiveHoursStart', 'ActiveHoursEnd'
  Invoke-Safely { Get-HotFix | Sort-Object InstalledOn -Descending -ErrorAction SilentlyContinue | Select-Object -First 6 | ForEach-Object { "  $($_.HotFixID) $($_.Description) installed $($_.InstalledOn)" } }
  Head 'Who has the screen right now (C:\citadel-box\screen.lock)'
  Invoke-Safely { if (Test-Path C:\citadel-box\screen.lock) { "  $(Get-Content C:\citadel-box\screen.lock -Raw)" } else { '  nobody' } }
  return
}

# Windows' default maximum password age is 42 days, and an expired password stops autologon.
net.exe accounts /maxpwage:unlimited | Out-Null
Set-LocalUser -Name citadel -PasswordNeverExpires $true
if ($Password) {
  # shortcut: the password also sits in the registry, as Windows' own autologon keeps it; it's a local
  # account in a VM nobody else reaches. Drop the registry copy if that ever matters: the secret is enough.
  [CitadelLsa]::Set('DefaultPassword', $Password)
  if ([CitadelLsa]::Get('DefaultPassword') -cne $Password) { throw 'the LSA secret DefaultPassword did not read back' }
  Set-Reg $winlogon DefaultPassword $Password String
}
Set-Reg $winlogon AutoAdminLogon '1' String
Set-Reg $winlogon DefaultUserName 'citadel' String
Set-Reg $winlogon DefaultDomainName $env:COMPUTERNAME String
Remove-ItemProperty -Path $winlogon -Name AutoLogonCount -ErrorAction SilentlyContinue
# ARSO: after an update Windows signs the last user in once by itself, then clears the autologon values.
Set-Reg $system DisableAutomaticRestartSignOn 1
# NoAutoRebootWithLoggedOnUsers only counts with scheduled installs (AUOptions 4): daily at 03:00.
# Best effort: Home isn't promised to honour these, so the box must survive a restart anyway.
Set-Reg $au NoAutoRebootWithLoggedOnUsers 1
Set-Reg $au AUOptions 4
Set-Reg $au ScheduledInstallDay 0
Set-Reg $au ScheduledInstallTime 3
Set-Reg $ux ActiveHoursStart 6
Set-Reg $ux ActiveHoursEnd 23
"Signs in as citadel at every start$(if (-not $Password) { ' (stored password left as it was)' }); password never expires; Windows' sign-in after updates off; no update restarts while signed in"
