# Effort retro: the typecheck chain from #1789 (Nov 24–25, 2026)

The server started this effort retro (#2113) once the chain's six minions had closed. The Taskmaster made all six, from
11:25 PST Nov 24 to 20:42 PST Nov 25[^t]. The chain did three things:

- #1789 put in a per-file type ratchet: `test/typecheck.test.ts` against `test/typecheck-baseline.json`, where counts may
  only go down.
- #1799, then #1816 and #1817 side by side, burned the counts down.
- #1822 and #1958 fixed real bugs that the burn-down turned up.

Times are Pacific.

| Minion | Model | Hand-offs | Landed | Refused | Min in line | Turn min | Cost |
|---|---|---|---|---|---|---|---|
| #1789 Typecheck Citadel (ratchet gate) | Opus high | 5 | 2 | 3 (CI burn-in) | 32 | 74 | $16.25 |
| #1799 Burn down any and type errors | Opus high | 2 | 1 | 1 (CI) | 10 | 16 | $12.56 |
| #1816 Round 2: src, tools, kit | Opus high | 8 | 7 | 1 (`size-budget`) | 105 | 80 | $20.03 |
| #1817 Round 2: test/ | Opus high | 12 | 11 | 1 (train guess) | 187 | 232 | $26.81 |
| #1822 Disk tile shows "NaNd ago" | Sonnet medium | 1 | 1 | 0 | 3 | 5 | $1.23 |
| #1958 Seal lost across a restart | Opus high | 2 | 1 | 1 (`size-budget`) | 79 | 33 | $3.20 |

The six together: 30 hand-offs, 7 refused, 416 min in line and $80.07[^l][^t]. In "Landed", a ship that rode another
ship's train counts once for each train.

- **Counts went down:**
  - Type errors went from 1385 to about 152 outside `test/`.
  - In `test/`, #1817 took errors from 919 to 166 and escapes from 1476 to 321[^r].
- **Bugs found and fixed in their own minions:** two, #1822 and #1958.

## Fixes

1. **The ratchet's counts file became a second shared hot file (a ledger repeat of the `size-budget` row).**
   - `test/typecheck-baseline.json` was the conflict in 9 of land.sh's conflict lines from Nov 24 to Nov 26 (UTC days)[^c].
     - Three involved the chain's own branches: #1822 on #1799's train, #1816 on #1930's, and #1816 on #1817's.
     - Six came from outside it: #1916, #2022, #2024, #2026, #2075 and #2097.
   - 56 commits on main changed the file from Nov 24 on[^g].
   - #1789's own first ship chased that file:
     - CI refused it three times, at 12:31, 13:02 and 13:12 PST Nov 24, each time with "`test/typecheck.test.ts`: failed in
       10 of 10 copies"[^l].
     - Each time, ships ahead of it had raised counts in files it never touched. It re-measured four times before
       landing at 13:19[^r].
     - Cara at the time: "Isn't this just going to keep happening?"[^r]
   - **A fix already exists, and nothing uses it.** #1827 (live 15:35 PST Nov 24[^h]) lets a ship name a command whose
     output it is, with `Regenerate:` and `Regenerate-files:` commit trailers. land.sh then re-runs the command after
     the rebase instead of stopping on a conflict.
   - No commit on main since Nov 24 carries either trailer[^z]. Minions are told about them: land.sh's conflict message
     (`regen_hint`, line 380) and `citadel:self-review` section 1. That same section says a ship that also changes code
     must not declare. Such a ship goes first in line and rides no train (`tools/deploy-queue.sh`, "holds the line").
   - Every burn-down ship and every ship that lowers a count is code plus baseline. So by design none of them can use
     it, and the conflicts went on.
   - **Fix (handoff):** make `test/typecheck-baseline.json` a built-in regenerated file, the way the prompt baseline
     already is. After the rebase, land.sh re-runs `node tools/typecheck.ts --update` and keeps the ship's place on its
     train.
   - **Why this is safe:**
     - `--update` only lowers counts, and refuses when a count is above its baseline. So a re-run on the merged tree
       can't hide a rise.
     - A branch that moved code needs `--update --moved`, and that case should stop as it does today.
   - Handoff: `shared/project/handoffs/handoff-type-baseline-regenerates.md`.
2. **land.sh calls every burn-in failure "racy". Most of them fail in every copy, and that misled #1789.**
   - Burn-in runs a new or changed test file as 10 copies at once. Its refusal (`tools/land.sh` line 739 and the
     `burn-in` kind in `src/land.ts`) says: "A file that fails when run as copies at once is racy… fix the race".
   - The land logs since Oct 29 hold 64 burn-in results (on 61 `burn-in red` lines; some name several files). 36 of
     them failed in 10 of 10 copies[^b].
   - 10 of 10 doesn't prove a plain red on its own. `tools/burn-in.sh`'s header notes flaky files failing up to 10 of 10
     at once. But #1789's three refusals were plain reds (the counts had moved under it), and the refusal offered only
     the race reading. #1789 read the word "racy" before it found the real cause[^r].
   - **Fix (same handoff, same files, same lane):**
     - When every copy failed, land.sh runs the file once, alone, on the rebased train.
     - The refusal then says which case it is: red alone means a plain red, green alone means a race.
     - Partial failures (1 to 9 of 10) keep today's advice.
   - The kit's template land.sh has no burn-in step (`grep -c racy` finds 0), so there is nothing to port.
3. **The ratchet doesn't count double casts, and they rose while the counted escapes fell.**
   - `tools/typecheck.ts` counts an explicit `any` and the `@ts-` comments. `x as unknown as T` gets round the checker
     just as well, and it isn't counted.
   - #1799 found Sonnet Grunts using double casts to bring the count down. It swapped them out by hand, and its handoff
     forbids them in prose[^r].
   - Across `*.ts` and `public/*.js`, `as unknown as` went from 167 at #1789's parent to 231 at main's tip[^u].
   - **Fix (handoff, kit):** count `as unknown as` as an escape, in both `tools/typecheck.ts` and the kit template,
     and re-baseline once. Handoff: `shared/project/handoffs/handoff-citadel-double-casts-count.md`.
4. **The burn-down was split by folder, not by lane, so a no-op change to a few files waited hours.**
   - Round 2 split src+tools+kit (#1816) from `test/` (#1817). Both ran at once on Josh's login and rewrote the same
     baseline file. #1817 left src-side errors for #1816, and the two conflicted in the baseline at 09:18 PST Nov 25[^c].
   - #1816 carried type annotations for `src/access.ts`, the tripwire and `tools/boot-check.ts`.
     - Each of those files makes a change high-risk by Project facts' "High risk by file" list.
     - So those ships each waited on a Josh card and a fresh review.
     - Separately, the part that touched pipeline files (`src/land.ts`, `tools/boot-check.ts` and two more, per
       `tools/pipeline-files.txt`) waited about 4 h last in the pipeline lane[^r].
   - Node strips types before it runs anything, so none of those ships changed what runs.
     - The one break a types-only edit did cause: #1799's `: Ticket` annotation broke `test/boot-check.test.ts`, which
       pins a line of `src/runner.ts`[^r]. That is a text-pinning test, not a change in behaviour.
   - **Fix (handoff, a rule change for people to decide):**
     - A `tools/types-only.ts` check: is the file's code the same once types are stripped (`module.stripTypeScriptTypes`,
       whitespace outside string and template literals ignored)?
     - When it is, Project facts' "High risk by file" line no longer applies. The pipeline lane still orders it.
     - This loosens a gate on auth and tripwire files, so it waits for a member's pick.
     - Handoff: `shared/project/handoffs/handoff-types-only-risk.md`.
   - **For the next sweep of this kind:** put the high-risk and pipeline files in one minion that holds the lane once,
     and split the rest by owner, not by folder. This is a note for whoever writes the briefs, not a rule; one effort.
5. **`citadel-test --affected` missed a repo-wide guard twice in this chain (a ledger repeat).**
   - #1799's CI red was `test/boot-check.test.ts` (it pins a `src/runner.ts` line).
   - #1958 (05:48 PST Nov 25) and #1816 (11:52 PST Nov 25) were refused by `size-budget`. #1958 had spent 60 min in
     line first[^l].
   - All three came before #2065, #1983 and #2037 went live, and `boot-check` is now `@pinned` in
     `tools/affected-map.txt`.
   - The ledger row's check for "no always-test refused a ship after 21:18 PST Nov 25" isn't tested by this chain: its
     last ship landed at 20:42[^l]. No edit here.

## Spec gaps

- **#1799 was cut mid-batch.** Cara, through the Taskmaster: "I think we should run it on Josh's account after the
  reset… Finish only the files your Grunts are on now." The batch was already out, so #1799 shipped it and closed[^r].
  - The login a long sweep runs on is a plan-level choice, so make it before a burn-down starts.
  - One case, so no rule.
- **#1958's brief said no stored shape should change.** The fix added an optional `rerun` mark to the stored queue[^r].
  It was handled in review. One case.

## What worked and should stay

- **Real bugs went to their own minions, with tight briefs.**
  - #1799's typing found the Disk tile bug. #1822 fixed it in one ship, for $1.23, with a red test first[^t][^r].
  - #1817 pulled a flaky test out of its ship rather than skipping it, and #1958 found the real bug behind it (a seal
    lost on restart)[^r].
- **The round handoffs were clear.** `typecheck-burn-down-citadel-2.md` and `-3.md` gave per-area splits and lists of
  what was left[^r].
- **#1789 measured before acting.** It costed the type test at about 8.1 CPU-s against the always-list's cap of 5, and
  used the affected map instead[^r].

[^t]: `sqlite3 -readonly coordinator.db "select t.number, t.model, t.effort, datetime(t.created_at/1000,'unixepoch','-8 hours'), datetime(t.closed_at/1000,'unixepoch','-8 hours') from tickets t where project_id=2 and number in (1789,1799,1816,1817,1822,1958)"`; cost and turn minutes from `select t.number, round(sum(u.cost_usd),2), round(sum(u.duration_ms)/60000.0) from tickets t join turns u on u.ticket_id=t.id where t.project_id=2 and t.number in (…) group by t.number`; run 2026-11-26.
[^l]: `grep -h -E '· timing · ticket/(1789|1799|1816|1817|1822|1958)-' shared/project/retro-log/2026-11-2[456]/land.md`, summed per branch: hand-offs = timing lines, landed = lines ending `landed…`, line minutes = the sum of `line N` / 60. Refusal reasons from the `burn-in red`, `guard` and `ship train verdict` lines before each refused timing line. Run 2026-11-26.
[^c]: `grep -h conflict shared/project/retro-log/2026-11-2[456]/land.md | grep -c typecheck-baseline` = 9, read line by line for the branches; run 2026-11-26.
[^g]: `git log --oneline --since=2026-11-24 main -- test/typecheck-baseline.json | wc -l` = 56, run 2026-11-26 at main 1497a0c15.
[^h]: `git log -1 --format='%h %ad' --date=iso main -S'Regenerate-files' -- tools/land.sh` = efba5d865, 2026-11-24 15:35:35 -0800.
[^z]: `git log main --since=2026-11-24 --format='%(trailers:key=Regenerate,valueonly)' | grep -c .` = 0, run 2026-11-26.
[^b]: `grep -h 'burn-in red' shared/project/retro-log/*/land.md | grep -oE 'failed in [0-9]+ of [0-9]+' | sort | uniq -c` (36 of "10 of 10" among 64 results on 61 lines; the earliest log folder is 2026-10-29), run 2026-11-26.
[^u]: `git grep -c 'as unknown as' <rev> -- '*.ts' 'public/*.js' | awk -F: '{s+=$NF} END{print s}'` for `69315f295~1` (167) and `HEAD` at 1497a0c15 (231), run 2026-11-26.
[^r]: The minions' chats, read with `read_minion` by two Sonnet Grunts on 2026-11-26. read_minion returned each minion's last 50 entries, so the earliest turns of #1789, #1799, #1816 and #1817 were not read. Quotes are from what was read.
