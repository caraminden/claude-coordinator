# Retro: Plot 11, one runner pool (2026-11-27 to 2026-11-28)

Overseer #2267. Members P1 #2268, P2 #2269, P3 #2275, P4 #2283, P5 #2284, fixer #2291; P6 #2305 and P7 ship to main afterwards.
Formed 9:45 PM PST Nov 27 on Cara's approval of #2264's plan (~$205); shipped to main switched off at about 10:15 AM PST Nov 28 on Cara's go ("Ship it", "Lock until move-over"). Plot spend $95.92 plus the Overseer's ~$16 at ship.

## Timeline
- 9:48 PM: P1 and P2 start. Both merge by 10:50 PM; first full run red (access-matrix snapshot missing new routes), fixed by the Overseer.
- 11:46 PM: P3 merges; full run red on an import cycle (HEAVY_SIZES before initialization) P3's own merge didn't catch. P3 fixed it by 12:02 AM.
- 12:20 to 12:36 AM: P4 and P5 merge. Fable review: high, four fixes (one to P3, three to the fixer).
- 12:44 AM to 9:19 AM: the fixer waits about 8 hours on a claims ask the board dropped (it had no action). Cara asked why it stalled.
- 9:20 to 9:36 AM: fixer's three fixes merge; ship card posted. Cara's "Lock until move-over" adds ~15 lines and one more full run.

## Lessons and fixes
1. A cabal_board ask with no action was dropped silently; the fixer waited ~8 h. Fixed on main by #2300.
2. A lead needs a `wake_at` check-back while members work, so a lost ask or a stall shows within an hour, not overnight. Fix: citadel:cabal should say to set one after each start.
3. Members' file lists kept missing files (test files, one-line edits in another member's file): about one claims round trip per start. Fix: handoffs list the tests beside each source file; the Overseer runs `who-uses` on the listed files before forming.
4. A member's own merge misses import cycles and load flakes that only show in a full run. Fix: run `node tools/typecheck.ts` plus a load of every touched module (`node -e 'import(...)'`) before a member merges.
5. Handoffs for a Plot that ships switched off need a done line "no change on live with the switch off", so the review checks it (it found ShipWatch's extra reads only by luck).
6. A ship-card choice that adds code costs one more full run after the go: put such choices on the go card's draft before the last full run.
7. Board log lines and card questions are capped at 500 characters: write them short from the start.

## Open
- test/machine-worker-browser.test.ts went red once before ship (run 46171606751), green in the next two full runs; judged load, not proved. A second red opens a flake minion.
