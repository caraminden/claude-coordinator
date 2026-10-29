# CLAUDE.md

Citadel: a shared web UI that runs headless Claude Code sessions as minions.
What it does, its layout and how to run it: `README.md`. Node 24+ runs the TypeScript
directly; there are no dependencies and no build step.

## Working rules

- Working with Cara (tone, when to ask versus pick a default, run-backs, her words as the
  spec): `docs/working-with-cara.md`. Read it before your first reply to her in a session.
- Never skip, loosen or delete a test to get green. Fix the code, or say why the test is wrong.
- Never push to main on GitHub yourself: `tools/deploy.sh` does that after each deploy. Work on your
  minion branch; when and how it lands in the local `main` and deploys follows the scheme
  instructions ("Shipping fixes"). No plain force pushes: `--force-with-lease`, and only on your own
  branch. `tools/guard.sh` and `.githooks/pre-push` enforce the push rules.
- Commit each green step before a worker starts in the same tree, and never `git checkout`,
  `git restore` or `git stash` a path to look at it (`git diff` and `git show HEAD:path` do
  that): on Delve, uncommitted work was lost twice that way.
- Do what was asked. Name anything extra you noticed instead of doing it.
- Verify live state (git, the running service, the database) before explaining it; a summary or
  a memory may claim something that didn't happen.
- A PR description states what was actually run (tests, a boot, a screenshot, a curl) and says
  plainly what was not verified. Template: `.github/pull_request_template.md`.
- While your own background job runs (a test run, a build, a server you're checking), wait for
  it inside the turn with one blocking command rather than ending the turn: a minion's turn is one
  `claude -p` process, the board shows it idle once that exits, and the job may not outlive it.
- After a second permission denial for the same kind of action, stop and say what you need
  instead of trying another route.
- Subagents (Grunts): whether a step should leave the session, and which `effort` and `model` each job
  gets: the `citadel:subagents` skill (it was `docs/subagents.md`). Never put `effort` on a skill.

## Compact instructions

When this conversation is compacted, keep each person's asks and decisions in their own words
with their times, every open question and who owes the next step, the branch, PR, head and what
is committed or pushed, the files written, and the checklist. Drop test and build logs, diffs,
file contents and finished subagent reports, keeping one line for what each concluded.

## Project facts

The kit's skills and agents read this repo's paths and commands from here. "None" means that
skill step is skipped or uses its default.

- **Check commands:** `npm test` (`node --test test/`). No build or lint step. A UI change is
  also checked in a dev copy or preview (scheme instructions, "UI checks").
- **Front end:** `public/`, plain JS with no build step.
- **High risk by file (self-review):** auth (`src/auth.ts`); deploy and restart code
  (`tools/deploy.sh`, `tools/land.sh`, `tools/boot-check.ts`, `deploy/`); the tripwire
  (`src/tripwire.ts`, `tools/guard.sh`, `.githooks/`). `src/db.ts` holds every query: judge an
  edit there by what it does.
- **How a change ships:** the scheme instructions, "Shipping fixes" (`tools/land.sh`).
- **UI rules:** the scheme instructions, "UI checks".
- **Glossary:** none. The names people read (Scheme, Taskmaster, Minion, Grunt) are in the scheme
  instructions; code keeps the old identifiers.
- **Decisions log (ADRs):** none yet; the first goes in `docs/adr/`.
- **Retros:** none yet; the first goes in `docs/retros/`.
- **Bug classes of its own:** none beyond the bug-fixing skill's.

## Skills, subagents (Grunts) and rules

The shared skills and agents live in the Citadel kit (`kit/`, see its `README.md`), which every
turn of every scheme loads; they show up namespaced, as `citadel:<name>` skills and
`citadel:<name>` subagent types. Some are copies of open-source packs, listed with their sources
in `kit/skills/THIRD_PARTY.md`. A fix to one lands here and reaches every scheme. This repo has
no skills or agents of its own. `.claude/rules/ponytail.md` loads whenever a session reads a code
file (plugins can't carry rules).

This file loads into every session, so keep it slim: a rule for one kind of job goes in its
skill, and detail goes in the doc that owns it, with at most a pointer here (the
`citadel:writing-for-agents` skill). `tools/doc-map.sh <doc>` prints a long doc's sections with their
line ranges, for reading only the part you need.
