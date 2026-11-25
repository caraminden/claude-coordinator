# 0035: Quick train: low ships that touch nothing sensitive ship on a quick check

Status: accepted, 2026-11-24, not built. Minion #1910. Design: shared folder, `specs/quick-train.md`; measured in
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
