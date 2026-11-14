# Real input on the test box for driver.mjs: one command per stdin line, one answer line each. Screen px, per-monitor DPI aware.
#   click X Y | drag X1 Y1 X2 Y2 | key <SendKeys text> | shot <file.png> X Y W H
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
}
"@
[void][M]::SetProcessDpiAwarenessContext([IntPtr]-4)
$UIA = [System.Windows.Automation.AutomationElement]

function Click($x, $y) {
  [void][M]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 80
  [M]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60; [M]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero)
}

# Buttons and checkboxes in Edge's top-level windows (the browser, its dialogs, the app window), named by regex.
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
      'click' { Click ([int]$a[1]) ([int]$a[2]); 'ok' }
      'drag' {
        [void][M]::SetCursorPos([int]$a[1], [int]$a[2]); Start-Sleep -Milliseconds 80; [M]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 120
        for ($i = 1; $i -le 10; $i++) { [void][M]::SetCursorPos([int]$a[1] + ([int]$a[3] - [int]$a[1]) * $i / 10, [int]$a[2] + ([int]$a[4] - [int]$a[2]) * $i / 10); Start-Sleep -Milliseconds 30 }
        Start-Sleep -Milliseconds 100; [M]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); 'ok'
      }
      'key' { [System.Windows.Forms.SendKeys]::SendWait($rest); 'ok' }
      'shot' {
        $bmp = New-Object System.Drawing.Bitmap([int]$a[4], [int]$a[5])
        $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen([int]$a[2], [int]$a[3], 0, 0, $bmp.Size); $g.Dispose()
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
