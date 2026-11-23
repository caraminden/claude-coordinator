---
name: diagnosing-bugs
description: Diagnosis loop for hard bugs and performance regressions. Use when the bug-fixing skill's first reproduction attempt fails, the bug is intermittent or a test is flaky (also when the ask is to bump a wait or add a retry), a fix did not hold, something got slow, or the user says "diagnose" or "debug this".
---

# Diagnosing Bugs

A discipline for hard bugs. Skip phases only when explicitly justified.

When exploring the codebase, read the glossary the repo's CLAUDE.md names under "Project facts", if it has one, to get a clear mental model of the relevant modules, and check its decisions log (ADRs) in the area you're touching.

## Redact

This skill has you show commands, outputs and captured artifacts. **Redact every secret first**: write `<REDACTED>` in its place. Build loops against env vars, so the credential stays in the environment rather than in what you show. Captured artifacts carry auth headers: quote only the lines that carry the signal.

If the redacted output is not enough to diagnose the bug, say so and ask with a card.

## Three strikes

Each fix that didn't hold is a strike, counting one made under citadel:bug-fixing (arriving
from it, you are on your second try).

1. **First try:** diagnose with the phases below and fix.
2. **Second try:** take a different approach. Not a variation on the first fix: a
   different hypothesis, seam or loop.
3. **Third try:** question the assumption both fixes shared: the design, the spec, or
   what the bug even is.

After the third strike, stop and ask the user (a card, where the session has a card tool)
instead of trying a fourth. Keep a one-line log of every failed attempt (what you tried,
what happened, what you changed next) and put it in the question and the PR. This is the
one turn that may end on a red test: the question says the branch is red and must not
ship until it's answered.

## Phase 1: Build a feedback loop

**This is the skill.** Everything else is mechanical. If you have a **tight** pass/fail signal for the bug (one that goes red on _this_ bug), you will find the cause; bisection, hypothesis-testing, and instrumentation all just consume it. If you don't have one, no amount of staring at code will save you.

Spend disproportionate effort here. **Be aggressive. Be creative. Refuse to give up.**

### Ways to construct one, in roughly this order

1. **Failing test** at whatever seam reaches the bug: unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) that drives the UI and asserts on DOM/console/network.
5. **Replay a captured trace.** Save a real network request / payload / event log to disk; replay it through the code path in isolation.
6. **Throwaway harness.** Spin up a minimal subset of the system (one service, mocked deps) that exercises the bug code path with a single function call.
7. **Property / fuzz loop.** If the bug is "sometimes wrong output", run 1000 random inputs (on a runner if they are slow or heavy) and look for the failure mode.
8. **Bisection harness.** If the bug appeared between two known states (commit, dataset, version), automate "boot at state X, check, repeat" so you can `git bisect run` it.
9. **Differential loop.** Run the same input through old-version vs new-version (or two configs) and diff outputs.
10. **HITL bash script.** Last resort. If a human must click, drive _them_ with `scripts/hitl-loop.template.sh` so the loop is still structured. Captured output feeds back to you.

Build the right feedback loop, and the bug is 90% fixed.

### Tighten the loop

Treat the loop as a product. Once you have _a_ loop, **tighten** it:

- Can I make it faster? (Cache setup, skip unrelated init, narrow the test scope.)
- Can I make the signal sharper? (Assert on the specific symptom, not "didn't crash".)
- Can I make it more deterministic? (Pin time, seed RNG, isolate filesystem, freeze network.)

A 30-second flaky loop is barely better than no loop; a 2-second deterministic one is tight, a debugging superpower.

### Non-deterministic bugs

The goal is not a clean repro but a **higher reproduction rate**. Loop the trigger 100×, parallelise, add stress, narrow timing windows, inject sleeps. A 50%-flake bug is debuggable; 1% is not, so keep raising the rate until it's debuggable.

**Heavy runs go to a runner.** One repro run on perigee is fine. Loops, stress, parallel
runs and flake hunts run on a CI or desktop runner (the scheme's stress or flake workflow;
`citadel:run-on-windows` for Windows), because perigee carries every agent and the Citadel
server: a Peek minion's 100-run loop there helped push its load to 88.
A CI burn-in that failed (copies of one test file at once) is reproduced on perigee with one copy, the
scheme's queued local burn-in where it has one (Citadel's `tools/burn-in.sh <file>`: 4 copies, one heavy
job), or a CI re-run; never 10 copies at once by hand or in a loop (Citadel #1702's seven 10-copy rounds
stalled the server, Nov 23).

**On perigee, starve the test, not the box** (Josh, 2026-11-12, "Cap it: quota mode"). When a stress
run does run there, in a window a person picked, it runs one suite at a time, off-hours. Load comes from a
CPU quota on the test's own scope (`systemd-run --user --scope -p CPUQuota=10% <test command>`), which
reproduced Citadel #470's starved-turn flakes. A browser test whose process sleeps while the page's timers
run needs a different tool: an event-loop stall preloaded into the test process with `NODE_OPTIONS=--import`.
#470's run used busy loops on every core and two suites at once, which held the live server for more than
2 s 27 times in 90 minutes (worst 7.3 s).

**Stress runs don't share the ship gate's queue.** A runner that serves ships is theirs first. A run in
the gate workflow's concurrency group (Citadel's `citadel-tests`) holds it for the whole run, and a change
shipping meanwhile waits behind it. land.sh gives up on a runner after 90 s and falls back to the suite
on the host: Citadel #564's probes, each started only while the group was idle, still sent two ships to
perigee that way. So loop where ships don't wait (a stress workflow with its own group on a runner
ships don't use), or ask a person for a quiet window first. Checking for a queued ship before each push
isn't enough, because the ship arrives after the check.

### Flaky tests

Sleeps help reproduce a race; they never fix one.

- **A wait on a timer races the thing it waits for.** Wait on the condition itself: await
  the process's exit, poll the state with a deadline, bind port 0 and read the port back.
  Citadel's previews test failed now and then because stop deleted the preview's folder
  right after SIGTERM while the process was still writing there; the fix (#154) awaits
  the exit, with SIGKILL after 2 s, before deleting. Test servers that picked a free port
  and then bound it lost it to a parallel suite in between (#156).
- **Passes alone, fails in the suite:** an earlier test leaves something behind (a file,
  a process, an env var, a module cache). Bisect for the polluter: run half the earlier
  tests then the victim (on a runner when the halves are big), keep whichever half still breaks it, repeat to one test. Then
  check what that test leaves behind.

### When the first repro fails

List 3+ hypotheses about what triggers the bug (timing, data, environment, order), each
with an evidence plan: the repro it predicts, and what would rule it out. They are
guesses at how to reproduce it, not at what to fix, so they serve this phase. When they're
independent and slow to check, give each to its own investigator Grunt (the
citadel:subagents skill picks model and effort), and have each report confirmed, ruled
out or unclear, with the evidence.

### When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask with a card for: (a) access to whatever environment reproduces it, (b) a redacted captured artifact (HAR file, log dump, core dump, screen recording with timestamps), or (c) permission to add temporary production instrumentation. Do **not** proceed to hypothesise without a loop.

### Completion criterion: a tight loop that goes red

Phase 1 is done when the loop is **tight** and **red-capable**: you can name **one command** (a script path, a test invocation, a curl) that you have **already run at least once** (show the invocation and its output, redacted), and that is:

- [ ] **Red-capable**: it drives the actual bug code path and asserts the **user's exact symptom**, so it can go red on this bug and green once fixed. Not "runs without erroring"; it must be able to _catch this specific bug_.
- [ ] **Deterministic**: same verdict every run (flaky bugs: a pinned, high reproduction rate, per above).
- [ ] **Fast**: seconds, not minutes.
- [ ] **Agent-runnable**: you can run it unattended; a human in the loop only via `scripts/hitl-loop.template.sh`.

If you catch yourself reading code to build a theory before this command exists, **stop: jumping straight to a hypothesis is the exact failure this skill prevents.** No red-capable command, no Phase 2.

## Phase 2: Reproduce + minimise

Run the loop. Watch it go red as the bug appears.

Confirm:

- [ ] The loop produces the failure mode the **user** described, not a different failure that happens to be nearby. Wrong bug = wrong fix.
- [ ] The failure is reproducible across multiple runs (or, for non-deterministic bugs, reproducible at a high enough rate to debug against).
- [ ] You have captured the exact symptom (error message, wrong output, slow timing) so later phases can verify the fix actually addresses it.

### Minimise

Once it's red, shrink the repro to the **smallest scenario that still goes red**. Cut inputs, callers, config, data, and steps **one at a time**, re-running the loop after each cut, and keep only what's load-bearing for the failure.

Why bother: a minimal repro shrinks the hypothesis space in Phase 3 (fewer moving parts left to suspect) and becomes the clean regression test in Phase 5.

Done when **every remaining element is load-bearing**: removing any one of them makes the loop go green.

Do not proceed until you have reproduced **and** minimised.

## Phase 3: Hypothesise

Generate **3–5 ranked hypotheses** before testing any of them. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**: state the prediction it makes.

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

If you cannot state the prediction, the hypothesis is a vibe: discard or sharpen it.

**Show the ranked list to the user before testing.** They often have domain knowledge that re-ranks instantly ("we just deployed a change to #3"), or know hypotheses they've already ruled out. Cheap checkpoint, big time saver. Don't block on it; proceed with your ranking if the user is AFK.

## Phase 4: Instrument

Each probe must map to a specific prediction from Phase 3. **Change one variable at a time.**

Tool preference:

1. **Debugger / REPL inspection** if the env supports it. One breakpoint beats ten logs.
2. **Targeted logs** at the boundaries that distinguish hypotheses.
3. Never "log everything and grep".

**Tag every debug log** with a unique prefix, e.g. `[DEBUG-a4f2]`. Cleanup at the end becomes a single grep. Untagged logs survive; tagged logs die.

**Perf branch.** For performance regressions, logs are usually wrong. Instead: establish a baseline measurement (timing harness, `performance.now()`, profiler, query plan), then bisect. Measure first, fix second.
On perigee, a small slowdown hides in timing noise: count instructions instead with `citadel-callgrind <binary> [args]` (on every turn's PATH; `citadel-callgrind setup` once per account, `--help`). A single-threaded bench repeats its count exactly; with threads, run the baseline a few times first to see its spread. Build the bench without `-march=native` / `target-cpu=native`, and for Rust prefer `--target x86_64-unknown-linux-musl`.

## Phase 5: Fix + regression test

Write the regression test **before the fix**, but only if there is a **correct seam** for it.

A correct seam is one where the test exercises the **real bug pattern** as it occurs at the call site. If the only available seam is too shallow (single-caller test when the bug needs multiple callers, unit test that can't replicate the chain that triggered the bug), a regression test there gives false confidence.

**If no correct seam exists, that itself is the finding.** Note it. The codebase architecture is preventing the bug from being locked down. Flag this for the next phase.

Fix where the bad value first appears, not where it surfaces: trace back up the call chain, one caller at a time, to the first place the value is already wrong.

If a correct seam exists:

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail. If you forced the red by mutating code or a fixture, `diff` against a pristine copy to prove the mutation landed before you trust it.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario.

## Phase 6: Cleanup

Required before declaring done:

- [ ] Original repro no longer reproduces (re-run the Phase 1 loop)
- [ ] Regression test passes (or absence of seam is documented)
- [ ] All `[DEBUG-...]` instrumentation removed (`grep` the prefix)
- [ ] Throwaway prototypes deleted (or moved to a clearly-marked debug location)
- [ ] The hypothesis that turned out correct is stated in the commit / PR message, so the next debugger learns
