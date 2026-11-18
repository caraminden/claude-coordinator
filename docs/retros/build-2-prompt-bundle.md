# Retro: Build 2, the prompt bundle (2026-11-17)

Build minion #875. Feeders: #878 (lever A: a byte-stable system prompt plus the prompt hash
log) and #931 (trims to the minion and Taskmaster prompts, the tool descriptions and the model
table). The brief was `shared/project/handoffs/handoff-prompt-bundle-build.md`. The evidence:

- the three chats (events for tickets 2067, 2070 and 2158);
- the `timing` lines in `retro-log/2026-11-17/land.md` (lines 140 and 279–291);
- the build's diff against main.

None of the three sessions logged a hook line: no tripwire refusals and no `process` lines.

## Fixes

1. **A feeder's red tests reached the build unseen for 12 hours.**
   - **What happened:** #878 merged into `build/2` at 02:48 PST and ran only the tests it
     touched ("into build/2 · tests 10 · merged", land.md:140). The first full run was #875's
     main take-in at 15:09 PST. It went red on 33 tests in 10 files ("refused at ci",
     land.md:279), and every one of them already failed on #878's own tip, 456d352f. #878 was
     reopened and fixed them, and the build was green again by 15:25 PST.
   - **Edit:** `src/prompts.ts`, build minion step 2. On each feeder merge, the build minion
     fast-forwards and runs `tools/land.sh --into build/<n> --full`. A full CI run takes about
     100 s (land.md:289, 291), so a red shows against the feeder that caused it, within minutes.
   - **Not land.sh:** land.sh is in the pipeline lane and rated high risk by file, so a land.sh
     change would hold this build. Making `--into` run the full suite for feeders is the
     stronger guard. If this repeats, it goes to the Taskmaster for the lane.
2. **Cara couldn't follow the build's list.**
   - **What happened:** she asked "Where did you come from? Did build 2 get lost?" and "I see a
     build 1 now as well" at 15:02–15:03 PST, then "What is feeder 2?" at 15:31 PST. The list
     named feeders as bare #N, and #875 had sat idle from 02:48 to 15:01 PST.
   - **Edit:** same step 2: each feeder is listed as #N with its short title.
   - **Already being fixed:** the idle gap is #927's, which wakes the build minion when a feeder
     merges.
3. **A rule the brief changed was one the server enforces.**
   - **What happened:** Cara's pick was "Relay: a quoted go always counts". But
     `src/approvals.ts` counts a go only from a person's typed message, and a bare "merge it"
     sent to the Taskmaster covers nothing (`test/merge-go.test.ts`). #931 flagged the mismatch
     (15:30 PST), and the build's self-review narrowed the prompt so it matches the server: a
     quoted go counts card-less only when it names the PR number.
   - **Edit:** none in this build. Widening `approvals.ts` is Cara's call, asked on its own
     card.
   - **For audits:** an audit that rewords a rule should name the file that enforces it.
     Neither the audit nor the brief did here. This is the first time it has come up, so it
     stays a retro note to watch for.

## Spec gaps (marked core where they set how the system works)

- **Core: where the per-minion lines go.** The brief gave "either… or" for A4. #878 put them
  in a turn note that opens each turn's message. Codex hand-over and hand-back then had to skip
  those notes (`isTurnNote`, a real bug that the 33 red tests found).
- **Core: the hash log's storage.** The column became `turns.prompt_digest` because
  `host_check`'s secret pattern matched "hash". The SCHEMA number moved to 62, behind #862's
  keepalive at 61. The brief said nothing about the schema numbering. `test/schema-compat`
  caught the clash, and #875 renumbered it twice.
- **Core: quoted-go semantics.** See fix 3. The prompt now says less than Cara picked, so that
  it matches the server.
- **Picked by the minions:**
  - The advisor trial's end date, 2026-11-30, was #931's pick with no source.
  - Merging the model table's tiers into fewer rows was also #931's call.
  - G-12 (Taskmaster-only memory) was dropped from this build.
- **Not covered by the brief:** a test policy for feeder merges. See fix 1.

## What to keep

- **Rule out the feeder before blaming the merge.** #875 ran the failing files on the feeder's
  own tip before suspecting the main merge. It kept the merge on its own branch, so `build/2`
  stayed on its last green commit.
- **Reopen the author.** #878 was reopened rather than having the build minion patch around
  its work. Its fix loosened no test, and it added one that fails without the Codex fix.
- **Search tests for reworded lines.** Before rewording a sentence, grep the tests for it.
  #931 found the one regex in `test/turn-setup.test.ts` this way.
- **Flag rather than edit enforcing files.** #931 raised the `approvals.ts` mismatch instead
  of editing a file next to the tripwire.
- **Full CI on the desktop runner takes about 100 s.** That is cheap enough to run after
  every feeder.
