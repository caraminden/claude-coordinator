# Retro: Build 5, for people (2026-11-20)

Build minion #1104; 14 feeders in four lanes: #1121 → #1130 → #1140 → #1149, #1122 → #1131 → #1141 → #1151,
#1123 → #1132 → #1142, #1124 → #1133 → #1144. Josh approved the build 2026-11-19 at about 8:55 PM PST. All 14 feeders
merged into `build/5` between 05:07 and 08:55Z on 2026-11-20 (`retro-log/2026-11-20/land.md`). The build's full suite
went green on CI at 09:01Z, and again with main taken in (run 44706923935).

## Fixes, ranked by what they'd have saved

1. **One full suite per feeder merge queued the build behind its own feeders for about three hours.**
   Build step 2 said to run `--full` "each time a feeder merges in". With 14 feeders landing in bursts, #1104 queued 10 full
   lands. Their time in the deploy line was 323, 1021, 736, 1153, 1764, 1161, 1646, 1691, 1480 and 131 s, about 3 h 5 min
   in all. Four of them (05:37, 06:46, 07:06 and 07:45Z) were refused at rebase or fallback, because a feeder merged while
   they waited, and those runs proved nothing. This also broke the brief's load rule ("full suite no more than once a day
   unless a merge needs it").
   Fix made: build step 2 in `src/prompts.ts` now runs the full suite once no feeder is still landing into the build,
   which batches a burst into one run.
   Not made, proposed for the pipeline lane: a `--full` land refused at rebase only because `build/<n>` moved could merge
   the new tip and stay in line.
2. **Main took the next `SCHEMA_HISTORY` number (and the prompt budget) out from under the build, again.**
   #1123's host_samples and #1130's tickets.goal were renumbered twice, then a third time after the build's last merge of main, when the Fable review found main's `ideas` and `flake_fixes` holding 89 and 90. They ended at 91 and 92, then main took 91 to 93 while the build waited for Josh's go: two more renumbers, ending at 94 and 95 (five in all). The minion and Taskmaster
   budgets in `test/prompt-budget.test.ts` went over on both merges of main (+47 and +17 chars).
   Both showed up only in CI on Cara's desktop, which compares with the newest origin/main. Build 2 and Build 4 hit the
   same schema clash. It is now a ledger row.
   Still not made, as in Build 4: a smoke check in land.sh that compares `SCHEMA_HISTORY` with main's tip before queueing.
   It needs the pipeline lane.
3. **Three tests passed in every feeder's run but depended on where and when they ran:**
   - `test/status-page.test.ts` read "today" in Pacific time, so it failed between 00:00 and 01:00 PST.
   - `test/watchdog.test.ts`'s backup test needed a live Citadel on 8573, which CI's runner doesn't have.
   - The review-set dev seed committed into the checkout the tests ran in. It moved this branch's HEAD; the branch was
     reset and the fixes were reapplied.

   Fixes made in the build:
   - `sameDayNow()` in the status-page test.
   - `WATCHDOG_CITADEL_PORT` with a stand-in server.
   - The seed's repo now lives under the copy's data. `test/dev-copy.test.ts` asserts that HEAD and the tree are unchanged
     after seeding twice; #1140 shipped the same fix.

   Not made: a suite-wide HEAD check in `test/leak-guard.ts`. A minion committing while its tests run would turn it red.

## Also seen

- #1142 changed `deploy/offbox-serve.sh`, a high-risk file by Project facts, and merged into the build with no
  self-review. The build's Fable review is what read it.
- #1131's merge into `build/5` carries no subject line. Its commits arrived only through branch ancestry, which made the
  build list harder to check from `git log`.
- `test/review-set-api.test.ts` flaked under load and refused the 05:16Z full run (33 flake lines across lands that
  night). Main's fix (98f6a888, 77454774) is in the build.

## The build's Fable review

Label high, set by `deploy/offbox-serve.sh` (#1142). The edit itself fails safe. Who-sees-what came back clean.

Fixed:
- Schema renumbered to 91 and 92.
- #1144's kept answers held every GET for the whole session. They now hold only the paths a chat's opening replays,
  at most 200.
- Home ticked "Answered" on rows that had only been opened or withdrawn. It now says "Done".

Left, all low:
- The status dev seed still points the Seeded scheme at the running checkout: its ships need this repo.
- `test/dev-copy.test.ts` needs a git checkout.
- The first start after shipping nudges every target already slow today.
- The CSP allows `data:` images for #1141's crop.
- The service worker fetches the whole shell again on any asset change.
- A long-time member with no last action sees the first-day welcome.

## Spec gaps (for Josh to judge)

- **Core: where cross-scheme items wait.** Main's ADR 0015 (Josh, 2026-11-19) keeps each scheme's Needs you to its own
  items. #1140's Home lists every scheme's. The build resolved this as compatible: Home is the Citadel-wide page,
  `directCards` feed only it, and the per-scheme inbox stays filtered.
- **Core: #1149's mentions** show on the mentioned person's row and in Your move until they open the chat. The guard for
  a turn with no caller is untested.
- Smaller: #1141's crop isn't drawn in Safari and is untested in Firefox.

## Round two: Josh's preview feedback (2026-11-20)

- **The preview never loaded** (Josh: "I dont seem to be able to load the preview"; Cara: 502 on webplatform, a hang on
  citadel.zip). Cause: the preview's data copy used a stepped `backup()` from the live connection, and the db-writer
  worker (#795) writes through its own connection, which restarts a stepped backup, so the copy never finished. #1204
  copies with one step from a fresh read-only connection. My first diagnosis (the live restarts) was wrong. Watching the
  copy's size stall at 196 MB settled it.
- **Josh's six notes became two feeders.** #1218 (low) drops the word tips and colours Status by failure share. #1217
  (medium) makes Home the normal minion list of everything waiting on you across schemes, with counts and 14-day ship
  bars in the chat's space. The spec gap: #1140 had built a new pared-down Home that Josh hadn't asked for, and only the
  preview showed it.
- **#1217 broke `test/inbox.test.js` and its land into the build didn't see it.** home.js began importing the app
  shell, and inbox.js imported home.js, so node couldn't load the inbox module. The feeder ran only its own files' tests.
  Fixed in the build: inbox.js loads home.js lazily, as it already did sidebar.js. The map now runs the inbox tests on
  a home.js change. Proposed, not made: `citadel-test --affected` also runs every test that imports a changed file.
- **The second Fable review** confirmed six findings (a checker refuted three). #1218 was half done: Status's tiles
  still went yellow on one failure, and the CI share counted every branch's runs. Home's 14-day buckets cost about 1.3 s
  on the server's one thread at 2,000 notes. Two real hovers (the ship badge, the Turns switch) went with the word tips.
  Home's count chips reflowed on a phone. All are fixed, and an Opus re-review of the fix diff found one more phone
  slot and a CI headline, now fixed too.

## Keep

- Four independent lanes: no lane ever waited on another, and the only rebase conflicts were in `public/core.js` and
  `public/hidden.js` (05:54 to 06:00Z), each settled at hand-off.
- Feeders' merge notices waking the build minion (#927's guard held all night).
