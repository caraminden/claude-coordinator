// Tests for the launcher's trial rules (../Trial.cs). Each test prints "ok <name>" or "FAIL <name>: <why>"; the exit
// code is the number that failed. test/desktop-launcher-trial.test.ts builds and runs this with perigee's .NET SDK.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.Serialization.Json;
using System.Text;
using Citadel.Desktop;

static class TrialTests
{
    static int failed;

    static void Is<T>(T got, T want, string what)
    {
        if (!EqualityComparer<T>.Default.Equals(got, want)) throw new Exception(what + ": got " + got + ", want " + want);
    }

    static void Test(string name, Action body)
    {
        try { body(); Console.WriteLine("ok " + name); }
        catch (Exception e) { failed++; Console.WriteLine("FAIL " + name + ": " + e.Message); }
    }

    static Build B(int id) { return new Build { Id = id, Exe = "App.exe", Started = "file" }; }

    /// <summary>Build 6 is current and good, build 7 is downloaded and waiting for the next start.</summary>
    static State Waiting() { return new State { Current = B(6), Previous = B(5), Pending = B(7) }; }

    static State ReadJson(string json)
    {
        using (var m = new MemoryStream(Encoding.UTF8.GetBytes(json))) return (State)new DataContractJsonSerializer(typeof(State)).ReadObject(m);
    }

    static string WriteJson(State s)
    {
        using (var m = new MemoryStream()) { new DataContractJsonSerializer(typeof(State)).WriteObject(m, s); return Encoding.UTF8.GetString(m.ToArray()); }
    }

    static int Main()
    {
        // 1. Probation: saying "started" doesn't end the trial; ten minutes without a crash, or a clean exit, does.
        Test("a build that says it started is current but still on probation, with the last good build kept", () =>
        {
            var s = Waiting();
            Trial.Started(s);
            Is(s.Current.Id, 7, "current");
            Is(Trial.OnProbation(s), true, "on probation");
            Is(Trial.LastGood(s).Id, 6, "last good");
            Is(s.Previous.Id, 6, "previous");
        });
        Test("the probation window is ten minutes of running, or a clean exit", () =>
        {
            Is(Trial.Probation, TimeSpan.FromMinutes(10), "window");
            Is(Trial.Judge(TimeSpan.FromSeconds(31), null), Verdict.Running, "just started");
            Is(Trial.Judge(TimeSpan.FromMinutes(9.9), null), Verdict.Running, "nine minutes in");
            Is(Trial.Judge(TimeSpan.FromMinutes(10), null), Verdict.Passed, "ten minutes in");
            Is(Trial.Judge(TimeSpan.FromMinutes(1), 0), Verdict.Passed, "closed cleanly a minute in");
            Is(Trial.Judge(TimeSpan.FromMinutes(1), 1), Verdict.Crashed, "exit 1 a minute in");
            Is(Trial.Judge(TimeSpan.FromMinutes(1), unchecked((int)0xC0000005)), Verdict.Crashed, "access violation a minute in");
        });
        Test("passing probation makes the build good: the next new build keeps it as the one to go back to", () =>
        {
            var s = Waiting();
            Trial.Started(s);
            Trial.Passed(s);
            Is(Trial.OnProbation(s), false, "on probation");
            Is(Trial.LastGood(s).Id, 7, "last good");
            s.Pending = B(8);
            Trial.Started(s);
            Is(s.Previous.Id, 7, "previous");
        });
        Test("a probation cut short (the launcher was closed) leaves it on probation, and a newer build still goes back to the last good one", () =>
        {
            var s = Waiting();
            Trial.Started(s);
            s.Pending = B(8);
            Trial.Started(s);
            Is(s.Current.Id, 8, "current");
            Is(s.Previous.Id, 6, "previous: the last good build, not the unproven 7");
        });

        // 2. A crash inside probation rolls back to the last good build, with one line for the person.
        Test("a crash inside probation goes back to the last good build and says so in one line", () =>
        {
            var s = Waiting();
            Trial.Started(s);
            var r = Trial.Crashed(s);
            Is(r != null, true, "rolled back");
            Is(s.Current.Id, 6, "current");
            Is(Trial.OnProbation(s), false, "the old build isn't on probation");
            Is(r.Bad, 7, "bad");
            Is(r.Back, 6, "back");
            var line = r.Notice("Test app");
            Is(line, "Test app build 7 crashed, so it went back to build 6. Build 7 gets one more try next time.", "notice");
            Is(line.Contains("\n"), false, "one line");
        });
        Test("a crash with nothing older to go back to keeps the build, still on probation", () =>
        {
            var s = new State { Pending = B(7) };
            Trial.Started(s);
            Is(Trial.Crashed(s), null, "no roll back");
            Is(s.Current.Id, 7, "current");
            Is(Trial.OnProbation(s), true, "on probation");
        });

        // 3. A failed build gets one more try on the next start, then it is refused.
        Test("a build that fails its start once stays waiting for one more try", () =>
        {
            var s = Waiting();
            var r = Trial.StartFailed(s);
            Is(r.Refused, false, "refused");
            Is(s.Pending != null && s.Pending.Id == 7, true, "still pending");
            Is(s.Failed.Contains(7), false, "not refused");
            Is(s.Current.Id, 6, "current");
            Is(r.Notice("Test app"), "Test app build 7 didn't start, so it went back to build 6. Build 7 gets one more try next time.", "notice");
        });
        Test("a build that fails its start twice is refused, as before", () =>
        {
            var s = Waiting();
            Trial.StartFailed(s);
            var r = Trial.StartFailed(s);
            Is(r.Refused, true, "refused");
            Is(s.Pending, null, "pending");
            Is(s.Failed.Contains(7), true, "refused for good");
            Is(Trial.WantsBuild(s, 7), false, "the feed's build 7 isn't downloaded again");
            Is(r.Notice("Test app"), "Test app build 7 didn't start, so it went back to build 6. Build 7 won't be tried again.", "notice");
        });
        Test("a crash inside probation counts as a failure: one more try, then refused", () =>
        {
            var s = Waiting();
            Trial.Started(s);
            Trial.Crashed(s);
            Is(s.Pending != null && s.Pending.Id == 7, true, "tried again on the next start");
            Is(s.Failed.Contains(7), false, "not refused yet");
            Trial.Started(s);
            var r = Trial.Crashed(s);
            Is(r.Refused, true, "refused");
            Is(s.Failed.Contains(7), true, "refused for good");
            Is(s.Pending, null, "pending");
            Is(s.Current.Id, 6, "current");
        });
        Test("a newer build waiting beats a second try of the crashed one", () =>
        {
            var s = Waiting();
            Trial.Started(s);
            s.Pending = B(8);
            Trial.Crashed(s);
            Is(s.Pending.Id, 8, "pending");
        });
        Test("a build that failed once and then passes starts with a clean record", () =>
        {
            var s = Waiting();
            Trial.StartFailed(s);
            Trial.Started(s);
            Trial.Passed(s);
            s.Pending = B(8);
            Trial.Started(s);
            Trial.Crashed(s);
            s.Pending = B(7);
            Trial.StartFailed(s);
            Is(s.Failed.Contains(7), false, "7's old failure was wiped when it passed");
        });

        // Saved data: a state.json written by launcher 1 reads as it is.
        Test("launcher 1's state.json: its current build is good and its refused builds stay refused", () =>
        {
            var s = ReadJson("{\"current\":{\"id\":6,\"exe\":\"App.exe\",\"started\":\"file\"},\"previous\":{\"id\":5,\"exe\":\"App.exe\",\"started\":\"file\"},\"failed\":[4]}");
            Is(Trial.OnProbation(s), false, "on probation");
            Is(Trial.LastGood(s).Id, 6, "last good");
            Is(Trial.WantsBuild(s, 4), false, "refused build 4");
            Is(Trial.WantsBuild(s, 7), true, "new build 7");
        });
        Test("launcher 1's state.json with a build waiting: it gets a trial with probation", () =>
        {
            var s = ReadJson("{\"current\":{\"id\":6,\"exe\":\"App.exe\",\"started\":\"file\"},\"pending\":{\"id\":7,\"exe\":\"App.exe\",\"started\":\"file\"},\"failed\":[]}");
            Trial.Started(s);
            Is(Trial.OnProbation(s), true, "on probation");
            var back = ReadJson(WriteJson(s));
            Is(Trial.OnProbation(back), true, "probation survives a save");
            Is(back.Previous.Id, 6, "previous survives a save");
        });

        Console.WriteLine(failed == 0 ? "all passed" : failed + " failed");
        return failed;
    }
}
