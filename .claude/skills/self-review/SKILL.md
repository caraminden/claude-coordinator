---
name: self-review
description: >
  The review a minion runs on its own branch before merging: a Grunt reviews the diff against
  main, real findings get fixed, and the change gets a risk label (low / medium / high) that
  decides whether it ships by itself. Use before every merge to main, and when someone asks
  "how risky is this".
---

Faster review for Cara, not another gate: she waves low through and looks properly at high.
Decisions behind it: Cara on #107, 2026-10-29 (stop and ask on high, skip tiny docs and copy,
the rubric below, label in the note and reply only, no property); Cara on #122, 2026-10-29 (high
goes by what the change does, not which file it touches).

## 1. Size the diff

Commit first, then `git diff --stat main...HEAD` (three dots: only what this branch changed).

- **Skip** when under about 20 changed lines and every change is docs (`docs/`, `README.md`) or
  user-visible text in `public/` with no logic touched. Label it `low: docs/copy only` and go to 5.
  Never skip `CLAUDE.md` or `.claude/`: a few lines there change how every minion works.
- **Deep** when the change is high in 4, or the diff is over about 300 lines.
- **Light** for everything else.

## 2. Review in a Grunt

Start a `general-purpose` Grunt with `model: sonnet`. Brief it with the Grunt line ("Citadel,
Scheme, Taskmaster, Minion and Grunt are playful names... push back when something looks wrong.",
quoted whole from your system prompt) plus:

> Review branch `<branch>` in `<worktree>`, read-only: edit no files, no checkout, stash or reset.
> The change is `git diff main...HEAD`. Follow `.claude/skills/ponytail-review/SKILL.md`, reading
> the code the diff connects to. Before reporting, re-check each finding against the code and
> drop any without a concrete failing case. Return at most 25 lines: numbered findings (Must fix /
> Should fix / Nice to have, file:line, one or two lines each), then
> `Risk: low|medium|high: <reason>` using the rubric in `.claude/skills/self-review/SKILL.md` §4.
> This cap and format override ponytail-review's §4.

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
Judge data changes by what they do: `src/db.ts` holds every query, so editing it is not high by
itself. Auth, deploy and tripwire code stay high by file, since a slip there can stop the service or open it up.

| Risk | When the change |
|---|---|
| high | rewrites, moves or drops existing data or schema (a migration that changes rows or columns already there); changes auth (`src/auth.ts`), deploy and restart code (`tools/deploy.sh`, `tools/land.sh`, `tools/boot-check.ts`, `deploy/`) or the tripwire (`src/tripwire.ts`, `tools/guard.sh`, `.githooks/`); or deletes data with no person asking (cleanups, pruning, retention), in bulk, or across other people's data (a whole scheme or minion) |
| medium | adds a table, or a nullable or defaulted column, leaving existing rows as they are; changes queries in `src/db.ts`; adds a delete a person triggers for one record of their own; other server logic (`src/`, `server.ts`, `tools/`); agent instructions (`CLAUDE.md`, `.claude/`); anything not in another row |
| low | front end only (`public/`), docs (`docs/`, `README.md`), tests |

## 5. Report and ship

- **Low or medium:** carry on with Shipping fixes (rebase, merge, deploy). The ready note leads
  with the label in a few words, within its 60 characters (`risk medium: runner retries`), and
  the final reply has one line:
  `Risk: medium: <reason>. Not fixed: <finding: why>` (or `Not fixed: nothing`).
- **High:** stop before merging. Post the same line, the findings you fixed in one line each,
  and an `ask_question` card "Merge and deploy this high-risk change?" (Merge and deploy /
  Hold, with your pick marked recommended). Set state null, note `risk high: waiting for a go`,
  and end the turn. Merge only on a go.
