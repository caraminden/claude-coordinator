# 0021: A ship's reruns alone get a CI window of their own

Date: 2026-11-20. Minion #1374, with #1372's handoff on the same problem (its option (a)).
Cara, 2026-11-20 ~19:40 PST, on the Taskmaster's line that a run hit its 6-minute limit before it could rerun its
failures alone: "maybe that situation should restart the timer? instead of globally raising it to 10m?"

## Context

land.sh waits `LAND_CI_TIMEOUT` (360 s) for a ship's CI run, then falls back to the suite on perigee. Since #1240,
`tools/run-tests.sh` stops its reruns alone at `DEPLOY_RERUN_DEADLINE` (the run's creation + 330 s), so a red answers
red before land.sh stops waiting. On the evening of Nov 20 the desktop was busy (#1372: CPU pressure 44-66% while two
runners shared it), and the full run alone took 295-351 s. It ended at or past the deadline, so every failed file was
"not rerun: CI's answer is due" and a red of flakes only counted as real: no fresh run, and two of them fed bisects.
When reruns did get to run they took 2-10 s a file.

## Decision

- tests.yml reruns the full suite's failed files in a step of its own, `rerun failed files alone`, after `the full
  suite` (run-tests.sh's `DEPLOY_RERUN_LATER` and `DEPLOY_RERUN_FROM`). On a ship's run, that step's deadline is its own
  start + `RERUN_WINDOW` (180 s) - 30 s.
- At its CI limit land.sh looks at the run's steps once. If `the full suite` failed and the rerun step hasn't ended, it
  waits `LAND_CI_RERUN` (180 s, the same number, pinned by test/ci-runner-choice.test.ts) more, says so, and falls back
  at the end of that if the run still isn't done. A run still in its full suite falls back at 360 s as before.
- Nothing else changes: only a file that passed alone is a flake, an unrerun file keeps the run red, and a red of
  flakes only still gets exactly one fresh run that must be fully green (ADR 0006).

## Not chosen

- A global raise to about 10 min: ruled out by Cara, since a hung run would cost every ship 4 more minutes.
- Rerunning in parallel before the deadline, or reserving time for the reruns from the failed files' solo times
  (#1372's (b) and (c)): on Nov 20 the full run itself ended past the deadline, so neither would have had time left.

## Consequences

A red ship whose reruns run waits up to 3 min longer at most; a hung rerun costs that once. The step shows in the
ship's CI readout as its own step. The count of files being rerun isn't readable from GitHub while the step runs, so
land.sh's line doesn't name it; the run's log does once it ends.
