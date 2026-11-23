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
- **Fresh eyes off:** no `citadel:fresh-eyes` Grunt (`references/review-extras.md`, "Fresh eyes"). It is its own switch: with the pre-ship review off and fresh eyes on, a medium feature still gets it.
- **Additions** (the scheme's own lines, people's verdicts, and the lessons its finding checker
  taught the reviewer): add `Also read <file>, this scheme's additions to the review` to the brief.

## Facts at load

These ran when the skill loaded; don't fetch them again unless they say UNCOMMITTED, say a piece is
missing, show the stat or file list cut (more than about 40 files), name a base other than the one you build on (a feeder's base is `build/<n>`; run `${CLAUDE_SKILL_DIR}/scripts/arrive.sh build/<n>`), or you commit or change files after this point (then re-run the section 1 commands).

!`${CLAUDE_SKILL_DIR}/scripts/arrive.sh`

## 1. Size the diff

Commit first (the facts above already cover it when nothing says UNCOMMITTED), then
`git diff --stat main...HEAD` (three dots: only what this branch changed) when you need it again.
Before your final test run, rebase onto your base once (the one "take a newer base at the end" step): then the tests you ran saw the files other ships added, which is what the ship's CI sees.

- **Skip** when under about 20 changed lines and every change is docs (`docs/`, `README.md`) or
  user-visible text in the front end with no logic touched. Label it `low: docs/copy only` and go
  to 5. Never skip `CLAUDE.md`, `.claude/` or the Citadel kit: a few lines there change how every
  minion works, and a kit change reaches every scheme.
- **Deep** when the change is high in 4, takes the fix route in 5 whatever its size, or the diff is over about 300 lines.
- **Light** for everything else.

**Critics run before any `hand_off_land`, low-first path included.** A diff that matches a critic's `when:` (any `public/` file: `ui-screenshots`, even a timing-only change the shots can't show) is refused until that critic's run is on record: run `citadel:critique` with the rubric from your turn's review-set folder, then `review_set` with `run: {round, verdict}`.

**Alongside the ship.** When how it ships is `hand_off_land` and the file list alone may say low,
open `references/ship.md`, "Alongside the ship": it says which changes hand off their ship before
the review and run sections 2 to 4 while it runs. Decide it from the file list before any review.
Everything else reviews first.

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

**Open `references/review-extras.md` when one applies:**
- **A feeder** (your base is `build/<n>`): reviewed on the build's tip, with two more brief lines.
- **Codex second opinion (light and deep):** run `citadel-codex-review --check` on every light or deep review; open it when that prints `ready`.
- **Tests against the base (light and deep):** when the diff adds or changes tests.
- **Fresh eyes:** any feature (the minion's `type`, or the kind the brief names), even with the pre-ship review off: the reference says which are small enough to skip.


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

A light review costs about 47k Grunt tokens and a minute (about $0.35); deep is about $1 to $1.50.
Don't re-review after fixes unless a fix grew past a few lines of high-row code.

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
One exception: the section 1 facts print `SHIP SCRIPT SYNC` when the diff's only touch of `tools/land.sh` or
`tools/land.local.sh` leaves it byte-identical to the kit's template (`scheme-setup/templates/`): that sync is medium.
`SHIP SCRIPT EDIT`, or any other high-by-file file in the diff, stays high.

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

- **Alongside the ship:** the steps are in `references/ship.md`, "Alongside the ship".
- **A live probe** (`hand_off_land` to main, 600+ changed lines; #1741): pick the one check that would show
  this change broken once live, e.g. `{kind:"timing", path:"/api/x", ms:800}` for a speed fix, `{kind:"sql",
  query:"SELECT count(*) FROM ...", min:1}` for a new writer, `{kind:"http", path, text}` for a route or the data
  a screen reads (an app's paths are `/apps/<name>/...`). Nothing live can show it (a prompt, a PC build)?
  `{kind:"none", reason}`. It's asked only when something of the scheme is served by Citadel (Citadel itself, or a
  scheme whose apps it deploys), and `sql` reads Citadel's own database, so only Citadel's ships use it. Its refusal
  lists the shapes; a fail wakes you after the ship.
- **The go threshold:** the Shipping line in your prompt says which labels wait for a person's go
  (with no Shipping line: high only; "No change waits": none). Below it, the label ships by itself;
  at or above it, it takes the High route (`references/ship.md`), whatever the label, unless the line says the
  merge's own Approve is the go: then open the pull request and merge it, with no card. One way
  out: a bug fix that passes the fix route (`references/ship.md`) ships with no go.
- **The fix route:** at or above the threshold, a bug fix with a recorded red-then-green test, a clean
  deep review, no data or auth change and a plain revert can ship with no go. When your minion's
  `type` is bug, open `references/ship.md`, "The fix route", for the four conditions and `fix_proof`.
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
- **At or above the threshold (High), unless the fix route holds:** stop before shipping. The card
  and the steps are in `references/ship.md`, "The High route". Ship only on a go.

## UI findings

When the diff touches a front end, open `references/ui-checks.md`: the UI checks for every front
end and the web front-end findings, each break a Should-fix finding.
