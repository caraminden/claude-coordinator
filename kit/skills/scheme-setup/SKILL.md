---
name: scheme-setup
description: How a setup minion applies an approved onboarding plan to its scheme's repo, from CLAUDE.md with Project facts, the push guard, adapted and new skills and copied rules through to the ship. Use when your brief is an approved setup or tune-up plan.
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
key, `- **Key:** value`, every key present, "none" written out where it is none. The one
exception is Real-hardware ledger: only a native-app scheme has that line.

| Key | What to write | Read by | When none |
|---|---|---|---|
| Check commands | Each command, exact, and what it checks: tests, build, lint, type check. A fresh minion worktree has no dependencies (no `node_modules`), so a check command that needs them installs them when they are missing (`npm ci` when the lockfile is there and `node_modules` isn't), or the first run in a new worktree is red. Then how a UI change is checked (a dev copy, preview, screenshot). A dev server: the command that starts it, printing its pid, and the stop by that pid (a kill by name or pattern is refused) | check-runner, bug-fixing, self-review | check-runner falls back to `package.json` or `Makefile`; UI: "none named yet" |
| Front end | Its folder, the framework, whether it builds | self-review (front-end-only changes rate low) | nothing rates low as front end |
| High risk by file | Files whose every edit is high risk: auth, save formats, migrations, deploy and restart code. Always `tools/guard.sh`, `.githooks/`, `.claude/settings.json`, and `tools/land.sh` and `tools/land.local.sh` when written | self-review | the guard files alone |
| How a change ships | The shipping answer in one line, and the pusher of main | self-review, guard.sh, pre-push | never none: ask (above) |
| UI rules | Where the UI rules live. Your own prompt carries the scheme instructions: name their UI section if they have one | retro | retro checks no UI rules |
| Glossary | Path of the glossary file | domain-modeling, diagnosing-bugs, improve-codebase-architecture | domain-modeling creates `GLOSSARY.md` when first needed |
| Decisions log (ADRs) | Path and format. A single file that every minion appends to (not one file per decision) gets `<path> merge=union` in `.gitattributes`, so two appends rebase without a conflict; only for an append-only log, never JSON or code (union would corrupt it) | bug-fixing, domain-modeling, fresh-eyes, retro, improve-codebase-architecture | first ADR goes in `docs/adr/` |
| Retros | Retro folder | retro | `docs/retros/` |
| Bug classes of its own | The stack's recurring bug kinds beyond bug-fixing's (a Godot signal wired twice, a stale save version) | bug-fixing | bug-fixing's classes only |
| Agent instructions | Prompts, guides and tool descriptions an agent reads beyond the kit, `CLAUDE.md`, `AGENTS.md` and `.claude/` (an app's system prompt, a guides folder) | self-review (Agent instructions lens) | those alone |
| Numbered things | What minions number in parallel and could both take the same "next" of: migration files, a version, ledger ids. Entries split by `;`: `files <glob with NNNN>`, `ids <glob> "<regex>"`, `version <glob> "<regex>"` (the format is in `land.sh`'s header). Only with `tools/land.sh`, which refuses a change that clashes | land.sh | no check |
| Docs test | A test that checks the paths docs name, if one exists | retro | skipped |
| Real-hardware ledger | Native-app schemes only: `docs/unproven.md`, written as below | self-review | no line |

**The ledger** (native-app schemes only) lists what nobody has yet seen work on real hardware.
Write `docs/unproven.md` with a title, then this paragraph with the platform filled in, and no
entries yet:

> What this app does that nobody has yet seen work on a real <platform> machine; CI's VMs
> can't show it. A PR that leaves something unchecked on real hardware adds an entry here,
> under an area heading (Capture, Colour, Install), numbered after the highest number so far.
> Each entry says what is unproven and what a failure would look like, and ends with its PR
> or commit. A run on real hardware deletes what held and swaps what broke for its bug
> minion's number. Numbers are never reused.

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

Copy from this skill's `templates/` folder: `guard.sh` to `tools/guard.sh` and `pre-push` to
`.githooks/pre-push` (both executable), and `settings.json` to `.claude/settings.json`. When the
repo already has a `.claude/settings.json`, add the template's hooks to it and keep the rest.
The template carries no `permissions.allow` list: minions run in bypassPermissions, where allow
rules change nothing, and the prompts left (Claude Code's check on an `rm` it cannot resolve)
ignore allow rules and hooks alike; the minion prompt teaches the `rm` habits that avoid them.
If the scheme's main branch has a name other than `main` or `master`, add it to `is_protected`
in `guard.sh`, to the `case` in `pre-push`, and to `BRANCH` in `land.local.sh`. Adapt the
copies of `guard.sh`, `pre-push` and `ponytail.md` freely (`land.sh` stays byte for byte, below):
when the kit changes one, Citadel's server merges the change into the scheme's copy, keeping the
scheme's own edits, and ships it on a member's go (Citadel #1100).

Opt-in live-app check: `guard.sh` carries an `is_live` helper that refuses a listed app's live folder
(`~/apps/<name>`, `~/apps/.<name>`, anything under either, or whatever those links lead to, `..`
resolved after links). It does nothing until the scheme lists its app: put the name in `LIVE_APPS=(name)`
near the top of its copy of `guard.sh`. The Bash hook then refuses a command that names the folder
(reads too, a shell can't be told apart) or runs from it; for Write and Edit, add a `PreToolUse` entry
with matcher `Write|Edit|MultiEdit|NotebookEdit` running `tools/guard.sh --hook files` to the scheme's
`.claude/settings.json`. Add self-test lines for it in `self_test` as the template's slot cases do.

When the plan names `tools/land.sh` as the pusher, copy `land.sh` there too (executable), byte
for byte, and `land.local.sh` to `tools/land.local.sh`. Every setting below goes in `land.local.sh`,
never in `land.sh`: the core stays the kit's, so a kit fix reaches the scheme as one copy, and
Citadel's deploy lists the schemes whose copy differs. Set `CHECK` there to the check command from
Project facts, or `true` while there is none (your done note says so); `SMOKE_CMD` to the check's quick part (a lint or a type check that answers in seconds; empty leaves only the conflict check before the line); `PUSH_MAIN=0` keeps main
local, and `land_after` is the hook for what the scheme does after a ship is pushed (closing a
PR, say). It rebases, runs the check, fast-forwards the main checkout and
pushes main; read its header. Ships wait for its lock in a line, oldest first, with no time
limit while the line moves: a minion runs it in the background with a long timeout, since a run
that is stopped loses its place. Before the check it refuses a branch that takes a migration
number, version or ledger id main already has, as the Numbered things line names them: look for
each (`git log --diff-filter=A` on a migrations folder, version lines, numbered ledger entries), and
check each regex matches what it should (`perl -ne 'print "$1\n" if /<regex>/' <file>`).

When the plan has CI decide what ships (the scheme's checks run on runners, not on the shared
box), turn on `land.sh`'s CI gate: set `CI_WORKFLOWS` to the workflow files that must be green,
add `'land/**'` to each one's `push: branches:`, and give each a concurrency group per ref. Take
`pull_request` out of their triggers, and `main` too: the ship run is the one that decides, on the exact
commit that ships, so a PR run only tests a commit that goes stale once main moves, and a main run tests
a commit that already passed. Each doubles the runners' work per ship (#603: Peek's PR runs were 3,700
runner-minutes in a week). Keep `workflow_dispatch` for runs by hand; the Windows CI kit's workflows have
this shape. Citadel's PR watcher expects no checks on a PR when no workflow runs on `pull_request`. Set
`CHECK` to what should still run on the box before anything is pushed (`true` for nothing). Then
a ship pushes its rebased commit to `land/<branch>`, waits for CI on exactly that commit, and
only then moves main. The shipped commit's runs there are left to finish (a scheme that keeps CI on main can skip
what they passed); every other run on the scratch branch is cancelled. The first `CI_STACK` ships in line (3) run CI at once, each built on the
one ahead, so a ship doesn't wait a whole CI round per place in line. `CI_BATCH` (4 by default; 1 turns it off) lets up to
that many share one run on the last one's commit, with `CI_STACK` set to the runs the runners carry at once; a batch
takes whoever is waiting and never waits to fill, and the header says how a red batch is bisected. A ship that
changes the pipeline (land.sh, land.local.sh, `.github/`, the lanes map, and `PIPELINE_FILES`' list) ships alone.
Leave it at the default. A high share of red ship runs (over about 15%) argues for 2. A scheme that deploys what
ships gives land.local.sh a `land_deploy`: the batch deploys once, and a failed deploy takes main back. Files two
ships often change in the same place (a budget both raise, a list both append to, a generated baseline) get a
`MERGES` line each, so the rebase merges them by rule rather than stopping. The rest of land.local.sh's hooks (guards,
preflight, a flaky-red rerun, a fallback when CI gives no answer, a shared lock) stay off unless the plan asks. When much of what ships needs less than the whole check and CI
(docs, one app of several), give it lanes: `LANES=tools/lanes` and a map of `<lane> <pattern>...` lines, with
`CHECK_<LANE>`, `CI_WORKFLOWS_<LANE>` and `CI_SKIPS_<LANE>` in `land.local.sh` (its comments show them). A light
ship goes through the line with no CI and no push; a lane's run goes to `land/<lane>/<branch>`, so `'land/**'` still
catches every run and `'land/<lane>/**'` routes one lane's. Anything the map doesn't list is full, so a missing
line costs time, never safety; `tools/land.sh --lane` prints the lane a commit would take. When "every workflow
green" is not the rule (a workflow that only blocks when red, one that runs for some paths), set
`CI_STATUS` to the scheme's own verdict command; the header gives its exit codes. Exit 75 means
CI gave no verdict (the runners' machine is off): nothing is wrong with the branch, so the minion
calls `wake_when_runners_back`, seals itself, and runs it again once Citadel says the runners are back. Say all of this in the "How a
change ships" line, and that the worktree sits on a detached commit while a ship waits.

`--install` sets `core.hooksPath` in the repo's shared config, so the main checkout gets the
hook once your merge brings `.githooks/` there. Then prove it:

```bash
tools/guard.sh --install && git config --get core.hooksPath            # .githooks
tools/guard.sh --self-test                                              # ... 0 failed
echo 'refs/heads/x 0 refs/heads/main 0' | .githooks/pre-push; echo $?   # 1
```

*Done when* the three lines print `.githooks`, `0 failed` and `1`. If you added a protected
branch name, add a self-test line pushing to it first, in `self_test` in `guard.sh`.

**CI runs on the shared runner.** Every scheme's GitHub Actions jobs run on Cara's desktop, one
self-hosted runner per repo, labelled `<scheme-slug>-ci` (the scheme's name in lowercase with
dashes: Peek Auras → `peek-auras-ci`); GitHub's hosted runners are only the fallback. So every
job in a workflow you write, adapt or find in `.github/workflows/` gets this `runs-on`, with this
scheme's label, and runs its steps in bash, which works on both:

```yaml
    runs-on: ${{ vars.CI_RUNNER == 'github' && 'ubuntu-latest' || fromJSON('["self-hosted", "<scheme-slug>-ci"]') }}
    defaults:
      run:
        shell: bash
```

A workflow that keeps a file from a run (a build, reports, a release) uploads it to Citadel's own
store, never with `actions/upload-artifact`: the `citadel:ci-store` skill has the script and the
rules for what may be kept.

A scheme's test workflow also sends its suite's wall time, so the CI page's Numbers tab can flag slow
creep: copy `ci-numbers.sh` from the `citadel:ci-store` skill to `tools/ci-numbers.sh`, give the job
`id-token: write`, time the test step (`started=$SECONDS` before it, the seconds after it on a green
run) and add a last step `if: success()` with `continue-on-error: true` running
`tools/ci-numbers.sh suite-time=${secs}s`. Citadel's own `.github/workflows/tests.yml` is the example.
A scheme's existing workflows are left alone.

Write no workflow the plan doesn't ask for. If the repo has workflows, add the scheme's runner
yourself: call the `ci_runners` tool with `op: "add"` (one runner unless the plan names a count,
at most 4). Citadel's runner agent on the desktop installs it, and the tool waits until GitHub
shows it Idle. Jobs wait in the queue until a runner is there. If the tool says no runner agent
is online, or the job failed, put its words in your done note and tell the Taskmaster
(`message_coordinator`); don't install a runner any other way. *Done when* no job's `runs-on` is
a bare hosted runner and, if the repo has workflows, `ci_runners` came back done with the runner
Idle (or its failure is in your done note).

**A Windows app's CI** starts from this skill's `templates/windows-ci/` when the plan gives the
scheme Windows CI: its `README.md` says where each file goes, and its lint line joins the check
commands in Project facts. Its workflows run only as a change ships, so they need land.sh's CI gate
(above): `windows.yml` in `CI_WORKFLOWS`, `desktop.yml` through `CI_STATUS`. Jobs that open windows need the session runner, which a person adds on
the PC (`add-runner.ps1 -Session -Visible`, not `ci_runners`): name that step in your done note.

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

Record every copy (rules, adapted skills and agents alike) under `## Copies` in
`$COORDINATOR_SHARED_DIR/onboarding.md`, adding the heading if it isn't there. One row each:
file here, source (scheme and path, or "kit template"), the source's commit (`git -C <source>
rev-parse --short HEAD`; a kit template has no commit to read: write `kit`), today's date. A tune-up refreshes copies from this table. Leave the
rest of that file to the Taskmaster.

A copy from outside Citadel (a third-party skill, agent or rule, from a plan line or a
`citadel:skills-survey` handoff) also gets a row in the repo's `THIRD_PARTY.md`, so the scheduled
upstream check (`citadel:upstream-check`) can read it. Make the file when it isn't there, with
this table and, below it, each licence's full text:

```
## Copies

| Upstream repo | Upstream path | Pinned commit | Path here | Licence | Copied | Checked |
|---|---|---|---|---|---|---|
| owner/repo | skills/x | abc1234 | .claude/skills/x/ | MIT | unchanged | abc1234 2026-11-06 |
```

`Copied` is `unchanged` or `adapted: <what changed>`; `Checked` starts as the pinned commit and
today's date; one row per copied path. If this is the file's first row and the plan's Standard
audits leave out the upstream check, get it asked for as `citadel:upstream-check` says. *Done when*
every copied file has its row.

### 8. Week-one basics: icon, live deploy, top bar, backups

Nearly every scheme spent its first week on follow-up minions for these (onboarding review, 2026-11-19, section 3). The gaps are from Citadel's onboarding review (`reports/scheme-onboarding-review-2026-11.md` in Citadel's shared folder, section 3). Each sub-step ends in a line for the done note: done, or "not this kind of scheme".

**8a. Icon** (closes the review's "icon done again after setup": about 14 minions across 10 schemes). One icon, drawn with code (no image generator), serves as the scheme's icon and the app's.
1. Draw `assets/icon/icon.svg` (a simple mark in the scheme's accent colour; under 256 KB, no scripts). Citadel takes a scheme's favicon from the first of `assets/icon/icon.svg`, `assets/icon/favicon.svg`, `web/public/icon.svg`, `public/icon.svg`, `public/favicon.svg` or `favicon.svg` in the repo's main (so use the first); commit it to the scheme's main, so shipping step 9 sets the scheme icon.
2. A contraption also uses the same drawing as its `icon.svg`, renders the 192 and 512 PNGs and a maskable PNG from it (`citadel:contraption-ui`, `references/installing.md`), and its `manifest.webmanifest` lists them.
*Done when* the SVG is committed at that path, and, for a contraption, the manifest's icons are the same drawing. Step 9's ship puts it on main, which is when the scheme's icon shows; check that after step 9.

**8b. Contraption: registered and live** (closes TripPresenter #6, about 15 h with nothing live, and Mandate #23). Skip 8a's contraption half and 8b to 8d when the scheme's app is not a contraption (an app Citadel serves under `/apps/<name>/`). The onboarding plan's contraption answer says whether it is one.
1. Call `deploy_contraption` for the app. A refusal that names the app as unknown means it is not registered.
2. Not registered: an app that doesn't exist yet is made by your own Taskmaster's `make_app` (a folder of this scheme's repo, registered and on for its members: `citadel:contraption-ui`, `references/api.md`); ask it for that rather than building one by hand. An app that already exists in its own repo: ship its `citadel-app.json` to main first, then ask your own Taskmaster (`message_coordinator`) to call `adopt_app` (`name`, `title`, `folder` of the manifest: `""` for the repo root) on a member's turn. It registers the app with a free port, its icon and this scheme as home, switches it on for the members, deploys it and answers with the deploy's outcome; it needs no one from Citadel's scheme. An app in a repo that isn't this scheme's own is still admin-only (the Citadel Taskmaster's `register_contraption`).
3. Your Taskmaster's `adopt_app` deploys at once: wait for its answer, then carry on from the deploy's outcome. Don't close with the deploy open.
4. Run `deploy_contraption` until one run went live, clear its **To do** lines, and take a screenshot of the live app for the done note.
5. In CLAUDE.md, write the deploy line ("deploys with `deploy_contraption`") as fact only once a run went live.
*Done when* one `deploy_contraption` run went live and its screenshot is in the done note. Only a Taskmaster that can't register it (it says so) lets the note list "registered and first deploy" as open, with the message you sent.

**8c. Top bar** (closes VA #57 and #66, ToC #139, Mandate #117). The contraption's page header is the kit's `<header class="cui-topbar">`, first in the page (`citadel:contraption-ui`, rule 24). *Done when* the live screenshot shows it.

**8d. Nightly backup** (closes VA #51), for a contraption that keeps data (a database or files). The convention: the app writes `$DATA_DIR/backups/<day>/` before 04:00 PST, from a timer in `citadel-app.json` (`timers`, see `references/api.md` of `citadel:contraption-ui`). `on_calendar` is systemd time on the server's own clock, Pacific, the same clock as Citadel's 04:00 ship; use `*-*-* 03:30:00`. Citadel ships them off the box. Its own snapshots of `DATA_DIR`, taken before a deploy that changes the app's `migrations` (#1137), are only for roll backs and stay on the box, so they don't replace this backup. *Done when* the timer is in `citadel-app.json` and one run wrote a `backups/<day>/` folder, or the app keeps no data.

**8e. Pin every agent you wrote**

(Closes TWI #52, TP #26, VA #65, Trans #75, Delve #125.) Every agent file you adapted in step 5 (`.claude/agents/*.md`) has `model:` and `effort:` lines, never `inherit`, picked by its job from the table in `citadel:subagents` ("Model and effort per job"). *Done when* `grep -L '^model:' .claude/agents/*.md` and the same for `effort:` list nothing, and `grep -l '^\(model\|effort\): *inherit' .claude/agents/*.md` lists nothing.

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
