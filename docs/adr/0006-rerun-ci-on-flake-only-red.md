# 0006: A land's CI run that is red only on flakes gets one fresh run

Date: 2026-11-15. Minion #769, from #767's land-failure report (`shared/project/reports/land-failures-2026-11-15.md`).
Cara, 2026-11-15, on #767's card: "2 Rerun CI on flake-only red"; on #769's plan card: "Plan approved: build it this
way."

This reverses Cara's 2026-11-10 "Keep failing, log it" (bb475202) for the CI gate.

## Context

`tools/run-tests.sh` reruns each file that failed in a red run once alone, only to label it: one that passes alone gets
"failed in the full run, passed alone" and a `flake` line in the retro log. The run stayed red, as Cara decided on
2026-11-10 ("Keep failing, log it"). In the 18 h before #767's report, 13 of 59 failed lands (22%) were reds in which
every failed file passed alone. Each one meant another wait and another wake, and a second trip through the line, and
the woken minion only ever said "flake, handing off unchanged" (median 11 s). #746 and #750 each hit it twice in a row.

## Decision

In `tools/land.sh`'s CI gate, a red run whose log has run-tests.sh's "<n> test file(s) failed; rerunning" line and a
"passed alone" label for all n files gets **one** fresh CI run of the same commit. The scratch branch `land/<branch>` is
deleted and pushed again, which starts a new run. The gate already passes over the red run as stale, so the red run is
never read as the answer.

- Only a fully green second run lands. A second red refuses whatever its labels say. One fresh run per land, never more.
- If the second run gets no answer (no runner, a timeout, GitHub down), it falls back to the full suite on perigee, like
  any unanswered run. That run never turns red into green either.
- It is no flake when any failed file failed again alone, hung, or wasn't rerun, and also when the run never got that far:
  more than five failed files, a hang of the whole run, a leak, a skipped test or a failed setup step.
- Each fresh run writes `flake rerun · <branch> · <files> · green|red|no answer` to the retro log, so the next report can
  count them.
- run-tests.sh is unchanged in what it does: its rerun alone still only labels, and its exit code stays red. A red run of
  the fallback on perigee still refuses at once.

## Consequences

About one extra CI run (2–4 min) per flake-only red, about 6 a day at the rate of the week of Nov 10. The land holds the
lock for that run, so the landings behind it wait that much longer. That is still shorter than the refused land's own
second trip through the line. Flaky files are still counted (`flake` lines) and still worth fixing: a rerun hides them
from the minion, not from the report.

The kit's `templates/land.sh` is unchanged. It runs a scheme's own `CHECK`, which has no "passed alone" signal, and
Peek's two flakes were `recipes.test` timeouts under load, which are better fixed in that test.
