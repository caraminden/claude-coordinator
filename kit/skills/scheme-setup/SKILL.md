---
name: scheme-setup
description: How a setup minion applies an approved onboarding plan to its scheme's repo, from CLAUDE.md with Project facts, the push guard, adapted and new skills and copied rules through to the merge. Use when your brief is an approved setup or tune-up plan.
---

# Scheme setup

You are the one setup minion of a new scheme. The Taskmaster has already applied its own part
of the plan (scheme instructions, settings, properties, `onboarding.md`). Yours is the repo:
about 10 to 20 files, merged to the scheme's main. The **plan** is your spec: build what it
lists, in its words, and nothing it doesn't.

## Your bounds

Every write lands in one of three places: your worktree, your scheme's main (by the route in
step 8), and the `## Copies` section of `$COORDINATOR_SHARED_DIR/onboarding.md`. Other schemes
are read-only, and only the exact files the plan lists to adapt. The tripwire refuses some of
these; the rest are on you:

- Never write to another scheme's repo, worktrees or shared folder. A fix you'd like there
  goes to your Taskmaster as a message.
- Never read another scheme's memory (`~/.claude/projects/*/memory/`) or its chat history. It
  holds that scheme's history and people's feedback in that context.
- Never create a repo (`gh repo create`, `git init` elsewhere) or push anywhere but your own
  scheme's `origin`.
- Never install or enable a systemd unit. Write it under `deploy/` and hand Cara the install
  command in your reply.
- Never copy anything the kit carries (step 2).

## What the plan gives you

Read the brief for each of these. A missing one that changes what you build (the shipping
answer above all) gets one `ask_question` card with your recommendation, asked at the start,
together with any other gaps. Never invent a shipping route.

| Part | Used in |
|---|---|
| Shipping answer: PR per change, auto-merge after self-review, or straight to main; and who pushes main to GitHub | steps 3, 4, 8 |
| Project facts draft, or the interview answers behind it (stack, tests, high-risk areas) | step 3 |
| Adapt list: name, kind (skill, agent, rule), source scheme and path, new name, why | step 5 |
| Write-new list: name, kind, one-line job | step 6 |
| Rules to copy and rules to write | step 7 |
| CLAUDE.md draft | step 3 |

**Tune-up plans** (the plan is a diff): edit only. Delete a skill, agent or rule only when the
plan lists it under retire.

## Steps

### 1. Look at the repo

Check your base (`git log -1 main` against `git merge-base HEAD main`). Read the README, the
build and test files, any existing `CLAUDE.md` and `.claude/`. Run the test command the plan
names once, so Project facts records a command you have seen pass (or fail, said so).
*Done when* you can name the stack, the check command and its result, and every file the
plan will touch already exists or not.

### 2. Strike what the kit already carries

List the kit's skills and agents (every `citadel:<name>` in your skill and agent listings).
For each item on the adapt and write-new lists, compare its **job**, not just its name, with
the kit's. A match is dropped, and your done note says which kit item covers it. A scheme's
own skill whose job differs from a kit one takes a different name: never a kit name.
*Done when* every listed item is either kept with a name no kit item has, or dropped with its
covering kit item named.

### 3. Write CLAUDE.md

Slim: it loads into every session of this scheme. Use `citadel:writing-for-agents` for every
file from here on. Sections, in this order:

1. A title and one line on what the project is, with a pointer to the README for layout and
   running it.
2. **Working rules**: only this repo's own (its stack's traps, a file never to edit by hand).
   The Citadel-wide layer and the scheme instructions already reach every session, so nothing
   of theirs is repeated here.
3. **Compact instructions**, as is: *When this conversation is compacted, keep each person's
   asks and decisions in their own words with their times, every open question and who owes
   the next step, the branch, PR, head and what is committed or pushed, the files written, and
   the checklist. Drop test and build logs, diffs, file contents and finished subagent reports,
   keeping one line for what each concluded.*
4. **Project facts**, below.
5. **Skills and rules**: where this scheme's own skills, agents and rules live, and that the
   generic ones come from the Citadel kit as `citadel:<name>`.

**Project facts** opens with: *The kit's skills and agents read this repo's paths and commands
from here. "None" means that skill step is skipped or uses its default.* Then one bullet per
key, `- **Key:** value`, every key present, "none" written out where it is none:

| Key | What to write | Read by | When none |
|---|---|---|---|
| Check commands | Each command, exact, and what it checks: tests, build, lint, type check. And how a UI change is checked (a dev copy, preview, screenshot) | check-runner, bug-fixing, self-review | check-runner falls back to `package.json` or `Makefile` |
| Front end | Its folder, the framework, whether it builds | self-review (front-end-only changes rate low) | nothing rates low as front end |
| High risk by file | Files whose every edit is high risk: auth, deploy and restart, guards, save formats, migrations | self-review | high goes by what a change does only |
| How a change ships | The shipping answer in one line, and who pushes main | self-review, guard.sh, pre-push | never none: ask (above) |
| UI rules | Where the scheme's UI rules live (often "the scheme instructions, UI checks") | retro | retro checks no UI rules |
| Glossary | Path of the glossary file | domain-modeling, diagnosing-bugs, improve-codebase-architecture | domain-modeling creates `GLOSSARY.md` when first needed |
| Decisions log (ADRs) | Path and format | bug-fixing, domain-modeling, fresh-eyes, retro, improve-codebase-architecture | first ADR goes in `docs/adr/` |
| Retros | Retro folder | retro | `docs/retros/` |
| Bug classes of its own | The stack's recurring bug kinds beyond bug-fixing's (a Godot signal wired twice, a stale save version) | bug-fixing | bug-fixing's classes only |
| Docs check | A test that checks the paths docs name, if one exists | retro | skipped |

*Done when* every key in the table has a line, each command was run or is marked untried, and
each path named exists or is the stated place its first file goes.

### 4. Install the push guard

Copy from this skill's `templates/` folder: `guard.sh` to `tools/guard.sh`, `pre-push` to
`.githooks/pre-push` (both executable), and `settings.json` to `.claude/settings.json`. When the
repo already has a `.claude/settings.json`, add the template's hooks to it and keep the rest.
If the scheme's main branch has a name other than `main` or `master`, add it to `is_protected`
in `guard.sh` and to the `case` in `pre-push`.

Then prove it:

```bash
tools/guard.sh --install && git config --get core.hooksPath            # .githooks
echo '{"tool_name":"Bash","command":"git push origin main","cwd":"'"$PWD"'"}' | tools/guard.sh --hook bash; echo $?   # 2
echo '{"tool_name":"Bash","command":"git push origin HEAD:refs/heads/topic","cwd":"'"$PWD"'"}' | tools/guard.sh --hook bash; echo $?   # 0
```

*Done when* the three lines print `.githooks`, `2` and `0`.

### 5. Adapt each skill the plan pulls in

For each item on the adapt list:

1. Read it in the source scheme, at the path the plan names, with any files its folder holds.
2. Write it under this repo's `.claude/skills/<new-name>/` (agents: `.claude/agents/`), under
   the name the plan gives.
3. **Specialise** it: this repo's paths, commands, stack and names, from Project facts where it
   can read them there. Drop sections for things this scheme doesn't have, and the source's
   decision citations ("Cara on <scheme> #123"): those decisions were the source's.
4. **Scrub** it. Grep every file you wrote for the source's traces:

   ```bash
   grep -rniE 'projects/<source-id>/|<source scheme name>|<source repo name>|/home/|#[0-9]+|ticket/|<source glossary terms>' <files>
   ```

   Each hit is removed or rewritten for this scheme. One that must stay (a library's own name
   that happens to match) is named in your done note.

*Done when* every adapted file exists under its new name and the scrub grep's hits are each
gone or named. Provenance goes in `onboarding.md` (step 7), not in the file.

### 6. Write each new skill

From the plan's one-line job, with `citadel:writing-for-agents` (its `SKILL-MECHANICS.md` for
the frontmatter and the invocation choice). Read this repo's code and docs for what the skill
must know; a question only a person can answer goes on your opening card. *Done when* each new
skill has its frontmatter, steps that end on a checkable completion criterion, and names only
this repo's paths.

### 7. Copy rules and record the copies

`.claude/rules/` can't come from the kit (plugins carry no rules), so generic rules are copied:

- A generic rule (`ponytail.md`) is copied whole, and its "In this repo" section rewritten for
  this repo's conventions and trust boundaries.
- A specific rule is written new, or adapted as in step 5, scrub included.

Record every copy, generic rules and adapted skills and agents alike, under `## Copies` in
`$COORDINATOR_SHARED_DIR/onboarding.md`, one row each: file here, source scheme and path,
the source's commit, the date. A tune-up refreshes copies from this table. Leave the rest of
that file to the Taskmaster. *Done when* every copied file has its row.

### 8. Commit and merge

Commit with each file named in the message. Run `citadel:self-review`: it never skips
`CLAUDE.md` or `.claude/`. On a high label, stop and ask with a card. Then merge by the
plan's shipping answer:

- **PR per change:** push your branch, `gh pr create`, and merge it with `gh pr merge` (the
  scheme's approval rules turn that into a card for a person). Wait for the merge.
- **Auto-merge after self-review** and **straight to main:** run the land step the plan names.
  When it names a land step for you to write, write it as the plan describes and land through
  it. When it names none, fast-forward the scheme's main checkout (the first entry of
  `git worktree list`) with `git -C <that dir> merge --ff-only <your branch>`.

Push main only as the plan's "who pushes main" answer says. A land step that pushes main
pushes from a clone without `core.hooksPath` set, since `pre-push` refuses main on purpose;
when the plan names no pusher, main stays local and your done note says so.
*Done when* `git log -1 main` in the scheme's main checkout is your commit (or the PR's merge),
and main is pushed or the note says it isn't.

## Done note

Your reply lists: the files written; kit items that covered planned ones (step 2); the copies
recorded; scrub hits kept; the check command and its result; whether main is pushed; and any
command Cara must run by hand (a unit install). The Taskmaster's first minions start on your
merge by themselves; nothing for you to start.
