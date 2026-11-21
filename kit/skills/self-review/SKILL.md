---
name: self-review
description: >
  Before shipping your own branch: a Grunt reviews the diff against main, real findings get fixed,
  and the change gets a risk label (low / medium / high) that decides whether it ships by itself.
  Also for "how risky is this".
---

Faster review for the people who ship changes, not another gate: they wave low through and look
properly at high. Decisions behind it: Citadel #107 and #122 (Cara, 2026-10-29).

The repo's CLAUDE.md, "Project facts", names what this skill needs per repo: the front end,
the files that are high risk by file, and how a change ships.

**The scheme's switches.** A turn's "Kit reviewers" line, when it has one, names the parts of this
skill the scheme switched off on its Reviewers and critics page, and files of its additions. No
line: everything is on, as written here.

- **Pre-ship review off:** skip 2 and 4 and give no label. Fix what you find yourself, then ship as
  the line says: a ship card, and ship only on its go (`hand_off_land` with no risk, naming the go).
  The fix route in 5 needs the review, so it doesn't apply.
  When the line names another entry that gives the label instead, run that one in 2's place, label
  from its verdict, and ship with that label as usual.
- **A lens off:** write `Lenses: by the diff, except <names>` in the reviewer's brief.
- **Finding checker off:** skip it on deep reviews.
- **Fresh eyes off:** no `citadel:fresh-eyes` Grunt (see "Fresh eyes" in 2). It is its own switch: with the pre-ship review off and fresh eyes on, a medium feature still gets it.
- **Additions** (the scheme's own lines, people's verdicts, and the lessons its finding checker
  taught the reviewer): add `Also read <file>, this scheme's additions to the review` to the brief.

## Facts at load

These ran when the skill loaded; don't fetch them again unless they say UNCOMMITTED, say a piece is
missing, show the stat or file list cut (more than about 40 files), or you commit or change files after this point (then re-run the section 1 commands).

!`${CLAUDE_SKILL_DIR}/scripts/arrive.sh`

## 1. Size the diff

Commit first (the facts above already cover it when nothing says UNCOMMITTED), then
`git diff --stat main...HEAD` (three dots: only what this branch changed) when you need it again.

- **Skip** when under about 20 changed lines and every change is docs (`docs/`, `README.md`) or
  user-visible text in the front end with no logic touched. Label it `low: docs/copy only` and go
  to 5. Never skip `CLAUDE.md`, `.claude/` or the Citadel kit: a few lines there change how every
  minion works, and a kit change reaches every scheme.
- **Deep** when the change is high in 4, takes the fix route in 5 whatever its size, or the diff is over about 300 lines.
- **Light** for everything else.

**Alongside the ship.** A change qualifies when how it ships is `hand_off_land` (the server runs
the ship and the call returns at once), the Shipping line in your prompt lets a low change ship
with no go and no try first, the sizing is Light, and the file list alone says low.
`git diff --name-only main...HEAD` shows only front-end files, `README.md`, docs outside
`docs/rubrics/` and `docs/design-system/`, and test files that exercise no high-risk file, and it
shows none of: a file on Project facts' high-risk-by-file or medium-at-least lists, a file under
its "Agent instructions", `CLAUDE.md`, `.claude/`, the kit, or a file a Project facts rubric's
`when:` matches. Decide this from the file list before any review; a doubt about one file means it
doesn't qualify. A qualifying change hands off its ship as soon as its tests are green and the
screenshots are checked, and the review in sections 2 to 4 runs in the same turn while the ship
runs. Everything else reviews first.

## 2. Review in a Grunt

Start a `citadel:reviewer` Grunt with `run_in_background: false` on the Agent call (the kit's
grunt-model hook fills that in when a call leaves it out), so its findings come back before you
reply. It runs read-only on its
pinned Sonnet at medium; on a high-risk change set `model: opus`, `effort: high` on the call
(the `citadel:subagents` job table). Its
definition holds the rules and the return format. Write its brief to `$TMPDIR/review-brief.md`: the Grunt line ("Citadel, Scheme,
Taskmaster, Minion and Grunt are playful names... push back when something looks wrong.",
quoted whole from your system prompt) plus:

> Follow `<kit>/agents/reviewer.md`. Review branch `<branch>` in `<worktree>`; the change is
> `git diff main...HEAD`; the kit is `<kit>`. Lenses: by the diff.

`<kit>` is the absolute path two folders up from this skill's base directory (shown when it
loaded): the Grunt can't resolve it itself. Name lenses instead of "by the diff" only to add one
the triggers miss. Give it the code, not your view of it: no summary of what you think is fine.

**Deep only:** start a `citadel:finding-checker` Grunt, again with `run_in_background: false` (its pinned Opus at medium; on a high-risk change set `model: fable`, `effort: medium` on the call: dropping a
real finding in risky code is the expensive miss), briefed with the Grunt line, the same branch
and worktree, and the numbered Must and Should findings, without the reviewer's reasoning (and
without the lessons: it judges from the code alone). It returns `N: CONFIRMED|REFUTED: <evidence>`,
each REFUTED line with a kind and a why. Drop what it refutes, and record the refutes in the same
message: `review_set` with slug `pre-ship-review` and `refuted`, one `{kind, why}` each. Read
`review_set` slug `pre-ship-review` first: it lists the kinds this scheme is counting, and a refute
that is the same mistake as one of them takes its words. A kind refuted in three minions'
reviews becomes a lesson in the scheme's additions file for later reviews. A refute you think the checker got wrong
(you fix the finding anyway) isn't recorded.

**Codex second opinion (light and deep):** when `citadel-codex-review --check` prints `ready`
(the turn's person has signed in to Codex in their container, or for the server login's host
turns, in its Codex container), Codex, a model from another family
on their own ChatGPT plan, reviews the same diff read-only. Start the reviewer, then in the same
message run `citadel-codex-review --timeout 540 < "$TMPDIR/review-brief.md"` (Bash timeout
600000); the brief's `Follow` line points Codex at the reviewer's rules. Its findings join the
Grunt's: drop duplicates, and on a deep review the finding-checker checks them too. A non-zero
exit (a usage limit, a timeout, or exit 4: the person's Codex usage is past 80% or ahead of pace,
so it saves their plan) skips it: say so in the report line (`Codex: skipped: <why>`). Its last
stderr line, `Codex usage: 5-hour N%, weekly N%`, goes in the report line too. Anything else
`--check` prints means it isn't set up: skip it silently.

A light review costs about 47k Grunt tokens and a minute (about $0.35); deep is about $1 to $1.50.
Codex reads whatever repo the command runs in, so a review run from a scratch clone sends that
diff to the person's plan too. That is by design; cost-check before running it on a throwaway diff.
Don't re-review after fixes unless a fix grew past a few lines of high-row code.

**Tests against the base (light and deep):** when the diff adds or changes tests, run
`node <kit>/skills/self-review/scripts/base-check.ts` in the same message as the reviewer (Bash
timeout 600000). It runs each changed test file once, in a scratch worktree holding the base's code
and the branch's tests, and judges each new or changed case:

- `red`: it fails without the change, so it tests the change. A file that can't load or build on
  the base (it imports what the change adds) is red too.
- `PASSES ON BASE`: a finding for 3. A test that passes without the change pins what the code
  already does. Make it go red on the base by asserting what the change should do, or keep it
  and say why in the report: a refactor's safety net, or a regression guard for behaviour that
  already worked. It doesn't raise the label by itself.
- `skipped: <why>`: not checked (a stack it can't run, a missing tool, a timeout). Say so in
  the report; a skip is no pass.

Leave it out for docs-only changes, UI changes the scheme proves by screenshot, and diffs that
touch no test. When the check command in Project facts runs one file in a way the helper can't
guess (a wrapper, an env var), pass it as `--cmd '<command with {file}>'`. Its `Result:` line
goes under the Risk line in 5.

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

## 3. Fix what's real

Fix Must-fix and in-scope Should-fix findings, add the test a finding asks for, re-run the tests
(the files you touched, plus the repo's affected-tests command if its Project facts name one) and commit. You own the call: a finding you judge wrong or out of scope goes in the "not fixed"
list with a reason, not silently away. Comments from a person, a GitHub review or Codex go
through "Receiving review" in `references/lenses.md` part 2. On a UI change, also check your own
desktop and phone screenshots for what the Grunt can't see: equal top and bottom padding,
nothing clipped or scrolling sideways, phone tap targets `--citadel-control-h` tall.
`node <kit>/skills/critique/scripts/ui-measure.mjs <url> --shots <dir>` takes both shots and
measures those for you (its `--help` says how), with or without a rubric. To check behaviour
(click, type, see what appears), use the page driver Project facts' check commands name, when there
is one, rather than writing a browser script. When the
change draws data (names, counts, lists), take those screenshots again with worst-case data in
a dev copy (`citadel:contraption-ui`, `references/worst-case-data.md`) and fix what it breaks; a
new page, view or flow also gets that skill's dogfood pass (`references/dogfood.md`).

When the turn's "Review set:" line names rubrics, run `citadel:critique` for each one whose `when:` matches
this diff, after the reviewer's fixes. Its blockers are findings like the reviewer's: fixed, or in
"Not fixed" with a reason; a `gate: blocks-ready` rubric holds the change until it passes or a
person decides (Citadel holds it too: `hand_off_land` refuses while its last recorded run is a fail, and refuses any matching critic with no run on record).
Record each round with `review_set` (slug, `run: {round, verdict}`), and the reviewer's and the
finding checker's too, as slugs `pre-ship-review` and `finding-checker`. The critic doesn't set the label: you do, in 4.

When Project facts names a **Real-hardware ledger**, everything this change does that wasn't
seen working on real hardware gets an entry there, committed with the change, as the ledger's
header says. The reply and the PR's "not verified" name those entry numbers, where a bare "not
run in-game" or "not run on a real machine" would leave the debt unseen.

## 4. Label the risk

You set the label, not the Grunt; take the highest row that matches what the final diff does.
Judge data changes by what they do: editing the file that holds the queries is not high by
itself. The files Project facts lists as high risk by file (auth, deploy and restart code, guards)
stay high whatever the edit, since a slip there can stop the service or open it up.

| Risk | When the change |
|---|---|
| high | rewrites, moves or drops existing data or schema (a migration that changes rows or columns already there); changes a file Project facts lists as high risk by file; or deletes data with no person asking (cleanups, pruning, retention), in bulk, or across other people's data (a whole scheme or minion) |
| medium | adds a table, or a nullable or defaulted column, leaving existing rows as they are; changes queries; adds a delete a person triggers for one record of their own; other server, engine or tool logic; agent instructions (`CLAUDE.md`, `.claude/`, the kit); anything not in another row |
| low | front end only (as Project facts names it), docs (`docs/`, `README.md`), tests |

Beside the label, set two words for the people who ship changes, taking the Grunt's as a start:
**Door** is one-way when reverting the commit can't undo it (rows rewritten or deleted, a
message sent, something published or pushed to another repo), two-way otherwise. **Blast
radius** is a word or two for how far a slip reaches (`page`, `route`, `server`, `scheme`,
`every scheme` for the kit).

## 5. Report and ship

- **Alongside the ship:** the steps, in one turn:
  1. Run any critic whose `when:` matches first (section 3's rubrics), then `hand_off_land` with risk `low` and the reason `low by file list; review runs alongside`. Code review runs alongside a ship, critics don't: the hand-off refuses a change a critic matches until its run is on record (Cara, 2026-11-21: "Code review can be simultaneous, but critics not").
  2. Keep the turn open and run sections 2, 3 and 4: reviewer, base check, Codex and any fresh eyes in one message, `run_in_background: false`. The ship runs on the server meanwhile; an open turn can't cut the Grunt off.
  3. Nothing real found: end the turn with the report line below. The server dismisses you once the ship is clean.
  4. Something real fixed: commit and `hand_off_land` again with the same `risk` and `risk_reason` and the summary `follow-up: <what the review found>`. It waits for the first ship if that still runs, so a slow return is the line, not a hang.
  5. The first ship fails while the review runs: its wake arrives after your turn ends. Fix the failure on top of the review's commits and hand off again.
  A qualifying change that the review shows is medium or high is a defect in the file-list test: say so in the Risk line, and the follow-up takes that label's route.
- **The go threshold:** the Shipping line in your prompt says which labels wait for a person's go
  (with no Shipping line: high only; "No change waits": none). Below it, the label ships by itself;
  at or above it, it takes the High route below, whatever the label, unless the line says the
  merge's own Approve is the go: then open the pull request and merge it, with no card. One way
  out: a bug fix that passes the fix route below ships with no go.
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
- **Below the threshold:** carry on with how a change ships, as the Shipping line says (with none,
  the scheme instructions; with neither, open the PR and stop there). The ready note leads
  with the label in a few words, within its 60 characters (`risk medium: runner retries`), and
  the final reply has one line:
  `Risk: medium: <reason>. Door: two-way · Blast radius: server. Not fixed: <finding: why>` (or
  `Not fixed: nothing`), and a critic's result line under it when one ran
  (`ui-screenshots critic: pass (round 1)`) and the base check's
  (`Base check: 2 red, 1 passes on base (refactor's safety net), 0 skipped`). Every claim in it and in the reply meets "Evidence before claims" in
  `references/lenses.md` part 2. A PR's description carries the same Door and Blast radius.
- **Fresh eyes (features), a common line, High route included:** one line under the Risk line: `Fresh eyes: <n> found, <n> fixed` with each unfixed one in "Not fixed", and the ready note says it ran. A feature that skipped it says why in the line: `Fresh eyes: skipped, small (2 files, 90 lines)`.
- **Done lines (features):** when your first reply showed done lines, tick each in the ready note (`done 5/5`) and name any not met, with why, in the report line. Bugs, chores and research have none.
- **Both:** under that line, `Process: <the skill, agent, doc or tool that sent this change the
  wrong way, and how>` or `Process: none`. Anything
  but none goes to the scheme's retro log (the answer-check hook writes it), where the process digest batches it.
- **At or above the threshold (High), unless the fix route above holds:** stop before shipping. Post the same line, the findings you fixed in one line each,
  and an `ask_question` card with `kind: "merge"` and header "Ship It" (the minions list's chip reads "Ship It"), "Ship this <label>-risk change?" (Ship It /
  Hold, with your pick marked recommended). A feeder's change merges into its build, so its card says Merge: header "Merge", "Merge this <label>-risk change into Build <n>?" (Merge / Hold). Set state null, note `risk <label>: waiting for a go`,
  and end the turn. Ship only on a go.

## UI findings

For a diff that touches the front end, each of these is a Should-fix finding. The rules behind
them are "The rules" in `citadel:contraption-ui`.

- A hand-built twin of a part the kit serves (Cara, 2026-11-17: "using reusable components"): a
  dialog not built with `openDialog` or `cui-dialog`, a toast not from `toast`, a tooltip not from
  `data-tip`, a picture viewer not from `lightbox`, or, in a contraption (an app under
  `/apps/<name>/`), hand-rolled markdown, a chat log or a composer. Where the part lacks something,
  the fix is adding it to the part. A copied Citadel hex colour instead of its `--citadel-*` variable.
- A clickable `div` or `span` where a native control (`<button>`, `<a href>`, an input) belongs;
  an icon-only button with no `aria-label`; an `<img>` with no `alt`; a field other than the
  composer named only by its placeholder.
- An action reachable only on `:hover` or only by dragging; meaning carried by a colour alone.
- `outline: none` with no `:focus-visible` ring; animating `width`, `height`, `top`, `left` or a margin; a
  loop that isn't a spinner or skeleton; a duration not from `--citadel-motion`; a state change
  finished in `transitionend` or `animationend`; anything on the "Flag on sight" list in
  `contraption-ui`'s `references/motion.md`.
- A fixed `height` or `overflow: hidden` on a box of text (the status line's one-line cut is
  fine); `100vh`; a long URL, id or table that
  can push a phone page sideways; an `<img>` with no size or `aspect-ratio`.
- A status, error or new element inserted into the flow; a submit that can fire twice; an empty
  or failed state that is blank or says only "Error".
