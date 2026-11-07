# Whether this session can read its screen the way desktop tests do: the whole virtual screen with GDI BitBlt and
# CAPTUREBLT, which Windows refuses ("Access is denied", "The handle is invalid") when the PC is locked, a Remote
# Desktop session was left disconnected, or the desktop isn't the one on screen. desktop.yml's `screen` job gates the
# desktop jobs on it, and windows.yml's build job runs it too, so a broken check goes red instead of quietly marking
# every desktop job NOT RUN.
# From Peek Auras' tools/ci-win/screen-check.ps1 (caraminden/peek-auras at 5f25195), copied into Citadel's Windows CI
# kit (#370); only this header and the class name changed. It calls GetDC, BitBlt and ReleaseDC itself because .NET's
# CopyFromScreen throws on CAPTUREBLT, and a plain one-pixel read passed on Peek's PC while the tests' reads failed.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/ci-win/screen-check.ps1
# Exit 0: read it. Exit 1: Windows refused, and the output says how. Exit 2: this script is broken.
$src = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CiScreenCheck {
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("gdi32.dll", SetLastError = true)] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll", SetLastError = true)] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", SetLastError = true)]
    static extern bool BitBlt(IntPtr dest, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);

    const uint SRCCOPY_CAPTUREBLT = 0x00CC0020 | 0x40000000;

    static string Why(string call) {
        int e = Marshal.GetLastWin32Error();
        return call + ": " + new Win32Exception(e).Message + " (0x" + e.ToString("X8") + ")";
    }

    // Null when the whole virtual screen was read, else which call Windows refused and why.
    public static string Read() {
        int x = GetSystemMetrics(76), y = GetSystemMetrics(77);  // SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN
        int w = GetSystemMetrics(78), h = GetSystemMetrics(79);  // SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN
        if (w <= 0 || h <= 0) return "no screen: the virtual screen is " + w + "x" + h;
        IntPtr screen = GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return Why("GetDC");
        IntPtr memory = IntPtr.Zero, bitmap = IntPtr.Zero, old = IntPtr.Zero;
        try {
            memory = CreateCompatibleDC(screen);
            if (memory == IntPtr.Zero) return Why("CreateCompatibleDC");
            bitmap = CreateCompatibleBitmap(screen, w, h);
            if (bitmap == IntPtr.Zero) return Why("CreateCompatibleBitmap");
            old = SelectObject(memory, bitmap);
            if (!BitBlt(memory, 0, 0, w, h, screen, x, y, SRCCOPY_CAPTUREBLT)) return Why("BitBlt");
            return null;
        } finally {
            if (old != IntPtr.Zero) SelectObject(memory, old);
            if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
            if (memory != IntPtr.Zero) DeleteDC(memory);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }
}
'@
try {
    Add-Type -TypeDefinition $src
    $why = [CiScreenCheck]::Read()
} catch {
    Write-Output "screen-check.ps1 is broken: $($_.Exception.Message)"
    exit 2
}
if ($why) { Write-Output $why; exit 1 }
Write-Output 'read the whole screen'
exit 0
