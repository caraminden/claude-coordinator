# Effort retro: Ship pipeline review (Nov 24–27, 2026)

The server started this effort retro (#2259) once the effort's 39 minions had closed. They ran from 16:48 PST Nov 24
(#1863) to 14:02 PST Nov 27 (#1912)[^created]. Most came from the review of the ship pipeline (#1868) and its
follow-ups. They covered land.sh's refusals and blame, CI trains, the CI desktop, flakes, and in the end splitting
land.sh into `tools/land/`. Times are Pacific.

| | Count |
|---|---|
| Minions | 39. 37 shipped; #1897 was dismissed after 13 min and #1898 was dropped[^created][^reads] |
| Cost | $415.54 across 38 minions with turns. The top four: #1902 $48.67, #1899 $34.33, #2099 $28.86, #1864 $26.89[^cost] |
| Minions started in one hour | 9, from 19:36 to 20:38 PST Nov 24 (#1897 to #1906)[^created] |
| Minions whose commits edit `tools/land.sh` | 18[^files] |
| Ship attempts | 66 timing lines: 48 landed, 18 refused (7 at CI, 5 at guards, 4 in line, 2 at rebase)[^timing] |
| Guard refusals | All 5 on `test/size-budget.test.ts`: #1906, #1985, #1984, #2019, #2067[^guard] |
| Land conflicts | 5 (#2099 2, #1917 2, #1985 1), plus 11 train-prep conflicts. The top files are `test/size-budget.test.ts`, `src/routes/tickets.ts` and `src/ship-handoff.ts`, 6 each[^land] |

## Fixes

1. **Nine minions started within an hour on one review's findings, before the train design was settled. Three were
   overtaken within hours.** This finding cost the most.
   - Between 19:36 and 20:38 PST Nov 24, #1897, #1898, #1899, #1900, #1901, #1902, #1904, #1905 and #1906 all
     started from #1868's review[^created]. Several of them changed the same mechanisms: the train's split and
     bisect, and who rides it.
   - #1899 built the "checked ships only" train. Josh then wrote "I feel like we are thinking about this all wrong"
     and gave a 5-step model, so #1899 rebuilt from main's train. #1918 was created at 23:24 to build Josh's
     pull-the-likely-ships rule. #1899 closed three minutes later, its split already replaced[^created][^reads]. It
     cost $34.33 against $15 expected[^cost][^reads].
   - #1864 dropped LB5, the bisect part of LB4, and R1, because #1899, #1914 and #1918 had replaced them. #1865
     dropped a fix whose wording #1918 had replaced[^reads].
   - #1898 was stacked on #1871, which closed without shipping. After 16.9 h and $18.02, Josh picked "Drop it"[^created][^cost][^reads].
   - #1897 was dismissed after 13 min with no work done[^created].
   - #1902 ended at $48.67 against $25, as its ask changed mid-work ("After 4 h, ships wait")[^cost][^reads].
   - `citadel:briefing` part 4 already says to look for "an open minion deciding or building the same mechanism".
     But it is written for one brief at a time. When nine briefs are written in one turn, no sibling has files
     yet, so `who-touches` shows nothing, and the briefs never compared mechanisms with each other.
   - It is in this retro only. `effort-overseer-crews-2026-11-26.md` wrote its handoffs early too, but its misses
     were tools that didn't exist, not siblings overtaken. So there is no ledger row yet; a second case makes one.
   - **Handoff (this repo, the kit):** `shared/project/handoffs/handoff-citadel-batch-start-seams.md`. For a batch
     of briefs from one review, the briefing skill gets a step at the point of writing: list the mechanism each
     brief changes. Briefs that share one are merged, chained behind each other, or held behind the design pick.
2. **A single pipeline lane serialised an effort that was nearly all pipeline files.**
   - 18 of the minions edited `tools/land.sh`[^files]. Minions that had finished building sat sealed for hours.
     #1863's estimate was about 17 h with 12 ahead of it, and #1985 was "15th in line, about 140 min"[^reads].
   - #2067 held the claim for about 2.5 h while it waited for Josh's go on a high-risk ship. The claim passed on
     three times on the 10-minute rule[^reads].
   - The effort fixed this itself. With #1985 (closed 17:17 PST Nov 25), a holder that isn't ready is skipped, and a
     ship that shares no files with it goes beside it. With #2046, a hand-off the lane refuses waits armed and ships with no turn when the lane reaches it. With #2030, a refusal whose files passed alone re-queues once. #2099 split
     land.sh into 11 files under `tools/land/`[^files][^created].
   - **No edit.** The next pipeline retro checks the `line` seconds on timing lines after #2099, to see whether the
     wait is gone.
3. **`size-budget` was the only guard that refused, and land.sh was the file at its limit.**
   - All five guard refusals were `size-budget`[^guard]. #1906 was refused with land.sh at 3,042 lines against a
     3,028 limit, after #1865 had grown it[^reads].
   - #2067 was refused at 21:27 PST Nov 25, nine minutes after the always-tests started running on every
     `citadel-test`. It had waited 468 s in line and had rebased (7 s) first[^guard2]. Its read says it was 4 to 5
     lines over after rebasing onto #2071's raised limits. The ledger calls this a sum over other ships that no
     minion's own run can see. That it was such a sum here is my guess.
   - No `size-budget` conflict on the effort's branches came after #1917 shipped (02:44 PST Nov 25)[^sb].
   - **No edit.** #2099's split takes land.sh out as the one hot file, and #2139 (13:25 PST Nov 26) checks a ship's
     size room after main and the ships in line before the line. Both ledger rows are updated, and the next retro checks #2139.
4. **Faults in the test environment read as flakes, and three minions worked around one before a fourth fixed it.**
   - The container's git 2.39 ignores `attr.tree`, so `test/scheme-setup-land.test.ts` failed every time there.
     #1827, #1866 and #1983 each worked around it and wrote the same ship lesson. #2071 then fixed it in 1 h 56 min
     (20:02 to 21:58 PST Nov 25)[^created][^reads].
   - The same pattern showed up three more times:
     - The container's 63 MB `/dev/shm` failed `restart-anywhere` on base for #1865.
     - `jq` was missing on the desktop runners, which refused #1864.
     - #1960 was briefed from a lesson that three minions had each written[^reads].
   - **No edit.** #2249 (on main Nov 27) makes worker containers match perigee. The Taskmaster did start fix
     minions from the repeated lessons, though only after the third. This finding is in one retro only, so it is a
     note, not a row.

## Spec gaps

- **Core: the train's split rule.** Josh's 5-step model arrived while #1899 was building, and #1918's
  pull-the-likely-ships rule replaced #1899's split within the hour. Josh should judge whether the train rule now on
  main is the model he meant.
- #2099's plan guessed land.sh's parts would total 165 KB. After step 6 was skipped ("Skip 6, do step 7", Cara)
  they came to 219 KB. Step 6 held 5 KB, not 17 KB[^reads].
- #1865 reported "past $56 against the $28 estimate". `turns.cost_usd` sums to $14.55 for it, $2.60 of that in
  Grunts[^cost2]. I don't know which number is right. The budget line and the turns table should agree.

## Checks the last retros left open

- **No always-test refuses a ship after 21:18 PST Nov 25** (ledger, "A feeder's land runs only its own files'
  tests"). One did: #2067 on `size-budget` at 21:27, after its rebase[^guard2]. It may be the ledger's summed-growth
  case, but that is a guess.
- **A burn-in refusal after #2141 (20:15 PST Nov 26) names the right case.** No burn-in red line names this
  effort's branches after that time[^burn], so this check stays open.

## What to keep

- Briefs that named their neighbours and had a "Leave alone" list kept rebases small. #1959's brief protected
  #1928, #1925 and #1900, and #1925's gave line numbers[^reads].
- Holding a brief until another minion was live set the order with no guessing: #1912 behind #1899, #1984 behind
  #1902, #2104 behind #2099[^reads].
- Plan, then handoffs, then builds: #1910 led to #1912, and #1921 led to #2098 and #2099. The handoffs were used as
  written[^reads].
- Deep reviews and Codex found real bugs in #1925, #1960 and #1983[^reads].

[^created]: `host_check db`: `SELECT number, datetime(created_at/1000,'unixepoch','-8 hours'), datetime(closed_at/1000,'unixepoch','-8 hours') FROM tickets WHERE project_id=2 AND number IN (<the 39>)`, run 2026-11-27.
[^cost]: `host_check db`: `SELECT t.number, ROUND(SUM(u.cost_usd),2) FROM tickets t JOIN turns u ON u.ticket_id=t.id WHERE t.project_id=2 AND t.number IN (<the 39>) GROUP BY t.number` and the same without GROUP BY for the total, run 2026-11-27. #1897 has no turns.
[^cost2]: `host_check db`: `turns.cost_usd` summed for #1865, and `turn_grunts.cost_usd` joined on its turns, run 2026-11-27.
[^reads]: `read_minion` on each of the 39, read by six Sonnet Grunts on 2026-11-27 (last 30 entries each, so early turns are cut). The expected costs and quotes come from those reads.
[^files]: `git log main --since=2026-11-24 --format='COMMIT %h %s' --name-only`, keeping commits whose subject starts with `#<N>` for the 39 and counting distinct minions per `tools/land.sh` / `tools/land/*` file, run 2026-11-27.
[^timing]: `cat retro-log/2026-11-2[4567]/land.md | grep -E "· timing · ticket/($P)-" | grep -oE "refused at [a-z-]+|landed" | sort | uniq -c` in the shared folder, `$P` the 39 numbers joined by `|`, run 2026-11-27.
[^guard]: `cat retro-log/2026-11-2[4567]/land.md | grep -E "· guard ·" | grep -E "ticket/($P)-"`, run 2026-11-27.
[^guard2]: `grep -h "ticket/2067" retro-log/2026-11-2*/land.md`: `05:27:40Z · guard · … size-budget` in `2026-11-26/land.md` (UTC), and its timing line `line 468 · rebase 7 … refused at guards`, run 2026-11-27.
[^land]: `grep "· land conflict ·"` and `grep "train prep conflict"` on the same files, filtered to `ticket/($P)-` as the branch being prepped, run 2026-11-27.
[^sb]: `grep -E "conflict · ticket/($P)-" retro-log/2026-11-2[4567]/land.md | grep size-budget` (the effort branch as the one being prepped or landed): 6 lines (#1899 3, #1904 1, #1917 2), the last at 10:12:58Z Nov 25 (02:12 PST), before #1917's ship. Run 2026-11-27.
[^burn]: `cat retro-log/2026-11-2[4567]/land.md | grep -E "burn-in" | grep -E "ticket/($P)-"`: the last line naming an effort branch is 00:32Z Nov 26 (#2009). Run 2026-11-27.
