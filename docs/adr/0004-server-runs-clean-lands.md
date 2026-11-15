# 0004: The server runs a handed-off land, with no model

Date: 2026-11-14. Minion #706.

## Context

A minion used to land its change by running `tools/land.sh` itself: wait several minutes, read "ok", post the
shipped line, set pending-deploy or close. That tail of the turn cost about $0.35 of model calls per clean land
(`reports/cache-reads-2026-11-14.md` in the scheme's shared folder), all to read output that is nearly always
fine.

## Decision

The minion hands the land off with the `hand_off_land` tool and ends its turn. The server runs land.sh and
reports it. Cara, 2026-11-14: "why cant the land tail be blind to the context?", "we can hand back to the
original minion with the context if more work needs to happen or if issues are encountered", and on the card
"For the blind land tail ... what should run the happy path?": "The server, no model".

- land.sh, deploy.sh, the deploy lock, the test gate and the rollback are unchanged: the server runs the
  minion's own `tools/land.sh` as the container `land` tool already did (`src/land.ts`, a host job).
- The hand-off is a file in the landing's folder (`run/landings/<minion>/handoff.json`), so a land that ends
  across a restart (most often the restart its own deploy queued) is reported by the next server.
- Exit 0: the shipped line (commit, the minion's summary and risk label, live or waiting), then a dismissal, or
  pending-deploy when the restart is still to come. Exit 75 (no CI verdict): parked until the runners are back.
  Anything else, a run a restart cut off included: the minion is woken with the end of the output.
- Uncommitted work is refused before the minion ends its turn. A high risk needs the person's go named in the
  call. A message for the minion while the land waits (a person's or a relay) keeps it open. A build
  minion's take-in of main (`--into build/<n> --full`) isn't handed off.

## Consequences

- A clean land costs no model call after the hand-off.
- A failed land costs one turn, with the minion's own context, as before.
- The scheme instructions' "Shipping fixes" steps 3 to 5 now point at the tool (the Taskmaster edits them).
- Exit 75 still wakes the minion once the runners are back, to hand off again; the server doesn't retry by
  itself.
- #712 (Cara, 2026-11-14, on its card: "Build it as briefed"): in a scheme that owns contraptions, a clean land
  on main deploys the ones on main before the shipped line, through auto-deploy's start, and waits for the outcome.
  An app already running a commit that holds the land (a batch's other lands, a newer land's deploy) isn't deployed
  again. The line says whether each went live; a failed deploy wakes the minion with
  its log; `deploy: false` on the hand-off skips it. A land into a build branch deploys nothing.
