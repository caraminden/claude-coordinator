# Effort retro: Turns the server could do (Nov 25–26, 2026)

The server started this effort retro (#2164) once the effort's 7 minions had closed. #2031 ("Audit: turns the server
could do") wrote the handoffs, and Josh picked six of them on its choices page. The Taskmaster started all six within
37 seconds, from 16:14:21 to 16:14:58 PST Nov 25[^t]:

- #2046: hand off once, ship when ready
- #2047: stall alerts skip box-refused ships
- #2048: no staying open just to tidy up
- #2049: the post-deploy watch wakes less
- #2050: a card pick starts the minion
- #2051: more box hiccups re-queue

#2089 came from #2046's own handoff for its pieces 2 and 3. Josh's pick at 22:51 PST started it through #2050's new
card start[^e]. The effort closed at 09:59 PST Nov 26, when the Taskmaster dismissed #2046[^t]. Times are Pacific.

| | Count |
|---|---|
| Minions | 7, all shipped |
| Cost | $49.36, of which #2046 and #2050 = $27.39[^c] |
| Turns | 23, of which #2050 had 8[^c] |
| Refused ships | 2, both #2050's: `test/size-budget.test.ts` at the line, then a DB-handle guard in CI[^l] |
| Conflicts with one of the effort's branches shipping | 6, of which 4 named `README.md` (3 #2050, 1 #2046)[^k] |
| Overlap between the effort's minions | 1 file, `src/ship-handoff.ts` (#2046 and #2051). Citadel's train prep caught it, and the fix was recorded ahead of time[^l][^r] |

## Fixes

1. **A card pick that starts everything leaves the card's owner open, with no turn to close it.** This is new: no ledger row.
   - **Who it hit:** #2046 shipped at 22:05 PST and then asked Josh, on a card, whether to start pieces 2 and 3.
     - Josh's pick at 22:51 started #2089 through #2050's card start.
     - Under ADR 0038, an all-started pick reaches the owner as held mail, with no turn.
     - So #2046 sat open for 11.1 hours until the Taskmaster dismissed it[^e][^h].
   - **How often since #2050:** of the 19 minions whose card started a minion, 3 sat 9 to 11.1 hours with no turn after
     the pick, until the Taskmaster dismissed them: #2046, #1921 and #2060[^h].
   - **Still open at 16:10 PST Nov 26:** 4 more were idle with no open card: #1778, #2115, #2117 and #2127. One of them,
     #2117, is the last effort retro[^h].
   - **Why it happens:**
     - The retro skill (step 8), `kit/schedules/architecture.md` and `kit/skills/cabal/SKILL.md` tell a minion to stay
       open in state ready until its start card is answered.
     - #2050 made that answer arrive with no turn.
     - Nothing closes a minion whose last open card was settled by starts. ADR 0038's line "nothing is left for the
       owner to do" is true, but no code acts on it.
   - **Fix (handoff, this repo's server):** `shared/project/handoffs/handoff-card-start-closes-owner.md`. An all-started
     pick dismisses the owner when nothing else is left for a person:
     - no other open card,
     - no unshipped commits on its branch,
     - no try, pending-deploy, sealed or outside state,
     - not a build or cabal lead.
     Otherwise it keeps today's held mail. This is a check where the mistake happens (the pick), not prose. It is on
     this retro's start card.
2. **Handoffs written before a person's pick weren't brought in line with the pick (ledger repeat: "Briefs state a
   guess as fact").** All six briefs were #2031's handoff files, passed on as written[^r].
   - **#2051:** the handoff's Done when listed four refusal kinds, but Josh's pick on #2031's page named three. #2051
     built the fourth, then removed it once fresh eyes flagged it. Josh then answered the second-red card "No, wake the
     minion"[^r].
   - **#2048:** its handoff said `relay_when_live` or `wake_when_live` could wake another minion. Neither can. The
     retro log has its `process` line: "the handoff overstated what the two live-wake tools do"[^p].
   - **#2049:** the handoff's "68 to about 10 wakes" could only be checked on the live data. The replay later measured
     26 to 11 minions over 7 days[^r].
   - **#2047:** its brief named #2030 as the neighbour but not #2051, which sat beside it on the same page about the
     same refusal kinds. No work was done twice: #2047 counts refusals and #2051 re-queues them[^r].
   - **Why:** the briefing skill's handoff section says that part 2 quotes the pick, but not that the handoff's Goal
     and Done when are cut to match it. A card start (#2050) now passes the file to the new minion unread, so a
     mismatch reaches the minion unless someone fixes it before the card goes out.
   - **Fix (handoff, kit):** `shared/project/handoffs/handoff-citadel-handoff-matches-pick.md`. It adds a line in
     `kit/skills/briefing/SKILL.md`, at the handoff step:
     - A pick that narrows or changes a handoff gets the file edited before it starts: Goal, Done when, and any claim
       about a tool, checked against that tool's description.
     - A choices-page pick that differs from the handoff starts nothing until the file matches.
3. **Two judge replays needed the live database from a container turn (ledger repeat: "A brief's Done when needs what
   the turn can't reach"). The guard shipped during the effort.**
   - **#2049:** asked the Taskmaster for a host run at about 17:00 PST. It went on after Cara's "run your replay"[^r].
   - **#2089:** asked at 23:00 PST. Josh re-recorded the `ci-red` replay by hand[^e][^r].
   - **The guard:** #2074 (`host_check` `judge_replay`) shipped at 23:27 PST, 27 minutes after #2089 asked[^l2].
   - **Edit:** this retro adds #2074 as the row's guard in the ledger. No new edit. The next retro checks that no
     container turn waited on a person for a judge replay after 23:27 PST Nov 25.

Not fixed, with the reason:

- **The ship line's `README.md` conflicts.** 4 of the 6 conflicts with one of the effort's branches shipping were on `README.md`,
  3 of them #2050's, and each cost #2050 a turn that only re-recorded the fix[^k][^r]. #2104 made Layout rows merge at
  ship time (live 11:48 PST Nov 26), after the last retro proposed it. Since then the logs show no README conflict:
  the one conflict after 19:48 UTC named `docs/retros/README.md`, the ledger[^k2]. The guard holds, so there's no new edit.
- **#2050's two refusals.** The size budget (+12 lines in `src/routes/projects.ts`) and the DB-handle guard are both
  checks doing their job[^r]. The size-budget one is the ledger's shared-counts row, already guarded by #1917.

## Spec gaps

- **#2050 (core: a flow):** ADR 0038 decided that a pick holds the owner's turn. Neither it nor #2050's brief said who
  then closes the owner. That's fix 1. It's for Josh to judge, since he picked "A pick starts the minion, with no
  Taskmaster turn".
- **#2047:** it chose by itself to leave CI-runner and "no answer" refusals out of the stall count, and asked Josh to
  say if he wants them counted. No answer is on record[^r].
- **#2049:** it chose by itself the path-matching rule (stall frames, error source, the served path for front-end
  files) and the 20-minute hold[^r].
- **#2050:** a Taskmaster's own cards can't carry `start`. It scoped that out as "Not fixed", in the ADR[^r].

## What to keep

- **The split.** Six independent pieces from one audit, started together. Five of them shipped within 5.5 hours
  of the start[^t]. Only one file was shared between them, and the train prep caught it before either minion had to.
- **#2046 stopping at piece 1.** It handed pieces 2 and 3 to a fresh minion instead of carrying a long chat. #2089
  cost $9.54, against $15.76 for #2046, and needed no correction[^c][^r].
- **#2050's card start working on the effort's own next step.** #2089 started from #2046's card with no Taskmaster
  turn, 4 hours after #2050 shipped[^e][^l].
- **Train prep's conflict heads-ups,** with the fix recorded ahead of time. They turned #2046 and #2051's shared file,
  and all three of #2050's README conflicts, into replays that needed no human[^l].

[^t]: `host_check db`: `SELECT number, model, datetime(created_at/1000,'unixepoch','-8 hours'), datetime(closed_at/1000,'unixepoch','-8 hours') FROM tickets WHERE project_id=2 AND number IN (2046,2047,2048,2049,2050,2051,2089)`, run 2026-11-26 16:05 PST. The last close in the effort before #2046's was #2051 at 21:41 PST, so five of the six shipped by 21:41.
[^c]: `host_check db`: `SELECT t.number, count(u.id), round(sum(u.cost_usd),2) FROM tickets t JOIN turns u ON u.ticket_id=t.id WHERE t.project_id=2 AND t.number IN (2046,2047,2048,2049,2050,2051,2089) GROUP BY t.number`, run 2026-11-26 16:06 PST: 15.76, 2.58, 0.80, 4.48, 11.63, 4.57 and 9.54, with turns 4, 2, 1, 2, 8, 4 and 2.
[^l]: `grep -h -E "ticket/(204[6-9]|205[01]|2089)-" retro-log/2026-11-2[5-7]/land.md` in the shared folder, run 2026-11-26 16:00 PST: `refused at line` and `refused at ci` lines for #2050, and the train-prep conflict on `src/ship-handoff.ts`. #2050's `landed` was at 02:46:56Z (18:46 PST).
[^k]: The same grep, keeping `land conflict` and `train prep conflict` lines where one of the effort's branches is the one shipping (6), then those naming `README.md` (4: 3 for #2050, 1 for #2046). 3 more lines (05:58 to 05:59Z) are #2077's, outside the effort, against #2046's train.
[^k2]: `grep -hE '(train prep|land) conflict' retro-log/2026-11-26/land.md | grep README.md | tail -3`, plus `grep ticket/2104- … | grep timing` (landed 19:48:07Z), run 2026-11-26 16:15 PST. The one conflict line after 19:48Z (23:46:55Z, #1935) names `docs/retros/README.md`.
[^l2]: `grep -h "ticket/2074-" retro-log/2026-11-26/land.md | grep timing`: landed 07:27:51Z = 23:27 PST Nov 25, run 2026-11-26 16:13 PST.
[^e]: `host_check db`: #2046's and #2089's events by `kind` (note, user_message, question) around 22:06 to 23:01 PST Nov 25, run 2026-11-26 16:08 PST. Includes #2089's note to the Taskmaster at 23:00:48: "`tools/judge-replay.ts` can't open coordinator.db".
[^h]: `host_check db`: each minion's last `note` starting "Citadel started #", and its `closed_at` minus that note's time, with the turns after it and the closing note, run 2026-11-26 16:09 PST, Citadel's minions only (19 with such a note; the three ran 8.97, 10.06 and 11.13 h, confirmed by the footnote re-run). The open ones were checked for questions with no later user_message at 16:10 PST.
[^p]: `retro-log/2026-11-26/2c0523ea-3b6f-4847-b7ee-6604b2fdfd92.md` (#2048's session), the `process` line at 00:40:51Z.
[^r]: read_minion on the seven minions, read by three Sonnet Grunts for this retro, Nov 26. Their counts are quoted, not re-derived.
