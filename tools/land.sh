#!/usr/bin/env bash
# Land a minion's branch: run it from the minion's worktree once its work is committed.
#   tools/land.sh
# Under the deploy lock (the one tools/deploy.sh takes), so landings and deploys go one at a time, in the
# order they asked (tools/deploy-queue.sh): it says its place in line, and waits as long as the line moves.
# Each time main moves while it waits, git merge-tree checks the branch would still rebase cleanly; a conflict leaves
# the line at once (#770). tools/land.sh --check runs only that check, for hand_off_land: exit 3 on a conflict.
# The restart the landing before it queued may still be running: steps 1 and 2 go on beside it, and steps 3 and 4
# wait for its verdict (the restart lock, #566). If that restart was rolled back and its commit came off main,
# steps 1 and 2 are done again without it.
# 0. The smoke check (#1012), before it gets in line, so what fails in seconds never holds the line: a trial rebase
#    (git merge-tree), tools/commit-titles.sh, tools/parse-check.ts, and through tools/citadel-test the always-tests plus the test files the
#    branch changes. A fail says "smoke: …", logs a smoke line to the retro log and no timing line. See smoke(), tools/land/prepare.sh.
#    Then, with others in line and the one check runner free, its own check (#1567, tools/own-check.sh): its CI on that
#    runner before it joins the line, so a ship red on its own goes back to its minion without holding anyone up.
#    With that runner busy, the light check instead (#1620, tools/light-check.sh): its own and affected test files on
#    CI's side runner, pinned there on its commit and on main.
# 1. Rebases the branch onto the local main. A conflict aborts the rebase and stops here. If the rebase
#    changed land.sh itself, the rebased copy takes over from here, still holding the lock.
#    Then refuses a branch that removes what a recent landing added without naming it (a stale squash: undo_guard).
#    Then runs the guard tests on the rebased commit (#1240: guards(), tools/land/guards.sh), so a break only the branch and main
#    together make is refused in a second or two, before a CI run is spent on it. A ship train's top and each step of
#    its bisect get the same run (#1479: train_guards, train_bisect).
# 2. Needs the full suite green on the rebased commit, with main untouched otherwise. Cara's desktop runs it
#    (.github/workflows/tests.yml) and this waits for that run; when CI can't answer it says CI FALLBACK and runs
#    the suite here (tools/run-tests.sh), but only once perigee is quiet (#1254: quiet(), tools/land/ci.sh), in citadel-heavy's
#    slot at nice 19 and half concurrency. See "The gate" below. It waits for that slot only when quiet() saw it
#    free: an hour's wait on a slot other schemes' builds held, while holding the lock, starved every landing (#499).
# 3. Fast-forwards main in the scheme repo to the branch.
# 4. Runs tools/deploy.sh (it inherits the lock, and skips its own test run when the live checkout
#    lands on the commit that just passed). If that deploys nothing because a check failed and
#    the live checkout went back, main goes back too, so main only ever holds what passed.
# For a restart that cuts off running turns (only with a person's OK), land first, then run
# tools/deploy.sh --now: it joins the restart this one queued.
#
# The ship train (#1166, docs/adr/0020-ship-train.md): at step 2 the landing at the front of the line stacks up to
# LAND_TRAIN_MAX (6) plain lands waiting behind it onto its own commit, runs CI once on the top, and steps 3 and 4 move
# main and deploy once for them all. A red train whose really failing test fails on main's tip too refuses nobody
# (train_main_red, #1430), and ships through main's red when that is its only real failure (#1478). Otherwise every ship its
# really failing tests name is pulled at once (train_suspects, #1918; Josh, 2026-11-24: "we bisect out the likely failures
# and run 1, 2, 4, 6, 7 if they are green they get shipped and we send 5 and 3 back to debug their failures"), and the rest
# runs again with nobody from the line in the empty seats; a pulled ship is refused only once it failed the test run alone
# on main. One only guessed goes back in line, to ship alone, its own CI run deciding (#2098: refuse only on
# proof; the train passing without it proved nothing). A ship that adds the case a burn-in failed needs no
# such proof (burn_new, #2019). With nobody named, it is split (train_bisect,
# #1899): its front half is tested and ships as soon as it is green; the next front tests part of what is left, until one
# ship is red by itself. Only that one is refused. The rest and the line then form a full train again. Each rider waits in line
# as before and reads its verdict from <state>/train/<its ticket> (train_verdict below). Off: LAND_TRAIN=0, or for
# every landing, touch <state>/train-off.
# A ship refused by the pipeline, not its change, keeps its ticket and rides the next train, once (retry_in_place, #1360).
# Conflict prep (#1366): a ship waiting behind a train that will conflict once it ships is told so while the train is
# tested (a "prep:" line; the server wakes its minion), and the fix it records with git rerere is replayed by its
# rebase. Off: LAND_PREP=0, or touch <state>/prep-off.
#
# Build branches (#593, specs/build-branches.md in the scheme's shared folder): a build is a branch build/<n>, checked out nowhere.
#   tools/land.sh --into build/<n> <test files>   a feeder merges into it: rebases onto build/<n> (no rebase when it is
#       already under the branch), runs only the named test files, and moves build/<n> by compare-and-swap. No CI, no
#       deploy, main untouched. With no test files it refuses, unless the change is docs only (*.md, docs/).
#       It waits only for other merges into the same build (a lock per build), not in the lands' line.
#   tools/land.sh --into build/<n> --full         the build minion's merge of main: build/<n> must already be under the
#       branch (never a rebase, which would flatten the merge), and the full suite runs as for a land (the gate below),
#       in the lands' line, so CI's citadel-tests group still runs one at a time.
#   tools/land.sh --build                          lands the build its branch is at the tip of: main comes in by merge
#       (not rebase: that would flatten the build's merges of main and change its feeders' commit hashes), then the gate,
#       the fast-forward and the deploy as above, then build/<n> is deleted.
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
flake_kept=${LAND_FLAKE_KEPT:-0} # how many times this hand-off kept its place after a CI red of flakes only (flake_keep below)
aside=${LAND_ASIDE:-0} # how many times this hand-off stepped aside from its own red train (train_suspects)
retried=${LAND_RETRIED:-} # why it was refused by the pipeline once already (retry_in_place below), in the copy that goes again
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
# Conflict prep (#1366; Cara, 2026-11-20: "Can we prepare the train that is next up against the version that is
# attempting to ship? ... we can deal with the merge issues before we try to ship and hit a failure"). While a train
# ahead is tested, each plain land waiting behind it checks it would still rebase once that train ships (prep_check).
# On a conflict its minion is woken (src/land.ts) to record the fix ahead of time with git rerere, in a scratch
# worktree on the train's top, never on its own branch; this line's rebases then replay the fix (rerere_on), and the
# early checks count a conflict the fix resolves as clean (rerere_covers). A fix the train never needs (it went red,
# that ship dropped out) just goes unused. Off: LAND_PREP=0, or for every landing, touch <state>/prep-off.
rr=()
[ "$mode" != land ] || [ "${LAND_PREP:-1}" = 0 ] || [ -e "$state/prep-off" ] || rr=(-c rerere.enabled=true -c rerere.autoupdate=true -c rebase.updateRefs=false)
# git turns rerere on everywhere once rr-cache exists, which these rebases make: keep it to land.sh and the prep steps.
[ ${#rr[@]} -eq 0 ] || [ -n "$(git config --get rerere.enabled)" ] || git config rerere.enabled false 2>/dev/null || true

# A claims merge in flight (#1684, as in the kit's template): the build minion's --into of a changed build-claims.md marks
# itself with <state>/build-<n>.claims.<pid> (its queue_proc identity), waiting for the build's lock included; a mark whose
# process is gone counts for nothing. claims_inflight prints the pid of a live one other than this run (a dead one's goes).
claims_mark() { echo "$state/build-${build#build/}.claims"; }
claims_inflight() {
  local f
  for f in "$(claims_mark)".*; do
    [ -f "$f" ] && [ "${f##*.}" != $$ ] || continue
    [ "$(queue_proc "${f##*.}")" != "$(cat "$f" 2>/dev/null)" ] || { echo "${f##*.}"; return 0; }
    rm -f "$f"
  done
  return 1
}
# claims_check, unless a claims merge is in flight: the claims are about to change, so a feeder's hand-off (--check)
# goes ahead, and its run waits for that merge to end and is checked against the new plan rather than refused against
# the old one. Under the build's lock claims_check runs again whatever happened here.
claims_gate() {
  local pid t=$SECONDS
  if pid=$(claims_inflight); then
    say "claims merge in flight on $build (the build minion's run, pid $pid), waiting for it to end; the claims are checked against the new plan after"
    [ -z "$check" ] || return 0
    while pid=$(claims_inflight); do
      [ $((SECONDS - t)) -lt "${LAND_BUILD_WAIT:-3600}" ] || refuse "waited ${LAND_BUILD_WAIT:-3600} s for the claims merge on $build (pid $pid) to end, so nothing merged: run it again later"
      sleep "$QUEUE_POLL"
    done
    say "the claims merge on $build ended: checking the claims"
  fi
  claims_check main
}

label=$branch # for the retro log's lines: which kind of run this is
untouched="main is untouched"
case $mode in
  into | full)
    label="$branch · into $build"
    [ "$mode" = into ] || label="$label, full"
    untouched="$build is untouched"
    # The main the build took in: schema-compat checks against it, not a last release main shipped while this waited (#2067).
    if [ "$mode" = full ]; then LAND_BUILD_BASE=$(git merge-base HEAD main) && export LAND_BUILD_BASE; fi
    [[ $branch != build/* ]] || refuse "run it from a feeder's branch or the build minion's own, not from a build branch"
    git show-ref -q --verify "refs/heads/$build" || refuse "$build doesn't exist: its build minion makes it (git branch $build main), so nothing merged"
    for f in "${files[@]}"; do { [[ $f != -* ]] && [ -f "$f" ]; } || refuse "$f is not a file in $here: name the test files this change touched"; done
    if [ "$mode" = into ] && [ ${#files[@]} -eq 0 ]; then
      code=$(git diff --name-only "refs/heads/$build...HEAD" | grep -vE '\.md$|^docs/' || true)
      [ -z "$code" ] || refuse "name the test files this change touched (tools/land.sh --into $build <test files>): only a docs-only change (*.md, docs/) merges in untested, and it changes $(head -n 3 <<<"$code" | sed ':a;N;$!ba;s/\n/, /g')$([ "$(wc -l <<<"$code")" -le 3 ] || echo ' and more'). Nothing merged"
    fi
    claims_gate
    # This run changes the claims: its mark. Written whole, then moved into place: a feeder reading it half-written would
    # take it for a dead one's.
    if [ "$mode" = into ] && [ -z "$check" ] && ! git diff --quiet "$(git merge-base "refs/heads/$build" HEAD)" HEAD -- build-claims.md; then
      claims_flag=$(claims_mark).$$ claims_new=$(claims_mark)-new.$$ # not a name claims_inflight's glob takes: it would drop it as a dead run's
      trap 'rm -f "$claims_flag" "$claims_new"' EXIT # then land_timing's
      queue_proc $$ >"$claims_new" && mv -f "$claims_new" "$claims_flag"
    fi ;;
  land)
    # The guard: a branch on a build's commits (a feeder that ran the usual command) would put part of that build live.
    # Not commits that came off main (a rolled-back restart) after a merge of main took them into the build: the rebase
    # below leaves those behind, as it does for any branch.
    taken=$(cut -d' ' -f1 "$state/taken-back" 2>/dev/null || true)
    while read -r ref; do
      for mb in $(git merge-base --all HEAD "$ref" 2>/dev/null); do
        git merge-base --is-ancestor "$mb" main && continue
        for t in $taken; do git merge-base --is-ancestor "$mb" "$t" 2>/dev/null && continue 2; done
        refuse "$branch carries commits of ${ref#refs/heads/} that main doesn't have, so landing it would put part of that build live; nothing landed. Merge it into the build instead: tools/land.sh --into ${ref#refs/heads/} <the test files you touched>"
      done
    done < <(git for-each-ref --format='%(refname)' 'refs/heads/build/')
esac

# Regenerated files (#1827; Cara, 2026-11-24: "a way for them to make an update at the front of the CI queue to
# preemptively fix a foreseeable issue instead of having to wait for the queue to totally empty while constantly being
# kicked out"). A ship whose diff is a command's output (a reformat, a baseline, generated files) says so with trailers
# on its own commits:
#   Regenerate: <a command, run with bash from the repo's top>
#   Regenerate-files: <the files it writes, as .gitattributes patterns, space-separated>
# Every merge numbers_git makes for it then takes main's side of those files instead of stopping on them (the
# citadel-regen driver keeps %A, main's side in a rebase and in merge-tree), so the early checks pass it too; after the
# rebase each command runs again on main and what it wrote is committed (regen_run, below). A conflict in any other
# file stops as before. Such a ship holds the line (QUEUE_HOLD, below). Land and --into only; the prompt baseline is
# this step's built-in case. shortcut: a modify/delete conflict in a declared file, or a .gitattributes merge= on one,
# still stops, and a hand edit to a declared file is lost when main changed it too: declare only what the command writes.
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
# The early check (#770): <onto> <when>. Whether the rebase onto <onto> (--build's merge of it) would stop on a conflict,
# by git merge-tree, which touches no worktree, index or ref. With $under, as the rebase's --onto leaves it behind. On a
# conflict it logs the files as conflict() does, says the same refusal, and fails. A git that can't tell (exit 2 and up)
# counts as clean: the rebase itself decides then. shortcut: a three-way merge, not a replay commit by commit. A branch
# that changes a line and changes it back can pass here and still stop in the rebase, which catches it as before; and a
# branch whose commit main already has as a cherry-pick, with a later commit on the same lines, is refused here though
# the rebase would skip it: the git rebase the refusal names then goes through clean. Upgrade to a replay if that bites.
# A conflict the fix recorded with git rerere resolves counts as clean (conflict prep, above): rerere_covers replays it.
# <onto>: a scratch folder holding <onto>'s .gitattributes files (nested ones too), printed, for trial()'s merge-tree to
# run in. git reads attributes from the worktree it runs in, then its index, and git before 2.40 ignores attr.tree, which
# read the branch's there (#2071): so trial() runs it in this folder with an empty index, and every git reads <onto>'s
# as the rebase onto it will. Removed after the trial.
attrs_of() {
  local d m o p
  d=$(mktemp -d "${TMPDIR:-/tmp}/land-attrs.XXXXXX") && d=$(cd "$d" && pwd -P) || return 1
  # A symlink's text isn't read as attributes, so only plain files are copied.
  while IFS=$'\t' read -r -d '' m p; do
    read -r m _ o <<<"$m"
    case $m:/$p in 1006??:*/.gitattributes) ;; *) continue ;; esac
    mkdir -p "$d/$(dirname "$p")" && git cat-file blob "$o" >"$d/$p" || { rm -rf "$d"; return 1; }
  done < <(git ls-tree -r -z "$1")
  echo "$d"
}

# LAND_REBASED: this is the rebased land.sh, started below by the one that rebased, and it holds the lock on fd 9.
# LAND_REDO with it: main went back while this waited for the restart ahead, so this starts over, once (1: the rebase
# is still to do; 2: done, by the copy that started this one).
resumed= redo=
[ -n "${LAND_REBASED:-}" ] && [ /dev/fd/9 -ef "$state/lock" ] && resumed=1 redo=${LAND_REDO:-}
if [ "$mode" = build ]; then
  # The rebased copy is past the merge of main, so HEAD is no longer at the build's tip: the copy that merged names it.
  if [ -n "$resumed" ]; then build=${LAND_BUILD:-}; else build=$(git for-each-ref --points-at HEAD --format='%(refname:lstrip=2)' 'refs/heads/build/'); fi
  if ! [[ $build =~ ^build/[1-9][0-9]{0,5}$ ]]; then
    # One merge ahead of a build: a --build that stopped after merging main (a red gate, a failed deploy), or a merge by
    # hand; with the commit that renumbered its ADRs (below) on top of that merge, if it made one.
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

# Commit titles (#1489): a rebase stopped on a conflict and continued with GIT_EDITOR=true used to read "#N: ..." as a comment
# and drop it. One line in $lost naming the first commit that lost its title while a sibling kept theirs; a plain scheme has none.
lost_title() { # <git log's range...>: what it reads, instead of everything from main or the build
  [ $# -gt 0 ] || set -- "$([ "$mode" = into ] && echo "refs/heads/$build" || echo main)"
  [ "$mode" = build ] || [ ! -x "$tools/commit-titles.sh" ] || lost=$("$tools/commit-titles.sh" "$@" 2>&1)
}
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
#   riding <front's branch> [pulled <tests>]    it is testing a train with this ship on it; with pulled, it took this
#                                                ship off it on a guess from the red <tests> and it waits for the verdict (#1918)
#   moving <train commit> <front> <tip it took> <front's pid and start>   main holds the train and its deploy runs: the
#                                                branch moves to its train commit now, so the release row lists it
#   back <train commit> <tip it took> <front>    the train went without it, or didn't ship: back to waiting, as it was
#   landed <train commit> <live|restart> <front> <tip it took> <ships>   it shipped; its next lines, if any, are said
#                                                as they are (known flakes, #1419; main's red it shipped through, #1478)
#   refused <front> guard-tests guard <tests>    the guard tests failed on the train with it and passed without it (#1479)
#   refused <front> <the red CI run> likely|burn <tests> pinned|new|alone|joined|unrun   the real failures in <tests> (comma-
#                                                separated; burn: in their burn-in) name this ship: with pinned, run alone
#                                                here they passed on main and failed with it on main (#1403); new: it adds
#                                                the case a burn-in failed (#2019); alone|joined|unrun: an older front's
#                                                refusal on a guess (#1918, none since #2098); The failure's last lines follow
#   alone <front> <tests> <how>                  it was pulled on a guess and nothing proved it (#2098): back in line, to
#                                                ship by itself, so its own CI run decides
# No file: on no train. <held>: this holds the lock now, so a riding is what a front that was killed left, and so is a
# moving whose front is gone. A moving whose front still runs is its restart being judged, after deploy.sh let go of
# the line (#566): this hands the line on and waits for the verdict outside it, and gets back in line if it is back.
# On landed or refused this ends the landing, as its own ship would have.
train_dir=$state/train riding=''
[ "$mode" != land ] || [ "${LAND_TRAIN:-1}" = 0 ] || QUEUE_TRAIN=train # the ticket's 6th line (tools/deploy-queue.sh)
# A Regenerate ship (above) holds the line instead (Cara picked "Regenerate + hold the line", 2026-11-24): it waits at the
# front (behind only ships a person placed), rides no train and takes no riders, and the restart lock keeps the next ship until it is live. Anything
# that ships ahead of it would only make its command run on a newer main; anything batched with it would conflict.
if [ "$mode" = land ] && [ -n "$regen_attrs" ]; then
  QUEUE_TRAIN=hold
  [ -n "$quiet" ] || say "$branch declares Regenerate files (${regen_pats[*]}), so it holds the line: it goes first among the waiters, alone, behind only ships a person placed"
fi
# The front (pid $1) hands its riders' lines to deploy.sh (DEPLOY_RIDERS): "<api> <token> <ticket> <train commit>", as
# its reporter() writes this one's own. A failed write never stops a landing.
train_reporter() {
  [ -n "${COORDINATOR_API:-}" ] && [ -n "${COORDINATOR_TOKEN:-}" ] && [ -n "${COORDINATOR_TICKET:-}" ] || return 0
  (umask 077 && echo "$COORDINATOR_API $COORDINATOR_TOKEN $COORDINATOR_TICKET $2" >>"$state/riders-$1") || true
}
# Conflict prep's waiting side (#1366, above): while a train ahead of this one is tested (<state>/train-top, top_say
# below), whether this would still rebase once it ships, by git merge-tree, as against main. Once per train top, branch
# tip and count of recorded fixes. A conflict the recorded fixes don't resolve says one "prep:" line, which the server
# turns into a wake with the steps (src/land.ts), naming the ship on the train that brings it (the first train commit it
# conflicts with). It never leaves the line: the minion's fix, or the conflict at its rebase, decides as before.
prepped=''
# Whether this ship would ride the quick train, and why not (#1912; tools/quick-train.ts, specs/quick-train.md in the shared
# folder): one retro line per ship, and nothing else. In a subshell, its failures swallowed and 10 s at most (about 0.3 s), so it never decides a landing.
# LAND_RISK is the hand-off's label (src/ship-handoff.ts). shortcut: judged on the branch before its rebase.
quick_train_line() (
  set +e
  { [ "$mode" = land ] || [ "$mode" = build ]; } && [ -f "$tools/quick-train.ts" ] || exit 0
  base=$(under_of) && [ -n "$base" ] || base=$(git merge-base main HEAD)
  out=$(timeout 10 "$tools/citadel-node" "$tools/quick-train.ts" --main main --base "$base" --risk "${LAND_RISK:-}" --mode "$mode")
  retro_log "quick train · $label · ${out:-not: could not be judged}"
) >/dev/null 2>&1 9>&- 7>&- 6>&- 5>&- </dev/null || true
# The rebased copy is the same process, so the ticket it was started with (none, from a land.sh older than the
# line) still names it, and it holds both locks already (an exec keeps its fds); only the trap that removes the
# ticket at the end has to be set again.
if [ -z "$resumed" ]; then
  [ -z "$build" ] || build_lock || { land_timing 1; exit 1; }
  if [ "$mode" != into ]; then
    # While others are ahead, each time main moves: whether this would still rebase onto it (#770). A conflict leaves
    # the line at once, so the minion is woken now rather than when it reaches the front. --full doesn't rebase.
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
  # What a landing or deploy killed outright left half-done (#553): the checkout, then main, go back first.
  # Not beside a restart still being judged (#566): it restarted on that checkout, so both wait for the restart lock below.
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
under=$(under_of) # under_of above: a commit that came off main, which the rebase leaves behind
[ -n "$pre" ] || pre=$(git rev-parse HEAD)
case $mode in
  land)
    [ -z "$under" ] || say "$branch sits on $(git log -1 --format='%h "%s"' "$under"), which came off main when its deploy was rolled back: leaving it behind"
    [ -n "$quiet" ] || queue_phase "rebasing onto main"
    [ -n "$quiet" ] || say "rebasing $branch onto main ($(git log -1 --format='%h "%s"' main))"
    # The same rebase, made by the early next train (early_next), so CI may have run it already. --keep refuses to
    # overwrite an edit or an untracked file, as the rebase would: then the rebase runs and says why.
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
      # Not `git log | grep -q` (#646): grep stops reading at its match, git log dies of SIGPIPE on the rest, and
      # pipefail turns the match into "not there".
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
# Bash goes on reading the files it started from, so a rebase that replaced land.sh or a part would land with the old one (#500):
# go on in the rebased one instead. It keeps the lock on fd 9 (and the build's on fd 6), and its own rebase finds
# nothing to do. Not --into: that holds no deploy lock for the copy to find, and only tests and moves a branch.
[ "$mode" = into ] || [ -n "$quiet" ] || [ "$(land_self)" = "$self" ] || LAND_REBASED=1 LAND_REDO=${redo:+2} LAND_BUILD=$build LAND_PRE=$pre LAND_RETRIED=$retried LAND_FLAKE_KEPT=$flake_kept LAND_ASIDE=$aside exec bash "$tools/land.sh" "${args[@]}"

# ADR numbers at ship time (#1221): a docs/adr/NNNN-*.md this branch adds whose number main (a feeder: the build) took
# while it waited goes to the next free number, with its links and the branch's own "ADR NNNN" lines, in one commit.
# <onto> <branch> [<onto's name>]: in this folder's worktree; sets renamed, the renames it committed. Fails with what
# it left in the worktree when the renumbering fails.
adr_commit() {
  local n=${2#ticket/}
  renamed=''
  [ -f "$tools/ship-numbers.ts" ] || return 0
  renamed=$("$tools/citadel-node" --no-warnings "$tools/ship-numbers.ts" adr "$1" ${3:+"$3"} </dev/null) || return 1
  [ -n "$renamed" ] || return 0
  n=${n%%-*}
  git commit -q -m "${n:+#$n: }$(head -n 1 <<<"$renamed")" -m "Numbered at ship time by tools/land.sh (#1221):" -m "$renamed" || return 1
  sed 's/^/land: /' <<<"$renamed" >&2
}
adr_onto=
case $mode in land | build) adr_onto=main ;; into) adr_onto=refs/heads/$build ;; esac # the build's lock holds it at $base
if [ -n "$adr_onto" ]; then
  adr_commit "$adr_onto" "$branch" || refuse "renumbering this branch's ADRs failed (see above), so nothing landed. Run git status, put back what it left, then this again"
  [ -z "$renamed" ] || [ "$mode" != into ] || claims_check main # its link rewrites may reach a file another feeder claims
fi
n=${branch#ticket/} n=${n%%-*}
for c in "${regen_cmds[@]}"; do regen_run "${n:+#$n: }regenerated at ship time: $c" "$c" "${regen_pats[@]}"; done
# The prompt baseline (#1418), the built-in case: a branch that changed it got main's copy from the merge (numbers_git
# above), so it is measured again on the merged prompts. shortcut: not for --build, whose merge of main keeps main's
# baseline (it only lists what grew, it never fails a test); upgrade if a build's baseline going stale bites.
if [[ $mode = land || $mode = into ]] && [ -f test/prompt-budget.test.ts ] && ! git diff --quiet "$(git merge-base "$adr_onto" "$pre")" "$pre" -- test/prompt-baseline.json; then
  regen_run "${n:+#$n: }test/prompt-baseline.json measured again at ship time" "PROMPT_BASELINE=write $(printf %q "$tools/citadel-node") --no-warnings --test test/prompt-budget.test.ts >/dev/null 2>&1 || true" test/prompt-baseline.json
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

# The gate (#523): the full suite, green on this exact commit. Cara's desktop runs it (.github/workflows/tests.yml, on
# the Linux runner in WSL) so perigee doesn't: the commit goes to a scratch branch land/<branch> on GitHub, and this
# waits for that run, still holding the lock. Landings are one at a time whatever the lock does (the one behind
# can't know its commit until this one moves main), so letting go of it would speed nobody up. The wait is bounded
# instead: no runner online, GitHub not answering, a job no runner starts in time or a run not done within
# LAND_CI_TIMEOUT of starting (LAND_CI_RERUN more for a run rerunning its failed files alone, ADR 0022) all fall back,
# loudly, to the run on perigee (also LAND_CI=0, for when CI itself is broken). "In time" is LAND_CI_START (90 s) with
# no runner online, but LAND_CI_START_ONLINE (15 min) while one is online and merely busy with another ship's run
# (#1361, Cara 2026-11-20 "Wait for a busy desktop": 39 suites ran on perigee that day, every one with the desktop
# online). A red run refuses, and never falls back, with two exceptions. #769: a red in which every failed test file
# passed when run-tests.sh reran it alone gets one fresh CI run of the same commit, and only a fully green one lands.
# #1377: a run cut off before any test failed (or killed from outside, #1393) gets the same one fresh run, and cut off
# again it is no answer.
# That reverses Cara's 2026-11-10 "Keep failing, log it" for CI: she picked "2 Rerun CI on flake-only red" on #767's
# card, 2026-11-15 (docs/adr/0006-rerun-ci-on-flake-only-red.md).
tip=$(git rev-parse HEAD)
short=$(git rev-parse --short HEAD)
# The lane (#753, tools/lanes as main has it): light runs no CI, only the tests that read its paths (light_guards), and
# deploy.sh restarts nothing for it; kit runs CI as usual, where tools/run-tests.sh picks the test files that read the kit. Lands into a build stay full.
lane=full
if [ "$mode" = land ]; then
  read -r lane lane_why < <(git diff --no-renames --name-only "$old" "$tip" | "$tools/lane.sh" "$old") || lane=full
  [ "$lane" = full ] || say "lane: $lane (tools/lanes; the path that decided it: $lane_why)"
fi

# A light land deploys without the boot check, so a refusing deploy doesn't hold it up.
[ "$mode" = into ] || [ "$mode" = full ] || [ "$lane" = light ] || preflight

# <words>: sets the phase, and moves it on every LAND_PHASE_EVERY s until phase_ticker_end: the line behind gives up on
# one unchanged for DEPLOY_QUEUE_STALL (15 min), and a long step's own work can take longer than that (a fallback suite,
# the guard tests and the runs alone that find a red train's cause, #1864). Once anything else sets the phase, it is
# theirs. Gone with land.sh: it looks for it at each tick.
ticker=''
phase_ticker() {
  queue_phase "$1"
  (
    exec 9>&- 7>&- 6>&-
    trap 'exit 0' TERM
    t0=$SECONDS
    while :; do
      read -rt "${LAND_PHASE_EVERY:-300}" <> <(:) || [ $? -gt 128 ] || exit 0 # a sleep with no child left behind: only a timeout ticks
      kill -0 $$ 2>/dev/null || exit 0
      mapfile -t l 2>/dev/null <"${DEPLOY_QUEUE_TICKET:-/dev/null}" || exit 0
      [[ ${l[3]:-} == "$1"* ]] || exit 0
      queue_phase "$1, $(((SECONDS - t0) / 60)) min so far"
    done
  ) &
  ticker=$!
}
phase_ticker_end() {
  [ -n "$ticker" ] || return 0
  kill "$ticker" 2>/dev/null || true
  wait "$ticker" 2>/dev/null || true
  ticker=''
}

# The guard tests, on the rebased commit before a CI run is spent (#1240). Each checks the repo's files against what
# main already holds (a schema number, the prompts' budget, the tests' own wait helpers, the UI contract, the files' size limits), so a branch that
# was clean alone can break one only together with main: the smoke check, on the branch as it was, can't see that, and
# on 2026-11-20 the first four were most of CI's real reds, and size-budget reddened whole trains on 2026-11-24. A second or two. Only the ones the repo has; a feeder's merge
# into a build (--into) skips them as it skips CI, and its build's own land runs them.
guard_set=(test/schema-compat.test.ts test/prompt-budget.test.ts test/one-until.test.ts test/ui-contract.test.ts test/size-budget.test.ts)
front_guards='' # guards()'s answer on this ship's own commit
# A light ship gets no CI, so its guards are the tests the affected map picks for its paths (#1864, LA2): a README line or
# a rule file can break a test that reads it (layout-map, rule-homes), and main would go red with nothing between.
light_guards() {
  local aff
  if ! aff=$("$tools/citadel-node" --no-warnings tools/affected.ts --root . --base "$old" 2>/dev/null); then
    say "the affected map couldn't answer, so no test that reads these paths ran: main's own CI decides"
    return 0
  fi
  mapfile -t guard_set < <(sed -nE $'s/^run\t([^\t]+)\t.*/\\1/p' <<<"$aff")
  guards
}
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
# CI_LIMIT was 360 s (#1361) until #1606: the suite grew (summed test time 1206 s on Nov 19, 1907 s on Nov 21, 3500 s on
# a pipeline-tier ship), and of 69 green land runs from Nov 21 11:30 to Nov 22 PST, counted as this does (pickup to
# the suite's end, burn-in taken off), p50 was 259 s, p90 353, p95 369 and the max 461: 6 greens ran past 360 s and fell
# back. 540 s clears that max with room for the suite's growth; a run that hangs costs 3 min more before it falls back.
CI_START=${LAND_CI_START:-90} CI_START_ONLINE=${LAND_CI_START_ONLINE:-900} CI_LIMIT=${LAND_CI_TIMEOUT:-540} CI_POLL=${LAND_CI_POLL:-15} CI_BACKOFF=${LAND_CI_BACKOFF:-60} # #1655: 5 s was 720 calls an hour for each landing waiting
CI_LATE=${LAND_CI_LATE:-20} CI_LATE_POLL=${LAND_CI_LATE_POLL:-2} # for how long after a push a stop looks for its run, which GitHub lists some seconds late (#1894)
CI_ONLINE_POLL=${LAND_CI_ONLINE_POLL:-30} # how often a job waiting past CI_START asks whether a runner is online
# The reruns alone get a window of their own (#1374, Cara 2026-11-20: "maybe that situation should restart the timer?
# instead of globally raising it to 10m?"). On Nov 20 a busy desktop's full run took 295-351 s, so it ended past the
# reruns' deadline and every flake counted as a real red. So the workflow reruns the failed files in a step of its own,
# and at CI_LIMIT a run whose full suite step failed and that has a rerun step gets CI_RERUN s more, once. A run
# still in its full suite falls back at CI_LIMIT as before. tests.yml's RERUN_WINDOW is the same number:
# test/ci-runner-choice.test.ts pins them together.
CI_RERUN_STEP='rerun failed files alone' CI_RERUN=${LAND_CI_RERUN:-180}
# The burn-in (#1443, tools/burn-in.sh): the ship's new and changed tests as 10 copies at once, in a step before the full
# suite. It needs the ship's base, which goes to GitHub as CI_BASE_REF beside CI_REF. Its red is the ship's own: never a
# flake, a cut-off or a known flake. At CI_LIMIT the run gets the step's time more (CI_BURN at most), once.
CI_BURN_STEP='burn in new and changed tests' CI_BURN=${LAND_CI_BURN:-180} CI_BASE_REF=land-base/$branch
ci_fail_n=0 ci_fail_at=''
ci_quota='' ci_slug='' ci_id='' ci_status='' ci_result='' ci_url='' ci_pushed='' ci_pushed_at='' ci_stale='' why='' burn_red='' burned='' ci_lost='' ci_step=''
# Perigee runs a ship's suite only while it is quiet (#1254, Josh 2026-11-20: "only if and when perigee has plenty of
# resources, just make sure we play nice and that it doesnt affect performance"): CPU pressure (some avg60) under
# QUIET_PSI %, the 1-minute load under half the cores, at least QUIET_MEM % of memory available, and citadel-heavy's
# plain slot and line free. Otherwise the ship keeps waiting for CI, and after QUIET_LIMIT s of a busy perigee it is refused.
# The kit's land template has no such rule because it has no fallback: with no answer from CI it exits 75 and runs nothing.
# A reading it can't take counts as busy: no evidence of quiet is no quiet. LAND_QUIET_PROC points at a fake /proc, for tests.
QUIET_PROC=${LAND_QUIET_PROC:-/proc} QUIET_PSI=${LAND_QUIET_PSI:-20} QUIET_MEM=${LAND_QUIET_MEM:-25}
QUIET_LIMIT=${LAND_QUIET_LIMIT:-1800} QUIET_POLL=${LAND_QUIET_POLL:-30}
heavy_dir=${CITADEL_HEAVY_DIR:-$HOME/.local/share/claude-coordinator/projects/.heavy}
busy='' busy_spent=0 busy_last='' busy_told=''
no_verdicts=0 NO_VERDICT_MAX=${LAND_NO_VERDICT_MAX:-3}
# <what it says once back>: this ship lets go of the lock, keeps its ticket and lets the next one go first; back at the
# front it starts over from its rebase.
requeue() {
  train_drop
  train_release # none after pull_say, which hands them over
  top_done
  early_end # its background stack must not outlive this run's hold on the lock (#1864, LA6)
  ci_done
  trap 'land_timing $? || true; queue_done' EXIT
  queue_wait_check() { { train_verdict && prep_check; } || true; }
  flock -u 9
  QUEUE_KEEP=$DEPLOY_QUEUE_TICKET QUEUE_YIELD=yield queue_lock "$state" "$branch" || { land_timing 1; exit 1; }
  unset -f queue_wait_check
  train_verdict held
  say "$1"
  LAND_REBASED=1 LAND_RETRY_NOW=1 LAND_PRE=$pre LAND_RETRIED=$retried LAND_FLAKE_KEPT=$flake_kept LAND_ASIDE=$aside exec bash "$tools/land.sh" "${args[@]}"
}
# A CI red of flakes only on the one fresh run too (#1419 part 2, Taskmaster 2026-11-21, after Cara: "I thought they
# were supposed to keep their spot not?"): when every failed file passed alone again and no ship on the train changed
# one or what it imports, the ship keeps its place (retry_in_place) instead of going back to its minion, at most
# FLAKE_KEEP_MAX times a hand-off; past that it is refused as before, so a ship that really breaks something can't circle.
FLAKE_KEEP_MAX=2
# flake_only's answer, and nothing when leftover processes were in it too: those are no flake.
flake_free() {
  ! grep -qE 'The tests left [0-9]+ process\(es\) running' <<<"$failed" || return 1
  flake_only
}
# The run this landing's push started, when no poll has read its id yet (#1894: a stop in the seconds after the push left
# it running, and the next ship waited behind it). Only one of the pushed commit on this landing's own scratch branch.
ci_late() {
  local run
  while :; do
    run=$(hub gh api "repos/$ci_slug/actions/runs?head_sha=$ci_pushed&per_page=20" --jq "[.workflow_runs[] | select((.path | startswith(\"$CI_WORKFLOW\")) and .head_branch == \"$CI_REF\")][0] // empty | [.id, .status] | @tsv" 2>/dev/null) || run=''
    if [[ $run =~ ^([0-9]+)$'\t'([a-z_]+) ]] && [ "${BASH_REMATCH[1]}" -gt "${ci_stale:-0}" ]; then ci_id=${BASH_REMATCH[1]} ci_status=${BASH_REMATCH[2]}; return 0; fi
    [ -n "$ci_pushed_at" ] && [ $((SECONDS - ci_pushed_at)) -lt "$CI_LATE" ] || return 0
    sleep "$CI_LATE_POLL"
  done
}
# A finished red run's facts, from GitHub: a call it doesn't answer is asked three times, as no answer about a run says
# nothing about a ship (#1864). Fails when it never answers.
ci_fact() {
  local n out
  for n in 1 2 3; do
    out=$(hub gh "$@" 2>"$state/ci.err") && [ -n "$out" ] && { printf '%s\n' "$out"; return 0; }
    [ "$n" = 3 ] || sleep "$CI_POLL"
  done
  return 1
}

# The tests CI's suite skipped (#1914; Cara: "Never skip, loosen or delete a test to get green"): the count, then up to 5
# names, a line each; fails when it skipped none. On Nov 24 #1885 and #1873 went live on red runs with a test skipped, since
# tests.yml looked for one only on a green run. Only CI's own lines count ("<job>\t<step>\t<time> ℹ skipped 1": node's
# summary, the last one): a test's quoted output is indented, and perigee's suite always skips the Biome tests it has no
# Biome for, so its log (no prefix) never matches.
skipped_tests() {
  local pre=$'^[^\t]+\t[^\t]+\t[^ \t]+' n
  n=$(sed -nE "s/$pre ℹ skipped ([0-9]+)\$/\\1/p" <<<"$failed" | tail -n 1)
  [[ $n =~ ^[1-9][0-9]*$ ]] || return 1
  echo "$n"
  sed -nE "s/$pre +﹣ (.*) \([0-9.]+ms\).*/\\1/p" <<<"$failed" | sort -u | sed -n 1,5p
}
# skipped_tests' answer in words: "a test was skipped in CI (<run>): <names>".
skipped_said() {
  local n=${1%%$'\n'*} names=''
  [ "$n" = "$1" ] || names=": $(sed '1d' <<<"$1" | paste -sd';' - | sed 's/;/; /g')"
  if [ "$n" = 1 ]; then echo "a test was skipped in CI ($ci_url)$names"; else echo "$n tests were skipped in CI ($ci_url)$names"; fi
}
# Red on main too (#1430; Nov 21 00:00-01:30 PST main's own clock test refused #1356, #1378, #1414 and #1366): before a
# red train's suspects or bisect, or a red ship alone's refusal, each real failure (train_real) runs alone here on main's tip ($old), niced, one file at
# a time, without the lock's fds. One that fails there too is main's red, not the train's: every CI run on top of main
# stays red on it, so neither the suspects nor a bisect can judge, and a bisect would blame the front. So no ship
# is refused for it: the riders go back in line, and this one takes its one retry in place (main_red, below), so it can
# ride with a fix for main that waits in line; a ship alone is refused at once, saying main is red, not its change. A file main
# hasn't got, or a run stopped at LAND_PIN_LIMIT s or by a test's own timeout (load on perigee, not proof), is no main red:
# today's path. A red file this ship changed, or what it imports (the suspects' map), is still main's red, but the ship
# hears that its change doesn't make it pass, with no retry (main_red_mine). Fails when no real failure is red on main.
# Ship through (#1478, Cara, 2026-11-21, on #1430's card: "Ship through"): when every real failure is main's red, no ship
# on it changed one of them or what it imports, and every other failed file passed alone and is a known flake no ship
# changed (#1419; one never rerun, whose rerun was killed, or a new flake may be the train's own, as may the leak guard's
# red), the train is no worse than main, so the gate counts as green (rc=0)
# and it ships, riders and all, saying so loudly; main's fix ships separately. Its shipped line names main's red
# (through_by). The cost: a second break in the same test stays hidden until main's fix ships.
main_red='' main_red_other='' main_red_mine='' main_red_riders=0
declare -A through_by=() # #1478: <commit> -> main's red tests its green was let through on
train_main_red() {
  local f i wt r n=0 real=() reds=() other=() chg=() hits=() mine=() touched=()
  [ -z "$burn_red" ] || return 1 # a burn-in red is the ship's own new or changed test (#1443)
  mapfile -t real < <(train_real) || true
  for f in "${real[@]}"; do git cat-file -e "$old:$f" 2>/dev/null && n=1; done
  [ "$n" = 1 ] || return 1
  wt=$(mktemp -d "${TMPDIR:-/tmp}/land-main.XXXXXX") && git worktree add -q --detach "$wt" "$old" 2>/dev/null || { [ -z "${wt:-}" ] || rm -rf "${wt:?}"; return 1; }
  say "red on main?: running ${real[*]} alone on main's tip ($(git rev-parse --short "$old")) here before blaming a ship"
  : >"$state/main-red.log"
  n=0
  phase_ticker "running the red tests alone on main since $(date +%H:%M)"
  for f in "${real[@]}"; do
    r=0
    if [ $((n++)) -lt 6 ] && [ -e "$wt/$f" ]; then # shortcut: at most 6 files, so a badly red main costs minutes, not an hour
      "$tools/test-alone.sh" run "$wt" "$f" >"$state/main-red.one" 2>&1 9>&- 7>&- 6>&- </dev/null || r=$?
      cat "$state/main-red.one" >>"$state/main-red.log"
      [ "$r" != 1 ] || ! grep -q 'test timed out after' "$state/main-red.one" || r=timeout
    fi
    if [ "$r" = 1 ]; then reds+=("$f"); else other+=("$f"); fi
  done
  phase_ticker_end
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
  [ ${#reds[@]} -gt 0 ] || return 1
  # Failed files with no verdict (not rerun, or the rerun killed) may be the train's own: they count as its other reds.
  mapfile -t -O "${#other[@]}" other < <(train_labels | sed -n 's/^\(not rerun\|killed (exit [0-9]*) when rerun alone\) //p') || true
  train_chg
  for f in "${reds[@]}"; do
    mapfile -t hits < <(train_suspects_of "$f")
    [[ " ${hits[*]} " != *' 0 '* ]] || mine+=("$f")
    for i in "${hits[@]}"; do [ "$i" = 0 ] || [[ " ${touched[*]} " == *" ${train_br[$((i - 1))]} "* ]] || touched+=("${train_br[$((i - 1))]}"); done
  done
  main_red=$(sed 's/ /, /g' <<<"${reds[*]}") main_red_other=$(sed 's/ /, /g' <<<"${other[*]}") main_red_mine=$(sed 's/ /, /g' <<<"${mine[*]}") main_red_riders=${#train_n[@]}
  local who="this train's" more flakes
  [ ${#train_n[@]} -gt 0 ] || who="this ship's"
  # Its passed-alone files go by #1419's rule (Cara, "Known flakes only"): a known flake no ship changed is excused; a new
  # one may be the train's own, and the leak guard's red is never a flake. Either counts as another red: no ship through.
  flakes=$(train_labels | sed -n 's/^failed in the full run, passed alone //p' | paste -sd, - | sed 's/,/, /g') || true
  if [ -n "$main_red_other$main_red_mine" ] || [ ${#touched[@]} -gt 0 ]; then
    :
  elif grep -qE 'The tests left [0-9]+ process\(es\) running' <<<"$failed"; then
    main_red_other='the leak guard (the tests left processes running)'
  elif skipped_tests >/dev/null; then
    main_red_other='a skipped test'
  elif [ -n "$flakes" ] && ! known_flakes "$flakes"; then
    main_red_other="$flakes (passed alone, but no known flake)"
  fi
  if [ -z "$main_red_other" ] && [ -z "$main_red_mine" ] && [ ${#touched[@]} = 0 ]; then
    through_by[$tip]=$main_red rc=0
    [ -z "$flakes" ] || known_by[$tip]=$known_why
    say "=========================================================================="
    say "SHIPPING THROUGH MAIN'S RED: $main_red fails run alone on main's tip $(git rev-parse --short "$old") here too, and it is the only real failure of $who CI run ($ci_url): no ship on it changed $main_red or what it imports, and its other failed files, if any, are known flakes (#1419). So it is no worse than main and ships as green$([ ${#train_n[@]} = 0 ] || echo ", all $((${#train_n[@]} + 1)) ships"). Main still needs a fix for $main_red, which ships separately; until then a new break in $main_red goes unseen"
    say "=========================================================================="
    retro_log "shipped through main's red · $label · $main_red · $ci_url"
    return 0
  fi
  more="no ship on the train is to blame and none is refused: the ${#train_n[@]} riders go back in line"
  [ ${#train_n[@]} -gt 0 ] || more="$branch isn't to blame"
  if [ -n "$main_red_mine" ] && [ ${#train_n[@]} = 0 ]; then
    more="$branch changed $main_red_mine or what it imports and it still fails, so its change doesn't make it pass"
  elif [ -n "$main_red_mine" ]; then
    more+=", though the front, $branch, changed $main_red_mine or what it imports and it still fails, so it is refused"
  fi
  [ ${#touched[@]} = 0 ] || more+=" (${touched[*]} changed $main_red or what it imports, so the train doesn't ship through main's red)"
  say "red on main too: not $who: $main_red fails run alone on main's tip $(git rev-parse --short "$old") here, so $more${main_red_other:+ (its other failures, $main_red_other, cannot be pinned on a ship while every run is red on the main ones, so it does not ship through)}. Main needs a fix for $main_red"
  retro_log "red on main too: not $who · $label · $main_red · $ci_url${main_red_other:+ · also red: $main_red_other}"
  train_drop
  return 0
}

# The ship train (#1166), the front's side: up to LAND_TRAIN_MAX plain lands waiting behind this one, in line order,
# each replayed onto the one before it in a scratch worktree, so CI runs once on the top. Its riders: own=this ship's
# commit, then train_tip, train_br, train_n (its ticket), train_was (its tip as the train took it). Not for a ship
# with no CI to answer (one ship's fallback run is all perigee should take on), nor while deploys are refusing or
# rolled back. A waiter is passed over, and keeps its place, when it changes the pipeline (tools/pipeline-files.txt:
# those land alone), has merge commits, sits on a commit that came off main, conflicts with the train, or fails the
# undo guard against it.
own=$tip train_tip=() train_br=() train_n=() train_was=() greens=' '
declare -A known_by=() # #1419: <commit> -> the known flakes its green was let through on
# <a red run's log>: what a refused rider hears of it, its last 40 lines, after the test it skipped, if any: those lines
# don't say so, and the wake's kind is read from it (#1914).
train_tail() {
  local failed=$1 f
  ! f=$(skipped_tests) || echo "land: $(skipped_said "$f")"
  tail -n 40 <<<"$failed"
}
# Early next train (#1366; Cara, 2026-11-20, picked "Also test next train early"; #1568: Cara, 2026-11-22, picked
# "Low-priority run on a ship runner"). While this train's CI runs (top_gate), early_next stacks the ship next in line,
# and the train it would take, on this train's top in a scratch worktree, and once this train's run has a runner and
# another ship runner is free, pushes it to early/<its branch>: tests.yml runs it niced beside this one. A red here drops
# it, and the train built again stacks a new one; this train's deploy keeps one stacked on its top, or stacks one then.
# Each stack goes to <state>/stacked ("<onto> <commit> <result>"), which that ship's own rebase and train_build take
# instead of rebasing again (a re-run rebase is a new commit), so a train that comes out the same is the same commit,
# and ci_gate takes the early run as its own. <state>/early: "<top> <its branch> <when pushed> <this branch> <onto>
# <its riders' tickets, comma-separated, or ->"; that landing builds its train of those riders only (early_look), so
# ships that joined the line since don't change it, and at its gate counts the run or cancels it (early_gate). Off:
# LAND_EARLY=0, or <state>/early-off. With the hold on (no <state>/hold-off, #1902, #1906) it goes only at this train's deploy, on an idle desktop.
early_ahead='' early_top='' early_pid='' train_only='' train_left='' # train_left: train_only is what is left of a red train (#1918)
# <worktree> <onto> <branch> <base> <tip>: what a ship at the front gets after its rebase (adr_commit, the prompt baseline,
# the commit titles), for one rebased onto <onto> in a scratch worktree (#1864, LA1: two ADRs 0027 shipped in one train).
# Fails with the reason in skip, the worktree put back clean.
train_steps() {
  local n=${3#ticket/} renamed
  if ! (
    cd "$1" || exit 1
    git diff --quiet "$2" HEAD -- docs/adr || adr_commit "$2" "$3" "the ship train" || exit 1
    if [ -f test/prompt-budget.test.ts ] && ! git diff --quiet "$4" "$5" -- test/prompt-baseline.json; then
      n=${n%%-*}
      PROMPT_BASELINE=write "$tools/citadel-node" --no-warnings --test test/prompt-budget.test.ts >/dev/null 2>&1 </dev/null || true
      git add test/prompt-baseline.json && { git diff --cached --quiet || git commit -q -m "${n:+#$n: }test/prompt-baseline.json measured again at ship time"; } || exit 1
    fi
  ); then
    skip="renumbering its ADRs or measuring its prompt baseline on the train failed"
  elif [ -x "$tools/commit-titles.sh" ] && ! (cd "$1" && "$tools/commit-titles.sh" "$2") >/dev/null 2>&1; then
    skip="a commit of it lost its #N: title"
  else return 0; fi
  git -C "$1" reset -q --hard >/dev/null 2>&1 || true
  git -C "$1" clean -fdq >/dev/null 2>&1 || true
  return 1
}
train_guards_run() {
  local t0 lo hi mid i rc out files keep was t v k room ahead
  while [ ${#train_n[@]} -gt 0 ]; do
    t0=$SECONDS rc=0
    guard_at "$tip" || rc=$?
    [ "$rc" = 1 ] || { [ "$rc" != 0 ] || say "guard tests passed on the ship train's top $short in $((SECONDS - t0)) s"; return 0; }
    out=$guard_out lo=0 hi=${#train_n[@]}
    while [ $((hi - lo)) -gt 1 ]; do
      mid=$(((lo + hi) / 2)) rc=0
      guard_at "$(train_at "$mid")" || rc=$?
      if [ "$rc" = 1 ]; then hi=$mid out=$guard_out; elif [ "$rc" = 0 ]; then lo=$mid; else break; fi
    done
    [ "$rc" -lt 2 ] || { say "the guard tests failed on the ship train's top ($short) but couldn't decide on a step before it (exit $guard_rc), so they name no ship: CI runs them"; return 0; }
    if [ "$hi" = 1 ] && [ "$front_guards" = 2 ]; then # this one never passed them (#1864): the first rider isn't the cause unless it does now
      rc=0
      guard_at "$own" || rc=$?
      [ "$rc" != 1 ] || { say "the guard tests failed on the ship train's top ($short), but $branch's own run of them didn't decide and fails now too, so they name no ship: CI runs them"; return 0; }
      [ "$rc" = 0 ] || { say "the guard tests failed on the ship train's top ($short), but $branch's own run of them didn't decide, then or now (exit $guard_rc), so they name no ship: CI runs them"; return 0; }
      front_guards=0
    fi
    i=$((hi - 1)) guard_out=$out files=$(guard_files) room=''
    # A size red (#2139): how far over, and the ships on the train before it that used the room, each by its own step.
    if [[ ,$files, == *,test/size-budget.test.ts,* ]] && [ -f "$tools/size-room.ts" ]; then
      ahead=(--ahead "$branch=$(git merge-base main "$own")..$own")
      for ((k = 0; k < i; k++)); do ahead+=(--ahead "${train_br[$k]}=$(train_at "$k")..$(train_at $((k + 1)))"); done
      ahead+=(--self "${train_br[$i]}=$(train_at "$i")..$(train_at "$hi")")
      room=$("$tools/citadel-node" --no-warnings "$tools/size-room.ts" "${ahead[@]}" 2>/dev/null | grep ' over its limit ') || : # exit 1: over
    fi
    say "the guard tests failed on the ship train's top ($short) in ${files:-the guard tests}, and on the train first with ${train_br[$i]} on it, so it is refused before any CI run and the train is built again without it"
    [ -z "$room" ] || say "$room"
    retro_log "guard · ${train_br[$i]} · on $label's train · $files · $((SECONDS - t0))s"
    train_say "$i" "refused $branch guard-tests guard ${files:-guards}" "$(grep -v '^full output: ' <<<"$out" | tail -n 40)" ${room:+"$room"}
    train_refused+="${train_n[$i]} " train_refused_tips+=" ${train_was[$i]}"
    keep=("${train_n[@]:0:$i}" "${train_n[@]:$hi}") was=("${train_n[@]}")
    train_tip=() train_br=() train_n=() train_was=()
    tip=$own short=$(git rev-parse --short "$own")
    [ -n "$train_left" ] || train_only='' # its early run had the refused rider, so it won't count: the next in line may ride (#1864)
    train_build "${keep[@]}"
    for t in "${was[@]}"; do # a rider the train no longer takes: back in line
      [[ " ${train_n[*]} " != *" $t "* ]] && read -r v _ 2>/dev/null <"$train_dir/$t" && [ "$v" = riding ] && rm -f "$train_dir/$t"
    done
  done
  return 0 # the loop's last test can read a refused rider's verdict, and land.sh runs under set -e
}

# Suspects first (#1346, Cara 2026-11-20: "we pull out the minions that touched the failing tests as they are vastly
# more likely to be the culprit"): a red train's real failures (run-tests.sh's labels: not the flakes) are pinned on
# ships. Each failing file first runs alone here on the train's prefixes (train_pin, #1403, Cara 2026-11-20, "Confirm
# suspects first"): the ship that turns it red is the cause, seconds a step rather than a CI run a step. A file perigee
# can't pin that way is guessed at from the files instead: the ships whose change touched it; failing that, a file it
# imports by a relative path or names by its path; failing that, a file those import. What is done with the ships
# named is train_suspects' header (#1918). 0: done (rc as gate's, 1 only for this one alone or confirmed itself),
# 1: the bisect looks, on the train as it now is (its top red, its log in $failed).
suspect_tests='' suspect_new='' train_refused=' ' train_refused_tips='' train_held_tips=''
held_n=() held_br=() held_was=() held_files=() held_run=() held_kind=() held_how=() held_log=()
# The real failures in $failed, one test file a line: those that failed again alone, hung, or whose rerun stopped at
# CI's deadline. A file not rerun, or whose rerun was killed from outside (#1393), may be load or real, so it names no suspect: if it is real, the train without the
# pulled ships is red on it, and the next round sees it. Fails when there are none, or the log doesn't label every failed file.
train_real() {
  local out
  [ -z "$burn_red" ] || { burn_lines | sed 's/: failed in .*//' | grep .; return; } # each burn-in red file is a real failure (#1443)
  out=$(train_labels) || return 1
  out=$(sed -n 's/^\(failed again alone\|hung when rerun alone\|rerun alone stopped\) //p' <<<"$out")
  [ -n "$out" ] && echo "$out"
}
# Each failed file in $failed with run-tests.sh's label for its rerun alone, "<label> <file>" a line. Fails when the log
# doesn't label every failed file.
train_labels() {
  local at n out
  at=$(grep -n 'run-tests: [0-9][0-9]* test file(s) failed; rerunning each alone' <<<"$failed" | tail -n 1 | cut -d: -f1)
  [[ $at =~ ^[0-9]+$ ]] || return 1
  n=$(sed -n "${at}s/.*run-tests: \\([0-9][0-9]*\\) test file(s) failed.*/\\1/p" <<<"$failed")
  out=$(tail -n "+$at" <<<"$failed" | sed -n 's/.*run-tests: \([^ ]*\): \(failed in the full run, passed alone\|failed again alone\|hung when rerun alone\|rerun alone stopped\|not rerun\|killed (exit [0-9]*) when rerun alone\).*/\2 \1/p' | sort -u -k2)
  [[ $n =~ ^[1-9][0-9]*$ ]] && [ -n "$out" ] && [ "$(wc -l <<<"$out")" = "$n" ] || return 1
  echo "$out"
}
# A burn-in red's failing cases that one train member added (#2019): "<member> <file>" a line (0: this ship, 1 on: its
# riders). A burn-in race passes when run alone (train_solo), but a case main and the ships before one don't have can only
# be that ship's, so it needs no proof. The log names each as "test at <file>:<line>:<col>", then "✖ <case> (<ms>)". A
# case already on main, one a ship only edited, or one whose file a later ship changes too, is left to the guess.
# [<riders>]: only the train up to that rider, as a bisect step tested it (all by default).
burn_new() {
  local f name i j red last=${1:-${#train_n[@]}}
  [ -n "$burn_red" ] || return 0
  red=$(burn_lines | sed 's/: failed in .*//')
  while IFS=$'\t' read -r f name; do
    grep -qxF -- "$f" <<<"$red" && ! has_case "$old" "$f" "$name" || continue
    for ((i = 0; i <= last; i++)); do
      has_case "$(train_at "$i")" "$f" "$name" || continue
      for ((j = i + 1; j <= last; j++)); do
        git diff --quiet "$(train_at $((j - 1)))" "$(train_at "$j")" -- "$f" || continue 3 # a later ship edits it: a guess
      done
      echo "$i $f"
      break
    done
  done < <(awk 'match($0, /test at [^ ]+:[0-9]+:[0-9]+/) { f = substr($0, RSTART + 8, RLENGTH - 8); sub(/:[0-9]+:[0-9]+$/, "", f); next }
    f != "" { if (i = index($0, "✖ ")) { n = substr($0, i + length("✖ ")); sub(/ \([0-9.]+ms\).*$/, "", n); print f "\t" n } f = "" }' <<<"$failed" | sort -u) | sort -u
}
# <commit> <file> <case>: the file there has the case, named in quotes (a name built at run time is never found, so guessed).
# git grep, with no pipe: under pipefail a `git show | grep -q` fails on a file over 64 KB that has the case.
has_case() { git grep -qF -e "'$3'" -e "\"$3\"" -e "\`$3\`" "$1" -- "$2" 2>/dev/null; }
# <file>: the repo paths it imports by a relative path, as the train's top has it.
train_imports() {
  local p
  git show "$tip:$1" 2>/dev/null | grep -oE "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]\.\.?/[^'\"]+['\"]" |
    sed -E "s/.*['\"](\.[^'\"]+)['\"]$/\1/" | while read -r p; do realpath -ms --relative-to="$PWD" "$PWD/$(dirname "$1")/$p"; done | sort -u
}
# <test file>: the train members (0: this one, 1 on: its riders) its failure is pinned on, nearest first. Reads chg.
train_suspects_of() {
  local live
  # set -e as before #1484 ($( ) drops it), so a step that fails still ends the guess with no suspects.
  live=$(set -e; train_guess "$1")
  [ -z "$live" ] || echo "$live"
}
# <test file>: train_suspects_of's answer.
train_guess() {
  local f=$1 text reach lvl m c hits named
  text=$(git show "$tip:$f" 2>/dev/null) || text=''
  # A guard's failure message names the file behind it ("loop-lag.test.ts:22 … 5 sleep hits", #1451): the ship that
  # changed that file is the suspect, before any guess from what the guard reads or imports.
  named=$({ grep -oE '[A-Za-z0-9_./-]+\.test\.ts:[0-9]+' <<<"$failed" || true; } | sed 's/:[0-9]*$//' | sort -u | while read -r c; do
    [[ $c == */* ]] || c=test/$c
    [ "$c" = "$f" ] || echo "$c"
  done)
  # A judge-replay red (test/judges.test.ts, #1503) names the pinned code that changed: "(pinned code: src/a.ts src/b.ts)".
  # The ship that changed that code is the suspect, not the one that only edited the test or its record (#1538).
  [ "$f" != test/judges.test.ts ] || named+=$'\n'$({ grep -oE 'pinned code: [^)]*' <<<"$failed" || true; } | sed 's/^pinned code: //' | tr ' ' '\n' | grep . | sort -u || true)
  named=$(grep . <<<"$named" || true)
  if [ -n "$named" ]; then
    hits=$(for ((m = 0; m < ${#chg[@]}; m++)); do
      while read -r c; do
        [ -n "$c" ] || continue
        if grep -qxF -- "$c" <<<"$named"; then echo "$m"; break; fi
      done <<<"${chg[$m]}"
    done)
    [ -z "$hits" ] || { echo "$hits"; return 0; }
  fi
  reach=$f
  for lvl in 0 1 2; do
    [ "$lvl" = 0 ] || reach=$(while read -r c; do [ -z "$c" ] || train_imports "$c"; done <<<"$reach" | sort -u) ||
      return 0 # the last file imports nothing by a relative path: no suspects (set -e stopped here before #1484)
    hits=$(for ((m = 0; m < ${#chg[@]}; m++)); do
      while read -r c; do
        [ -n "$c" ] || continue
        if grep -qxF -- "$c" <<<"$reach" || { [ "$lvl" = 1 ] && grep -qF -- "$c" <<<"$text"; }; then echo "$m"; break; fi
      done <<<"${chg[$m]}"
    done)
    [ -z "$hits" ] || { echo "$hits"; return 0; }
  done
}
# Sets chg (the caller's local): each train member's own changed files, 0 being this ship's.
train_chg() {
  local m
  chg=()
  for ((m = 0; m <= ${#train_n[@]}; m++)); do
    if [ "$m" = 0 ]; then chg[0]=$(git diff --no-renames --name-only "$old" "$own"); else chg[m]=$(git diff --no-renames --name-only "$(train_at $((m - 1)))" "$(train_at "$m")"); fi
  done
}
# <member>: its #N, or its branch when that names no ticket.
train_label() {
  local t
  if [ "$1" = 0 ]; then t=$branch; else t=${train_br[$(($1 - 1))]}; fi
  [[ ! $t =~ ^ticket/([0-9]+)- ]] || t="#${BASH_REMATCH[1]}"
  echo "$t"
}
# Known flakes (#1419, Cara 2026-11-20, "Known flakes only": "Skip the extra run when each failed test has already flaked on
# other ships in the last 2 weeks, or a minion is fixing it"; ADR 0006's amendment). <files, comma-separated>, each of
# which passed alone: whether every one is a known flake (tools/known-flakes.ts: the retro log's sightings on other
# branches, an open fix minion, and not a broken test) that no ship on the train changed, nor what it imports (the suspects' map). Says why
# not; on yes, sets $known_why ("<file> (<why>), ..."). Anything it can't tell keeps today's fresh run.
known_flakes() {
  local files=() f m out hits=() chg=() ok=1 who
  known_why=''
  [ -f "$tools/known-flakes.ts" ] || return 1
  # The leak guard fails a run on its own, beside the files (test/leak-guard.ts): that is no flake.
  ! grep -qE 'The tests left [0-9]+ process\(es\) running' <<<"$failed" || { say "the run also left processes running (the leak guard), so no flake is excused"; return 1; }
  IFS=, read -ra files <<<"${1//, /,}"
  out=$(LAND_FLAKE_DB=${DEPLOY_DB:-$HOME/.local/share/claude-coordinator/coordinator.db} \
    "$tools/citadel-node" --no-warnings "$tools/known-flakes.ts" "$branch ${train_br[*]}" "${files[@]}" 2>/dev/null) || ok=''
  [ -n "$out" ] || { say "couldn't tell whether $1 are known flakes (tools/known-flakes.ts gave no answer)"; return 1; }
  # A broken test (#1487: red in a big share of the last hours' runs) is said as known-flakes.ts words it, and logged, so the
  # server moves its fix minion to the front of the line (src/flake-fixes.ts) and Releases calls it one (src/land-news.ts).
  [ -n "$ok" ] || { while read -r f; do
    if [[ $f == 'broken test, not a flake: '* ]]; then
      say "$f"
      m=${f#broken test, not a flake: }
      retro_log "broken test · ${m%% *} · ${m#* } · $branch"
    elif [[ $f == *'(not seen on another branch'* ]]; then say "$f is no known flake"; fi
  done <<<"$out"; return 1; }
  train_chg
  for f in "${files[@]}"; do
    mapfile -t hits < <(train_suspects_of "$f")
    [ ${#hits[@]} -gt 0 ] || continue
    who=''
    for m in "${hits[@]}"; do who+="${who:+ and }$(train_label "$m")"; done
    say "$f is a known flake, but $who changed it or what it imports, so it isn't excused"
    ok=''
  done
  [ -n "$ok" ] || return 1
  known_why=$(sed ':a;N;$!ba;s/\n/, /g' <<<"$out")
}
# <scratch worktree> <commit> <test file>: 0 when the file passes run alone at that commit here, or the commit hasn't
# got it; 1 when it fails (a test past its own 60 s timeout too). Niced, one file, without the lock's fds; a run stopped
# at LAND_PIN_LIMIT s, a checkout that fails or a missing package is no answer (any other code): test-alone.sh.
train_alone() {
  git -C "$1" checkout -q --detach "$2" 2>/dev/null || return 2
  "$tools/test-alone.sh" run "$1" "$3" >>"$state/train-pin.log" 2>&1 9>&- 7>&- 6>&- </dev/null
}
# <test file> <scratch worktree>: the train member (0: this one, 1 on: its riders) that turns it red run alone here: it
# fails at the train's top and passes on main, so the train's prefixes are bisected with that one file, and the answer
# is run once more on each side (red with it, green just before it) so one load failure can't pin an innocent ship.
# Nothing when it passes at the top here (a test only CI's machine fails), fails on main too, a step gives no answer, or
# the recheck disagrees: the files decide then. The caller adds and removes the worktree, one at a time.
train_pin() {
  local f=$1 wt=$2 lo=-1 hi=${#train_n[@]} mid r=0 before
  [ -n "$wt" ] || return 0
  train_alone "$wt" "$tip" "$f" || r=$?
  if [ "$r" = 1 ]; then
    r=0
    train_alone "$wt" "$old" "$f" || r=$?
    while [ "$r" = 0 ] && [ $((hi - lo)) -gt 1 ]; do
      mid=$(((lo + hi) / 2))
      train_alone "$wt" "$(train_at "$mid")" "$f" || r=$?
      if [ "$r" = 0 ]; then lo=$mid; elif [ "$r" = 1 ]; then hi=$mid r=0; fi
    done
    if [ "$r" = 0 ]; then
      if [ "$hi" = 0 ]; then before=$old; else before=$(train_at $((hi - 1))); fi
      train_alone "$wt" "$(train_at "$hi")" "$f" || r=$?
      if [ "$r" = 1 ]; then r=0 && train_alone "$wt" "$before" "$f" && echo "$hi"; fi
    fi
  fi
}
# Every file the full run failed in $failed, whatever its rerun showed (a held ship's test not rerun is no pass).
train_failing() {
  local at
  [ -z "$burn_red" ] || { burn_lines | sed 's/: failed in .*//' | sort -u; return; }
  at=$(grep -n 'run-tests: [0-9][0-9]* test file(s) failed; rerunning each alone' <<<"$failed" | tail -n 1 | cut -d: -f1)
  [[ $at =~ ^[0-9]+$ ]] || return 0
  tail -n "+$at" <<<"$failed" | sed -n 's/.*run-tests: \([^ ]*\): \(failed in the full run, passed alone\|failed again alone\|hung when rerun alone\|rerun alone stopped\|not rerun\|killed (exit [0-9]*) when rerun alone\).*/\1/p' | sort -u
}
# <ticket> <branch> <tip> <files> <run> <kind> <how> <log>: held off the train until the train without it has a verdict.
train_hold() {
  held_n+=("$1") held_br+=("$2") held_was+=("$3") held_files+=("$4") held_run+=("$5") held_kind+=("$6") held_how+=("$7") held_log+=("$8")
}
# The train's last verdict: what becomes of the ships still held off it. One that ships past main's red or a known flake
# was red on those files all the same.
train_end() {
  local f=''
  [ ${#held_n[@]} -gt 0 ] || return 0
  if [ "$rc" = 1 ] || [ -n "${through_by[$tip]:-}${known_by[$tip]:-}" ]; then
    f=$(train_failing)
    # A log that doesn't name every failed file proves no file passed: the held go back in line.
    [ -n "$burn_red" ] || train_labels >/dev/null || { train_release; return 0; }
  fi
  # shellcheck disable=SC2086 # file names
  if [ "$rc" = 0 ] || { [ "$rc" = 1 ] && [ -n "$f" ]; }; then train_settle $f; fi
  train_release
}
# <most> <what>: waits until at most that many of train_each's runs are going. The phase moves at each end and every
# 5 min, since the line behind gives up on one unchanged for DEPLOY_QUEUE_STALL (15 min).
train_wait() {
  local n t
  while n=$(jobs -rp | wc -l) && [ "$n" -gt "$1" ]; do
    queue_phase "running the red tests alone here: $2, $n left at $(date +%H:%M)"
    t=$SECONDS
    while [ "$(jobs -rp | wc -l)" = "$n" ] && [ $((SECONDS - t)) -lt 300 ]; do read -rt .3 <> <(:) || true; done
  done
}
# <function> <what it looks for>: that function on each file of $real with a scratch worktree, LAND_PIN_JOBS at once; pins[<file>] = its answer.
train_each() {
  local k pd wts=()
  : >"$state/train-pin.log"
  pd=$(mktemp -d "${TMPDIR:-/tmp}/land-pins.XXXXXX")
  # The worktrees are added here, one at a time, not in the jobs: git's admin files don't take parallel adds.
  for ((k = 0; k < ${#real[@]}; k++)); do
    wts[$k]=$(mktemp -d "${TMPDIR:-/tmp}/land-pin.XXXXXX") && git worktree add -q --detach "${wts[$k]}" "$tip" 2>/dev/null || { rmdir "${wts[$k]}" 2>/dev/null; wts[$k]=''; }
  done
  for ((k = 0; k < ${#real[@]}; k++)); do
    train_wait $((${LAND_PIN_JOBS:-3} - 1)) "$2"
    (set +e; "$1" "${real[$k]}" "${wts[$k]}") >"$pd/$k" 2>/dev/null &
  done
  train_wait 0 "$2"
  for ((k = 0; k < ${#real[@]}; k++)); do
    pins[${real[$k]}]=$(cat "$pd/$k" 2>/dev/null)
    [ -z "${wts[$k]}" ] || git worktree remove --force "${wts[$k]}" >/dev/null 2>&1 || true
  done
  rm -rf "${pd:?}"
}
# <test file> <scratch worktree>: its guessed members (guess) run alone with it on main's tip here: "<m>" fails it (twice,
# so one load failure blames nobody), "-<m>" doesn't; "main" when it fails on main's tip itself. No word of one with no
# answer: a run or a checkout that gave none, or a ship that doesn't rebase onto main by itself or sits on another ship
# of the train, since what fails there may be the other's.
train_solo() {
  local f=$1 wt=$2 m i c b x r=0
  [ -n "$wt" ] && [ -n "${guess[$f]:-}" ] || return 0
  train_alone "$wt" "$old" "$f" || r=$?
  [ "$r" != 1 ] || echo main
  [ "$r" = 0 ] || return 0
  for m in ${guess[$f]}; do
    c=$own
    if [ "$m" != 0 ]; then
      c=${train_was[$((m - 1))]}
      for x in "$pre" "$own" "${train_was[@]}"; do
        [ "$x" = "$c" ] || ! sits_on "$c" "$x" || continue 2
      done
      b=$(git merge-base "$old" "$c") && git -C "$wt" checkout -q --detach "$c" 2>/dev/null || continue
      git -C "$wt" "${rr[@]}" rebase -q --onto "$old" "$b" >/dev/null 2>&1 || { git -C "$wt" rebase --abort >/dev/null 2>&1; continue; }
      c=$(git -C "$wt" rev-parse HEAD)
    fi
    for i in 1 2; do
      r=0
      train_alone "$wt" "$c" "$f" || r=$?
      [ "$r" = 1 ] || break
    done
    if [ "$r" = 1 ]; then echo "$m"; elif [ "$r" = 0 ]; then echo "-$m"; fi
  done
}
# <commit> <ship's tip>: whether the commit is built on that ship, which main hasn't got.
sits_on() { git merge-base --is-ancestor "$2" "$1" 2>/dev/null && ! git merge-base --is-ancestor "$2" "$old" 2>/dev/null; }
# A red train (#1918; Josh, 2026-11-24: "we bisect out the likely failures and run 1, 2, 4, 6, 7 if they are green they
# get shipped and we send 5 and 3 back to debug their failures. If they are still red and we guess 1 is the issue based on
# the failure, then we take it out and run 2, 4, 6, 7 then we finally get a green and ship those 4"; he approved the plan
# at 11:24 PM PST). Every likely ship of the red's failing tests is pulled at once, this one at the front included: the
# one a test's runs on the train's prefixes here name (train_pin) and each one the files name (train_suspects_of). Each of
# those is run alone on main first (train_solo): red alone, it goes back to its minion with that; another ship pulled for
# the same test red alone, it waits for the next train (or stays on, when the prefixes name the one red alone); no ship pulled for it red alone, it is held, and all of them go back once
# the train without them passes the test. The train is built again from what is left, with nothing from the line in the
# empty seats (train_only); one that can't be rebuilt without the pulled ones goes back in line, blamed for nothing.
# Still red, on the same test or not, the new failure names the next pull. A file no ship can be named for rides on
# while others are pulled. With nobody named, or every ship on the train and none of them red alone: train_bisect.
# All of a round's files are judged before anyone is pulled (#1564, Cara 2026-11-21, C "Go").
train_suspects() {
  local f i m t v n x line held_line sure_line rest kind real=() hits=() keep=() was=() chg=() open=()
  local -A sus=() sure=() next=() pins=() pin=() guess=() how=() added=() new=()
  local new_line
  while :; do
    mapfile -t real < <(train_real) || true
    if [ ${#real[@]} = 0 ]; then
      train_release
      [ -z "$reran" ] || flake_keep # #1864 (LB4): red twice of flakes only, which no ship on it touched: nobody's fault
      say "suspects: CI's log doesn't say which tests really failed, so the bisect looks for the ship"
      return 1
    fi
    # shellcheck disable=SC2046 # file names
    train_settle $(train_failing)
    sus=() sure=() next=() pins=() pin=() guess=() how=() open=() kind=burn
    train_chg
    added=() new=()
    while read -r m f; do
      new[$f]=1 added[$m]=1 sure[$m]+="${sure[$m]:+, }$f" sus[$m]+="${sus[$m]:+, }$f"
    done < <(burn_new)
    if [ -z "$burn_red" ]; then # a burn-in red names the file a ship added or changed itself (#1443), so no bisect of it here
      kind=likely
      say "suspects: running ${real[*]} alone on the train's commits here, ${LAND_PIN_JOBS:-3} at a time, to find the ship that turns each red"
      train_each train_pin 'which ship turns each red'
    fi
    line=''
    for f in "${real[@]}"; do
      [ -z "${new[$f]:-}" ] || continue # the ship that adds the failing case is known
      m=${pins[$f]:-}
      pin[$f]=$m
      mapfile -t hits < <({ [ -z "$m" ] || echo "$m"; train_suspects_of "$f"; } | awk '!seen[$0]++')
      guess[$f]=${hits[*]}
      if [ ${#hits[@]} = 0 ]; then open+=("$f"); else line+="${line:+; }$f: $(for m in "${hits[@]}"; do train_label "$m"; done | paste -sd, | sed 's/,/, /g')"; fi
    done
    if [ -n "$line" ]; then
      say "suspects: running the tests alone on main's tip ($(git rev-parse --short "$old")) here with each likely ship ($line)"
      train_each train_solo 'each likely ship by itself on main'
      for f in "${real[@]}"; do
        [ -n "${guess[$f]:-}" ] || continue
        hits=(${pins[$f]})
        if [ "${hits[0]:-}" = main ]; then open+=("$f"); continue; fi
        for m in ${guess[$f]}; do
          if [[ " ${hits[*]} " == *" $m "* ]]; then
            sure[$m]+="${sure[$m]:+, }$f" sus[$m]+="${sus[$m]:+, }$f"
            continue
          fi
          x=unrun
          [[ " ${hits[*]} " != *" -$m "* ]] || x=alone
          [ "$m" != "${pin[$f]}" ] || x=joined
          if [[ ! " ${hits[*]}" =~ \ [0-9] ]]; then sus[$m]+="${sus[$m]:+, }$f"
          elif [[ " ${hits[*]} " != *" ${pin[$f]:-none} "* ]]; then next[$m]+="${next[$m]:+, }$f"
          else continue; fi
          # The least said of it by any of its tests: not run by itself, then red on the train's prefixes.
          { [ "${how[$m]:-}" != unrun ] && [ "$x" != alone ]; } || [ -z "${how[$m]:-}" ] && how[$m]=$x
        done
      done
    fi
    for m in "${!sure[@]}"; do sus[$m]=${sure[$m]}; done # sent back for what it failed alone, not for the others' guesses
    for m in "${!sus[@]}"; do unset "next[$m]"; done
    n=$((${#sus[@]} + ${#next[@]}))
    # Nothing left to test with every ship pulled, so only the proven leave; and this one steps aside three times at most.
    for m in "${!sus[@]}" "${!next[@]}"; do
      [ "$n" -gt ${#train_n[@]} ] || { [ "$m" = 0 ] && [ "$aside" -ge 3 ]; } || continue
      [ -z "${sure[$m]:-}" ] || continue
      for f in ${sus[$m]:-}; do f=${f%,}; [[ " ${open[*]} " == *" $f "* ]] || open+=("$f"); done
      unset "sus[$m]" "next[$m]"
    done
    if [ ${#sus[@]} = 0 ]; then
      train_release
      if [ "$n" -gt 0 ] && [ "$n" -le ${#train_n[@]} ]; then say "suspects: only $branch is likely, and it has stepped aside $aside times already, so the bisect looks for the ship"
      elif [ "$n" = 0 ]; then say "suspects: no ship on the train touched ${open[0]} or what it imports, so the bisect looks for the ship"
      else say "suspects: the files name every ship there is to pull for $(sed 's/ /, /g' <<<"${open[*]}") and none of them failed alone, so the bisect looks for the ship"; fi
      return 1
    fi
    [ ${#open[@]} = 0 ] || say "suspects: no ship could be pinned on $(sed 's/ /, /g' <<<"${open[*]}"), so they stay on the train while the likely causes leave"
    line='' sure_line='' new_line='' held_line='' rest=''
    for m in $(printf '%s\n' "${!sus[@]}" "${!next[@]}" | sort -n); do
      t=$(train_label "$m")
      if [ -n "${added[$m]:-}" ]; then
        line+="${line:+, }$t (${sus[$m]}; adds the failing case: sent back)" new_line+="${new_line:+, }$t"
      elif [ -n "${sure[$m]:-}" ]; then
        line+="${line:+, }$t (${sus[$m]}; failed alone: sent back)" sure_line+="${sure_line:+, }$t"
      elif [ -n "${sus[$m]:-}" ]; then
        line+="${line:+, }$t (${sus[$m]}; a guess: waits for the verdict)" held_line+="${held_line:+, }$t"
      elif [ "${how[$m]}" = unrun ]; then line+="${line:+, }$t (${next[$m]}; not run alone: waits for the next train)" rest+="${rest:+, }$t"
      else line+="${line:+, }$t (${next[$m]}; passed alone: waits for the next train)" rest+="${rest:+, }$t"; fi
    done
    say "suspects: $line: CI is red on the ship train ($ci_url) in those tests, so they leave the train at once.${new_line:+ $new_line adds the test case that failed, so that is the cause: back to its minion with the failure.}${sure_line:+ Run alone on main here, the tests failed with $sure_line and passed without, so that is the cause: back to its minion with the failure.}${held_line:+ $held_line: not red alone here, so the files are only a guess: they go back in line once the train has a verdict without them, to ship alone unless it is red on those tests again.}${rest:+ $rest: not red alone here, and another ship was: the next train.} The train runs again with the ships that are left, and none from the line takes their places"
    retro_log "ship train suspects · $label · $(sed 's/; [^)]*)/)/g' <<<"$line")${new_line:+ · adds the failing case: $new_line}${sure_line:+ · failed alone here: $sure_line}${held_line:+ · pulled on a guess, not red alone here: $held_line}${rest:+ · not red alone here while another ship was: $rest} · $ci_url"
    [ -z "$sure_line$new_line" ] || split_over
    keep=()
    for ((i = 0; i < ${#train_n[@]}; i++)); do
      m=$((i + 1)) v=${sus[$((i + 1))]:-}
      if [ -n "${next[$m]:-}" ]; then
        train_held_tips+=" ${train_was[$i]}"
      elif [ -z "$v" ]; then
        keep+=("$i")
      elif [ -n "${sure[$m]:-}" ]; then
        x=pinned
        [ -z "${added[$m]:-}" ] || x=new
        train_say "$i" "refused $branch $ci_url $kind ${v//, /,} $x" "$(train_tail "$failed")"
        train_refused+="${train_n[$i]} " train_refused_tips+=" ${train_was[$i]}"
      else
        train_say "$i" "riding $branch pulled ${v//, /,}"
        train_hold "${train_n[$i]}" "${train_br[$i]}" "${train_was[$i]}" "${v//, /,}" "$ci_url" "$kind" "${how[$m]}" "$(train_tail "$failed")"
        train_held_tips+=" ${train_was[$i]}"
      fi
    done
    if [ -n "${sus[0]:-}${next[0]:-}" ]; then # this one: the next front among the ships that are left runs them (pull_look)
      v=${sus[0]:-}
      [ -z "$v" ] || [ -n "${sure[0]:-}" ] || train_hold "${DEPLOY_QUEUE_TICKET##*/}" "$branch" "$own" "${v//, /,}" "$ci_url" "$kind" "${how[0]}" "$(train_tail "$failed")"
      was=("${keep[@]}") keep=()
      for i in "${was[@]}"; do # the next front would bring the pulled one's commits along with a ship built on it
        for x in "$pre" "$own" $train_refused_tips $train_held_tips; do
          ! sits_on "${train_was[$i]}" "$x" || { say "${train_br[$i]} goes back in line: it sits on a ship this train pulled"; continue 2; }
        done
        keep+=("$i")
      done
      pull_say "${keep[@]}"
      if [ -n "${sure[0]:-}" ]; then # it failed alone here, so it is refused below
        suspect_tests=$v suspect_new=${added[0]:-}
        tip=$own short=$(git rev-parse --short "$own") rc=1
        return 0
      fi
      aside=$((aside + 1))
      say "$branch steps aside: the next ship in line runs the train with what is left of it"
      requeue "back at the front after it was pulled off its train: starting over from the rebase"
    fi
    queue_phase "testing the train again without its likely causes"
    was=("${train_n[@]}")
    for ((i = 0; i < ${#keep[@]}; i++)); do keep[$i]=${train_n[${keep[$i]}]}; done
    train_tip=() train_br=() train_n=() train_was=()
    tip=$own short=$(git rev-parse --short "$own")
    train_only=" ${keep[*]} " train_left=1
    train_build "${keep[@]}"
    [ ${#train_n[@]} -gt 0 ] || [ ${#keep[@]} = 0 ] || train_release # as for a pulled front's kept ships: this one's own run says nothing of the held
    train_guards
    top_say
    for t in "${was[@]}"; do # a rider the train no longer takes (it no longer rebases onto it, say): back in line
      [[ " ${train_n[*]} " != *" $t "* ]] && [[ " ${held_n[*]} " != *" $t "* ]] && read -r v _ 2>/dev/null <"$train_dir/$t" && [ "$v" = riding ] && rm -f "$train_dir/$t"
    done
    rc=0
    top_gate || rc=$?
    busy_gate
    [ "$rc" != 1 ] || train_main_red || [ ${#train_n[@]} = 0 ] || continue
    return 0
  done
}
# A front that is pulled itself leaves the rest of its train to the next front: <state>/pull, its label, then a
# "keep <ticket> <branch>" line per ship left on the train and a "held <ticket> <branch> <tip> <files> <run> <kind>
# <how> <log, base64>" line per ship held off it. The kept ones go first in line (queue/.order). The next front reads it
# once (pull_look): one of the kept ones takes the others and nobody else, and judges the held; any other front drops
# it, the held back in line with no verdict, so a stale or broken file never holds the line up.
# <rider index>...: the riders that stay on the train; everyone else not held or refused goes back in line.
pull_say() {
  local i v keep=()
  for ((i = 0; i < ${#train_n[@]}; i++)); do
    [[ " ${held_n[*]} " == *" ${train_n[$i]} "* ]] || ! read -r v _ 2>/dev/null <"$train_dir/${train_n[$i]}" || [ "$v" != riding ] || rm -f "$train_dir/${train_n[$i]}"
  done
  if [ $# -gt 0 ]; then
    {
      echo "$label"
      for i; do echo "keep ${train_n[$i]} ${train_br[$i]}"; done
      for ((i = 0; i < ${#held_n[@]}; i++)); do
        echo "held ${held_n[$i]} ${held_br[$i]} ${held_was[$i]} ${held_files[$i]} ${held_run[$i]} ${held_kind[$i]} ${held_how[$i]} $(base64 -w0 <<<"${held_log[$i]}")"
      done
    } >"$state/pull.tmp$$" && mv -f "$state/pull.tmp$$" "$state/pull"
    for i; do keep+=("${train_n[$i]}"); done
    queue_front "$state/queue" "${keep[@]}"
    held_n=() held_br=() held_was=() held_files=() held_run=() held_kind=() held_how=() held_log=() # the next front's now
    split_over
  else train_release; fi
  train_tip=() train_br=() train_n=() train_was=()
}
pull_look() {
  local l=() x v n b w f u k h d mine='' keep=' '
  [ "$mode" = land ] && mapfile -t l 2>/dev/null <"$state/pull" || return 0
  rm -f "$state/pull"
  for x in "${l[@]:1}"; do
    read -r v n b _ <<<"$x"
    [ "$v" = keep ] && [[ $n =~ ^[0-9]{10}$ ]] || continue
    if [ "$n" = "${DEPLOY_QUEUE_TICKET##*/}" ] && [ "$b" = "$branch" ]; then mine=1; else keep+="$n "; fi
  done
  for x in "${l[@]:1}"; do
    read -r v n b w f u k h d <<<"$x"
    [ "$v" = held ] && [[ $n =~ ^[0-9]{10}$ ]] && [ -e "$state/queue/$n" ] || continue
    if [ -n "$mine" ] && [ -n "$d" ]; then
      train_hold "$n" "$b" "$w" "$f" "$u" "$k" "$h" "$(base64 -d <<<"$d" 2>/dev/null || true)"
      train_tell "$n" "riding $branch pulled $f"
      train_held_tips+=" $w"
    elif read -r v _ 2>/dev/null <"$train_dir/$n" && [ "$v" = riding ]; then
      rm -f "$train_dir/$n"
    fi
  done
  [ -n "$mine" ] || return 0
  train_only=$keep train_left=1
  say "ship train: $branch runs on what is left of ${l[0]}'s red train, with nobody else from the line"
}
# A red train whose failing tests name no ship to pull (train_suspects, #1918), and only that. #1899's rule (Josh,
# 2026-11-24: "keep splitting and any green section gets shipped, until the bad change is found
# and then pulled out to be fixed and full train starts over"). The part at its front (split_cut) is tested; green, it ships at once
# (that commit is tested and main hasn't moved, so it needs no further run) and the ships behind it go back in line,
# nobody refused; red, its own first half is next. <state>/split holds the ships the red may be (split_say), so the next
# front among them tests half of what is left (split_look, train_build), down to one ship tested by itself: only a red
# there, on main as it then is, refuses it; but a burn-in red on a case one ship adds (burn_new, #2019) ends the split,
# and that step is judged as a red train of its own (train_suspects). So two ships red only together ship the first and send back the second, and a
# flake refuses nobody. That found, the rest and the line form a full train again. A no-answer: the train goes back in
# line, this one falls back on its own, and the split stays.
# Each step past this one's own commit runs the guard tests first (#1479): red there is the step's answer, with no CI run.
train_bisect() {
  local hi=${#train_n[@]} lo g n back
  n=$((hi + 1)) split_of=${split_of:-$label}
  say "CI is red on the ship train ($ci_url): finding the first ship that turned it red"
  queue_phase "finding the ship that turned the train red"
  while [ "$hi" -gt 0 ]; do
    split_say "$hi"
    lo=$(split_cut "$((hi + 1))")
    # The Releases page shows this step (#1368, src/land-news.ts): train_at "$lo" holds the leader and $lo riders.
    say "bisect: testing the first $((lo + 1)) of $n ships"
    g=0
    [ "$lo" = 0 ] || guard_at "$(train_at "$lo")" || g=$?
    if [ "$g" = 1 ]; then
      hi=$lo
      say "the guard tests failed on the train up to ${train_br[$((lo - 1))]} ($(git rev-parse --short "$(train_at "$lo")")), so that step needs no CI run"
      continue
    fi
    rc=0
    gate "$(train_at "$lo")" || rc=$?
    [ "$rc" = 2 ] || retro_log "bisect run · $branch · $lo of ${#train_br[@]}" # a run without a timing line: tools/known-flakes.ts counts it
    busy_gate "$(train_at "$lo")"
    if [ "$rc" = 2 ]; then return; fi
    if [ "$rc" = 1 ]; then
      if [ -n "$(burn_new "$lo")" ]; then # the step's red names its ship (#2019): judged as a red train of its own, no more steps
        split_over
        train_drop "$lo"
        train_suspects || [ ${#train_n[@]} = 0 ] || train_bisect
        return
      fi
      hi=$lo
      continue
    fi
    back=${train_br[*]:$lo}
    say "bisect: the first $((lo + 1)) of $n ships tested green, so they ship now; back in line with nobody refused: $back; the red may be: ${train_br[*]:$lo:$((hi - lo))}"
    retro_log "ship train green section · $label · $((lo + 1)) of $n ships · back in line: $back · $ci_url"
    train_drop "$lo"
    tip=$(train_at "$lo") short=$(git rev-parse --short "$(train_at "$lo")") rc=0
    top_say
    return
  done
  say "the bisect found $branch itself red, so the ships behind it go back in line"
  train_drop
  tip=$own short=$(git rev-parse --short "$own") rc=1
  train_main_red || true # this red is its own run's: main's red still blames nobody
}
# The ships a red train is down to: <state>/split, the train's leader as retro_log names it, then a "<ticket> <branch>" line each.
# <rider>: this one and its riders up to that one.
split_of='' split_rest=''
split_say() {
  local i
  {
    echo "$split_of"
    echo "${DEPLOY_QUEUE_TICKET##*/} $branch"
    for ((i = 0; i < $1; i++)); do echo "${train_n[$i]} ${train_br[$i]}"; done
  } >"$state/split.tmp$$" && mv -f "$state/split.tmp$$" "$state/split"
}
# <ships>: the last ship, from 0, of the part to test next: the first half.
split_cut() { echo "$((($1 - 2) / 2))"; }
# Is this front one of them? Then split_of names their train and split_rest holds the tickets of those behind it there
# and still in line; else split_rest holds all of them, which ride in no other train while the split goes on.
split_look() {
  local l=() i n b
  split_of='' split_rest=' '
  mapfile -t l 2>/dev/null <"$state/split" || return 0
  for ((i = 1; i < ${#l[@]}; i++)); do
    read -r n b _ <<<"${l[$i]}" # a split begun before #1918 has a third word on some lines, for where to cut
    if [ "$n" = "${DEPLOY_QUEUE_TICKET##*/}" ] && [ "$b" = "$branch" ]; then
      split_of=${l[0]} split_rest=' '
    elif [ -e "$state/queue/$n" ]; then
      split_rest+="$n "
    fi
  done
}
# The bad change is found (or the search is over): the next front builds a full train again.
split_over() {
  [ -n "$split_of" ] || return 0
  rm -f "$state/split"
  split_of='' split_rest=' '
}

# The line and the lock go before the clean-up on GitHub (#553 M14): a hung gh or push held the lock up to 60 s more.
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
  # No answer from CI: the suite runs here only on a quiet perigee (#1254). Until then CI is asked again at every look,
  # since a runner may come back (Cara's desktop logs on); busy_wait refuses once perigee has been busy QUIET_LIMIT s.
  # The train's retest and bisect wait the same way, on the commit they test (#1361). Runs of a train that are lost or cut
  # off every time may be a rider's doing: the caller drops the riders, and this one goes on alone (#1864).
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
  [ -z "$suspect_new" ] || refuse "a new or changed test failed its burn-in in CI on its ship train ($ci_url): $burn_said, in $suspect_tests, and $branch adds the test case that failed, which main doesn't have, so it is the cause: the ships behind it went back in line, so $untouched. A file that fails when run as copies at once is racy (its output is above): fix the race (a shared path, a fixed port, a timing assumption), not the wait, then run this again"
  [ -z "$suspect_tests" ] || [ -z "$burn_said" ] || refuse "a new or changed test failed its burn-in in CI on its ship train ($ci_url): $burn_said, in $suspect_tests, and run alone on perigee it passed on main and failed with $branch on it, so it is the cause: the ships behind it went back in line, so $untouched. A file that fails when run as copies at once is racy (its output is above): fix the race (a shared path, a fixed port, a timing assumption), not the wait, then run this again"
  [ -z "$suspect_tests" ] || refuse "tests failed in CI on its ship train ($ci_url) in $suspect_tests, and run alone on perigee it passed on main and failed with $branch on it, so it is the cause: the ships behind it went back in line, so $untouched. Fix it, re-test, commit, then run this again"
  [ -z "$burn_said" ] || refuse "a new or changed test failed its burn-in in CI ($ci_url): $burn_said, so it never reached the full suite and $untouched. A file that fails when run as copies at once is racy (its output is above): fix the race (a shared path, a fixed port, a timing assumption), not the wait, then run this again. This is the ship's own red, never a known flake"
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
  # Its CPU weight is the embedder's 20, not run-tests.sh's 500, so turns outrank it. A job that took the slot since
  # quiet() looked holds it up no longer than the busy limit's rest: then citadel-heavy gives up (75), and this refuses.
  # --heavy: the suite is CPU work for minutes, so with no past runs to judge by it still takes the slot (#1629).
  half=$(( ( ($(nproc 2>/dev/null || echo 2) + 1) / 2 + 1) / 2 ))
  fallback_limit=$((half < 10 ? 6000 / half : 600)) # run-tests.sh's 600 s is for half the cores; 6 of 9 fallbacks at a quarter of them hit it (#1863)
  [ "$fallback_limit" -le 1800 ] || fallback_limit=1800
  left=$((QUIET_LIMIT - $(busy_waited)))
  # The wait for a slot (up to the busy limit's rest, plus citadel-heavy's load and memory waits) and then the suite can
  # take longer than the line waits; the reruns then set a phase of their own (waits.ts reads their counts from it).
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
main_back() {
  [ -n "$moved" ] || return 0
  # A deploy killed outright never put the checkout back; only with the lock, which a deploy that got as far as queuing its restart has let go of.
  # Nor beside a restart being judged on that checkout (#566): then the next landing does it, with both locks.
  ! flock -n 9 2>/dev/null || ! flock -n 7 2>/dev/null || deploy_unchecked_back "$state" "$LIVE"
  git -C "$LIVE" merge-base --is-ancestor "$tip" HEAD 2>/dev/null && return 0
  if [ "$(git -C "$SOURCE" rev-parse main)" = "$tip" ]; then
    while read -r c b; do taken_back "$state" "$c" "$b"; done < <(train_others)
    taken_back "$state" "$tip" "$train_owner" # first: the landing behind looks for it the moment main goes back
    git -C "$SOURCE" reset -q --keep "$old"
  fi
  # Also when the landing behind this one took it off main first (it does once the restart has its verdict).
  if ! git -C "$SOURCE" merge-base --is-ancestor "$tip" main 2>/dev/null; then
    refuse "the live checkout doesn't have it (the deploy stopped before taking it, or its restart was rolled back), so main is back at $(git log -1 --format=%h "$old"); $branch keeps the rebased work. Fix it and land again"
  fi
}
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
