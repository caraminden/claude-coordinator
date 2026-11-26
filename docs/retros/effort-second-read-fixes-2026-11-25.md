# Effort retro: Second read fixes (Nov 25, 2026)

The server started this effort retro (#2069) once the effort's five minions had closed. The Taskmaster made all five
from 02:42 to 02:45 PST, one per item Josh marked "Go" on #1777's choices page. Each brief was a handoff written by the
second read (`shared/project/handoffs/qp-second-read-2-fix-*.md`)[^t][^r]. Times are Pacific.

| Minion | Ships | Hand-offs | Refused or failed once on | Closed | Cost |
|---|---|---|---|---|---|
| #1952 Deleted memory notes stay deleted | 1 | 3 | a rebase conflict in `src/runner.ts` (#1840's split), then `size-budget` | 12:02 | $9.66 |
| #1953 Releases: roll backs survive a restart | 1 | 1 | none | 06:05 | $7.36 |
| #1954 CI health frees the right fix minion | 2 | 3 | `size-budget` (`src/ci-health.ts`) | 12:23 | $10.77 |
| #1955 Memory, tidy and decisions fixes | 2 | 3 | `db-writer` in CI | 06:49 | $3.68 |
| #1956 Machine jobs keep their state | 3 | 4 | `size-budget` (`machine-agent.mjs`) | 11:49 | $6.80 |

Ships, hand-offs and refusals are from land.sh's timing lines[^l] and the minions' chats[^r]; closes and costs from the
database[^t]. The five cost $38.27 together. The briefs' expected costs added up to about $104[^r].

## Fixes

1. **Four of the five were refused once by a repo-wide guard that their own test runs never picked (ledger repeat).**
   - `size-budget` refused #1952, #1954 and #1956. `db-writer` refused #1955 in CI[^l][^r].
   - Those four hand-offs spent 6531 s (109 min) in line before the refusal. The `size-budget` three spent 4411 s, for a
     test that takes 0.2 s here[^l][^ms].
   - **Cause:** #1928 narrowed `citadel-test --affected` to touched and same-named tests. It landed at 04:08 PST, during
     this effort[^l]. Both guards sit only on `tools/affected-map.txt`, and the narrow pick reads no map rule. The smoke
     check before the line runs `tools/always-tests.txt`. `size-budget` was on that list only for a ship with
     formatting changes, and `db-writer` (35 s) never[^ms].
   - The whole scheme logged 16 `size-budget` guard refusals in Nov 25's land log, of 18 guard lines in all[^g].
   - **Already being fixed elsewhere, so nothing built here:**
     - #1983 ("quick checks before the line") adds `size-budget`, `ui-contract` and four more to the always list.
     - #2037 ("pinning tests always run") adds `size-budget`, `db-writer-lists` and four more, and picks a test that
       reads a source file when that file changes.
     - Both wait in the pipeline lane, and both add `size-budget` to the same list, so the second to ship will
       conflict there[^w]. The Taskmaster has been told.
   - **Still open after those ship:** the slow source-tree guards that #2065 put on the map (`worker-tla`,
     `frontend-syntax`) are also skipped by the narrow pick. A minion meets them only through `--wide` or the ship's
     CI.
2. **#1955's `--affected` run failed, so it named its tests by hand and missed `db-writer`.**
   - Its worktree was cut at 02:44, before #1928 landed at 04:08[^t][^l]. Its turn's pinned `citadel-test` then
     passed `--narrow`, which the worktree's older `tools/affected.ts` didn't know. The run stopped with "unknown
     argument --narrow"[^r].
   - It fell back to the memory tests it could name, and CI refused the ship on `db-writer` 2120 s later[^l].
   - One occurrence, in the hour after one flag was added. So it stays a note, not a fix. If a pinned tool's flag is
     ever added again, the fix is for `tools/citadel-test` to fall back to the plain pick when `affected.ts` rejects
     the flag. That file is in the pipeline lane.
3. **The split was right; the tail was set by one card and by neighbours outside the effort.**
   - The five handoffs carried no shared file between them. #1952 and #1955 sat beside each other in the memory
     files, and the briefs said whoever ships second rebases. No conflict happened[^r]. Nothing was built twice, and
     no person corrected any of the five.
   - #1953 and #1955 were done by 06:49. The other three closed between 11:49 and 12:23[^t]:
     - #1956's 2MA1 needed a new database column. It asked Josh at 04:18 and got "Add the column" at 11:13. That is
       6 h 55 min of a sealed wait, then a 35-min ship[^c]. The handoff didn't say 2MA1 needed a column, so the go
       couldn't be asked with the pick on #1777's page.
     - #1952 lost its first hand-off to #1840's `src/runner.ts` split, an outside minion, then hit that file's size
       limit (4861 lines against 4858)[^r].
   - No edit. The column ask was one case, and the minion did all the other work while it waited, which is the right
     order. A handoff writer that can see a gated fix (a migration, a data delete) should list it, so the choices
     page asks for that go too. This is worth watching, not a rule yet.
4. **#1954 spent most of a turn rebuilding a database for two judge replays.**
   - `test/judges.test.ts`'s replays need the live database's history, which a container turn can't open.
   - It built a partial copy. The flake-counter replay ran past 500 s, and the real alerts were missing from the
     copy anyway[^r].
   - One occurrence, so it stays a note. If it repeats, the fix is a `host_check`-fed replay or a canned fixture.

## Spec gaps

- **#1956, 2MA1:** the shape (a column of its own against reusing the stop field) went to Josh on a card. He picked
  the column. It sets how the core works, and a person decided it[^c].
- **#1955, ME4:** the skip, cut and drop wording needed the minion's own reading. Its reviewer showed the first
  reading was wrong, and it was fixed before ship[^r]. That was a wording call, not the core.
- **#1953, 2RE7:** whether the 513 MB leftover-folder sweep was in scope was settled by re-reading the brief, which
  did ask for it[^r].

## Did the last retro's fixes hold

- **Push failure gaps, fix 1 (source-tree guards on the always list and the map, #2065):** it shipped after this
  effort, so it isn't tested here. Fix 1 above shows that the map half doesn't reach the default `citadel-test` since
  #1928.
- **Briefs mark guesses:** not hit. The five briefs carried checked commits ("checked against main 5538796eb") and
  "already shipped" and "leave alone" parts. Neither the minions nor the Taskmaster corrected one[^r].

## Keep

- **The handoff shape from a review:** "Done when", "Already shipped", "Leave alone" and who-touches lines, plus the
  Taskmaster's "What the handoff can't know". All five briefs ran without a person's correction[^r].
- **Codex as the second reader:** it found real bugs the reviewer passed[^r]:
  - #1953: 3 real of 4; the reviewer found none.
  - #1956's main ship: 3 real of 4; the reviewer found one small thing.
  - #1954's 2CA12: one real one (the end-marker check); the reviewer found none.
- **Costs well under estimate:** $38.27 against about $104[^t][^r].

[^t]: `host_check db`, run 2026-11-25: `tickets` rows for numbers 1928, 1952 to 1956, 1983 and 2037 (created_at,
closed_at as Pacific, state, note), and the largest `total_cost_usd` in each minion's events (cumulative within a
minion, per the last retro's reading).
[^l]: `grep -n timing shared/project/retro-log/2026-11-25/land.md | grep -E '195[2-6]'`, run 2026-11-25: 13 timing
lines, 9 `landed` and 4 `refused`. The refused lines' `line` seconds are 2120 (#1955), 2676 (#1954), 1482 (#1956)
and 253 (#1952). `land conflict` at 17:12:39Z names #1952's `src/runner.ts`. The `would refuse #1955` line at
12:57:23Z names `test/db-writer.test.ts`. #1928 is the `ticket/1928-heavy-jobs-stay-on-4-cores` timing line at
12:08:15Z (04:08 PST), `landed`.
[^g]: `grep '· guard ·' retro-log/2026-11-25/land.md`, run 2026-11-25: 18 lines, 16 of them naming
`test/size-budget.test.ts` (the Nov 26 UTC file adds 3 and 2 as it grows).
[^ms]: `tools/citadel-node --no-warnings --test test/<name>.test.ts`, timed wall-clock on perigee, 2026-11-25:
size-budget 197 ms, db-writer 35482 ms, ui-contract 183 ms, one-until 299 ms. The list's contents are
`tools/always-tests.txt` at 993732e78, and land.sh's smoke pick is `tools/land.sh` lines 516 to 518.
[^w]: `who-touches tools/always-tests.txt`, run 2026-11-25, and `git diff <merge-base> -- tools/always-tests.txt` in
the worktrees of #1983 and #2037.
[^c]: `host_check db`, run 2026-11-25: events of ticket id 3924 (#1956). The `question` is at 04:18:11, Josh's answer
at 11:13:39. The ship is efa2d2c07 at 11:48:57 PST (land.md's 19:48:57Z `ship train shipped` line).
[^r]: `read_minion` 1952 to 1956, read by two Sonnet Grunts on 2026-11-25. Their reports give counts, not
transcripts. The expected costs are the briefs' (about $20, $17, $24, $18 and $25).
