# Effort retro: Push failure gaps (Nov 24 to 25, 2026)

The server started this effort retro (#2065) once the effort's three minions had closed. The Taskmaster made all
three at 18:04 to 18:05 PST on Nov 24 from Josh's pick on the gaps card. They came out of the Nov 24 freeze incident
(#1874's report, `shared/project/reports/incident-2026-11-24-1505-cause.md`) and were sealed until #1868 was live[^m].

- **#1880 Main's test run goes first:** closed unstarted at 19:49 PST. Its ask moved into #1902.
- **#1881 Say when a ship is frozen:** live at 23:42 PST Nov 24.
- **#1882 Keep Taskmasters answering:** two ships, live by 04:33 PST Nov 25, closed at 11:17 PST.

Times are Pacific.

## Fixes

1. **A fast guard test no local run picked cost #1881 one trip through the line (ledger repeat).**
   - #1881's first ship waited 6318 s (105 min) in line. CI then refused it on `test/one-pacific.test.ts`; the fix
     was a two-line commit (e89c4737a)[^l].
   - Before the line, its own check was skipped ("the check runner was busy") and so was the light check ("no idle
     side runner")[^l].
   - The smoke check runs `tools/always-tests.txt` and the branch's own test files. One-pacific was on neither, nor
     on `tools/affected-map.txt`, so `citadel-test`, `--wide` and the smoke check all passed it by.
   - Six more guards that scan `src/` or `public/` were missing the same way: one-home, worker-tla, frontend-syntax,
     css-has-cost, help-words and unit-thp. They were found by listing the test files that read a source tree and
     are on neither list[^g].
   - **Shipped:**
     - The five that take under 0.3 s each go on `tools/always-tests.txt`, which the smoke check and every
       `citadel-test` run read.
     - The two that take seconds (worker-tla 7.5 to 9.9 s, frontend-syntax 4.3 s[^t]) go on the map.
     - All seven go on `REPO_WIDE` in `test/affected.test.ts`, which fails when one is dropped from both lists.
   - **Still open:** `REPO_WIDE` is hand-kept (its own `shortcut:` comment), so a new guard can be missed again. No
     heuristic separated the source-tree scans from the 60-odd tests that read their own temp folders[^g], so
     detecting them by what they read is left as the comment says.
2. **The effort's first ask left the effort.**
   - #1880 was briefed at 18:04 PST.
   - At 19:36 PST the Taskmaster made #1897 ("Ships get the desktop first") for an overlapping ask.
   - At 19:49 PST it closed both unstarted and made #1902 ("Deploys first on the CI desktop") to do both[^m].
   - Folding the two early was right: nothing was built twice and #1880 cost nothing. But #1902 carries no
     `effortName`, so this retro started while a third of the effort was still in the ship line (#1902 state
     outside, "landing: in line", Nov 25)[^m], and it can't judge that third.
   - **Fix:** a handoff, since it is Citadel's server and close tool:
     `shared/project/handoffs/handoff-citadel-effort-follows-moved-asks.md`. A minion closed because its ask
     moved passes its effort on, and the retro waits for the receiving minion.
3. **Briefs still carried guesses as facts, and the Taskmaster caught them seconds later (ledger repeat).** The
   last retro's fix 2, "a cause, count or size carries its command or is labelled a guess", shipped at 11:56 PST
   Nov 24 in `kit/skills/briefing/SKILL.md`. Six hours later:
   - #1880's brief named "#1671-era own-check runs", a number never checked; the right one was #1620.
   - #1881's brief stated three guesses as facts:
     - "other schemes' too";
     - "nobody saw it until I read the cgroups by hand";
     - "the oomd and hold-schemes code".

   The Taskmaster sent corrections 36 s and 25 s after making them (at 18:05:15 and 18:05:17), while both were
   still sealed[^m]. So the rule fired on re-reading the brief, not while writing it. This time it cost nothing; held
   mail reached both before their first turn.
   - #1881 still found that one clause of its brief was moot: no Citadel code freezes units, so the "frozen on
     purpose" flag it was told to honour is never set.
   - No new edit: a second text rule would repeat what the last retro says doesn't hold. The ledger row is new, so
     the next retro counts it. A mechanism (create_ticket printing a brief's unsourced numbers back to the writer)
     is an idea, not built.
4. **A ship's train went red on other riders' size-list conflicts. Fixed elsewhere; keep watching.**
   - #1881's second ship rode 5 trains. All 5 burn-ins went red.
   - 3 of them named other riders' `test/size-budget.test.ts` as the suspect. The other 2 went to bisect[^l].
   - Its line wait was 4806 s and its CI run 808 s, from the hand-off at 20:17 PST to live at 23:42 PST[^l].
   - On Nov 25 (UTC day), `size-budget.test.ts` was in 63 of the 101 rebase and train-prep conflicts[^s].
   - #1917's count rule (size-list edits merge by themselves) shipped about 02:13 PST. The last size-budget
     conflict was at 02:46 PST, and none in Nov 26 UTC's log up to when this ran (about 16:30 PST Nov 25)[^s]. No action.
5. **#1881's screenshots couldn't show a frozen row.**
   - The dev copy passes no fixture for a frozen ship, and the Releases row needs a deploy target. The critic judged
     a static page, failed round 1, and was never shown the fix[^m].
   - One occurrence and no ledger row, so this stays a note. The verifier's copy
     (`tools/review-escapes/verifier-copy.ts`) is where a "frozen ship" state would go if it comes back.

## Spec gaps

- **#1881, the alert:** the 5-minute frozen alert is the Taskmaster's starting number, not Josh's. The "frozen on
  purpose" exemption named a mechanism that does not exist. Neither sets how the core works.
- **#1882, the core shape:** Josh picked it on its design card ("Its own small container", Nov 24 4:37 PM), so
  nothing was invented.

## Did the Nov 10 to 24 retro's fixes hold

- **Fix 2 (briefs mark guesses):** half. See finding 3.
- **Fix 5 (shipping got slower):** still slow here. Line waits were 6318 s and 4806 s for #1881, and 1610 s and
  1504 s for #1882[^l].

## Keep

- **#1882's order: a design card, then the build, a go card, then a measured trial.** It was high risk and needed
  no correction from a person.
  - Josh gave three answers: the design pick, "Ship It" at about 2:58 AM, and "Yes, cover them too".
  - Its trial passed on perigee. The old way gave no answer in 62,232 ms; the new container answered in 545 ms[^m].
- **Costs stayed inside the briefs' estimates:** about $4.08 for #1881 (estimate $8) and $15.34 for #1882 (estimate
  $18)[^c].
- **Conflict prep (#1366):** it recorded #1881's `src/release-readers.ts` conflict ahead of time, and the real
  rebase replayed it[^l].

[^m]: `host_check db`, run 2026-11-25: `tickets` rows for numbers 1880, 1881, 1882, 1897 and 1902 (created_at,
closed_at, state, note). The `events` of ticket ids 3836 and 3837 (user_message kinds). Taskmaster (ticket 2427)
events mentioning `1880` between 18:04 and 19:50 PST. The trial numbers and critic rounds are from `read_minion`
1881 and 1882 (a Sonnet Grunt's report).
[^l]: `grep -n '1881-say\|1882-keep' shared/project/retro-log/2026-11-25/land.md`, run 2026-11-25: timing lines at
06:06:34Z (line 6318, refused at ci), 07:42:19Z (line 4806, ci-run 808, landed), 11:26:59Z (line 1610), 12:33:50Z (line 1504). Burn-in reds and suspects are the `burn-in red` and `ship train suspects` lines between
06:58Z and 07:42Z. Own check and light check skips are lines 224 and 225; the conflict prep is lines 286 to 299.
[^g]: In this worktree, 2026-11-25: for each `test/*.test.ts` matching `readdirSync|ls-files|globSync`, whether it
appears in `tools/affected-map.txt` or `tools/always-tests.txt`. The seven were confirmed by reading each file's scan.
[^t]: `tools/citadel-node --no-warnings --test test/<name>.test.ts`, timed wall-clock on perigee, 2026-11-25:
one-pacific 297 ms, one-home 275, css-has-cost 189, help-words 193, unit-thp 219, frontend-syntax 4296, worker-tla
9897 (7.5 s at the re-check).
[^s]: `grep -E 'conflict' retro-log/<day>/land.md | grep -c size-budget` against `grep -c -E 'conflict'`, for days
2026-11-25 (63 of 101) and 2026-11-26 (0 of 12 when first run, 0 of 13 at the re-check; that log was still growing), run 2026-11-25. The last one is the 10:46:41Z line. #1917's land
conflict at 10:12:58Z dates its ship.
[^c]: `host_check db`, 2026-11-25: the last `result` event's `total_cost_usd` per minion (ticket ids 3837 and 3838).
That it is cumulative within a minion is my reading of the rising values (1.91, 11.25, … 15.34), not checked against
the budget code.
