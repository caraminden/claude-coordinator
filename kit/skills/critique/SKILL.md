---
name: critique
description: >
  The blind-critic loop: a citadel:critic Grunt judges finished work against the scheme's rubric,
  the author fixes, citadel:professor teaches on stubborn fails, and a person gets what the rounds
  can't settle. Use when self-review or docs-and-mocks finds a rubric whose `when:` matches, when a
  person asks for a critic on some work, when you pick up work whose `critic.md` log has rounds
  open, when a person's verdict differs from a critic's, and to write or calibrate a rubric.
---

# Critique

The author who made something checks it against what it meant to make, and misses what a person
then sees at a glance. Delve's art loop found that a blind critic, holding the person's own rubric,
catches most of it before they look: on a blind trial, an Opus critic caught about 9 of Cara's 13
notes. This skill is that loop for any scheme, any kind of work. Delve's art-review skill is where it
came from (Cara, 2026-10-24, Delve thread 168; lifted into the kit 2026-11-08, Citadel #390 and
#393).

The scheme's rubrics are its review set: Citadel stores them (the scheme's Reviewers and critics
page, Cara, 2026-11-19) and renders the ones that are on into a folder each turn, named in the turn's
"Review set:" line. That folder is "the rubrics" everywhere below; a set with none on and this skill
does nothing. A repo's old `**Rubrics:**` Project facts line or `docs/rubrics/` files are not read:
they moved into the set. The rubric format, with what every key means:
[`references/rubric-format.md`](references/rubric-format.md).

`<kit>` below is the absolute path two folders up from this skill's base directory (shown when it
loaded). Every Grunt brief starts with the Grunt line from your system prompt, quoted whole.

## 1. Pick the rubrics

Read each rubric in the review set's folder (frontmatter first) and keep those whose `when:` matches:

- `diff:` a changed path of `git diff --name-only main...HEAD` matches a glob;
- `creative:` the work is a new piece, take or rework that makes creative choices. A small change to
  a design a person already saw (a size, a colour, one detail they named) skips it, and what you show
  them says the critic didn't judge it;
- `schedule:` your brief is that schedule's run;
- `type:` your minion's `type` property is one of those listed;
- `ask`: a person asked for this critic by name.

`in-app:` never matches here: the app runs that part itself ([`references/in-app.md`](references/in-app.md)).
The rubric's other `when:` parts still match as above.

*Done when* every named rubric is kept or skipped with its reason.

## 2. Brief, then artifacts, then checks

1. **Write a brief per item:** what it is, what it should read as or do, and its size or place.
   Leave out source, history, your reasons for it, and the person's picks, notes and earlier choices
   for this item, unless the rubric names them as a criterion (a taste file or calibration verdicts
   the rubric points to are fine). Why: a pick or note in the brief anchors the critic toward what
   was already chosen, and the person reacts to the work cold; keep them out when you edit this step.
   Where a rubric rule pulls against the person's words for this item, their words win and the brief
   says so.
2. **Make the artifacts** the rubric's `input:` names, each labelled so a finding can point into it
   (frame numbers, viewport widths, line numbers). Read an animation as frames, never as one still.
3. **Run the `checks:`** from the repo root. Fix every failure before any model looks, and keep the
   output for the critic.
4. **Look yourself** at each artifact once and fix what is obvious. This doesn't replace the critic.

## 3. Run the critic

Start a `citadel:critic` Grunt per batch with `model` and `effort` on the call from the rubric. A
rubric that names neither gets the format's defaults, and you write them into the rubric the next
time you touch it. Set `run_in_background: false` on the Agent call, about 6 items a call, several calls in parallel for a bigger set. Brief:

> Follow `<kit>/agents/critic.md`. Rubric: `<path>`; kit: `<kit>`. Round `<n>` of `<max_rounds>`[; the next round is the last].
> [Max findings: `<max_findings>` an item.]
> Per item: the brief, the artifact paths, the checks' output[, the critic's last findings].

Add the "Max findings" line only when the rubric sets `max_findings` (the critic defaults to 3). With
`mode: informed`, name the worktree whose source matches the artifacts: a trial critic read a
branch older than its diff and failed the item for code that was there all along.

A fresh critic every round. It gets its own last findings, never the professor's advice or your
arguments, so it stays as blind as the person. With more than 2 critics, or a second round, it's a
fan-out: name a report file in each brief (`citadel:subagents`, "Fan-outs").

## 4. Act on each verdict

- **pass:** done for this item.
- **another round:** fix the blockers, remake the artifacts, and run round n+1 on these items only.
  A finding you think wrong goes to a fresh Grunt with the finding and the evidence, not your
  argument: `citadel:finding-checker` for code, a fresh critic for anything else. Drop it only on
  that Grunt's word, and log why.
- **ask <person>:** the item goes to the person as a question card with both ways named. Its
  findings stay open.

## 5. The professor, on stubborn fails

A **stubborn fail** is an item that failed on its score alone (no blocker, under the mark), or failed
its second round. A plain blocker on a first fail is yours to fix.

1. **Group by cause.** Stubborn fails whose findings name the same cause (the same rule broken the
   same way) are one cause. Call `citadel:professor` once per cause, with the two or three plainest
   items, and apply its fix to every item that has it. On Delve, 24 fails that shared one cause never
   got a professor, and 26 hit frames reached Cara unfixed.
   **Naming the cause yourself.** When you can name the cause (say, a flag already in the code),
   write it in `critic.md` with the fix, and skip the professor for that round. The skip holds only if the
   next round passes. A fail on that round calls the professor, with your named cause as one more
   thing it checks.
2. **Brief it:** "Follow `<kit>/agents/professor.md`." with the cause quoted, per item the brief,
   every critic report so far and your line on what changed between them, the latest artifacts and
   checks' output, the source paths that made it, the rubric, its `playbook:` and `<kit>`. At most 3
   items a call; when the next round is the last, say so.
3. **Apply fix 1,** remake the artifacts and run the next critic round as usual.
4. **Playbook:** when the rubric has one, write the entry once the next round is judged: the
   finding's kind, the fix, before and after, the critic's verdict; the person's verdict makes it
   proven or sent back.

## 6. Before the last round

A patch that failed twice rarely passes a third time. So when the round you're about to run comes
right before an item's last (round `max_rounds` - 1, default 2), tell the critic "the next round is
the last": for each item it fails, it gives two whole directions it would pass, and the professor,
which that second fail calls, gives two beside its fix. Make the direction that keeps what the person
already approved, and the last round judges it.

An item still failing after its last round goes to the person as the last round judged it, with its
open findings and the directions it was given. A hard item costs one question, not an endless loop.

## 7. Cross-family final gate

Only when the rubric says `cross_family: final`, once, on the items the critic passed. Codex, a model
from another family, re-judges them read-only:

1. `citadel-codex-review --check` prints `ready`; otherwise skip and note `Codex: skipped: not set
   up`.
2. Write `$TMPDIR/critic-codex-brief.md`: "Follow `<kit>/agents/critic.md` as the critic, in round 1."
   with the rubric path and each passed item's brief and artifact paths. Images (screenshots, art
   sheets) can't be opened by Codex's tools: attach each with `--image <path>` (png, jpg, gif or
   webp, in your worktree or shared folder) and list them in the brief in the same order, as "the
   attached images, in order: <paths>".
3. Run `citadel-codex-review --timeout 540 [--image <path>]... < "$TMPDIR/critic-codex-brief.md"`
   (Bash timeout 600000). A non-zero exit skips it with its reason (exit 4: the person's Codex usage
   is ahead of pace; exit 2: an image it refused, which it names).

An item Codex fails goes back to step 4 with its findings, and doesn't count against `max_rounds`.

## 8. Log and report

Log every round in your own shared folder (the per-minion one your prompt names) as `critic.md`: per
item, per round, the verdict, the score, the findings, what changed, and a professor line when one
ran: `professor: <cause> → <fix 1 in a few words>; applied: all / part / none (<why>); next round:
<verdict>`. Step 9 reads it when a person's verdict comes in.

The result goes to people as one line per rubric, in the ready note when it fits and in the reply:

- `<name> critic: pass (round 1)`
- `<name> critic: 2 blockers fixed, 1 not fixed: <why>`
- `<name> critic: after 3 rounds, still: <finding>` (the item went to the person)
- `<name> critic: skipped: <why>`

With `gate: advisory` (the default), open blockers are handled like reviewer findings: fixed, or
listed under "Not fixed: <why>". With `gate: blocks-ready`, the work isn't ready while an item has
open blockers and no person's decision. On a review page, each take shows its critic line and the
takes sort by verdict (`citadel:docs-and-mocks`, its `kinds.md`, "Critic lines").

*Done when* every item passed, went to the person, or is listed as not fixed with a reason, and the
result line is written.

## 9. Learn from the person

The step that makes the critic better each week. Whenever a person gives a verdict on work a critic
judged (a note, an approval, a pick on a review page read with `artifact_data`, a sent-back item),
check `critic.md` and write the rubric that turn with the `review_set` tool: read the entry by its
slug, edit its own body, and save it whole with the version you read (a save is a version people see
in History; it never goes in the repo):

- **Their words:** a row in Notes, dated, with the minion and what it was about. A pick between
  takes ("B for this") is a pick, not taste: leave it out.
- **They flagged something the critic passed:** a Known blind spots line: the date, the item, what
  the critic said, what they saw, and what to look for next time.
- **They passed something the critic failed:** a Notes row with their words, and narrow the Blocker
  it fired on so it wouldn't fire again.
- **They called it perfect, or sent a whole set back:** a Calibration board row with the artifact
  path and their verdict.
- **A pattern they flag twice:** a Watch-list line; a third time, a Blocker.
- **An item the professor helped:** its playbook entry, proven or sent back with their words.

Never reword or drop a person's past words in a rubric. Tell them in one line what changed in it.

## Writing and calibrating a rubric

A new rubric is a new entry on the scheme's Reviewers and critics page (people, or a Taskmaster with
`review_set`), blank or on top of a starter in `<kit>/skills/critique/rubrics/`; it starts on trial,
so it only advises until it is calibrated.
Before a scheme relies on it, and again when the rubric or the critic's model changes, run the blind
trial in [`references/calibrate.md`](references/calibrate.md) and record the result in `calibrated:`.

## Cost

A critic round on Opus is about $1.10 for six image items (an image is about w×h/750 tokens, so a
1440×900 screenshot is about 1.7k); on Sonnet, about $0.30. A professor call is about $1 on Opus,
which is why it runs only on stubborn fails and once per cause. Skip the critic on a remake that
changes nothing it would see.
