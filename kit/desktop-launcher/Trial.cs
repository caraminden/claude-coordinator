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
        [DataMember(Name = "previous", EmitDefaultValue = false)] public Build Previous;
        [DataMember(Name = "pending", EmitDefaultValue = false)] public Build Pending;
        /// <summary>Builds that failed their start: never tried again.</summary>
        [DataMember(Name = "failed")] public List<int> Failed = new List<int>();
    }

    public enum Verdict { Running, Passed, Crashed }

    public static class Trial
    {
        public static readonly TimeSpan Probation = TimeSpan.Zero;

        public static bool OnProbation(State s) { return false; }

        public static Build LastGood(State s) { return s.Current; }

        public static Verdict Judge(TimeSpan ran, int? exitCode) { return Verdict.Passed; }

        public static void Started(State s)
        {
            s.Previous = s.Current;
            s.Current = s.Pending;
            s.Pending = null;
        }

        public static void Passed(State s) { }

        public static Rollback StartFailed(State s)
        {
            var r = new Rollback { Bad = s.Pending.Id, Back = s.Current == null ? 0 : s.Current.Id, Refused = true };
            s.Failed.Add(s.Pending.Id);
            s.Pending = null;
            return r;
        }

        public static Rollback Crashed(State s) { return null; }

        public static bool WantsBuild(State s, int build)
        {
            return build > 0 && (s.Current == null || s.Current.Id != build) && (s.Pending == null || s.Pending.Id != build) && !s.Failed.Contains(build);
        }
    }

    public class Rollback
    {
        public int Bad;
        public int Back;
        public bool Refused;
        public string Notice(string title) { return ""; }
    }
}
