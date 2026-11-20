#!/usr/bin/env bash
# Land a minion's branch on main: run it from the minion's worktree once its work is committed.
#   tools/land.sh
# Don't edit this file in a scheme: it is the Citadel kit's (kit/skills/scheme-setup/templates/land.sh), copied
# byte for byte, so a kit fix reaches a scheme as one copy. The scheme's settings and hooks go in tools/land.local.sh
# next to it (the kit's land.local.sh shows each one), which this sources; a setting the core gains gets a default here.
# This is the route CLAUDE.md names under "Project facts", "How a change ships". One landing at a
# time, under a lock in the scheme repo's .git, in the order they asked: it says its place in line
# and waits as long as the line moves, so run it in the background with a long timeout (a run that
# is stopped loses its place).
#   tools/land.sh --check   only says whether the rebase onto main would conflict (exit 3, naming the files), changing
#       nothing; Citadel's hand_off_land runs it first. While others are ahead in line, each move of main is checked
#       the same way, and a conflict leaves the line at once.
#   tools/land.sh --verify  the full check and CI on HEAD, a commit already on main, out of line and without the land
#       lock: Citadel's fast mode runs it behind the lands. It prints "verify: green", or "verify: failing <id>" for
#       each failure land_failures finds (below) and "verify: red"; exit 0 green, 1 red, 75 CI gave no verdict.
#       With LAND_VERIFY_IDS (ids, a line each: fast mode's culprit search), only what those need runs: CI only for a
#       ci: id, and with CHECK_FILE_CMD set, only their test files in place of the whole CHECK.
# Build branches: a major build is a branch build/<n>, checked out nowhere, that feeders merge into and that ships
#    to $BRANCH whole. Ported from Citadel's own land.sh. Once this script takes --into, Citadel's prompts tell the
#    Taskmaster when to suggest a build and each feeder and build minion its steps (the scheme's Builds setting).
#   tools/land.sh --into build/<n> [<test files>]   a feeder merges into it: rebases onto build/<n> (no rebase when it
#       is already under the branch), runs the named test files through CHECK_FILE_CMD (with none named, or no
#       CHECK_FILE_CMD: CHECK_LIGHT, else CHECK), and moves build/<n> by compare-and-swap. No CI, no line, no push:
#       it waits only for other runs on the same build (a lock per build).
#   tools/land.sh --into build/<n> --full           the build minion's merge of $BRANCH: build/<n> must already be
#       under its branch (it ran git merge build/<n>; no rebase, which would flatten the build's merges), then the
#       full CHECK and CI on land/<branch>, as --verify runs them, then the same compare-and-swap. Out of the line.
#   tools/land.sh --build                            ships the build its branch is at the tip of, through the line:
#       $BRANCH comes in by merge (not rebase), then the check, CI, the fast-forward and the push as for any land,
#       then build/<n> is deleted, here and on origin. Only as the head of the line, never stacked, never in fast mode.
#   A plain land refuses a branch that carries commits of a build/* that $BRANCH doesn't have: half a build would go live.
#   Lock order: a build's lock (fd 6) before the land lock (fd 9); --into and --full take only the build's.
# Fast mode (#1017): with LAND_FAST=1 (Citadel sets it for a low or medium risk land in a scheme whose Settings turn
#    fast mode on), a branch that changes none of tools/land.sh, tools/land.local.sh, the LANES map, .github/* or the
#    scheme's FAST_FULL patterns lands on the smoke check alone: no check, no CI. The full suite runs behind it on main.
# Known reds: LAND_KNOWN_RED (from Citadel in fast mode) lists what already fails on main, a line "<id><TAB><who is
#    fixing it>" each ("#41 is fixing it"). A smoke, check or CI red whose failures (land_failures) are all known reds
#    doesn't refuse; a file's id stands for every test in it. A check that timed out, or a CI workflow still running,
#    is never waived. With no SMOKE_CMD (or LAND_SMOKE=0) fast mode is off: a land with no check at all takes the gate.
# 0. The smoke check, before it gets in line, so what fails in seconds never holds the line: whether the rebase onto
#    main would conflict (git merge-tree), then SMOKE_CMD, the scheme's quick check, if it sets one. A fail says
#    "smoke: …" and exits 1. LAND_SMOKE=0 skips it.
# 1. Rebases the branch onto the local main. A conflict stops here.
# 2. Refuses when the branch takes a number main already has (a migration, a version, a ledger id),
#    as the "Numbered things" line in Project facts names them. No line, or "none": no check.
#    And refuses a branch that removes what a recent landing added without naming it, such as a squash
#    onto a newer main that keeps the branch's old files (undo_guard below; a message line "Undoes: <sha>"
#    lets a meant undo through).
# 3. Runs the check command on the rebased commit, within LAND_CHECK_TIMEOUT whole seconds (default
#    1800). A failure or overrun stops here. With lanes (LANES below), the check of the commit's lane.
# 4. With the CI gate on (below): pushes the commit to the scratch branch land/<branch> on origin and
#    waits for CI to pass exactly that commit (with lanes, land/<lane>/<branch>, or no push for a lane with no CI). Red stops here. On the way out the scratch branch is
#    deleted and its unfinished runs cancelled, except those of a commit that landed: they finish, so
#    main's CI can reuse what they pass. With batches (CI_BATCH over 1, "Batches" below) only the
#    last of a batch pushes, and its run covers the commits of the ones ahead of it in the batch.
# 5. Fast-forwards main in the scheme's main checkout to the commit; with batches, the head of the
#    line moves it to the deepest commit of its batch CI passed, which lands every member up to there.
#    Main only ever moves to a commit CI passed.
# 6. Pushes main to origin from the main checkout, never forced (not with PUSH_MAIN=0). A failed push is
#    reported and main stays moved; the next landing pushes it again.
# 7. Once main is pushed and the lock and the place in line are free: runs land.local.sh's land_after, if it
#    has one, for each branch that landed. Its failures are warnings, never a failed landing.
# Until step 5 main is untouched. The branch itself only moves when it lands, or to the rebased
# commit when the check or CI was red on top of main (so the fix starts from there); anything else
# leaves it where it was. While this runs, the worktree sits on a detached commit: don't work in it.
# Exit: 0 landed; 1 refused (a conflict, a clash, a red check, red CI) or main moved but its push
# failed; 75 CI gave no verdict (no runner took the run, it ran too long, or it was lost twice; or,
# for LAND_CI_DOWN seconds after a landing waited out one of those limits, no runner has taken this one's yet):
# nothing is wrong with the branch and nothing landed, so park and run this again once a person says
# the runners are back.
set -euo pipefail

# The check command, exactly as Project facts names it under "Check commands" ('true' while it has none).
# With the CI gate on it is what runs here before anything is pushed: keep it light.
CHECK='npm test'
# The smoke check (#1012): the scheme's quick check, run on the branch as it is, before it gets in line, so a land it
# refuses never waits in line or for CI. Seconds, not minutes: a parse or lint step, the tests a change anywhere can
# break. '' none (the conflict check still runs). Past SMOKE_TIMEOUT seconds it doesn't decide, and the land goes on.
SMOKE_CMD=''
SMOKE_TIMEOUT=${LAND_SMOKE_TIMEOUT:-300}
# The scheme's main branch.
BRANCH=main
# The file whose Project facts may have a "Numbered things" line.
FACTS=CLAUDE.md

# The CI gate: off while both of these are empty.
# CI_WORKFLOWS: the workflow files that must all be green on the exact commit that lands, split by
#   spaces: 'windows.yml' or 'ci.yml android.yml'. Each needs "land/**" among its push branches:
#     on:
#       push:
#         branches: ['land/**']
#   with no pull_request or main trigger, which would only run the same check again (#603), and a
#   concurrency group per ref (group: <name>-${{ github.ref }}), or the stacked runs below
#   wait for each other. A run that succeeded with a job skipped is not green, and is refused rather than
#   run again (it would skip again): a workflow whose jobs are skipped on purpose needs CI_STATUS.
# CI_STATUS: only when "every workflow green" is not the scheme's rule (a workflow that blocks only
#   when red, one that runs only for some paths): the scheme's own command. It gets the commit as
#   its one argument (with lanes, the run's lane as a second) and answers by exit code: 0 green, 1 red, 2 running, 3 not started (no run yet,
#   or still queued), 4 ended without a verdict (cancelled, the runner lost, its jobs skipped);
#   anything else: no answer this time. What it prints is shown when CI is red. It must judge the
#   newest run on that commit.
CI_WORKFLOWS=''
CI_STATUS=''
# Lanes: off while LANES is empty, and then every landing is full, as above. LANES is the repo path of the scheme's
#   lane map (tools/lanes), always read from $BRANCH's copy, never the landing's, so a commit can't loosen its own
#   lane. A map line is "<lane> <pattern>...": a path takes the lane of the first line with a pattern that matches
#   it, and a path no line matches is full. Patterns are bash case patterns, where * also matches /; '#' starts a
#   comment. A lane is light, full, or a lower-case word naming a partial lane (fast, android, py); any other word
#   reads as full. The map itself, tools/land.sh, tools/land.local.sh and .github/* are full whatever it says.
#   A commit's lane is over what it changes since the commit it was rebased onto (main, or the commit of the one ahead
#   in the stack): every path light is light; light and one partial lane P is P; two partial lanes, a full or unlisted
#   path, no change at all, or a git failure is full. With batches a run takes the lane of its batch's whole range,
#   from the commit under its first member to the one pushed.
#   light: runs CHECK_LIGHT (none while it is empty), pushes nothing and starts no CI: it is green once checked, and
#     still lands only on top of main in its place in line (behind a running CI: right after that one lands).
#   a partial lane, fast: runs CHECK_FAST (CHECK while unset; '' none), pushes to land/fast/<branch> and waits for
#     CI_WORKFLOWS_FAST (CI_WORKFLOWS while unset; '' runs no CI, like light); a run may skip the jobs named in
#     CI_SKIPS_FAST, split by spaces. The setting names take the lane in upper case.
#   full: CHECK and CI_WORKFLOWS, pushed to land/full/<branch>.
#   A workflow picks its lanes by its push branches ('land/full/**', 'land/fast/**'), a job it skips on one by
#   `if: ${{ !startsWith(github.ref_name, 'land/fast/') }}`. tools/land.sh --lane [<commit>] [<base>] prints
#   "<lane> <the path that decided it>" for what <commit> (HEAD) changes since it forked from <base> ($BRANCH), by
#   $BRANCH's map, and exits.
LANES=''
CHECK_LIGHT=''
# How many landings at the front of the line run CI at once, each on top of the ones ahead of it
# (below, "The stack"). 1: only the head of the line. Runners that can't carry three runs at once: 2.
CI_STACK=${LAND_STACK_DEPTH:-3}
# How many landings share one CI run (below, "Batches"): the stack then counts batches, and only the last
# of each batch runs CI. 1: every landing runs its own, as above. A deep line on slow CI: 3 or 4.
CI_BATCH=${LAND_BATCH:-1}
# 0: main stays in the main checkout and is never pushed (a scheme whose origin isn't its own).
PUSH_MAIN=1
# Fast mode: the paths (bash case patterns, where * also matches /, split by spaces) that keep a land on the full gate
# besides the pipeline's own files: 'migrations/* src/auth/*'.
FAST_FULL=''
# Fast mode's culprit search: the check on one test file ({file}), as 'node --test {file}' or 'pytest {file}'. Set,
# a red over several lands reruns only the failing files on each commit; '' reruns the whole CHECK.
CHECK_FILE_CMD=''

say() { echo "land: $*" >&2; }
refuse() { say "$*"; exit 1; }
park() { say "$*"; exit 75; }

# The scheme's own settings and hooks: every value above it sets wins. Plain shell, sourced here under set -e, so
# a command in it that fails (its last line too: a false `[ x ] && y`) stops the landing, loudly.
#   land_after <commit> <branch>  step 7: run once per branch that landed, after main was pushed, with the
#                                 lock and the place in line already free. The head of a batch runs it for each
#                                 member it landed, from its own worktree: only the arguments name the landing.
#                                 A failure (or an exit) in it is only warned about.
#   land_failures                 reads a check's or CI's output on stdin and prints the ids of what failed, one a
#                                 line (known reds and fast mode's ledger match on them): "<file>::<test>" where
#                                 the output names the test, else "<file>". The one below reads node's test runner
#                                 (spec and TAP), pytest and jest (files only) output, and red workflows in CI's:
#                                 a line "<workflow>: completed failure" (or timed_out, or "completed, failure"), its id "ci:<workflow>".
#                                 A scheme on another runner (cargo test) defines its own in land.local.sh.
land_failures() {
  awk '
    function flush() { if (spec != "") print spec; spec = "" }
    /^test at [^ ]+:[0-9]+:[0-9]+/ { flush(); spec = $3; sub(/:[0-9]+:[0-9]+$/, "", spec); next }
    spec != "" && /^\342\234\226 / { n = $0; sub(/^\342\234\226 /, "", n); sub(/ \([0-9.]+m?s\)$/, "", n); print spec "::" n; spec = ""; next }
    { flush() }
    /^not ok / { tap = 1; n = $0; sub(/^not ok [0-9]+ - /, "", n); sub(/ # (SKIP|TODO).*$/, "", n); next }
    tap && /^ *location: / { p = $2; gsub(/\047/, "", p); sub(/:[0-9]+:[0-9]+$/, "", p); print p "::" n; tap = 0; next }
    /^(ok|# Subtest)/ { tap = 0 }
    /^FAILED [^ ]+::/ { print $2; next }
    /^FAIL [^ ]+/ { print $2; next }
    /^[[:space:]]*[^:[:space:]][^:]*: completed,? (failure|timed_out)/ { p = $0; sub(/^[[:space:]]+/, "", p); sub(/: completed.*$/, "", p); print "ci:" p }
    END { flush() }
  '
}
LOCAL=$(dirname "${BASH_SOURCE[0]}")/land.local.sh
if [ -f "$LOCAL" ]; then
  trap 'say "$LOCAL failed (exit $?), so nothing ran: a command in it, or its last line, came out false"' EXIT
  # shellcheck source=/dev/null
  . "$LOCAL"
  trap - EXIT
fi
[[ $PUSH_MAIN =~ ^[01]$ ]] || refuse "PUSH_MAIN is 1 (push main) or 0 (keep it local), not \"$PUSH_MAIN\""

# Lanes (the header at LANES). lane_of <base> <commit> <map's revision>: prints "<lane> <the path that decided it>"
# for the paths <commit> changes since it forked from <base>, by the map as that revision has it.
lane_of() {
  local fork files f i l lane=light why='' words lanes=() pats=()
  { fork=$(git merge-base "$1" "$2" 2>/dev/null) && files=$(git diff --no-renames --name-only -z "$fork" "$2" | tr '\0' '\n'); } 2>/dev/null ||
    { echo "full (couldn't diff ${2:0:12} against ${1:0:12})"; return 0; }
  [ -n "$files" ] || { echo "full (no changes)"; return 0; }
  while read -r -a words || [ "${#words[@]}" -gt 0 ]; do
    l=${words[0]:-}
    [ -n "$l" ] && [[ $l != \#* ]] || continue
    [[ $l =~ ^[a-z][a-z0-9_]*$ && $l != wait && $l != limit ]] || l=full # CHECK_WAIT and CHECK_LIMIT are this script's own
    for i in "${words[@]:1}"; do [[ $i != \#* ]] || break; lanes+=("$l") pats+=("$i"); done
  done < <(git show "$3:$LANES" 2>/dev/null)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case $f in "$LANES" | tools/land.sh | tools/land.local.sh | .github/*) echo "full $f"; return 0 ;; esac
    l=full
    for i in "${!pats[@]}"; do
      case $f in ${pats[i]}) l=${lanes[i]}; break ;; esac
    done
    case $l in
      light) [ -n "$why" ] || why=$f ;;
      full) echo "full $f"; return 0 ;;
      *) if [ "$lane" = light ]; then lane=$l why=$f; elif [ "$lane" != "$l" ]; then echo "full $f"; return 0; fi ;;
    esac
  done <<<"$files"
  echo "$lane $why"
}

# lane_ci <lane>: 0 when its landings run CI, with LW the workflows the built-in reader waits for and LS the jobs a run
# may skip; 1 when they run none.
lane_ci() {
  local v
  LW=$CI_WORKFLOWS LS=''
  if [ -n "$LANES" ] && [ "$1" != full ]; then
    [ "$1" != light ] || return 1
    v=CI_SKIPS_${1^^} && LS=${!v-}
    v=CI_WORKFLOWS_${1^^}
    if [ -n "${!v+set}" ]; then LW=${!v} && [ -n "$LW" ]; return; fi
  fi
  [ -n "$CI_WORKFLOWS$CI_STATUS" ]
}

if [ "${1:-}" = --lane ]; then
  [ $# -le 3 ] || refuse "--lane takes a commit and a base, both optional"
  if [ -z "$LANES" ]; then echo "full (LANES is not set, so every landing is full)"; else lane_of "${3:-$BRANCH}" "${2:-HEAD}" "$BRANCH"; fi
  exit 0
fi

# A turn in its person's Claude container has its own pid namespace: this script there can't see the landings
# running on the host, so it would delete their places in line as dead, and they its own (Theory of Crafting,
# 2026-11-11). Citadel's land tool runs it on the host for such a turn.
[ "${COORDINATOR_CONTAINER:-}" != 1 ] || refuse "this turn runs in a container: call the land tool (mcp__thread) instead, which runs land.sh on the host"

# The line for the land lock. The lock itself is the flock on <.git>/land.lock, on fd 9: that alone
# keeps landings one at a time. The kernel grants a flock in no order, though, so several landings
# waiting on it meant some lost every round and timed out (2026-11-10). So waiters line up first:
# each takes a numbered ticket file in <.git>/land-queue, and only the oldest ticket tries the lock.
#   queue_join <.git dir> <label>   take a ticket at the end of the line
#   queue_look                      one look at the line: Q_AHEAD is how many are ahead; with none,
#                                   it takes the lock (Q_HELD). Returns 1 only when nothing has moved
#                                   for QUEUE_STALL seconds.
#   queue_phase <text>              say what this one is doing now: the waiters' sign of progress
#   queue_done [ok]                 leave the line; ok: it went all the way, so its time counts
#                                   toward the waiters' estimate
# A ticket is eight lines: "<pid> <the pid's start time>", when it got the lock (0 while it waits),
# its label, its phase, the commit it built ("-" while it has none, "skip" when it can't land where
# it sits; see "The stack"), CI's verdict on that commit ("-", running, green or red) and the commit
# it built on ("-" while it has none; both for "Batches"), and "order": it follows .order (below). A ticket whose
# process is gone is deleted by whoever waits behind it.
# The line's order (#1007) is the holder, then the waiters <.git>/land-queue/.order names (written by Citadel's
# Releases page: a "# " line saying who set it, then ticket numbers, front first), then the rest in arrival order.
# Citadel lists only tickets with the "order" line in it: a landing from an older branch runs a land.sh that waits for
# every lower ticket, so ranking it could leave two waiting on each other. For the same reason a waiting one is a
# barrier: nobody who arrived after it goes ahead of it, so .order ranks the waiters between two such ones only among
# themselves (had a later one counted itself ahead, both would take the lock as the holder left: The Trans Agenda #76).
# Citadel never ranks a waiter behind such a one either, so a land.sh from before that rule, which ranks .order's
# waiters ahead of every other, sees the same line as this one.
# A land.sh from a branch older than the line takes the flock directly; the head of the line waits
# for it like for anyone else.
# The same line as Citadel's own tools/deploy-queue.sh, kept inline so a scheme copies one file: a
# fix to either belongs in both (the stack is only here).
#
# The stack (CI gate on, CI_STACK over 1). A landing can't know its commit until the one ahead has
# landed, so with CI in the way every landing would wait a whole CI round alone. Instead the first
# CI_STACK in line each build now: the head on main, each one behind on the commit in the ticket
# directly ahead of it, and CI runs them side by side. Only the head lands, holding the land lock
# from the moment it is head, and only a commit CI passed that sits exactly on main. When it lands,
# the next one's commit already sits on the new main, so it lands as soon as its own run is green.
# When one leaves without landing (red, a conflict, killed), the commit ahead of everyone behind it
# changes: each of them builds again on the new one and CI runs again. The ones ahead never notice.
# A ticket with no fifth line is from a land.sh older than the stack: nobody builds on it, they
# wait for it to leave.
# The commit is built on a detached HEAD from the branch as it was, so the branch never holds
# another minion's unlanded commits, whatever stops this script.
#
# Batches (CI_BATCH over 1). The stack's unit becomes a batch: the first CI_STACK x CI_BATCH in line (skipped
# tickets left out) build as above, in batches of CI_BATCH, and only the last of each batch (its top: the last in
# line, if the batch isn't full) pushes, so one run covers them all. The next CI_BATCH build ahead: they rebase
# and check, and push once they move into the window. The head lands to the deepest green commit of its batch,
# after checking main and every member's commit sit under it and asking CI about it afresh; each member whose
# commit is then on main says it landed in a batch and leaves. The commits in the middle of a batch never ran CI
# on their own. A red top bisects: the member halfway between the deepest green one (or main) and the shallowest
# red one pushes its commit as it is. Red isn't final until the member's commit sits on main, so nobody marks
# itself skip for it, and nobody pushes with a red ticket ahead. A newcomer that joins a batch that isn't full is
# its new top; the old top's run goes on. A ticket with no sixth line is from a land.sh older than batches: it is
# a batch of its own, never landed by another.
QUEUE_POLL=${LAND_QUEUE_POLL:-1}
CHECK_LIMIT=${LAND_CHECK_TIMEOUT:-1800}
[[ $CHECK_LIMIT =~ ^[0-9]+$ ]] || refuse "LAND_CHECK_TIMEOUT is in whole seconds, not \"$CHECK_LIMIT\""
[[ ${LAND_QUEUE_SLACK:-300} =~ ^[0-9]+$ ]] || refuse "LAND_QUEUE_SLACK is in whole seconds, not \"$LAND_QUEUE_SLACK\""
# CI's limits, in whole seconds, counted for the head of the line only (a run behind it may just be
# waiting for a runner the ones ahead are using): a runner takes the run within CI_START, and the run
# ends within CI_LIMIT. CI is asked every CI_POLL. For CI_GRACE after a push, an older run of the
# same commit may still be the one that answers, so red or lost is not believed yet. For CI_DOWN after a
# landing waited out CI_START or CI_LIMIT, the next ones park as soon as no runner has taken theirs.
for v in LAND_CI_START LAND_CI_TIMEOUT LAND_CI_POLL LAND_CI_GRACE LAND_CI_DOWN; do
  [[ ${!v:-0} =~ ^[0-9]+$ ]] || refuse "$v is in whole seconds, not \"${!v}\""
done
CI_START=${LAND_CI_START:-600} CI_LIMIT=${LAND_CI_TIMEOUT:-2700} CI_POLL=${LAND_CI_POLL:-20} CI_GRACE=${LAND_CI_GRACE:-60} CI_DOWN=${LAND_CI_DOWN:-600}
[[ $CI_STACK =~ ^[1-9][0-9]*$ ]] || refuse "CI_STACK is a number from 1 up, not \"$CI_STACK\""
[[ $CI_BATCH =~ ^[1-9][0-9]*$ ]] || refuse "CI_BATCH is a number from 1 up, not \"$CI_BATCH\""
CI_ON=$CI_WORKFLOWS$CI_STATUS
# With lanes, a lane's own workflows turn the gate on too.
[ -z "$LANES" ] || for v in $(compgen -v CI_WORKFLOWS_); do CI_ON+=${!v}; done
[ -n "$CI_ON" ] || CI_ON='' CI_STACK=1 CI_LIMIT=0 CI_BATCH=1
BATCH='' BUILDERS=$CI_STACK BISECT=0 # BUILDERS: how many in line build at once
if [ "$CI_BATCH" -gt 1 ]; then
  BATCH=1 BUILDERS=$(((CI_STACK + 1) * CI_BATCH))
  while [ $((1 << BISECT)) -lt "$CI_BATCH" ]; do BISECT=$((BISECT + 1)); done # a red batch's bisect: ceil(log2 CI_BATCH) more runs
fi
# Give up after this long with no change at the head of the line. The head's longest single phases
# are the check (which may wait for the checks of the ones stacked behind it) and the CI run (with batches,
# the runs of a bisect too), so the limit is those plus slack (the 30 s a check gets to die, the 60 s push):
# it stays longer than them whatever a scheme sets them to.
# shortcut: a waiter counts with its own limits, not the holder's; write the holder's into its
# ticket if landings in one scheme ever run with different limits.
QUEUE_STALL=$((CHECK_LIMIT * BUILDERS + CI_LIMIT * (1 + BISECT) + ${LAND_QUEUE_SLACK:-300}))
# The wait for the check lock: the checks ahead of this one (at most BUILDERS, each within CHECK_LIMIT, and half the
# slack for the 30 s each may take to die) end within it, so past it the check holding it is stopped (a SIGSTOP, a
# frozen cgroup) or hung. Shorter than QUEUE_STALL, so the one waiting refuses before the ones behind it give up.
CHECK_WAIT=$((CHECK_LIMIT * BUILDERS + ${LAND_QUEUE_SLACK:-300} / 2))
QUEUE_TYPICAL=300 # a landing's length until some have been timed here
QUEUE_TICKET='' Q_DIR='' Q_N='' Q_ME='' Q_LABEL='' Q_AHEAD=0 Q_PRED='' Q_PREDNAME='' Q_HELD='' Q_LAST='' Q_SINCE=0 Q_SAID='' Q_LINE=() Q_ORDER=() Q_BY=''

# "<pid> <start time>" of a live process, or nothing. The start time tells a reused pid apart.
queue_proc() {
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 0
  stat=${stat##*) } # the command's name may hold spaces
  # shellcheck disable=SC2086
  set -- "$1" $stat
  # A zombie (Z, or X while it is reaped) is dead, though its /proc entry stays until its parent waits on it.
  case $2 in Z | X | x) return 0 ;; esac
  echo "$1 ${21}"
}

# The state letter of a process: T or t is stopped (a SIGSTOP), and so is a process in a frozen cgroup.
queue_state() {
  local stat cg
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 0
  stat=${stat##*) }
  stat=${stat%% *}
  # A frozen cgroup (systemctl freeze, a paused container) leaves its processes in state S: its cgroup.events says it.
  if [[ $stat != [Tt] ]] && cg=$(grep -m 1 '^0::' "/proc/$1/cgroup" 2>/dev/null) &&
    grep -qx 'frozen 1' "${LAND_QUEUE_CGROUP:-/sys/fs/cgroup}${cg#0::}/cgroup.events" 2>/dev/null; then stat=T; fi
  echo "$stat"
}

queue_write() { # <file> <pid and start> <got> <label> <phase> <commit> <verdict> <base>: by a rename, so nobody reads half a ticket
  printf '%s\n' "$2" "$3" "$4" "$5" "$6" "$7" "$8" order >"$1.tmp$$" && mv -f "$1.tmp$$" "$1"
}

queue_set() { # <line, from 0> <text>: change one line of this landing's ticket
  local t=$QUEUE_TICKET l
  [ -n "$t" ] && [ -e "$t" ] || return 0
  mapfile -t l 2>/dev/null <"$t" || return 0
  l[$1]=$2
  [ "$1" != 5 ] || [ "$mode" != build ] || l[5]=old # a build is a batch of its own: no gated landing's batch takes it in
  queue_write "$t" "${l[0]:-}" "${l[1]:-0}" "${l[2]:-}" "${l[3]:-}" "${l[4]:--}" "${l[5]:--}" "${l[6]:--}" 2>/dev/null || true
}

queue_phase() { queue_set 3 "$1"; }

queue_done() {
  local t=$QUEUE_TICKET l took
  [ -n "$t" ] && [ -e "$t" ] || return 0
  mapfile -t l 2>/dev/null <"$t" || true
  # How long it held the lock, for the next waiters' estimate (the newest 5 are kept). Not a run that
  # stopped early (a conflict, a red check): a few of those would promise everyone a one-minute wait.
  if [ "${1:-}" = ok ] && [ "${l[1]:-0}" -gt 0 ] 2>/dev/null; then
    took=$(dirname "$t")/.took
    { tail -n 4 "$took" 2>/dev/null; echo $(($(date +%s) - l[1])); } >"$took.tmp$$" && mv -f "$took.tmp$$" "$took"
  fi 2>/dev/null
  rm -f "$t"
}

# The tickets in line order (the header at "The line's order"), as Q_ORDER, and who set .order, as Q_ORDER_BY.
queue_order() {
  local t l i=0 old=0 seg keys=()
  local -A rank=()
  Q_ORDER=() Q_ORDER_BY=''
  [ ! -f "$Q_DIR/.order" ] || while read -r t; do
    if [[ $t =~ ^[0-9]{10}$ ]]; then rank[$t]=$((i += 1)); elif [[ $t == '# '* ]]; then Q_ORDER_BY=${t#\# }; fi
  done <"$Q_DIR/.order" 2>/dev/null || true
  for t in "$Q_DIR"/[0-9]*; do
    t=${t##*/}
    [[ $t =~ ^[0-9]+$ ]] && mapfile -t l 2>/dev/null <"$Q_DIR/$t" || continue # not a ticket half-written, or the glob itself
    seg=$(printf '1%05d' "$old") # the waiters from before .order (no "order" line) ahead of it, in arrival order
    if [ "${l[1]:-0}" != 0 ]; then keys+=("0 $t")
    elif [ "${l[7]:-}" != order ]; then keys+=("${seg}3 $t") old=$((old + 1))
    elif [ -n "${rank[$t]:-}" ]; then keys+=("${seg}1$(printf '%010d' "${rank[$t]}") $t")
    else keys+=("${seg}2 $t"); fi
  done
  [ ${#keys[@]} = 0 ] || mapfile -t Q_ORDER < <(printf '%s\n' "${keys[@]}" | LC_ALL=C sort | cut -d' ' -f2)
}

queue_ordinal() {
  case $1 in 1) echo next ;; 2) echo 2nd ;; 3) echo 3rd ;; *) echo "${1}th" ;; esac
}

queue_join() {
  Q_DIR=$1/land-queue Q_LABEL=$2
  mkdir -p -m 700 "$Q_DIR"
  # Unopened, it leaves a bare shell error, or a flock one a second (Citadel's drill, F12b).
  if ! { exec 9>"$1/land.lock"; } 2>/dev/null; then
    echo "queue: can't open the land lock $1/land.lock for writing, so nothing landed: a person needs to look at it" >&2
    return 1
  fi
  Q_ME=$(queue_proc $$)
  # The ticket and its number, under a lock of its own that is only ever held for these few lines: the
  # ticket is in the folder before the next number goes out, so nobody behind it can miss it.
  Q_N=$(
    exec 8>"$Q_DIR/.seq.lock"
    flock 8
    n=$(cat "$Q_DIR/.seq" 2>/dev/null) || n=0
    # Junk in it (F12c) gave out a number already in line: number on from the newest ticket instead (an empty one,
    # from a write cut off, quietly).
    if ! [[ $n =~ ^[0-9]{1,10}$ ]]; then
      t=$(find "$Q_DIR" -maxdepth 1 -regex '.*/[0-9]+' -printf '%f\n' 2>/dev/null | sort | tail -n 1)
      [ -z "$n" ] || echo "queue: $Q_DIR/.seq held no ticket number (\"$(head -c 40 <<<"$n")\"); numbering goes on from the newest ticket, $((10#${t:-0}))" >&2
      n=${t:-0}
    fi
    n=$(printf '%010d' $((10#$n + 1)))
    queue_write "$Q_DIR/$n" "$Q_ME" 0 "$Q_LABEL" waiting - "$UNRUN" -
    echo "$((10#$n))" >"$Q_DIR/.seq"
    echo "$n"
  )
  QUEUE_TICKET="$Q_DIR/$Q_N" Q_SINCE=$SECONDS
  queue_order
  Q_BY=$Q_ORDER_BY # an order set before this joined is no news to it
}

queue_look() {
  local q=$Q_DIR t l ahead=0 head="" headname="" headpid="" sig typical sum count line detail look
  Q_PRED='' Q_PREDNAME='' Q_LINE=()
  queue_order
  if [ "$Q_ORDER_BY" != "$Q_BY" ]; then
    Q_BY=$Q_ORDER_BY
    # Said before its place, which follows at once (Citadel reads the place from the last "queue:" line).
    [ -z "$Q_BY" ] || [ -n "$Q_HELD" ] || { echo "queue: $Q_BY" >&2; Q_LAST=''; }
  fi
  for t in "${Q_ORDER[@]}"; do
    [ "$t" != "$Q_N" ] || break
    t=$q/$t
    mapfile -t l 2>/dev/null <"$t" || continue
    # Its process is gone (killed, or its turn was stopped): it leaves the line.
    if [ -z "${l[0]:-}" ] || [ "$(queue_proc "${l[0]%% *}")" != "${l[0]}" ]; then
      rm -f "$t"
      continue
    fi
    # A waiter that is stopped (a SIGSTOP, a frozen cgroup) holds no land lock, so it is passed over; it tries for the
    # lock like the head once it wakes. Those this one passed so are waiting on its lock, not ahead of it. A check it
    # was running keeps the check lock: CHECK_WAIT bounds that.
    if [ "${l[1]:-0}" = 0 ] && { [ -n "$Q_HELD" ] || [[ $(queue_state "${l[0]%% *}") == [Tt] ]]; }; then continue; fi
    ahead=$((ahead + 1))
    [ -n "$head" ] || { head="${l[*]}" headname="${l[2]:-?}, ${l[3]:-?}" headpid=${l[0]%% *}; }
    # The last one seen is the one directly ahead. "skip": that one is red or in conflict where it sits, and
    # lands only if what is ahead of it fails, so the ones behind build on the one ahead of it meanwhile.
    # Q_LINE: the ones ahead that aren't skipped, for batches: label, commit, verdict ("old" from a land.sh older than
    # batches), base, pid.
    [ "${l[4]:-}" = skip ] || { Q_PRED=${l[4]:-} Q_PREDNAME=${l[2]:-?}; Q_LINE+=("${l[2]:-?} ${l[4]:--} ${l[5]:-old} ${l[6]:--} ${l[0]}"); }
  done
  Q_AHEAD=$ahead
  [[ $Q_PRED =~ ^[0-9a-f]{40,}$ ]] || Q_PRED='' # "-": it has built nothing yet; no line: older than the stack

  if [ "$ahead" = 0 ]; then
    [ -z "$Q_HELD" ] || return 0
    # A short blocking wait, not a poll: the lockers outside the line block in the kernel, and a poller would lose to every one of them.
    if flock -w "$QUEUE_POLL" 9; then
      [ -z "$Q_SAID" ] || echo "queue: got the land lock" >&2
      Q_HELD=1
      queue_set 1 "$(date +%s)"
      return 0
    fi
    # Held by a landing behind this one in line: it passed this one while it was stopped.
    head="outside $Q_N" headname="a landing started from a branch whose land.sh is older than the line"
    for t in "$q"/[0-9]*; do
      [[ ${t##*/} =~ ^[0-9]+$ ]] && mapfile -t l 2>/dev/null <"$t" || continue
      [ "${l[1]:-0}" != 0 ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]:-}" ] || continue
      head="${l[*]}" headname="${l[2]:-?}, ${l[3]:-?}"
      break
    done
  fi

  # Progress is any change at the head of the line: a new head, or the head's next phase.
  sig="$ahead $head"
  if [ "$sig" != "$Q_LAST" ]; then
    Q_LAST=$sig Q_SINCE=$SECONDS
    line="$(queue_ordinal $((ahead + 1))) in line for the land lock"
    if [ "$ahead" -gt 0 ]; then
      sum=0 count=0
      [ ! -f "$q/.took" ] || while read -r typical; do [[ $typical =~ ^[0-9]+$ ]] && sum=$((sum + typical)) count=$((count + 1)); done <"$q/.took" || true
      typical=$((count ? sum / count : QUEUE_TYPICAL))
      [ "$typical" -gt 0 ] || typical=1
      line="$line, about $((((ahead + CI_BATCH - 1) / CI_BATCH * typical + 59) / 60)) min"
    fi
    echo "queue: $line (ahead: $headname)" >&2
    [ -n "$Q_SAID" ] || echo "queue: the wait has no time limit while the line moves, so run this in the background with a long timeout rather than under a 10 min limit: a run that is stopped loses its place" >&2
    Q_SAID=1
  elif [ $((SECONDS - Q_SINCE)) -ge "$QUEUE_STALL" ]; then
    detail="" look="what holds the land lock (${q%/land-queue}/land.lock)"
    if [ "$ahead" -gt 0 ]; then
      detail=$(queue_state "$headpid")
      case $detail in T | t) detail="; pid $headpid, stopped" ;; *) detail="; pid $headpid, state ${detail:-?}" ;; esac
      if flock -n 9; then
        flock -u 9
        detail="$detail; the lock is free" look="pid $headpid, which is first in line and is not taking the lock,"
      else
        detail="$detail; the lock is held"
      fi
    fi
    echo "queue: nothing has moved for $(((QUEUE_STALL + 59) / 60)) min (ahead: $headname$detail), so this gave up and nothing landed. A person needs to look at $look before anyone tries again" >&2
    return 1
  fi
}

# Whose check holds the check lock, by the phase in the tickets, for when it never comes.
check_holder() {
  local t l s
  for t in "$Q_DIR"/[0-9]*; do
    [[ ${t##*/} =~ ^[0-9]+$ ]] && [ "$t" != "$QUEUE_TICKET" ] && mapfile -t l 2>/dev/null <"$t" || continue
    [[ ${l[3]:-} == "running the check"* ]] || continue
    s=$(queue_state "${l[0]%% *}")
    case $s in T | t) s=stopped ;; *) s="state ${s:-?}" ;; esac
    echo "${l[2]:-?}'s check holds it (its landing is pid ${l[0]%% *}, $s)"
    return 0
  done
  echo "no landing in line says it is running its check, so it may be one a killed landing left running"
}

# Numbered things: what minions number in parallel, so two can take the same "next" one and both
# land it (git merges two identical version bumps without a word). The Project facts line lists
# entries split by ';', each a kind, a path glob and, for ids and version, a Perl regex in quotes:
#   - **Numbered things:** files src/db/migrations/NNNN-*.sql; ids docs/unproven.md "\*\*U(\d+)\.";
#     version addons/*/*.toc "^## Version: (.+)"
# files: the digits in place of NNNN in a file name; two files with one number clash.
# ids: what the regex's group matches, line by line, across the glob's files; an id the branch
#   makes appear twice clashes (duplicates main already had are left alone).
# version: the first match in each file; it clashes when the branch and main both changed it since
#   the branch started. In globs, * and ? stop at '/'. Backticks are ignored.
# Args: the revisions main is, the branch started from and the branch was before the rebase. Prints
# one line per clash and exits 1; exits 0 when there are none and 2 when the line doesn't parse.
numbered_clashes() {
  # No single quote anywhere in the Perl, comments included: it would end the bash string.
  perl -e '
    use strict; use warnings;
    my ($facts, $main, $fork, $pre) = @ARGV;
    sub git { # its output, or undef when it fails; its errors are not shown
      my @args = @_;
      my $pid = open(my $fh, "-|") // die "fork: $!\n";
      if (!$pid) { open STDERR, ">", "/dev/null"; exec "git", @args or exit 127 }
      local $/; my $out = <$fh>; close $fh;
      return $? ? undef : ($out // "");
    }
    sub git_or_die { my $out = git(@_); defined $out or die "git @_ failed\n"; $out }
    sub norm { $_[0] =~ /^\d+$/ ? $_[0] + 0 : $_[0] }
    sub glob_re { # a glob as an anchored regex; with $nums, NNNN captures digits
      my ($glob, $nums) = @_;
      my $re = join "", map { $_ eq "*" ? "[^/]*" : $_ eq "?" ? "[^/]" : ($nums && /^N{2,}$/) ? "(\\d+)" : quotemeta }
        $glob =~ /(N{2,}|[*?]|[^*?N]+|N)/g;
      qr/^$re$/;
    }
    sub highest { my @n = grep /^\d+$/, @_; @n ? " (the highest so far is " . (sort { $b <=> $a } @n)[0] . ")" : "" }

    my %head = map { $_ => 1 } split /\0/, git_or_die("ls-tree", "-rz", "--name-only", "HEAD");
    exit 0 unless $head{$facts};
    my $line;
    for (split /\n/, git_or_die("show", "HEAD:$facts")) { # a wrapped line goes on until the next bullet
      if (defined $line) { last if /^\s*-/ || /^\s*\z/ || /^\S/; $line .= " $_"; next }
      $line = $1 if /^\s*-\s*\*\*Numbered things:\*\*\s*(.*)/;
    }
    exit 0 unless defined $line;
    $line =~ tr/`//d; $line =~ s/^\s+|\s+$//g;
    exit 0 if $line eq "" || $line =~ /^none\b/i;
    my $bad = sub { print "the Numbered things line in $facts does not parse: $_[0]\n"; exit 2 };
    my @entries = ([]);
    while ($line =~ /\G\s*(?:"((?:[^"\\]|\\.)*)"|(;)|([^\s;"]+))/gc) {
      if (defined $2) { push @entries, []; next }
      push @{$entries[-1]}, defined $1 ? $1 =~ s/\\"/"/gr : $3;
    }
    $line =~ /\G\s*$/gc or $bad->("an unclosed quote or a stray character");
    my $files = join "", map "$_\n", sort keys %head;
    my %added = map { $_ => 1 } split /\0/, git_or_die("diff", "-z", "--name-only", "--no-renames", "--diff-filter=A", $main, "HEAD");
    my @clashes;
    for my $e (grep @$_, @entries) {
      my ($kind, $glob, $rx, @rest) = @$e;
      my $what = join " ", @$e;
      if ($kind eq "files") {
        (defined $glob && !defined $rx && $glob =~ /N{2,}/) or $bad->("\"$what\": files takes one glob with NNNN where the number goes");
        my $re = glob_re($glob, 1); my %by;
        for (sort keys %head) { push @{$by{$1 + 0}}, $_ if $_ =~ $re }
        for my $f (grep { $added{$_} && $_ =~ $re } sort keys %head) {
          my $n = ($f =~ $re)[0] + 0;
          my @others = grep $_ ne $f, @{$by{$n}};
          push @clashes, "$f takes number $n, which @others already has" . highest(keys %by) if @others;
        }
        next;
      }
      ($kind eq "ids" || $kind eq "version") && defined $rx && !@rest or $bad->("\"$what\": the kinds are files <glob>, ids <glob> \"<regex>\" and version <glob> \"<regex>\"");
      my $re = eval { qr/$rx/m } or $bad->("\"$what\": the regex does not compile: $@");
      my $path_re = glob_re($glob, 0);
      my @matched = grep { $_ =~ $path_re } sort keys %head;
      if ($kind eq "ids") {
        # A clash is an id the branch has more of than main, past one: old duplicates on main are left alone.
        my (%count, %was, %where);
        for my $f (@matched) {
          for (map { /$re/g } split /\n/, git_or_die("show", "HEAD:$f")) { $count{norm($_)}++; $where{norm($_)} = $f }
          $was{norm($_)}++ for map { /$re/g } split /\n/, git("show", "$main:$f") // "";
        }
        push @clashes, "$where{$_} has id $_ " . ($was{$_} ? "twice: this branch adds one and main already has it" : "$count{$_} times, all from this branch") . highest(keys %count)
          for grep { $count{$_} > 1 && $count{$_} > ($was{$_} // 0) } sort keys %count;
        next;
      }
      for my $f (@matched) {
        my ($was, $mine, $theirs) = map { my $t = git("show", "$_:$f"); defined $t && $t =~ $re ? ($1 // $&) : "" } $fork, $pre, $main;
        push @clashes, "$f: this branch moves its version from $was to $mine, but main moved it to $theirs since the branch started"
          if $mine ne $was && $theirs ne $was;
      }
    }
    print "$_\n" for @clashes;
    exit(@clashes ? 1 : 0);
  ' "$FACTS" "$@"
}

# The undo guard (#677, after Peek Auras #361's tools/undo-guard.sh): prints, and exits 1 on, the commits among
# <onto>'s last 60 that this branch reverts without seeing them. A stale squash does that behind a clean
# fast-forward with CI green: `git reset --soft main` from a branch that started further back keeps its old files
# (Peek Auras #309 undid six landings so). A commit counts when the branch removes 90% of the lines it added (4 or
# more, repeats included, of 12+ characters, compared trimmed; a removed line is a move, not a removal, only as
# many times as the branch adds that text back in any file, so a revert that also puts back older copies of a
# repeated line like "linked: null" still counts: The Trans Agenda #66) and, if it removed lines, puts at least half
# of those back. shortcut: the add-backs go to the branch's other removals of that text first, so merging two
# identical files, one of them recent, reads as undoing it (none in ~1,090 landings); if one shows up, credit the
# add-backs to the commit's own lines first, which scores a stale squash of several exports lower (96% to 93%).
# Commits of the branch's own ticket don't count (ticket/N-… against a subject's leading "#N" or "WIP #N" or last
# "#N)"); an undo that is meant names each one in a message line "Undoes: <sha>" (git revert's "This reverts commit
# <sha>" counts too). Tried on 2026-11-14 over ~690 landings in four schemes: it refused the stale squash, two
# deliberate removals of another minion's work (what the trailer is for), and nothing else; the line counts of
# 2026-11-15 refused the same over ~1,090 landings in seven.
undo_guard() {
  local base
  base=$(git merge-base HEAD "$1") || return 2
  perl -e '
    use strict; use warnings; use List::Util qw(min max);
    my ($base, $ticket) = @ARGV;
    sub run { my $out = `$_[0]`; $? == 0 or die "undo guard: $_[0] failed\n"; $out }
    sub lines { # how many times a diff adds (+) or removes (-) each trimmed line of 12+ characters, keyed by file
      my ($sign, $cmd) = @_; my (%set, $f);
      for (split /\n/, run("git -c core.quotePath=false $cmd")) {
        if (/^diff /) { undef $f; next }
        if (/^--- (?:a\/(.*)|\/dev\/null)$/) { $f = $1; next } # a deleted file is named here only
        if (/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/) { $f = $1 // $f; next }
        next if /^@@/ || !defined $f;
        $set{"$f\0$1"}++ if /^\Q$sign\E\s*(.*?)\s*$/ && length $1 >= 12;
      }
      \%set;
    }
    sub text { (split /\0/, $_[0], 2)[1] }
    sub ticket { my $s = shift; return $1 if $s =~ /^(?:WIP:? )?#(\d+)\b/; my @t = $s =~ /#(\d+)\)/g; @t ? $t[-1] : "" }
    my @named = run("git log --format=%B $base..HEAD") =~ /^(?:Undoes: *|This reverts commit )([0-9a-f]{7,40})\b/mg;
    my $diff = "diff -U0 --no-renames --no-color $base HEAD";
    my ($removed, $added) = (lines("-", $diff), lines("+", $diff));
    my %net; # per text, how many more lines the branch removes than adds back anywhere
    $net{text($_)} += $removed->{$_} for keys %$removed;
    $net{text($_)} -= $added->{$_} for keys %$added;
    my @bad;
    for (split /\n/, run("git log --no-merges --format=\"%H %s\" -60 $base")) {
      my ($c, $s) = /^(\S+) (.*)/ or next;
      next if $ticket ne "" && ticket($s) eq $ticket;
      next if grep { index($c, $_) == 0 } @named;
      my $show = "diff-tree -p --root -U0 --no-renames --no-color --format= $c";
      my $put = lines("+", $show);
      my ($n, $gone, %here) = (0, 0);
      for (keys %$put) { $n += $put->{$_}; $here{text($_)} += min($put->{$_}, $removed->{$_} // 0) }
      next if $n < 4;
      $gone += min($here{$_}, max(0, $net{$_} // 0)) for keys %here;
      next if $gone < 0.9 * $n;
      my $took = lines("-", $show);
      my $back = grep { $added->{$_} } keys %$took;
      next if keys %$took && $back < 0.5 * keys %$took;
      push @bad, sprintf("  %s %s (%d of the %d lines it added are removed here)", substr($c, 0, 12), $s, $gone, $n);
    }
    exit 0 unless @bad;
    print join("\n", @bad), "\n";
    exit 1;
  ' "$base" "$(sed -nE 's|^ticket/([0-9]+)-.*|\1|p' <<<"$branch")"
}

# The early check: whether <commit> (the branch as it was) would rebase onto $BRANCH's tip cleanly, by git merge-tree,
# which touches no worktree, index or ref. On a conflict it says the refusal, naming the files, and fails; a git that
# can't tell (too old, exit 2 and up) counts as clean, and the rebase itself decides. shortcut: a three-way merge, not a
# replay commit by commit. A branch that changes a line and changes it back can pass here and still stop in the
# rebase, which catches it as before; and a branch whose commit main already has as a cherry-pick, with a later commit
# on the same lines, is refused here though the rebase would skip it: the git rebase the refusal names then goes
# through clean. Upgrade to a replay if that bites.
# A third argument checks onto a build instead: --check --into build/<n>.
early_conflict() {
  local out rc=0 files onto=${3:-$BRANCH} fix
  out=$(git -c "attr.tree=refs/heads/$onto" merge-tree --write-tree --name-only --no-messages "refs/heads/$onto" "$1" 2>/dev/null) || rc=$?
  [ "$rc" = 1 ] || return 0
  files=$(sed -n '2,${/^$/q;p}' <<<"$out" | sort -u | sed ':a;N;$!ba;s/\n/, /g')
  case $mode in
    build) fix="Take $BRANCH in on your branch by hand (git merge $BRANCH), resolve it keeping both sides, run tools/land.sh --into $build --full, then this again" ;;
    into | full) fix="On conflicts: run git rebase $onto, resolve them keeping the other feeders' changes, re-test, commit, then run this again" ;;
    *) fix="On conflicts: run git rebase $BRANCH, resolve them keeping the other minions' changes, re-test, commit, then run this again" ;;
  esac
  say "$branch won't $([ "$mode" = build ] && echo "merge $onto in" || echo "rebase onto $onto") ($(git log -1 --format='%h "%s"' "refs/heads/$onto")) cleanly, by git merge-tree $2, so nothing landed${files:+; conflicted files: $files}. $fix"
  return 1
}

# --check: only the early check, changing nothing; exit 3 on a conflict, else 0. Citadel runs it at hand_off_land,
# with the land's own arguments.
check='' verify=''
[ "${1:-}" != --check ] || { check=1; shift; }
[ "${1:-}" != --verify ] || { verify=1; shift; }
mode=land build='' files=() # mode: land, into, full or build (the header's "Build branches")
case ${1:-} in
  '') ;;
  --into)
    build=${2:-}
    [[ $build =~ ^build/[1-9][0-9]{0,5}$ ]] || refuse "--into takes a build branch, build/<n>, then the test files the change touched (or --full)"
    shift 2
    mode=into
    if [ "${1:-}" = --full ]; then
      mode=full
      shift
      [ $# -eq 0 ] || refuse "--full runs the whole check and CI: name no test files with it"
    fi
    files=("$@") ;;
  --build) [ $# -eq 1 ] || refuse "--build takes nothing more: run it from the build minion's branch at the build's tip"; mode=build ;;
  *) refuse "takes no arguments besides --check, --verify, --lane, --into build/<n> <test files>, --into build/<n> --full and --build" ;;
esac
[ -z "$verify" ] || [ "$mode" = land ] || refuse "--verify takes no other arguments"
here=$(git rev-parse --show-toplevel)
cd "$here"
gitdir=$(git rev-parse --absolute-git-dir)
branch=$(git branch --show-current)
[ -z "$verify" ] || branch=verify LAND_KNOWN_RED='' LAND_FAST='' # its scratch branch is land/verify; it judges, so nothing is known red
# --build ships the build whose tip the branch is at. After the recovery below, which may put the branch back.
find_build() {
  build=$(git for-each-ref --points-at HEAD --format='%(refname:lstrip=2)' 'refs/heads/build/')
  [[ ! $build =~ ^build/[1-9][0-9]{0,5}$ ]] || return 0
  [ -z "$check" ] || exit 0 # the land itself refuses it
  local ahead='' # one merge ahead of a build: $BRANCH merged in by hand
  [ -n "$build" ] || ! git rev-parse -q --verify HEAD^2 >/dev/null || ahead=$(git for-each-ref --points-at HEAD^1 --format='%(refname:lstrip=2)' 'refs/heads/build/' | head -n 1)
  [ -z "$ahead" ] || refuse "$branch is one merge ahead of $ahead (a merge of $BRANCH by hand): run tools/land.sh --into $ahead --full first, then this again. Nothing landed"
  refuse "$branch is not at the tip of a build branch${build:+ (it is at more than one: $(echo $build))}: bring it to its build's tip first (git merge --ff-only build/<n>). Nothing landed"
}
if [ -n "$check" ]; then
  { [ -n "$branch" ] && [ "$branch" != "$BRANCH" ]; } || exit 0 # the land itself refuses these
  [ "$mode" != build ] || find_build
  case $mode in
    land | build) early_conflict HEAD "at hand-off" || exit 3 ;;
    into) git merge-base --is-ancestor "refs/heads/$build" HEAD 2>/dev/null || ! git show-ref -q --verify "refs/heads/$build" || early_conflict HEAD "at hand-off" "$build" || exit 3 ;;
  esac
  exit 0 # --full: no rebase, so nothing to check
fi
# A landing that was killed outright left this worktree on its detached commit, and the branch where it was.
if [ -z "$branch" ] && [ -s "$gitdir/land-branch" ]; then
  git rebase --abort 2>/dev/null || true
  { read -r branch; read -r left; } <"$gitdir/land-branch" || true
  # Anything committed here since would be lost with the detached commit, which may also hold other minions' unlanded work.
  [ "$(git rev-parse HEAD)" = "$left" ] || refuse "an earlier landing was stopped mid-way and left $here on a detached commit (${left:0:12}), and HEAD has moved since. If you committed here, put those commits on $branch (git checkout $branch, then git cherry-pick each one of yours); otherwise just git checkout $branch. Then run this again"
  git checkout -q "$branch" || refuse "an earlier landing was stopped mid-way and $here could not go back onto $branch (above); a person needs to look"
  say "an earlier landing here was stopped mid-way: $here is back on $branch as it was"
fi
rm -f "$gitdir/land-branch"
{ [ -n "$branch" ] && [ "$branch" != "$BRANCH" ]; } || refuse "run it from a minion's branch, not $BRANCH or a detached HEAD"
[ "$mode" != build ] || find_build
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "$here has uncommitted changes: commit them first"
case $mode in
  land)
    # The guard: a branch on a build's commits (a feeder that ran the usual command) would put part of that build live.
    while read -r ref; do
      for mb in $(git merge-base --all HEAD "$ref" 2>/dev/null); do
        git merge-base --is-ancestor "$mb" "refs/heads/$BRANCH" ||
          refuse "$branch carries commits of ${ref#refs/heads/} that $BRANCH doesn't have, so landing it would put part of that build live; nothing landed. Merge it into the build instead: tools/land.sh --into ${ref#refs/heads/} <the test files you touched>"
      done
    done < <(git for-each-ref --format='%(refname)' 'refs/heads/build/')
    ;;
  into | full)
    [[ $branch != build/* ]] || refuse "run it from a feeder's branch or the build minion's own, not from a build branch"
    git show-ref -q --verify "refs/heads/$build" || refuse "$build doesn't exist: its build minion makes it (git branch $build $BRANCH), so nothing merged"
    for f in "${files[@]}"; do [ -f "$f" ] || refuse "$f is not a file in $here, so nothing merged: name the test files the change touched, from the worktree's top"; done
    ;;
esac
# Fast mode (the header): the first path the branch changes since it forked from main that keeps the full gate.
fast_full() {
  local fork f p
  fork=$(git merge-base "refs/heads/$BRANCH" HEAD 2>/dev/null) || { echo "(couldn't find where it forked from $BRANCH)"; return; }
  while IFS= read -r -d '' f; do
    case $f in tools/land.sh | tools/land.local.sh | .github/*) echo "$f"; return ;; esac
    [ -z "$LANES" ] || [ "$f" != "$LANES" ] || { echo "$f"; return; }
    for p in $FAST_FULL; do
      case $f in $p) echo "$f"; return ;; esac
    done
  done < <(git diff --no-renames --name-only -z "$fork" HEAD) # -z: a non-ASCII path as it is, not quoted (Mandate #152)
}
FAST='' UNRUN=- # UNRUN: its ticket's verdict before CI has run
[ "$mode" = land ] || LAND_FAST='' # a whole build takes the full gate, and a merge into one isn't in the line
if [ "${LAND_FAST:-}" = 1 ]; then
  why=$(set -f; fast_full)
  if [ -z "$why" ] && { [ -z "$SMOKE_CMD" ] || [ "${LAND_SMOKE:-1}" = 0 ]; }; then why='a land with no smoke check'; fi
  if [ -z "$why" ]; then
    FAST=1 UNRUN=old CHECK='' LANES='' CI_ON='' CI_WORKFLOWS='' CI_STATUS='' CI_STACK=1 CI_LIMIT=0 CI_BATCH=1 BATCH='' BUILDERS=1 BISECT=0
    # Its ticket says "old" (a land.sh older than batches), so the batches of the gated landings around it never take
    # it in: it lands alone, with no CI run of theirs to wait for.
    say "fast mode: this lands on the smoke check alone; the full suite runs on $BRANCH behind it"
  else
    say "fast mode is on, but $why takes the full gate"
  fi
fi
# A build lands only as the head of the line, on $BRANCH itself, and alone: its ticket says "old" (queue_set), so no
# batch takes it in. The ones behind may still stack on it.
[ "$mode" != build ] || CI_STACK=1 CI_BATCH=1 BATCH='' UNRUN=old
# The main checkout is the first entry of the worktree list.
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
state=$(git -C "$MAIN" rev-parse --absolute-git-dir)

CI_REF=land/$branch
slug=''
if [ -n "$CI_ON" ]; then
  slug=$(git -C "$MAIN" remote get-url origin 2>/dev/null) || refuse "the CI gate is on, but there is no origin remote to run CI from"
  slug=${slug#*github.com[:/]} slug=${slug%.git}
fi
cilog="$state/land-ci-${branch//\//-}.log"
# Never holding the lock: a gh or git left hanging after its timeout mustn't keep it.
hub() { GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 timeout 30 "$@" 9>&- 6>&-; }

pre=$(git rev-parse HEAD) # the branch as it was: every build starts from here
base=''    # the commit the build sits on: main, or the commit of the one directly ahead
tip=''     # the build: $pre rebased onto $base, once it passed the check
blocked='' # why it can't land on $base (a conflict, a clash, a red check, red CI). Final only once it is the head
           # and $base is main: until then the fault may lie in an unlanded commit it sits on, so it waits.
           # shortcut: it waits for the ones ahead to land, not just to turn green; read their verdicts
           # from their tickets if a red landing holding up the ones behind it ever costs real time.
keep=''    # the rebased commit the branch moves to on the way out, if it sits on main by then
green='' pushed='' pushed_at='' retried='' ci_clock=0 ci_begun='' ci_last=-1 landed='' ci_skipped=''
main_pushed='' # step 7 runs land_after only once this is set
lane=full lane_why='' ci_lane=full # this commit's lane (LANES), why, and the lane of the CI run it waits for
verdict=-  # CI's verdict on $tip, as its ticket says it: -, running, green or red
B_NUM=''   # with batches: which batch this one is in, from the head's (1); "Batches" below
fronted='' # with batches: it has been in the head's batch, so CI's limits count
g_last='' g_quiet='' # with batches, the head: when it last asked CI about the commit it lands, and since when with no answer

# CI's verdict on [commit] ($tip if none) in [lane] ($ci_lane if none), by the exit codes in the header at CI_STATUS;
# what it found goes to $cilog. A lane that runs no CI is green. ci_verdict: the same, but red only on failures that
# aren't known reds (known_red); with those waived, it is the other workflows' (ci_open).
ci_verdict() {
  local rc=0
  ci_runs "$@" || rc=$?
  [ "$rc" = 1 ] || return "$rc"
  # A red only on known ids still waits for the workflows running beside it (said once they've all finished).
  if [ "$ci_open" = 0 ]; then known_red "CI on $(git rev-parse --short=12 "${1:-$tip}")" <"$cilog" || return 1; return 0; fi
  known_red x <"$cilog" 2>/dev/null || return 1
  return "$ci_open"
}

# known_red <what>: reads what failed on stdin; true when land_failures finds failures in it and every one is a known
# red (LAND_KNOWN_RED, the header), saying so.
known_red() {
  local id who all='' ids
  [ -n "${LAND_KNOWN_RED:-}" ] || return 1
  ids=$(land_failures | sed "s|^$here/||" | sort -u)
  [ -n "$ids" ] || return 1
  while IFS= read -r id; do
    who=$(awk -F'\t' -v i="$id" '$1 == i || index(i, $1 "::") == 1 { print $2; exit }' <<<"$LAND_KNOWN_RED")
    [ -n "$who" ] || return 1
    all+="; $id: known red, $who"
  done <<<"$ids"
  say "$1 failed only on known reds, so it goes on${all/#;/:}"
}

# ci_open: the same verdict over the workflows that aren't red (0 when they're green), so a waived red waits for the rest.
ci_runs() {
  local sha=${1:-$tip} ln=${2:-$ci_lane} runs w path id status result one failed skipped j rank worst=0 worst_rank=0 open_rank=0 rc=0
  : >"$cilog"
  ci_skipped='' ci_open=0
  lane_ci "$ln" || return 0
  if [ -n "$CI_STATUS" ]; then
    timeout 120 bash -c "$CI_STATUS \"\$@\"" _ "$sha" ${LANES:+"$ln"} >"$cilog" 2>&1 9>&- 6>&- || rc=$?
    # Its lines for workflows still going ("<file>: in_progress …", "<file>: not started …") keep a red from deciding.
    [ "$rc" != 1 ] || ! grep -Eq '^[[:space:]]*[^:[:space:]][^:]*: (in_progress|queued|waiting|pending|requested|not started)' "$cilog" || ci_open=2
    return "$rc"
  fi
  runs=$(hub gh api "repos/$slug/actions/runs?head_sha=$sha&per_page=100" --jq '.workflow_runs | sort_by(.created_at) | reverse | .[] | [.path, .id, .status, .conclusion // "-", .html_url] | @tsv' 2>>"$cilog") || return 5
  for w in $LW; do
    one=3
    while IFS=$'\t' read -r path id status result url; do
      [[ ${path%%@*} == */"$w" ]] || continue
      case $status:$result in
        completed:success)
          # Green only when every job ran: a run whose jobs were skipped (an `if:` that came out false) concludes success too.
          if [ -z "$LS" ]; then
            skipped=$(hub gh api "repos/$slug/actions/runs/$id/jobs?per_page=100" --jq '[.jobs[] | select(.conclusion == "skipped")] | length' 2>>"$cilog") || return 5
          else # the lane's CI_SKIPS_<LANE> may be skipped: the others are counted, by name
            j=$(hub gh api "repos/$slug/actions/runs/$id/jobs?per_page=100" --jq '.jobs[] | select(.conclusion == "skipped") | .name' 2>>"$cilog") || return 5
            skipped=0
            while IFS= read -r j; do [ -z "$j" ] || [[ " $LS " == *" $j "* ]] || skipped=$((skipped + 1)); done <<<"$j"
          fi
          # Only a plain 0 is green; a count is told apart from no answer (ci_ask), which is handled as a lost run.
          if [ "$skipped" = 0 ]; then one=0; else one=4; [ "$skipped" -gt 0 ] 2>/dev/null && ci_skipped="$skipped of the jobs in $w's run"; fi ;;
        completed:failure)
          # Red only when a step failed. A runner that went away mid-run fails its job with the step it was in never finished.
          failed=$(hub gh api "repos/$slug/actions/runs/$id/jobs?per_page=100" --jq '[.jobs[].steps[]? | select(.conclusion == "failure")] | length' 2>>"$cilog") || return 5
          if [ "$failed" -gt 0 ] 2>/dev/null; then one=1; else one=4; fi ;;
        completed:timed_out) one=1 ;;
        completed:*) one=4 ;;
        in_progress:*) one=2 ;;
      esac
      echo "$w: $status $result $url" >>"$cilog"
      break # the newest run of this workflow on the commit
    done <<<"$runs"
    [ "$one" != 3 ] || echo "$w: not started on ${sha:0:12}" >>"$cilog"
    # The worst of the workflows: red, then no verdict, not started, running, green.
    case $one in 1) rank=4 ;; 4) rank=3 ;; 3) rank=2 ;; 2) rank=1 ;; *) rank=0 ;; esac
    [ "$rank" -le "$worst_rank" ] || worst=$one worst_rank=$rank
    [ "$one" = 1 ] || [ "$rank" -le "$open_rank" ] || ci_open=$one open_rank=$rank
  done
  return "$worst"
}

# The commit goes to the scratch branch, which starts CI on it. Deleted first: a push of the commit
# the branch already has (a run to repeat) would start nothing. Forced on purpose: only this script
# writes land/<branch>, so there is no one's work to overwrite. --no-verify: the check ran above.
# CI on $tip, begun: a run of this very commit that is green or going (its pull request's, say) will do;
# otherwise a new one.
# With lanes, a lane that runs no CI is green at once, with no push. With batches the run takes the lane of the batch's
# range, from the commit under its first member (B_BASE[1], from batch_look) to $tip; one not under $tip is full.
ci_start() {
  local rc=0 l
  ci_clock=$SECONDS ci_last=$SECONDS ci_begun=''
  if [ -n "$BATCH" ] && [ -n "$LANES" ]; then
    l="full (${B_BASE[1]:--} is not under ${tip:0:12})"
    ! git merge-base --is-ancestor "${B_BASE[1]:--}" "$tip" 2>/dev/null || l=$(lane_of "${B_BASE[1]}" "$tip" "refs/heads/$BRANCH")
    ci_lane=${l%% *}
    say "its batch's run, from ${B_BASE[1]:0:12} up, takes lane ${l%% *}: ${l#* }"
  fi
  if ! lane_ci "$ci_lane"; then
    green=1 verdict=green
    say "lane $ci_lane runs no CI, so nothing is pushed and ${tip:0:12} is green as checked"
    queue_set 5 green
    queue_phase "checked ${tip:0:12}: lane $ci_lane runs no CI"
    return 0
  fi
  ci_verdict || rc=$?
  case $rc in
    0) green=1 && rm -f "$state/ci-down" && say "CI already passed ${tip:0:12}" ;;
    2) say "CI is already running on ${tip:0:12}" ;;
    *) ci_push ;;
  esac
  verdict=running
  [ -z "$green" ] || verdict=green
  queue_set 5 "$verdict"
  queue_phase "waiting for CI on ${tip:0:12} since $(date +%H:%M)"
}

# With lanes the scratch branch is land/<lane>/<branch>: one a rebuild moved off (its lane changed) goes, with its runs.
ci_push() {
  local ref=land/$branch
  [ -z "$LANES" ] || ref=land/$ci_lane/$branch
  if [ "$ref" != "$CI_REF" ]; then
    [ -z "$pushed" ] || { ci_cancel; hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null || true; }
    CI_REF=$ref
  fi
  [ -n "$pushed" ] || ci_cancel # what a landing of this branch that was killed left running (a landed one's runs go on)
  hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null || true
  hub git push -q --no-verify origin "+$tip:refs/heads/$CI_REF" || refuse "couldn't push ${tip:0:12} to origin's $CI_REF, so CI can't run on it and nothing landed"
  pushed=1 pushed_at=$SECONDS ci_clock=$SECONDS ci_begun=''
  say "waiting for CI on ${tip:0:12} (origin's $CI_REF)"
}

# Stops the scratch branch's runs nobody waits for now, so they don't hold a runner. Best effort. A run of a
# commit already on main is left to finish: main's CI may reuse what it passes.
ci_cancel() {
  local id sha
  while read -r id sha; do
    [ -z "$id" ] || git merge-base --is-ancestor "$sha" "refs/heads/$BRANCH" 2>/dev/null || hub gh api -X POST "repos/$slug/actions/runs/$id/cancel" >/dev/null 2>&1 || true
  done < <(hub gh api "repos/$slug/actions/runs?branch=$CI_REF&per_page=20" --jq '.workflow_runs[] | select(.status != "completed") | [.id, .head_sha] | @tsv' 2>/dev/null)
}

# A CI outage is paid once: a landing that waited out a limit leaves <state>/ci-down ("<when> <why>"), so the ones of
# the next CI_DOWN seconds don't each wait to learn the same thing. ci_down <why> writes it; ci_down_fresh puts what
# to say into $down while it is fresh.
ci_down() { printf '%s %s\n' "$(date +%s)" "$1" >"$state/ci-down" 2>/dev/null || true; }
ci_down_fresh() {
  local at why now
  read -r at why 2>/dev/null <"$state/ci-down" || return 1
  now=$(date +%s)
  [[ $at =~ ^[0-9]+$ ]] && [ $((now - at)) -lt "$CI_DOWN" ] || return 1
  down="CI gave no answer to a landing $((now - at)) s ago ($why), so this one doesn't wait for it and nothing landed; CI is asked again from $(date -d "@$((at + CI_DOWN))" +%H:%M)"
}

# Asks CI about $tip, at most every CI_POLL seconds: sets green, refuses on red, repeats a lost run once, parks at the limits.
ci_ask() {
  local rc=0 waited busy down=''
  [ $((SECONDS - ci_last)) -ge "$CI_POLL" ] || return 0
  ci_last=$SECONDS
  ci_verdict || rc=$?
  if [ -n "$pushed_at" ] && [ $((SECONDS - pushed_at)) -lt "$CI_GRACE" ]; then
    case $rc in 1 | 4) rc=3 ;; esac
  fi
  case $rc in
    0)
      green=1 verdict=green
      rm -f "$state/ci-down"
      say "CI is green on ${tip:0:12}"
      queue_set 5 green
      queue_phase "CI passed ${tip:0:12}"
      return 0 ;;
    1)
      cat "$cilog" >&2
      say "CI is red on ${tip:0:12}"
      [ "$Q_AHEAD" = 0 ] || say "that commit sits on $Q_PREDNAME's, which hasn't landed: waiting to see whether it does before giving up"
      blocked="CI is red on ${tip:0:12} (above), so $BRANCH is untouched. Fix it, commit, then run this again"
      keep=$tip verdict=red
      queue_set 5 red
      # Nobody builds on a red commit. In a batch they already have: it stays, and the bisect finds where the fault is.
      [ -n "$BATCH" ] || { tip=''; queue_set 4 skip; }
      queue_phase "CI is red"
      return 0 ;;
    4)
      cat "$cilog" >&2
      [ -z "$ci_skipped" ] || refuse "$ci_skipped on ${tip:0:12} were skipped, so the commit's checks did not all run and nothing landed. Nothing is wrong with the runners, and running it again would skip them again. A workflow with jobs that are skipped on purpose needs the scheme's own CI_STATUS script, or with lanes their names in the lane's CI_SKIPS_<LANE> (see the top of tools/land.sh)"
      [ -z "$retried" ] || park "CI's run on ${tip:0:12} ended without a verdict a second time (a runner lost mid-run, or the run cancelled), so nothing landed. The runners need a person's look; park, and run this again after"
      retried=1
      say "CI's run on ${tip:0:12} ended without a verdict (a runner lost mid-run, or the run cancelled): running it again, once. The commit is the same, so the ones stacked on it keep their runs"
      ci_push
      queue_phase "waiting for CI on ${tip:0:12} again since $(date +%H:%M)"
      return 0 ;;
  esac
  [ "$Q_AHEAD" = 0 ] || [ "$B_NUM" = 1 ] || return 0 # the limits count at the front: the head, or with batches the head's batch
  waited=$((SECONDS - ci_clock))
  [ "$rc" != 2 ] || ci_begun=1
  # Under a fresh note, not before CI_GRACE after the push: GitHub may not have handed the run to a runner yet, and
  # until then a red or lost verdict shows as rc 3 (above).
  if [ -z "$ci_begun" ] && { [ "$waited" -ge "$CI_START" ] || { [ "$rc" = 3 ] && { [ -z "$pushed_at" ] || [ $((SECONDS - pushed_at)) -ge "$CI_GRACE" ]; } && ci_down_fresh; }; }; then
    cat "$cilog" >&2
    [ "$rc" = 3 ] || park "CI gave no answer about ${tip:0:12} for $(((CI_START + 59) / 60)) min (exit $rc from ${CI_STATUS:-gh}; above), so nothing landed. That is GitHub or this box's gh login, not the runners or the branch: a person needs to look. Park, and run this again after"
    # Runs going elsewhere in the repo mean the runners are there and busy (the ones stacked behind this, say): the
    # run is waiting its turn. CI_LIMIT still ends the wait.
    busy=$(hub gh api "repos/$slug/actions/runs?status=in_progress&per_page=1" --jq .total_count 2>/dev/null) || busy=0
    if [ "$busy" -gt 0 ] 2>/dev/null; then
      say "CI hasn't started on ${tip:0:12} yet, but the runners are busy with other runs: still waiting"
      ci_begun=1
      return 0
    fi
    [ -z "$down" ] || park "$down. Park, and run this again once a person says the runners are back"
    ci_down "no runner started CI on ${tip:0:12} within $(((CI_START + 59) / 60)) min"
    park "no runner has started CI on ${tip:0:12} within $(((CI_START + 59) / 60)) min (the machine they run on is probably off or asleep), so nothing landed. Park, and run this again once a person says the runners are back"
  fi
  if [ "$waited" -ge "$CI_LIMIT" ]; then
    cat "$cilog" >&2
    ci_down "CI on ${tip:0:12} didn't finish within $(((CI_LIMIT + 59) / 60)) min"
    park "CI on ${tip:0:12} hasn't finished within $(((CI_LIMIT + 59) / 60)) min, so nothing landed. Park, and run this again later"
  fi
}

# The branch as it was, rebased onto <commit> and checked: sets base, and tip when it passed (with the
# CI gate on, CI then runs on it), or blocked when it can't sit on that commit.
build() {
  local want=$1 on phase rc=0 clashes fork log chk v
  [ -z "$pushed" ] || ci_cancel # its run is on a commit that will never land now
  base=$want tip='' blocked='' keep='' green='' retried='' pushed_at='' verdict=-
  queue_set 4 -
  queue_set 5 "$UNRUN"
  queue_set 6 "$want"
  if [ "$Q_AHEAD" = 0 ]; then
    on="$BRANCH ($(git log -1 --format='%h "%s"' "$want"))" phase="rebasing onto $BRANCH"
  else
    phase="rebasing onto $Q_PREDNAME's commit"
    on="$Q_PREDNAME's commit ${want:0:12}, $(queue_ordinal $((Q_AHEAD + 1))) in line: CI runs on both at once, and this lands once $Q_PREDNAME has"
  fi
  [ "$mode" != build ] || phase="merging $BRANCH into $build"
  queue_phase "$phase"
  if [ "$mode" = build ]; then say "merging $on into $build on $branch"; else say "rebasing $branch onto $on"; fi
  # The branch, and the commit this leaves the worktree on: how the next run puts things back if this one is killed.
  printf '%s\n' "$branch" "$pre" >"$gitdir/land-branch"
  # 9>&- on git: a git gc --auto it starts detaches, and mustn't keep the lock.
  git checkout -q --detach "$pre" 9>&- 6>&-
  if [ "$mode" = build ]; then
    # A build takes $BRANCH in by merge: a rebase would flatten its merges of $BRANCH and change its feeders' commits.
    if git merge-base --is-ancestor "$want" HEAD || git merge -q -m "Merge $BRANCH into $build" "$want" 9>&- 6>&-; then
      printf '%s\n' "$branch" "$(git rev-parse HEAD)" >"$gitdir/land-branch"
    else
      git merge --abort 2>/dev/null || true
      blocked="merging $BRANCH into $build failed (see git's output above), so nothing landed. Take $BRANCH in on your branch by hand (git merge $BRANCH), resolve it keeping both sides, run tools/land.sh --into $build --full, then this again"
      return 0
    fi
  elif git rebase -q "$want" 9>&- 6>&-; then
    printf '%s\n' "$branch" "$(git rev-parse HEAD)" >"$gitdir/land-branch"
  else
    git rebase --abort 2>/dev/null || true # nothing to abort if it never started
    blocked="the rebase onto $BRANCH failed (see git's output above), so nothing landed. On conflicts: run git rebase $BRANCH, resolve them keeping the other minions' changes, re-test, commit, then run this again"
    return 0
  fi

  queue_phase "checking numbered things"
  fork=$(git merge-base "$want" "$pre")
  clashes=$(numbered_clashes "$want" "$fork" "$pre") || rc=$?
  if [ "$rc" != 0 ]; then
    printf '%s\n' "$clashes" | sed 's/^/land:   /' >&2
    [ "$rc" != 2 ] || refuse "fix that line in $FACTS (commit it on this branch), then run this again. Nothing landed and $branch is back where it was"
    [ "$rc" = 1 ] || refuse "the numbered-things check itself failed (exit $rc), so nothing landed and $branch is back where it was; a person needs to look"
    blocked="this branch takes a number $BRANCH already has (above), so nothing landed and $branch is back where it was. Renumber yours past $BRANCH's highest (bump the version past $BRANCH's), commit, then run this again"
    return 0
  fi

  queue_phase "checking for landings it undoes"
  rc=0
  clashes=$(undo_guard "$want") || rc=$?
  if [ "$rc" != 0 ]; then
    [ "$rc" = 1 ] || refuse "the undo check itself failed (exit $rc, above), so nothing landed and $branch is back where it was; a person needs to look"
    printf 'land: %s\n' "$branch removes what these landed, without naming them:" "$clashes" >&2
    refuse "nothing landed and $branch is back where it was. A squash onto a newer $BRANCH keeps the branch's old files, which reverts what landed since (git reset --soft from a branch that started further back). Find the branch's last commit before the squash (git reflog), rebase that onto $BRANCH, and squash only then: git reset --soft \$(git merge-base HEAD $BRANCH). If the undo is meant, add a line \"Undoes: <sha>\" to a commit message for each commit above, then run this again"
  fi

  # Its lane, over what it changes on $want, and that lane's check.
  lane=full lane_why='' chk=$CHECK
  if [ -n "$LANES" ]; then
    read -r lane lane_why <<<"$(lane_of "$want" HEAD "refs/heads/$BRANCH")"
    say "lane $lane: $lane_why"
    case $lane in light) chk=$CHECK_LIGHT ;; full) ;; *) v=CHECK_${lane^^} && chk=${!v-$CHECK} ;; esac
  fi
  ci_lane=$lane
  if [ -z "$chk" ]; then
    [ -n "$FAST" ] || say "lane $lane runs no check"
  else
    say "running $chk"
    queue_phase "waiting to run the check"
    log="$state/land-check-${branch//\//-}.log"
    rm -f "$log" # the check makes it as it starts: none afterwards means the check lock never came
    # It runs under the lock when this is the head, so it has a time limit (LAND_CHECK_TIMEOUT, in seconds), and
    # 9>&- keeps a process it leaves running from holding the lock after this script ends. One check at a time,
    # under a lock of its own (fd 7): the ones stacked behind the head check too, and the box is shared.
    (
      flock -w "$CHECK_WAIT" 7 || exit 1
      queue_phase "running the check since $(date +%H:%M)"
      timeout -k 30 "$CHECK_LIMIT" bash -c "$chk" >"$log" 2>&1 9>&- 7>&- 6>&-
    ) 7>"$state/land-check.lock" 9>&- 6>&- || rc=$? # 9>&-: this subshell outlives a killed landing, and mustn't keep its lock
    [ "$rc" = 0 ] || [ -e "$log" ] || refuse "the check lock ($state/land-check.lock) was still taken after ${CHECK_WAIT}s, so the check never ran and nothing landed: $(check_holder). A person needs to look at it before anyone tries again"
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      echo "land: the check ran past ${CHECK_LIMIT}s and was stopped: something in it hung" >>"$log" # the tail below shows it
    fi
    if [ "$rc" != 0 ] && { [ "$rc" = 124 ] || [ "$rc" = 137 ] || ! known_red "the check" <"$log"; }; then
      tail -n 40 "$log" >&2
      keep=$(git rev-parse HEAD)
      blocked="the check failed on the rebased branch (full log: $log), so $BRANCH is untouched"
      return 0
    fi
  fi

  tip=$(git rev-parse HEAD)
  if [ -n "$BATCH" ]; then
    queue_phase "checked ${tip:0:12}: CI runs on its batch's top"
  elif [ -n "$CI_ON" ]; then
    ci_start
  fi
  queue_set 4 "$tip"
}

# Batches (CI_BATCH over 1; the header at "Batches"). batch_look walks the line from the head: the ones ahead as
# queue_look saw them, this one, then the ones behind, leaving out the gone, the skipped and the stopped, as
# queue_look does ahead. It sets B_NUM (this one's batch, from the head's, 1), B_I (its place in the batch, from 1),
# B_LABEL, B_SHA, B_VER, B_BASE and B_PID (each member's, from 1), and B_RED when a ticket ahead of this one is red.
batch_add() { # <label> <commit> <verdict> <base> <pid and start>: the next in line joins the last batch, or starts one
  if [ "$B_N" != 0 ] && { [ "$3" = old ] || [ "$B_N" = "$CI_BATCH" ]; }; then
    B_AT=$((B_AT + 1)) B_N=0 B_LABEL=('') B_SHA=('') B_VER=('') B_BASE=('') B_PID=('')
  fi
  B_N=$((B_N + 1))
  [ "$3" != old ] || B_N=$CI_BATCH # a land.sh older than batches is a batch of its own
  B_LABEL+=("$1") B_SHA+=("$2") B_VER+=("$3") B_BASE+=("$4") B_PID+=("$5")
}

batch_look() {
  local e t l label sha ver bas pid behind=''
  B_AT=1 B_N=0 B_LABEL=('') B_SHA=('') B_VER=('') B_BASE=('') B_PID=('') B_RED=''
  for e in "${Q_LINE[@]}"; do
    read -r label sha ver bas pid <<<"$e"
    [ "$ver" != red ] || B_RED=1
    batch_add "$label" "$sha" "$ver" "$bas" "$pid"
  done
  batch_add "$branch" "${tip:--}" "$verdict" "${base:--}" "$Q_ME"
  B_NUM=$B_AT B_I=$B_N
  for t in "${Q_ORDER[@]}"; do
    [ "$B_N" -lt "$CI_BATCH" ] || break
    [ -n "$behind" ] || { [ "$t" != "$Q_N" ] || behind=1; continue; } # the ones behind this one, in queue_look's order
    mapfile -t l 2>/dev/null <"$Q_DIR/$t" || continue
    [ -n "${l[0]:-}" ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]}" ] && [ "${l[4]:-}" != skip ] || continue
    if [ "${l[1]:-0}" = 0 ] && [[ $(queue_state "${l[0]%% *}") == [Tt] ]]; then continue; fi
    [ -n "${l[5]:-}" ] && [ "${l[5]}" != old ] || break # older than batches, or fast mode's: the next batch
    batch_add "${l[2]:-?}" "${l[4]:--}" "${l[5]}" "${l[6]:--}" "${l[0]}"
  done
}

# Which member of a red batch runs CI next: halfway between the deepest green one (0: main) and the shallowest red one.
batch_mid() {
  local i hi='' lo=0
  for ((i = 1; i < ${#B_VER[@]}; i++)); do [ "${B_VER[i]}" != red ] || { hi=$i; break; }; done
  [ -n "$hi" ] || return 0
  for ((i = 1; i < hi; i++)); do [ "${B_VER[i]}" != green ] || lo=$i; done
  [ $((hi - lo)) -le 1 ] || echo $(((lo + hi) / 2))
}

# Whether this one pushes now: in a batch that runs CI, never with a red ticket ahead (its fault may be in this
# commit too: the bisect ahead goes first), and only as its batch's top or as a red batch's next halfway member.
batch_push() {
  [ "$B_NUM" -le "$CI_STACK" ] && [ -z "$B_RED" ] || return 1
  [ "$B_I" = $((${#B_SHA[@]} - 1)) ] || [ "$(batch_mid)" = "$B_I" ]
}

# The head: the deepest green member of its batch, as G (its commit) and GI, once it may land. Its ticket's green is
# checked: main and every member's commit, the head's down to G's, sit under G, each built on the one ahead (the
# head on main: a member killed since leaves a gap), CI passes G when asked again now, and the members up to G are
# all still running (one killed meanwhile must not land). CI is asked at most every CI_POLL, and with no answer for
# CI_START it parks, as ci_ask does.
batch_green() {
  local i rc=0 under main gl=full
  G='' GI=''
  for ((i = ${#B_VER[@]} - 1; i >= 1; i--)); do [ "${B_VER[i]}" != green ] || { GI=$i; break; }; done
  [ -n "$GI" ] && [[ ${B_SHA[GI]} =~ ^[0-9a-f]{40,}$ ]] || return 1
  G=${B_SHA[GI]} under=$(git rev-parse "refs/heads/$BRANCH") main=$under
  git merge-base --is-ancestor "$under" "$G" 2>/dev/null || return 1
  for ((i = 1; i <= GI; i++)); do
    [ "${B_BASE[i]}" = "$under" ] && [[ ${B_SHA[i]} =~ ^[0-9a-f]{40,}$ ]] && git merge-base --is-ancestor "${B_SHA[i]}" "$G" 2>/dev/null || return 1
    under=${B_SHA[i]}
  done
  [ -z "$g_last" ] || [ $((SECONDS - g_last)) -ge "$CI_POLL" ] || return 1
  g_last=$SECONDS
  # In the lane of main..G: inside the range G's run had, so no heavier than the lane that run took.
  [ -z "$LANES" ] || { gl=$(lane_of "$main" "$G" "refs/heads/$BRANCH") && gl=${gl%% *}; }
  ci_verdict "$G" "$gl" || rc=$?
  case $rc in
    0) g_quiet='' ;;
    [1-4])
      cat "$cilog" >&2
      refuse "${B_LABEL[GI]}'s ticket says CI passed ${G:0:12}, but CI says otherwise now (exit $rc from ${CI_STATUS:-gh}; above), so nothing landed. A person needs to look before anyone tries again" ;;
    *)
      g_quiet=${g_quiet:-$SECONDS}
      [ $((SECONDS - g_quiet)) -lt "$CI_START" ] || { cat "$cilog" >&2; park "CI gave no answer about ${G:0:12} for $(((CI_START + 59) / 60)) min (exit $rc from ${CI_STATUS:-gh}; above), so nothing landed. That is GitHub or this box's gh login, not the runners or the branch: a person needs to look. Park, and run this again after"; }
      return 1 ;;
  esac
  for ((i = 2; i <= GI; i++)); do [ "$(queue_proc "${B_PID[i]%% *}")" = "${B_PID[i]}" ] || return 1; done
}

# A member whose commit the head landed (its commit is on main now): it says so and leaves as landed, unless a commit
# was made on the branch or here while it waited: that one is not on main, so it refuses as the head would.
batch_landed() {
  local i with='' on='its own'
  if [ "$(git rev-parse HEAD)" != "$tip" ] || [ "$(git rev-parse "refs/heads/$branch")" != "$pre" ]; then
    keep=''
    refuse "${tip:0:12} landed in a batch ($BRANCH is now $(git rev-parse --short=12 "refs/heads/$BRANCH")), but $branch or this worktree's HEAD moved while it waited, so what was committed since is not on $BRANCH. Put it on $branch, then run this again"
  fi
  for ((i = 1; i < ${#B_SHA[@]}; i++)); do
    [[ ${B_SHA[i]} =~ ^[0-9a-f]{40,}$ ]] && git merge-base --is-ancestor "${B_SHA[i]}" "refs/heads/$BRANCH" 2>/dev/null || continue
    if [ "$i" = "$B_I" ]; then on='its own'; else with="$with, ${B_LABEL[i]}" on="${B_LABEL[i]}'s"; fi
  done
  keep=$tip landed=ok
  say "landed in a batch with ${with#, }, on $on CI run (${BRANCH} is now $(git rev-parse --short=12 "refs/heads/$BRANCH"))"
  exit 0
}

# On the way out, however it ends: the worktree goes back on the branch, the place in line and the lock
# go, then the scratch branch and its runs, except a landed commit's own runs, which finish (main's CI
# may skip what they passed). Then step 7, once main was pushed: land_after for this branch and, as the
# head of a batch, for each member it landed.
leave() {
  local rc=$? main
  trap - EXIT
  set +e
  if [ -z "$(git branch --show-current)" ]; then
    git rebase --abort 2>/dev/null
    # The branch takes the rebased commit only when that landed or was built on main itself: never one stacked on
    # someone's unlanded work.
    main=$(git rev-parse "refs/heads/$BRANCH")
    if [ "$(git rev-parse "refs/heads/$branch")" != "$pre" ]; then
      say "$branch moved while this ran, so it is left as it is now"
      git checkout -q "$branch" 9>&-
    elif [ -n "$keep" ] && { [ -n "$landed" ] || { [ "$mode" != build ] && { [ "$keep" = "$main" ] || [ "$base" = "$main" ]; }; }; }; then
      git checkout -q -B "$branch" "$keep" 9>&-
    else
      git checkout -q "$branch" 9>&-
    fi
  fi
  rm -f "$gitdir/land-branch"
  queue_done $landed
  exec 9>&- 6>&-
  if [ -n "$pushed" ]; then
    ci_cancel
    hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null
  fi
  if [ -n "$main_pushed" ] && declare -F land_after >/dev/null; then
    local i after=("$tip $branch")
    [ -z "$BATCH" ] || for ((i = 2; i <= ${GI:-0}; i++)); do after+=("${B_SHA[i]} ${B_LABEL[i]}"); done
    for i in "${after[@]}"; do
      (land_after "${i%% *}" "${i#* }") >&2 || say "land.local.sh's land_after failed for ${i#* } (exit $?), which landed all the same"
    done
  fi
  exit "$rc"
}

# The smoke check (step 0): before the line, so what fails in seconds never waits in it.
smoke() {
  local t0=$SECONDS out rc=0
  say "smoke: checking $branch before it queues"
  early_conflict "$pre" "before the line" || refuse "smoke: it conflicts with $BRANCH, before the line ($((SECONDS - t0)) s), so nothing landed and nobody waited on it. Fix it, re-test, commit, then run this again"
  if [ -n "$SMOKE_CMD" ]; then
    out=$(timeout -k 10 "$SMOKE_TIMEOUT" bash -c "$SMOKE_CMD" 2>&1 6>&-) || rc=$?
    if { [ "$rc" = 124 ] || [ "$rc" = 137 ]; } && [ -n "$FAST" ]; then
      refuse "smoke: SMOKE_CMD ran past $SMOKE_TIMEOUT s, and a fast land goes live on it alone, so nothing landed. Find what hangs; a land labelled high takes the full gate"
    elif [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
      say "smoke: SMOKE_CMD ran past $SMOKE_TIMEOUT s, so it doesn't decide: getting in line"
      return 0 # it did not pass: no "passed" line (The Trans Agenda #76)
    elif [ "$rc" != 0 ]; then
      ! known_red "smoke: SMOKE_CMD" <<<"$out" || return 0 # it said so, and it did not pass either
      tail -n 60 <<<"$out" | sed 's/^/land: smoke: /' >&2
      refuse "smoke: SMOKE_CMD failed (exit $rc), before the line ($((SECONDS - t0)) s), so nothing landed and nobody waited on it. Fix it, re-test, commit, then run this again"
    fi
  fi
  say "smoke: passed in $((SECONDS - t0)) s"
}

# --verify (the header): the full CHECK under the check lock, then with the CI gate on, CI on land/verify (with lanes
# land/full/verify) within CI_START and CI_LIMIT. Both run, so one verdict names every failure.
# A red waits for the workflows still going (ci_open), so the verdict names every one that fails; one already red on
# the commit needs no new run.
verify_ci() {
  rc=0
  ci_runs || rc=$?
  [ "$rc" != 1 ] || [ "$ci_open" = 0 ] || { ci_red=1 rc=$ci_open; }
}
verify_run() {
  local rc=0 log="$state/land-verify.log" red="" ids="" ci="" ci_red="" chk=$CHECK want=${LAND_VERIFY_IDS:-} files
  tip=$(git rev-parse HEAD) ci_lane=full
  say "verify: ${tip:0:12}"
  if [ -n "$want" ]; then
    # Only what the ids need: CI for a ci: id, and each test file alone when CHECK_FILE_CMD can run one.
    grep -Eq '^(ci:|CI$)' <<<"$want" || CI_ON=''
    files=$(grep -Ev '^(ci:|CI$)' <<<"$want" | sed 's/::.*//' | sort -u || true)
    if [ -z "$files" ]; then chk=''
    elif [ -n "$CHECK_FILE_CMD" ] && ! grep -Eqx 'the check|CI' <<<"$files"; then
      chk='r=0; '
      while IFS= read -r f; do chk+="{ ${CHECK_FILE_CMD//\{file\}/$(printf %q "$f")}; } || r=1; "; done <<<"$files"
      chk+='exit $r'
    fi
  fi
  if [ -n "$chk" ]; then
    (
      flock -w "$CHECK_WAIT" 7 || { echo "land: the check lock was still taken after ${CHECK_WAIT}s"; exit 1; }
      timeout -k 30 "$CHECK_LIMIT" bash -c "$chk" 2>&1 7>&- 6>&-
    ) >"$log" 7>"$state/land-check.lock" || rc=$?
    if [ "$rc" != 0 ]; then
      tail -n 40 "$log" >&2
      red=1 ids=$(land_failures <"$log" | sed "s|^$here/||")
      # A check that hung, or failed on nothing land_failures can name, is one id of its own.
      if [ -z "$ids" ] || [ "$rc" = 124 ] || [ "$rc" = 137 ]; then ids+=$'\nthe check'; fi
    fi
  fi
  if [ -n "$CI_ON" ]; then
    ci_clock=$SECONDS
    verify_ci
    [ "$rc" = 0 ] || [ "$rc" = 1 ] || [ "$rc" = 2 ] || ci_push
    while [ "$rc" != 0 ] && [ "$rc" != 1 ]; do
      sleep "$CI_POLL"
      verify_ci
      [ "$rc" != 2 ] || ci_begun=1
      if [ "$rc" = 4 ] && [ -z "$retried" ]; then retried=1 && ci_push; continue; fi
      if [ "$rc" = 4 ] || { [ -z "$ci_begun" ] && [ $((SECONDS - ci_clock)) -ge "$CI_START" ]; } || [ $((SECONDS - ci_clock)) -ge "$CI_LIMIT" ]; then
        cat "$cilog" >&2
        # A workflow already red is a verdict even if the others never finish.
        if [ -n "$ci_red" ]; then rc=1; break; fi
        [ -n "$red" ] && break
        hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null || true
        echo "verify: no verdict"
        exit 75
      fi
    done
    [ -z "$pushed" ] || hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null || true
    if [ "$rc" = 1 ]; then
      cat "$cilog" >&2
      red=1 ci=$(land_failures <"$cilog")
      ids+=$'\n'${ci:-CI}
    fi
  fi
  if [ -z "$red" ]; then echo "verify: green"; exit 0; fi
  sed '/^$/d' <<<"$ids" | sort -u | sed 's/^/verify: failing /'
  echo "verify: red"
  exit 1
}
[ -z "$verify" ] || verify_run

# A build's lock: one run at a time on build/<n> (a merge into it, its --full run or its land), on fd 6. --build takes
# it before the line, so a land never waits on a feeder's check; the feeders wait for the build's land instead.
if [ -n "$build" ]; then
  [[ ${LAND_BUILD_WAIT:-3600} =~ ^[0-9]+$ ]] || refuse "LAND_BUILD_WAIT is in whole seconds, not \"$LAND_BUILD_WAIT\""
  lock=$state/land-build-${build#build/}.lock
  exec 6>"$lock" || refuse "can't open $lock for writing, so nothing ran: a person needs to look at it"
  if ! flock -n 6; then
    say "waiting for the run on $build ahead of this one (a merge into it, its full run or its land) to end"
    flock -w "${LAND_BUILD_WAIT:-3600}" 6 || refuse "waited ${LAND_BUILD_WAIT:-3600} s for the run on $build ahead of this one, so nothing ran: run it again later, or look at what holds $lock"
  fi
  # Under its lock only land.sh moves it: what a merge into it compares and swaps against.
  bbase=$(git rev-parse -q --verify "refs/heads/$build") || refuse "$build doesn't exist (a build that landed is deleted), so nothing ran"
  [ "$mode" != build ] || [ "$bbase" = "$pre" ] || refuse "$build moved on while this waited ($(git log -1 --format='%h "%s"' "$bbase")): bring $branch to it (git merge --ff-only $build) and run it again. Nothing landed"
fi

# --into and --full (the header's "Build branches"): out of the line, under the build's lock only.
if [ "$mode" = into ] || [ "$mode" = full ]; then
  if git merge-base --is-ancestor "$bbase" HEAD; then
    say "$build is already under $branch: no rebase"
  else
    [ "$mode" = into ] || refuse "$build has commits $branch doesn't: run git merge $build (not a rebase), re-test, then run this again. Nothing merged"
    say "rebasing $branch onto $build ($(git log -1 --format='%h "%s"' "$bbase"))"
    if ! git rebase -q "$bbase" 6>&-; then
      git rebase --abort 2>/dev/null || true
      refuse "the rebase onto $build failed (see git's output above), so $build is untouched. On conflicts: run git rebase $build, resolve them keeping the other feeders' changes, re-test, commit, then run this again"
    fi
  fi
  rc=0
  clashes=$(numbered_clashes "$bbase" "$(git merge-base "$bbase" "$pre")" "$pre") || rc=$?
  if [ "$rc" != 0 ]; then
    printf '%s\n' "$clashes" | sed 's/^/land:   /' >&2
    [ "$rc" != 2 ] || refuse "fix that line in $FACTS (commit it on this branch), then run this again. $build is untouched"
    [ "$rc" = 1 ] || refuse "the numbered-things check itself failed (exit $rc), so $build is untouched; a person needs to look"
    refuse "this branch takes a number $build already has (above), so $build is untouched. Renumber yours past $build's highest, commit, then run this again"
  fi
  rc=0
  clashes=$(undo_guard "$bbase") || rc=$?
  if [ "$rc" != 0 ]; then
    [ "$rc" = 1 ] || refuse "the undo check itself failed (exit $rc, above), so $build is untouched; a person needs to look"
    printf 'land: %s\n' "$branch removes what these merged, without naming them:" "$clashes" >&2
    refuse "$build is untouched. If the undo is meant, add a line \"Undoes: <sha>\" to a commit message for each commit above, then run this again"
  fi
  if [ "$mode" = into ]; then
    # A feeder runs only what it touched: its test files through CHECK_FILE_CMD, else the light check, else CHECK.
    chk=${CHECK_LIGHT:-$CHECK}
    if [ ${#files[@]} -gt 0 ] && [ -n "$CHECK_FILE_CMD" ]; then
      chk='r=0; '
      for f in "${files[@]}"; do chk+="{ ${CHECK_FILE_CMD//\{file\}/$(printf %q "$f")}; } || r=1; "; done
      chk+='exit $r'
    fi
    if [ -n "$chk" ]; then
      say "running $chk"
      log="$state/land-check-${branch//\//-}.log"
      (
        flock -w "$CHECK_WAIT" 7 || { echo "land: the check lock was still taken after ${CHECK_WAIT}s"; exit 1; }
        timeout -k 30 "$CHECK_LIMIT" bash -c "$chk" 2>&1 7>&- 6>&-
      ) >"$log" 7>"$state/land-check.lock" 6>&- || rc=$?
      [ "$rc" = 0 ] || { tail -n 40 "$log" >&2; refuse "the check failed on the rebased branch (full log: $log), so $build is untouched; $branch keeps the rebased work"; }
    fi
  else
    # The build minion's merge of $BRANCH: the full check and CI, judged as --verify judges (no fast mode, no known reds).
    out=$(LAND_VERIFY_IDS='' verify_run) || rc=$?
    case $rc in
      0) ;;
      75) park "CI gave no verdict on $(git rev-parse --short=12 HEAD), so $build is untouched. Park, and run this again once a person says the runners are back" ;;
      *) sed -n 's/^verify: failing /land:   failing: /p' <<<"$out" >&2
         refuse "the full check or CI is red on $branch (above), so $build is untouched. Fix it, commit, then run this again" ;;
    esac
  fi
  tip=$(git rev-parse HEAD)
  git update-ref -m "land.sh --into" "refs/heads/$build" "$tip" "$bbase" || refuse "$build moved while this ran (not by land.sh, which holds its lock), so nothing merged: run it again"
  say "$build is now at $(git log -1 --format='%h "%s"' "$tip"); $BRANCH is untouched"
  exit 0
fi

[ "${LAND_SMOKE:-1}" = 0 ] || smoke
queue_join "$state" "$branch"
trap leave EXIT
seen_main='' looked='' checked_main=''
while :; do
  # In a batch, landed by the head: its commit is under the one the head moved main to.
  if [ -n "$BATCH" ] && [ -n "$tip" ] && git merge-base --is-ancestor "$tip" "refs/heads/$BRANCH" 2>/dev/null; then batch_landed; fi
  queue_look || exit 1
  # While others are ahead, each time main moves: whether the branch would still rebase onto it. A conflict leaves the
  # line at once, so the minion hears now rather than when it reaches the front.
  # Not once its own commit is on main (landed in a batch since batch_landed's look): it would conflict with itself.
  if [ "$Q_AHEAD" != 0 ] && [ "$(git rev-parse "refs/heads/$BRANCH")" != "$checked_main" ] &&
    ! { [ -n "$tip" ] && git merge-base --is-ancestor "$tip" "refs/heads/$BRANCH" 2>/dev/null; }; then
    checked_main=$(git rev-parse "refs/heads/$BRANCH")
    early_conflict "$pre" "waiting in line" || exit 1
  fi
  if [ -n "$BATCH" ]; then
    batch_look
    looked=1
    # The limits on CI count from here: until now its run could be waiting on the batches ahead.
    [ "$B_NUM" != 1 ] || [ -n "$fronted" ] || fronted=1 ci_clock=$SECONDS ci_begun=''
  fi
  if [ "$Q_AHEAD" = 0 ]; then
    [ -n "$Q_HELD" ] || continue # queue_look waited on the lock, so this is no busy loop
    if [ -z "$seen_main" ]; then
      # Under the lock: another landing fast-forwarding main there looks like uncommitted changes while it runs.
      [ "$(git -C "$MAIN" branch --show-current)" = "$BRANCH" ] || refuse "$MAIN is not on $BRANCH; a person needs to look"
      [ -z "$(git -C "$MAIN" status --porcelain --untracked-files=no)" ] || refuse "$MAIN has uncommitted changes; a person needs to look"
      seen_main=1 ci_clock=$SECONDS ci_begun='' # the limits on CI count from here: until now its run could be waiting on the ones ahead
    fi
    want=$(git rev-parse "refs/heads/$BRANCH")
  elif [ -n "$BATCH" ]; then
    want='' # the batches that run CI and the one that builds ahead build; further back waits
    [ "$B_NUM" -gt $((CI_STACK + 1)) ] || want=$Q_PRED
  elif [ "$Q_AHEAD" -lt "$CI_STACK" ] && [ -n "$Q_PRED" ]; then
    want=$Q_PRED
  else
    want='' # too far back to build yet, or the one ahead has nothing built
  fi

  if [ -z "$want" ]; then
    # What it was built on is gone: wait for the one ahead to build again. Unless that was main's tip: the one
    # it sat on has landed and only skipped ones are ahead for a moment, so the build and its CI run still stand.
    if [ -n "$base" ] && [ "$base" != "$(git rev-parse "refs/heads/$BRANCH")" ]; then
      [ -z "$pushed" ] || ci_cancel
      base='' tip='' blocked='' green='' verdict=-
      queue_set 4 -
      queue_set 5 "$UNRUN"
      queue_set 6 -
      queue_phase waiting
    fi
  elif [ "$want" != "$base" ]; then
    build "$want"
    looked='' # the line may have moved while it built (a check takes minutes): batches decide on the next look
    [ -z "$blocked" ] || [ "$Q_AHEAD" = 0 ] || queue_set 4 skip
    [ -z "$blocked" ] || [ "$Q_AHEAD" = 0 ] || say "that was on top of $Q_PREDNAME's commit, which hasn't landed: ${blocked%%, so *}. Not final: waiting to see whether that one lands"
  fi

  if [ -n "$blocked" ]; then
    [ "$Q_AHEAD" != 0 ] || refuse "$blocked"
  elif [ -n "$tip" ] && [ -n "$BATCH" ]; then
    if [ -n "$looked" ]; then
      [ "$verdict" != - ] || ! batch_push || ci_start
      [ "$verdict" != running ] || ci_ask
      B_VER[B_I]=$verdict
      if [ "$Q_AHEAD" = 0 ] && [ -z "$blocked" ] && batch_green; then break; fi
    fi
  elif [ -n "$tip" ]; then
    [ -z "$CI_ON" ] || [ -n "$green" ] || ci_ask
    if [ "$Q_AHEAD" = 0 ] && { [ -z "$CI_ON" ] || [ -n "$green" ]; }; then break; fi
  fi
  sleep "$QUEUE_POLL"
done

# The head of the line, holding the lock, with $tip checked (and green in CI) on exactly today's main; with
# batches, main moves to G, the deepest green commit of its batch, which holds $tip.
# The merge keeps the lock, so nobody sees main half moved if this script is killed; gc.auto=0, so no git gc
# detaches from it holding the lock.
# A commit made here or on the branch while this waited is not in $tip: CI never saw it.
{ [ "$(git rev-parse HEAD)" = "$tip" ] && [ "$(git rev-parse "refs/heads/$branch")" = "$pre" ]; } || refuse "$branch or this worktree's HEAD moved while the landing waited, so what CI passed is not what is here now and nothing landed. Put any commit made meanwhile on $branch, then run this again"
to=$tip
[ -z "$BATCH" ] || to=$G
git -C "$MAIN" -c gc.auto=0 merge -q --ff-only "$to" || refuse "could not fast-forward $BRANCH to $branch; nothing landed"
keep=$tip landed=ok # it landed, so its time counts toward the estimate, whatever the push does
say "$BRANCH is now at $(git log -1 --format='%h "%s"' "$to")"
if [ -n "$BATCH" ] && [ "$GI" != 1 ]; then
  with=$(printf ', %s' "${B_LABEL[@]:2:GI-1}")
  say "landed in a batch with ${with#, }, on ${B_LABEL[GI]}'s CI run"
fi
if [ "$mode" = build ]; then
  if git update-ref -d "refs/heads/$build" "$bbase"; then
    say "deleted $build, which is on $BRANCH now (to make it again: git branch $build $(git rev-parse --short "$bbase"))"
  else
    say "$build moved during the land (not by land.sh), so it stays: what is in it after $(git rev-parse --short "$bbase") isn't on $BRANCH"
  fi
fi

if [ "$PUSH_MAIN" = 0 ]; then
  say "PUSH_MAIN is 0, so $BRANCH stays local"
  exit 0
fi
if ! git -C "$MAIN" remote get-url origin >/dev/null 2>&1; then
  say "no origin remote, so $BRANCH stays local"
  exit 0
fi
queue_phase "pushing $BRANCH to origin"
# --no-verify: .githooks/pre-push refuses every push to main on purpose; this script is the one
# route that may make it.
if out=$(GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$MAIN" push -q --no-verify origin "$BRANCH" 2>&1); then
  say "pushed $BRANCH to origin"
  main_pushed=1
  if [ "$mode" = build ] && git show-ref -q --verify "refs/remotes/origin/$build"; then
    hub git push -q --no-verify origin ":refs/heads/$build" 2>/dev/null || say "couldn't delete $build on origin: delete it there by hand"
  fi
else
  say "$BRANCH moved, but the push to origin failed: $out"
  say "the next landing retries it; if origin's $BRANCH moved on its own (rejected as non-fast-forward), a person merges it into $MAIN first"
  exit 1
fi
