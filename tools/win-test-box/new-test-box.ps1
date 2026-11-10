<#
.SYNOPSIS
  Builds Citadel's Windows test box: a Hyper-V VM on this PC whose console is always signed in and
  unlocked, at 125% with Windows 11's rounded corners, for native-app schemes' desktop CI jobs and
  minions' run-on-Windows tools (#369). README.md beside this has the whole procedure.

.DESCRIPTION
  Run it once, in PowerShell as administrator, on the host. It never restarts this PC.
  1. Checks: elevated, the edition, Hyper-V on, VBS, free memory and disk, the ISO. Stops with the
     reason if one fails and changes nothing.
  2. Applies Windows 11 Home from the ISO straight onto a new VHDX (no Setup, so no clicks and no
     licence key: the box runs unactivated, Cara's pick, 2026-11-07), with an unattend file that
     makes a local admin `citadel` that signs itself in, and copies this folder's guest scripts in.
  3. Creates a Gen 2 VM: 6 vCPUs capped at 75% with a low weight, 8 GB fixed memory, Secure Boot and
     a vTPM, one fixed display, started 2 minutes after the host boots and shut down with it.
  4. Starts it and waits (up to an hour) for guest-setup.ps1 to finish inside it, over PowerShell
     Direct, then prints the next steps.
  Run it again after a failure: an existing VM of that name skips straight to step 4.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\new-test-box.ps1 -IsoPath D:\Win11_25H2_English_x64.iso
#>
[CmdletBinding()]
param(
  [string]$IsoPath,
  [string]$Name = 'citadel-test-box',
  [ValidateRange(4, 64)][int]$MemoryGB = 8,
  [ValidateRange(2, 32)][int]$Cpus = 6,
  [ValidateRange(80, 1000)][int]$DiskGB = 120,
  [int]$Width = 1920,
  [int]$Height = 1080,
  [string]$Edition = 'Windows 11 Home',
  [string]$Switch = 'Default Switch',
  # Only the checks: says what it would do and changes nothing.
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
function Say([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Stop-With([string]$Why) { Write-Host "`nStopped: $Why" -ForegroundColor Red; exit 1 }

# ---------- 1. checks ----------
Say 'Checking this PC'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Stop-With 'run this in PowerShell as administrator (right-click, Run as administrator).' }
$os = Get-CimInstance Win32_OperatingSystem
Write-Host "  $($os.Caption), build $($os.BuildNumber)"
if ($os.Caption -notmatch 'Pro|Enterprise|Education') { Stop-With 'Hyper-V needs Windows Pro, Enterprise or Education on the host.' }
$hv = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
if ($hv.State -ne 'Enabled') {
  Stop-With @"
Hyper-V is off. Turn it on with this line (as administrator), then restart the PC yourself when it suits you, and run this script again:
  Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart
"@
}
if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) { Stop-With 'Hyper-V is on but its PowerShell module is missing; restart the PC once if you turned Hyper-V on without restarting.' }
$vbs = (Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue).VirtualizationBasedSecurityStatus
Write-Host "  Virtualization-based security: $(switch ($vbs) { 2 { 'running (the hypervisor was already under your games)' } 1 { 'on, not running' } default { 'off' } })"
$freeGb = [Math]::Round($os.FreePhysicalMemory / 1MB, 1)
$totalGb = [Math]::Round($os.TotalVisibleMemorySize / 1MB)
Write-Host "  Memory: $freeGb GB free of $totalGb GB; the box holds $MemoryGB GB all the time it runs"
$existing = Get-VM -Name $Name -ErrorAction SilentlyContinue
if (-not $existing -and $freeGb -lt $MemoryGB + 2) { Stop-With "only $freeGb GB of memory is free; the box needs $MemoryGB GB plus some room. Close something or pass a smaller -MemoryGB." }
$vhdDir = (Get-VMHost).VirtualHardDiskPath
$vhdPath = Join-Path $vhdDir "$Name.vhdx"
$drive = Get-PSDrive ([IO.Path]::GetPathRoot($vhdDir).Substring(0, 1))
$diskFreeGb = [Math]::Round($drive.Free / 1GB)
Write-Host "  Disk: $diskFreeGb GB free on $($drive.Name):, where Hyper-V keeps disks ($vhdDir). The box's disk grows to about 60-90 GB, $DiskGB GB at most"
if (-not $existing -and $diskFreeGb -lt 100) { Stop-With "$($drive.Name): has $diskFreeGb GB free; keep at least 100 GB free for the box. Move Hyper-V's disk folder (Hyper-V Settings) or free some space." }
if (-not $existing -and (Test-Path $vhdPath)) { Stop-With "a disk from an earlier try is at $vhdPath, with no VM. Delete it (Remove-Item '$vhdPath') and run this again." }
if (-not (Get-VMSwitch -Name $Switch -ErrorAction SilentlyContinue)) { Stop-With "there is no Hyper-V switch '$Switch'. Pass -Switch with one of: $((Get-VMSwitch).Name -join ', ')" }
if (-not $existing -and -not $CheckOnly -and -not $IsoPath) { Stop-With 'pass -IsoPath with the Windows 11 ISO you downloaded.' }
if (-not $existing -and $IsoPath -and -not (Test-Path $IsoPath)) { Stop-With "no ISO at $IsoPath. Download the Windows 11 disk image (ISO) from Microsoft's Windows 11 download page." }
$cpusHere = (Get-CimInstance Win32_Processor | Measure-Object NumberOfLogicalProcessors -Sum).Sum
Write-Host "  Processors: $cpusHere logical; the box gets $Cpus, capped at 75% of them, at a low weight"
$guestFiles = 'guest-setup.ps1', 'stay-signed-in.ps1', 'add-scheme.ps1', 'screen-lock.ps1' | ForEach-Object { Join-Path $PSScriptRoot $_ }
foreach ($f in $guestFiles) { if (-not (Test-Path $f)) { Stop-With "$f is missing: run this from the kit's folder (tools\win-test-box)." } }
if ($CheckOnly) {
  Say 'Checks passed. Without -CheckOnly it would:'
  if ($existing) { Write-Host "  find the VM '$Name' already there and wait for its guest setup" }
  else { Write-Host "  apply '$Edition' from $IsoPath to $vhdPath, create the VM '$Name' ($Cpus vCPUs, $MemoryGB GB, ${Width}x$Height at 125%), start it and wait for its guest setup" }
  exit 0
}

# The guest's sign-in. Printed once at the end; Hyper-V's VM window is where it's ever typed.
$credFile = Join-Path $PSScriptRoot "$Name.password.txt"

if (-not $existing) {
  # ---------- 2. Windows onto a new disk ----------
  Say "Reading $IsoPath"
  $iso = Mount-DiskImage -ImagePath (Resolve-Path $IsoPath) -PassThru
  try {
    $isoLetter = ($iso | Get-Volume).DriveLetter
    $image = @('install.wim', 'install.esd') | ForEach-Object { "${isoLetter}:\sources\$_" } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $image) { Stop-With 'that ISO has no sources\install.wim or install.esd; use the Windows 11 ISO from Microsoft.' }
    $index = (Get-WindowsImage -ImagePath $image | Where-Object ImageName -eq $Edition).ImageIndex
    if (-not $index) { Stop-With "the ISO has no '$Edition'. It has: $((Get-WindowsImage -ImagePath $image).ImageName -join ', ')" }

    Say "Making $vhdPath ($DiskGB GB, grows as it fills)"
    $vhd = New-VHD -Path $vhdPath -SizeBytes ($DiskGB * 1GB) -Dynamic
    $disk = $vhd | Mount-VHD -PassThru | Get-Disk
    try {
      Initialize-Disk -Number $disk.Number -PartitionStyle GPT
      $efi = New-Partition -DiskNumber $disk.Number -Size 260MB -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}' -AssignDriveLetter
      Format-Volume -Partition $efi -FileSystem FAT32 -NewFileSystemLabel System -Confirm:$false | Out-Null
      New-Partition -DiskNumber $disk.Number -Size 16MB -GptType '{e3c9e316-0b5c-4db8-817d-f92df00215ae}' | Out-Null
      $win = New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
      Format-Volume -Partition $win -FileSystem NTFS -NewFileSystemLabel Windows -Confirm:$false | Out-Null
      # Re-read: the objects New-Partition returns don't always carry the letter yet.
      $w = "$((Get-Partition -DiskNumber $disk.Number -PartitionNumber $win.PartitionNumber).DriveLetter):"
      $s = "$((Get-Partition -DiskNumber $disk.Number -PartitionNumber $efi.PartitionNumber).DriveLetter):"
      if ($w -eq ':' -or $s -eq ':') { throw 'Windows gave the new disk no drive letters' }

      Say "Applying $Edition (about 10 minutes)"
      Expand-WindowsImage -ImagePath $image -Index $index -ApplyPath "$w\" | Out-Null
      # The image's own bcdboot can fail from the host (0xC0E90002 on a 26200 host with a 26300 image);
      # fall back to this PC's, and show bcdboot's own words if both fail.
      # bcdboot writes warnings to stderr (e.g. "BFSVC Warning: FveOpenVolumeByHandle" on a BitLocker
      # host); under 'Stop' PowerShell 5.1 turns those into a terminating error, so judge by exit code only.
      $ErrorActionPreference = 'Continue'
      $bcdOut = & "$w\Windows\System32\bcdboot.exe" "$w\Windows" /s $s /f UEFI /v 2>&1 | ForEach-Object { "$_" }
      $bcdCode = $LASTEXITCODE
      if ($bcdCode) {
        Write-Host ("  the image's bcdboot failed (0x{0:X8}); trying this PC's" -f $bcdCode)
        $bcdOut = & "$env:SystemRoot\System32\bcdboot.exe" "$w\Windows" /s $s /f UEFI /v 2>&1 | ForEach-Object { "$_" }
        $bcdCode = $LASTEXITCODE
      }
      $ErrorActionPreference = 'Stop'
      if ($bcdCode) { throw ("bcdboot failed (0x{0:X8}):`n{1}" -f $bcdCode, ($bcdOut | Out-String)) }
      Write-Host "  boot files written"

      Say 'Writing the unattend file and the guest scripts'
      $bytes = New-Object byte[] 18
      [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $password = 'Cb-' + ([Convert]::ToBase64String($bytes) -replace '[+/=]', 'x')
      Set-Content -Path $credFile -Value $password -Encoding ASCII
      $tz = (Get-TimeZone).Id
      $locale = (Get-Culture).Name
      $xmlPassword = [Security.SecurityElement]::Escape($password)
      $arch = 'processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"'
      $unattend = @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" $arch>
      <ComputerName>CITADEL-BOX</ComputerName>
      <TimeZone>$tz</TimeZone>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" $arch>
      <InputLocale>$locale</InputLocale>
      <SystemLocale>$locale</SystemLocale>
      <UILanguage>$locale</UILanguage>
      <UserLocale>$locale</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" $arch>
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>citadel</Name>
            <Group>Administrators</Group>
            <Password><Value>$xmlPassword</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <Username>citadel</Username>
        <Password><Value>$xmlPassword</Value><PlainText>true</PlainText></Password>
        <LogonCount>999</LogonCount>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <CommandLine>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\citadel-box\guest-setup.ps1</CommandLine>
          <Description>Citadel test box setup</Description>
        </SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
"@
      New-Item -ItemType Directory -Force "$w\Windows\Panther", "$w\citadel-box" | Out-Null
      Set-Content -Path "$w\Windows\Panther\unattend.xml" -Value $unattend -Encoding UTF8
      Copy-Item $guestFiles "$w\citadel-box\"
      # guest-setup.ps1 keeps the box signing in for good with this; the unattend file is deleted there.
      Set-Content -Path "$w\citadel-box\autologon.txt" -Value $password -Encoding ASCII
    } finally {
      Dismount-VHD -Path $vhdPath
    }
  } finally {
    Dismount-DiskImage -ImagePath (Resolve-Path $IsoPath) | Out-Null
  }

  # ---------- 3. the VM ----------
  Say "Creating the VM '$Name'"
  $vm = New-VM -Name $Name -Generation 2 -MemoryStartupBytes ($MemoryGB * 1GB) -VHDPath $vhdPath -SwitchName $Switch
  Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
  Set-VMProcessor -VM $vm -Count $Cpus -Maximum 75 -RelativeWeight 50
  Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
  Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
  Enable-VMTPM -VM $vm
  Set-VMVideo -VM $vm -HorizontalResolution $Width -VerticalResolution $Height -ResolutionType Single
  # Checkpoints would keep old disks around; the box is rebuilt, not rolled back.
  Set-VM -VM $vm -AutomaticStartAction Start -AutomaticStartDelay 120 -AutomaticStopAction ShutDown -CheckpointType Disabled -AutomaticCheckpointsEnabled $false
  Start-VM -VM $vm
}

# ---------- 4. wait for the guest ----------
if (-not (Test-Path $credFile)) { Stop-With "the box's password file $credFile is gone, so this can't reach the guest. Run remove-test-box.ps1 and start again." }
$password = (Get-Content $credFile -Raw).Trim()
$cred = New-Object Management.Automation.PSCredential('citadel', (ConvertTo-SecureString $password -AsPlainText -Force))
if ((Get-VM -Name $Name).State -ne 'Running') { Start-VM -Name $Name }
Say 'Waiting for Windows to set itself up and guest-setup.ps1 to finish (20-40 minutes; it restarts the box once)'
$deadline = (Get-Date).AddMinutes(60)
$said = ''
while ($true) {
  try {
    $state = Invoke-Command -VMName $Name -Credential $cred -ErrorAction Stop -ScriptBlock {
      if (Test-Path C:\citadel-box\guest-setup.done) { 'done' }
      elseif (Test-Path C:\citadel-box\guest-setup.failed) { 'failed: ' + (Get-Content C:\citadel-box\guest-setup.failed -Raw) }
      else { (Get-Content C:\citadel-box\guest-setup.log -Tail 1 -ErrorAction SilentlyContinue) }
    }
  } catch { $state = 'starting up' }
  if ($state -eq 'done') { break }
  if ($state -like 'failed:*') { Stop-With "guest-setup.ps1 $state. Its log: C:\citadel-box\guest-setup.log in the box. Fix it and run guest-setup.ps1 again there (as administrator)." }
  if ($state -and $state -ne $said) { Write-Host "  $state"; $said = $state }
  if ((Get-Date) -gt $deadline) { Stop-With "the guest isn't done after an hour (last: $said). Open the box's window in Hyper-V Manager to see why, then run this script again to keep waiting." }
  Start-Sleep -Seconds 20
}

Say 'The box is up'
Write-Host @"
  VM: $Name ($Cpus vCPUs, $MemoryGB GB, ${Width}x$Height at 125%, rounded corners forced on), starts 2 minutes after this PC.
  Its sign-in: citadel / $password
  Keep that in your password manager, then delete $credFile.

Next (README.md, steps 5-8), in the box's window (Hyper-V Manager, Connect):
  5. Sign Tailscale in (its tray icon).
  6. On Citadel's Machines page, add the machine '$Name', paste its Windows lines into PowerShell in the box.
  7. For each scheme: PowerShell as administrator in the box, C:\citadel-box\add-scheme.ps1 -Repo <owner/repo>
  8. Close the window. Never sign out of the box or lock it.
Restart the box only from inside it (Restart-Computer). Never Restart-VM -Force or a plain Restart-VM: that is a hard reset.
"@
