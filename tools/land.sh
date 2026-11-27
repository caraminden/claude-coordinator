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

label=$branch # for the retro log's lines: which kind of run this is
untouched="main is untouched"
case $mode in
  into | full)
    label="$branch · into $build"
    [ "$mode" = into ] || label="$label, full"
    untouched="$build is untouched"
    # The main the build took in: schema-compat checks against it, not a later release main (#2067).
    if [ "$mode" = full ]; then LAND_BUILD_BASE=$(git merge-base HEAD main) && export LAND_BUILD_BASE; fi
    [[ $branch != build/* ]] || refuse "run it from a feeder's branch or the build minion's own, not from a build branch"
    git show-ref -q --verify "refs/heads/$build" || refuse "$build doesn't exist: its build minion makes it (git branch $build main), so nothing merged"
    for f in "${files[@]}"; do { [[ $f != -* ]] && [ -f "$f" ]; } || refuse "$f is not a file in $here: name the test files this change touched"; done
    if [ "$mode" = into ] && [ ${#files[@]} -eq 0 ]; then
      code=$(git diff --name-only "refs/heads/$build...HEAD" | grep -vE '\.md$|^docs/' || true)
      [ -z "$code" ] || refuse "name the test files this change touched (tools/land.sh --into $build <test files>): only a docs-only change (*.md, docs/) merges in untested, and it changes $(head -n 3 <<<"$code" | sed ':a;N;$!ba;s/\n/, /g')$([ "$(wc -l <<<"$code")" -le 3 ] || echo ' and more'). Nothing merged"
    fi
    claims_gate
    # This run changes the claims: its mark, written whole then moved into place (a half-written one reads as a dead run's).
    if [ "$mode" = into ] && [ -z "$check" ] && ! git diff --quiet "$(git merge-base "refs/heads/$build" HEAD)" HEAD -- build-claims.md; then
      claims_flag=$(claims_mark).$$ claims_new=$(claims_mark)-new.$$ # not a name claims_inflight's glob takes: it would drop it as a dead run's
      trap 'rm -f "$claims_flag" "$claims_new"' EXIT # then land_timing's
      queue_proc $$ >"$claims_new" && mv -f "$claims_new" "$claims_flag"
    fi ;;
  land)
    # A branch on a build's commits would put part of that build live. Not commits that came off main (a rolled-back
    # restart) after a merge of main took them into the build: the rebase below leaves those behind.
    taken=$(cut -d' ' -f1 "$state/taken-back" 2>/dev/null || true)
    while read -r ref; do
      for mb in $(git merge-base --all HEAD "$ref" 2>/dev/null); do
        git merge-base --is-ancestor "$mb" main && continue
        for t in $taken; do git merge-base --is-ancestor "$mb" "$t" 2>/dev/null && continue 2; done
        refuse "$branch carries commits of ${ref#refs/heads/} that main doesn't have, so landing it would put part of that build live; nothing landed. Merge it into the build instead: tools/land.sh --into ${ref#refs/heads/} <the test files you touched>"
      done
    done < <(git for-each-ref --format='%(refname)' 'refs/heads/build/')
esac

# Regenerated files (#1827). A ship whose diff is a command's output says so with trailers on its own commits:
#   Regenerate: <a command, run with bash from the repo's top>
#   Regenerate-files: <the files it writes, as .gitattributes patterns, space-separated>
# Every merge numbers_git makes for it then takes main's side of those files (the citadel-regen driver), so the early
# checks pass it too; after the rebase each command runs again on main and what it wrote is committed (regen_run). A
# conflict in any other file stops as before. Such a ship holds the line (QUEUE_HOLD). Land and --into only; the prompt
# baseline is this step's built-in case. shortcut: a modify/delete conflict in a declared file, or a .gitattributes
# merge= on one, still stops, and a hand edit to a declared file is lost when main changed it too.
regen_cmds=() regen_pats=() regen_attrs=''
if [[ $mode = land || $mode = into ]]; then
  regen_from=main
  [ "$mode" = land ] || regen_from=refs/heads/$build
  # From the branch as it was before the rebase on a re-run: a declared commit whose files main already has drops out of it.
  mapfile -t regen_cmds < <(git log --reverse --format='%(trailers:key=Regenerate,valueonly,unfold)' "$regen_from..${LAND_PRE:-HEAD}" | awk 'NF && !seen[$0]++')
  read -ra regen_pats <<<"$(git log --format='%(trailers:key=Regenerate-files,valueonly,unfold)' "$regen_from..${LAND_PRE:-HEAD}" | tr '\n' ' ')" || true
  [ ${#regen_cmds[@]} -gt 0 ] || [ ${#regen_pats[@]} -eq 0 ] || refuse "$branch has a Regenerate-files: trailer but no Regenerate: <command> one: add the command that writes them (git commit --allow-empty with both trailers), then this again. Nothing landed"
  [ ${#regen_pats[@]} -gt 0 ] || [ ${#regen_cmds[@]} -eq 0 ] || refuse "$branch has a Regenerate: trailer but no Regenerate-files: <patterns> one naming what the command writes: add it (git commit --allow-empty with both trailers), then this again. Nothing landed"
  for p in "${regen_pats[@]}"; do
    case $p in '!'* | '#'* | *=*) refuse "Regenerate-files: takes plain .gitattributes patterns, not \"$p\". Nothing landed" ;; esac
  done
  if [ ${#regen_cmds[@]} -gt 0 ]; then
    regen_attrs=$(git rev-parse --absolute-git-dir)/land-regen.attributes
    { cat "$tools/ship-numbers.attributes"; printf '%s citadel-regen merge=citadel-regen\n' "${regen_pats[@]}"; } >"$regen_attrs.$$"
    mv -f "$regen_attrs.$$" "$regen_attrs"
  fi
fi
# What to do about a conflict, the same for a rebase or merge that stopped and for the early check below.
regen_hint=" If every conflicted file is a command's output (a reformat, a baseline, generated files), declare it instead: a commit with the trailers Regenerate: <command> and Regenerate-files: <those files>, and the ship makes them again on main"

# LAND_REBASED: this is the rebased land.sh, started below by the one that rebased, and it holds the lock on fd 9.
# LAND_REDO with it: main went back while this waited for the restart ahead, so this starts over once (1: the rebase
# is still to do; 2: done).
resumed= redo=
[ -n "${LAND_REBASED:-}" ] && [ /dev/fd/9 -ef "$state/lock" ] && resumed=1 redo=${LAND_REDO:-}
if [ "$mode" = build ]; then
  # The rebased copy is past the merge of main, so HEAD is no longer at the build's tip: the copy that merged names it.
  if [ -n "$resumed" ]; then build=${LAND_BUILD:-}; else build=$(git for-each-ref --points-at HEAD --format='%(refname:lstrip=2)' 'refs/heads/build/'); fi
  if ! [[ $build =~ ^build/[1-9][0-9]{0,5}$ ]]; then
    # One merge ahead of a build: a --build that stopped after merging main, or a merge by hand; with the commit
    # that renumbered its ADRs (below) on top of it, if it made one.
    ahead= tip=HEAD
    ! grep -qF 'Numbered at ship time by tools/land.sh' <<<"$(git log -1 --format=%b HEAD)" || tip=HEAD^ # not a pipe: #646
    [ -n "$build" ] || ! git rev-parse -q --verify "$tip^2" >/dev/null || ahead=$(git for-each-ref --points-at "$tip^1" --format='%(refname:lstrip=2)' 'refs/heads/build/' | head -n 1)
    [ -z "$ahead" ] || refuse "$branch is one merge ahead of $ahead (a --build that stopped after merging main, or a merge of main by hand): run tools/land.sh --into $ahead --full first, then this again. Nothing landed"
    refuse "$branch is not at the tip of a build branch${build:+ (it is at more than one: $(echo $build))}: bring it to its build's tip first (git merge --ff-only build/<n>). Nothing landed"
  fi
  label="$branch · lands $build"
  ! git cat-file -e HEAD:build-claims.md 2>/dev/null || refuse "build-claims.md, the build's claims, is still on $branch and would ship to main: git rm it, commit, run tools/land.sh --into $build (a docs-only merge), then this again. Nothing landed"
fi
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

old=$(git -C "$SOURCE" rev-parse main)
if [ "$mode" = build ] && [ "$redo" = 1 ]; then
  git reset -q --keep "$base" # main went back while this waited: main is merged in again without what came off it
fi
under=$(under_of) # under_of (tools/land/prepare.sh): a commit that came off main, which the rebase leaves behind
[ -n "$pre" ] || pre=$(git rev-parse HEAD)
case $mode in
  land)
    [ -z "$under" ] || say "$branch sits on $(git log -1 --format='%h "%s"' "$under"), which came off main when its deploy was rolled back: leaving it behind"
    [ -n "$quiet" ] || queue_phase "rebasing onto main"
    [ -n "$quiet" ] || say "rebasing $branch onto main ($(git log -1 --format='%h "%s"' main))"
    # The same rebase, made by the early next train (early_next), so CI may have run it already. --keep refuses to
    # overwrite an edit or an untracked file: then the rebase runs and says why.
    if [ -z "$under" ] && c=$(stacked_of "$(git rev-parse main)" "$(git rev-parse HEAD)") && git reset -q --keep "$c" 2>/dev/null; then :
    elif numbers_git ours "${rr[@]}" rebase -q ${under:+--onto} main ${under:+"$under"}; then :
    elif rerere_on . numbers_git ours; then say "the fix recorded ahead of time (git rerere, conflict prep) resolved the rebase's conflicts"; retro_log "train prep replayed · $label onto main ($(git rev-parse --short main))"
    else conflict main rebase "the rebase onto main failed (see git's output above), so nothing landed"; fi ;;
  into | full)
    if git merge-base --is-ancestor "$base" HEAD; then
      say "$build is already under $branch: no rebase"
    else
      # A rebase would flatten the build minion's merge of main.
      [ "$mode" = into ] || refuse "$build has commits this branch doesn't: run git merge $build (not a rebase), re-test, then run this again. Nothing merged"
      say "rebasing $branch onto $build ($(git log -1 --format='%h "%s"' "$base"))"
      numbers_git ours rebase -q "$base" || conflict "refs/heads/$build" rebase "the rebase onto $build failed (see git's output above), so $build is untouched"
    fi
    claims_check main ;; # again under the lock: a feeder that merged while this waited may own a file now
  build)
    # The same commit under a build sits below its merges of main and can't be left behind, so it is reverted by hand.
    while read -r t b; do
      git merge-base --is-ancestor "$t" HEAD 2>/dev/null && ! git merge-base --is-ancestor "$t" main 2>/dev/null || continue
      # Not `git log | grep -q` (#646): grep stops at its match, git log dies of SIGPIPE, and pipefail reads that as "not there".
      said=$(git log --format=%B main..HEAD)
      ! grep -qF "This reverts commit $t" <<<"$said" || continue
      refuse "$build carries $(git log -1 --format='%h "%s"' "$t"), which came off main when its deploy was rolled back, so landing it would put that back live. Nothing landed: on your branch, revert what it brought (git revert --no-edit main..$(git rev-parse --short "$t")), run tools/land.sh --into $build --full, then this again"
    done < <(cat "$state/taken-back" 2>/dev/null || true)
    if git merge-base --is-ancestor main HEAD; then
      [ -n "$quiet" ] || say "$build already has main ($(git log -1 --format='%h "%s"' main))"
    else
      [ -n "$quiet" ] || queue_phase "merging main into $build"
      say "merging main ($(git log -1 --format='%h "%s"' main)) into $build on $branch"
      numbers_git theirs merge -q --no-edit main || conflict main merge "merging main into $build failed (see git's output above), so nothing landed"
    fi ;;
esac
# Bash goes on reading the files it started from, so a rebase that replaced land.sh or a part would land with the old one
# (#500): go on in the rebased one instead, which keeps the lock on fd 9 (and the build's on fd 6). Not --into: that
# holds no deploy lock and only tests and moves a branch.
[ "$mode" = into ] || [ -n "$quiet" ] || [ "$(land_self)" = "$self" ] || LAND_REBASED=1 LAND_REDO=${redo:+2} LAND_BUILD=$build LAND_PRE=$pre LAND_RETRIED=$retried LAND_FLAKE_KEPT=$flake_kept LAND_ASIDE=$aside exec bash "$tools/land.sh" "${args[@]}"

adr_onto=
case $mode in land | build) adr_onto=main ;; into) adr_onto=refs/heads/$build ;; esac # the build's lock holds it at $base
if [ -n "$adr_onto" ]; then
  adr_commit "$adr_onto" "$branch" || refuse "renumbering this branch's ADRs failed (see above), so nothing landed. Run git status, put back what it left, then this again"
  [ -z "$renamed" ] || [ "$mode" != into ] || claims_check main # its link rewrites may reach a file another feeder claims
fi
n=${branch#ticket/} n=${n%%-*}
for c in "${regen_cmds[@]}"; do regen_run "${n:+#$n: }regenerated at ship time: $c" "$c" "${regen_pats[@]}"; done
# The prompt baseline (#1418), the built-in case: a branch that changed it got main's copy from the merge, so it is
# measured again on the merged prompts. shortcut: not for --build, whose merge keeps main's baseline; upgrade if that goes stale and bites.
if [[ $mode = land || $mode = into ]] && [ -f test/prompt-budget.test.ts ] && ! git diff --quiet "$(git merge-base "$adr_onto" "$pre")" "$pre" -- test/prompt-baseline.json; then
  regen_run "${n:+#$n: }test/prompt-baseline.json measured again at ship time" "PROMPT_BASELINE=write $(printf %q "$tools/citadel-node") --no-warnings --test test/prompt-budget.test.ts >/dev/null 2>&1 || true" test/prompt-baseline.json
fi
# The type baseline (#2141): a commit that only lowered it took main's (ship-numbers.ts), so --update lowers it again.
# shortcut: not for --build, whose lowerings wait for the next --update; upgrade if a build's slack baseline bites.
if [[ $mode = land || $mode = into ]] && [ -f tools/typecheck.ts ] &&
  ! git diff --quiet "$(git merge-base "$adr_onto" "$pre")" "$pre" -- test/typecheck-baseline.json; then
  regen_why="after the rebase onto ${adr_onto#refs/heads/}, node tools/typecheck.ts --update refused on $branch, so nothing"
  regen_why+=" landed and $untouched. Fix it on your rebased branch, commit, then this again. It said"
  regen_run "${n:+#$n: }test/typecheck-baseline.json measured again at ship time" \
    "CITADEL_TEST_FILES=0 $(printf %q "$tools/citadel-node") --no-warnings tools/typecheck.ts --update" test/typecheck-baseline.json
  regen_why=
fi

lost_title || refuse "$lost. Nothing landed" # again on the rebased commit, after the smoke check

if [ "$mode" = land ] || [ "$mode" = into ]; then
  onto=main
  [ "$mode" = land ] || onto=$base
  urc=0
  undone=$(undo_guard "$onto") || urc=$?
  if [ "$urc" != 0 ]; then
    [ "$urc" = 1 ] || refuse "the undo check itself failed (exit $urc, above), so nothing landed and $untouched; a person needs to look"
    printf 'land: %s\n' "$branch removes what these landed, without naming them:" >&2
    printf 'land: %s\n' "$undone" >&2
    refuse "nothing landed and $untouched. A squash onto a newer ${build:-main} keeps the branch's old files, which reverts what landed since (git reset --soft from a branch that started further back). Find the branch's last commit before the squash (git reflog), rebase that onto ${build:-main}, and squash only then: git reset --soft \$(git merge-base HEAD ${build:-main}). If the undo is meant, add a line \"Undoes: <sha>\" to a commit message for each commit above, then run this again"
  fi
fi

[ "$mode" = into ] || [ "$mode" = full ] || bad_check

# The gate (#523): the full suite, green on this exact commit. Cara's desktop runs it (.github/workflows/tests.yml): the
# commit goes to a scratch branch land/<branch> on GitHub, and this waits for that run, still holding the lock. The wait
# is bounded: no runner online, GitHub not answering, a job no runner starts in time or a run not done within
# LAND_CI_TIMEOUT of starting (LAND_CI_RERUN more for a rerun of its failed files alone, ADR 0022) all fall back, loudly,
# to the run on perigee (also LAND_CI=0, for when CI is broken). "In time" is LAND_CI_START (90 s) with no runner online,
# LAND_CI_START_ONLINE (15 min) while one is online and busy (#1361). A red run refuses, never falls back, with two
# exceptions: #769, a red whose failed files all passed when rerun alone gets one fresh run, and only a fully green one
# lands (ADR 0006); #1377, a run cut off before any test failed (or killed from outside, #1393) gets the same one fresh run.
tip=$(git rev-parse HEAD)
short=$(git rev-parse --short HEAD)
# The lane (#753, tools/lanes as main has it): light runs no CI, only the tests that read its paths (light_guards), and
# deploy.sh restarts nothing for it; kit runs CI as usual. Lands into a build stay full.
lane=full
if [ "$mode" = land ]; then
  read -r lane lane_why < <(git diff --no-renames --name-only "$old" "$tip" | "$tools/lane.sh" "$old") || lane=full
  [ "$lane" = full ] || say "lane: $lane (tools/lanes; the path that decided it: $lane_why)"
fi

# A light land deploys without the boot check, so a refusing deploy doesn't hold it up.
[ "$mode" = into ] || [ "$mode" = full ] || [ "$lane" = light ] || preflight

# <words>: sets the phase, and moves it on every LAND_PHASE_EVERY s until phase_ticker_end: the line behind gives up on
# one unchanged for DEPLOY_QUEUE_STALL (15 min), and a long step (a fallback suite, the guard tests, #1864) can take
# longer. Once anything else sets the phase, it is theirs. Gone with land.sh: it looks for it at each tick.
ticker=''

# The guard tests, on the rebased commit before a CI run is spent (#1240). Each checks the repo's files against what main
# already holds (a schema number, the prompts' budget, the UI contract, size limits), so a branch clean alone can break
# one only together with main. Only the ones the repo has; --into skips them as it skips CI, and its build's land runs them.
guard_set=(test/schema-compat.test.ts test/prompt-budget.test.ts test/one-until.test.ts test/ui-contract.test.ts test/size-budget.test.ts)
front_guards='' # guards()'s answer on this ship's own commit
if [ "$mode" = into ]; then :
elif [ "$lane" != light ]; then guards
elif [ -f tools/affected.ts ]; then light_guards
fi

# A feeder's merge into a build runs only the test files it touched (Cara's pick, specs/build-branches.md): no CI.
if [ "$mode" = into ]; then
  land_mark tests tests
  if [ ${#files[@]} -gt 0 ]; then
    say "running ${files[*]} on $short"
    guard=()
    [ -r test/leak-guard.ts ] && guard=(--test-global-setup=test/leak-guard.ts)
    timeout -k 30 "${DEPLOY_TEST_TIMEOUT:-600}" "$tools/citadel-node" --test --test-force-exit "${guard[@]}" "${files[@]}" >&2 9>&- 6>&- || refuse "tests failed on the rebased branch (output above), so $build is untouched; $branch keeps the rebased work"
  else
    say "a docs-only change: no tests to run"
  fi
  land_mark gate
  merge_into
fi
REMOTE=${DEPLOY_REMOTE-origin}
CI_WORKFLOW=.github/workflows/tests.yml
CI_LABEL=citadel-ci-linux
CI_REF=land/$branch
CI_STEP='the full suite' # the workflow's step that runs the tests; a run that fails in any other never ran them
CI_CLOCK_STEP="the runner's clock" # the workflow's step that fails on a skewed runner clock
CI_PORTS_STEP='Windows ports left behind' # the workflow's check of the PC itself, run only after a green suite (#1763)
CI_DOWN=${LAND_CI_DOWN:-600} # how long one landing's unanswered wait for CI spares the next ones theirs
# CI_LIMIT: 540 s clears the slowest green run seen (461 s, measured pickup to suite end, burn-in off) with room for the
# suite's growth (#1606); a run that hangs costs 3 min more before it falls back.
CI_START=${LAND_CI_START:-90} CI_START_ONLINE=${LAND_CI_START_ONLINE:-900} CI_LIMIT=${LAND_CI_TIMEOUT:-540} CI_POLL=${LAND_CI_POLL:-15} CI_BACKOFF=${LAND_CI_BACKOFF:-60} # #1655: 5 s was 720 calls an hour for each landing waiting
CI_LATE=${LAND_CI_LATE:-20} CI_LATE_POLL=${LAND_CI_LATE_POLL:-2} # for how long after a push a stop looks for its run, which GitHub lists some seconds late (#1894)
CI_ONLINE_POLL=${LAND_CI_ONLINE_POLL:-30} # how often a job waiting past CI_START asks whether a runner is online
# The reruns alone get a window of their own (#1374): the workflow reruns the failed files in a step of its own, and at
# CI_LIMIT a run whose full suite step failed and that has a rerun step gets CI_RERUN s more, once. A run still in its
# full suite falls back at CI_LIMIT. tests.yml's RERUN_WINDOW is the same number: test/ci-runner-choice.test.ts pins them.
CI_RERUN_STEP='rerun failed files alone' CI_RERUN=${LAND_CI_RERUN:-180}
# The burn-in (#1443, tools/burn-in.sh): the ship's new and changed tests as 10 copies at once, in a step before the full
# suite, needing the ship's base (CI_BASE_REF beside CI_REF). Its red is the ship's own: never a flake, a cut-off or a
# known flake. At CI_LIMIT the run gets the step's time more (CI_BURN at most), once.
CI_BURN_STEP='burn in new and changed tests' CI_BURN=${LAND_CI_BURN:-180} CI_BASE_REF=land-base/$branch
ci_fail_n=0 ci_fail_at=''
ci_quota='' ci_slug='' ci_id='' ci_status='' ci_result='' ci_url='' ci_pushed='' ci_pushed_at='' ci_stale='' why='' burn_red='' burned='' ci_lost='' ci_step=''
# Perigee runs a ship's suite only while it is quiet (#1254): CPU pressure (some avg60) under QUIET_PSI %, load under
# half the cores, at least QUIET_MEM % memory available, citadel-heavy's plain slot and line free. Otherwise the ship
# keeps waiting for CI, and after QUIET_LIMIT s of a busy perigee it is refused. An unreadable reading counts as busy.
# LAND_QUIET_PROC points at a fake /proc, for tests.
QUIET_PROC=${LAND_QUIET_PROC:-/proc} QUIET_PSI=${LAND_QUIET_PSI:-20} QUIET_MEM=${LAND_QUIET_MEM:-25}
QUIET_LIMIT=${LAND_QUIET_LIMIT:-1800} QUIET_POLL=${LAND_QUIET_POLL:-30}
heavy_dir=${CITADEL_HEAVY_DIR:-$HOME/.local/share/claude-coordinator/projects/.heavy}
busy='' busy_spent=0 busy_last='' busy_told=''
no_verdicts=0 NO_VERDICT_MAX=${LAND_NO_VERDICT_MAX:-3}
# A CI red of flakes only on the one fresh run too (#1419): when every failed file passed alone again and no ship on the
# train changed one or what it imports, the ship keeps its place (retry_in_place) instead of going back to its minion,
# at most FLAKE_KEEP_MAX times a hand-off; past that it is refused, so a ship that really breaks something can't circle.
FLAKE_KEEP_MAX=2

# Red on main too (#1430): before a red train's suspects or bisect, or a red ship alone's refusal, each real failure
# (train_real) runs alone here on main's tip ($old), niced, one file at a time, without the lock's fds. One that fails
# there too is main's red, not the train's: neither suspects nor bisect can judge it, so no ship is refused for it: the
# riders go back in line and this one takes its one retry in place (main_red); a ship alone is refused at once, saying
# main is red. A file main hasn't got, or a run stopped at LAND_PIN_LIMIT s or by a test's own timeout, is no main red.
# A red file this ship changed, or what it imports, still fails: it hears that its change doesn't make it pass, with no
# retry (main_red_mine). Fails when no real failure is red on main.
# Ship through (#1478): when every real failure is main's red, no ship on it changed one of them or what it imports, and
# every other failed file passed alone and is a known flake no ship changed (#1419), the gate counts as green (rc=0) and
# it ships, riders and all, saying so; its shipped line names main's red (through_by).
main_red='' main_red_other='' main_red_mine='' main_red_riders=0
declare -A through_by=() # #1478: <commit> -> main's red tests its green was let through on

# The ship train (#1166), the front's side: up to LAND_TRAIN_MAX plain lands waiting behind this one, each replayed onto
# the one before it in a scratch worktree, so CI runs once on the top. Its riders: own=this ship's commit, then
# train_tip, train_br, train_n (its ticket), train_was (its tip as the train took it). Not for a ship with no CI to
# answer, nor while deploys are refusing or rolled back. A waiter keeps its place when it changes the pipeline
# (tools/pipeline-files.txt: those land alone), has merge commits, sits on a commit that came off main, conflicts with
# the train, or fails the undo guard against it.
own=$tip train_tip=() train_br=() train_n=() train_was=() greens=' '
declare -A known_by=() # #1419: <commit> -> the known flakes its green was let through on
# Early next train (#1366, #1568). While this train's CI runs (top_gate), early_next stacks the ship next in line, and
# the train it would take, on this train's top in a scratch worktree, and once this train's run has a runner and another
# ship runner is free, pushes it to early/<its branch>: tests.yml runs it niced beside this one. A red here drops it.
# Each stack goes to <state>/stacked ("<onto> <commit> <result>"), which that ship's own rebase and train_build take
# instead of rebasing again, and ci_gate takes the early run as its own.
# <state>/early: "<top> <its branch> <when pushed> <this branch> <onto> <its riders' tickets, comma-separated, or ->";
# that landing builds its train of those riders only (early_look), and at its gate counts the run or cancels it
# (early_gate). Off: LAND_EARLY=0, or <state>/early-off. With the hold on (no <state>/hold-off, #1902) it goes only at
# this train's deploy, on an idle desktop.
early_ahead='' early_top='' early_pid='' train_only='' train_left='' # train_left: train_only is what is left of a red train (#1918)

# Suspects first (#1346): a red train's real failures (not the flakes) are pinned on ships. Each failing file first runs
# alone here on the train's prefixes (train_pin, #1403): the ship that turns it red is the cause. A file perigee can't
# pin that way is guessed at from the files: the ships whose change touched it; failing that, a file it imports or
# names by its path; failing that, a file those import. What is done with the ships named is train_suspects' header
# (#1918). 0: done (rc as gate's, 1 only for this one alone or confirmed itself), 1: the bisect looks, on the train as it
# now is (its top red, its log in $failed).
suspect_tests='' suspect_new='' train_refused=' ' train_refused_tips='' train_held_tips=''
held_n=() held_br=() held_was=() held_files=() held_run=() held_kind=() held_how=() held_log=()
# The ships a red train is down to: <state>/split, the train's leader as retro_log names it, then a "<ticket> <branch>" line each.
# <rider>: this one and its riders up to that one.
split_of='' split_rest=''

# The line and the lock go before the clean-up on GitHub (#553): a hung gh or push held the lock up to 60 s more.
trap 'land_rc=$?; train_release; train_drop; top_done; land_timing $land_rc || true; queue_done; exec 9>&- 7>&- 6>&-; ci_done; early_end' EXIT
fellback=
rc=0
failed=''
reran=''
land_mark ci ci
if [ "$lane" = light ]; then
  rc=light
  early_gate
else
  # No answer from CI: the suite runs here only on a quiet perigee (#1254). Until then CI is asked again at every look
  # (a runner may come back); busy_wait refuses once perigee has been busy QUIET_LIMIT s. The train's retest and bisect
  # wait the same way, on the commit they test. Runs of a train lost or cut off every time may be a rider's doing: the
  # caller drops the riders, and this one goes on alone (#1864).
  busy_gate() {
    local at=${1:-$tip}
    while [ "$rc" = 2 ] && ! quiet; do
      [ "$no_verdicts" -lt "$NO_VERDICT_MAX" ] || [ ${#train_n[@]} = 0 ] || break
      busy_wait "$why"
      sleep "$QUIET_POLL"
      rc=0
      gate "$at" || rc=$?
    done
    no_verdicts=0
  }
  early_look
  pull_look
  # shellcheck disable=SC2086 # ticket numbers
  train_build $train_only
  # None of a pulled front's kept ships rides now: a run of this one by itself says nothing of the held.
  [ ${#train_n[@]} -gt 0 ] || [ -z "${train_only// /}" ] || train_release
  train_guards
  top_say
  early_gate
  top_gate || rc=$?
  # A train keeps its riders while it waits (#1361): they go back only once the gate gives up for good, to run here.
  busy_gate
  [ "$rc" != 1 ] || train_main_red || [ ${#train_n[@]} = 0 ] || train_suspects || [ ${#train_n[@]} = 0 ] || train_bisect
  train_end
  if [ "$rc" = 2 ] && [ ${#train_n[@]} -gt 0 ]; then
    say "the ship train goes back in line, since CI gave no answer ($why): $branch goes on alone"
    train_drop
    tip=$own short=$(git rev-parse --short "$own")
    top_say
    busy_gate
  fi
fi
land_mark gate
if [ "$rc" = light ]; then
  say "no CI: the server reads nothing in this change (tools/lanes)"
  tested=$tip
elif [ "$rc" = 0 ]; then
  ci_done
  tested=$tip # CI ran the commit and nothing else, so a stray file in this worktree was never part of it
elif [ "$rc" = 1 ]; then
  burn_said=$(burn_lines | paste -sd';' - | sed 's/;/; /g')
  if [ -n "$main_red_mine" ]; then
    refuse "tests failed in CI ($ci_url) in $main_red, which fails on main's own tip too (run alone here), and $branch changed $main_red_mine or what it imports, yet it still fails: main is red and this change doesn't make it pass, so $untouched${main_red_other:+. The run was also red on $main_red_other}. If it is meant to fix it, look into why, re-test, commit, then run this again; if not, run this again once main is green"
  elif [ -n "$main_red" ]; then
    [ "$main_red_riders" = 0 ] || retry_in_place "red on main too: $main_red" # alone, a retry would only run CI on it again
    refuse "tests failed in CI ($ci_url) in $main_red, which fails on main's own tip too (run alone here): main is red, not this change, so $untouched${main_red_other:+. The run was also red on $main_red_other, which may be yours}. Run this again once main is green (a fix for $main_red has shipped)"
  fi
  [ -z "$reran" ] || [ -n "$suspect_tests$burn_said" ] || flake_keep # kept in line, it is no bad ship
  [ -z "$split_of" ] || retro_log "ship train red · $split_of · $branch · $ci_url"
  split_over
  # shellcheck disable=SC2046 # file names
  pulled_out $(train_real || train_failing)
  [ -z "$suspect_new" ] || refuse "a new or changed test failed its burn-in in CI on its ship train ($ci_url): $burn_said, in $suspect_tests, and $branch adds the test case that failed, which main doesn't have, so it is the cause: the ships behind it went back in line, so $untouched. $(burn_advice), then run this again"
  [ -z "$suspect_tests" ] || [ -z "$burn_said" ] || refuse "a new or changed test failed its burn-in in CI on its ship train ($ci_url): $burn_said, in $suspect_tests, and run alone on perigee it passed on main and failed with $branch on it, so it is the cause: the ships behind it went back in line, so $untouched. $(burn_advice), then run this again"
  [ -z "$suspect_tests" ] || refuse "tests failed in CI on its ship train ($ci_url) in $suspect_tests, and run alone on perigee it passed on main and failed with $branch on it, so it is the cause: the ships behind it went back in line, so $untouched. Fix it, re-test, commit, then run this again"
  [ -z "$burn_said" ] || refuse "a new or changed test failed its burn-in in CI ($ci_url): $burn_said, so it never reached the full suite and $untouched. $(burn_advice), then run this again. This is the ship's own red, never a known flake"
  [ -z "$reran" ] || refuse "tests failed on the rebased branch in CI again ($ci_url), on the one fresh run after a red whose files all passed alone ($reran), so $untouched. A second red refuses whatever its labels say"
  refuse "tests failed on the rebased branch in CI ($ci_url), so $untouched"
else
  ci_done
  fellback=$why
  say "=========================================================================="
  say "CI FALLBACK: $why. Running the full suite on perigee instead."
  say "BURN-IN SKIPPED: new and changed tests were not run as 10 copies at once, since that runs only on CI, never on perigee (#1443)"
  say "=========================================================================="
  # Once it asked GitHub; asked again only if it answered then, so an outage isn't waited on twice.
  retro_log "ci fallback · $branch · $why${ci_quota:+ · GitHub calls left: $([ "$ci_quota" = unknown ] && echo unknown || gh_quota)}"
  say "running the tests"
  started=$(date +%H:%M)
  land_mark fallback fallback
  # A file the tests saw that isn't in the commit (never git-added, or ignored) means deploy.sh tests it again.
  # node_modules is no stray: run-tests.sh runs on one that matches the commit's lockfile, or not at all (#1863).
  [ -z "$(git status --porcelain --ignored -- . ':(exclude)node_modules')" ] && tested=$tip || tested=
  log="$state/land-test.log"
  trc=0
  # In citadel-heavy's slot on perigee (nice 19, idle IO) at half run-tests.sh's usual concurrency, so it yields (#1254).
  # Its CPU weight is the embedder's 20, so turns outrank it. A job that took the slot since quiet() looked holds it
  # up no longer than the busy limit's rest: then citadel-heavy gives up (75), and this refuses.
  # --heavy: the suite is CPU work for minutes, so with no past runs to judge by it still takes the slot (#1629).
  half=$(( ( ($(nproc 2>/dev/null || echo 2) + 1) / 2 + 1) / 2 ))
  fallback_limit=$((half < 10 ? 6000 / half : 600)) # run-tests.sh's 600 s is for half the cores; 6 of 9 fallbacks at a quarter of them hit it (#1863)
  [ "$fallback_limit" -le 1800 ] || fallback_limit=1800
  left=$((QUIET_LIMIT - $(busy_waited)))
  # The wait for a slot and then the suite can take longer than the line waits; the reruns set a phase of their own.
  phase_ticker "running the tests since $started"
  CITADEL_HEAVY_WHAT="land.sh's suite for $branch (CI fallback)" CITADEL_HEAVY_MAX_WAIT=${LAND_HEAVY_MAX_WAIT:-$((left > 60 ? left : 60))} \
    CITADEL_TEST_CONCURRENCY=${CITADEL_TEST_CONCURRENCY:-$half} DEPLOY_TEST_CPU_WEIGHT=${DEPLOY_TEST_CPU_WEIGHT-20} \
    DEPLOY_TEST_TIMEOUT=${DEPLOY_TEST_TIMEOUT:-$fallback_limit} \
    "$tools/citadel-heavy" --here --heavy "$tools/run-tests.sh" "$log" 9>&- 6>&- || trc=$? # without the lock's fd: a run that outlives a killed land.sh must not hold it
  phase_ticker_end
  [ "$trc" != 75 ] || retry_in_place "perigee's heavy slot was taken"
  [ "$trc" != 75 ] || refuse "CI and perigee both busy, try again: CI: $why; perigee's heavy slot was taken just before the suite could start, and stayed taken (citadel-heavy's lines above), so no test ran. So $untouched"
  [ "$trc" != 3 ] || refuse "no test ran: the test run could not write its files (the run-tests line above says which), so $untouched"
  [ "$trc" != 4 ] || retry_in_place "the test packages could not be installed on perigee"
  [ "$trc" != 4 ] || refuse "no test ran: the packages the tests import could not be installed here (the run-tests line above says why), so $untouched. Run this again"
  if [ "$trc" != 0 ]; then
    tail -n 40 "$log" >&2
    # The shared log is the next landing's within a second (#553 M6): a red one is kept under the branch's name, for two weeks.
    find "$state" -maxdepth 1 -name 'land-red-*.log' -mtime +14 -delete 2>/dev/null || true
    kept="$state/land-red-${branch//\//-}.log"
    cp "$log" "$kept" 2>/dev/null || kept=$log
    failed=$(cat "$kept" 2>/dev/null) || failed=''
    if ! flakes=$(flake_only) || ! known_flakes "$flakes"; then
      [ -z "$flakes" ] || retry_in_place "failed in the full run but passed alone on perigee: $flakes"
      # Killed from outside before any test failed (#1393): no verdict on the change, so it goes again once, as flakes do.
      if cut_off; then
        retry_in_place "the suite on perigee was killed from outside before any test failed"
        refuse "the suite on perigee was killed from outside before any test failed (full log: $kept): that says nothing about $branch, but it is no answer either, so $untouched. Run this again"
      fi
      # Stopped at its limit: only a file that fails alone here and passes on main is this ship's (#1863).
      if grep -q '^run-tests: the tests ran past' "$kept"; then
        queue_phase "running the stopped suite's suspects alone since $(date +%H:%M)"
        mapfile -t own < <("$tools/test-alone.sh" stopped "$kept" "$tip" "$old" 2>"$state/train-pin.log" 9>&- 7>&- 6>&-)
        [ ${#own[@]} -gt 0 ] || retry_in_place "the suite on perigee ran out of its time limit"
        [ ${#own[@]} -gt 0 ] || refuse "the suite on perigee ran out of its time limit and no test is known to be $branch's own failure (full log: $kept): that is no answer, so $untouched. Run this again"
        refuse "tests failed on the rebased branch: the suite ran out of time, and ${own[*]} fails alone here and passes on main (full log: $kept), so $untouched"
      fi
      refuse "tests failed on the rebased branch (full log: $kept), so $untouched"
    fi
    say "only known flakes failed on perigee: $known_why, so this goes on as green"
    retro_log "known flake · $branch · $known_why · on perigee"
    known_by[$tip]=$known_why
  fi
fi
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

# A rider that left the line while the train was tested (its minion was stopped) doesn't ship: the train ships up to
# the ship before it, and the ones after it go back in line. That commit is tested only if CI passed on it.
for ((i = 0; i < ${#train_n[@]}; i++)); do
  tl=() tv=''
  mapfile -t tl 2>/dev/null <"$state/queue/${train_n[$i]}" || true
  read -r tv _ 2>/dev/null <"$train_dir/${train_n[$i]}" || true
  [ -z "${tl[0]:-}" ] || [ "$(queue_proc "${tl[0]%% *}")" != "${tl[0]}" ] || [ "$tv" != riding ] || continue
  say "ship train: ${train_br[$i]} left the line while the train was tested, so it ships without it and the ships after it go back in line"
  train_drop "$i"
  tip=$(train_at "$i") short=$(git rev-parse --short "$(train_at "$i")")
  top_say
  [[ $greens == *" $tip "* ]] || tested=''
  break
done
train_owner=$branch
[ ${#train_n[@]} = 0 ] || train_owner=${train_br[-1]}

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
# gc.auto=0: a git gc --auto detaches and would keep the lock it inherits.
git -C "$SOURCE" -c gc.auto=0 merge -q --ff-only "$tip" || refuse "could not fast-forward main to $branch; nothing landed"
say "main is now at $(git log -1 --format='%h "%s"' "$tip")"
[ -z "${known_by[$tip]:-}" ] || say "shipped past known flakes ${known_by[$tip]}"
[ -z "${through_by[$tip]:-}" ] || say "shipped through main's red on ${through_by[$tip]}"
if [ ${#train_n[@]} -gt 0 ]; then
  # Each rider moves its own branch (its worktree is its own) within a poll of the line, before the deploy writes the
  # release row, which finds each ship by its branch's tip (src/releases.ts landedIn).
  me=$(queue_proc $$)
  rm -f "$state/riders-$$" # a killed landing's, with this pid
  for ((i = 0; i < ${#train_n[@]}; i++)); do train_say "$i" "moving ${train_tip[$i]} $branch ${train_was[$i]} $me"; done
  for ((w = 0; w < 20; w++)); do
    late=''
    for ((i = 0; i < ${#train_n[@]}; i++)); do
      [ "$(git rev-parse -q --verify "refs/heads/${train_br[$i]}")" = "${train_tip[$i]}" ] || late="$late ${train_br[$i]}"
    done
    [ -n "$late" ] || break
    sleep 0.5
  done
  [ -z "$late" ] || say "ship train:$late didn't move to its train commit within 10 s, so the release row may leave it out"
fi
# In the background, so set -e still holds inside it, but a slip there can't stop this deploy with main moved.
early_drop "$tip" "the train ahead changed after its run started"
early_kept || { early_next 'this one deploys' </dev/null 9>&- 7>&- 6>&- & wait $!; } || say "early next train: it stopped part way (exit $?), so the next ship's CI waits for its turn"
queue_phase "deploying"
land_mark deploy deploy

if ! DEPLOY_LOCKED=1 DEPLOY_TESTED="$tested" DEPLOY_TIMES="$times" DEPLOY_RIDERS="$state/riders-$$" "$here/tools/deploy.sh" 6>&-; then
  main_back
  refuse "the deploy failed after main moved; main keeps $(git log -1 --format=%h "$tip"). The deploy's lines above say why and what to do"
fi
trap - INT TERM HUP
land_mark landed
if [ ${#train_n[@]} -gt 0 ]; then
  for ((i = 0; i < ${#train_n[@]}; i++)); do train_landed "$i"; done
  say "ship train: ${train_br[*]} shipped with $branch, each with its own shipped line"
  retro_log "ship train shipped · $label · $((${#train_n[@]} + 1)) ships · $(git rev-parse --short "$tip")"
  train_n=() train_br=() train_tip=() train_was=()
fi
if [ "$mode" = build ]; then
  # Landed: the branch goes, so the app stops calling it open. Its tip stays in the log line, for a rollback.
  if git update-ref -d "refs/heads/$build" "$base"; then
    say "deleted $build, which is on main now (to make it again if its restart is rolled back: git branch $build $(git rev-parse --short "$base"))"
  else
    say "$build moved during the land (not by land.sh), so it stays: what is in it after $(git rev-parse --short "$base") isn't on main"
  fi
  if [ -n "$REMOTE" ] && git show-ref -q --verify "refs/remotes/$REMOTE/$build"; then
    hub git push -q "$REMOTE" ":refs/heads/$build" 2>/dev/null || say "couldn't delete $build on $REMOTE: delete it there by hand, or the app still counts the build as open"
  fi
fi
queue_done ok
[ -z "$fellback" ] || say "landed on perigee's own test run, not CI: $fellback"
