# Self-review: shipping routes

Part of `citadel:self-review`, opened by name from its SKILL.md; section numbers (1 to 5) are SKILL.md's.

## Alongside the ship

Which changes qualify (section 1):

**Alongside the ship.** A change qualifies when how it ships is `hand_off_land` (the server runs
the ship and the call returns at once), the Shipping line in your prompt lets a low change ship
with no go and no try first, the sizing is Light, the branch is no feeder's (a feeder reviews
before it merges in: `references/review-extras.md`, "A feeder"), and the file list alone says low.
`git diff --name-only main...HEAD` shows only front-end files, `README.md`, docs outside
`docs/rubrics/` and `docs/design-system/`, and test files that exercise no high-risk file, and it
shows none of: a file on Project facts' high-risk-by-file or medium-at-least lists, a file under
its "Agent instructions", `CLAUDE.md`, `.claude/`, the kit, or a file a Project facts rubric's
`when:` matches. Decide this from the file list before any review; a doubt about one file means it
doesn't qualify. A qualifying change hands off its ship as soon as its tests are green and the
screenshots are checked, and the review in sections 2 to 4 runs in the same turn while the ship
runs. Everything else reviews first.

The steps (section 5):

- **Alongside the ship:** the steps, in one turn:
  1. Run any critic whose `when:` matches first (section 3's rubrics), then `hand_off_land` with risk `low` and the reason `low by file list; review runs alongside`. Code review runs alongside a ship, critics don't: the hand-off refuses a change a critic matches until its run is on record (Cara, 2026-11-21: "Code review can be simultaneous, but critics not").
  2. Keep the turn open and run sections 2, 3 and 4: reviewer, base check, Codex and any fresh eyes in one message, `run_in_background: false`. The ship runs on the server meanwhile; an open turn can't cut the Grunt off.
  3. Nothing real found: end the turn with the report line (SKILL.md section 5, "Below the threshold"). The server dismisses you once the ship is clean.
  4. Something real fixed: commit and `hand_off_land` again with the same `risk` and `risk_reason` and the summary `follow-up: <what the review found>`. It waits for the first ship if that still runs, so a slow return is the line, not a hang.
  5. The first ship fails while the review runs: its wake arrives after your turn ends. Fix the failure on top of the review's commits and hand off again.
  A qualifying change that the review shows is medium or high is a defect in the file-list test: say so in the Risk line, and the follow-up takes that label's route.

## The fix route

- **The fix route** (Cara, 2026-11-20, "Fixes ship; data still asks": "the thing we are trying to
  protect is already broken, shouldnt we just fix it?"). At or above the threshold, a change skips
  the go when your minion's `type` is bug and all four hold:
  1. **A test proves it.** A test file that ran red on main's tip and green on your branch. Record
     it, don't claim it: write or change the test (or name one main already has red) and commit.
     Run your test file against main's code, not your fix: a scratch clone checked out at the main
     commit your branch is built on (`git merge-base HEAD main`) with only your test file copied in.
     Keep the failing lines it prints, then run it green on your branch. The test file, that main
     commit's sha and the failing lines are the proof.
  2. **The deep review is clean:** run deep whatever the diff's size, and nothing real is left
     unfixed.
  3. **No data, no auth:** no migration that changes rows or columns already there, no deletion
     of data, and no change to any file Project facts marks as auth.
  4. **A plain revert undoes it** (two-way door in 4).
  On `hand_off_land`, pass `fix_proof` in place of `go`: `{ test, red_on, red_output, review }`
  (`review` starts "clean"). The server checks what git can show: type bug, the test a file your
  branch commits (changed by it, or a test file), `red_on` on main and in your branch, and a diff
  with no path named for auth, migration or SQL that rewrites or deletes data; anything it refuses
  takes the High route. The rest is your word: the red run, the review, a revert, and auth files
  only Project facts names. On a pull-request path, the PR description carries the same proof and the line
  `Shipped as a fix without a go: <test>`. Members get that one line on the shipped line and the
  Releases row, no card. It never applies where every change waits for a person, and a new rule or
  feature is not a fix, even in a high-risk file.

## The High route

- **At or above the threshold (High), unless the fix route above holds:** stop before shipping. Post the same line (the Risk line in SKILL.md section 5), the findings you fixed in one line each,
  and an `ask_question` card with `kind: "merge"` and header "Ship It" (the minions list's chip reads "Ship It"), "Ship this <label>-risk change?" (Ship It /
  Hold, with your pick marked recommended). A feeder's change merges into its build, so its card says Merge: header "Merge", "Merge this <label>-risk change into Build <n>?" (Merge / Hold). Set state null, note `risk <label>: waiting for a go`,
  and end the turn. Ship only on a go.
- **Prepare the ship with the card** (#1930): when your change goes to main by `hand_off_land`, commit everything first
  and pass `hand_off` on that card: the arguments you would hand it off with, without `go` (`summary`, `risk`, `risk_reason`,
  `learned`, `probe`; `fix` only for a rolled-back deploy's). One option is labelled exactly `Ship It`. A refusal comes back
  at once, when the ship would have been refused: fix it and post the card again. Then pressing Ship It starts the ship with
  no turn of yours, and the press is the go. Change nothing after the card: a new commit, an uncommitted edit or a person's
  message makes the press come to you as an ordinary answer with a line saying why, and you hand off yourself. Leave
  `hand_off` out on a feeder's or build card, where ships go by pull request, and when you owe steps between the go and the ship.
