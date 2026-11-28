# Effort retro: Quick train (Nov 27, 2026)

The server started this effort retro (#2294) once the effort's four minions had closed. They were pieces 2 to 5 of
the quick train that #1910 designed on Nov 24 (ADR 0035, `specs/quick-train.md`, `handoffs/quick-train-2` to `-5`).
Piece 1 (who qualifies) had shipped before, as #1912. All four were created at 14:08 to 14:10 PST Nov 27 and closed
from 19:59 to 23:34 PST the same day[^created]. Times are Pacific.

| | Count |
|---|---|
| Minions | 4, all shipped: #2242 promised runner, #2243 gap train, #2244 run behind, #2245 page[^created] |
| Cost | $53.95 in all: #2242 $12.17, #2243 $14.33, #2244 $14.38, #2245 $13.07[^cost] |
| Ship attempts | 5 timing lines: 4 landed, 1 refused at CI (#2244)[^timing] |
| Land conflicts | 0 on the effort's branches[^conflicts] |
| Flakes | 2, both passed on a rerun in CI: `land-train-suspects` (#2243) and `land-train-suspects-3` (#2244)[^timing] |
| Size limits raised on a person's go | 2: #2243 (about 23 KB), #2244 (251 KB to 261 KB)[^reads] |
| Ships the quick train judged on Nov 27 and 28 | 151: 51 "would qualify", 0 taken, as the train is off. The top reasons not: risk medium 54, risk high 27[^judged] |

## Fixes

1. **The five handoffs were written together on Nov 24 and started three days later. Their premises went stale, and
   the siblings' shared parts were never compared.** This finding cost the most.
   - Piece 2 (#2242) was briefed to make the light check wait for a busy runner, and to use "skip numbers since
     #2209". But the own check, the only caller of the light check, had been off since 20:29 PST Nov 24. The minion
     found 0 light checks in 18 ships and built the wait from 45 older skips[^reads]. The Taskmaster's additions had
     caught #2209's change, but not the switch-off.
   - Pieces 2 and 3 each built their own side-runner lookup, and each had the same cleanup bug: a stopped run left
     its worktree, because under `set -e` the trap's `wait` on the killed run ended the cleanup early. #2243 fixed it
     in the quick check and passed the light check's copy on as held mail. It took a separate minion, #2265, to fix
     that copy[^reads][^fix].
   - Piece 5 (#2245) drew states from files that piece 4 (#2244) writes, and the two were built side by side. So
     every state the page shows other than "off" was stubbed in its shots. Its review found a hole between #2243's
     `quick.sh` and the page: a lone quick train shows as an ordinary "Releasing now" train. The fix needs a pipeline
     file, so it went to the Taskmaster as held mail[^reads].
   - This repeats `effort-ship-pipeline-review-2026-11-27.md` finding 1, so it gets a ledger row. Its guard, #2261
     (on main 20:31 PST Nov 27), makes a batch compare mechanisms before any create_ticket[^fix]. These four were
     created at 14:08 PST, before #2261 shipped. #2261 only checks at the point of writing, though. Nothing re-checks
     a handoff written days before its start.
   - **No edit here.** The Nov 24 handoffs predate #2261. The next retro on a batch of handoffs started more than a
     day after they were written checks two things: did the Taskmaster's start re-read the premise, and did #2261's
     mechanism list catch shared code like the runner lookup? If either missed, the edit goes at the start step of
     `citadel:briefing`.
2. **#2244 was refused at CI by a guard its own test run never picked.** This cost one queue wait and one CI cycle.
   - #2244 added `behind_verify` to `tools/land/`, and the new function reads CI's log. `test/land-verdicts.test.ts`
     ends with a guard that fails when such a function is neither benched nor on an exception list. The map lists that
     test for `tools/land/*.sh`, but only in the wide pick. `citadel-test --affected` runs the narrow pick, which takes
     only `@pinned` rule tests, so the guard never ran on perigee[^reads][^narrow].
   - Its first hand-off at 22:18 PST waited 681 s in line, then ran 290 s of CI before the refusal at 22:35. It shipped
     on the second hand-off at 22:51[^timing].
   - This repeats the ledger's row "A feeder's land runs only its own files' tests".
   - **Edit (shipped here):** `test/land-verdicts.test.ts` is `@pinned` in `tools/affected-map.txt`. A new test in
     `test/affected.test.ts` fails if the narrow pick for `tools/land.sh` or `tools/land/quick.sh` skips it. The test
     is red on main's map and green with the fix. The guard file takes about 4 s[^narrow].
3. **Cara's go depended on a recount a week later, and nothing held it.** The switch went on the same evening, and no
   one owns the recount.
   - At 8:53 PM PST Nov 27, Cara's go on #2243 was conditional: "Re-read this count after a week, with #1896's failing
     test looked up, before the quick lane skips CI for real." At 9:07 PM she wrote "I ran the command", so the flag
     file was there before piece 4's run behind existed. #2243 pointed out the slip. Cara picked "Off until the
     recount", and the file had to be removed by hand, because the tripwire guards the live checkout[^reads].
   - No schedule and no open minion holds the recount, which is due on or after Dec 4[^owner].
   - #2245's page now gives the reason the train is off, with the #1896 condition (fresh eyes put that condition back
     after the minion had dropped it)[^reads]. That covers what a person sees. It does not cover the date.
   - **Edit:** I didn't make one in the repo, because a gate that reads a date inside `quick.sh` would be a high-risk
     pipeline change for a single switch. Instead the recount brief is
     `shared/project/handoffs/quick-train-recount-dec4.md`, and I sent its path to the Taskmaster to schedule for Dec 4.
     It isn't on a start card, since starting it now would count only one day's data.
4. **Two pieces each needed a person's go to raise a ship-script size limit.** This is a pause, not a rework. Both
   raises were bundled into the ship card Cara was already answering[^reads].
   - **No edit.** The pieces were small. The limit exists to make someone look at growth, and it did that. If a third
     pipeline effort raises it twice, it gets a row.

## Spec gaps

- **Piece 3 before piece 4 (order, core flow).** The spec ordered the gap train before its run behind and kept the
  train off to cover the gap. Off held only as long as no one touched the switch (finding 3). Order a switch-off piece
  after the piece that makes it safe to switch on, or ship both together. **For Josh and Cara:** keep this order for
  the next phased pipeline feature, or require the safety piece first?
- **The lone quick train on the page (#2245).** No spec named how a quick train with an empty line shows. The page
  shows it as a full train for now. The fix sits with the Taskmaster.

## Checks the last retros left open

- `effort-ship-pipeline-review-2026-11-27.md` asked whether lands still waited long in line after #2099 split
  land.sh. Here the line waits were 1 s, 215 s, 681 s, 93 s and 239 s[^timing]. The 681 s wait was behind #2270's
  ship, not the lane. Not long.
- The burn-in row asks whether a refusal named the right case: none of the effort's ships was refused at burn-in.

## What to keep

- Every piece's Verifier found a real bug that the reviewers had missed (a stale reserved place, 7+ unpinned files,
  wrong states)[^reads]. Keep the Verifier on for pipeline work.
- Each piece's off test (the line ships exactly as today with the switch off) let three high-risk pieces ship in one
  evening with no conflicts and no rollback.
- #2245's take-A mock pick came before the build, and it cut the bars that had no data behind them (Josh's
  real-data rule).

[^created]: `sqlite3 -readonly coordinator.db "SELECT t.number, datetime(t.created_at/1000,'unixepoch','-8 hours'), datetime(t.closed_at/1000,'unixepoch','-8 hours') FROM tickets t WHERE t.project_id=2 AND t.number IN (2242,2243,2244,2245)"`, run 2026-11-28.
[^cost]: `sqlite3 -readonly coordinator.db "SELECT t.number, ROUND(SUM(u.cost_usd),2) FROM tickets t LEFT JOIN turns u ON u.ticket_id=t.id WHERE t.project_id=2 AND t.number IN (2242,2243,2244,2245) GROUP BY t.number"`, run 2026-11-28. The total is the sum of the four.
[^timing]: `grep -E 'timing|flake' shared/project/retro-log/2026-11-28/land.md | grep -E 'ticket/224[2-5]'`, run 2026-11-28. These are UTC lines, converted to Pacific.
[^conflicts]: `grep conflict shared/project/retro-log/2026-11-2[78]/land.md | grep -c -E '224[2-5]'` gives 0, run 2026-11-28.
[^judged]: `grep '· quick train ·' shared/project/retro-log/2026-11-2{7,8}/land.md`: 107 + 44 lines, 36 + 15 "would qualify", reasons from `grep -o 'not: [^;]*' | sort | uniq -c`, run 2026-11-28. A ship judged twice counts twice.
[^reads]: `read_minion` on #2242 to #2245 (last 50 entries each, read by two Sonnet Grunts), 2026-11-28. #2243's first 9 entries and #2245's first 7 were not read.
[^fix]: `git log --oneline main --grep='#2261'` (47bf4f126) and `--grep='#2265'` (168a7c3ce); the time from land.md's `quick train` line for ticket/2261 (04:31:13Z), run 2026-11-28.
[^narrow]: `node tools/affected.ts --narrow [--map <main's map>] --paths tools/land/quick.sh` (`--paths` last: it takes every argument after it) with main's map gives 0 `land-verdicts` lines, and 1 with this branch's map. The guard file's time is from `tools/citadel-node --test test/land-verdicts.test.ts` (16 pass, 3.6 s), run 2026-11-28.
[^owner]: `sqlite3 -readonly coordinator.db "SELECT id,name FROM schedules WHERE project_id=2 AND (name LIKE '%quick%' OR name LIKE '%recount%')"` gives no rows, and open tickets titled like `%recount%` or `%quick%` give only #2294, run 2026-11-28.
