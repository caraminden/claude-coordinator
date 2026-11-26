# Retro: Build 7, worker machines (2026-11-26)

Build minion #1935. Nineteen feeders merged into `build/7` between 02:37 PST on 2026-11-25 and 10:15 PST on 2026-11-26[^merges]:
#1937, #1962, #1973, #1972, #2006, #2011, #2044, #2070, #2052–#2057 (machine connections M1–M6), #2088, #2085, #2064, #2061 and #2105.
Main was taken in 14 times[^takeins]. The build's full runs were tried 38 times: 22 merged, 13 were refused at CI, 2 at guards and 1 at rebase[^full].
The feeders and the build minion cost $389.50 together. The build minion's share was $61.55, against the $25 its brief expected[^cost].

## Fixes, ranked by what they'd have saved

1. **The claims cost more than they saved, because most feeders were links of a chain that edits its own earlier lines.**
   - 12 of 19 feeders were refused at least once for writing outside their claim[^refusals].
   - Fixing those took 19 lend commits out of 46 commits to `build-claims.md`[^claims]. Each lend needed a turn of the build minion, and the feeder waited for it.
   - Most refusals were a later piece changing lines an earlier piece of the same plan wrote. Examples: M3 and M4 changing what M2 merged in `src/machines.ts` and `src/routes/machines.ts`, and #1972 and #2070 changing `src/runner.ts` lines from #1962. "A shared file takes added lines only" can't fit that.
   - Against that, only 1 of 19 hand-offs hit a git rebase conflict: #2085 in `public/machine-role-cards.js`[^conflict]. Build 6 had no claims and also had one conflict in 14 feeders. So the claims prevented little here.
   - #1972 put it this way (11-25, 14:15 PST): a feeder that must change a shared file's lines "learns it only at hand-off, after its go card".
   - **Not made here:** `claims_check` is in `tools/land.sh` and the kit's template, both pipeline-lane files. The fix lets a claims line name a chain's minions together (`#2052 #2053: …`), so they may change each other's lines. It is written up in the shared folder's `handoffs/handoff-build-claims-chains.md`, with the test to add to `test/land-build.test.ts`. No ledger row yet: claims came in after Build 6 (#1159, 2026-11-20), so this is the first retro to see them.
2. **The burn-in again called plain 10-of-10 reds "racy".** Four test files failed 10 of 10 at burn-in: machine-turn, machine-away, machine-remove-browser and access-matrix[^burnin].
   - access-matrix was not a race. It was a stale snapshot row: main's #2126 had changed the Flow row's 400 to 200 after the take-in. Taking main in again (33c9559a7) fixed it.
   - Two sessions' `process` notes on 11-25 (7330e2f3 at 02:14 and f5bd5406 at 02:28 PST) say the same thing: the message sent them looking for a race.
   - This is a repeat (ledger row "burn-in refusal calls every 10-of-10 failure racy"). Its fix is still the unshipped proposal in `handoffs/handoff-type-baseline-regenerates.md`, a land.sh change in the pipeline lane. **Not made here** for the same reason. This retro is added to the row.
3. **Feeders' `--into` runs missed reds that only the build's full run saw.** Examples: the access snapshot (11-25 05:14 and 11-26 10:35), size-budget (11-25 12:36), and #2070's note that base-check judged all of Build 7's tests (11-25 20:29)[^fullonly].
   - Most of the 13 CI refusals of full runs trace to one of these, or to a burn-in race.
   - This is a repeat of the ledger row "A feeder's land runs only its own files' tests". The build's full run is the guard by design. **No new fix:** each such red cost one full run, and the map row it would need differs every time. This retro is added to the row.
4. **Main moved shared counts and types under the build mid-flight.**
   - #2111's blocking-call check (`test/sync-calls.json`) and #2128's split of `public/types.d.ts` both landed after the build's other take-ins.
   - The take-in at 11-26 10:23 resolved conflicts in ci-armed card fields, size budgets and sync-calls.json. The one at 11:12 resolved the types split[^takeins].
   - sync-calls cost the most. Its 16 new rows were unclassed, the owed total went past main's 253 cap, and two machine-turn writes had to become async (a reviewer then found a race in them, fixed in 414abe7f1).
   - A third take-in at 12:10 PST, after the go card was up, brought #2142, which started counting `as unknown as` as a type escape. The build's 16 such casts were written before that rule, and recording them in the baseline cost one more full run.
   - A fourth, after Cara's go, was forced by the ship itself refusing a main that wouldn't merge: #2134 had moved the poll and stop off the thread. Build 7's running-turn code had to go async to match, and its reviewer caught a stop that would have signalled a machine turn's pid on the server (fixed in d6fd08a38).
   - This is a repeat of the ledger row on shared counts files (size-budget, the type baseline). sync-calls.json is now a third such file. **Not made:** the row's proposed fix (regenerated files that merge by themselves) is in the same pipeline-lane handoff. This retro and the file are added to the row.
5. **Two feeders' briefs named a handoff file that didn't exist (#1937, #1962)**[^briefs]. Both found the spec instead, so the cost was one lookup each. This falls under the ledger row on briefs stating a guess as fact. **No new fix:** the briefing skill's part 6 already covers it. The row gets this retro.

## The whole-build review

The Fable review of the whole diff found a bug that no feeder's review caught.
- Saving the one scheme list gave every role that was switched on the union of all the roles' lists. A lend card approved for one scheme, or a Machines page left open from before the deploy, would have lent Tools, GPU jobs and Minion turns to every scheme that CI was lent to.
- M1 (#2052) kept the one-list write for the old callers. #2064 then gave CI its own list, which was every scheme the owner is in. Only the two together spread the lists.
- Fixed in the build: `setMachineProjects` now saves only the change. `test/machine-roles.test.ts` gained a test that fails on the old code.
- Not fixed: the line of waiting turns reads the machines from the database on every pump, for each waiting entry. That cost hasn't been measured, and there are few machines (8 live[^machines]).

This repeats the ledger row "Feeders' self-reviews rate a change by its own files", and this retro is added to it. Each feeder's review was right about its own diff; the bug only exists in the two diffs together.

## Did the claims help?

Mostly no; see fix 1. They did make the merge order visible: every lend is a dated bullet in `build-claims.md`. And three late feeders, #2064, #2061 and #2105, each needed `server.ts`; the claims made them take turns instead of colliding. That order would have come from git conflicts anyway, at the cost of one rebase each.

## Pieces that arrived after the go card

- #2120 (M6c: heavy jobs ask the balancer) and #2137 (turn start and end off the server's thread) were picked into Build 7 while it was being reviewed. Both reported ready after the whole-build review, the retro and the go card were done.
- Merging them would have meant another review and full run under an open go card. So they ship to main by themselves after Build 7 is live. The Taskmaster was asked to take them out of the build.
- #2147 (Claude Code cloud sessions as a worker class: Josh, 2026-11-26, "essentially these are just another class of worker in the worker pool") is a measured trial that ships nothing. It is counted with the build's effort, and any cloud route it proposes is a follow-up piece.
- **Not made:** a build has no "closed to new feeders" point. Its step 5 starts "once every feeder on the list is merged in", but nothing stops the list from growing during step 5. This is a first sighting; if a second build sees it, the fix is a refusal at start time for a build whose go card is up.

## Follow-ups

- The four UI critic findings: a double rule under an opened machine's header, no warning for a Runs on pick that can't run, no spinner while a computer connects, and the code block's Copy button position.
- The line of waiting turns reads `pools.machines()` uncached on every pass.
- `test/turn-setup.test.ts:159` and `test/machine-setup.test.js:79` fail inside a Fable minion's turn: they read the turn's environment. CI doesn't see it (#2137's report).
- The claims chain handoff (fix 1) and #2147's trial.

## Spec gaps (for Josh to judge)

- **Core:** M5 (#2057) shows the Windows screen role to ticked workspaces even when Tools is off, and the sticky machine pick is forgotten on a restart. The spec names the roles but not how the screen role interacts with Tools.
- **Core:** #2085 adds a no-password sudo rule on owners' PCs, bounded to that PC's thread and memory limits. It is a one-way door on each PC it reaches. Cara's desktop has to rerun the worker install by hand for it.
- #2105's heavy-job half was split off; Josh picked "Start it (server places)" (11-26, 10:00 PST).
- #2064 left these: the desktop screen runner is still per scheme, admins added later aren't lent old schemes, and ownerless rows are lent by hand.

## Keep

- One full run per feeder merge, with the list rewritten after each. The reds were always traced to one merge.
- A reviewer Grunt on every claims or test commit the build minion made (Josh: "we should ALWAYS have at least minion reviews"). It caught the endStart race in the take-in fix.
- Feeders' merge notes naming their risk and what they didn't fix. The go card's "not verified" list was built from them.

[^merges]: `grep -E "timing.*into build/7" shared/project/retro-log/2026-11-2{5,6}/land.md`, Z times minus 8 h, run 2026-11-26 11:30 PST.
[^takeins]: `git log --first-parent --merges --format=%s main..build/7 | grep -ci main` → 14 (2026-11-26 13:25 PST); conflict files from `git show --diff-merges=cc --name-only <sha>`, 2026-11-26.
[^full]: `cat shared/project/retro-log/2026-11-2{5,6}/land.md | grep -E 'timing.*build/7, full' | grep -oE '(merged|refused[^,;]*)' | sort | uniq -c`, 2026-11-26.
[^cost]: `host_check db`: `SELECT t.number, round(sum(u.cost_usd),2) FROM tickets t JOIN turns u ON u.ticket_id=t.id WHERE t.project_id=2 AND t.number IN (1935, the 19 feeders) GROUP BY t.number`, summed, 2026-11-26 ~12:00 PST. It excludes the turns after that query.
[^refusals]: `grep -c 'writes outside its claim in build/7'` over each feeder's transcript under `~/.claude/projects/*-tickets-<worktree>/*.jsonl`, 2026-11-26. Transcripts only, so it is a lower bound.
[^claims]: `git log --format=%s build/7 -- build-claims.md | wc -l` → 46; `| grep -ciE 'lend|lent|borrow'` → 19, 2026-11-26.
[^conflict]: `grep 'land conflict' shared/project/retro-log/2026-11-2{5,6}/land.md`, filtered to Build 7 feeders' branches, 2026-11-26; Build 6's from `build-6-platform-and-apps.md`'s first paragraph.
[^burnin]: `grep -h 'burn-in red · ticket/1935' shared/project/retro-log/2026-11-2{5,6}/land.md | grep '10 of 10'`, 2026-11-26.
[^fullonly]: Feeders' `process` lines in `shared/project/retro-log/2026-11-2{5,6}/*.md` at those times, 2026-11-26.
[^briefs]: The first turns of #1937 and #1962 (`read_minion`), 2026-11-26.
[^machines]: `host_check db`: `SELECT count(*) FROM machines` → 8, 2026-11-26 ~12:40 PST.
