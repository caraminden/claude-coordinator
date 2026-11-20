<#
.SYNOPSIS
  The test box's GPU switch (#1175): the box's share of Cara's GPU (a Hyper-V GPU partition, put on
  by gpu-host.ps1) stays turned off inside the box, so everything draws in software (WARP) exactly as
  before, and is on only while a job that asked for it runs.

.DESCRIPTION
  Runs in the box. gpu-host.ps1 copies it to C:\citadel-box and runs -Install there.
    -Run '<command line>'  a job that wants the GPU: turns it on, runs the PowerShell command line
                           (in a child powershell.exe, like the run task), and lets it go off again.
                           The workspaces' run-gpu task is this. Not elevated.
    -Check                 the GPU's state, who wants it, and the Direct3D adapters an app sees, the
                           first being the one it gets by default. Not elevated.
    -Install               as administrator, once and after each gpu-host.ps1: the 'Citadel GPU'
                           task, the GPU off, and a run-gpu task in every workspace.
    -Sync                  the 'Citadel GPU' task itself (elevated): the GPU on while a live job
                           wants it, off as soon as none does, then it exits.
  A job's ask is a file C:\citadel-box\gpu-want\<pid> holding that process's start time. A job that
  is killed leaves its file, but its pid is gone, so the next look turns the GPU off; a file over 2
  hours old counts as gone too.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\citadel-box\gpu.ps1 -Run 'cargo test --test gpu_timing'
#>
[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
  [Parameter(ParameterSetName = 'Run', Mandatory)][string]$Run,
  [Parameter(ParameterSetName = 'Check')][switch]$Check,
  [Parameter(ParameterSetName = 'Install', Mandatory)][switch]$Install,
  [Parameter(ParameterSetName = 'Sync', Mandatory)][switch]$Sync
)
$ErrorActionPreference = 'Stop'
$box = 'C:\citadel-box'
$wantDir = "$box\gpu-want"
$log = "$box\gpu.log"
$taskName = 'Citadel GPU'

function Add-GpuLog([string]$Text) {
  Add-Content -Path $log -Value "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) $Text"
  if ((Get-Item $log).Length -gt 1MB) { Get-Content $log -Tail 2000 | Set-Content "$log.tmp"; Move-Item -Force "$log.tmp" $log }
}

# The GPU partition's device in the box: a Display device that isn't one of Microsoft's own (Hyper-V
# Video drives the screen; the partition shows as a render device named after the host's GPU).
function Get-Gpu { @(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -notlike 'Microsoft *' }) }
function Test-GpuOn { @(Get-Gpu | Where-Object Status -eq 'OK').Count -gt 0 }

# The live asks: a pid still running with the same start time, under 2 hours old. Dead ones are deleted.
function Get-Want {
  if (-not (Test-Path $wantDir)) { return @() }
  @(Get-ChildItem $wantDir -File | Where-Object {
    $p = $null
    if ($_.Name -match '^\d+$') { $p = Get-Process -Id ([int]$_.Name) -ErrorAction SilentlyContinue }
    # A file it can't read yet counts as the job's: an error here would end Sync with the GPU left on.
    $same = try { "$($p.StartTime.Ticks)" -eq "$(Get-Content $_.FullName -Raw)".Trim() } catch { $true }
    $live = $p -and $_.LastWriteTime -gt (Get-Date).AddHours(-2) -and $same
    if (-not $live) { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
    $live
  })
}

function Get-Adapter {
  if (-not ('CitadelDxgi' -as [type])) {
    # C# 5: Windows PowerShell's compiler. Only the vtable slots up to the ones called need to exist.
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CitadelDxgi {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Desc1 {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
  }
  [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIAdapter1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumOutputs(); void GetDesc(); void CheckInterfaceSupport();
    [PreserveSig] int GetDesc1(out Desc1 desc);
  }
  [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDXGIFactory1 {
    void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
    void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter();
    [PreserveSig] int EnumAdapters1(uint index, out IDXGIAdapter1 adapter);
  }
  [DllImport("dxgi.dll")]
  static extern int CreateDXGIFactory1([In] ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IDXGIFactory1 factory);
  public static List<string> List() {
    Guid g = typeof(IDXGIFactory1).GUID;
    IDXGIFactory1 f;
    int hr = CreateDXGIFactory1(ref g, out f);
    if (hr != 0) throw new Exception("CreateDXGIFactory1 failed: 0x" + hr.ToString("X8"));
    List<string> r = new List<string>();
    for (uint i = 0; ; i++) {
      IDXGIAdapter1 a;
      hr = f.EnumAdapters1(i, out a);
      if (hr == unchecked((int)0x887A0002)) break;
      if (hr != 0) throw new Exception("EnumAdapters1 failed: 0x" + hr.ToString("X8"));
      Desc1 d;
      hr = a.GetDesc1(out d);
      Marshal.ReleaseComObject(a);
      if (hr != 0) throw new Exception("GetDesc1 failed: 0x" + hr.ToString("X8"));
      // Microsoft's (vendor 1414) are the CPU: Basic Render says "hardware" but draws with WARP.
      r.Add(string.Format("{0} ({1}, {2} MB of its own memory)", d.Description,
        d.VendorId == 0x1414 ? "software, on the CPU" : "hardware, vendor " + d.VendorId.ToString("X4"), (ulong)d.DedicatedVideoMemory / 1048576));
    }
    Marshal.ReleaseComObject(f);
    return r;
  }
}
'@
  }
  [CitadelDxgi]::List()
}

function Show-State {
  $gpu = Get-Gpu
  if (-not $gpu) { Write-Host 'GPU: none. This box has no GPU partition (gpu-host.ps1 on the host adds it), so it draws in software.' }
  foreach ($d in $gpu) { Write-Host "GPU: $($d.FriendlyName), $(if ($d.Status -eq 'OK') { 'on' } else { "off ($($d.Status))" })" }
  $want = Get-Want
  Write-Host "Asked for by: $(if ($want) { ($want | ForEach-Object { "pid $($_.Name) since $($_.LastWriteTime.ToString('HH:mm:ss'))" }) -join ', ' } else { 'no job' })"
  Write-Host 'Direct3D adapters (an app gets the first by default):'
  $i = 0
  foreach ($a in Get-Adapter) { Write-Host "  $i. $a"; $i++ }
}

switch ($PSCmdlet.ParameterSetName) {
  'Check' { Show-State; exit 0 }

  'Sync' {
    # One instance at a time (the task's IgnoreNew); it stays while a job wants the GPU, polling, and
    # turns it off and exits once none does. The 3 h is the task's own limit too.
    $until = (Get-Date).AddHours(3)
    while ((Get-Date) -lt $until) {
      $want = @(Get-Want).Count -gt 0
      foreach ($d in Get-Gpu) {
        try {
          if ($want -and $d.Status -ne 'OK') { Enable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false; Add-GpuLog "on: $($d.FriendlyName) for $((Get-Want).Name -join ', ')" }
          elseif (-not $want -and $d.Status -eq 'OK') { Disable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false; Add-GpuLog "off: $($d.FriendlyName)" }
        } catch { Add-GpuLog "couldn't turn $($d.FriendlyName) $(if ($want) { 'on' } else { 'off' }): $_" }
      }
      # A job that asked between the look above and now gets another round instead of a dead end.
      if (-not $want -and @(Get-Want).Count -eq 0) { exit 0 }
      Start-Sleep -Seconds 3
    }
    Add-GpuLog 'gave up after 3 hours; the next ask starts it again'
    exit 0
  }

  'Install' {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { throw 'gpu.ps1 -Install needs PowerShell as administrator in the box (gpu-host.ps1 runs it that way).' }
    New-Item -ItemType Directory -Force $wantDir | Out-Null
    # Jobs run as citadel, not elevated: they need to write their ask.
    & icacls.exe $wantDir /grant '*S-1-5-11:(OI)(CI)M' | Out-Null

    # Turning a device on or off needs administrator. The task runs elevated as the signed-in user
    # (S4U: no window on the box's screen, no stored password), and a job starts it with schtasks /run:
    # a task's author may run it from an unelevated prompt too.
    $user = "$env:COMPUTERNAME\$env:USERNAME"
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $box\gpu.ps1 -Sync"
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    $sid = ([Security.Principal.NTAccount]$user).Translate([Security.Principal.SecurityIdentifier]).Value
    $svc = New-Object -ComObject Schedule.Service
    $svc.Connect()
    $svc.GetFolder('\').GetTask($taskName).SetSecurityDescriptor("D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;$sid)", 0)
    Write-Host "  task '$taskName' registered (runs elevated as $user, started by jobs that ask)"

    # Off now, unless a job is asking.
    if (-not @(Get-Want).Count) {
      foreach ($d in Get-Gpu | Where-Object Status -eq 'OK') { Disable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false; Add-GpuLog "off: $($d.FriendlyName) (install)" }
    }

    # A run-gpu task in every workspace: the run task's command with this script in front.
    $config = "$env:USERPROFILE\coordinator-agent\machine-agent.json"
    if (Test-Path $config) {
      $env:CC_BOX_GPU = @'
const fs = require('fs');
const [file] = process.argv.slice(1);
const c = JSON.parse(fs.readFileSync(file, 'utf8'));
const names = [];
for (const [name, w] of Object.entries(c.workspaces || {})) {
  const run = w.tasks && w.tasks.run && w.tasks.run.run;
  if (!Array.isArray(run)) continue;
  const mise = run[0] === 'mise' ? ['mise', 'exec', '--'] : [];
  w.tasks['run-gpu'] = { run: [...mise, 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\citadel-box\\gpu.ps1', '-Run'], args: true, about: 'like run, with the GPU on (real Direct3D hardware) while it runs; run draws in software' };
  names.push(name);
}
fs.writeFileSync(file, JSON.stringify(c, null, 2));
console.log(names.join(', ') || 'none');
'@
      $names = & node -e 'eval(process.env.CC_BOX_GPU)' $config
      $code = $LASTEXITCODE
      Remove-Item Env:CC_BOX_GPU
      if ($code) { throw "Could not write $config" }
      Write-Host "  run-gpu task added to workspaces: $names"
    } else {
      Write-Host "  no $config yet: add-scheme.ps1 adds run-gpu with each scheme"
    }
    Show-State
    exit 0
  }

  'Run' {
    $gpu = Get-Gpu
    if (-not $gpu) { Write-Host 'This box has no GPU partition, so there is no GPU to turn on. Nothing was run.'; exit 2 }
    New-Item -ItemType Directory -Force $wantDir | Out-Null
    $ask = "$wantDir\$PID"
    # Written whole, then moved in: Sync never sees it half-written.
    $tmp = [IO.Path]::GetTempFileName()
    Set-Content -Path $tmp -Value (Get-Process -Id $PID).StartTime.Ticks
    Move-Item $tmp $ask -Force
    try {
      $until = (Get-Date).AddSeconds(90)
      $kicked = [datetime]::MinValue
      # Still on 5 s later: a Sync that looked just before this ask may switch it off once more (and on
      # again a round later), and the job shouldn't start in between.
      while ($true) {
        if (Test-GpuOn) { Start-Sleep -Seconds 5; if (Test-GpuOn) { break } }
        if ((Get-Date) -gt $until) {
          Write-Host "The GPU didn't come on in 90 s: $((Get-Gpu | ForEach-Object { "$($_.FriendlyName) $($_.Status)" }) -join ', '). Nothing was run. The box's C:\citadel-box\gpu.log says why."
          exit 3
        }
        if (((Get-Date) - $kicked).TotalSeconds -ge 10) {
          $out = & schtasks.exe /run /tn "\$taskName" 2>&1
          if ($LASTEXITCODE) { Write-Host "Couldn't start the '$taskName' task: $out. Nothing was run. Run gpu.ps1 -Install in the box again (as administrator)."; exit 3 }
          $kicked = Get-Date
        }
        Start-Sleep -Seconds 1
      }
      Write-Host "GPU on. Direct3D's default adapter: $((Get-Adapter)[0])"
      # -EncodedCommand: Windows PowerShell 5.1 mangles quotes inside a native argument.
      $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Run))
      & powershell.exe -NoProfile -NonInteractive -EncodedCommand $encoded
      $code = $LASTEXITCODE
    } finally {
      # The task sees no ask left and turns the GPU off within a few seconds.
      Remove-Item $ask -Force -ErrorAction SilentlyContinue
    }
    exit $code
  }
}
