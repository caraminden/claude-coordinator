# Effort retro: Worker pool (Nov 24–25, 2026)

The server started this effort retro (#2116) once the effort's 21 minions had closed. They ran from 17:59 PST Nov 24
to 23:47 PST Nov 25[^t]. Josh asked for all of it, and his Taskmaster wrote every brief. It came in two waves.

- **Wave 1 (Nov 24 evening):** #1875 designed who gets the next worker. Its five handoffs became #1887, #1888, #1889,
  #1890 and #1892. #1909 and #1916 followed from Josh's card answers.
- **Wave 2 (Nov 25, 01:14 to 02:55 PST):** Josh asked "Why is the server getting overloaded?" and "We need to stop
  letting these load issues derail everything we are doing". Eight minions came from that in 101 minutes: #1928,
  #1929, #1930, #1931, #1949, #1950, #1951 and #1957[^t]. #1965, #1968, #1982, #1986 and #2004 followed from their
  reports and cards.

Times are Pacific.

| | Count |
|---|---|
| Minions | 21: 18 shipped code, 3 decided only (#1875, #1931, #1951) |
| Cost | $157.60, of which #1890 + #1916 = $43.39[^t] |
| Hand-offs to ship | 31: 19 landed, 12 refused[^l] |
| Minutes in the ship line | 1012 across the 18[^l] |
| Rebase conflicts naming the effort's branches | 39, 32 of them on `test/size-budget.test.ts`[^c] |

## Fixes

1. **Two pairs of minions built or decided the same thing at once.** This is the cross-minion miss, and it cost the most.
   - **#1890 and #1916.** #1890 ("End a waiting turn and wake it", from #1875's handoff) was open from 18:52 PST Nov 24.
     #1916 started at 22:54 as "a minion waiting on a card frees its worker". Its brief was then widened to also end the
     process and resume it on the answer[^t][^r]. The Taskmaster: "That was my mistake".
     - So #1916 overlapped #1890's own mechanism. Both built the hold length and the "woken goes first" pieces.
     - They settled it by message: #1916 put in stand-ins, and #1890 swapped them for its own on a rebase of 131
       commits with 10 clashing files[^r].
     - Together they cost $43.39, the two most expensive minions in the effort[^t].
   - **#1931 and #1951.** Both started at 01:36 and 02:32 PST Nov 25, two Opus design minions on one decision: how to
     keep the box from overloading[^t].
     - #1931 asked "worker lanes: worth building?". #1951 asked whether the pool should count test runs inside turns.
       #1951's brief listed #1931 as in flight[^r].
     - #1951 replayed Nov 25 for each take and had to redo the replay once. Then Josh answered "maybe we just do the
       quick lane and not this?" and picked "Build nothing for now"[^r]. That cost $6.48[^t].
   - **Why the guards didn't catch it:**
     - `citadel:briefing` part 4 asks what has already shipped. Part 5 runs `who-touches` on the files.
     - Neither asks whether an open minion is answering the same question. A design minion has no files yet, and
       #1916's widened brief named a mechanism, not a file.
     - The "Duplicate start?" check didn't fire either, because the titles differed.
   - **Fix (handoff, kit):** add a line to `kit/skills/briefing/SKILL.md` part 4. When the minions list shows an open
     minion deciding or building the same mechanism, the Taskmaster does one of two things:
     - sends the new ask to that minion with `message_minion`, or
     - names the seam in both briefs (who builds which piece, who ships second).
     It's a skill edit at the step where the mistake is made: writing part 4. Handoff:
     `shared/project/handoffs/handoff-citadel-worker-pool-overlap.md`.
2. **The ship line cost 1012 minutes, mostly on shared files and guards that `--affected` skipped (two ledger
   repeats).** No new edit: the guards have landed since, and this effort shows them holding.
   - **`size-budget` conflicts:**
     - 32 of the 39 conflict lines naming the effort's branches were on `test/size-budget.test.ts`. All of them fell
       between 21:43 PST Nov 24 and 00:11 PST Nov 25[^c].
     - #1917 made size-list edits merge by themselves (02:44 PST Nov 25). There were none on the effort's branches
       after that[^c].
     - #1888 alone spent 167 minutes in line over 3 tries[^l]. #1889, #1890, #1909 and #1916 were held on it[^r], so one
       shared-file fight held up five minions.
   - **Guards that the narrow pick didn't run:**
     - #1892 and #1957 were refused by `test/access-matrix.test.ts` (smoke, 20:23 PST Nov 24 and 05:12 PST Nov 25).
     - #1965 was refused twice at the line (06:04 and 06:23 PST Nov 25)[^l]. Its chat names `one-home`, then
       `config.test.ts`[^r].
     - #1957 and #1965 both wrote process notes saying `citadel-test --affected` missed them.
     - All of these came before #2065 (18:11 PST Nov 25). `one-home` and `config` are now on `tools/always-tests.txt`,
       and the smoke check follows the map for access-matrix[^a].
   - **The ledger's open check:**
     - The ledger asks whether any always-test refused a ship after 21:18 PST Nov 25. This effort's only ship after
       that hour, #2004 (23:46 PST), shows none[^l].
     - #1982 was refused by smoke at 19:32 PST Nov 25, in 20 s and before the line. The cause was its own test
       (`test/mem-room.test.ts` read the host's real heavy slice)[^r]. That's the smoke check working as meant.
     - The log line doesn't name the failing file, so the two smoke refusals elsewhere that night (#2074, and #1935
       into build/7) can't be judged from it. The check stays open.
3. **land.sh's burn-in refusal said "racy" for two more 10-of-10 failures that weren't races (a ledger repeat, new
   row).**
   - #1916: the tripwire read CI's temp folder as another person's home.
   - #1930: a test made a commit with no git identity on the CI runner. #1930's burn-in red is in the log at 02:48 PST
     Nov 25, on #1949's train[^l][^r].
   - Both minions first followed "fix the race". #1916's process note says the message "points the wrong way"[^r].
   - The last retro found the same thing on #1789 (plain reds). Its fix, "when every copy fails, run the file once alone
     and say which case it is", sits in `shared/project/handoffs/handoff-type-baseline-regenerates.md` and hasn't
     shipped.
     - That fix would also have named these two: a CI-only environment fault fails alone too, so it would read as
       "red alone, not a race".
   - **Fix:** no new handoff. I added both cases to that handoff's evidence, plus one line asking that its "red alone"
     wording name CI-only environment faults (temp paths, git identity) next to plain reds.
4. **A go card rested on numbers the minion later withdrew (#1928).**
   - Josh said "Ship it" on a report claiming the change was 2.7× slower. The table wasn't like for like, and the mawk
     test hadn't been run on main. The minion withdrew the numbers and asked again[^r].
   - One case, so no rule. `citadel:self-review`'s "numbers carry their query" already covers it.
5. **The pipeline lane was the other big wait.**
   - #1928, #1982 and #1986 each waited for the lane. #1902 held it while open, and the lane rule changed mid-effort
     (#1985)[^r].
   - Armed hand-offs (#2046, live 2026-11-25) now queue a refused pipeline ship with no turn. No edit; the next retro
     checks it.

## Spec gaps

- **#1986's brief lost the cap from its handoff.** The handoff said "up to 2 on top of the pool"; the brief said
  "counts over the size".
  - The first build had no cap and reached 6 of 3; the reviewers caught it[^r].
  - The cap sets how the core works, so it's for Josh to judge. Part 2 of the briefing skill ("their words") would
    have carried it if the handoff's line had been quoted rather than restated.
- **#1929's brief assumed `/dev/shm` would have room once cleaned.** At 63 MB it never does, so the test always uses
  disk[^r]. One case.
- **#2004's brief was written before its search.** The Taskmaster found #1258 and #1848 afterwards and sent 3
  corrections[^r]. The ledger row "Briefs state a guess as fact" covers this. Added to the row.

## What worked and should stay

- **#1875's handoffs were good briefs.**
  - #1887's named the cause and a leave-alone list, and shipped a one-line fix for $0.55[^t][^r].
  - #1889's named the drag twins and said to read #1888's live routes, not the handoff's guess[^r].
- **Small bugs went to Sonnet medium and shipped cheaply.** #1929, #1949 and #1968 cost $0.86 together[^t].
  - All three skipped the Grunt review, and #1929 and #1949 never ran their test red on main[^r]. That's acceptable at
    this size, but it's the next thing to check if one of them regresses.
- **#1931 and #1950 checked their own claims and retracted the wrong ones.**
  - #1931: easing held the pool small. In fact 26 of 37 easing stretches ended within 1.5 s of a restart.
  - #1950: a count it never gave.
  - Neither error reached a card[^r].

[^t]: host_check db, `select t.number, t.model, t.effort, datetime(t.created_at/1000,'unixepoch','-8 hours'), datetime(t.closed_at/1000,'unixepoch','-8 hours'), round(sum(u.cost_usd),2), round(sum(u.duration_ms)/60000.0) from tickets t left join turns u on u.ticket_id=t.id where t.project_id=2 and t.number in (1875,1887,1888,1889,1890,1892,1909,1916,1928,1929,1930,1931,1949,1950,1951,1957,1965,1968,1982,1986,2004) group by t.number`; costs summed, run 2026-11-26.
[^l]: `grep -h -E 'ticket/(<the 21 numbers>)-' shared/project/retro-log/2026-11-2[456]/land.md | grep ' · timing · '`: 31 lines, 19 ending `landed`; line minutes = the sum of `line N` / 60 per branch (#1888: 167). Smoke and burn-in lines from the same grep. Run 2026-11-26.
[^c]: the same grep, `| grep -E ' · (train prep conflict|land conflict) · '` = 39, of which `| grep -c size-budget` = 32. Those 32 run from 05:43:23Z to 08:11:35Z Nov 25 (21:43 PST Nov 24 to 00:11 PST Nov 25). "Naming" includes other ships rebasing onto an effort branch's train. Run 2026-11-26.
[^a]: `grep -nE 'access-matrix|one-home|config.test' tools/always-tests.txt` at 615a2625e: `one-home` line 22, `config` line 28; access-matrix's line 11 comment says the quick check follows the map for it. Run 2026-11-26.
[^r]: The minions' chats, read with `read_minion` (last 50 entries each) by five Sonnet Grunts on 2026-11-26. The earliest entries of #1875 (12), #1888 (18), #1890 (4) and #1916 (2) were omitted. Quotes are from what was read.
