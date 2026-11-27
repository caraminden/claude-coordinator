#!/usr/bin/env bash
# Land a minion's branch: run it from the minion's worktree once its work is committed.
#   tools/land.sh
# Under the deploy lock (the one tools/deploy.sh takes), so landings and deploys go one at a time, in the order they
# asked (tools/deploy-queue.sh). While others are ahead, each time main moves, git merge-tree checks the branch would
# still rebase cleanly; a conflict leaves the line at once (#770). --check runs only that check, for hand_off_land: exit 3.
# The restart the landing before it queued may still be running: steps 1 and 2 go on beside it, 3 and 4 wait for its
# verdict (the restart lock, #566). If it was rolled back, steps 1 and 2 are done again without it.
# 0. The smoke check (#1012), before it gets in line: a trial rebase, tools/commit-titles.sh, tools/parse-check.ts and
#    the always-tests plus the branch's changed test files (smoke(), tools/land/prepare.sh). Then, with others in line
#    and the check runner free, its own check (#1567, tools/own-check.sh); with it busy, the light check (#1620, tools/light-check.sh).
# 1. Rebases the branch onto the local main. A conflict aborts the rebase and stops here. If the rebase changed land.sh
#    itself, the rebased copy takes over, still holding the lock. Then refuses a branch that removes what a recent landing
#    added without naming it (undo_guard), then runs the guard tests on the rebased commit (#1240: guards(), tools/land/guards.sh).
# 2. Needs the full suite green on the rebased commit. Cara's desktop runs it (.github/workflows/tests.yml) and this
#    waits for that run; when CI can't answer it says CI FALLBACK and runs the suite here (tools/run-tests.sh), only once
#    perigee is quiet (#1254: quiet(), tools/land/ci.sh), in citadel-heavy's slot at nice 19 and half concurrency. See
#    "The gate" below. It waits for that slot only when quiet() saw it free (#499).
# 3. Fast-forwards main in the scheme repo to the branch.
# 4. Runs tools/deploy.sh (it inherits the lock, and skips its own test run when the live checkout lands on the commit
#    that just passed). If that deploys nothing because a check failed and the live checkout went back, main goes back too.
# For a restart that cuts off running turns (only with a person's OK), land first, then run tools/deploy.sh --now.
#
# The ship train (#1166, docs/adr/0020-ship-train.md): at step 2 the landing at the front stacks up to LAND_TRAIN_MAX (6)
# plain lands waiting behind it onto its own commit, runs CI once on the top, and steps 3 and 4 move main and deploy once
# for them all. A red train whose failing test fails on main's tip too refuses nobody (train_main_red, #1430), and ships
# through main's red when that is its only real failure (#1478). Otherwise every ship its really failing tests name is
# pulled (train_suspects, #1918) and the rest runs again; a pulled ship is refused only once it failed alone on main
# (#2098), or adds the case a burn-in failed (burn_new, #2019). With nobody named, the train is split (train_bisect,
# #1899) until one ship is red by itself; only that one is refused. Each rider waits in line and reads its verdict from
# <state>/train/<its ticket> (train_verdict). Off: LAND_TRAIN=0, or touch <state>/train-off.
# A ship refused by the pipeline, not its change, keeps its ticket and rides the next train, once (retry_in_place, #1360).
# Conflict prep (#1366): a ship waiting behind a train that will conflict once it ships is told so while the train is
# tested (a "prep:" line; the server wakes its minion), and its git rerere fix is replayed by its rebase. Off: LAND_PREP=0.
#
# Build branches (#593, specs/build-branches.md in the scheme's shared folder): a build is a branch build/<n>, checked out nowhere.
#   tools/land.sh --into build/<n> <test files>   a feeder merges into it: rebases onto build/<n> (no rebase when it is
#       already under the branch), runs only the named test files, and moves build/<n> by compare-and-swap. No CI, no
#       deploy, main untouched. With no test files it refuses, unless the change is docs only (*.md, docs/).
#       It waits only for other merges into the same build (a lock per build), not in the lands' line.
#   tools/land.sh --into build/<n> --full         the build minion's merge of main: build/<n> must already be under the
#       branch (never a rebase, which would flatten the merge), and the full suite runs as for a land, in the lands' line.
#   tools/land.sh --build                          lands the build its branch is at the tip of: main comes in by merge
#       (a rebase would change its feeders' commit hashes), then the gate, the fast-forward and the deploy, then build/<n> is deleted.
#   A plain land refuses a branch that carries commits of a build/* that main doesn't have: half a build would go live.
#   Claims (#1159): with a build-claims.md on build/<n>, --into first checks the feeder's files against it (claims_check).
# Lock order: the deploy lock (fd 9) before a build's lock (fd 6), and --into takes only the build's, so none waits on the other.
# Paths can be overridden with DEPLOY_LIVE and DEPLOY_SOURCE, as for deploy.sh (how it is tested).
set -euo pipefail

LIVE=${DEPLOY_LIVE:-$HOME/claude-coordinator}
SOURCE=${DEPLOY_SOURCE:-$HOME/.local/share/claude-coordinator/projects/2/repo}

say() { echo "land: $*" >&2; }
refuse() { say "$*"; exit 1; }

# A turn in its person's Claude container (#213) has no deploy lock, user bus or GitHub login here.
[ "${COORDINATOR_CONTAINER:-}" != 1 ] || refuse "this turn runs in a container: call the land tool (mcp__thread) instead, which runs land.sh on the host"
# Inside a slot it would hold a heavy slot, shared by every scheme, while it waits on the deploy lock.
[ -z "${CITADEL_HEAVY_HELD:-}" ] || refuse "run it on its own, not under citadel-heavy: it would hold a heavy slot other schemes need while it waits for the deploy lock"
# --check (#770): only say whether the branch would still rebase onto what it lands on, for the server's hand_off_land.
# No lock, no line and no state: exit 3 with the conflict's refusal when it wouldn't, 0 otherwise (a refusal of
# anything else is 1, as for a land, and the hand-off goes on to meet it there).
check=
[ "${1:-}" != --check ] || { check=1; shift; }
args=("$@") # for the rebased copy (the execs below)
flake_kept=${LAND_FLAKE_KEPT:-0} # how many times this hand-off kept its place after a CI red of flakes only (flake_keep, tools/land/ci.sh)
aside=${LAND_ASIDE:-0} # how many times this hand-off stepped aside from its own red train (train_suspects)
retried=${LAND_RETRIED:-} # why it was refused by the pipeline once already (retry_in_place, tools/land/ci.sh), in the copy that goes again
mode=land build='' files=()
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
      [ $# -eq 0 ] || refuse "--full runs the whole suite: name no test files with it"
    fi
    files=("$@") ;;
  --build) [ $# -eq 1 ] || refuse "--build takes nothing more: run it from the build minion's branch at the build's tip" ; mode=build; export FMT_WHOLE_BUILD=1 ;; # the format check (tools/fmt --own): its feeders' files are this ship's
  *) refuse "takes no arguments besides --into build/<n> <test files>, --into build/<n> --full and --build (for --now, land first, then run tools/deploy.sh --now with a person's OK)" ;;
esac
tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) # before the cd below, which would break a relative path to it
# The parts (tools/land/<part>.sh, #2099): definitions only, all sourced up front, never lazily (a ship whose branch
# predates a part would miss it). They use $tools, not BASH_SOURCE, and touch no state when sourced (--check has none).
for land_part in "$tools"/land/*.sh; do
  # shellcheck source=/dev/null
  [ ! -e "$land_part" ] || . "$land_part"
done
unset land_part
# Which files bash is reading: land.sh and its parts (tools/land/*.sh), each by name and inode. The rebase below may
# replace any of them; a part-only change must hand over too (#2099).
land_self() {
  local f
  for f in "$tools/land.sh" "$tools"/land/*.sh; do [ ! -e "$f" ] || stat -c '%n %d:%i' "$f"; done
}
self=$(land_self)
here=$(git rev-parse --show-toplevel)
cd "$here" # the tests run from the worktree's top, wherever in it this was started
branch=$(git branch --show-current)
{ [ -n "$branch" ] && [ "$branch" != main ]; } || refuse "run it from a minion's branch, not main or a detached HEAD"
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "$here has uncommitted changes: commit them first"
state=$(git -C "$LIVE" rev-parse --absolute-git-dir)/cc-deploy
# shellcheck source=tools/deploy-queue.sh
. "$tools/deploy-queue.sh"
[ -n "$check" ] || mkdir -p -m 700 "$state"
# Conflict prep (#1366): while a train ahead is tested, each plain land behind it checks (prep_check) it would still
# rebase once that train ships. On a conflict its minion is woken (src/land.ts) to record the fix with git rerere in a
# scratch worktree; its rebases replay it (rerere_on) and the early checks count it as clean (rerere_covers).
# Off: LAND_PREP=0, or touch <state>/prep-off.
rr=()
[ "$mode" != land ] || [ "${LAND_PREP:-1}" = 0 ] || [ -e "$state/prep-off" ] || rr=(-c rerere.enabled=true -c rerere.autoupdate=true -c rebase.updateRefs=false)
# git turns rerere on everywhere once rr-cache exists, which these rebases make: keep it to land.sh and the prep steps.
[ ${#rr[@]} -eq 0 ] || [ -n "$(git config --get rerere.enabled)" ] || git config rerere.enabled false 2>/dev/null || true

mode_checks # tools/land/prepare.sh

regen_setup # tools/land/rebase.sh

# LAND_REBASED: this is the rebased land.sh, started below by the one that rebased, and it holds the lock on fd 9.
# LAND_REDO with it: main went back while this waited for the restart ahead, so this starts over once (1: the rebase
# is still to do; 2: done).
resumed= redo=
[ -n "${LAND_REBASED:-}" ] && [ /dev/fd/9 -ef "$state/lock" ] && resumed=1 redo=${LAND_REDO:-}
build_tip # tools/land/build.sh
now_again=${LAND_RETRY_NOW:-}
pre=${LAND_PRE:-} # the branch as it was before the rebase, from the copy that rebased (the prompt baseline, below)
unset LAND_REBASED LAND_REDO LAND_BUILD LAND_RETRY_NOW LAND_RETRIED LAND_FLAKE_KEPT LAND_ASIDE LAND_PRE
if [ -n "$check" ]; then
  under=$(under_of)
  case $mode in
    land | build) early_check main "at hand-off" || exit 3 ;;
    into) git merge-base --is-ancestor "refs/heads/$build" HEAD || early_check "refs/heads/$build" "at hand-off" || exit 3 ;;
  esac
  exit 0 # --full: no rebase, so nothing to check
fi

formatted=''; [ -n "$resumed" ] || [ "$mode" = build ] || [ ! -x tools/fmt ] || [ ! -f "$tools/ship-format.sh" ] || { . "$tools/ship-format.sh"; format_ship; } # the ship's own files, in a commit of their own (#1885)
[ -n "$resumed" ] || [ "$mode" = into ] || [ "${LAND_SMOKE:-1}" = 0 ] || smoke
quiet=$resumed
[ "$redo" != 1 ] && [ -z "$now_again" ] || quiet=
times=$state/times-$$ # the same in the rebased copy, which is this process
if [ -z "$resumed" ]; then
  rm -f "$times" # what a killed landing with this pid left
  find "$state" -maxdepth 1 -name 'times-*' -mmin +1440 -delete 2>/dev/null || true # and other killed ones, a day on
  land_mark start line
  trap 'land_timing $? || true' EXIT # until queue_lock's: its own check, or the build's lock, can end it first (#1864, LA8)
fi
QUEUE_EXIT='land_timing $? || true; queue_done' # queue_lock's EXIT trap here (deploy-queue.sh)
# A rider's side of the ship train (#1166). The landing at the front writes <state>/train/<this ticket>, one line:
#   riding <front's branch> [pulled <tests>]    it is on the train being tested; with pulled, taken off it on a guess from
#                                                the red <tests> (#1918), waiting for the verdict
#   moving <train commit> <front> <tip it took> <front's pid and start>   main holds the train and its deploy runs: the
#                                                branch moves to its train commit now, so the release row lists it
#   back <train commit> <tip it took> <front>    the train went without it, or didn't ship: back to waiting
#   landed <train commit> <live|restart> <front> <tip it took> <ships>   it shipped; its next lines, if any, are said
#                                                as they are (known flakes, #1419; main's red it shipped through, #1478)
#   refused <front> guard-tests guard <tests>    the guard tests failed on the train with it and passed without it (#1479)
#   refused <front> <the red CI run> likely|burn <tests> pinned|new|alone|joined|unrun   the real failures in <tests> (comma-
#                                                separated; burn: in their burn-in) name this ship: pinned: run alone here
#                                                they passed on main and failed with it (#1403); new: it adds the case a
#                                                burn-in failed (#2019); alone|joined|unrun: older guesses (none since
#                                                #2098); the failure's last lines follow
#   alone <front> <tests> <how>                  pulled on a guess, nothing proved it (#2098): back in line to ship alone
# No file: on no train. <held>: this holds the lock now, so a riding is what a killed front left, and so is a moving
# whose front is gone. A moving whose front still runs is its restart being judged (#566): this hands the line on, waits
# for the verdict outside it, and gets back in line if it is back. On landed or refused this ends the landing.
train_dir=$state/train riding=''
[ "$mode" != land ] || [ "${LAND_TRAIN:-1}" = 0 ] || QUEUE_TRAIN=train # the ticket's 6th line (tools/deploy-queue.sh)
# A Regenerate ship (above) holds the line instead: it waits at the front (behind only ships a person placed), rides no
# train and takes no riders, and the restart lock keeps the next ship until it is live (its command must run on a main nothing ships ahead of).
if [ "$mode" = land ] && [ -n "$regen_attrs" ]; then
  QUEUE_TRAIN=hold
  [ -n "$quiet" ] || say "$branch declares Regenerate files (${regen_pats[*]}), so it holds the line: it goes first among the waiters, alone, behind only ships a person placed"
fi
# Conflict prep's waiting side (#1366): while a train ahead is tested (<state>/train-top, top_say in tools/land/train.sh),
# whether this would still rebase once it ships, once per train top, branch tip and count of recorded fixes. A conflict
# the fixes don't resolve says one "prep:" line, which the server turns into a wake (src/land.ts). It never leaves the line.
prepped=''
# The rebased copy is the same process, so its ticket (none, from a land.sh older than the line) still names it, and it
# holds both locks already (an exec keeps its fds); only the trap that removes the ticket has to be set again.
if [ -z "$resumed" ]; then
  [ -z "$build" ] || build_lock || { land_timing 1; exit 1; }
  if [ "$mode" != into ]; then
    # While others are ahead, each time main moves: whether this would still rebase onto it (#770). A conflict leaves
    # the line at once, so the minion is woken now. --full doesn't rebase.
    waited_on=''
    queue_wait_check() {
      local now
      [ "$mode" != land ] || train_verdict || return 0 # riding: the train's top decides, not main
      [ "$mode" != land ] || prep_check
      [ "$mode" != full ] && now=$(git rev-parse -q --verify refs/heads/main) && [ "$now" != "$waited_on" ] || return 0
      waited_on=$now under=$(under_of)
      early_check main "waiting in line"
    }
    quick_train_line
    # A ship's own check (#1567): with others in line and the check runner free, its CI runs first on that runner.
    [ "$mode" != land ] || [ ! -f "$tools/own-check.sh" ] || { . "$tools/own-check.sh"; own_check; }
    queue_lock "$state" "$branch" || { land_timing 1; exit 1; }
    unset -f queue_wait_check
    [ "$mode" != land ] || train_verdict held # its train's front let go of the lock before this read the verdict
  fi
  land_mark lock rebase
fi
trap 'land_timing $? || true; queue_done' EXIT
if [ -n "$build" ]; then
  # Under its lock only land.sh moves it, so this is what a merge into it compares and swaps against.
  base=$(git rev-parse -q --verify "refs/heads/$build") || refuse "$build doesn't exist (a build that landed is deleted), so nothing merged"
  [ "$mode" != build ] || [ -n "$resumed" ] || [ "$base" = "$(git rev-parse HEAD)" ] || refuse "$build moved on while this waited ($(git log -1 --format='%h "%s"' "$base")): bring $branch to it (git merge --ff-only $build) and run it again. Nothing landed"
fi
if [ "$mode" = land ] || [ "$mode" = build ]; then
  # Under the lock: another landing fast-forwarding main there looks like uncommitted changes while it runs.
  [ "$(git -C "$SOURCE" branch --show-current)" = main ] || refuse "$SOURCE is not on main; a person needs to look"
  [ -z "$(git -C "$SOURCE" status --porcelain --untracked-files=no)" ] || refuse "$SOURCE has uncommitted changes; a person needs to look"
  # What a landing or deploy killed outright left half-done (#553): the checkout, then main, go back first, but not
  # beside a restart still being judged (#566): both wait for the restart lock below.
  exec 7>"$state/restart.lock"
  if flock -n 7; then
    deploy_unchecked_back "$state" "$LIVE"
    main_moving_back "$state" "$LIVE" "$SOURCE"
    flock -u 7
  fi
  exec 7>&-
fi

land_rebase # tools/land/rebase.sh
# Bash goes on reading the files it started from, so a rebase that replaced land.sh or a part would land with the old one
# (#500): go on in the rebased one instead, which keeps the lock on fd 9 (and the build's on fd 6). Not --into: that
# holds no deploy lock and only tests and moves a branch.
[ "$mode" = into ] || [ -n "$quiet" ] || [ "$(land_self)" = "$self" ] || LAND_REBASED=1 LAND_REDO=${redo:+2} LAND_BUILD=$build LAND_PRE=$pre LAND_RETRIED=$retried LAND_FLAKE_KEPT=$flake_kept LAND_ASIDE=$aside exec bash "$tools/land.sh" "${args[@]}"

land_regen # tools/land/rebase.sh

# The gate (#523): the full suite, green on this exact commit. Cara's desktop runs it (.github/workflows/tests.yml): the
# commit goes to a scratch branch land/<branch> on GitHub, and this waits for that run, still holding the lock. The wait
# is bounded: no runner online, GitHub not answering, a job no runner starts in time or a run not done within
# LAND_CI_TIMEOUT of starting (LAND_CI_RERUN more for a rerun of its failed files alone, ADR 0022) all fall back, loudly,
# to the run on perigee (also LAND_CI=0, for when CI is broken). "In time" is LAND_CI_START (90 s) with no runner online,
# LAND_CI_START_ONLINE (15 min) while one is online and busy (#1361). A red run refuses, never falls back, with two
# exceptions: #769, a red whose failed files all passed when rerun alone gets one fresh run, and only a fully green one
# lands (ADR 0006); #1377, a run cut off before any test failed (or killed from outside, #1393) gets the same one fresh run.
land_checks # tools/land/gate.sh
land_settings # tools/land/settings.sh

# The line and the lock go before the clean-up on GitHub (#553): a hung gh or push held the lock up to 60 s more.
trap 'land_rc=$?; train_release; train_drop; top_done; land_timing $land_rc || true; queue_done; exec 9>&- 7>&- 6>&-; ci_done; early_end' EXIT
land_gate # tools/land/gate.sh
land_verdict # tools/land/gate.sh
if [ "$mode" = full ]; then
  [ -z "$fellback" ] || say "merged on perigee's own test run, not CI: $fellback"
  [ -z "${known_by[$tip]:-}" ] || say "shipped past known flakes ${known_by[$tip]}"
  [ -z "${through_by[$tip]:-}" ] || say "shipped through main's red on ${through_by[$tip]}"
  merge_into
fi

# The restart lock (#566, tools/deploy-queue.sh): from here on this moves main and the live checkout, so a restart
# still being judged has its verdict first. The rebase and the gate above ran beside it.
restart_lock "$state" || refuse "nothing landed: main is untouched, and $branch keeps the rebased work"
# With that lock a rollback is final: a commit it took out of the checkout comes off main here, if its own landing hasn't yet.
deploy_unchecked_back "$state" "$LIVE"
main_moving_back "$state" "$LIVE" "$SOURCE"
if [ "$(git -C "$SOURCE" rev-parse main)" != "$old" ]; then
  # The gate passed a commit that sits on what came off main: the rebase and the gate are done again, by the land.sh of that rebase.
  [ -z "$redo" ] || refuse "main moved again while this waited for the restart ahead, for the second time, so nothing landed. A person needs to look at main and $state"
  say "main went back to $(git -C "$SOURCE" log -1 --format='%h "%s"' main) while this waited (the restart ahead was rolled back): rebasing $branch onto it and testing again"
  train_drop
  flock -u 7
  exec 7>&-
  LAND_REBASED=1 LAND_REDO=1 LAND_BUILD=$build LAND_PRE=$pre LAND_RETRIED=$retried LAND_FLAKE_KEPT=$flake_kept LAND_ASIDE=$aside exec bash "$tools/land.sh" "${args[@]}"
fi

ship_riders_left # tools/land/ship.sh

# Only when the live checkout doesn't have it (a failed check or a rolled-back restart put it back, or it never pulled): main follows, unless it moved on since.
moved=
# Killed mid-deploy (a person's Stop, a time limit): the same rule, from here on, once the deploy has put the checkout back.
trap 'main_back; exit 130' INT
trap 'main_back; exit 143' TERM
trap 'main_back; exit 129' HUP
bad_check # again: a rollback may have come while this one waited for CI
# Until this ends by itself, however the deploy goes; a kill that skips the trap leaves it for the next landing.
{ echo "$old $tip"; echo "$train_owner"; train_others; } >"$state/moving"
trap 'land_rc=$?; train_release; train_drop; top_done; land_timing $land_rc || true; rm -f "$state/riders-$$"; [ "$(head -n 1 "$state/moving" 2>/dev/null)" != "$old $tip" ] || rm -f "$state/moving"; queue_done; exec 9>&- 7>&- 6>&-; ci_done' EXIT
moved=1
ship_main # tools/land/ship.sh
trap - INT TERM HUP
ship_landed # tools/land/ship.sh
