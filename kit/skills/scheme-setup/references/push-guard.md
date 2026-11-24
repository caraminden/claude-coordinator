# Step 4 in full: the push guard and CI runner

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
`MERGES` line each, so the rebase merges them by rule rather than stopping. A ship whose whole diff is a command's
output (a reformat, a regenerated baseline or generated files; not a feature that also moves one) needs no setup: it declares the command with two
trailers on one of its commits, `Regenerate: <command>` and `Regenerate-files: <patterns>`, and land.sh takes
main's side of those files on a conflict, runs the command again after the rebase, commits what it wrote and holds the
line (first among the waiters, alone) until it ships. A conflict refusal names the trailers. The rest of land.local.sh's hooks (guards,
preflight, a flaky-red rerun, a fallback when CI gives no answer, a shared lock) stay off unless the plan asks. When much of what ships needs less than the whole check and CI
(docs, one app of several), give it lanes: `LANES=tools/lanes` and a map of `<lane> <pattern>...` lines, with
`CHECK_<LANE>`, `CI_WORKFLOWS_<LANE>` and `CI_SKIPS_<LANE>` in `land.local.sh` (its comments show them). A light
ship goes through the line with no CI and no push; a lane's run goes to `land/<lane>/<branch>`, so `'land/**'` still
catches every run and `'land/<lane>/**'` routes one lane's. Anything the map doesn't list is full, so a missing
line costs time, never safety; `tools/land.sh --lane` prints the lane a commit would take. When "every workflow
green" is not the rule (a workflow that only blocks when red, one that runs for some paths), set
`CI_STATUS` to the scheme's own verdict command; the header gives its exit codes. When a major build's
`--full` run must also see a workflow the gate leaves out (Peek's `desktop.yml`, which runs on main only), name it in
`BUILD_WORKFLOWS` in `land.local.sh`: `'desktop.yml'` for every build, or `'desktop.yml:<paths file>'` only when the build
changes a path that file lists. That file must name everything the workflow tests (the code too, not just its harness),
or a build that changes only that code skips it; when in doubt, use the plain form. `--full` dispatches it on the build's `land/` branch when the push didn't
start it (it needs `workflow_dispatch`), waits for it, and refuses the build on its red, CI_STATUS or not. Exit 75 means
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

