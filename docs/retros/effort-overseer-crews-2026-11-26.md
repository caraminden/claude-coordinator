# Effort retro: Overseer crews (Nov 25–26, 2026)

The server started this effort retro (#2166) once the effort's 7 minions had closed. #2076 ("Foreman and crew
proposal") wrote `specs/foreman-crews-proposal.md`, split the work into seven pieces and wrote one handoff per piece.
Josh went "Go" on all seven on its picks page on Nov 25. All seven minions were created between 23:02:12 and
23:04:00 PST Nov 25, chained by `start_after`[^t]:

- #2090: the cabal board (piece 1). Starts now.
- #2091: the Overseer's hands (piece 2). After 1.
- #2092: a cabal card in the minions list (piece 3). After 1.
- #2093: shift change (piece 4). After 1.
- #2094: cabal members in other schemes (piece 5). After 2.
- #2095: prompts, kit skill and words (piece 6). This piece turns cabals on.
- #2096: one cabal retro (piece 7). After 6.

The last piece shipped at 14:02 PST Nov 26[^l]. Times are Pacific.

| | Count |
|---|---|
| Minions | 7, all shipped |
| Cost (turns) | $65.18, against the spec's estimate of about $75. #2090 cost the most, at $17.79[^c] |
| Turns | 13[^c] |
| Prompt eval | $38.57 by #2095's own report. I found no row for it in `turns` or `outside_spend`[^e] |
| Wall time | 15.0 h. 8.5 h of it was #2091's ship card waiting overnight[^q] |
| First ship tries refused | 4 of 7: #2090 (twice), #2092, #2094 and #2095[^l][^m] |
| Ship conflicts | 1, on `README.md` (#2091, 10:01 PST, before #2104's Layout-row merge went live at 11:48)[^l] |
| People's corrections mid-build | 0. People's only inputs were two gos to ship, both from Josh: #2091 and #2094[^m] |

## Fixes

1. **The handoffs for a chain were all written before piece 1 shipped, and two of them leaned on a tool that didn't
   exist.** This repeats a ledger row: briefs that state a guess as fact.
   - **#2095 (piece 6):** this piece was meant to turn cabals on, but no tool could make a minion a lead. #2095 added a
     `lead` flag to `create_ticket` (commit `241388e76`). Until then, pieces 1 to 5 had shipped a feature that nothing
     could start. Its process note says: "the handoff missed that no tool could make a minion a lead"[^m].
   - **#2094 (piece 5):** its brief had it seal a member with `wake_when_live` until the build shipped. That tool only
     works within one scheme. #2094 replaced it with a seal ask to the other scheme's Taskmaster, plus an unseal the
     lead has to remember to send. The retro log has this process line twice for #2094's session[^r].
   - **Why it happens:** `citadel:briefing` says how to write one handoff. It says nothing about a set of handoffs
     written at once, where a later piece calls a tool that an earlier piece is assumed to add, or that is assumed to
     exist already.
   - **Fix:** a handoff, `shared/project/handoffs/handoff-citadel-chain-briefs-name-their-tools.md` (Cara picked it; #2173). It adds a step to
     "Writing a handoff" in `kit/skills/briefing/SKILL.md`, the step where these briefs get written:
     - each handoff in a set names every tool or flag it calls, and either the `rg` line that finds it or the earlier
       piece that adds it;
     - the piece that turns the feature on gets a Done when line that starts it the way a person or Taskmaster would.

2. **Repo-wide guards turned away 4 of the 7 first ship tries, and one of those guards was on no list at all.** This
   repeats the ledger row on a feeder's land running only its own files' tests. The four:
   - **#2090, CI red on `test/settings-pages.test.js`.** This test reads every `public/*.js` for page exports. No map
     rule picks it and it isn't on the always list. `test/pinned-tests.test.ts` exists to catch tests like this, but it
     scanned only `.test.ts` files, so 44 `.test.js` files went unchecked[^p].
   - **#2092, refused at the line on `test/front.test.ts`.** The narrow pick skips importer tests (#1928). The ledger
     already names this case.
   - **#2090, refused on `test/size-budget.test.ts` (00:10 PST), and #2095, refused at CI on `test/prompt-budget.test.ts`
     (12:50 PST).** Both tests are on the always list, and each minion's own run passed. What refused them was growth
     from the other ships in the same train: #2097 added a line to `projects.ts`, and the batch added 4 characters to
     the Taskmaster prompt. Both checks fail on the combined change, and neither minion could have seen it alone. So
     the ledger's check, that no always-test refuses a ship after 21:18 PST Nov 25, failed twice. Both cases are this
     new train-sum shape, not a missed pick[^l].
   - **Shipped here (#2166):**
     - `test/pinned-tests.test.ts` now scans `.test.js` files too. Widening the scan found three more tests no rule
       picked, and each now has a map row: `share.test.js`, `artifact-bridge-page.test.js` and `machine-setup.test.js`.
     - `test/settings-pages.test.js` now runs on every `citadel-test` (it takes 0.1 s) and is listed in `REPO_WIDE`.
     - The scan still misses a folder scan done through a variable, like settings-pages' `readdirSync(dir)`. Its
       `shortcut:` comment now says so.
   - **Not fixed here:** the train-sum refusals cost one extra try each, about 12 and 10 minutes between the refusal
     and the landing[^l]. A guard for that belongs in land.sh, a pipeline-lane file, so this retro records it on the
     ledger without proposing a fix.

3. **The prompt eval's $38.57 is missing from #2095's spend.** Citadel showed #2095 at $7.66[^c], but its own report
   says the 16-case Taskmaster eval alone cost $38.57, and the eval's `claude -p` runs have no row in `turns` or
   `outside_spend`[^e]. I don't know whether another table counts them (the query is in the handoff). If none does,
   every budget readout and Taskmaster cost alert misses the most expensive check in the repo. The brief's $14 estimate
   didn't include it either.
   - **Fix:** a handoff, `shared/project/handoffs/handoff-citadel-prompt-eval-spend.md` (Cara picked it; #2174). It checks first, and if
     nothing counts the eval, books `run.ts`'s total cost on the minion that ran it.

## Not fixed, and why

- **The critical path ran through one overnight go.** #2091 was rated high risk. It posted its ship card at
  01:28:54 PST, and Josh's go came at 10:01, which is 8.5 of the effort's 15 hours[^q]. Pieces 5, 6 and 7 were chained
  behind it, waiting for it to go live. The fix would be a change to the go rule (a go given at planning time for a
  piece the spec already marks high risk), or starting piece 5 on piece 2's branch. That's for the scheme's members to
  decide, so this retro doesn't propose an edit. If the wait comes up again, a member decides.
- **Smoke's flake check reads only `.test.ts` names.** Codex found this while reviewing #2166.
  - `tools/land/prepare.sh` collects the failed files with a `.test.ts`-only pattern.
  - Suppose a `.test.js` guard (now including `settings-pages`) fails, and in the same run a `.test.ts` file fails and
    then passes alone. Smoke calls the whole run a flake and lets the ship into the line.
  - CI still runs every file after the line, so the cost is a later refusal, not a bad ship.
  - The pattern predates this retro: map-picked `.test.js` files have always had this gap.
  - The fix belongs in a pipeline-lane, high-risk file, and the kit's template needs the same fix, so it goes to the
    Taskmaster instead of shipping here.
- **Codex was skipped in #2094, #2095 and #2096** because the weekly limit was at 80%[^m]. That's a limit doing its job.
- **A later piece's review found holes in an earlier piece.** #2096's reviewer found cross-scheme visibility leaks in
  the new timeline, which builds on #2094's access work, and #2096 fixed them in `eb460e819`[^m]. The chain order is
  what let piece 7's review catch that. It's worth keeping.

## Spec gaps

- **The spec never said how a cabal starts.** It covered forming, the board and the prompts, but no piece owned the
  tool that makes a minion an Overseer. #2095 invented the `lead` flag on `create_ticket`, which settles a core flow.
  Josh should judge whether a Taskmaster flag is the right trigger.
- **Cross-scheme sealing was left to piece 5 to work out.** The spec's "Cabals across schemes" section didn't say how a
  member in another scheme waits for the build. #2094 settled it as a seal ask plus a manual unseal, and that unseal
  is still left to the lead to remember. Josh should judge that too.

## What to keep

- **One spec, seven handoffs and a picks page.** Josh's one go started the whole effort, and nobody corrected a
  minion mid-build[^m].
- **Pieces 3 and 4 ran beside piece 2 without a clash.** #2092, #2093 and #2091 shipped with one conflict between
  them, and that one was in `README.md`[^l].
- **The turns came in under the spec's estimate**, at $65.18 in turns against about $75[^c]. That figure leaves
  out the eval in finding 3.

[^t]: `host_check` db, `SELECT number, created_at FROM tickets WHERE project_id=2 AND number BETWEEN 2090 AND 2096`,
    run 2026-11-26 about 16:40 PST: created 1795676532933 to 1795676640281 ms, which is 23:02:12 to 23:04:00 PST Nov 25.
[^c]: `host_check` db, `SELECT t.number, count(u.rowid), round(sum(u.cost_usd),2) FROM tickets t LEFT JOIN turns u ON
    u.ticket_id=t.id WHERE t.project_id=2 AND t.number BETWEEN 2090 AND 2096 GROUP BY t.number`, run 2026-11-26 about
    16:40 PST. Turns 3, 2, 2, 1, 2, 2 and 1 (13 in all). Costs $17.79, $13.07, $6.14, $3.13, $13.03, $7.66 and $4.35
    (summing the raw rows gives $65.18; the rounded figures sum to $65.17). The $75 estimate is from the spec's "The pieces" section.
[^e]: #2095's report, read with `read_minion` 2095 last=50: "the 16-case Taskmaster eval alone cost $38.57". Checked
    with `host_check` db, `SELECT * FROM outside_spend` (one row in all, scheme 10's), run 2026-11-26 about 16:45 PST.
[^l]: `grep -E 'ticket/209[0-6]-' retro-log/2026-11-26/land.md | grep -E 'conflict|guard|smoke|burn|flake|timing'`,
    run 2026-11-26 about 16:50 PST, with UTC converted to PST. #2090 was refused at the line at 00:05 and 00:10 (the
    second on `size-budget`, on #2097's train) and landed at 00:22. #2093 landed at 01:00. #2092 was refused at the
    line at 01:33 and landed at 02:04. #2091 had its `README.md` conflict at 10:01 and landed at 10:11. #2094 had a
    smoke refusal at 11:52 and landed at 12:20. #2095 had its `prompt-budget` burn-in red at 12:50 and landed at
    13:00. #2096 had a `cabal-start` flake at 13:51 and landed at 14:02.
[^m]: `read_minion` on #2090 to #2096 (last=50), read by two Sonnet Grunts on 2026-11-26 about 16:30 PST, plus
    `git log main --grep='^#209N'`. #2090's first refusal was a CI red on `settings-pages`.
[^q]: `host_check` db on `events` with kind `question` for #2091 and #2094, run 2026-11-26 about 16:45 PST: #2091 at
    01:28:54 PST and #2094 at 11:17:40 PST. Josh's gos came at about 10:01 and 11:50 (`read_minion`). The wall time is
    23:02 to 14:02.
[^r]: `grep -c wake_when_live retro-log/2026-11-26/ce40df22*.md`, run 2026-11-26 about 16:35 PST: 2 process lines.
[^p]: `git ls-files 'test/*.test.js' | wc -l` gives 44. `node --test test/pinned-tests.test.ts`, with the filter
    widened to `.test.[jt]s`, named the three unmapped files. Both were run 2026-11-26 about 16:55 PST.
