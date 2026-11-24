# Self-review: review extras

Part of `citadel:self-review`, opened by name from its SKILL.md; section numbers (1 to 5) are SKILL.md's.

## A feeder

**A feeder** (your base is `build/<n>`) is reviewed on the build's tip, not on the commit it started
from: bugs where feeders meet only show beside the other feeders' merged code (Peek Auras' Build 4
found 2 Must fix and 5 Should fix at those seams in the whole-build review, too late, after four
feeders had closed). Right before starting the review Grunts:

1. Run `git rebase build/<n>`. When it brought commits in (the facts' `BEHIND:` line lists them),
   re-run the tests you touched.
2. Every reviewer's brief gets the same two lines: the kit's reviewer and each of the scheme's own
   reviewing agents your diff triggers (the "Kit reviewers" line names them; Project facts or the
   agent's own description says which diffs each one is for). The lines are: the change is `git diff build/<n>...HEAD`, and "The other
   feeders' work this change now sits on: `git log --oneline --no-merges main..build/<n>`; check
   where this change meets their code." (That `main` stays main: it is what the build adds.)
3. Fix real findings in your branch (section 3) before you merge in. A finding in another feeder's code
   goes to the build minion (`message_minion`).

If `build/<n>` takes another feeder's merge before yours and that merge changes a file your diff
changes, rebase and run the scheme's own reviewing agents again on the new tip; not the rest. The
build minion's whole-build review at the end stays as it is.

## Codex second opinion

**Codex second opinion (light and deep):** when `citadel-codex-review --check` prints `ready`
(the turn's person has signed in to Codex in their container, or for the server login's host
turns, in its Codex container), Codex, a model from another family
on their own ChatGPT plan, reviews the same diff read-only. Start it in the background before the
reviewer (see "Side by side" below): `S=<kit>/skills/self-review/scripts/side-check.sh`, then a Bash
call with `run_in_background: true` running `$S codex citadel-codex-review --timeout 540 < "$TMPDIR/review-brief.md"`; the brief's `Follow` line points Codex at the reviewer's rules. Its findings join the
Grunt's: drop duplicates, and on a deep review the finding-checker checks them too. A non-zero
exit (a usage limit, a timeout, or exit 4: the person's Codex usage is past 80% or ahead of pace,
so it saves their plan) skips it: say so in the report line (`Codex: skipped: <why>`). Its last
stderr line, `Codex usage: 5-hour N%, weekly N%`, goes in the report line too. Anything else
`--check` prints means it isn't set up: skip it silently.

Codex reads whatever repo the command runs in, so a review run from a scratch clone sends that
diff to the person's plan too. That is by design; cost-check before running it on a throwaway diff.

## Tests against the base

**Tests against the base (light and deep):** when the diff adds or changes tests, run
`node <kit>/skills/self-review/scripts/base-check.ts` in the background before the reviewer (see
"Side by side" below): a Bash call with `run_in_background: true` running
`<kit>/skills/self-review/scripts/side-check.sh base-check node <kit>/skills/self-review/scripts/base-check.ts`. It runs each changed test file once, in a scratch worktree holding the base's code
and the branch's tests, and judges each new or changed case:

- `red`: it fails without the change, so it tests the change. A file that can't load or build on
  the base (it imports what the change adds) is red too.
- `PASSES ON BASE`: a finding for 3. A test that passes without the change pins what the code
  already does. Make it go red on the base by asserting what the change should do, or keep it
  and say why in the report: a refactor's safety net, or a regression guard for behaviour that
  already worked. It doesn't raise the label by itself.
- `skipped: <why>`: not checked (a stack it can't run, a missing tool, a timeout, a case the
  run's output never names, a new Rust test module). Say so in
  the report; a skip is no pass.

Leave it out for docs-only changes, UI changes the scheme proves by screenshot, and diffs that
touch no test. When the check command in Project facts runs one file in a way the helper can't
guess (a wrapper, an env var), pass it as `--cmd '<command with {file}>'`. Its `Result:` line
goes under the Risk line in 5.

## Side by side

The reviewer Grunt, Codex and the base check are independent, and Codex (about 6 to 8 minutes) and the
base check (about 9 to 11) each take as long as the reviewer, so run them together, not one after
another (#1818). Write `$TMPDIR/review-brief.md` first. Then, in one message and before the reviewer:

1. each check that applies, as its own Bash call with `run_in_background: true`, through
   `scripts/side-check.sh <name> <command...>`. It writes `$TMPDIR/side-checks/<name>.out`, `.err`,
   `.exit` and `.start` / `.end` (epoch seconds), so the output and exit status are kept;
2. the reviewer Grunt (and fresh eyes), foreground as usual.

When the reviewer returns, wait for each check: you get a notice when its background call exits, or
`citadel-wait file $TMPDIR/side-checks/<name>.exit` (Bash timeout 600000, repeated on exit 124). Then read its
`.out` and `.exit` (and `.err`, whose last line is Codex's usage line): the exit status means what
this file said above (non-zero Codex exit: skipped, say why; base-check's own `Result:` line goes under the
Risk line). A missing `.exit` after its call ended means the check was killed: say so, don't treat it as a pass.

## Fresh eyes

**Fresh eyes (medium or larger features only):** a feature that is not small gets a
`citadel:fresh-eyes` Grunt before you call it ready, in the same message as the reviewer
(`run_in_background: false`). It asks whether you built what the requester asked for, which the
reviewer doesn't. A run costs about $1 (its pinned Opus at high), so the cut is strict
(Josh, 2026-11-19: "Only on medium or larger features, not small ones"):

- **Runs** when the work is a feature (the minion's `type` property, or the kind the brief names) and it is not
  small. Medium is the size of the feature, not its risk label.
- **Small, so it skips:** touches three files or fewer (test and doc files not counted) and changes
  under about 150 lines (`git diff --stat main...HEAD`, all files), and adds no new screen, flow or table. Any one of those three broken
  makes it not small. A doubt means it runs.
- **Never runs** for bugs, chores, research, docs or art.
- **Off** when the turn's "Kit reviewers" line says fresh eyes is switched off: no Grunt.
- **Its own step:** it runs even when the pre-ship review is off (then start it alone, no reviewer to share a message with), and whether the retro is written yet doesn't matter.

Brief it as in the reviewer's brief (the Grunt line, branch, worktree, `<kit>`), with
`Follow <kit>/agents/fresh-eyes.md`, the requester's own words verbatim with their times (or the
path of a handoff that quotes them; never your summary of them), the diff `git diff main...HEAD`,
and the done lines if your first reply showed any. Hand it the spec or PR text only as the
agent's step 3 says. Its three lists (built but not asked, asked but not built, read
differently) are findings like the reviewer's: fix them or list them under "Not fixed" with a
reason. Record the run with `review_set` (slug `fresh-eyes`).
