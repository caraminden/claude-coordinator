# Retro: Build 4, reviewers and critics (2026-11-19)

Build minion #1050; feeders #1051 (store and page, medium), #1052 (built-ins and agent, high), #1054 (wiring and record).
A duplicate phase-1 minion, #1053, was started from a second brief and closed without merging.
All three feeders merged into `build/4` the same afternoon. #1050 landed the build branch six times (`land.md`, 23:05 to 00:20Z), three of them refused at CI.

## Fixes, ranked by what they'd have saved

1. **`SCHEMA_HISTORY` numbers are picked by hand, and main took the next one four times while the build was open.**
   #1051 wrote 72, then 77, 78, 80 and finally 81. Each time main moved, `test/schema-compat.test.ts` went red in the full CI run
   (`land.md` 23:07, 23:49 and 00:09Z, "refused at ci"), and each retry waited in the deploy line 4 to 7 minutes before
   the CI run even started (`line 187`, `line 411`). The conflict is always the same textual one in `src/db.ts`.
   Fix proposed, not made here: a check in land.sh's smoke step that compares `SCHEMA_HISTORY` with main's tip before queueing, so the
   clash shows before the line, not after 2 minutes of CI. Needs the pipeline lane.
2. **A feeder's own land runs only the files it touched, so three regressions in files #1051 never touched showed up only in the build's full run:**
   `test/db-setup.test.ts` (the two new tables were two more commits on a new database, 16 against a limit of 15), `test/cold-mail.test.ts` and
   `test/question-images.test.ts` (a new "no review set" line added to every scheme's turn). Fixed in the build. Fix made: CLAUDE.md's
   Project facts now name `test/db-setup.test.ts` and `test/schema-compat.test.ts` beside host-check for a change that adds a table.
3. **Self-review of each feeder missed a ship-gate bypass that the whole-build Fable review found.** With a scheme's go threshold set to `never`,
   an unlabelled ship needed no go, against Josh's Q10. The one gate test ran on the default threshold. Fixed in the build, with a test for `never`.
   This is the second build where only the build-level review caught a gate (Build 3's `turnPerson` was the first): ledger row added.

## Spec gaps (for Cara to judge)

- **Core:** a hand-off with no `risk` while the pre-ship review is on was a 400, and is now treated as high with no reason needed (finding 3 of the review, left as is).
- Smaller: `reviewSetLine`'s "no reviewers on" text is no longer reached, since a scheme with none now gets no line at all; the reserved slug `audits`.

## Keep

- The one-off import being insert-only, run once, with a person's go quoted on the card: nothing in it needed a second look.
- Feeders rebasing onto `build/4` themselves when it moved (#1052), so the hashes stayed.
