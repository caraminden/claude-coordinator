# 0035: Quick train: low ships that touch nothing sensitive ship on a quick check

Status: accepted, 2026-11-24; the gap train built and off, 2026-11-27 (#2243). Minion #1910. Design: shared folder, `specs/quick-train.md`; measured in
`reports/quick-train-measured-2026-11-24.md`; five handoffs, `handoffs/quick-train-1` to `-5`.

- **Josh, 2026-11-24:** "what if we had a low risk ship lane that didnt run tests or ran very limited tests?" and "The idea
  would be to intelligently create trains of the same risk and therefore test requirements right?"; then, on the plan
  card: "Plan approved: build it this way." The plan is narrower than the "All low-risk ships" pick.
- **What it reverses:** Cara's "Fast mode on Citadel itself: Later" (2026-11-18) and "not on citadel" (2026-11-19). ADR
  0011's fast mode itself stays off for Citadel: this is a separate train.
- **Who qualifies:** risk low, no sensitive file (pipeline, saved data, sign-in and access, tripwire and push guard, kit
  templates, turn start, Citadel UI contract), every path known to the affected map, at most 40 test files picked. It is
  judged from the files, not the label.
- **Why not every low ship:** 73 of 317 low ships touched a sensitive file. 224 qualify (71%). Reds the quick check would
  have missed in 10 days: 4, all tests out of date or guards. Adding medium would have missed 6 of 16, two real bugs.
- **The train:** up to 6, in line order, after the full train in progress. The full suite runs on main behind it, once
  each. A red reopens the ship's minion. No auto-revert (#1006, M10). Nothing on perigee.
- **Ruled out:** a separate lane that moves main under a full run; a low ship filling an empty seat on a full train
  (#1899: each rider has its own full check); splitting quick trains by front end and server.
- **The gap train, built off (#2243, `tools/land/quick.sh`):** Cara, 2026-11-27: "Go, with both changes", the second
  "Re-read this count after a week, with #1896's failing test looked up, before the quick lane skips CI for real." So it
  ships switched off, and with it off the line ships exactly as before (`test/land-quick-train.test.ts`). A person turns
  it on after that recount, on perigee: `touch "$(git -C ~/claude-coordinator rev-parse --absolute-git-dir)/cc-deploy/quick-train-on"`;
  removing that file turns it off again, and `LAND_QUICK=0` turns it off for one ship. The plan pairs each quick train
  with a full run on main behind it (piece 4, below); before it, the only full suite over a quick top was the next full
  train's, so at most one quick train ships between full ones.
- **The run behind, piece 4 (#2244, `tools/land/behind.sh`, `src/fast-mode.ts`'s quick scheme):** each quick train
  shipped writes a line in `<state>/quick-behind` (its base, top, and each ship's top with its #N). The next full train's
  CI run counts: green over the top clears the line; red on a file that also fails alone on main's tip (`train_main_red`,
  which still ships through it, #2212) marks it. Else, with no ship waiting in line (30 minutes at most), the server runs
  `tools/land.sh --verify` on the top: the full suite on CI, out of line. A red's real files (not passed alone, not a
  known flake) run alone, twice, on the base and each ship's top, oldest first: the first ship one fails on is its
  culprit, whose minion is told with the failing files, tagged urgent so its fix goes first, and the Taskmaster hears
  after 30 minutes. Red on the base is main's own: the Taskmaster's. Passing alone everywhere blames nobody. Reuses fast
  mode's pin, ledger and escalation (ADR 0011), not a second hold. Off, no line is written and nothing runs.
