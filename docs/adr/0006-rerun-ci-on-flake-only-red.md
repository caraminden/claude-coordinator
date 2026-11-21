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

- If the scratch branch can't be deleted, no fresh run starts and the red refuses as usual: pushing a commit the branch
  already has starts nothing, and waiting on it would read as CI being down.
- Only a fully green second run lands. A second red refuses whatever its labels say, unless it was cut off before any test failed (below). One fresh run per land, never more.
- If the second run gets no answer (no runner, a timeout, GitHub down), it falls back to the full suite on perigee, like
  any unanswered run. That run never turns red into green either.
- It is no flake when any failed file failed again alone, hung, or wasn't rerun, and also when the run never got that far:
  more than five failed files, a hang of the whole run, a leak, a skipped test or a failed setup step.
- Each fresh run writes `flake rerun · <branch> · <files> · green|red|no answer|not started` to the retro log, so the next report can
  count them.
- A run cut off from outside before any test failed (#1377, 2026-11-20: Node's `Interrupted while running:`, no
  `✖ failing tests:`, and not run-tests.sh's own hang stop) is no verdict on the commit. It gets the same one fresh run,
  logged as `cut-off rerun · <branch> · <run> · green|red|no answer|not started`; a second cut-off is no answer (the
  fallback; in a train's bisect, nobody is refused). A fresh run after a flake-only red that is cut off is no answer too.
  Run 44859457680 was interrupted at 55 s, and a bisect refused #1302 for it (reports/incident-2026-11-20-1840-cause.md).
- run-tests.sh is unchanged in what it does: its rerun alone still only labels, and its exit code stays red. A red run of
  the fallback on perigee still refuses at once.

## Consequences

About one extra CI run (2–4 min) per flake-only red, about 6 a day at the rate of the week of Nov 10. The land holds the
lock for that run, so the landings behind it wait that much longer. That is still shorter than the refused land's own
second trip through the line. Flaky files are still counted (`flake` lines) and still worth fixing: a rerun hides them
from the minion, not from the report.

The kit's `templates/land.sh` is unchanged. It runs a scheme's own `CHECK`, which has no "passed alone" signal, and
Peek's two flakes were `recipes.test` timeouts under load, which are better fixed in that test.

## Amendment, 2026-11-20: known flakes ship without the fresh run (#1419)

Cara, 2026-11-20, about 23:45 PST: "ok, here is a thought, what if we say that known flakes that havent been fixed are
acceptable and do not block ship trains from going live?" On the Taskmaster's card she picked "Known flakes only" over
"Any test that passes alone" and "Keep it as today": "Skip the extra run when each failed test has already flaked on other
ships in the last 2 weeks, or a minion is fixing it. A test flaking for the first time still gets the extra run, because a
new flake is often caused by the change being shipped."

Why: on Nov 20 and 21, 39 ships went through the fresh run. 20 came back green (about 5 minutes lost each), 16 came back
red again on flakes and were refused, and 1 got no answer.

- A red in which every failed file passed alone (as above) and every one of them is a known flake goes on as green, with
  no fresh run, no refusal and, on perigee's fallback, no retry in place (#1360). This holds for a train's run, its
  retests after suspects and its bisect too, since they all go through the same gate.
- Known means `tools/known-flakes.ts` says so: the file passed alone on at least one other branch in the last 14 days (the
  retro log's `flake` lines, which the Test health tab counts; `flake_events` rows keep no branch), or an open fix
  minion has it (`flake_fixes`, read-only; the reason names its #N). "Havent been fixed": once a fix minion's fix has
  passed its proof (its `flake_fixes` row is held), only sightings after that count. A sighting whose branch, or any
  rider on its train (the line's `with` part), is the ship's own branch or one of its riders' doesn't count; a train's
  sighting counts once, for its front.
- A known flake that the ship, or any ship on its train, changed, or that imports what they changed (the suspects' map,
  `train_suspects_of`), is never excused: it gets the fresh run as before.
- A file seen for the first time, a file that didn't pass alone, a run that also tripped the leak guard (leftover
  processes are no flake), or anything the helper can't read keeps the behaviour above.
- It says so plainly: `only known flakes failed …, so this goes on as green, with no fresh run`, then
  `shipped past known flakes <file> (seen on N other branches in 14 days, fix #N)` in the land's output and every
  rider's, the shipped line, the Releases news (as a warning), and a `known flake · <branch> · <files> · <run>` retro
  log line. The `flake` sightings are still written, so the Test health tab keeps counting and the automatic fix minions keep coming.
- Citadel only: the kit's `templates/land.sh` is still unchanged, for the reason above: a scheme's own `CHECK` gives no "passed alone"
  signal to know a flake by.

## Amendment, 2026-11-21: a second red of flakes only keeps the ship's place (#1419 part 2)

Cara, 2026-11-21, about 1:40 AM PST, on #1366 going to the back of the line after three flake refusals: "I thought they
were supposed to keep their spot not?" The Taskmaster's brief: keep its place, re-queued by the server, with a cap.

- When the one fresh run is red again and every failed file passed alone again, none of them changed by a ship on the
  train or importing what one changed, a plain land keeps its ticket (#1360's retry in place) instead of being refused:
  `refused on flakes only (…), not your change: keeping its place in line and riding the next train (N of 2)`.
- At most twice a hand-off (`FLAKE_KEEP_MAX`), counted apart from #1360's one pipeline retry; past that it is refused
  to its minion as before. A real failure or a touched file on the second red refuses at once, as before.
- The ship keeps its queue ticket, so a person's placement in the ship line stays. The shipped line says
  `Kept its place in line after N reds of flakes only.`, and each keep writes a `flake keep` retro log line.
