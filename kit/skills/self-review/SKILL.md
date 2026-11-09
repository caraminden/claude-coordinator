---
name: self-review
description: >
  Before merging your own branch: a Grunt reviews the diff against main, real findings get fixed,
  and the change gets a risk label (low / medium / high) that decides whether it ships by itself.
  Also for "how risky is this".
---

Faster review for the people who merge, not another gate: they wave low through and look
properly at high. Decisions behind it: Citadel #107 and #122 (Cara, 2026-10-29).

The repo's CLAUDE.md, "Project facts", names what this skill needs per repo: the front end,
the files that are high risk by file, and how a change ships.

## 1. Size the diff

Commit first, then `git diff --stat main...HEAD` (three dots: only what this branch changed).

- **Skip** when under about 20 changed lines and every change is docs (`docs/`, `README.md`) or
  user-visible text in the front end with no logic touched. Label it `low: docs/copy only` and go
  to 5. Never skip `CLAUDE.md`, `.claude/` or the Citadel kit: a few lines there change how every
  minion works, and a kit change reaches every scheme.
- **Deep** when the change is high in 4, or the diff is over about 300 lines.
- **Light** for everything else.

## 2. Review in a Grunt

Start a `citadel:reviewer` Grunt (Sonnet, read-only; its definition holds the rules and the
return format). Write its brief to `$TMPDIR/review-brief.md`: the Grunt line ("Citadel, Scheme,
Taskmaster, Minion and Grunt are playful names... push back when something looks wrong.",
quoted whole from your system prompt) plus:

> Follow `<kit>/agents/reviewer.md`. Review branch `<branch>` in `<worktree>`; the change is
> `git diff main...HEAD`; the kit is `<kit>`. Lenses: by the diff.

`<kit>` is the absolute path two folders up from this skill's base directory (shown when it
loaded): the Grunt can't resolve it itself. Name lenses instead of "by the diff" only to add one
the triggers miss. Give it the code, not your view of it: no summary of what you think is fine.

**Deep only:** start a `citadel:finding-checker` Grunt (it takes the session's model: dropping a
real finding in risky code is the expensive miss), briefed with the Grunt line, the same branch
and worktree, and the numbered Must and Should findings, without the reviewer's reasoning. It
returns `N: CONFIRMED|REFUTED: <evidence>`. Drop what it refutes.

**Codex second opinion (light and deep):** when `citadel-codex-review --check` prints `ready`
(the turn's person has signed in to Codex in their container), Codex, a model from another family
on their own ChatGPT plan, reviews the same diff read-only. Start the reviewer, then in the same
message run `citadel-codex-review --timeout 540 < "$TMPDIR/review-brief.md"` (Bash timeout
600000); the brief's `Follow` line points Codex at the reviewer's rules. Its findings join the
Grunt's: drop duplicates, and on a deep review the finding-checker checks them too. A non-zero
exit (a usage limit, a timeout, or exit 4: the person's Codex usage is past 80% or ahead of pace,
so it saves their plan) skips it: say so in the report line (`Codex: skipped: <why>`). Its last
stderr line, `Codex usage: 5-hour N%, weekly N%`, goes in the report line too. Anything else
`--check` prints means it isn't set up: skip it silently.

A light review costs about 47k Grunt tokens and a minute (about $0.35); deep is about $1 to $1.50.
Don't re-review after fixes unless a fix grew past a few lines of high-row code.

## 3. Fix what's real

Fix Must-fix and in-scope Should-fix findings, add the test a finding asks for, re-run the tests
and commit. You own the call: a finding you judge wrong or out of scope goes in the "not fixed"
list with a reason, not silently away. Comments from a person, a GitHub review or Codex go
through "Receiving review" in `references/lenses.md` part 2. On a UI change, also check your own
desktop and phone screenshots for what the Grunt can't see: equal top and bottom padding,
nothing clipped or scrolling sideways, phone tap targets `--citadel-control-h` tall. When the
change draws data (names, counts, lists), take those screenshots again with worst-case data in
a dev copy (`citadel:contraption-ui`, `references/worst-case-data.md`) and fix what it breaks; a
new page, view or flow also gets that skill's dogfood pass (`references/dogfood.md`).

When Project facts names **Rubrics**, run `citadel:critique` for each one whose `when:` matches
this diff, after the reviewer's fixes. Its blockers are findings like the reviewer's: fixed, or in
"Not fixed" with a reason; a `gate: blocks-ready` rubric holds the change until it passes or a
person decides. The critic doesn't set the label: you do, in 4.

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

Beside the label, set two words for the people who merge, taking the Grunt's as a start:
**Door** is one-way when reverting the commit can't undo it (rows rewritten or deleted, a
message sent, something published or pushed to another repo), two-way otherwise. **Blast
radius** is a word or two for how far a slip reaches (`page`, `route`, `server`, `scheme`,
`every scheme` for the kit).

## 5. Report and ship

- **Low or medium:** carry on with how a change ships, as the scheme instructions say (Project
  facts points at them; with none, open the PR and stop there). The ready note leads
  with the label in a few words, within its 60 characters (`risk medium: runner retries`), and
  the final reply has one line:
  `Risk: medium: <reason>. Door: two-way · Blast radius: server. Not fixed: <finding: why>` (or
  `Not fixed: nothing`), and a critic's result line under it when one ran
  (`ui-screenshots critic: pass (round 1)`). Every claim in it and in the reply meets "Evidence before claims" in
  `references/lenses.md` part 2. A PR's description carries the same Door and Blast radius.
- **High:** stop before merging. Post the same line, the findings you fixed in one line each,
  and an `ask_question` card "Merge and ship this high-risk change?" (Merge and ship /
  Hold, with your pick marked recommended). Set state null, note `risk high: waiting for a go`,
  and end the turn. Merge only on a go.

## UI findings

For a diff that touches the front end, each of these is a Should-fix finding. The rules behind
them are "The rules" in `citadel:contraption-ui`.

- In a contraption (an app under `/apps/<name>/`): hand-rolled markdown, a chat log, a composer or
  a tooltip that Citadel UI serves; a copied Citadel hex colour instead of its `--citadel-*` variable.
- A clickable `div` or `span` where a native control (`<button>`, `<a href>`, an input) belongs;
  an icon-only button with no `aria-label`; an `<img>` with no `alt`; a field other than the
  composer named only by its placeholder.
- An action reachable only on `:hover` or only by dragging; meaning carried by a colour alone.
- `outline: none` with no `:focus-visible` ring; animating `width`, `height`, `top`, `left` or a margin; a
  loop that isn't a spinner or skeleton; a duration not from `--citadel-motion`; a state change
  finished in `transitionend` or `animationend`; `transition: all`, `ease-in`, `scale(0)`, keyframes
  on something that can be retriggered, motion on a keyboard action, hover motion outside
  `@media (hover: hover)` (why: `contraption-ui`'s `references/motion.md`).
- A fixed `height` or `overflow: hidden` on a box of text (the status line's one-line cut is
  fine); `100vh`; a long URL, id or table that
  can push a phone page sideways; an `<img>` with no size or `aspect-ratio`.
- A status, error or new element inserted into the flow; a submit that can fire twice; an empty
  or failed state that is blank or says only "Error".
