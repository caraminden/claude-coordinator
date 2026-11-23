# Real input on the test box for driver.mjs: one command per stdin line, one answer line each. Screen px, per-monitor DPI aware.
#   front <pid> (that process's window kept on top, so clicks reach it) | move X Y | click X Y | rclick X Y | drag X1 Y1 X2 Y2
#   key <SendKeys text> | shot <file.png> [X Y W H] (no box: the whole screen)
#   menu                    the items of the open menu (Electron's, drawn by Chromium), joined by " | "
#   menu-close              Escape posted to each open menu's window (posted, so it gets past UIPI); "closed <n>"
#   menu-invoke <regex>     invokes (UI Automation, no real click) the first item of it whose name matches; "none" if none
#   uia-list <name regex>   names of the buttons and checkboxes in Edge's windows matching it
#   uia-click <name regex>  real click on the first visible one whose name matches; "none" if there is none
# The UI Automation and Forms types come from the Add-Type below, which the lint can't follow.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseCompatibleTypes', '')]
param()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
[void][M]::SetProcessDpiAwarenessContext([IntPtr]-4)
$UIA = [System.Windows.Automation.AutomationElement]

function Click($x, $y) {
  [void][M]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 80
  [M]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60; [M]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
}

# Buttons and checkboxes in Edge's top-level windows (the browser, its dialogs, the app window), named by regex.
# The items of an open menu in a Chromium window: Electron draws its menus with Chromium's views (a Chrome_WidgetWin
# window), not a Win32 menu, so they are found through UI Automation.
function MenuItems($windows) {
  $item = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
  foreach ($w in $UIA::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.ClassName -notlike 'Chrome_WidgetWin*') { continue }
    $items = @($w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $item) | Where-Object { -not $_.Current.IsOffscreen })
    if ($windows) { if ($items.Count) { $w } } else { $items }
  }
}

function Controls($re) {
  $kinds = New-Object System.Windows.Automation.OrCondition(
    (New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
    (New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::CheckBox)))
  foreach ($w in $UIA::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($w.Current.ClassName -notlike 'Chrome_WidgetWin*') { continue }
    foreach ($c in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $kinds)) {
      $n = $c.Current.Name
      if ($n -and $n -match $re -and -not $c.Current.IsOffscreen) { $c }
    }
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $a = $line.Split(' '); $rest = ($a[1..($a.Length - 1)] -join ' ')
  try {
    switch ($a[0]) {
      # Topmost needs no foreground rights; the foreground is asked for too, and named: while an elevated window (an admin
      # console left open) has it, Windows drops all injected input (UIPI), so nothing here can click or type.
      'front' {
        $h = (Get-Process -Id ([int]$a[1])).MainWindowHandle
        $top = [M]::SetWindowPos($h, [IntPtr]-1, 0, 0, 0, 0, 0x43); $fg = [M]::SetForegroundWindow($h)
        $p = 0; [void][M]::GetWindowThreadProcessId([M]::GetForegroundWindow(), [ref]$p)
        "topmost $top foreground $fg now $((Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName) $p"
      }
      'move' { [void][M]::SetCursorPos([int]$a[1], [int]$a[2]); 'ok' }
      'menu' { ((MenuItems | ForEach-Object { $_.Current.Name }) -join ' | ') + ' ' }
      'menu-invoke' {
        $m = MenuItems | Where-Object { $_.Current.Name -match $rest } | Select-Object -First 1
        if (-not $m) { 'none' } else {
          $p = $null
          if ($m.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); 'invoked ' + $m.Current.Name } else { 'no invoke on ' + $m.Current.Name }
        }
      }
      'menu-close' {
        $n = 0; foreach ($w in MenuItems $true) { $h = [IntPtr]$w.Current.NativeWindowHandle; [void][M]::PostMessage($h, 0x100, [IntPtr]0x1B, [IntPtr]::Zero); [void][M]::PostMessage($h, 0x101, [IntPtr]0x1B, [IntPtr]::Zero); $n++ }
        "closed $n"
      }
      'windows' { (($UIA::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.ClassName + ':' + $_.Current.Name }) -join ' | ') + ' ' }
      'click' { Click ([int]$a[1]) ([int]$a[2]); 'ok' }
      'rclick' { [void][M]::SetCursorPos([int]$a[1], [int]$a[2]); Start-Sleep -Milliseconds 80; [M]::mouse_event(8, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60; [M]::mouse_event(16, 0, 0, 0, [IntPtr]::Zero); 'ok' }
      'drag' {
        [void][M]::SetCursorPos([int]$a[1], [int]$a[2]); Start-Sleep -Milliseconds 80; [M]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 120
        for ($i = 1; $i -le 10; $i++) { [void][M]::SetCursorPos([int]$a[1] + ([int]$a[3] - [int]$a[1]) * $i / 10, [int]$a[2] + ([int]$a[4] - [int]$a[2]) * $i / 10); Start-Sleep -Milliseconds 30 }
        Start-Sleep -Milliseconds 100; [M]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); 'ok'
      }
      'key' { [System.Windows.Forms.SendKeys]::SendWait($rest); 'ok' }
      'shot' {
        $b = if ($a.Length -ge 6) { New-Object System.Drawing.Rectangle([int]$a[2], [int]$a[3], [int]$a[4], [int]$a[5]) } else { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }
        $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size); $g.Dispose()
        $bmp.Save($a[1], [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); 'ok'
      }
      'uia-list' { ((Controls $rest | ForEach-Object { $_.Current.ControlType.ProgrammaticName.Split('.')[-1] + ':' + $_.Current.Name }) -join ' | ') + ' ' }
      'uia-click' {
        $c = Controls $rest | Select-Object -First 1
        if (-not $c) { 'none' } else { $r = $c.Current.BoundingRectangle; Click ([int]($r.X + $r.Width / 2)) ([int]($r.Y + $r.Height / 2)); 'clicked ' + $c.Current.Name }
      }
      default { 'unknown ' + $a[0] }
    }
  } catch { 'ERR ' + ($_.Exception.Message -replace '\s+', ' ') }
}
