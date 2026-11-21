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

# How many landings at the front of the line run CI at once. Runners that can't carry three runs at once: 2.
# CI_STACK=${LAND_STACK_DEPTH:-3}

# How many landings share one CI run (batches). 1: off. A deep line on slow CI: 3 or 4.
# CI_BATCH=${LAND_BATCH:-1}

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
# The ids of what failed, from a check's or CI's output on stdin, one a line: fast mode's ledger of known reds and
# LAND_KNOWN_RED match on them. The core's finds test files in node's, pytest's and jest's output and red workflows
# in CI's (ci:<file>). A scheme whose CI_STATUS prints its own: replace it.
# land_failures() {
#   sed -nE 's/^FAILED: (\S+)$/\1/p'
# }
