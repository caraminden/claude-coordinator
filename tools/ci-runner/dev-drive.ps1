<#
.SYNOPSIS
  Moves Peek Auras' build runners' work folders onto a Dev Drive and back (#1344).
.DESCRIPTION
  Cara, 2026-11-20 16:37 PST: "G. Dev Drive on the desktop: Go". The runbook is tools/ci-runner/README.md, "A Dev
  Drive for Peek's build runners". Run it in an elevated PowerShell on Cara's desktop. -Do picks the step:
    Check        changes nothing: Dev Drive support, R:, free room on C:, the four runner services.
    MakeDrive    makes C:\DevDrive\ci-runners.vhdx (200 GB, grows as it fills), formats it as a Dev Drive on R:, and
                 registers a SYSTEM task that attaches it at boot.
    Move         for each -Runner: waits for its job to end, stops it, copies _work, cargo, rustup and mise to
                 R:\peek-auras-<n>, renames each old folder to <name>.pre-devdrive, leaves a junction at the old path,
                 and starts the runner again, error or not. Run it again after a stop and it carries on.
    Back         for each -Runner: the junctions go and the .pre-devdrive folders take their names back.
    Cleanup      for each -Runner: deletes the .pre-devdrive folders whose junction is in place. Back can't run after.
    RemoveDrive  once no runner points at R:: the boot task goes, the disk detaches and its file is deleted.
    Attach       attaches the disk by hand (after a power cut the task missed).
  It only knows Peek Auras' four build runners, so it can't touch another scheme's. It never restarts the PC.
  -Test runs Move, Back and Cleanup on a made-up layout (-Base, -DriveRoot) with no services, Defender or drive checks.
#>
param(
  [Parameter(Mandatory)][ValidateSet('Check', 'MakeDrive', 'Move', 'Back', 'Cleanup', 'RemoveDrive', 'Attach')][string]$Do,
  [ValidateSet('DESKTOP-G248IJ8', 'DESKTOP-G248IJ8-2', 'DESKTOP-G248IJ8-3', 'DESKTOP-G248IJ8-4')][string[]]$Runner = @(),
  [string]$Base = 'C:\actions-runner-peek-auras',
  [string]$DriveRoot = 'R:\',
  [switch]$Test
)
$ErrorActionPreference = 'Stop'
$vhd = 'C:\DevDrive\ci-runners.vhdx'
$task = 'Attach CI Dev Drive'
$folders = '_work', 'cargo', 'rustup', 'mise'

function Get-RunnerPath([string]$name) {
  $suffix = $name -replace '^DESKTOP-G248IJ8', ''
  [pscustomobject]@{
    Name = $name
    Folder = "$Base$suffix"
    Drive = Join-Path $DriveRoot ('peek-auras' + $(if ($suffix) { $suffix } else { '-1' }))
    Service = "actions.runner.caraminden-peek-auras.$name"
  }
}

function Assert-Ready([bool]$needDrive) {
  if ($Test) { return }
  # keep-runners.ps1 starts stopped runner services in the first 30 minutes after a boot, which would race a move.
  $up = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
  if ($up.TotalMinutes -lt 31) { throw "The PC started $([int]$up.TotalMinutes) minutes ago: wait until 31 minutes have passed, so nothing restarts a stopped runner mid-move" }
  if (-not $needDrive) { return }  # Back works with R: gone, which is when it's needed most
  $v = Get-Volume -DriveLetter R -ErrorAction SilentlyContinue
  if (-not $v -or $v.FileSystemLabel -ne 'ci-runners' -or $v.FileSystemType -ne 'ReFS') { throw "R: isn't the ci-runners Dev Drive: run -Do MakeDrive, or -Do Attach after a power cut" }
}

function Stop-Runner($p) {
  if ($Test) { return }
  Get-Service $p.Service | Out-Null
  while (Get-CimInstance Win32_Process -Filter "Name='Runner.Worker.exe'" | Where-Object ExecutablePath -like "$($p.Folder)\*") {
    "$($p.Name): a job is running, waiting"; Start-Sleep 20
  }
  Stop-Service $p.Service
}

function Start-Runner($p) { if (-not $Test) { Start-Service $p.Service; "$($p.Name): started" } }

function Move-Runner($p) {
  if (-not (Test-Path $p.Folder)) { throw "$($p.Folder) doesn't exist" }
  Stop-Runner $p
  try {
    New-Item -ItemType Directory -Force $p.Drive | Out-Null
    if (-not $Test) {
      icacls $p.Drive /grant '*S-1-5-20:(OI)(CI)F' | Out-Null  # NETWORK SERVICE, which the runner runs as
      if ($LASTEXITCODE) { throw "icacls failed ($LASTEXITCODE)" }
      Add-MpPreference -ExclusionPath $p.Drive  # Defender skips the old folders already (#286), so the trial measures the drive alone
    }
    foreach ($f in $folders) {
      $live = Join-Path $p.Folder $f; $old = "$live.pre-devdrive"; $new = Join-Path $p.Drive $f
      $i = Get-Item $live -Force -ErrorAction SilentlyContinue
      if ($i -and $i.LinkType) { "$($p.Name): $f already moved"; continue }
      if (-not $i -and (Test-Path $old)) {
        if (-not (Test-Path $new)) { throw "${f} is only at ${old}: rename it back to $f by hand" }
        New-Item -ItemType Junction -Path $live -Target $new | Out-Null; "$($p.Name): $f linked"; continue
      }
      if (-not $i) { "$($p.Name): no $f, skipping"; continue }
      if (Test-Path $old) { throw "$old is already there: move it aside by hand first" }
      # owners kept (git refuses a checkout NETWORK SERVICE doesn't own); /B needs the admin's backup right, which -Test may lack
      if (Test-Path $new) {  # left from a move before a Back: start clean, so files deleted since don't come back
        cmd /c rmdir /s /q "$new"; if (Test-Path $new) { throw "couldn't clear the old copy $new" }
      }
      $keep = if ($Test) { @('/COPY:DAT') } else { @('/COPY:DATO', '/B') }
      robocopy $live $new /E $keep /DCOPY:DAT /SJ /SL /MT:16 /R:1 /W:1 /NFL /NDL /NP | Select-Object -Last 12
      if ($LASTEXITCODE -ge 8) { throw "copying $f failed (robocopy $LASTEXITCODE); $f is untouched" }
      Rename-Item $live (Split-Path $old -Leaf)
      try { New-Item -ItemType Junction -Path $live -Target $new | Out-Null }
      catch { Rename-Item $old $f; throw }
      "$($p.Name): $f moved"
    }
  } finally { Start-Runner $p }
}

function Move-Back($p) {
  Stop-Runner $p
  try {
    foreach ($f in $folders) {
      $live = Join-Path $p.Folder $f; $old = "$live.pre-devdrive"
      $i = Get-Item $live -Force -ErrorAction SilentlyContinue
      if ($i -and -not $i.LinkType) { "$($p.Name): $f is not moved"; continue }
      if (-not (Test-Path $old)) {
        if ($i) { throw "$old is gone (cleaned up): $f stays on the Dev Drive" }
        "$($p.Name): no $f, skipping"; continue
      }
      if ($i) { cmd /c rmdir "$live"; if (Test-Path $live) { throw "removing the junction $live failed" } }  # removes the link only
      Rename-Item $old $f
      "$($p.Name): $f back"
    }
  } finally { Start-Runner $p }
  if (-not $Test) { Remove-MpPreference -ExclusionPath $p.Drive }
}

function Remove-Old($p) {
  foreach ($f in $folders) {
    $live = Join-Path $p.Folder $f; $old = "$live.pre-devdrive"; $new = Join-Path $p.Drive $f
    if (-not (Test-Path $old)) { continue }
    $i = Get-Item $live -Force -ErrorAction SilentlyContinue
    if (-not $i -or $i.LinkType -ne 'Junction' -or "$($i.Target)".TrimEnd('\') -ne $new.TrimEnd('\')) { throw "${live} isn't the junction to ${new}: keeping $old" }
    cmd /c rmdir /s /q "$old"  # rmdir removes links inside without following them, unlike Remove-Item in PowerShell 5.1
    if (Test-Path $old) { throw "$old is still there" }
    "$($p.Name): deleted $f.pre-devdrive"
  }
}

function Mount-Drive {
  if (-not (Get-DiskImage -ImagePath $vhd).Attached) { Mount-DiskImage -ImagePath $vhd | Out-Null }
  Get-Volume -DriveLetter R | Format-Table DriveLetter, FileSystemLabel, FileSystemType, SizeRemaining, Size
}

switch ($Do) {
  'Check' {
    fsutil devdrv query
    $v = Get-Volume -DriveLetter R -ErrorAction SilentlyContinue
    if ($v) { "R: is taken: $($v.FileSystemLabel) $($v.FileSystemType) (fine only if it says ci-runners ReFS)" } else { 'R: is free' }
    $free = [math]::Round((Get-PSDrive C).Free / 1GB)
    $size = [math]::Round(((Get-ChildItem "$Base-2" -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum) / 1GB)
    "C: has $free GB free; runner -2 holds $size GB, so the trial needs about $($size + 20) GB"
    Get-Service actions.runner.caraminden-peek-auras.* | Format-Table Name, Status, StartType
  }
  'MakeDrive' {
    if (-not (Get-Command Format-Volume).Parameters.ContainsKey('DevDrive')) { throw "This Windows can't make a Dev Drive (it needs Windows 11 22621.2338 or later)" }
    if (Test-Path $vhd) { throw "$vhd already exists" }
    if (Get-Volume -DriveLetter R -ErrorAction SilentlyContinue) { throw 'R: is taken' }
    New-Item -ItemType Directory -Force (Split-Path $vhd) | Out-Null
    Set-Content "$env:TEMP\devdrive.txt" "create vdisk file=$vhd maximum=204800 type=expandable`r`nattach vdisk" -Encoding ascii
    diskpart /s "$env:TEMP\devdrive.txt"
    if ($LASTEXITCODE) { throw "diskpart failed ($LASTEXITCODE)" }
    $disk = Get-DiskImage -ImagePath $vhd | Get-Disk
    if ($disk.BusType -ne 'File Backed Virtual' -or $disk.PartitionStyle -ne 'RAW') { throw "disk $($disk.Number) is not the new empty virtual disk: stopping before any format" }
    Initialize-Disk -Number $disk.Number -PartitionStyle GPT
    $dev = @{ DevDrive = $true }  # splatted: the lint's Windows 10 profiles lack -DevDrive; the check above refuses a Windows without it
    New-Partition -DiskNumber $disk.Number -UseMaximumSize -DriveLetter R | Out-Null
    Format-Volume -DriveLetter R @dev -FileSystemLabel ci-runners -Confirm:$false | Out-Null  # piping the partition in fails to bind on 26100
    $act = New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -Command `"if (-not (Get-DiskImage -ImagePath $vhd).Attached) { Mount-DiskImage -ImagePath $vhd }`""
    Register-ScheduledTask -TaskName $task -Action $act -Trigger (New-ScheduledTaskTrigger -AtStartup) -User SYSTEM -RunLevel Highest | Out-Null
    fsutil devdrv query R:
  }
  'Attach' { Mount-Drive; Get-ScheduledTaskInfo -TaskName $task | Format-List LastRunTime, LastTaskResult }
  'RemoveDrive' {
    foreach ($n in 'DESKTOP-G248IJ8', 'DESKTOP-G248IJ8-2', 'DESKTOP-G248IJ8-3', 'DESKTOP-G248IJ8-4') {
      $p = Get-RunnerPath $n
      foreach ($f in $folders) { if ((Get-Item (Join-Path $p.Folder $f) -Force -ErrorAction SilentlyContinue).LinkType) { throw "$n's $f still points at R:: run -Do Back first" } }
    }
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
    if ((Get-DiskImage -ImagePath $vhd).Attached) { Dismount-DiskImage -ImagePath $vhd | Out-Null }
    Remove-Item $vhd
    if (-not (Get-ChildItem (Split-Path $vhd) -Force)) { Remove-Item (Split-Path $vhd) }
    'The Dev Drive is gone'
  }
  default {
    if (-not $Runner) { throw "-Do $Do needs -Runner" }
    Assert-Ready ($Do -ne 'Back')
    foreach ($n in $Runner) {
      $p = Get-RunnerPath $n
      switch ($Do) { 'Move' { Move-Runner $p } 'Back' { Move-Back $p } 'Cleanup' { Remove-Old $p } }
    }
  }
}
