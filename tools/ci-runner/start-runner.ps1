# Citadel's session-mode runner launcher (#370), copied from Peek Auras' tools/ci-win/runner.ps1 (caraminden/peek-auras
# at d6879f7, which grew it from Delve's tools/perf-runner.ps1); only these header lines changed.
# add-runner.ps1 -Session copies it into the runner's folder as start-runner.ps1 (this file's own name), and a logon
# task runs it while the user who ran add-runner.ps1 is logged on:
#   conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File <dir>\start-runner.ps1 -Desktop <name>
# It makes a desktop of its own that is never shown (named after the runner's label), so every window and console a
# job opens lands there, never on the user's screen or taskbar, and never takes focus, while it still runs in their
# session on their GPU. With -Desktop Default (add-runner.ps1 -Visible) it runs on the user's own desktop instead,
# which always exists, so it makes none and only the windows' place changes. A hidden desktop can't be read or
# captured, so a scheme whose tests read the screen needs -Visible and an unlocked session (tools/ci-runner/README.md).
# It starts run.cmd there, waits on it and starts it again a minute after it ends, whatever its
# exit code (the task restarts only on a failure, and run.cmd can end with 0). Each step goes to
# <dir>\launcher.log and run.cmd's own output to <dir>\runner-console.log, since nothing here is
# ever seen: no "start" line after the task ran means PowerShell never reached this script.
# shortcut: both logs grow without bound (a few lines per start, one per job); trim them by hand if
# they ever get big.
param([string]$Runner = $PSScriptRoot, [string]$Desktop)
if (-not $Runner) { $Runner = Split-Path -Parent $MyInvocation.MyCommand.Path }
$log = Join-Path $Runner 'launcher.log'
function Log([string]$Text) { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Text" }
Log "start: pid $PID, $env:USERDOMAIN\$env:USERNAME, session $((Get-Process -Id $PID).SessionId), PowerShell $($PSVersionTable.PSVersion), desktop '$Desktop', runner $Runner"
trap { Log "error: $($_.Exception.GetType().Name): $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"; exit 1 }
$ErrorActionPreference = 'Stop'
if (-not $Desktop) { throw 'No -Desktop given.' }
if (-not (Test-Path (Join-Path $Runner 'run.cmd'))) { throw "No run.cmd in $Runner." }

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class HiddenDesktop
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devMode, int flags, uint access, IntPtr attributes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string app, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    // Held for the launcher's life: a desktop lasts while a handle to it or a process on it does.
    private static IntPtr desk;

    /// <summary>Makes (or opens) the named desktop; throws with Windows' error code if it can't.</summary>
    public static void Open(string desktop)
    {
        const uint GenericAll = 0x10000000;
        if (desk == IntPtr.Zero) desk = CreateDesktop(desktop, IntPtr.Zero, IntPtr.Zero, 0, GenericAll, IntPtr.Zero);
        if (desk == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktop(" + desktop + ") failed");
    }

    /// <summary>Starts a command on the desktop and returns its process handle; throws with Windows' error code if it can't.</summary>
    public static IntPtr Start(string desktop, string commandLine, string directory, out int pid)
    {
        var startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), lpDesktop = @"WinSta0\" + desktop };
        ProcessInformation process;
        if (!CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, directory, ref startup, out process))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess on WinSta0\\" + desktop + " failed");
        CloseHandle(process.hThread);
        pid = process.dwProcessId;
        return process.hProcess;
    }

    /// <summary>Waits for the process to end, closes its handle and returns its exit code.</summary>
    public static uint Wait(IntPtr process)
    {
        WaitForSingleObject(process, 0xFFFFFFFF);
        uint code;
        bool got = GetExitCodeProcess(process, out code);
        int error = Marshal.GetLastWin32Error();
        CloseHandle(process);
        if (!got) throw new Win32Exception(error, "GetExitCodeProcess failed");
        return code;
    }
}
'@

if ($Desktop -eq 'Default') { Log 'desktop WinSta0\Default: the user''s own' }
else { [HiddenDesktop]::Open($Desktop); Log "desktop WinSta0\$Desktop is open" }
# cmd strips the outer quotes, leaving: "<dir>\run.cmd" >> "<dir>\runner-console.log" 2>&1
$command = "cmd.exe /c `"`"$Runner\run.cmd`" >> `"$Runner\runner-console.log`" 2>&1`""
while ($true) {
  $childPid = 0
  $process = [HiddenDesktop]::Start($Desktop, $command, $Runner, [ref]$childPid)
  Log "run.cmd started: pid $childPid"
  $code = [HiddenDesktop]::Wait($process)
  Log ("run.cmd ended: exit code {0} (0x{0:X8}); starting it again in 60 s" -f $code)
  Start-Sleep -Seconds 60
}
