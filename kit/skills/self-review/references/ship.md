# Self-review: shipping routes

Part of `citadel:self-review`, opened by name from its SKILL.md; section numbers (1 to 5) are SKILL.md's.

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
  at once, when the ship would have been refused (a claim the ship needs is read at the press): fix it and post the card again. Then pressing Ship It starts the ship with
  no turn of yours, and the press is the go. Change nothing after the card: a new commit, an uncommitted edit or a person's
  message makes the press come to you as an ordinary answer with a line saying why, and you hand off yourself. Leave
  `hand_off` out on a feeder's or build card, where ships go by pull request, for an `outage` ship, and when you owe steps between the go and the ship.
