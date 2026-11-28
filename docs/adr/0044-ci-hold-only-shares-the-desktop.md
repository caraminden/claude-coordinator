# 0044: The CI hold stops only what shares the desktop with a ship

Date: 2026-11-27. Minion #2256, from the effort retro #2254 (#2209's ship lesson and risk reason). Narrows the
hold (#1902) now that ADR 0043 moved ship CI to GitHub's runners.

## Their words

- Josh, 2026-11-24 (the hold's origin, `src/ci-hold.ts`): "Deploys first: while a ship is in line, nothing optional runs on the CI desktop".
- Cara, 2026-11-27, on #2198's card: "I think that github should actually be the main CI? with my desktop as the fallback".

## Context

The hold classed tests.yml runs by branch alone, and counted every ship in Citadel's line as holding the desktop. After
#2209 a ship's push tests on GitHub's 20 shards, yet the hold still stopped hand-started branch runs dispatched with
`where=github` (about 2.5 h lost on #2209 itself), held desktop heavy jobs and suites for ships that never touched the
desktop, listed GitHub ship runs as the desktop's on the CI page, and (through `shipNow`) had `src/runner-cap.ts` take
Peek's build label off its desktop runners while a Citadel ship was in line (2026-11-27 evening: Peek's Windows ship
jobs had nowhere to run).

## Decision

- **A tests.yml run on GitHub's runners is outside the hold**, like a pre-ship run (#2210): never stopped, never a ship
  holding the desktop, never on the desktop's running list or in its one-job slot. Where a run goes is read from its jobs,
  as land.sh does (`tools/land/ci.sh`): a `test` job not skipped is the desktop's; a `times` or `shard (…)` job not
  skipped is GitHub's. Read once per run and kept. Until its jobs say: a ship's run counts as the desktop's (the old,
  safe side), a running suite too (only the desktop's test job asks and runs that early), and a queued one waits for
  the next look.
- **The ship line holds the desktop only while ships' pushes test there**: the repo variable `CI_RUNNER` is `desktop`
  (read every 5 minutes). Unset or anything else, ships go to GitHub and only a ship's run actually on the desktop (land.sh's
  fallback, `where=desktop`) holds optional work, with the same settle time after it as before.
- **A GitHub branch run doesn't yield for GitHub's 20-job account cap.** A `where=github` run takes the 20 slots for about
  5 minutes; a ship pushed meanwhile can't start its shards within `LAND_CI_GH_START` (60 s) and falls back to the desktop,
  which is now free for it. Stopping the branch run instead would restart it from scratch in every gap between ships, the
  loss this ADR is about; a few minutes of a ship on the slower desktop is the cheaper side. Tested in `test/ci-hold.test.ts`.
- Main's full-run wait (MAIN_WAIT_MS) and the ship's own run are unchanged, except that main's desktop run no longer waits
  for ships testing on GitHub.

## Left alone

`ci_busy` in `tools/deploy-queue.sh` (a pipeline file) still counts a GitHub ship run as the desktop busy, so a ship's own
check or the early next train waits for it; that is a separate pipeline-lane change. The hold's judge replay
(`tools/judge-replay.ts ci-hold`) can't read past runs' jobs, so it still treats every past run as the desktop's.
