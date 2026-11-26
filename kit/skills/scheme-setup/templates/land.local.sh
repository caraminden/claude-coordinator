# The scheme's own settings and hooks for tools/land.sh, which sources this file. tools/land.sh is the Citadel
# kit's, copied byte for byte: never edit it here, put what is this scheme's in this file. Plain shell, sourced
# under set -euo pipefail, so a mistake here stops every landing (a command that fails, a last line like
# `[ x ] && y` that comes out false: use if): run the scheme's land tests after editing. High risk by file, like
# land.sh.
# Set only what differs from the core's default (shown); leave the rest commented.

# The check command, exactly as Project facts names it under "Check commands" ('true' while it has none).
# With the CI gate on it is what runs here before anything is pushed: keep it light.
# CHECK='npm test'

# The smoke check: the scheme's quick check (seconds: a parse or lint step, the tests a change anywhere can break),
# run before a land gets in line, so what it refuses never waits in line or for CI. '' none.
# SMOKE_CMD='npm run lint'
# SMOKE_TIMEOUT=${LAND_SMOKE_TIMEOUT:-300}
# The smoke check also runs CHECK_LIGHT on the branch rebased onto main, so a red light check is refused before the
# line too, and skipped in line when main hasn't moved since. 0: only in line (it runs twice when main moves).
# EARLY_CHECK=${LAND_EARLY_CHECK:-1}

# The scheme's main branch.
# BRANCH=main

# The file whose Project facts may have a "Numbered things" line.
# FACTS=CLAUDE.md

# The CI gate: off while both of these are empty. The header of tools/land.sh says what each needs.
# CI_WORKFLOWS: the workflow files that must all be green on the exact commit that lands, split by spaces.
# CI_WORKFLOWS=''
# CI_STATUS: the scheme's own verdict command, when "every workflow green" is not the rule (exit 0 green,
#   1 red, 2 running, 3 not started, 4 no verdict). Its output names each workflow one a line, the way the core
#   prints them: "<workflow>: completed failure" (or timed_out; "completed, failure" too) for a red one, its id
#   "ci:<workflow>" (a known red matches on it), and "<workflow>: in_progress" (or queued, waiting, pending,
#   requested, not started) for one still
#   going, which keeps a red waiting for it. The name may hold spaces but no colon, and the line may be indented.
#   In another shape a known CI red never matches unless land_failures (below) reads it, and a workflow still going
#   doesn't hold a red back.
# CI_STATUS=''
# BUILD_WORKFLOWS: more workflows a major build's --full must see green, read by the core's own reader even beside
#   CI_STATUS and dispatched when the push doesn't start them: 'desktop.yml' always, 'desktop.yml:<paths file>' only
#   when the build changes a path that file lists (a bash case pattern a line, ! rules one out). The file must name all
#   the workflow tests, its code as well as its harness; in doubt, the plain form.
# BUILD_WORKFLOWS=''

# How many landings at the front of the line run CI at once. Runners that can't carry three runs at once: 2.
# CI_STACK=${LAND_STACK_DEPTH:-3}

# How many landings share one CI run (batches), with a CI gate. A batch takes whoever is waiting and never waits to
# fill. 1: off, every landing runs its own. A high share of red ship runs (over about 15%): 2.
# CI_BATCH=${LAND_BATCH:-4}

# How many fresh CI runs a red that land_flaky calls flakes only gets, keeping its place in line. Flakes that strike
# twice in a row: 3.
# FLAKE_RUNS=${LAND_FLAKE_RUNS:-1}

# Where CI gives no answer (no runner, no verdict, past its limit), ask it again in place this many times before
# parking. A runner that drops runs now and then: 2.
# PARK_RETRIES=${LAND_PARK_RETRIES:-0}

# Conflict prep: a landing stacked on the one ahead whose rebase onto it stops prints a "prep:" line, and its author
# records the fix ahead of time with git rerere (Citadel's server wakes the minion with the steps). Needs CI_STACK 2+.
# CONFLICT_PREP=${LAND_PREP:-0}
# More of the pipeline's own files, besides tools/land.sh, this file, .github/ and the lanes map: a list in the repo,
# one path a line, # comments, a trailing / for a folder. A landing that changes one ships alone, in no batch, and
# keeps fast mode on the full gate.
# PIPELINE_FILES=tools/pipeline-files.txt

# Lanes: a landing checks, and runs CI for, only the lane of the paths it changes. LANES names the map, read from
# main's copy, lines of `<lane> <pattern>...` (bash case patterns, * crosses /, first match wins, # comments):
#   light docs/* *.md
#   android app/*
# A path no line lists is full, and so are the map itself, tools/land.sh, this file and .github/*. Light paths and
# one other lane: that lane; two other lanes: full. `tools/land.sh --lane [<commit>] [<base>]` prints a commit's.
# Unset: every landing is full, as before. The header of tools/land.sh says the rest.
# LANES=tools/lanes
# The light lane's check (none: it lands in line with no check and no CI) and each other lane's (default CHECK).
# CHECK_LIGHT=''
# CHECK_ANDROID='./gradlew lint'
# A lane's workflows (default CI_WORKFLOWS; '' runs no CI and pushes nothing), and the names of jobs its runs may
# skip, split by spaces. Its runs are pushed to land/<lane>/<branch>: route them with `branches: ['land/android/**']`.
# CI_WORKFLOWS_ANDROID='android.yml'
# CI_SKIPS_ANDROID='desktop-tests'
# CI_STATUS gets the lane as its second argument.

# Guards: a quick command run on each rebased commit, after land_rebased and before the check (a schema, budget or
# contract test). Exit 0 goes on; 2, a timeout or a kill doesn't decide (it says so, and the check decides); anything
# else refuses as a red check does. Every batch member runs it; the light lane doesn't.
# GUARD_CMD='node --test test/schema-compat.test.ts'
# GUARD_TIMEOUT=${LAND_GUARD_TIMEOUT:-120}

# Ship-time merges: files two branches often change in the same place, which the rebase merges by rule rather than
# stopping on, a line "<path> <rule> [<regex>]" each. Rules: append <regex> (lines both add to a list whose opening
# line matches), sum <regex> (lines matching <regex> both changed: numbers both raised become main's plus this
# branch's raise, notes both added keep both), count <regex> (as sum, and a number either side lowered adds up too: a
# list of sizes), rows <regex> (markdown table rows both add under a heading that matches: a Layout table), main
# (main's copy: a file land_rebased makes again), hook (land_merge
# below). Anything a rule isn't sure of stops the rebase, as a clash in any other file does. The header of
# tools/land.sh says the rest.
# MERGES='
# test/prompt-budget.test.ts sum ^const\ (BUDGET|KIT_BUDGET)\ =
# src/db.ts append ^const\ MIGRATIONS
# test/size-budget.test.ts count ^\ \ .[[:alnum:]/._-]+.:\ \[[0-9]+,
# test/prompt-baseline.json main
# README.md rows ^##\ Layout$
# '

# The land lock and the line's folder ('' is <.git>/land.lock and <.git>/land-queue in the main checkout). Set both to
# share one line with another script that takes the same lock with flock (a deploy queue). Relative: from the main
# checkout.
# LOCK_FILE=''
# QUEUE_DIR=''

# 0: main stays in the main checkout and is never pushed (a scheme whose origin isn't its own).
# PUSH_MAIN=1

# Step 7: run once per branch that landed, after main was pushed, with the land lock and the place in line
# already free. The head of a batch runs it for each member it landed, from the head's worktree: use only the
# arguments, never the current branch. Its output shows with the landing's; a failure is only warned about and
# the landing still exits 0. Keep a network call in it under a timeout.
# land_after() { # <commit> <branch>
#   timeout 60 gh pr close "$2" --comment "Landed as $1" >/dev/null 2>&1 || true
# }

# Fast mode (the scheme's Settings, #1017): a low or medium risk land lands on the smoke check alone, and the full
# CHECK and CI run behind it on main (tools/land.sh --verify). The paths that keep a land on the full gate besides the
# pipeline's own files (bash case patterns, split by spaces):
# FAST_FULL='db/migrations/* src/auth/*'

# Deploy what shipped: run once by whoever moves main (alone, or the head for its whole batch), with main at <commit>,
# holding the land lock, before main is pushed. Plain shell under set -e: a command that fails is a failed deploy,
# and main goes back where it was, so the landing (and every member of its batch) didn't ship. Print one word last
# for the ship line's deploy state (live, restart; else "done"). Keep it under a timeout: it holds the line.
# land_deploy() { # <commit>
#   timeout 600 ./deploy/release.sh "$1" >&2
#   echo live
# }

# Run on the branch just rebased onto <base> (today's main, or the commit ahead of it in line), in its worktree,
# before its check: a file generated from the whole tree, rebuilt so it never goes stale or conflicts. Commit what
# should ship (it ships with the branch); changes left uncommitted, or a failure, refuse the landing.
# land_rebased() { # <base> <branch>
#   tools/build-map.sh >tools/affected-map.txt
#   git add tools/affected-map.txt # add, not commit -a: the first run makes the file
#   git diff --cached --quiet || git commit -qm "Rebuild the affected map on $1"
# }
# The ids of what failed, from a check's or CI's output on stdin, one a line: fast mode's ledger of known reds and
# LAND_KNOWN_RED match on them. The core's finds test files in node's, pytest's and jest's output and red workflows
# in CI's (ci:<file>). A scheme whose CI_STATUS prints its own: replace it.
# land_failures() {
#   sed -nE 's/^FAILED: (\S+)$/\1/p'
# }

# Runs on each rebased commit just before GUARD_CMD, in the worktree, not on the light lane: non-zero refuses the
# landing as a red check does (a boot check while deploys are refusing).
# land_preflight() { # <commit> <lane>
#   tools/boot-check.sh "$1"
# }

# Reads a red check's or CI's output on stdin; exit 0 says the red was flakes only, and what it prints says which. A
# red check then runs once more and passes only if that run is green; a red CI run gets FLAKE_RUNS fresh runs. None:
# red is red.
# land_flaky() {
#   ids=$(land_failures) && [ -n "$ids" ] && ! grep -vxFf tools/known-flakes.txt <<<"$ids" >/dev/null && echo "$ids"
# }

# CI gave no answer about <commit> (no runner started, no verdict, past its limit): decide in CI's place, in the
# worktree, which sits on <commit>. Exit 0 green, 75 no verdict either (it parks, as with none, or asks CI again with
# PARK_RETRIES; LAND_PARK_RETRIED counts the asks so far), anything else red.
# land_fallback() { # <commit>
#   timeout 1800 npm test >&2
# }

# CI on <commit> ran past CI_LIMIT: print "<seconds> <key> <why>" to give it more time, else nothing. <keys> are the
# keys given this run already; each counts once.
# land_ci_more() { # <commit> <keys>
#   case " $2 " in *' queued '*) ;; *) [ -n "$(gh run list --commit "$1" --status queued --json databaseId -q '.[]')" ] && echo "900 queued its run is still waiting for a runner" ;; esac
# }

# Failure ids on stdin (none of them known reds): print those that fail on <main> too. The check, the smoke check or
# CI then waives them, saying so.
# land_main_red() { # <main> <commit>
#   grep -xFf /dev/stdin .main-reds.txt || true # ids a nightly run of main found red
# }

# Each pass of the line, in the main checkout before this landing's work: put right what a deploy that died half way
# left. A failure refuses the landing.
# land_recover() { # <main's commit>
#   [ ! -e .deploy-half-done ] || tools/deploy-finish.sh "$1"
# }

# Print the newest commit under the branch's whose own commits left main since (a deploy rolled them back), so the
# rebase replays only the branch's commits above it. Nothing: the usual fork point. Asked again before each rebase.
# land_under() { # <the branch's commit> <branch>
#   cat .rolled-back-to 2>/dev/null || true # the deploy's roll back writes the newest commit it took off main
# }

# A red batch's guess at the member that turned CI red, from the failure ids on stdin (land_failures'): print that
# member's commit, one of those given (from the one on main up), and the bisect runs CI just below it, then on it,
# before halving. Nothing: halving as always. The red batch waits for it, so keep a slow one (a test run) under a
# timeout. This one guesses the lowest member whose change touched a failing file.
# land_suspect() { # <main's commit> <member's commit>...
#   local ids m prev=$1; ids=$(cut -d: -f1 | sort -u); shift
#   for m in "$@"; do
#     git diff --name-only "$prev" "$m" | grep -qxFf <(printf '%s\n' "$ids") && { echo "$m"; return; }
#     prev=$m
#   done
# }

# MERGES's hook rule: merge <path>, leaving the result in <ours>. <side> says which of ours and theirs is main's
# (ours in a rebase). Exit 0 clean; anything else stops the rebase as a clash does. With append, sum or count lines for the
# same path, it runs with LAND_MERGE_DIFF3=1 and leaves its clashes as diff3 markers (size 31, main/base/branch) for
# those rules; tools/ship-numbers.ts does.
# land_merge() { # <side> <base> <ours> <theirs> <path>
#   node tools/ship-numbers.ts merge "$1" "$2" "$3" "$4" # it takes no path
# }
