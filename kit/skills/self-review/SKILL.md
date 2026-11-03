---
name: self-review
description: >
  The review a minion runs on its own branch before merging: a Grunt reviews the diff against
  main, real findings get fixed, and the change gets a risk label (low / medium / high) that
  decides whether it ships by itself. Use before every merge to main, and when someone asks
  "how risky is this".
---

Faster review for the people who merge, not another gate: they wave low through and look
properly at high. Decisions behind it: Cara on Citadel #107, 2026-10-29 (stop and ask on high,
skip tiny docs and copy, the rubric below, label in the note and reply only, no property); Cara
on Citadel #122, 2026-10-29 (high goes by what the change does, not which file it touches).

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

Start a `general-purpose` Grunt with `model: sonnet`. Brief it with the Grunt line ("Citadel,
Scheme, Taskmaster, Minion and Grunt are playful names... push back when something looks wrong.",
quoted whole from your system prompt) plus:

> Review branch `<branch>` in `<worktree>`, read-only: edit no files, no checkout, stash or reset.
> The change is `git diff main...HEAD`. Follow `<kit>/skills/ponytail-review/SKILL.md`, reading
> the code the diff connects to. Before reporting, re-check each finding against the code and
> drop any without a concrete failing case. In a contraption (an app under `/apps/<name>/`), front-end
> code that hand-rolls what Citadel UI serves (markdown rendering, a chat log, a composer) or copies a
> Citadel hex colour instead of its `--citadel-*` variable is a Should-fix finding (`citadel:contraption-ui`). Return at most 25 lines: numbered findings (Must fix /
> Should fix / Nice to have, file:line, one or two lines each), then
> `Risk: low|medium|high: <reason>` using the rubric in `<kit>/skills/self-review/SKILL.md` §4
> and the "Project facts" section of the repo's CLAUDE.md. This cap and format override
> ponytail-review's §4.

`<kit>` is the absolute path two folders up from this skill's base directory (shown when it
loaded): the Grunt can't resolve it itself.

Give it the code, not your view of it: no summary of what you think is fine.

**Deep only:** start a second Grunt with `model` unset (dropping a real finding in risky code is
the expensive miss), briefed with the Grunt line, the same branch, worktree and read-only
sentence, and the numbered Must and Should findings, without the first Grunt's reasoning. It opens
each cited file:line, checks the finding against the code and returns
`N: CONFIRMED|REFUTED: <evidence>`, at most 15 lines. Drop what it refutes.

A light review costs about 47k Grunt tokens and a minute (about $0.35); deep is about $1 to $1.50.
Don't re-review after fixes unless a fix grew past a few lines of high-row code.

## 3. Fix what's real

Fix Must-fix and in-scope Should-fix findings, add the test a finding asks for, re-run the tests
and commit. You own the call: a finding you judge wrong or out of scope goes in the "not fixed"
list with a reason, not silently away.

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

## 5. Report and ship

- **Low or medium:** carry on with how a change ships, as the scheme instructions say (Project
  facts points at them; with none, open the PR and stop there). The ready note leads
  with the label in a few words, within its 60 characters (`risk medium: runner retries`), and
  the final reply has one line:
  `Risk: medium: <reason>. Not fixed: <finding: why>` (or `Not fixed: nothing`).
- **High:** stop before merging. Post the same line, the findings you fixed in one line each,
  and an `ask_question` card "Merge and ship this high-risk change?" (Merge and ship /
  Hold, with your pick marked recommended). Set state null, note `risk high: waiting for a go`,
  and end the turn. Merge only on a go.
