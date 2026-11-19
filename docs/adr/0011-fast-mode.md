# Fast mode: land now, test behind

Status: accepted, 2026-11-19 (#1017's grilling round, built in #1017).

From #1006's report (`reports/ci-test-policy-2026-11.md`), package B: a scheme can land a change on the smoke check
alone and run the full suite on main behind it. It came after the roll-back button (ADR 0010; Cara, 2026-11-18: "No
build, rollback first").

- **The setting** (Cara, 2026-11-19: "Off and Fast"): `projects.land_mode` is `off` or `fast`, set from Settings, Minion
  rules, CI, or the `set_project_settings` tool. Turning it on is refused while the scheme's `tools/land.sh` doesn't
  know `LAND_FAST` and `--verify`, so a scheme re-syncs from the kit's land template first. Citadel's own scheme stays
  off (Cara: "Later"). Around 2026-11-26 the other schemes' numbers go to Cara, with the question for Citadel.
- **Which lands are fast** (Cara, 2026-11-19: "Label, plus pipeline files"): a land labelled low or medium gets
  `LAND_FAST=1`, and the template lands it on `SMOKE_CMD` alone, with no `CHECK_CMD` and no CI wait. High-risk lands keep
  the full gate. So do branches that touch the land pipeline (`tools/land.sh`, `tools/land.local.sh`, anything under `.github/`, the lanes file) or a
  scheme's own `FAST_FULL` globs.
- **Testing behind** (Cara, 2026-11-19: "One run, newest main"): `src/fast-mode.ts` runs `tools/land.sh --verify` (the
  full check and CI on that commit) as a host job, outside the deploy lock. It runs in a kept worktree per scheme, one
  run at a time, always on main's newest head. A green run moves last green forward.
- **Pinning a red over several lands**: the ids that fail and aren't on the known-red ledger are new. With more than one
  commit since the last verified head, it runs the commits oldest first until one fails on a new id; that commit is
  the culprit. Over 8 commits, or on the first run after fast mode goes on (main may have been red already), the
  Taskmaster gets it.
- **Who fixes a red** (Cara, 2026-11-19: "Reopen that minion"): the culprit commit's minion is the landing that put it on
  main, or the nearest landing after it on main. Failing that, it's the `#N` in the commit's subject. That minion is
  woken with the failing ids and the output's tail. If it isn't fixed in 30 minutes, the Taskmaster is told, once.
- **The known-red ledger**, per scheme: each failing id records its culprit's #N. A run failing only on known ids blames
  nobody. A land's smoke check, check and CI wait don't refuse on a known id: they go on, saying "known red, #N is
  fixing it" (`LAND_KNOWN_RED`). An id leaves the ledger once a run on main passes it.
- **No Mandate alerts for fast lands' reds** (Cara, 2026-11-19: "We should also not send Mandate alerts for CI failures
  in fast mode, they are expected to some extent"): in a fast scheme, CI health doesn't wake the Taskmaster or open an
  item for a red push run on main. Fast mode owns those reds. A scheduled or manual run's red still alerts.

Limits we know about:

- A fast land still queues behind gated landings in the same line. It is a batch of its own and doesn't wait for theirs.
- A CI red counts as one id per workflow (`ci:<file>`), so a known red on a workflow lets through every other failure
  in that workflow until it clears.
- A run with no verdict (CI never answered) marks that head stuck and isn't retried until main moves.
- The branch is assumed to be `main`, as in every scheme the kit has set up so far.
