// A test app for Citadel's desktop launcher (#1148): a window that shows label.txt from its folder and says it
// started. A build with broken.txt beside it crashes at start instead, to prove the launcher keeps the old one.
using System;
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
        var form = new Form { Text = "Citadel test app " + label, Width = 520, Height = 220 };
        form.Controls.Add(new Label { Text = "Test app " + label + " (build " + Environment.GetEnvironmentVariable("CITADEL_BUILD") + ")", Dock = DockStyle.Fill, TextAlign = System.Drawing.ContentAlignment.MiddleCenter, Font = new System.Drawing.Font("Segoe UI", 20) });
        form.Shown += (s, e) =>
        {
            string started = Environment.GetEnvironmentVariable("CITADEL_STARTED_FILE");
            if (!string.IsNullOrEmpty(started)) File.WriteAllText(started, "started");
        };
        Application.Run(form);
    }
}
