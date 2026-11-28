// A test app for Citadel's desktop launcher (#1148): a window that shows label.txt from its folder and says it
// started. A build with broken.txt beside it crashes at start instead, to prove the launcher keeps the old one; one with
// crash-after.txt (a number of seconds) says it started and then exits with code 3 that many seconds later, a crash
// inside the launcher's probation (#1396). One with tray.txt starts hidden in the tray, as if the person had closed its
// window there, and so does any start with CITADEL_START_HIDDEN set; the tray icon shows the window. Like the desktop app
// it quits with code 0 when the launcher writes CITADEL_QUIT_FILE, but only while its window is hidden (#2279).
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

static class TestApp
{
    [STAThread]
    static void Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        if (File.Exists(Path.Combine(dir, "broken.txt"))) throw new Exception("this build is broken on purpose");
        string label = File.Exists(Path.Combine(dir, "label.txt")) ? File.ReadAllText(Path.Combine(dir, "label.txt")).Trim() : "?";
        bool hidden = File.Exists(Path.Combine(dir, "tray.txt")) || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("CITADEL_START_HIDDEN"));
        var form = new Form { Text = "Citadel test app " + label, Width = 520, Height = 220 };
        form.Controls.Add(new Label { Text = "Test app " + label + " (build " + Environment.GetEnvironmentVariable("CITADEL_BUILD") + ")", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 20) });
        // In the tray, closing the window hides it there and the tray icon's Quit closes the app; else closing it closes the app.
        bool inTray = hidden;
        bool quitting = false;
        NotifyIcon tray = null;
        Action quit = () => { quitting = true; if (tray != null) tray.Visible = false; Application.Exit(); };
        form.FormClosing += (s, e) => { if (inTray && !quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; form.Hide(); } };
        form.FormClosed += (s, e) => quit();
        if (inTray)
        {
            tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Test app " + label, Visible = true };
            tray.Click += (s, e) => form.Show();
            tray.ContextMenu = new ContextMenu(new[] { new MenuItem("Quit", (s, e) => quit()) });
        }

        var ready = new Timer { Interval = 100 };
        ready.Tick += (s, e) =>
        {
            ready.Stop();
            string started = Environment.GetEnvironmentVariable("CITADEL_STARTED_FILE");
            if (!string.IsNullOrEmpty(started)) File.WriteAllText(started, "started");
            string crash = Path.Combine(dir, "crash-after.txt");
            if (File.Exists(crash))
            {
                var t = new Timer { Interval = Math.Max(1, int.Parse(File.ReadAllText(crash).Trim())) * 1000 };
                t.Tick += (a, b) => Environment.Exit(3);
                t.Start();
            }
        };
        if (hidden) ready.Start(); else form.Shown += (s, e) => ready.Start();

        string quitFile = Environment.GetEnvironmentVariable("CITADEL_QUIT_FILE");
        if (!string.IsNullOrEmpty(quitFile))
        {
            var watch = new Timer { Interval = 1000 };
            watch.Tick += (s, e) => { if (File.Exists(quitFile) && !form.Visible) quit(); };
            watch.Start();
        }
        if (!hidden) form.Show();
        Application.Run();
    }
}
