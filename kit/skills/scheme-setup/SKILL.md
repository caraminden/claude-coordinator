---
name: scheme-setup
description: How a setup minion applies an approved onboarding plan to its scheme's repo, from CLAUDE.md with Project facts, the push guard, adapted and new skills and copied rules through to the ship. Use when your brief is an approved setup or tune-up plan. Not for re-syncing one kit template (land.sh, guard.sh) into a repo.
---

# Scheme setup

You are the one setup minion of a new scheme. The Taskmaster has already applied its own part
of the plan (scheme instructions, settings, properties, `onboarding.md`). Yours is the repo
files, shipped to the scheme's main. The **plan** is your spec: build what it lists, in its
words, and nothing it doesn't.

## Your bounds

Every write goes to one of three places: your worktree, your scheme's main (by the route in
step 9), and the `## Copies` section of `$COORDINATOR_SHARED_DIR/onboarding.md`. Other schemes
are read-only, and you read only the files the plan lists to adapt, plus that source's
CLAUDE.md and glossary for the scrub. The tripwire refuses some of these; the rest are on you:

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

| Part | Used in |
|---|---|
| Shipping answer: the scheme's Shipping settings (Minion rules; `get_project_settings` shows them): Citadel ships it (`citadel`), pull request with auto-merge (`pr-auto`), pull request the minion merges when green (`pr-minion`) or pull request a person merges (`pr-person`), and from which risk label a person's go is needed; and the pusher of main (`tools/land.sh`, or "main stays local") | steps 3, 4, 8 |
| Project facts draft, or the interview answers behind it (stack, tests, high-risk areas) | step 3 |
| Adapt list: name, kind (skill, agent, rule), source scheme and path, new name, why | step 5 |
| Write-new list: name, kind, one-line job | step 6 |
| Rules to copy and rules to write | step 7 |
| CLAUDE.md draft | step 3 |

A gap goes one of two ways. A missing shipping answer, or a fact a new skill's job can't be
done without (who approves what it produces), gets an `ask_question` card with your
recommendation, every such gap on one card at the start. Every other gap takes the "When none"
of step 3's table, and your done note names it as a default people can change. Never invent a
shipping route.

**Tune-up plans** (the plan is a diff): edit only. Delete a skill, agent or rule only when the
plan lists it under retire.

## Steps

### 1. Look at the repo

Check your base (`git log -1 main` against `git merge-base HEAD main`). Read the README, the
build and test files, any existing `CLAUDE.md` and `.claude/`. Run the check command the plan
names once, so Project facts records a command you have seen pass, or fail, said so.
*Done when* you can name the stack, the check command and its result, and whether each path
the plan names exists yet.

### 2. Strike what the kit already carries

List the kit's skills and agents (every `citadel:<name>` in your skill and agent listings).
For each item on the adapt and write-new lists, compare its **job**, not just its name, with
the kit's:

- Same job: drop it, and your done note names the kit item that covers it.
- A kit job narrowed to this stack ("bug-fixing for Godot crashes"): drop it, and put its
  specifics in Project facts (bug classes, check commands), which the kit item reads.
- A different job: keep it, under a name no kit item has.

*Done when* every listed item is kept under a non-kit name or dropped with its covering kit
item named.

### 3. Write CLAUDE.md

Slim: it loads into every session of this scheme. Use `citadel:writing-for-agents` for every
file from here on. A rule that applies only while working in one area (a front-end folder, a
content folder, the deploy scripts) goes in a path-scoped rule instead (step 7, and that skill's
"Path-scoped rules" for what belongs where). Sections, in this order:

1. A title and one line on what the project is, with a pointer to the README for layout and
   running it.
   The README it points at has a "## Layout" table (path → what it owns, with globs or folder
   rows for groups), and the plan's check commands include a small test that fails when a module
   in the source folders has no row (Citadel's is `test/layout-map.test.ts`). Where "where does X
   live" is asked, the table answers it, read on demand: never copy it into CLAUDE.md.
   The plan's check commands also include a size budget: copy `templates/size-budget.test.ts` to the repo's
   `test/`, set its source folders and file extensions, and list each file already over the line limit at its current size with a
   one-line reason, so files can shrink but not grow (Citadel's is `test/size-budget.test.ts`). The template skips the files the kit syncs in (`KIT_SYNCED`: land.sh, guard.sh, pre-push, ponytail.md): never list them in ALLOWED.
   A repo with TypeScript also gets the type check: copy `templates/typecheck.ts` to `tools/typecheck.ts`, set its
   config block (baseline path, tsconfigs; none counts `any` only), add `typescript` as a devDependency, run
   `node tools/typecheck.ts --init`, and make `node tools/typecheck.ts` (exit 1 when a file gains a type error, an
   explicit `any` or a `@ts-ignore`) part of the check commands, with a line on fixing it with real types and
   `--update` after lowering counts (Cara, 2026-11-24: "don't cheat and use 'any'"; Citadel's is `test/typecheck.test.ts`).
   A repo with TypeScript or JavaScript also gets the formatter (#1792): copy `templates/biome.config.json` to the repo root as `biome.json` (set its
   `includes` to the repo's source folders, and `!`-exclude generated and vendored files), `templates/fmt` to `tools/fmt` and
   `templates/format.test.ts` to `test/`, add `@biomejs/biome` to devDependencies pinned exactly (`npm i -D --save-exact
   --ignore-scripts @biomejs/biome`), run `tools/fmt` once and commit that reformat alone, add its hash to
   `.git-blame-ignore-revs` (and run `git config blame.ignoreRevsFile .git-blame-ignore-revs`), and make the format test part of
   the check commands (Cara, 2026-11-24, "Formatter everywhere"; Citadel's is `test/format.test.ts`). A Python repo uses ruff
   (`ruff format`, no lint rules beyond the default) the same way. If the repo's style differs from the template's (no semicolons,
   double quotes), change `quoteStyle` and `semicolons` first so the reformat stays small.
2. **Working rules**: only this repo's own (its stack's traps, a file never to edit by hand).
   The Citadel-wide layer and the scheme instructions already reach every session, so nothing
   of theirs is repeated. A native-app scheme (the plan names a Real hardware part or the
   Real-hardware ledger) always has one: *GitHub's hosted runners (`windows-latest` and the rest) are GPU-less VMs at 100%
   display scaling with square window corners, so a desktop test passing there proves little;
   only a run on real hardware proves it.* Otherwise, when the repo has none yet, leave the
   section out.
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
key, `- **Key:** value`, every key present, "none" written out where it is none. Read `references/project-facts.md` for what each key holds, who reads it and what "none" means. The keys: Check commands, Front end, High risk by file, How a change ships, UI rules, Glossary, Decisions log (ADRs), Retros, Bug classes of its own, Agent instructions, Numbered things, Docs test, and Real-hardware ledger (native-app schemes only, with how to write `docs/unproven.md`).

**Check it** before moving on: read each line as a session new to this repo would, against four
tests.

- **Commands:** every command is exact and copy-pasteable, and step 1 saw it pass or fail.
- **Non-obvious:** every Working rule is a trap the code doesn't confess: a generated file, an
  order that matters, the reason behind an odd choice.
- **Current:** every path and command exists now; nothing describes how the repo used to be.
- **Concise:** no line restates the README, the code, the Citadel-wide or scheme layers, or a
  default the model already follows (`citadel:writing-for-agents`, "Pruning").
- **Every turn:** every line is needed whatever the session touches; one that matters only in
  one area moves, word for word, to a path-scoped rule (step 7).

Keep out: a directory tour the README or `ls` gives, generic advice ("write clean code"),
one-off fixes that won't recur, template text left as the template, TODOs. On a tune-up, run
the same tests on the existing file: fix the failures in lines the plan touches, and name the
rest in your done note. A tune-up also splits an existing CLAUDE.md the same way, moving each
area-only section to a path-scoped rule, and its done note names what moved, the globs, and the
file's bytes before and after.

*Done when* every key in the table has a line, each command was run or is marked untried,
each path named exists or is the stated place its first file goes, and every line passes the
check or its failure is in your done note.

### 4. Install the push guard

Read `references/push-guard.md` and do it as written: copy `guard.sh`, `pre-push` and `settings.json` from `templates/`, prove the
guard, then point every workflow job at the scheme's shared runner (`<scheme-slug>-ci`) and call `ci_runners` with `op: "add"`.

*Done when* `git config core.hooksPath` prints `.githooks`, `tools/guard.sh --self-test` ends `0 failed`, a push to main through
`.githooks/pre-push` exits 1, no job's `runs-on` is a bare hosted runner and, if the repo has workflows, `ci_runners` came back
done with the runner Idle (or its failure is in your done note).

### 5. Adapt each skill the plan pulls in

For each item on the adapt list:

1. Read it in the source scheme, at the path the plan names, with any files its folder holds.
2. Write it here under the name the plan gives: skills in `.claude/skills/<name>/`, agents in
   `.claude/agents/`, rules in `.claude/rules/`.
3. **Specialise** it: this repo's paths, commands, stack and names, read from Project facts
   where they live there. Drop sections for things this scheme doesn't have. Keep a rule the
   plan wants, but drop its citation ("Cara on <scheme> #123"): that decision was the source's.
4. **Scrub** it. Grep every file you wrote for the source's traces, with its terms from the
   source's glossary:

   ```bash
   grep -rniE 'projects/<source-id>/|<source scheme name>|/home/|#[0-9]+|ticket/|<source glossary terms>' <files>
   ```

   Then check every path the file names: each exists here or is the stated place its first
   file goes. Each hit is removed or rewritten for this scheme; one that must stay (a
   library's own name that happens to match) is named in your done note.

*Done when* every adapted file exists under its new name, the grep's hits are each gone or
named, and every path it names is checked. Provenance goes in `onboarding.md` (step 7), not in
the file.

### 6. Write each new skill

From the plan's one-line job, with `citadel:writing-for-agents` (its `SKILL-MECHANICS.md` for
the frontmatter and the invocation choice). Read this repo's code and docs for what the skill
must know. Say in it who runs it (a minion or the Taskmaster); it may name Citadel's tools and
kit skills (`citadel:<name>`) that its runner has. *Done when* each new skill has its
frontmatter, steps that end on a checkable completion criterion, and every path it names
exists here or is its first place.

**Architecture and testing skills** (the two kinds that grew past 9,000 words in other schemes' copies) stay short: the
description names the trigger and one near-miss, the body stays under about 1,500 words, and anything about Citadel's UI, tools
or rules is a pointer to its kit skill (`citadel:contraption-ui`, `citadel:test-quality`), never a restatement. Long detail goes in
`references/`, opened by name from the step that needs it.

### 7. Copy rules and record the copies

`.claude/rules/` can't come from the kit (plugins carry no rules), so generic rules are copied:

- **Ponytail:** copy this skill's `templates/ponytail.md` to `.claude/rules/ponytail.md`. Set
  its `paths:` to this repo's code files, and write its "In this repo" section.
- A specific rule is written new, or adapted as in step 5, scrub included.
- **Path-scoped rules** for this repo's areas (step 3): one file per area,
  `.claude/rules/<area>.md`, with `paths:` frontmatter as in `citadel:writing-for-agents`,
  "Path-scoped rules" (format and catches: it loads only once a matching file is read, and never
  in a Codex turn). Moved text keeps its words; where CLAUDE.md still names the subject (a
  Project facts line), it keeps a pointer to the rule file.

Record every copy (rules, adapted skills and agents alike) in the onboarding file's `## Copies` table, and a copy from outside Citadel
also in the repo's `THIRD_PARTY.md`: `references/copies.md` has the row format. *Done when* every copied file has its row.

### 8. Week-one basics: icon, live deploy, top bar, backups

Read `references/week-one-basics.md` and do 8a to 8e: icon, first live deploy, top bar, nightly backup, agent model lines. Each ends in
a line for the done note: done, or "not this kind of scheme".

*Done when* the done note has a line for each of 8a to 8e, each done or "not this kind of scheme".

### 9. Commit and ship

Commit with each file named in the message. Run `citadel:self-review`: it never skips
`CLAUDE.md` or `.claude/`. The guard files you just listed as high risk by file make a setup
rate high by themselves; the approved plan already listed them, so that alone is no reason to
stop. A high label for any other reason: stop and ask with a card. Then ship by the plan's
shipping answer:

- **Pull request, a person merges** (`pr-person`): push your branch, `gh pr create`, and ship it
  with `gh pr merge` (the merge approval turns that into a card for a person). Wait for it to ship.
- **Pull request, auto-merge when green** (`pr-auto`): first check the repo can auto-merge:
  `gh api repos/<owner>/<repo> --jq .allow_auto_merge`. Anything but `true` (a private repo on a
  free plan refuses auto-merge with a 403) means the plan's path can't work: ask the Taskmaster to
  switch the scheme's ship path to `pr-minion` (`message_coordinator`, `need: ask`), say so in
  your done note, and ship as below. Otherwise push your branch, `gh pr create`, and
  `gh pr merge --auto --squash`. Wait for CI and the merge.
- **Pull request, the minion merges when green** (`pr-minion`): push your branch, `gh pr create`,
  wait for CI to go green on your head commit, then `gh pr merge --squash`. Never merge a red or
  still-running PR.
- **Citadel ships it** (`citadel`), pusher `tools/land.sh`: commit it
  with the rest, then run `tools/land.sh` from your worktree. It ships and pushes your own
  setup, and every minion after you ships through it.
- **Main stays local:** check the main checkout (the first entry of `git worktree list`) is on
  main and clean, then `git -C <that dir> merge --ff-only <your branch>`.

*Done when* `git log -1 main` in the main checkout is your commit (or the PR's merge commit), and main
is pushed or your note says it stays local.

## Done note

Your reply lists: the files written; kit items that covered planned ones (step 2); gaps that
took a default; the copies recorded (and whether the scheme has the standard upstream check, or it was asked for); scrub
hits kept; the check command and its result; whether main is pushed; the step 8 list, each of icon, live deploy (with its screenshot), top bar, backup and agent model lines as done or "not this kind of scheme" (the setup card reads it from here); and any command Cara must
run by hand (a unit install). The Taskmaster's first minions start once yours ships, by themselves; nothing for you to start.
