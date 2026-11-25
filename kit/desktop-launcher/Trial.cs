// The launcher's trial rules (#1396), kept apart from Launcher.cs so they can be tested off Windows
// (kit/desktop-launcher/tests, run by test/desktop-launcher-trial.test.ts). Launcher.cs does the files and processes.
using System;
using System.Collections.Generic;
using System.Runtime.Serialization;

namespace Citadel.Desktop
{
    [DataContract]
    public class Build
    {
        [DataMember(Name = "id")] public int Id;
        [DataMember(Name = "exe")] public string Exe;
        /// <summary>"file": started once it writes CITADEL_STARTED_FILE; "alive": still running after the grace, or exited 0.</summary>
        [DataMember(Name = "started")] public string Started;
    }

    [DataContract]
    public class State
    {
        [DataMember(Name = "current", EmitDefaultValue = false)] public Build Current;
        /// <summary>The build to go back to. While the current one is on probation, it is the last good build.</summary>
        [DataMember(Name = "previous", EmitDefaultValue = false)] public Build Previous;
        [DataMember(Name = "pending", EmitDefaultValue = false)] public Build Pending;
        /// <summary>Builds refused on this PC: they failed twice.</summary>
        [DataMember(Name = "failed")] public List<int> Failed = new List<int>();
        /// <summary>The current build's id while it is on probation; 0 once it is good. Launcher 1 never wrote it, so its current build reads as good.</summary>
        [DataMember(Name = "probation", EmitDefaultValue = false)] public int Probation;
        /// <summary>Builds that failed once: they get one more try.</summary>
        [DataMember(Name = "struck", EmitDefaultValue = false)] public List<int> Struck;
    }

    public enum Verdict { Running, Passed, Crashed }

    /// <summary>
    /// A new build is tried on the start after it downloads. Once it says it started it becomes current, on probation:
    /// it is good once it has run Probation without crashing, or exits cleanly first. A failed start or a crash on
    /// probation goes back to the last good build and counts against the new one: it gets one more try on the next
    /// start, and a second failure refuses it on this PC.
    /// </summary>
    public static class Trial
    {
        /// <summary>
        /// Ten minutes: long enough to cover a first session's setup (sign in, first sync, opening a file), where a new
        /// build's crashes mostly show; short enough that a trial ends within one sitting, so a build that crashes on day
        /// two is a bug to fix with a roll back on the feed, not a reason to keep the launcher watching for hours.
        /// </summary>
        public static readonly TimeSpan Probation = TimeSpan.FromMinutes(10);

        /// <summary>How long a new build has to say it started (Peek Auras' START_GRACE). A clean exit this soon proves nothing: it may have handed off to a copy already running.</summary>
        public static readonly TimeSpan Grace = TimeSpan.FromSeconds(30);

        public static bool OnProbation(State s) { return s.Current != null && s.Probation == s.Current.Id; }

        /// <summary>The newest build known to work here: the current one, unless it is on probation.</summary>
        public static Build LastGood(State s) { return OnProbation(s) ? s.Previous : s.Current; }

        /// <summary>
        /// What a build on probation has shown: `ran` is how long it ran (to its exit, when it exited), exitCode is null while
        /// it still runs. Running is also the verdict for a clean exit inside Grace: it stays on probation, watched again next start.
        /// </summary>
        public static Verdict Judge(TimeSpan ran, int? exitCode)
        {
            if (ran >= Probation) return Verdict.Passed;
            if (exitCode == null || (exitCode == 0 && ran < Grace)) return Verdict.Running;
            return exitCode == 0 ? Verdict.Passed : Verdict.Crashed;
        }

        /// <summary>
        /// Whether to try the pending build on this start. A "file" build isn't tried while a copy of the app is already
        /// running (#1522): a single-instance app hands the new start off to that copy and exits 0 without writing the file,
        /// which proves nothing about the new build and mustn't count against it. The current build starts instead, and the
        /// new one waits for a start with nothing running. An "alive" build is tried anyway: a clean exit already passes its
        /// start and leaves it on probation (Judge). `copyRuns` is asked only when it decides.
        /// </summary>
        public static bool TryNow(State s, Func<bool> copyRuns)
        {
            if (s.Pending == null) return false;
            if (s.Current == null || s.Pending.Started == "alive") return true;
            return !copyRuns();
        }

        /// <summary>
        /// Whether the feed, naming `build`, took back the pending build (a roll back, #1942): it names an older one, or the
        /// current one, which leaves nothing to try. A higher number reads as a newer build, so the pending one is
        /// tried meanwhile: else an app published often would never get past downloading.
        /// shortcut: a roll back to a run Citadel no longer keeps is published under a new number, so it isn't seen as one; a
        /// field in the feed if that happens. With no current build there is nothing to run instead, so the pending one stays.
        /// </summary>
        public static bool Withdrawn(State s, int build)
        {
            return build > 0 && s.Pending != null && s.Current != null && (build == s.Current.Id || build < s.Pending.Id);
        }

        /// <summary>The pending build said it started: it is current, on probation, and the last good build stays to go back to.</summary>
        public static void Started(State s)
        {
            s.Previous = LastGood(s);
            s.Current = s.Pending;
            s.Pending = null;
            s.Probation = s.Current.Id;
        }

        /// <summary>The build on probation ran it out or exited cleanly: it is good, and its record is clean.</summary>
        public static void Passed(State s)
        {
            s.Probation = 0;
            if (s.Struck != null) s.Struck.Remove(s.Current.Id);
        }

        /// <summary>The pending build didn't start: the current one runs instead, and the pending one waits for its second try unless this was it.</summary>
        public static Rollback StartFailed(State s)
        {
            var bad = s.Pending;
            var r = new Rollback { Bad = bad.Id, Back = s.Current == null ? 0 : s.Current.Id, Refused = Strike(s, bad.Id) };
            if (r.Refused) s.Pending = null;
            return r;
        }

        /// <summary>The build on probation crashed: back to the last good build. Null when there is none (it stays current, on probation).</summary>
        public static Rollback Crashed(State s)
        {
            if (!OnProbation(s) || s.Previous == null) return null;
            var bad = s.Current;
            var r = new Rollback { Bad = bad.Id, Back = s.Previous.Id, Crashed = true, Refused = Strike(s, bad.Id) };
            s.Current = s.Previous;
            s.Previous = null;
            s.Probation = 0;
            // A newer build already waiting is tried instead of the second go.
            if (!r.Refused && s.Pending == null) s.Pending = bad;
            return r;
        }

        /// <summary>Count a failure: the first strikes it, the second refuses it. True when it is refused.</summary>
        static bool Strike(State s, int id)
        {
            if (s.Struck == null) s.Struck = new List<int>();
            if (!s.Struck.Contains(id)) { s.Struck.Add(id); return false; }
            s.Struck.Remove(id);
            if (!s.Failed.Contains(id)) s.Failed.Add(id);
            return true;
        }

        /// <summary>Whether to download the build the feed names: one this PC doesn't have and hasn't refused.</summary>
        public static bool WantsBuild(State s, int build)
        {
            return build > 0 && (s.Current == null || s.Current.Id != build) && (s.Pending == null || s.Pending.Id != build) && !s.Failed.Contains(build);
        }
    }

    public class Rollback
    {
        public int Bad;
        /// <summary>The build that runs instead; 0 when there is none (a first build that didn't start).</summary>
        public int Back;
        /// <summary>It crashed on probation; else it didn't start.</summary>
        public bool Crashed;
        public bool Refused;

        /// <summary>The one line the person sees.</summary>
        public string Notice(string title)
        {
            return title + " build " + Bad + (Crashed ? " crashed" : " didn't start") + ", so it went back to build " + Back + ". Build " + Bad
                + (Refused ? " won't be tried again." : " gets one more try next time.");
        }
    }
}
