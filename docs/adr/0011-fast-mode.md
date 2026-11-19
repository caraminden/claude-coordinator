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
  scheme's own `FAST_FULL` globs, and every land in a scheme with no `SMOKE_CMD` (or with `LAND_SMOKE=0`).
- **Testing behind** (Cara, 2026-11-19: "One run, newest main"): `src/fast-mode.ts` runs `tools/land.sh --verify` (the
  full check and CI on that commit) as a host job, outside the deploy lock. It runs in a kept worktree per scheme, one
  run at a time, always on main's newest head. A green run moves last green forward.
- **Pinning a red over several lands**: the ids that fail and aren't on the known-red ledger are new. With more than one
  commit since the last verified head, it checks the commits oldest first for just those ids (`LAND_VERIFY_IDS`; with
  the scheme's `CHECK_FILE_CMD`, each failing file alone). Each id is blamed on the first commit failing it, and the rest
  go on to the next; ids no earlier commit fails are the head's. Meanwhile they count as known reds ("Citadel is finding
  whose land broke it"), and their 30 minutes start when the red was seen. Over 8 commits, or on the first run after
  fast mode goes on (main may have been red already), the Taskmaster gets it.
- **Who fixes a red** (Cara, 2026-11-19: "Reopen that minion"): the culprit commit's minion is the landing that put it on
  main, or the nearest landing after it on main. Failing that, it's the `#N` in the commit's subject. That minion is
  woken with the failing ids and the output's tail. If it isn't fixed in 30 minutes, the Taskmaster is told, once.
- **The known-red ledger**, per scheme: each failing id records its culprit's #N. A run failing only on known ids blames
  nobody. A land's smoke check, check and CI wait don't refuse on a known id: they go on, saying "known red, #N is
  fixing it" (`LAND_KNOWN_RED`). An id leaves the ledger once a run on main passes it.
- **No Mandate alerts for fast lands' reds** (Cara, 2026-11-19: "We should also not send Mandate alerts for CI failures
  in fast mode, they are expected to some extent"): in a fast scheme, CI health doesn't wake the Taskmaster or open an
  item for a red push run on main. Fast mode owns those reds. A scheduled or manual run's red still alerts, and so does
  any red from a workflow the scheme lists in its watched CI workflows (`ci_watch`): watching one is asking for it.

Limits we know about:

- A fast land still queues behind gated landings in the same line. It is a batch of its own and doesn't wait for theirs.
- Ids are what the parser in land.sh (`land_failures`) can name: `file::test` from node's spec output and pytest, the
  file alone from node's TAP and jest, `ci:<file>` per CI workflow. A known file id or workflow lets through every other
  failure in it until it clears. A scheme on another runner (cargo, go test) overrides `land_failures` in
  `tools/land.local.sh`, or its failures have no ids.
- A failing check whose output names no id, run beside a known red, isn't told apart from it at land time. A check that
  hits its time limit is never waived, and a red CI waits for its other workflows to finish before it's waived.
- A run with no verdict (CI never answered) marks that head stuck and isn't retried until main moves.
- The branch is assumed to be `main`, as in every scheme the kit has set up so far.
