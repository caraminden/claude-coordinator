// Citadel's desktop launcher (#1148; Josh, 2026-11-19: "A small launcher exe", "SHA-256 in the feed", "Yes, with a safety
// check"). People start a desktop app through this exe. It keeps each build of the app in its own folder, starts the
// current one, and in the background reads the app's feed on Citadel. A newer build is downloaded, checked against the
// feed's SHA-256 and unpacked beside the others; it is tried on the next start, and becomes current once it says it
// started (it writes the file CITADEL_STARTED_FILE names) or, for an app set to "alive", is still running after the grace.
// It then runs on probation (#1396, Trial.cs): good once it has run ten minutes or exited cleanly. A build that fails its
// start or crashes on probation goes back to the last good build, with one line for the person, and gets one more try on
// the next start; a second failure refuses it on this PC. An update never leaves a PC without a working app. The launcher updates itself the same way: a new one must pass --selftest before it replaces
// this exe, and if it then fails before the app starts, it puts the old one back and hands over to it.
//
// Install folder: <app>.exe (this), launcher.json { "app", "feed" }, state.json, versions\<build>\, launcher.log.
// Built from this file and Trial.cs (the trial rules, tested off Windows in tests\).
// .NET Framework 4.8 ships with every Windows 10 and 11, so the exe needs nothing installed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Citadel.Desktop
{
    [DataContract]
    public class Config
    {
        [DataMember(Name = "app")] public string App;
        [DataMember(Name = "feed")] public string Feed;
        [DataMember(Name = "title", EmitDefaultValue = false)] public string Title;
    }

    [DataContract]
    public class LauncherInfo
    {
        [DataMember(Name = "version")] public int Version;
        [DataMember(Name = "file")] public string File;
        [DataMember(Name = "sha256")] public string Sha256;
        [DataMember(Name = "size")] public long Size;
    }

    [DataContract]
    public class Feed
    {
        [DataMember(Name = "app")] public string App;
        [DataMember(Name = "build")] public int Build;
        [DataMember(Name = "exe")] public string Exe;
        [DataMember(Name = "started")] public string Started;
        [DataMember(Name = "zip")] public string Zip;
        [DataMember(Name = "sha256")] public string Sha256;
        [DataMember(Name = "size")] public long Size;
        [DataMember(Name = "launcher", EmitDefaultValue = false)] public LauncherInfo Launcher;
    }

    public static class Program
    {
        /// <summary>This launcher's version: the feed offers a newer one by a higher number. Raise it with every change.</summary>
        public const int Version = 4;

        [STAThread]
        public static int Main(string[] args)
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            if (args.Length > 0 && args[0] == "--version") { Console.WriteLine(Version); return 0; }
            if (args.Length > 0 && args[0] == "--selftest") return SelfTest(dir);
            var l = new Launcher(dir, args);
            try
            {
                return l.Run();
            }
            catch (Exception e)
            {
                l.Log("failed: " + e);
                if (l.SwapBackLauncher()) return 0;
                MessageBox.Show(e.Message, l.Title + " couldn't start", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        /// <summary>What a new launcher must pass before it replaces the old one: it reads this folder's config and state as a start would.</summary>
        static int SelfTest(string dir)
        {
            try
            {
                var l = new Launcher(dir, new string[0]);
                l.ReadConfig();
                l.ReadState();
                Console.WriteLine("ok " + Version);
                return 0;
            }
            catch (Exception e)
            {
                Console.WriteLine("selftest failed: " + e.Message);
                return 1;
            }
        }
    }

    public class Launcher
    {
        public static readonly TimeSpan Grace = Trial.Grace;
        /// <summary>How long a start with a build to try waits for the feed first (#1942): enough for a slow first connection, short enough that an offline PC's app still opens.</summary>
        static readonly TimeSpan FeedWait = TimeSpan.FromSeconds(5);
        const long MaxDownload = 4L * 1024 * 1024 * 1024;

        readonly string dir;
        readonly string[] args;
        Config config;
        public string Title = "The app";

        public Launcher(string dir, string[] args)
        {
            this.dir = dir;
            this.args = args;
        }

        string P(params string[] parts) { return Path.Combine(new[] { dir }.Concat(parts).ToArray()); }
        string Versions { get { return P("versions"); } }
        string Me { get { return Process.GetCurrentProcess().MainModule.FileName; } }
        string OldLauncher { get { return Path.ChangeExtension(Me, ".old.exe"); } }
        string TrialFile { get { return P("launcher.trial"); } }
        string BadFile { get { return P("launcher.bad"); } }

        public int Run()
        {
            ReadConfig();
            bool mine;
            using (var mutex = new Mutex(false, "Local\\citadel-launcher-" + config.App))
            {
                try { mine = mutex.WaitOne(0); } catch (AbandonedMutexException) { mine = true; }
                try
                {
                    var state = ReadState();
                    // Another launcher of this app is busy (downloading or trying a build): start what is current and leave the rest to it.
                    if (!mine)
                    {
                        if (state.Current == null) throw new Exception(Title + " is still being set up: try again in a minute.");
                        StartPlain(state.Current);
                        return 0;
                    }
                    if (state.Current == null && state.Pending == null)
                    {
                        Log("nothing installed yet: reading the feed first");
                        CheckForUpdates(state, false);
                        if (state.Pending == null) throw new Exception("Couldn't download " + Title + " from " + config.Feed + ": see launcher.log.");
                    }
                    // Only a start with a build to try waits for the feed. The running copy is asked again after the wait.
                    bool withdrawn = Trial.TryNow(state, () => ACopyRuns(state)) && DropWithdrawn(state, FeedBeforeTrial());
                    bool tryNow = !withdrawn && Trial.TryNow(state, () => ACopyRuns(state));
                    if (state.Pending != null && !withdrawn && !tryNow)
                        Log("build " + state.Pending.Id + " waits: a copy of " + Title + " is already running, and a new start would hand off to it, proving nothing about the new build");
                    var started = tryNow ? TryPending(state) : StartCurrent(state);
                    EndLauncherTrial();
                    Cleanup(state);
                    if (started == null) CheckForUpdates(state, true);
                    else
                    {
                        // The launcher stays to watch a build on probation, with the feed read beside it so a long download
                        // can't hold up a roll back. Another start meanwhile runs the current build without a watch.
                        var updates = new Thread(() => CheckForUpdates(state, true)) { IsBackground = true };
                        updates.Start();
                        WatchProbation(state, started);
                        updates.Join();
                    }
                }
                finally
                {
                    if (mine) mutex.ReleaseMutex();
                }
            }
            return 0;
        }

        public void ReadConfig()
        {
            config = Read<Config>(P("launcher.json"));
            if (config == null || string.IsNullOrEmpty(config.App) || string.IsNullOrEmpty(config.Feed)) throw new Exception("launcher.json needs app and feed");
            Title = string.IsNullOrEmpty(config.Title) ? config.App : config.Title;
        }

        public State ReadState()
        {
            var s = File.Exists(P("state.json")) ? Read<State>(P("state.json")) : new State();
            if (s.Failed == null) s.Failed = new List<int>();
            return s;
        }

        void Save(State s)
        {
            Write(P("state.json"), s);
        }

        /// <summary>Save, but a full disk mustn't keep the app from starting: the state on disk is then a step behind and the next start picks up from it.</summary>
        bool TrySave(State s)
        {
            try { Save(s); return true; } catch (Exception e) { Log("couldn't save state.json: " + e.Message); return false; }
        }

        // ---- Starting the app ----

        ProcessStartInfo StartInfo(Build b, string startedFile)
        {
            string folder = P("versions", b.Id.ToString());
            string exe = Path.Combine(folder, b.Exe);
            if (!File.Exists(exe)) throw new Exception(Title + "'s build " + b.Id + " has no " + b.Exe);
            var psi = new ProcessStartInfo(exe, Quote(args)) { WorkingDirectory = folder, UseShellExecute = false };
            psi.EnvironmentVariables["CITADEL_BUILD"] = b.Id.ToString();
            psi.EnvironmentVariables["CITADEL_STARTED_FILE"] = startedFile;
            return psi;
        }

        void StartPlain(Build b)
        {
            Log("starting build " + b.Id);
            Process.Start(StartInfo(b, P("started-" + b.Id))).Dispose();
        }

        /// <summary>Whether a copy of the app from any build in versions\ is running (Trial.TryNow): found by its exe's name, then its path.</summary>
        bool ACopyRuns(State state)
        {
            string root = Path.GetFullPath(Versions).TrimEnd('\\') + "\\";
            var names = new[] { state.Current, state.Previous, state.Pending }.Where(b => b != null && !string.IsNullOrEmpty(b.Exe))
                .Select(b => Path.GetFileNameWithoutExtension(b.Exe)).Distinct(StringComparer.OrdinalIgnoreCase);
            foreach (var name in names)
            {
                foreach (var p in Process.GetProcessesByName(name))
                {
                    using (p)
                    {
                        // Another user's or an elevated process can't be read: not a copy this launcher started.
                        try { if (p.MainModule.FileName.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return true; }
                        catch (Exception) { }
                    }
                }
            }
            return false;
        }

        /// <summary>A build the launcher watches on probation, and when it started.</summary>
        class Started
        {
            public Process Process;
            public DateTime At;
        }

        /// <summary>Start the current build. A build still on probation (its last watch was cut short: the launcher was closed) is watched again from the start.</summary>
        Started StartCurrent(State state)
        {
            if (!Trial.OnProbation(state)) { StartPlain(state.Current); return null; }
            Log("starting build " + state.Current.Id + ": still on probation");
            return new Started { Process = Process.Start(StartInfo(state.Current, P("started-" + state.Current.Id))), At = DateTime.UtcNow };
        }

        /// <summary>Start the pending build on trial. Once it says it started it is current, on probation; else it is stopped and the current one starts.</summary>
        Started TryPending(State state)
        {
            var b = state.Pending;
            string started = P("started-" + b.Id);
            TryDelete(started);
            Log("trying build " + b.Id + " (" + b.Started + ")");
            Process p = null;
            var at = DateTime.UtcNow;
            bool ok = false;
            string why = "";
            try
            {
                p = Process.Start(StartInfo(b, started));
                var until = at + Grace;
                while (DateTime.UtcNow < until && !File.Exists(started) && !p.HasExited) Thread.Sleep(100);
                if (File.Exists(started)) ok = !p.HasExited || p.ExitCode == 0;
                else if (b.Started == "alive") ok = p.HasExited ? p.ExitCode == 0 : true;
                if (!ok)
                {
                    why = p.HasExited ? "it exited with code " + p.ExitCode + " before it started" : "it didn't say it started within " + Grace.TotalSeconds + " s";
                    if (!p.HasExited) { try { p.Kill(); p.WaitForExit(10000); } catch { } }
                }
            }
            catch (Exception e)
            {
                why = e.Message;
            }
            if (ok)
            {
                lock (state)
                {
                    Trial.Started(state);
                    Log("build " + b.Id + " started: it is now current, on probation for " + Trial.Probation.TotalMinutes + " min");
                    TrySave(state);
                }
                return new Started { Process = p, At = at };
            }
            if (p != null) p.Dispose();
            var r = Trial.StartFailed(state);
            Log("build " + b.Id + " failed its start (" + why + "): " + (r.Refused ? "its second failure, so it is refused" : "it gets one more try on the next start")
                + "; rolling back to " + (state.Current == null ? "nothing" : "build " + state.Current.Id));
            // A refused build's folder goes only once state.json says so: else the next start would try a build with no files.
            if (TrySave(state) && r.Refused) TryDeleteDir(P("versions", b.Id.ToString()));
            if (state.Current == null) throw new Exception(Title + "'s first build didn't start (" + why + "): see launcher.log.");
            Notify(r.Notice(Title));
            return StartCurrent(state);
        }

        /// <summary>Wait out the current build's probation. It passes once it has run Trial.Probation or exits cleanly; a crash goes back to the last good build, with one line for the person.</summary>
        void WatchProbation(State state, Started started)
        {
            var b = state.Current;
            int? code;
            TimeSpan ran;
            using (var p = started.Process)
            {
                var left = Trial.Probation - (DateTime.UtcNow - started.At);
                if (left > TimeSpan.Zero) p.WaitForExit((int)Math.Ceiling(left.TotalMilliseconds));
                code = p.HasExited ? p.ExitCode : (int?)null;
                ran = (code == null ? DateTime.UtcNow : p.ExitTime.ToUniversalTime()) - started.At;
            }
            var verdict = Trial.Judge(ran, code);
            if (verdict == Verdict.Crashed && ShuttingDown())
            {
                Log("build " + b.Id + " was stopped by Windows shutting down: still on probation");
                return;
            }
            if (verdict == Verdict.Running)
            {
                Log("build " + b.Id + " exited cleanly " + (int)ran.TotalSeconds + " s after it started, too soon to prove anything (did it hand off to a copy already running?): still on probation");
                return;
            }
            Rollback r;
            lock (state)
            {
                if (verdict == Verdict.Passed)
                {
                    Trial.Passed(state);
                    TrySave(state);
                    Log("build " + b.Id + " passed probation (" + (code == null ? "ran " + Trial.Probation.TotalMinutes + " min" : "exited with code " + code + " after " + (int)ran.TotalSeconds + " s") + "): it is good");
                    return;
                }
                r = Trial.Crashed(state);
                if (r == null)
                {
                    Log("build " + b.Id + " crashed on probation (exit code " + code + ") after " + (int)ran.TotalSeconds + " s, and there's no older build to go back to: it stays current, on probation");
                    return;
                }
                Log("build " + b.Id + " crashed on probation (exit code " + code + ") after " + (int)ran.TotalSeconds + " s: " + (r.Refused ? "its second failure, so it is refused" : "it gets one more try on the next start")
                    + "; rolling back to build " + state.Current.Id);
                if (TrySave(state) && r.Refused) TryDeleteDir(P("versions", b.Id.ToString()));
            }
            StartPlain(state.Current);
            Notify(r.Notice(Title));
        }

        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);

        /// <summary>Windows is logging off or shutting down (SM_SHUTTINGDOWN): an app stopped by it didn't crash.</summary>
        static bool ShuttingDown() { try { return GetSystemMetrics(0x2000) != 0; } catch { return false; } }

        /// <summary>
        /// One line for the person, on top of the app that started instead (MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST).
        /// On its own thread, so it shows at once while the launcher carries on; the launcher's process stays until it is closed.
        /// </summary>
        void Notify(string line)
        {
            new Thread(() =>
            {
                try { MessageBoxW(IntPtr.Zero, line, Title, 0x40 | 0x10000 | 0x40000); } catch (Exception e) { Log("couldn't show: " + line + " (" + e.Message + ")"); }
            }).Start();
        }

        void Cleanup(State state)
        {
            if (!Directory.Exists(Versions)) return;
            var keep = new HashSet<string>(new[] { state.Current, state.Previous, state.Pending }.Where(b => b != null).Select(b => b.Id.ToString()));
            foreach (var d in Directory.GetDirectories(Versions)) if (!keep.Contains(Path.GetFileName(d))) TryDeleteDir(d);
            foreach (var f in Directory.GetFiles(Versions)) TryDelete(f);
            foreach (var f in Directory.GetFiles(dir, "started-*")) TryDelete(f);
        }

        // ---- Updates ----

        /// <summary>The app's feed, or null (with a line in the log) when it can't be read or is another app's.</summary>
        Feed ReadFeed()
        {
            Feed f;
            try
            {
                f = Fetch<Feed>(config.Feed);
            }
            catch (Exception e)
            {
                Log("couldn't read the feed: " + e.Message);
                return null;
            }
            if (f == null || f.App != config.App) { Log("the feed is for " + (f == null ? "nothing" : f.App) + ", not " + config.App + ": ignored"); return null; }
            return f;
        }

        /// <summary>
        /// The feed, if it answers within FeedWait; else null, and the waiting build is tried as if there were no feed. Waited
        /// for on a thread of its own: a request's own timeout leaves out looking up the name and finding a proxy.
        /// </summary>
        Feed FeedBeforeTrial()
        {
            var read = Task.Run(() => ReadFeed());
            if (read.Wait(FeedWait)) return read.Result;
            Log("the feed didn't answer within " + FeedWait.TotalSeconds + " s: carrying on without it");
            return null;
        }

        /// <summary>Drop the waiting build if the feed took it back (Trial.Withdrawn). True when it did. Its folder goes with the next Cleanup.</summary>
        bool DropWithdrawn(State state, Feed f)
        {
            if (f == null) return false;
            lock (state)
            {
                if (!Trial.Withdrawn(state, f.Build)) return false;
                var b = state.Pending;
                state.Pending = null;
                // Unsaved, state.json still names it: kept here too, so Cleanup leaves its folder and the next start drops it.
                if (!TrySave(state)) state.Pending = b;
                Log("build " + b.Id + " is not tried: the feed now names build " + f.Build);
                return true;
            }
        }

        /// <summary>Read the feed and download what is newer: the app's build (tried on the next start) and the launcher.</summary>
        void CheckForUpdates(State state, bool launcherToo)
        {
            var f = ReadFeed();
            if (f == null) return;
            if (Trial.WantsBuild(state, f.Build))
            {
                try
                {
                    Stage(f, state);
                }
                catch (Exception e)
                {
                    Log("couldn't download build " + f.Build + ": " + e.Message);
                }
            }
            // After the download: a crash on probation beside it puts the bad build back in line, and a failed one leaves it there.
            DropWithdrawn(state, f);
            if (launcherToo && f.Launcher != null && f.Launcher.Version > Program.Version && !BadLaunchers().Contains(f.Launcher.Version))
            {
                try
                {
                    UpdateLauncher(f.Launcher);
                }
                catch (Exception e)
                {
                    Log("couldn't update the launcher to " + f.Launcher.Version + ": " + e.Message);
                }
            }
        }

        /// <summary>Download a build, check its size and SHA-256 against the feed, unpack it into versions\&lt;build&gt; and make it the one to try.</summary>
        void Stage(Feed f, State state)
        {
            // A path inside the build, as the server takes it ("App.exe", "bin/App.exe"): no root, drive or "..".
            if (string.IsNullOrEmpty(f.Exe) || f.Exe.IndexOfAny(new[] { '\\', ':' }) >= 0 || f.Exe.StartsWith("/")
                || Array.Exists(f.Exe.Split('/'), s => s.Length == 0 || s == "." || s == "..")) throw new Exception("the feed's exe isn't a path inside the build");
            Directory.CreateDirectory(Versions);
            string id = f.Build.ToString();
            string zip = P("versions", id + ".zip.part");
            string part = P("versions", id + ".part");
            string final = P("versions", id);
            try
            {
                Download(new Uri(new Uri(config.Feed), f.Zip), zip, f.Size, f.Sha256);
                TryDeleteDir(part);
                Unzip(zip, part);
                if (!File.Exists(Path.Combine(part, f.Exe))) throw new Exception("the build has no " + f.Exe);
                var staged = new Build { Id = f.Build, Exe = f.Exe, Started = f.Started == "alive" ? "alive" : "file" };
                // The probation watch may have changed the state meanwhile (it runs beside this). After a crash back to this very
                // build its folder is in use: replacing it would break the app that runs.
                lock (state)
                {
                    if (!Trial.WantsBuild(state, f.Build)) { Log("build " + f.Build + " was downloaded, but it isn't wanted any more"); return; }
                    TryDeleteDir(final);
                    Directory.Move(part, final);
                    // The one it replaces may be the build to go back to: its folder goes with the next Cleanup, if nothing needs it.
                    state.Pending = staged;
                    Save(state);
                }
                Log("build " + f.Build + " is ready: it is tried on the next start");
            }
            finally
            {
                TryDelete(zip);
                TryDeleteDir(part);
            }
        }

        void UpdateLauncher(LauncherInfo info)
        {
            string next = P("launcher.next.exe");
            Download(new Uri(new Uri(config.Feed), info.File), next, info.Size, info.Sha256);
            // The safety check: the new launcher must read this folder and report its version before it replaces this one.
            string said = "";
            int code = -1;
            try
            {
                var psi = new ProcessStartInfo(next, "--selftest") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true, WorkingDirectory = dir };
                using (var p = Process.Start(psi))
                {
                    var read = p.StandardOutput.ReadToEndAsync();
                    if (!p.WaitForExit(15000)) { try { p.Kill(); } catch { } }
                    else { code = p.ExitCode; said = read.Wait(5000) ? read.Result.Trim() : ""; }
                }
            }
            catch (Exception e)
            {
                said = e.Message;
            }
            if (code != 0 || said != "ok " + info.Version)
            {
                TryDelete(next);
                MarkBad(info.Version);
                throw new Exception("launcher " + info.Version + " failed its selftest (exit " + code + ": " + said + ")");
            }
            // Windows lets a running exe be renamed, not deleted: this one moves aside, the new one takes its name.
            TryDelete(OldLauncher);
            File.Move(Me, OldLauncher);
            try
            {
                File.Move(next, Me);
            }
            catch
            {
                File.Move(OldLauncher, Me);
                throw;
            }
            File.WriteAllText(TrialFile, Program.Version.ToString());
            Log("launcher " + info.Version + " is in place: it takes over on the next start");
        }

        /// <summary>A new launcher reached the app's start: it stays, and the old one goes.</summary>
        void EndLauncherTrial()
        {
            if (!File.Exists(TrialFile)) return;
            TryDelete(TrialFile);
            TryDelete(OldLauncher);
            Log("launcher " + Program.Version + " started the app: it stays");
        }

        /// <summary>This launcher is on trial and failed before the app started: put the old one back and hand over to it. False when not on trial.</summary>
        public bool SwapBackLauncher()
        {
            try
            {
                if (!File.Exists(TrialFile) || !File.Exists(OldLauncher)) return false;
                string bad = P("launcher.bad.exe");
                TryDelete(bad);
                File.Move(Me, bad);
                File.Move(OldLauncher, Me);
                TryDelete(TrialFile);
                MarkBad(Program.Version);
                Log("launcher " + Program.Version + " failed: the old launcher is back");
                Process.Start(new ProcessStartInfo(Me, Quote(args)) { UseShellExecute = false, WorkingDirectory = dir }).Dispose();
                return true;
            }
            catch (Exception e)
            {
                Log("couldn't put the old launcher back: " + e.Message);
                return false;
            }
        }

        HashSet<int> BadLaunchers()
        {
            var s = new HashSet<int>();
            if (File.Exists(BadFile)) foreach (var line in File.ReadAllLines(BadFile)) { int n; if (int.TryParse(line.Trim(), out n)) s.Add(n); }
            return s;
        }

        void MarkBad(int version)
        {
            try { File.AppendAllText(BadFile, version + Environment.NewLine); } catch { }
        }

        // ---- Files, downloads and JSON ----

        static void Download(Uri url, string to, long size, string sha256)
        {
            if (string.IsNullOrEmpty(sha256) || sha256.Length != 64) throw new Exception("the feed gives no SHA-256 for " + url);
            if (size <= 0 || size > MaxDownload) throw new Exception("the feed gives no usable size for " + url);
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 30000;
            req.ReadWriteTimeout = 60000;
            using (var res = (HttpWebResponse)req.GetResponse())
            using (var body = res.GetResponseStream())
            using (var file = new FileStream(to, FileMode.Create, FileAccess.Write))
            using (var hash = SHA256.Create())
            {
                var buf = new byte[1 << 16];
                long got = 0;
                int n;
                while ((n = body.Read(buf, 0, buf.Length)) > 0)
                {
                    got += n;
                    if (got > size) throw new Exception("the download is bigger than the feed says");
                    hash.TransformBlock(buf, 0, n, null, 0);
                    file.Write(buf, 0, n);
                }
                hash.TransformFinalBlock(buf, 0, 0);
                if (got != size) throw new Exception("the download is " + got + " bytes, the feed says " + size);
                string hex = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
                if (hex != sha256.ToLowerInvariant()) throw new Exception("the download's SHA-256 doesn't match the feed");
            }
        }

        /// <summary>Unpack a zip into `to`, refusing any entry that would land outside it.</summary>
        static void Unzip(string zip, string to)
        {
            string root = Path.GetFullPath(to).TrimEnd('\\') + "\\";
            Directory.CreateDirectory(root);
            using (var z = ZipFile.OpenRead(zip))
            {
                foreach (var e in z.Entries)
                {
                    string full = Path.GetFullPath(Path.Combine(root, e.FullName));
                    if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("the build has a file outside its folder: " + e.FullName);
                    if (e.FullName.EndsWith("/") || e.FullName.EndsWith("\\")) { Directory.CreateDirectory(full); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(full));
                    e.ExtractToFile(full, true);
                }
            }
        }

        static T Fetch<T>(string url)
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = 15000;
            req.ReadWriteTimeout = 15000;
            // Never a cached feed: a roll back or a fix must be seen at once.
            req.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
            using (var res = req.GetResponse())
            using (var s = res.GetResponseStream())
                return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(s);
        }

        static T Read<T>(string path)
        {
            using (var s = File.OpenRead(path)) return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(s);
        }

        /// <summary>Write JSON beside the file and swap it in, so a crash mid-write leaves the old file whole.</summary>
        static void Write<T>(string path, T value)
        {
            string tmp = path + ".tmp";
            using (var s = new FileStream(tmp, FileMode.Create, FileAccess.Write))
            {
                new DataContractJsonSerializer(typeof(T)).WriteObject(s, value);
                s.Flush(true);
            }
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }

        static string Quote(string[] a)
        {
            return string.Join(" ", a.Select(x => x.Length > 0 && x.IndexOfAny(new[] { ' ', '\t', '"' }) < 0 ? x : "\"" + x.Replace("\"", "\\\"") + "\""));
        }

        static void TryDelete(string f) { try { if (File.Exists(f)) File.Delete(f); } catch { } }
        static void TryDeleteDir(string d) { try { if (Directory.Exists(d)) Directory.Delete(d, true); } catch { } }

        readonly object logLock = new object();

        /// <summary>
        /// The probation watch and the feed read log from two threads, so one writes at a time. A few tries, since a scanner
        /// can hold a new log open for a moment (the test box lost a line that way, #1396).
        /// </summary>
        public void Log(string line)
        {
            string text = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " [" + Program.Version + "] " + line + Environment.NewLine;
            lock (logLock)
                for (int i = 0; i < 5; i++)
                {
                    try
                    {
                        string log = P("launcher.log");
                        if (File.Exists(log) && new FileInfo(log).Length > 512 * 1024) { TryDelete(log + ".1"); File.Move(log, log + ".1"); }
                        File.AppendAllText(log, text, Encoding.UTF8);
                        return;
                    }
                    catch (IOException) { Thread.Sleep(100); }
                    catch { return; }
                }
        }
    }
}
