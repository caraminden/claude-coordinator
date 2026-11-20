# Retro: Build 6, platform and apps (2026-11-20)

Build minion #1105. Fourteen feeders merged into `build/6` between 21:06 and 23:57 PST on 2026-11-19: #1125, #1126, #1128, #1118,
#1135, #1137, #1146, #1145, #1181, #1152, #1147, #1136, #1138 and #1148. Only #1136 hit a land conflict (`src/mcp.ts`,
`retro-log/2026-11-20/land.md:244`), and the next try merged it. The build's own full lands were refused 4 times at CI and 3 times at rebase.
They waited about 99 minutes in the deploy line (`land.md:110,130,143,181,320,337`), and main was merged in three times between 00:06 and 01:10 PST.

## Fixes, ranked by what they'd have saved

1. **`SCHEMA_HISTORY` and ADR numbers are still picked by hand, and main took them again. This is the third retro in a row.**
   - #1136's and #1138's schema numbers moved four times: 84/85, then 87/88, 89/90 and 91/92 (b3560b23, 416a02a7, c537d604).
   - Three ADRs were renumbered: 0016 to 0017 (d051b9a0), 0015 to 0018 and 0016 to 0019. Main itself now has four ADR 0015s, two 0013s and two 0002s.
   - Each main merge cost a red `schema-compat` in a full CI run, plus the wait in line before it.
   - #1119, a Build 5 feeder, logged the same thing on its own (`retro-log/2026-11-20/a14cd6c8-*.md:9`): "A number handed out at ship time would end these conflicts."
   - `kit/skills/domain-modeling/ADR-FORMAT.md:25` ("highest existing number and increment by one") collides by design when several branches are open.
   - **Not made here:** the fix is land.sh handing out the next free number when it rebases, so it belongs to the pipeline lane (one minion at a time).
     It is written up in the shared folder's `handoffs/numbers-at-ship-time.md`. Ledger row added.
2. **#1136's static import from `kit/` stopped every copy of the server from booting, and only the build's full suite saw it.**
   - The deploy, previews and restart-hold tests copy only `server.ts`, `src/` and `public/`.
   - #1136's own land ran only the tests its files map to, so it never saw the break.
   - Fixed in the build (abff4111: make-app loads the generator on use).
   - **Fix made:** `test/boot-imports.test.ts` fails when `server.ts` or `src/` statically imports anything outside those three folders.
     `tools/affected-map.txt` maps `server.ts` and `src/**` to it, so the next feeder sees the failure in its own run.
   - This is the second build where a feeder's own run missed a break in files it never touched. Build 4's was `db-setup`, `cold-mail` and `question-images`. Ledger row added.
3. **Two minions built app-restart handling at once, one on main and one in the build, and nobody saw the overlap until the merge.**
   - #1173 (main) added a 5 s retry of refused GETs in `src/proxy.ts`. #1118 (the build) added restart holds in `src/apps.ts`.
   - Together, a held request would retry for another 5 s after its hold ran out, and #1118's fail-fast tests went red.
   - abff4111 joined them: a held request or a stopped app gets no retry.
   - The Fable review then found the second half: a person's Start never cleared the stop's mark (21e07485).
   - **Not made:** the collision showed up on the first main merge, which is that merge's job. The cost was one red full run.
     A watch on main's commits touching the build's files would only move the same discovery an hour earlier.
4. **#1125's settings key cache broke #1029's query-plan test.** It was taken back out in the build (342dfce5), since #1029's index had already
   removed that stall (55 of 205 loop-lag events before it, 0 of 22 after). This is the same class as fix 2. No separate fix.
5. **`prompt-budget.test.ts` conflicted more than any other file on 2026-11-20 (about 8 conflict lines), and `KIT_BUDGET` moved on every main merge.**
   - Two changes can each fit the budget and go over it together (`a14cd6c8-*.md:6`).
   - **Not made:** the merge adds the two raises in a minute. Watch it if it starts costing reds.

Also seen: `review-set-api.test.ts` had 21 flake lines in the day's log. Main fixed it (#1171), and 4721e94c's copy was dropped in the merge.

## Spec gaps (for Josh to judge)

- **Core:** #1137 makes Citadel snapshot app data on deploys that change an app's migrations. That reverses #828's "Citadel never snapshots
  app data" (Josh, 2026-11-19, idea A6 "Build it"; ADR 0018). It was decided, but it changes how every app's data is handled, so the go card says so.
- #1146's "runs in one app's CI" is not met: running it there needs a workflow change in that app's repo. Its adoption handoff is in the shared folder.

## Keep

- Re-recording snapshots (`UPDATE_ACCESS_MATRIX=1`, `UPDATE_SNAPSHOT=1`) instead of hand-merging them: no snapshot conflict cost more than one run.
- Feeders' merge notes naming their risk, what they didn't fix, and the by-hand steps. The go card was built from them.
- The Fable review of the whole diff found two real bugs that every feeder's review missed: incidents running in a preview, and the stop mark.
