# Retro: Build 3, per-person Taskmasters + Overlord (2026-11-17)

Build minion #918; feeders #919 (sessions and routing), #920 (Mine and Everyone), #921 (the Overlord), #922 (prompts).
All four started at once around 13:36 PST and had all merged into `build/3` by 14:14 PST (`retro-log/2026-11-17/land.md:264-267`).
#918 took main in at 15:01 (`10c168dc`, CI green in 86 s, `land.md:276`), then a Fable review found five real bugs, fixed in `2b3ee3f6`.

## Fixes, ranked by what they'd have saved

1. **No one told the build minion when a feeder merged in.** #918 parked, waiting on its feeders. `src/land.ts`'s
   handed-off land completion (the `into` branch, around lines 428-493) posts the shipped line in the feeder's chat
   and dismisses the feeder, but never wakes the build owner (`buildOwnerKey`). The build sat for about 45 minutes
   until Cara noticed ("Why are you waiting? 919 is dismissed"). #855 (Build 1) and #875 (Build 2) are parked the
   same way right now.
   Fix: #927 (landed 2026-11-17) wakes and unparks the build owner from that branch with the feeder's summary and
   risk. Build 2's retro found the same gap, so it is the ledger's first row (`README.md`).
2. **Every feeder's self-review missed a login bug.** `turnPerson` in `src/runner.ts` picked the person's login
   only for a card answer. A plan verdict, a file comment, a /backup message, or a card answer for everyone from
   another person all ran on the Taskmaster owner's login. That breaks the "never one person's request on another's
   login" rule. Each feeder rated its own change by its own files, and only `src/access.ts` was on the high-risk-by-file list.
   Fix (in this build): `CLAUDE.md` Project facts now list `turnPerson` as high risk by file, so any edit to it gets
   a Fable review. `test/taskmaster-sessions.test.ts` now pins typed words, a verdict and held mail.
3. **The spec contradicted itself, and a feeder reverted its own review edit.** The spec's "Overlord cards"
   paragraph says an answer wakes only the Overlord, while Cara's later pick, "Asker acts on it", was in neither
   place. #922's review edit `04a9ac2f` followed the paragraph. `44ab11d4` reverted it three seconds later.
   Fix: the spec now records the pick under "Overlord cards" and states the login rule in full (shared
   `specs/per-person-taskmasters-overlord.md`).
4. **The dev seed's sign-in hint was wrong.** `taskmaster-split` said to sign in as Josh with the same password, but
   that password signs in admins only. The dev-copy Grunt had to go through the invite flow.
   Fix: `tools/dev-seeds.ts`'s hint now says so.

## Spec gaps (for Cara to judge)

- **Core:** what happens when a member with no Taskmaster of their own writes straight to the Overlord. The spec's
  "else the Overlord" made it theirs for good, with their words filtered out of Mine. The build review decided their
  own Taskmaster is made first.
- **Core:** the login rule for every person-started turn in someone else's Taskmaster. R5 named card answers only.
  The build applies it to any message a person wrote.
- Smaller choices the feeders made: claims, releases and dismissals as digest lines (#921); no digest in a
  one-person scheme (the review); how Needs you counts per person (#920).

## Keep

- Running all four feeders at once worked. #919 sent its names early, nobody built a second model, and the merges
  had no conflicts (rebase 1, zero conflicts each).
- The deep review (a Fable reviewer, then a Fable finding-checker) caught all five bugs that four light reviews and
  a green CI run missed. Keep it for every build's go card.
- The dev-copy check by a Grunt covered all five handoff checks in about 8 minutes, and its "surprises" list turned
  up the seed and spacing bugs.
