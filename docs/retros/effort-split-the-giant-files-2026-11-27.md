# Effort retro: Split the giant files (Nov 24–26, 2026)

The server started this effort retro (#2216) once the effort's four minions had closed. They ran from 16:06 PST Nov 24
to 23:28 PST Nov 26 (the retro's brief). #1786 had added the 1,500-line limit, so #1840, #1842 and #1843 each split one
giant file. Josh then picked #2045 on #2027's gaps card, after runner.ts had grown back. Times are Pacific.

| | Count |
|---|---|
| Minions | 4, all shipped |
| Cost | $51.81: #1840 $16.55, #1842 $16.35, #2045 $10.40, #1843 $8.51[^cost] |
| `src/db.ts` | 4,135 → 843 lines (925 on main now)[^size] |
| `src/mcp.ts` | 2,939 → 304 lines (307 now)[^size] |
| `src/runner.ts` | 5,827 → 4,669 after #1840 → 4,093 now, after #2045. #2045 aimed under ~3,000[^size] |
| Land conflicts naming the effort's branches | 4: three for #1842 (`size-budget` twice, `db.ts` once), one for #1840 (`runner.ts`)[^land] |
| Refused hand-offs | #1842 3, #1840 1, #2045 1[^land] |

## Fixes

1. **Moving code out of runner.ts quietly dropped its tests from the pre-ship pick.** This cost no ship in round 1, but
   it is the one cost here that no check catches.
   - `tools/affected-map.txt` gives `src/runner.ts` seven rule tests, among them `closed-cleanup` and
     `background-jobs` ("broke ships #1449-#1464"). Those tests import runner.ts, not the new modules.
   - So after #1840, a change to `src/closing.ts` picked none of the seven, only the generic always-tests. The same
     went for the other eight modules #1840 made[^map].
   - #2045 met this at the line. CI refused it at 22:04 PST Nov 26 on `test/front.test.ts`, because `src/reader.ts`'s
     stand-in Runner lacked the moved helpers (the refusal's time from [^land], the test from [^r2045]). Only then did #2045 add map rows for its own five files. #1840's
     nine stayed unmapped, and every one of #1840's hand-offs said "affected-map not fixed (pipeline file)"[^r1840].
   - **Shipped here:** the nine modules take runner.ts's rows in `tools/affected-map.txt`, plus a comment there saying
     a module moved out of a mapped file takes its rows. A change to `src/closing.ts` now picks `closed-cleanup` again[^map].
   - **Handoff (this repo):** a one-hop inherit in `tools/affected.ts`, so the next split
     (`src/routes/projects.ts`, `src/routes/tickets.ts` and `src/tripwire.ts` are queued) needs no hand rows.
     `shared/project/handoffs/handoff-citadel-split-inherits-map.md`.
2. **runner.ts took two rounds and still missed its target. The first round cut by size, though ADR 0024 says to cut by
   seams.**
   - #1840 was cut into six move-only pieces and ended at 4,669 lines[^size][^r1840]. Other ships then grew the
     file, so #2027 reported it regrowing. #2045 was the round 2 Josh picked, aimed under ~3,000[^r2045]. Partway
     through, Cara answered "Move them too" on the side jobs, and ADR 0024 was amended[^r2045].
   - db.ts and mcp.ts had natural seams (areas, tool families) and needed one round each. runner.ts's shared Maps
     and store keys are the reason ADR 0001 and ADR 0024 give for why it won't cut by size.
   - No edit: ADR 0024 already says "The cut is not by size". The miss was the brief not pointing at it. It is in one retro only,
     so it stays a note to watch for.
   - **Shipped here:** `test/size-budget.test.ts`'s runner.ts reason said "a split into its seams is queued", which went
     stale on #2045. It now names the two splits and what is left.
3. **#1840 built all six pieces up front and then waited about a day and a half, so pieces 4 to 6 were rebuilt.**
   - Its six commits came together early on Nov 25. The Taskmaster then shipped them in the order #1842, #1843,
     #1840, and piece 6 was sealed until Build 7 shipped at about 16:20 PST Nov 26[^r1840].
   - Pieces 4 to 6 were rebuilt on a fresh main after each ship. Piece 6 was rebuilt twice: once for Build 7, once
     after #2137. It met one `runner.ts` conflict at its hand-off[^r1840][^land].
   - **What worked:** each rebuild reran #1840's scripted move on the new base, instead of resolving conflicts by
     hand. #2045 reused that script and the deps-object pattern from #1840's handoff. It started from that handoff,
     not from a guess[^r2045].
   - No edit: building ahead was cheap because the move was scripted.
4. **Conflicts on the shared counts file again: a ledger repeat that #1917 has since fixed.**
   - #1842's conflicts were on `test/size-budget.test.ts` twice, with #1855 and #1918, and on `src/db.ts` once, with
     #1877. It met 19 train-prep warnings on Nov 25 on db.ts alone[^land].
   - #1917, live 02:44 PST Nov 25, made size-list edits merge. No `size-budget` conflict named the effort's branches
     after that[^land]. No edit.

## Spec gaps

- Round 1's briefs gave no target size. #2045's gave one (~3,000), and it was missed by about 1,100 lines with no ask.
  Whether 4,093 is "done" is for Josh to judge, since he picked #2045.
- The side jobs were left out of round 2 by ADR 0024's earlier call, until Cara said "Move them too". That reversal
  set what round 2 moved, which is a core-shape choice.

## Keep

- The scripted move with a self-check, reused across both runner rounds and replayed on each new base.
- db.ts and mcp.ts one family per ship, with the two minions sealing and waking each other in the Taskmaster's order.
  That is a clean serial chain with no overlap.
- Each split lowering its own `size-budget` number in the same commit.

[^cost]: `host_check db`: `SELECT t.number, round(sum(u.cost_usd),2) FROM tickets t JOIN turns u ON u.ticket_id=t.id WHERE t.project_id=2 AND t.number IN (1840,1842,1843,2045) GROUP BY t.number`, run 2026-11-27.
[^size]: `git show 96e1961e2^:src/db.ts | wc -l` (4135), `git show 2a220a97c:src/db.ts | wc -l` (843); `git show 92453750b^:src/mcp.ts | wc -l` (2939), `git show fce1246f3:src/mcp.ts | wc -l` (304); `git show d14208a54^:src/runner.ts | wc -l` (5827); `wc -l src/runner.ts src/db.ts src/mcp.ts` on main a54fc8019 (4093, 925, 307), run 2026-11-27. The 4,669 is a Grunt's count at #1840's last piece: my guess within a few lines.
[^land]: `grep -hE 'land conflict|train prep conflict|timing' shared/project/retro-log/2026-11-2[4-7]/land.md | grep -E '1840|1842|1843|2045'`, run 2026-11-27. The refusal counts are from a Grunt's reading of those lines, and #1842's three earlier refusals had no cause traced.
[^map]: `node tools/affected.ts --paths src/closing.ts`, before and after this retro's map edit, run 2026-11-27 (before: 6 generic tests; after: 13, with closed-cleanup and background-jobs).
[^r1840]: `read_minion 1840`, last 50 entries, read 2026-11-27.
[^r2045]: `read_minion 2045`, last 50 entries, read 2026-11-27.
