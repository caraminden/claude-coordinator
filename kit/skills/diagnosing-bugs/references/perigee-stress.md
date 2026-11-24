# Heavy and stress runs on perigee (Citadel's repo)

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
