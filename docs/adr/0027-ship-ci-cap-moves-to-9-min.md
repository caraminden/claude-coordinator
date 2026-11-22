# 0027: A ship's CI wait moves from 6 to 9 minutes, on numbers

Date: 2026-11-22. Minion #1606, from the daily pipeline check (#1600): Cara picked "CI suite back under the cap" on
its "Pipeline fixes" card. Done when: "median green tests.yml on land/** is under 4 min over a day, or the cap is moved
on numbers with the reason written down."

## Context

land.sh waits `LAND_CI_TIMEOUT` for a ship's CI run, counted from the runner's pickup, with the burn-in's time (up to
`LAND_CI_BURN`, 180 s; burn-in.sh itself stops at 150 s) and a rerun window (`LAND_CI_RERUN`, ADR 0022) added on top. Past it the ship falls back to the full
suite on perigee. It was 360 s (#1361).

What grew, from tests.yml's step timings and logs on land/** (times PST):

- The suite itself, mostly. Summed test time in the product tier went from 1206 s (3234 tests, Nov 19) to 1907 s (4482
  tests, Nov 21): +58% in about 2.5 days. A pipeline-tier ship runs about 1600 s more (3500 s summed on Nov 22; the
  biggest are land-train 247 s, land-overlap 203 s, land 181 s). The full-suite step's median went from 107 s before
  Nov 20 to 244 s after #1477 and 257 s after #1565.
- Burn-in (#1443), new since Nov 21: median 30-40 s, and its whole 150 s limit on about 1 run in 8. The cap already
  credits it, so it lengthens the line but doesn't cause fallbacks.
- The box is near CPU-bound at 16 files at once (#1558's quiet rounds: 16 only about 20% faster than 8), so more
  concurrency won't buy it back.

On the cap's own clock (pickup to the suite's end, burn-in taken off), the 69 green land runs from Nov 21 11:30 to
Nov 22 ran p50 259 s, p90 353, p95 369, max 461. 6 of them passed 360 s, and the 7 cancelled runs were at 400-528 s.
A median under 4 min isn't reachable without cutting tests, which is ruled out.

## Decision

- `LAND_CI_TIMEOUT` goes to 540 s: past every green seen, with room for the suite's growth.
- tests.yml's job limit on land/** goes from 15 to 16 minutes, which test/ci-runner-choice.test.ts asks for
  (limit + rerun window + burn-in + 60 s).
- tests.yml's wait for the lands (the nightly's) counts land runs from the last 30 minutes, not 15: a ship's run can
  wait 15 for a busy runner and then up to 15 more.
- src/ci-land-gate.ts's `LAND_CAP_MS` follows (8 min into the CI wait, as 5 was for 6) and names the 9-min cap.

## Cost, and what it reverses

A run that truly hangs now costs its ship 3 more minutes before the fallback. Cara turned down "a global raise to
about 10 min" on Nov 20 for that reason (ADR 0022, "Not chosen"); this is a smaller raise made on a day's numbers, and
it goes to a member for a go before it ships. A fallback today costs the 6 minutes already spent plus the whole suite
on perigee, and hit about 1 green ship in 11.

## Not done here

- Burn-in skipping files whose last full-run time won't fit what's left of its 150 s: it would shorten the line, not
  the cap's clock, and those files gave no verdict anyway.
- Bigger levers, each a choice for a person: more of the desktop's threads for the WSL VM (16 of 32 today), speeding
  up the slow land-* test files, or GitHub's own runners (Actions minutes).
