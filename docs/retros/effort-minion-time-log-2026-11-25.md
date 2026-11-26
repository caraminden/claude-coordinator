# Effort retro: Minion time log (Nov 25, 2026)

The server started this effort retro (#2102) once the effort's three minions had closed. The Taskmaster made all three
at 12:08 PST, from Josh's pick on #1911's card ("The log itself; Recording the waits; Explain"). #1991 and #1992 began
at once. #1994 was sealed until #1991 was live, and Josh unsealed it at 14:34[^t][^u]. Times are Pacific.

| Minion | Turns | Refused before shipping | Closed | Cost |
|---|---|---|---|---|
| #1991 Time log behind the progress line | 5 | `ui-contract` (guards), then `chat-reading-browser` (line) | 15:40 | $17.20 |
| #1992 Record the waits the log can't see | 4 | `size-budget` (guards), then `one-home` (line) | 15:40 | $9.36 |
| #1994 Explain on the time log | 4 | `one-pacific` (CI) | 18:03 | $16.64 |

The three cost $43.20 together[^t]. The refusals come from land.sh's timing and suspect lines[^l], and the rest from the
minions' chats[^r]. #1991 and #1992 shipped together at 15:39, in #1992's train. #1994 shipped at 18:03, riding #1903's
train[^l].

## Fixes

1. **Four of the five refusals were repo-wide guards the minions' own test runs never picked (ledger repeat).**
   - The four were `ui-contract` (#1991), `size-budget` (#1992), `one-home` (#1992) and `one-pacific` (#1994). Each
     passes in under a second[^l][^r].
   - The fifth was #1991's `chat-reading-browser` red, a real bug: its panel had dropped the running-actions toggle.
   - Those five hand-offs spent 11,308 s (188 min) in line or CI before they were refused[^s].
   - **Cause:** this is the same gap as the last two effort retros. The fixes were already in the pipeline lane, but
     none was live yet:
     - #2065 put `one-pacific` and `one-home` on `tools/always-tests.txt` (landed 18:11).
     - #1983 moved the always-tests ahead of the line (20:01).
     - #2037 runs the always-tests on every `citadel-test` (21:18)[^g].
     - #1994's refusal at 17:30 was the last one before them.
   - **Edit:** none to the guards. The ledger row now names all three as shipped. The next retro checks that no
     always-test refused a ship after 21:18 on Nov 25.
2. **README.md's Layout table is the file every ship fights over, and no check or merge rule covers it.**
   - On Nov 25 and 26 (UTC), 34 of 128 logged conflicts named `README.md`: 21 of 100, then 13 of 28[^c].
   - Within this effort, #1994 and #1996 (the day strips) conflicted 3 times between 17:14 and 17:38. Both were sealed
     on #1991 and both added rows to `README.md` and `docs/design-system/index.html`[^c].
   - Minions now record conflict fixes ahead of time, by hand. #1989, #2050 and #2077 each did it for a README row[^m].
   - `tools/land.local.sh`'s `MERGES` gives `size-budget`, `judges` and `src/db.ts` ship-time merge rules. Its
     `append` rule needs indented lines, so a table row can't use it[^mg].
   - **Edit:** `shared/project/handoffs/handoff-readme-layout-merge.md`, a pipeline-lane minion that starts after #2099
     splits the ship script. It is offered on this retro's start card.
3. **Two briefs set "Done when" lines the minion's own turn couldn't meet (new ledger row with the last retro's #1954).**
   - #1991's brief asked for "the query timed on a copy of the live data". A container turn has no live data and no
     preview login. The retro log has 2 `process` lines on it[^p]. The minion timed it with the live probe after
     shipping (median 77 ms)[^r].
   - #1992's handling of the "left" ending needed `src/land.ts`, a pipeline-lane file it didn't hold, so it shipped
     that part half done[^r].
   - The last retro's #1954 rebuilt a database copy in a container turn for two judge replays (fix 4 there).
   - **Edit:** a kit fix, so it goes in `shared/project/handoffs/handoff-citadel-minion-time-log.md` for the
     Taskmaster. It adds one line to `citadel:briefing` part 3: a Done-when line that needs live data or a pipeline-lane
     file names how the minion meets it. That means `host_check`, the ship's `probe`, or the lane.
   - The same handoff adds the sibling line from fix 2. Minions sealed on one leader, with the same files to edit, are
     told which ships second. #1992's brief did this for the schema number[^b].

## Spec gaps

- **#1991 "Always show the line":** Josh picked it on #1991's card after its first hand-off, and it shipped in the same
  ship[^r]. That is a pick about how the feature works, made by a person. It is not a gap the brief left open.
- **#1994 schema number:** its brief said "take yours when you ship, not before". It took 118 while building, then
  moved to 119 after #1992 took 118[^r][^b]. That cost one rebase and no refusal. `tools/ship-numbers.ts` would have
  renumbered it at ship time anyway.
- No minion invented a formula or data shape that a person should judge.

## What worked, keep it

- **The split:** reader and UI (#1991), new records (#1992), and the Haiku explainer (#1994). The three never
  conflicted with each other[^c]. #1992 gave #1991 its query in one held message, and #1991 needed no change[^r].
- **The early unseal:** Josh unsealed #1994 at 14:34 onto #1991's branch, an hour before #1991 was live at 15:39. #1994
  then reused #1991's reader, route and colours as briefed[^u][^l].
- **Handoffs deleted:** all three handoff files were gone from `shared/project/handoffs/` by the retro[^h].

## Did the last retro's fixes hold

- **Second read fixes, fix 1** (the narrow `--affected` pick misses map-only guards; #1983 and #2037): this effort ran
  before either was live, so it was hit again, not tested. Fix 1 above says what the next retro checks.
- **Push failure gaps, fix 1** (#2065, source-tree guards on the always list): #1994's `one-pacific` refusal came at
  17:30, 41 minutes before #2065 landed. So this is not a failure of that fix.

[^t]: `host_check db`, Nov 26: `SELECT t.number, count(*), round(sum(u.cost_usd),2), datetime(t.created_at/1000,'unixepoch','-8 hours'), datetime(min(u.ended_at-u.duration_ms)/1000,'unixepoch','-8 hours'), datetime(t.closed_at/1000,'unixepoch','-8 hours') FROM tickets t JOIN turns u ON u.ticket_id=t.id WHERE t.project_id=2 AND t.number IN (1991,1992,1994) GROUP BY t.number`.
[^u]: `host_check db`, Nov 26: #1994's `note` and `user_message` events (`SELECT ... FROM events e JOIN tickets k ON k.id=e.ticket_id WHERE k.project_id=2 AND k.number=1994 AND e.kind NOT IN ('assistant','tool_use','tool_result','result','stream') ORDER BY e.id LIMIT 8`): "Josh unsealed it before its leader's work was in" at 14:34:04.
[^l]: `grep -hE 'timing · ticket/(1991|1992|1994)' shared/project/retro-log/2026-11-2[56]/land.md` and the `ship train suspects` lines naming those branches, Nov 26. UTC converted to PST.
[^s]: The `line` (plus `ci-queue` and `ci-run` when refused at CI) on the five refused `timing` lines in [^l]: 2281 + 1546 + 412 + 1146 + (4906 + 29 + 988) = 11,308 s.
[^g]: `grep -hE 'timing · ticket/(1983|2037|2065)[^ ]* .*landed' shared/project/retro-log/2026-11-26/land.md`, Nov 26: 02:11Z, 04:01Z and 05:18Z on Nov 26 UTC. `grep -nE 'one-pacific|one-home|size-budget|ui-contract' tools/always-tests.txt` lists all four on main 2830f3d87.
[^c]: `for d in 2026-11-25 2026-11-26; do grep -cE '(train prep|land) conflict' $d/land.md; grep -E '(train prep|land) conflict' $d/land.md | grep -c README.md; done` in `shared/project/retro-log/`, Nov 26: 100/21 and 28/13. The #1994 and #1996 lines are at 01:14:05Z, 01:38:05Z and 01:38:22Z in 2026-11-26/land.md.
[^m]: `search_minions "README Layout conflict merge"` since 2026-11-20, Nov 26.
[^mg]: `sed -n 154,161p tools/land.local.sh` and `sed -n 300,316p tools/land-core.sh` on 2830f3d87.
[^p]: `grep -c '· process ·' shared/project/retro-log/2026-11-25/01adc402-980f-4064-9c06-877f94ea7de0.md` (#1991's session), Nov 26: 2.
[^r]: `read_minion` on #1991, #1992 and #1994, by a Sonnet Grunt, Nov 26. Its counts come from the chats. Costs come from [^t] instead.
[^b]: `host_check db`, Nov 26: the `"brief":true` user_message of #1991 and #1992. #1992's ends with "may also need the next SCHEMA_HISTORY number: take yours when you ship, not before", and #1991's Done when reads "the query timed on a copy of the live data".
[^h]: `ls shared/project/handoffs/ | grep -i time-log`, Nov 26: no file.
