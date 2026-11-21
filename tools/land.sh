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
#    (git merge-tree), tools/parse-check.ts, and through tools/citadel-test the always-tests plus the test files the
#    branch changes. A fail says "smoke: …", logs a smoke line to the retro log and no timing line. See smoke() below.
# 1. Rebases the branch onto the local main. A conflict aborts the rebase and stops here. If the rebase
#    changed land.sh itself, the rebased copy takes over from here, still holding the lock.
#    Then refuses a branch that removes what a recent landing added without naming it (a stale squash: undo_guard).
#    Then runs the guard tests on the rebased commit (#1240: guards() below), so a break only the branch and main
#    together make is refused in a second or two, before a CI run is spent on it.
# 2. Needs the full suite green on the rebased commit, with main untouched otherwise. Cara's desktop runs it
#    (.github/workflows/tests.yml) and this waits for that run; when CI can't answer it says CI FALLBACK and runs
#    the suite here (tools/run-tests.sh), but only once perigee is quiet (#1254: quiet() below), in citadel-heavy's
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
# main and deploy once for them all. A red train first refuses the ship that turns its really failing tests red run
# alone here, or holds off those whose change touched them (train_suspects, #1346, #1403) and runs again with the next ships in line in their places; failing that, it is bisected by
# its prefixes: the green part ships, the first ship that turned it red is refused with its own failure, and the ships
# after it stay in line. Each rider waits in line
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

# A line in the scheme's retro log. Best effort: land.sh has no session id, so it goes in the day's land.md, and any
# failure here is swallowed so the landing goes on as before.
retro_log() (
  set +e
  [ -n "${COORDINATOR_SHARED_DIR:-}" ] || exit 0
  dir=$COORDINATOR_SHARED_DIR/retro-log/$(date -u +%F)
  mkdir -p "$dir" || exit 0
  [ -e "$dir/land.md" ] || printf '%s\n\n' '# Retro log: land.sh' 'Written by tools/land.sh, tools/run-tests.sh and the queued restart in tools/deploy.sh (no session id, so one file per day). One line per rebase conflict, per landing that fell back from CI to the suite on perigee, per test file that failed in a land or deploy run and passed alone (flake), and per fresh CI run after a red of flakes only (flake rerun: green, red, no answer or not started), and per fresh CI run after one cut off before any test failed (cut-off rerun, the same results). A `smoke` line per landing the smoke check refused before the line (#1012: what failed, its seconds; no timing line for it). Phase times in whole seconds (#565), - for a phase never reached: a `timing` line per landing that got in line, landed or not (line: waiting for the deploy lock; rebase; ci-queue: until a runner took the job; ci-run; fallback: the wait for a CI that gave no answer + the suite on perigee; deploy: pull, boot check and tests if any, until the restart was queued or the front end reloaded; live: from then until the deploy saw it live, the restart'"'"'s settle check included), and a `restart` line per queued restart (idle-wait: for the turns it would cut off and the lock; backup: the database copy; healthy: restart to the first healthy answer; settle: the check after it).' >>"$dir/land.md"
  printf -- '- %sZ · %s\n' "$(date -u +%T)" "$1" >>"$dir/land.md"
) >/dev/null 2>&1 || true

# Phase times for the timing line (#565): "<name> <epoch seconds> [<the phase a refusal from here on is at>]" lines
# in $times, a file of this process's own, so the rebased copy (the exec below) keeps them. deploy.sh adds "queued"
# (the restart queued or the front end reloaded) and "live" lines to it, and "landed" comes once its deploy went through.
land_mark() { { echo "$1 $(date +%s) ${2:-}" >>"$times"; } 2>/dev/null || true; }
# One line when the landing ends, however it ends (each EXIT trap below calls it). Best effort, like retro_log.
land_timing() (
  set +eu
  declare -A t
  rc=$1 now=$(date +%s) phase='?'
  while read -r k v p; do
    [ -n "${t[$k]}" ] || t[$k]=$v
    [ -z "$p" ] || phase=$p
  done <"$times"
  span() { if [ -n "$1" ]; then echo $((${2:-$now} - $1)); else echo -; fi; } # <start> [<end>, else now]; - if it never started
  if [ -n "${t[fallback]}" ]; then
    ciq=- cir=- fb="$(span "${t[ci]}" "${t[gate]}")+$(span "${t[fallback]}" "${t[deploy]}")"
  else
    fb=- ciq=$(span "${t[ci]}" "${t[cirun]:-${t[gate]}}") cir=$(span "${t[cirun]}" "${t[gate]}")
  fi
  if [ -n "${t[merged]}" ]; then out=merged
  elif [ -n "${t[landed]}" ]; then out=landed; [ -n "${t[live]}" ] || out="landed, not live yet"
  elif [ "$rc" = 1 ]; then out="refused at $phase"
  else out="stopped at $phase"; [ "$rc" = 0 ] || out="$out (exit $rc)"; fi # a kill before the signal traps can end it with 0
  [ -z "${retried:-}" ] || [ ! -e "$times" ] || case $out in
    landed*) retro_log "retry in place · $branch · $retried · landed" ;;
    refused*) retro_log "retry in place · $branch · $retried · refused" ;;
    *) retro_log "retry in place · $branch · $retried · stopped" ;;
  esac
  if [ -n "${t[live]}" ]; then live=$((${t[live]} - ${t[queued]:-${t[live]}})); else live=-; fi
  if [ "$mode" = into ]; then # only its own test files: no CI, no deploy
    retro_log "timing · $label · line $(span "${t[start]}" "${t[lock]}") · rebase $(span "${t[lock]}" "${t[tests]}") · tests $(span "${t[tests]}" "${t[gate]}") · $out"
  else
    retro_log "timing · $label · line $(span "${t[start]}" "${t[lock]}") · rebase $(span "${t[lock]}" "${t[ci]}") · ci-queue $ciq · ci-run $cir · fallback $fb · deploy $(span "${t[deploy]}" "${t[queued]}") · live $live${early_ahead:+ · ci early ${early_ahead}s} · $out"
  fi
  rm -f "$times"
) >/dev/null 2>&1

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
  --build) [ $# -eq 1 ] || refuse "--build takes nothing more: run it from the build minion's branch at the build's tip" ; mode=build ;;
  *) refuse "takes no arguments besides --into build/<n> <test files>, --into build/<n> --full and --build (for --now, land first, then run tools/deploy.sh --now with a person's OK)" ;;
esac
tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) # before the cd below, which would break a relative path to it
self=$(stat -c %d:%i "$tools/land.sh") # which file bash is reading; the rebase below may replace it
here=$(git rev-parse --show-toplevel)
cd "$here" # the tests run from the worktree's top, wherever in it this was started
branch=$(git branch --show-current)
{ [ -n "$branch" ] && [ "$branch" != main ]; } || refuse "run it from a minion's branch, not main or a detached HEAD"
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "$here has uncommitted changes: commit them first"
state=$(git -C "$LIVE" rev-parse --absolute-git-dir)/cc-deploy
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
# Build claims (#1159): build-claims.md on build/<n>, the build minion's plan, names the files each feeder writes
# ("#<n>: <paths>"; a path ending in / is a folder, the longest match wins), the hub files any feeder may add to
# ("shared: <paths>") and the build minion ("build: #<n>"). A feeder's --into is refused when it writes a file another
# feeder claimed, an unclaimed file another feeder already merged in, the claims file itself, or, in a shared file,
# lines another feeder merged in. Who merged a commit comes from build/<n>'s reflog ("land.sh --into <branch>"),
# else from a "#<n>" at the start of its subject. It runs at --check, before the lock, and again after the rebase. A plain check, no AI; with no claims file there is no check.
claims_check() {
  local trunk=$1 claims me boss mb merged f who m a b why
  claims=$(git show "refs/heads/$build:build-claims.md" 2>/dev/null) || return 0
  me=$(sed -nE 's#^ticket/([0-9]+)(-.*)?$#\1#p' <<<"$branch")
  boss=$(sed -nE 's/^build:[[:space:]]*#?([0-9]+).*/\1/p' <<<"$claims" | head -n 1)
  [ -n "$boss" ] || { say "warning: $build's build-claims.md has no line build: #<n> naming its build minion, so its claims aren't checked"; return 0; }
  { [ -n "$me" ] && [ "$me" != "$boss" ]; } || return 0 # the build minion's own branch, or one with no minion number
  [ "$mode" != full ] || refuse "--full is the build minion's (#$boss): a feeder merges in with tools/land.sh --into $build <test files>. Nothing merged"
  mb=$(git merge-base "refs/heads/$build" HEAD) || return 0
  # "<commit> <minion>" for each commit a feeder's --into brought in, newest reflog entry first.
  merged=$(git reflog show --format='%H %gs' "refs/heads/$build" 2>/dev/null | awk 'NR > 1 { print $1, prev } { prev = $0 }' |
    while read -r old new tool flag who; do
      [ "$tool $flag" = "land.sh --into" ] || continue
      m=$(sed -nE 's#^ticket/([0-9]+)(-.*)?$#\1#p' <<<"$who")
      [ -z "$m" ] || git rev-list "$old..$new" 2>/dev/null | sed "s/\$/ $m/"
    done)
  # The minion that wrote a commit of the build, or nothing for main's commits and the build minion's.
  writer() {
    git merge-base --is-ancestor "$1" "refs/heads/$trunk" 2>/dev/null && return 0
    local m
    m=$(awk -v c="$1" '$1 == c { print $2; exit }' <<<"$merged")
    [ -n "$m" ] || m=$(git log -1 --format=%s "$1" | sed -nE 's/^#([0-9]+)([^0-9].*)?$/\1/p')
    [ "$m" = "$boss" ] || echo "$m"
  }
  why=$(while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$f" = build-claims.md ]; then
      echo "$f is the build minion's plan, so only it changes a claim"
      continue
    fi
    # A list mark, backticks and commas are read as spaces: "- #4: `a.ts`, `b.ts`" claims both.
    who=$(awk -v f="$f" '{ l = $0; sub(/^[-*][ \t]+/, "", l); gsub(/[`,]/, " ", l) } match(l, /^(#[0-9]+|shared):/) {
        w = substr(l, 1, RLENGTH - 1); sub(/^#/, "", w); n = split(substr(l, RLENGTH + 1), p, /[ \t]+/)
        for (i = 1; i <= n; i++) if (p[i] != "" && (p[i] == f || (p[i] ~ /\/$/ && index(f, p[i]) == 1)) && length(p[i]) > best) { best = length(p[i]); out = w }
      } END { print out }' <<<"$claims")
    if [ "$who" = shared ]; then
      # Each run of lines this branch changes or removes, blamed at the merge-base: any another feeder wrote refuses.
      git -c core.quotePath=false diff -U0 --no-renames "$mb" HEAD -- "$f" | sed -nE 's/^@@ -([0-9]+)(,([0-9]+))? .*/\1 \3/p' | while read -r a b; do
        [ "${b:-1}" != 0 ] || continue
        git blame --porcelain -L "$a,+${b:-1}" "$mb" -- "$f" 2>/dev/null | awk 'length($1) >= 40 && $1 ~ /^[0-9a-f]+$/ { print $1 }' | sort -u | while read -r c; do
          m=$(writer "$c")
          [ -z "$m" ] || [ "$m" = "$me" ] || echo "$f (shared) changes or removes lines #$m merged in (line $a): only add to a shared file"
        done
      done | sort -u
    elif [ -n "$who" ]; then
      [ "$who" = "$me" ] || echo "$f is #$who's in the claims"
    else
      for c in $(git rev-list --reverse "refs/heads/$trunk..refs/heads/$build" -- "$f"); do
        m=$(writer "$c")
        [ -n "$m" ] || continue
        [ "$m" = "$me" ] || echo "$f is unclaimed, but #$m merged it in first, so it is #$m's"
        break
      done
    fi
  done < <(git -c core.quotePath=false diff --name-only --no-renames "$mb" HEAD))
  [ -n "$why" ] || return 0
  why="$branch writes outside its claim in $build's build-claims.md, so nothing merged: $(sed ':a;N;$!ba;s/\n/; /g' <<<"$why"). A late need goes through the build minion: ask #${boss:-?} (message_minion) to move the claim, or leave those files to their owners, then run this again"
  [ -z "$check" ] || { say "$why"; exit 3; } # hand_off_land's early check: exit 3 stops the hand-off with this text
  refuse "$why"
}

label=$branch # for the retro log's lines: which kind of run this is
untouched="main is untouched"
case $mode in
  into | full)
    label="$branch · into $build"
    [ "$mode" = into ] || label="$label, full"
    untouched="$build is untouched"
    [[ $branch != build/* ]] || refuse "run it from a feeder's branch or the build minion's own, not from a build branch"
    git show-ref -q --verify "refs/heads/$build" || refuse "$build doesn't exist: its build minion makes it (git branch $build main), so nothing merged"
    for f in "${files[@]}"; do { [[ $f != -* ]] && [ -f "$f" ]; } || refuse "$f is not a file in $here: name the test files this change touched"; done
    if [ "$mode" = into ] && [ ${#files[@]} -eq 0 ]; then
      code=$(git diff --name-only "refs/heads/$build...HEAD" | grep -vE '\.md$|^docs/' || true)
      [ -z "$code" ] || refuse "name the test files this change touched (tools/land.sh --into $build <test files>): only a docs-only change (*.md, docs/) merges in untested, and it changes $(head -n 3 <<<"$code" | sed ':a;N;$!ba;s/\n/, /g')$([ "$(wc -l <<<"$code")" -le 3 ] || echo ' and more'). Nothing merged"
    fi
    claims_check main ;;
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


# A commit that came off main again (its restart was rolled back) while this branch was already rebased onto it
# (#566: the gate runs beside that restart) is still under this branch, and a plain rebase would carry it back onto
# main. It is left behind, unless it is this branch's own: this prints the newest such commit, for the rebase's --onto.
under_of() {
  local t b u=''
  [ "$mode" = land ] || return 0
  while read -r t b; do
    [ "$b" != "$branch" ] && git merge-base --is-ancestor "$t" HEAD 2>/dev/null && ! git merge-base --is-ancestor "$t" main 2>/dev/null || continue
    { [ -n "$u" ] && git merge-base --is-ancestor "$t" "$u"; } || u=$t
  done < <(cat "$state/taken-back" 2>/dev/null || true)
  echo "$u"
}
# Numbers at ship time (#1221): git with tools/ship-numbers.ts as the merge driver for src/db.ts, so a SCHEMA_HISTORY
# number main took while this waited goes to the branch's next free one instead of conflicting. <main side> names which
# side of the merge is main or the build (ours for merge-tree and a rebase, theirs for --build's merge of main): its
# numbers stay. Only land.sh's own merges get it, not a person's rebase. A tools/ that lacks the driver (mid-rebase
# onto a build without it) merges as git would.
numbers_git() {
  local side=$1
  shift
  git -c "core.attributesFile=$tools/ship-numbers.attributes" -c "merge.citadel-numbers.name=SCHEMA_HISTORY numbers at ship time" \
    -c "merge.citadel-numbers.driver=if [ -f '$tools/ship-numbers.ts' ]; then '$tools/citadel-node' --no-warnings '$tools/ship-numbers.ts' merge $side %O %A %B; else git merge-file %A %O %B; fi" "$@"
}
# A conflict in src/db.ts the driver couldn't sort out: the number to take, from <onto>'s history.
number_hint() {
  local n
  case ", $1, " in *", src/db.ts, "*) ;; *) return 0 ;; esac
  n=$(git show "$2:src/db.ts" 2>/dev/null | sed -n '/^export const SCHEMA_HISTORY = \[$/,/^\] as const;$/p' | grep -oE '^  \[[0-9]+' | tail -n 1 | tr -dc 0-9)
  [ -z "$n" ] || echo " SCHEMA_HISTORY ends at $n on ${2#refs/heads/}: number this branch's new lines from $((n + 1)), and its schema_version checks with them."
}
# What to do about a conflict, the same for a rebase or merge that stopped and for the early check below.
conflict_fix() {
  case $mode in
    land) echo "On conflicts: run git rebase ${under:+--onto }main${under:+ $(git rev-parse --short "$under")}, resolve them keeping the other minions' changes, re-test, commit, then run this again" ;;
    into) echo "On conflicts: run git rebase $build, resolve them keeping the other feeders' changes, re-test, commit, then run this again" ;;
    build) echo "Take main in on your branch by hand (tools/citadel-node tools/ship-numbers.ts take main: git merge main that renumbers the build's schema lines main took), resolve it keeping both sides, run tools/land.sh --into $build --full, then this again" ;;
  esac
}
# The early check (#770): <onto> <when>. Whether the rebase onto <onto> (--build's merge of it) would stop on a conflict,
# by git merge-tree, which touches no worktree, index or ref. With $under, as the rebase's --onto leaves it behind. On a
# conflict it logs the files as conflict() does, says the same refusal, and fails. A git that can't tell (exit 2 and up)
# counts as clean: the rebase itself decides then. shortcut: a three-way merge, not a replay commit by commit. A branch
# that changes a line and changes it back can pass here and still stop in the rebase, which catches it as before; and a
# branch whose commit main already has as a cherry-pick, with a later commit on the same lines, is refused here though
# the rebase would skip it: the git rebase the refusal names then goes through clean. Upgrade to a replay if that bites.
# A conflict the fix recorded with git rerere resolves counts as clean (conflict prep, above): rerere_covers replays it.
# <onto>: git merge-tree's trial of that rebase. 1 on a conflict, its files (comma-separated) in $mt_files.
trial() {
  local out rc=0
  mt_files=''
  out=$(numbers_git ours -c "attr.tree=$1" merge-tree --write-tree --name-only --no-messages ${under:+"--merge-base=$under"} "$1" HEAD 2>/dev/null) || rc=$?
  [ "$rc" = 1 ] || return 0
  mt_files=$(sed -n '2,${/^$/q;p}' <<<"$out" | sort -u | sed ':a;N;$!ba;s/\n/, /g')
  return 1
}
# <dir> <git or numbers_git ours>: after a rebase in <dir> stopped, go on while every stop is one rerere resolved in full
# (git stops even then): no file left unmerged. 1 at any other stop, the rebase left for the caller.
rerere_on() {
  local d=$1 n step
  shift
  [ ${#rr[@]} -gt 0 ] || return 1
  for ((n = 0; n < 1000; n++)); do
    [ -d "$(git -C "$d" rev-parse --absolute-git-dir)/rebase-merge" ] && [ -z "$(git -C "$d" diff --name-only --diff-filter=U)" ] || return 1
    # Nothing staged: the recorded fix kept the other side whole, so this commit is empty now and drops out.
    if git -C "$d" diff --cached --quiet; then step=--skip; else step=--continue; fi
    GIT_EDITOR=true "$@" -C "$d" "${rr[@]}" rebase "$step" >/dev/null 2>&1 && return 0
  done
  return 1
}
# <onto> <commit>: the stack the early next train (early_next, below) made of that commit on that one, if it is still there.
stacked_of() {
  local c
  c=$(awk -v k="$1 $2" '$1 " " $2 == k { print $3; exit }' "$state/stacked" 2>/dev/null) && [ -n "$c" ] && git cat-file -e "$c^{commit}" 2>/dev/null && echo "$c"
}
# <onto>: whether the rebase onto <onto>, which trial() says stops, goes through with the fixes recorded with git rerere.
# Replayed in a scratch worktree, so no ref or worktree of the minion's moves. shortcut: a checkout each time (about 1 s
# for Citadel's 18 MB), only after trial() found a conflict; cache by commits if that ever runs often.
rerere_covers() {
  local wt base ok=1
  [ ${#rr[@]} -gt 0 ] && base=${under:-$(git merge-base "$1" HEAD)} && wt=$(mktemp -d "${TMPDIR:-/tmp}/land-prep.XXXXXX") || return 1
  if git worktree add -q --detach "$wt" HEAD >/dev/null 2>&1; then
    { numbers_git ours -C "$wt" "${rr[@]}" rebase -q --onto "$1" "$base" >/dev/null 2>&1 || rerere_on "$wt" numbers_git ours; } && ok=0
    git -C "$wt" "${rr[@]}" rebase --abort >/dev/null 2>&1 || true # with rerere on, so it drops the preimage it left
    git worktree remove --force "$wt" >/dev/null 2>&1 || true
  fi
  rmdir "$wt" 2>/dev/null || true
  return $ok
}
early_check() {
  local files at
  trial "$1" && return 0
  files=$mt_files
  if rerere_covers "$1"; then
    say "$branch conflicts with ${1#refs/heads/} by git merge-tree $2 (${files:-no files named}), but a fix recorded ahead of time (git rerere, conflict prep) resolves it"
    return 0
  fi
  at=$(git log -1 --format='%h "%s"' "$1")
  retro_log "land conflict · $label onto ${at%% *}: ${files:-no conflicted files named} · $2"
  say "$branch won't $([ "$mode" = build ] && echo "merge ${1#refs/heads/} in" || echo "rebase onto ${1#refs/heads/}") ($at) cleanly, by git merge-tree $2, so nothing landed${files:+; conflicted files: $files}.$(number_hint "$files" "$1") $(conflict_fix)"
  return 1
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
unset LAND_REBASED LAND_REDO LAND_BUILD LAND_RETRY_NOW LAND_RETRIED LAND_FLAKE_KEPT
if [ -n "$check" ]; then
  under=$(under_of)
  case $mode in
    land | build) early_check main "at hand-off" || exit 3 ;;
    into) git merge-base --is-ancestor "refs/heads/$build" HEAD || early_check "refs/heads/$build" "at hand-off" || exit 3 ;;
  esac
  exit 0 # --full: no rebase, so nothing to check
fi

# The smoke check (#1012): before the line, the checks that fail in seconds, so a land they refuse never waits in line
# or for CI (#1006: about 40 of 86 refusals at the lock were these). It reads the branch's own tools (a repo without
# one skips that check). Tests that run past LAND_SMOKE_TIMEOUT (300 s) don't decide: CI still runs everything.
# shortcut: the tests run on the branch as it is, not on its rebase onto main; a break only the two together make
# still meets CI in line. Run them on a merge-tree commit if those show up. Off: LAND_SMOKE=0.
smoke() {
  local t0=$SECONDS out rc=0 tests=()
  smoke_fail() {
    retro_log "smoke · $label · $1 · $((SECONDS - t0))s"
    refuse "smoke: $1, before the line ($((SECONDS - t0)) s), so nothing landed and nobody waited on it. Fix it, re-test (citadel-test), commit, then run this again"
  }
  say "smoke: checking $branch before it queues"
  if [ "$mode" != full ]; then
    under=$(under_of)
    early_check main "before the line" || smoke_fail "it conflicts with main"
  fi
  if [ -f tools/parse-check.ts ]; then
    out=$("$tools/citadel-node" --no-warnings tools/parse-check.ts 2>/dev/null) || true
    [ -z "$out" ] || { sed 's/^/land: smoke: /' <<<"$out" >&2; smoke_fail "a .ts file does not parse"; }
  fi
  # Instruction files that name a repo path that is gone (#1395): only the dead paths this branch adds, so a scheme's old debt
  # never blocks a ship. Every scheme's repo; a tool that is missing or errors is skipped, never a refusal.
  if [ -x "$tools/stale-docs" ] && [ "$mode" = land ]; then
    out=$("$tools/citadel-node" "$tools/stale-docs" refs --new-since "$(git merge-base main HEAD)" 2>/dev/null) && rc=0 || rc=$?
    if [ "$rc" = 1 ]; then sed 's/^/land: smoke: /' <<<"$out" >&2; smoke_fail "an instruction file names a path that is not in the repo (tools/stale-docs refs: fix the line, or allow-list it in .stale-docs-allow with a reason)"; fi
    rc=0
  fi
  if [ -x tools/citadel-test ] && [ -f tools/always-tests.txt ]; then
    # The always-tests, and in a plain land the test files the branch adds or changes; citadel-test drops repeats.
    mapfile -t tests < <(grep -vE '^[[:space:]]*(#|$)' tools/always-tests.txt; [ "$mode" != land ] || git diff --name-only --diff-filter=d "$(git merge-base main HEAD)" HEAD -- 'test/*.test.ts')
    if [ ${#tests[@]} -gt 0 ]; then
      say "smoke: running ${#tests[@]} test files"
      out=$(tools/citadel-test --timeout "${LAND_SMOKE_TIMEOUT:-300}" "${tests[@]}" 2>&1) || rc=$?
      if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
        say "smoke: the tests ran past ${LAND_SMOKE_TIMEOUT:-300} s, so they don't decide: getting in line, and CI runs them all"
      elif [ "$rc" = 2 ]; then # citadel-test couldn't start them (its usage and setup errors), which says nothing about the branch
        say "smoke: citadel-test couldn't run the tests ($(grep -m1 '^citadel-test: ' <<<"$out" || echo exit 2)), so they don't decide: getting in line"
      elif [ "$rc" != 0 ]; then
        # Each failed file once more on its own (no always-tests), as run-tests.sh does: one that passes alone is a
        # likely flake from load, which doesn't decide here (ADR 0006) and gets a flake line. A failure no file names fails.
        local failed=() still=() f
        mapfile -t failed < <(sed -nE 's/^✖ ([^ :]+\.test\.ts)(:[0-9]+)? › .*/\1/p' <<<"$out" | sort -u)
        for f in "${failed[@]}"; do
          CITADEL_TEST_ALWAYS=/dev/null tools/citadel-test --timeout "${LAND_SMOKE_TIMEOUT:-300}" "$f" >/dev/null 2>&1 || still+=("$f")
        done
        if [ ${#failed[@]} -gt 0 ] && [ ${#still[@]} -eq 0 ]; then
          for f in "${failed[@]}"; do retro_log "flake · $f · smoke · $label"; say "flake: $f · smoke"; done
          say "smoke: ${failed[*]} failed, then passed alone: likely load, not your change, so it doesn't decide: getting in line"
        else
          grep -v '^full output: ' <<<"$out" | tail -n 60 | sed 's/^/land: smoke: /' >&2
          smoke_fail "tests failed (exit $rc)"
        fi
      fi
    fi
  fi
  say "smoke: passed in $((SECONDS - t0)) s"
}
[ -n "$resumed" ] || [ "$mode" = into ] || [ "${LAND_SMOKE:-1}" = 0 ] || smoke
quiet=$resumed
[ "$redo" != 1 ] && [ -z "$now_again" ] || quiet=
times=$state/times-$$ # the same in the rebased copy, which is this process
if [ -z "$resumed" ]; then
  rm -f "$times" # what a killed landing with this pid left
  land_mark start line
fi
# shellcheck source=tools/deploy-queue.sh
. "$tools/deploy-queue.sh"
# A rider's side of the ship train (#1166). The landing at the front writes <state>/train/<this ticket>, one line:
#   riding <front's branch>                     it is testing a train with this ship on it
#   moving <train commit> <front> <tip it took> <front's pid and start>   main holds the train and its deploy runs: the
#                                                branch moves to its train commit now, so the release row lists it
#   back <train commit> <tip it took> <front>    the train went without it, or didn't ship: back to waiting, as it was
#   landed <train commit> <live|restart> <front> <tip it took> <ships>   it shipped
#   refused <front> <the red CI run> [likely <tests> [pinned]]   the bisect found it the first ship that turned the train red, or
#                                                with likely: the real failures in <tests> (comma-separated) map to its change (#1346), and
#                                                with pinned: they failed alone here with it and passed without it (#1403); the
#                                                failure's last lines follow
# No file: on no train. <held>: this holds the lock now, so a riding is what a front that was killed left, and so is a
# moving whose front is gone. A moving whose front still runs is its restart being judged, after deploy.sh let go of
# the line (#566): this hands the line on and waits for the verdict outside it, and gets back in line if it is back.
# On landed or refused this ends the landing, as its own ship would have.
train_dir=$state/train riding=''
[ "$mode" != land ] || [ "${LAND_TRAIN:-1}" = 0 ] || QUEUE_TRAIN=train # the ticket's 6th line (tools/deploy-queue.sh)
train_verdict() {
  local f=$train_dir/${DEPLOY_QUEUE_TICKET##*/} v a b c d e x lines=() at requeue=''
  if [ -z "${DEPLOY_QUEUE_TICKET:-}" ] || [ ! -s "$f" ]; then
    [ -z "$riding" ] || { riding=''; queue_phase waiting; say "back in line on its own: the ship train went without $branch"; }
    return 0
  fi
  read -r v a b c d e <"$f" || true
  at=$(git rev-parse HEAD)
  if [ -n "${1:-}" ]; then
    [ "$v" != riding ] || { rm -f "$f"; riding=''; return 0; }
    if [ "$v" = moving ] && [ -n "$d" ] && [ "$(queue_proc "$d")" = "$d $e" ]; then
      [ "$at" != "$c" ] || git reset -q --keep "$a" || true
      queue_done
      flock -u 9
      requeue=1
      say "waiting outside the line for the restart of $b's ship train to be judged"
      while read -r v a b c d e 2>/dev/null <"$f" && [ "$v" = moving ] && [ "$(queue_proc "$d")" = "$d $e" ]; do sleep 1; done
      read -r v a b c d e 2>/dev/null <"$f" || v=''
      at=$(git rev-parse HEAD)
    fi
    [ "$v" != moving ] || { v=back x=$b b=$c c=$x; }
  fi
  case $v in
    riding)
      [ -n "$riding" ] || { riding=1; queue_phase "riding in $a's ship train"; say "riding in $a's ship train: waiting for CI on the train"; }
      return 1 ;;
    moving)
      [ "$at" != "$c" ] || git reset -q --keep "$a" || true
      return 1 ;;
    back)
      [ "$at" != "$a" ] || git reset -q --keep "$b" || true
      rm -f "$f"
      riding=''
      say "back in line on its own: ${c:-the front}'s ship train went without $branch"
      queue_phase waiting
      [ -z "$requeue" ] || QUEUE_TRAIN='' queue_lock "$state" "$branch" || { land_timing 1; exit 1; }
      return 0 ;;
    landed)
      x=$(sed -n 2p "$f" 2>/dev/null) || x=''
      rm -f "$f"
      [ "$at" = "$a" ] || { [ "$at" = "$d" ] && git reset -q --keep "$a"; } ||
        say "$branch moved after the train took it, so it stays as it is; what shipped of it is $(git rev-parse --short "$a")"
      say "shipped in $c's ship train of $e ships, with one CI run and one deploy for them all"
      say "main is now at $(git log -1 --format='%h "%s"' "$a"), in $c's ship train"
      [ -z "$x" ] || say "$x"
      land_mark lock
      land_mark landed
      if [ "$b" = live ]; then
        echo "deploy: live now: $c's ship train went live with it" >&2
        land_mark live
      else
        echo "deploy: not live yet: the restart $c's ship train queued carries it, and reports in that minion's chat" >&2
      fi
      queue_done
      land_timing 0 || true
      exit 0 ;;
    refused)
      mapfile -t lines <"$f" || true
      rm -f "$f"
      [ ${#lines[@]} -lt 2 ] || printf '%s\n' "${lines[@]:1}" >&2
      queue_done
      land_timing 1 || true
      [ "$c" != burn ] || refuse "a new or changed test failed its burn-in in CI on $a's ship train ($b): ${d//,/, }, which $branch changed or which imports what it changed, so it is likely the cause, and it was taken off the train: nothing of it landed and $untouched; $branch is as it was. A file that fails when run as copies at once is racy (its output is above): fix the race (a shared path, a fixed port, a timing assumption), not the wait, then run this again"
      [ "$c $e" != 'likely pinned' ] || refuse "tests failed in CI on $a's ship train ($b) in ${d//,/, }, and run alone on perigee it passed on the train up to the ship before $branch and failed with it, so it is the cause, and it was taken off the train: nothing of it landed and $untouched; $branch is as it was. Fix it, re-test, commit, then run this again"
      [ "$c" != likely ] || refuse "tests failed in CI on $a's ship train ($b) in ${d//,/, }, which $branch changed or which imports what it changed, so it is likely the cause (a guess from the files, not a bisect), and it was taken off the train: nothing of it landed and $untouched; $branch is as it was. Look into it: fix it if it is yours, re-test, commit, then run this again"
      refuse "tests failed in CI on $a's ship train ($b), and its bisect found $branch the first ship that turned it red, so nothing of it landed and $untouched; $branch is as it was. Fix it, re-test, commit, then run this again" ;;
    *)
      rm -f "$f"
      [ -z "$requeue" ] || QUEUE_TRAIN='' queue_lock "$state" "$branch" || { land_timing 1; exit 1; } ;;
  esac
}
# One writer per build branch, on fd 6: a merge into it, its --full run or its land. Merges into a build take a minute,
# so they wait only for each other, not in the lands' line. --full and --build take it before they get in that line, so
# a land never waits on a feeder's test run; the feeders wait for them instead.
build_lock() {
  local lock=$state/build-${build#build/}.lock wait=${LAND_BUILD_WAIT:-3600}
  exec 6>"$lock" || { say "can't open $lock for writing, so nothing merged: a person needs to look at it"; return 1; }
  flock -n 6 && return 0
  say "waiting for the run on $build ahead of this one (a merge into it, its full run or its land) to end"
  flock -w "$wait" 6 && return 0
  say "waited $((wait / 60)) min for the run on $build ahead of this one, so nothing merged: run it again later, or look at what holds $lock"
  return 1
}
# Conflict prep's waiting side (#1366, above): while a train ahead of this one is tested (<state>/train-top, top_say
# below), whether this would still rebase once it ships, by git merge-tree, as against main. Once per train top, branch
# tip and count of recorded fixes. A conflict the recorded fixes don't resolve says one "prep:" line, which the server
# turns into a wake with the steps (src/land.ts), naming the ship on the train that brings it (the first train commit it
# conflicts with). It never leaves the line: the minion's fix, or the conflict at its rebase, decides as before.
prepped=''
prep_check() {
  local top fb fp key files c b cause='' head base
  [ ${#rr[@]} -gt 0 ] && read -r top fb fp 2>/dev/null <"$state/train-top" && [ -n "$top" ] && [ "$fb" != "$branch" ] && kill -0 "$fp" 2>/dev/null || return 0
  [ "$top" != "$(git rev-parse -q --verify refs/heads/main)" ] && git cat-file -e "$top^{commit}" 2>/dev/null || return 0
  head=$(git rev-parse HEAD)
  key="$top $head $(find "$(git rev-parse --path-format=absolute --git-common-dir)/rr-cache" -name 'postimage*' 2>/dev/null | wc -l)"
  [ "$key" != "$prepped" ] || return 0
  prepped=$key under=$(under_of)
  trial "$top" && return 0
  files=$mt_files
  while read -r c b; do trial "$c" || { cause=$b; break; }; done < <(tail -n +2 "$state/train-top" 2>/dev/null)
  if rerere_covers "$top"; then
    say "prep: $branch conflicts with ${cause:-a ship} on $fb's ship train ($files), but the fix recorded ahead of time (git rerere) resolves it, so its rebase goes through once that train ships"
    return 0
  fi
  base=${under:-$(git merge-base "$top" HEAD)}
  retro_log "train prep conflict · $label onto $fb's train ($(git rev-parse --short "$top")) · ${cause:-?}: $files"
  say "prep: $branch will conflict with ${cause:-a ship} once $fb's ship train ships; conflicted files: ${files:-none named}; record the fix against $top from $base to $head"
  return 0
}
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
# <onto> <rebase|merge> <refusal>: a rebase or merge that stopped. Which files collide is worth a retro-log
# line (the architecture check counts them).
conflict() {
  local conflicted what
  conflicted=$(git diff --name-only --diff-filter=U 2>/dev/null | sed ':a;N;$!ba;s/\n/, /g' || true)
  if [ -n "$conflicted" ]; then what=" onto $(git log -1 --format=%h "$1"): $conflicted"; else what=": no conflicted files found (the $2 may not have started)"; fi
  retro_log "land conflict · $label$what"
  git "${rr[@]}" "$2" --abort 2>/dev/null || true # nothing to abort if it never started (an untracked file in the way)
  refuse "$3${conflicted:+; conflicted files: $conflicted}.$(number_hint "$conflicted" "$1") $(conflict_fix)"
}
if [ "$mode" = build ] && [ "$redo" = 1 ]; then
  git reset -q --keep "$base" # main went back while this waited: main is merged in again without what came off it
fi
under=$(under_of) # under_of above: a commit that came off main, which the rebase leaves behind
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
# Bash goes on reading the file it started from, so a rebase that replaced land.sh would land with the old one (#500):
# go on in the rebased one instead. It keeps the lock on fd 9 (and the build's on fd 6), and its own rebase finds
# nothing to do. Not --into: that holds no deploy lock for the copy to find, and only tests and moves a branch.
[ "$mode" = into ] || [ -n "$quiet" ] || [ "$(stat -c %d:%i "$tools/land.sh")" = "$self" ] || LAND_REBASED=1 LAND_REDO=${redo:+2} LAND_BUILD=$build exec bash "$tools/land.sh" "${args[@]}"

# ADR numbers at ship time (#1221): a docs/adr/NNNN-*.md this branch adds whose number main (a feeder: the build) took
# while it waited goes to the next free number, with its links and the branch's own "ADR NNNN" lines, in one commit.
adr_onto=
case $mode in land | build) adr_onto=main ;; into) adr_onto=refs/heads/$build ;; esac # the build's lock holds it at $base
if [ -n "$adr_onto" ] && [ -f "$tools/ship-numbers.ts" ]; then
  renamed=$("$tools/citadel-node" --no-warnings "$tools/ship-numbers.ts" adr "$adr_onto") || refuse "renumbering this branch's ADRs failed (see above), so nothing landed. Run git status, put back what it left, then this again"
  if [ -n "$renamed" ]; then
    sed 's/^/land: /' <<<"$renamed" >&2
    n=${branch#ticket/} n=${n%%-*}
    git commit -q -m "${n:+#$n: }$(head -n 1 <<<"$renamed")" -m "Numbered at ship time by tools/land.sh (#1221):" -m "$renamed"
    [ "$mode" != into ] || claims_check main # its link rewrites may reach a file another feeder claims
  fi
fi

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

# <state>/bad: "<commit> <last-good> <when> <what it restarted on>", left by the restart that rolled <commit>'s deploy back (tools/deploy.sh),
# or with " rollback" after it by a Roll back to last green from <commit> (deploy.sh --to, #1016).
# While main still holds that commit every deploy pulls it in again and is rolled back too (#553), so only its fix
# may land: a branch that changes a file that deploy changed, or one the lander vouches for with LAND_FIX=1.
bad_check() {
  local bad good rest
  # <state>/rolling-back: "<from> <to> <when>", while a Roll back to last green's restart waits (deploy.sh --to, #1271).
  # Its deploy would refuse after main moved, so refuse now, the fix too: its own deploy would undo the roll back.
  if [ -s "$state/rolling-back" ]; then
    read -r _ good _ <"$state/rolling-back" || true
    if systemctl --user is-active -q "${DEPLOY_UNIT:-cc-restart-when-idle}" 2>/dev/null; then
      refuse "a member pressed Roll back to last green, and its restart onto $(git log -1 --format='%h "%s"' "$good" 2>/dev/null || echo "${good:0:7}") waits to go live (for running turns a restart would cut off). Nothing landed. Ship again once it is live (the Releases page shows it)"
    fi
    rm -f "$state/rolling-back" # left by a roll back that was killed
  fi
  [ -s "$state/bad" ] || return 0
  read -r bad good rest <"$state/bad" || true
  git -C "$SOURCE" merge-base --is-ancestor "$bad" main 2>/dev/null || { rm -f "$state/bad"; return 0; }
  [ -z "${LAND_FIX:-}" ] || return 0
  [ -z "$(comm -12 <(git diff --name-only "$good" "$bad" | sort) <(git diff --name-only main HEAD | sort))" ] || return 0 # not `| grep -q`, as above
  local why="the restart on it failed: its report is in the chat of the minion that deployed it"
  [ "${rest##* }" != rollback ] || why="a member pressed Roll back to last green on Releases"
  refuse "main holds $(git log -1 --format='%h "%s"' "$bad"), whose deploy was rolled back ($why), and $branch changes none of the files that deploy changed, so its deploy would be rolled back too. Nothing landed. Land the fix for it first (or its revert); if $branch is that fix, run LAND_FIX=1 tools/land.sh (from a turn in a container: the land tool with fix: true)"
}
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
# The lane (#753, tools/lanes as main has it): light runs no tests and no CI, and deploy.sh restarts nothing for it;
# kit runs CI as usual, where tools/run-tests.sh picks the test files that read the kit. Lands into a build stay full.
lane=full
if [ "$mode" = land ]; then
  read -r lane lane_why < <(git diff --no-renames --name-only "$old" "$tip" | "$tools/lane.sh" "$old") || lane=full
  [ "$lane" = full ] || say "lane: $lane (tools/lanes; the path that decided it: $lane_why)"
fi

# The deploy's boot check, before a CI run is spent (#646). Only while <state>/refusing is there: deploy.sh leaves it
# ("<when> <why>") when its boot check fails and removes it when one passes. On Nov 13 nine landings each waited in
# line and for CI, to be refused by a boot check that failed on every commit. The fix for such a failure passes here
# and lands as usual. Off: LAND_PREFLIGHT=0, or for every landing, touch <state>/preflight-off.
preflight() {
  local at why since rc=0
  [ -s "$state/refusing" ] || return 0
  { [ "${LAND_PREFLIGHT:-1}" != 0 ] && [ ! -e "$state/preflight-off" ]; } || return 0
  read -r at why <"$state/refusing" || true
  [[ $at =~ ^[0-9]+$ ]] || return 0
  since=$(date -d "@$at" '+%b %-d %H:%M %Z')
  say "deploy has been refusing since $since ($why): running its boot check on $short before a CI run is spent on it"
  queue_phase "boot check before CI since $(date +%H:%M)"
  land_mark preflight preflight
  # As deploy.sh runs it: the commit's own check, a limit from outside, not as `node`, and without the locks' fds.
  timeout -k 10 "${DEPLOY_BOOT_TIMEOUT:-420}" "$here/tools/citadel-node" "$here/tools/boot-check.ts" "$here" "${DEPLOY_DB:-$HOME/.local/share/claude-coordinator/coordinator.db}" >/dev/null 9>&- 7>&- 6>&- || rc=$?
  if [ "$rc" = 0 ]; then
    say "the boot check passes on $short, so this landing goes on"
    return 0
  fi
  retro_log "preflight refusal · $label · refusing since $since ($why)"
  # 124, or 137 from timeout's KILL: stopped at the limit, which is not a verdict on the change (as deploy.sh says of it).
  [ "$rc" != 124 ] && [ "$rc" != 137 ] || refuse "deploy has been refusing since $since: $why, and the boot check hung on $short here too (stopped after ${DEPLOY_BOOT_TIMEOUT:-420} s), so no CI run was spent and $untouched; $branch keeps the rebased work. A hang is not a verdict on the change: run it again, and if it hangs again tell the Taskmaster, since landings are blocked until that is fixed"
  refuse "deploy has been refusing since $since: $why, and $short fails the same check here (its output is above), so no CI run was spent and $untouched; $branch keeps the rebased work. If the cause is in your change, fix it and land again. If it isn't, landings are blocked until the fix for it lands (that fix passes this check and lands as usual): tell the Taskmaster, and don't retry until then"
}
# A light land deploys without the boot check, so a refusing deploy doesn't hold it up.
[ "$mode" = into ] || [ "$mode" = full ] || [ "$lane" = light ] || preflight

# The guard tests, on the rebased commit before a CI run is spent (#1240). Each checks the repo's files against what
# main already holds (a schema number, the prompts' budget, the tests' own wait helpers, the UI contract), so a branch that
# was clean alone can break one only together with main: the smoke check, on the branch as it was, can't see that, and
# on 2026-11-20 these four were most of CI's real reds. A second or two. Only the ones the repo has; a feeder's merge
# into a build (--into) skips them as it skips CI, and its build's own land runs them.
guards() {
  local t0=$SECONDS out rc=0 tests=() f
  for f in test/schema-compat.test.ts test/prompt-budget.test.ts test/one-until.test.ts test/ui-contract.test.ts; do [ ! -f "$f" ] || tests+=("$f"); done
  [ -x tools/citadel-test ] && [ ${#tests[@]} -gt 0 ] || return 0
  land_mark guards guards
  out=$(CITADEL_TEST_ALWAYS=/dev/null tools/citadel-test --timeout "${LAND_GUARD_TIMEOUT:-120}" "${tests[@]}" 2>&1 9>&- 7>&- 6>&-) || rc=$?
  case $rc in
    0) say "guard tests passed on $short in $((SECONDS - t0)) s" ;;
    2 | 124 | 137) say "the guard tests couldn't run or ran past ${LAND_GUARD_TIMEOUT:-120} s (exit $rc), so they don't decide: CI runs them" ;;
    *)
      grep -v '^full output: ' <<<"$out" | tail -n 60 | sed 's/^/land: guard: /' >&2
      retro_log "guard · $label · $(sed -nE 's/^✖ ([^ :]+\.test\.ts).*/\1/p' <<<"$out" | sort -u | paste -sd, -) · $((SECONDS - t0))s"
      refuse "guard tests failed on $short, the branch rebased onto ${build:-main} (output above), so no CI run was spent and $untouched; $branch keeps the rebased work. Run citadel-test on that file, fix it, commit, then run this again" ;;
  esac
}
[ "$mode" = into ] || [ "$lane" = light ] || guards

# The end of --into: build/<n> moves to what was tested, unless something moved it meanwhile (the compare-and-swap).
merge_into() {
  git update-ref -m "land.sh --into $branch" "refs/heads/$build" "$tip" "$base" || refuse "$build moved while this ran (not by land.sh, which holds its lock), so nothing merged: run it again"
  land_mark merged
  queue_done ok
  say "$build is now at $(git log -1 --format='%h "%s"' "$tip"); main and the live checkout are untouched"
  exit 0
}
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
CI_DOWN=${LAND_CI_DOWN:-600} # how long one landing's unanswered wait for CI spares the next ones theirs
CI_START=${LAND_CI_START:-90} CI_START_ONLINE=${LAND_CI_START_ONLINE:-900} CI_LIMIT=${LAND_CI_TIMEOUT:-360} CI_POLL=${LAND_CI_POLL:-5}
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
# As the box's own gh login, like deploy.sh's push of main (#182), whoever's turn this is; never holding the lock.
hub() { env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 timeout 30 "$@" 9>&- 7>&- 6>&-; }
ci_slug='' ci_id='' ci_status='' ci_result='' ci_url='' ci_pushed='' why='' burn_red='' burned=''
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
# 0 when perigee is quiet; else 1, with what is busy in $busy.
quiet() {
  local line load cores total avail
  busy=''
  cores=$(nproc 2>/dev/null || echo 2)
  if ! { line=$(grep -m 1 '^some ' "$QUIET_PROC/pressure/cpu" 2>/dev/null) && [[ $line =~ avg60=([0-9]+) ]]; }; then busy+="no CPU pressure reading, "
  elif [ "$((10#${BASH_REMATCH[1]}))" -ge "$QUIET_PSI" ]; then busy+="CPU pressure ${BASH_REMATCH[1]}% (quiet is under $QUIET_PSI%), "; fi
  # In hundredths, so 2.75 on 5 cores is busy.
  if ! { read -r load _ 2>/dev/null <"$QUIET_PROC/loadavg" && [[ $load =~ ^([0-9]+)\.([0-9]{2}) ]]; }; then busy+="no load reading, "
  elif [ $((10#${BASH_REMATCH[1]}${BASH_REMATCH[2]} * 2)) -ge $((cores * 100)) ]; then busy+="load $load on $cores cores (quiet is under half), "; fi
  total=$(sed -n 's/^MemTotal: *\([0-9]*\) kB/\1/p' "$QUIET_PROC/meminfo" 2>/dev/null) avail=$(sed -n 's/^MemAvailable: *\([0-9]*\) kB/\1/p' "$QUIET_PROC/meminfo" 2>/dev/null)
  if ! [[ $total =~ ^[0-9]+$ && $avail =~ ^[0-9]+$ ]] || [ "$total" -le 0 ]; then busy+="no memory reading, "
  elif [ $((avail * 100 / total)) -lt "$QUIET_MEM" ]; then busy+="$((avail * 100 / total))% of memory free (quiet is $QUIET_MEM% or more), "; fi
  # Only looked at, not held: a job that takes it before the run below makes that run wait, but no longer than the busy limit.
  if [ -e "$heavy_dir/slot-0" ] && ! flock -n "$heavy_dir/slot-0" true 2>/dev/null; then busy+="perigee's heavy slot is taken ($(head -c 120 "$heavy_dir/slot-0.who" 2>/dev/null || echo '?')), "; fi
  if [ -e "$heavy_dir/queue" ] && ! flock -n "$heavy_dir/queue" true 2>/dev/null; then busy+="jobs are in line for that slot, "; fi
  busy=${busy%, }
  [ -z "$busy" ]
}
# A refusal by the pipeline, not by the ship's own change (#1360, Cara 2026-11-20, "Refused ships keep their place"): CI
# and perigee both busy, the heavy slot taken, or a perigee red of flakes only. Once per hand-off a plain land keeps its
# ticket instead of refusing: it lets go of the lock, the next ship in line takes it (tools/deploy-queue.sh, QUEUE_YIELD)
# and takes this one on its train as the first rider; with no train (a pipeline change, CI down) this goes right after
# it. Back at the front, it starts over from its rebase. Only a fully green run ships it, as ever (ADR 0006).
# <why>: returns when it can't (a second time, or not a plain land), and the caller refuses as before.
# <why> flake: flake_keep's, which doesn't count as the one pipeline retry and says how many it has used.
retry_in_place() {
  [ -n "${2:-}" ] || [ -z "$retried" ] || { say "refused by the pipeline again ($1), after its one retry in place ($retried), so it is refused this time"; return 0; }
  [ "$mode" = land ] && [ -n "${DEPLOY_QUEUE_TICKET:-}" ] && [ -e "$DEPLOY_QUEUE_TICKET" ] || return 0
  if [ -n "${2:-}" ]; then
    flake_kept=$((flake_kept + 1))
    say "refused on flakes only ($1), not your change: keeping its place in line and riding the next train ($flake_kept of $FLAKE_KEEP_MAX)"
    retro_log "flake keep · $branch · $1 · $flake_kept of $FLAKE_KEEP_MAX"
  else
    say "refused by the pipeline ($1), not your change: keeping its place in line and riding the next train, once"
    retried=$1
  fi
  train_drop
  top_done
  ci_done
  trap 'land_timing $? || true; queue_done' EXIT
  queue_wait_check() { { train_verdict && prep_check; } || true; }
  flock -u 9
  QUEUE_KEEP=$DEPLOY_QUEUE_TICKET QUEUE_YIELD=yield queue_lock "$state" "$branch" || { land_timing 1; exit 1; }
  unset -f queue_wait_check
  train_verdict held
  say "back at the front after its retry in place: starting over from the rebase"
  LAND_REBASED=1 LAND_RETRY_NOW=1 LAND_RETRIED=$retried LAND_FLAKE_KEPT=$flake_kept exec bash "$tools/land.sh" "${args[@]}"
}
# A CI red of flakes only on the one fresh run too (#1419 part 2, Taskmaster 2026-11-21, after Cara: "I thought they
# were supposed to keep their spot not?"): when every failed file passed alone again and no ship on the train changed
# one or what it imports, the ship keeps its place (retry_in_place) instead of going back to its minion, at most
# FLAKE_KEEP_MAX times a hand-off; past that it is refused as before, so a ship that really breaks something can't circle.
FLAKE_KEEP_MAX=2
flake_keep() {
  local again f hits=() chg=()
  again=$(flake_only) || return 0
  ! grep -qE 'The tests left [0-9]+ process\(es\) running' <<<"$failed" || return 0 # leftover processes are no flake
  train_chg
  for f in ${again//, / }; do
    mapfile -t hits < <(train_suspects_of "$f")
    [ ${#hits[@]} = 0 ] || return 0
  done
  [ "$flake_kept" -lt "$FLAKE_KEEP_MAX" ] || { say "only flakes failed again ($again), but it has kept its place $flake_kept times already, so it is refused this time"; return 0; }
  retry_in_place "$reran, then $again on the fresh run" flake
}
# Perigee is busy: say so (at first, then every 5 min) and refuse once it has been busy QUIET_LIMIT s. $1: why CI didn't answer.
# The busy time adds up only from one call to the next (#1361): ci_gate clears busy_last while a runner is online and CI
# hasn't given up on it, so time spent waiting on a merely busy desktop never counts towards the refusal.
busy_waited() { if [ -n "$busy_last" ]; then echo $((busy_spent + SECONDS - busy_last)); else echo "$busy_spent"; fi; }
busy_wait() {
  local waited
  waited=$(busy_waited)
  busy_spent=$waited busy_last=$SECONDS
  [ "$waited" -lt "$QUIET_LIMIT" ] || retry_in_place "CI and perigee both busy for $((waited / 60)) min"
  [ "$waited" -lt "$QUIET_LIMIT" ] || refuse "CI and perigee both busy, try again: CI: $1; perigee for $((waited / 60)) min: $busy. So $untouched"
  # Every 5 min, a new phase too: the line behind counts an unchanged one as stuck after DEPLOY_QUEUE_STALL (15 min).
  if [ -z "$busy_told" ] || [ $((SECONDS - busy_told)) -ge 300 ]; then
    say "waiting for CI or a quiet perigee: CI: $1, but perigee is busy ($busy), so this keeps asking CI and runs the suite here only once perigee is quiet (refused after $((QUIET_LIMIT / 60)) min, $((waited / 60)) min so far)"
    queue_phase "waiting for CI or a quiet perigee, $((waited / 60)) min so far"
    busy_told=$SECONDS
  fi
}
# What gh or git said on stderr ($state/ci.err), as " (<its first lines>)" (git's "To <remote>" left out) for a reason (#553 F12d: a rate limit, a missing gh
# and a rejected push all read alike). Nothing when it said nothing.
ci_said() {
  local s
  s=$(grep -v -e '^[[:space:]]*$' -e '^To ' "$state/ci.err" 2>/dev/null | head -n 4 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed ':a;N;$!ba;s/\n/; /g' | cut -c1-300) || true
  [ -z "$s" ] || echo " ($s)"
}
# The newest run of the workflow on this commit, into ci_*; nothing when there is none. Fails when GitHub doesn't answer
# with one (an error page is no answer).
ci_run() {
  local run
  run=$(hub gh api "repos/$ci_slug/actions/runs?head_sha=$tip&per_page=20" --jq "[.workflow_runs[] | select(.path | startswith(\"$CI_WORKFLOW\"))][0] // empty | [.id, .status, .conclusion // \"-\", .html_url] | @tsv" 2>"$state/ci.err") || return 1
  [ -z "$run" ] || [[ $run =~ ^[0-9]+$'\t' ]] || { echo "it sent something that isn't a run: $(head -c 100 <<<"$run")" >"$state/ci.err"; return 1; }
  read -r ci_id ci_status ci_result ci_url <<<"$run" || true
}
# Leaves nothing behind on GitHub: a run nobody waits for is cancelled, and the scratch branch goes.
ci_done() {
  [ -z "$ci_id" ] || [ "$ci_status" = completed ] || hub gh api -X POST "repos/$ci_slug/actions/runs/$ci_id/cancel" >/dev/null 2>&1 || true
  [ -z "$ci_pushed" ] || hub git push -q "$REMOTE" ":refs/heads/$CI_REF" ":refs/heads/$CI_BASE_REF" >/dev/null 2>&1 || true
  ci_id='' ci_pushed=''
}
# 0 when the run's full suite step failed and it has a rerun step (#1374), in any state: one already ended means the
# run ended between the gate's look and this one, and the next look reads its verdict rather than falling back on a
# red it already has. A first pass still going, a run with no rerun step, or GitHub not answering is no.
ci_rerunning() {
  local steps
  steps=$(hub gh api "repos/$ci_slug/actions/runs/$ci_id/jobs" --jq "[.jobs[].steps[] | select(.name == \"$CI_STEP\" or .name == \"$CI_RERUN_STEP\") | [.name, .status, .conclusion // \"-\"] | @tsv] | .[]" 2>/dev/null) || return 1
  grep -qxF "$CI_STEP"$'\t'completed$'\t'failure <<<"$steps" || return 1
  grep -q "^$CI_RERUN_STEP"$'\t' <<<"$steps"
}
# 0, with its seconds in $burned (CI_BURN at most, or CI_BURN while it still runs), when the run has a burn-in step that took
# any time (#1443). One that skipped, a run without the step, or GitHub not answering is no. Timestamps go through date, which
# reads GitHub's milliseconds and offsets.
ci_burned() {
  local st a b
  read -r st a b < <(hub gh api "repos/$ci_slug/actions/runs/$ci_id/jobs" --jq "[.jobs[].steps[] | select(.name == \"$CI_BURN_STEP\") | [.status, .started_at // \"-\", .completed_at // \"-\"] | @tsv][0] // empty" 2>/dev/null) || : # no answer leaves st empty
  case $st in
    in_progress) burned=$CI_BURN ;;
    completed) a=$(date -d "$a" +%s 2>/dev/null) && b=$(date -d "$b" +%s 2>/dev/null) || return 1; burned=$((b - a)) ;;
    *) return 1 ;;
  esac
  [ "$burned" -le "$CI_BURN" ] || burned=$CI_BURN
  [ "$burned" -gt 0 ]
}
# Only when no runner is online, GitHub errors (#1361) or a runner's clock is off (#900): a late start or a slow run says
# nothing about the next ship's.
ci_down() { printf '%s %s\n' "$(date +%s)" "$why" >"$state/ci-down" 2>/dev/null || true; }
# How many runners with the label are online. Its own query (the runners list, a page of 100), not the one before a push.
ci_online() {
  local n
  n=$(hub gh api "repos/$ci_slug/actions/runners?per_page=100" --jq "[.runners[] | select(.status == \"online\" and any(.labels[]; .name == \"$CI_LABEL\"))] | length" 2>"$state/ci.err") || return 1
  [[ $n =~ ^[0-9]+$ ]] || { echo "it sent: $(head -c 100 <<<"$n")" >"$state/ci.err"; return 1; }
  echo "$n"
}
# 0: green on this commit. 1: red. 2: no answer, with the reason in $why.
ci_gate() {
  local url online='' online_at='' step stale='' started=$SECONDS waited ci_taken='' taken_at='' nap down n told='' limit=$CI_LIMIT rerun_wait='' burn_wait='' ran
  [ "${LAND_CI:-1}" != 0 ] || { why="LAND_CI=0 was set"; return 2; }
  { [ -n "$REMOTE" ] && url=$(git remote get-url "$REMOTE" 2>/dev/null); } || { why="this repo has no ${REMOTE:-GitHub} remote"; return 2; }
  ci_slug=${url#*github.com[:/]} ci_slug=${ci_slug%.git}
  # A CI outage is paid once (#553): a landing that waited out a limit leaves a note, and those of the next minutes
  # go straight to the run here instead of each waiting to learn the same thing.
  local down_at='' down_why='' now
  now=$(date +%s)
  read -r down_at down_why 2>/dev/null <"$state/ci-down" || true
  # While perigee is busy the note doesn't count: this landing asks CI itself rather than wait on perigee.
  if [[ $down_at =~ ^[0-9]+$ ]] && [ $((now - down_at)) -lt "$CI_DOWN" ] && quiet; then
    why="CI gave no answer to a landing $((now - down_at)) s ago ($down_why), so this one doesn't wait for it (it is asked again from $(date -d "@$((down_at + CI_DOWN))" +%H:%M))"
    return 2
  fi
  ci_run || { why="GitHub didn't answer$(ci_said)"; return 2; }
  # A run of this commit that is green or still going (a landing stopped and started again) will do; otherwise a new one.
  if [ -z "$ci_id" ] || { [ "$ci_status" = completed ] && [ "$ci_result" != success ]; }; then
    stale=$ci_id ci_id=''
    # shortcut: with the repo variable CI_RUNNER=github (hosted runners) this finds no runner and falls back; look at the variable too if that is ever used for long.
    online=$(hub gh api "repos/$ci_slug/actions/runners" --jq "[.runners[] | select(.status == \"online\" and any(.labels[]; .name == \"$CI_LABEL\"))] | length" 2>"$state/ci.err") || { why="GitHub didn't say which runners are online$(ci_said)"; return 2; }
    [[ $online =~ ^[0-9]+$ ]] || { why="GitHub didn't say which runners are online (it sent: $(head -c 100 <<<"$online"))"; return 2; }
    [ "$online" -gt 0 ] || { why="no $CI_LABEL runner is online (they run only while Cara is logged on to her desktop)"; return 2; }
    ci_pushed=1
    # Forced on purpose: land/<branch> and land-base/<branch> are scratch branches only this script writes and deletes, so
    # there is no one's work to overwrite. Atomic, so the run never starts without the base its burn-in compares with.
    hub git push -q --atomic "$REMOTE" "+$tip:refs/heads/$CI_REF" "+$old:refs/heads/$CI_BASE_REF" 2>"$state/ci.err" || { why="pushing $short to GitHub failed$(ci_said)"; return 2; }
  fi
  say "waiting for CI on $short: the full suite on Cara's desktop (up to $((CI_START_ONLINE / 60)) min for a runner to start it while one is online, then at most $((CI_LIMIT / 60)) min for the run; past that it runs here once perigee is quiet)"
  queue_phase "waiting for CI since $(date +%H:%M)"
  while :; do
    ci_run || true # one missed answer is not a verdict: the limits below end the wait
    [ "$ci_id" != "$stale" ] || ci_id='' ci_status=''
    if [ -z "$ci_taken" ] && { [ "$ci_status" = in_progress ] || [ "$ci_status" = completed ]; }; then # a runner took it
      ci_taken=1 taken_at=$SECONDS
      land_mark cirun
      # Not `[ = completed ] ||`: a stop that lands in the $(date) after a failed test would read as a refusal (exit 1).
      if [ "$ci_status" != completed ]; then queue_phase "waiting for CI: running since $(date +%H:%M)"; fi
    fi
    [ "$ci_status" != completed ] || break
    waited=$((SECONDS - started))
    # Past a limit the suite runs here, but only on a quiet perigee: until then this keeps waiting for the run (busy_wait).
    why='' down=''
    if [ -n "$ci_taken" ]; then
      ran=$((SECONDS - taken_at))
      if [ "$ran" -ge "$limit" ]; then
        if [ -z "$burn_wait" ] && ci_burned; then
          burn_wait=1 limit=$((limit + burned))
          say "CI's burn-in of new and changed tests took ${burned}s before its full suite, so this waits that much more ($ci_url)"
        elif [ -z "$rerun_wait" ] && ci_rerunning; then
          rerun_wait=1 limit=$((ran + CI_RERUN))
          say "CI's full run ended red and it is rerunning the failed files alone to tell flakes from real failures, so this waits up to $((CI_RERUN / 60)) min $((CI_RERUN % 60)) s more for them instead of falling back at ${CI_LIMIT}s ($ci_url)"
          queue_phase "waiting for CI's reruns alone since $(date +%H:%M)"
        else
          why="CI didn't finish within ${limit}s of starting${rerun_wait:+, its reruns alone included}"
        fi
      fi
    elif [ "$waited" -ge "$CI_START" ]; then
      # Not started yet: is a runner online? Asked afresh past CI_START, then every CI_ONLINE_POLL s. A missed answer keeps
      # the last one (the count before the push, at first); with none at all, GitHub errs.
      if [ -z "$online_at" ] || [ $((SECONDS - online_at)) -ge "$CI_ONLINE_POLL" ]; then
        if n=$(ci_online); then online=$n online_at=$SECONDS; fi
      fi
      if [ -z "$online" ]; then why="GitHub didn't say which runners are online$(ci_said)" down=1
      elif [ "$online" = 0 ]; then why="no runner started the job within ${CI_START}s, and no $CI_LABEL runner is online (they run only while Cara is logged on to her desktop)" down=1
      elif [ "$waited" -ge "$CI_START_ONLINE" ]; then why="no runner started the job within ${CI_START_ONLINE}s, though a $CI_LABEL runner is online"
      elif [ -z "$told" ] || [ $((SECONDS - told)) -ge 300 ]; then
        # Every 5 min, a new phase too: the line behind counts an unchanged one as stuck after DEPLOY_QUEUE_STALL (15 min).
        say "a $CI_LABEL runner is online but hasn't started the job (busy with another run, most likely), so this waits for it: up to $((CI_START_ONLINE / 60)) min, $((waited / 60)) min so far"
        queue_phase "waiting for CI: a busy runner, $((waited / 60)) min so far"
        told=$SECONDS
      fi
    fi
    nap=$CI_POLL
    # On a busy perigee it asks CI and perigee again every QUIET_POLL s, not every CI_POLL s (Josh: "re-checking every 30 s").
    if [ -n "$why" ]; then
      if quiet; then [ -z "$down" ] || ci_down; return 2; fi
      busy_wait "$why"
      nap=$QUIET_POLL
    else
      busy_last='' # a runner is online and CI hasn't given up on it: this time isn't perigee's busy time (#1361)
    fi
    sleep "$nap"
  done
  case $ci_result in
    success) rm -f "$state/ci-down"; say "CI passed on $short in $((SECONDS - started))s ($ci_url)" ;;
    failure)
      # Red only when the tests ran: a run that failed setting up (no user manager, a download) says nothing about this commit.
      step=$(hub gh api "repos/$ci_slug/actions/runs/$ci_id/jobs" --jq '[.jobs[].steps[] | select(.conclusion == "failure") | .name][0] // empty' 2>/dev/null) || step=''
      # A skewed clock (#900) lasts hours, until the distro behind it stops: the note spares the next landings a run each.
      [ "$step" != "$CI_CLOCK_STEP" ] || { why="runner clock: the CI runner's clock stayed skewed for 2 min, so no test ran ($ci_url); a systemd-timesyncd in a WSL distro on Cara's desktop must be masked (tools/ci-runner/README.md)"; ci_down; return 2; }
      [ "$step" != "$CI_BURN_STEP" ] || { burn_red=1; return 1; } # the ship's own red (#1443)
      [ "${step:-$CI_STEP}" = "$CI_STEP" ] || { why="the CI run failed in its setup step \"$step\", before any test ran ($ci_url): the runner needs fixing"; return 2; }
      return 1 ;;
    timed_out) return 1 ;;
    *) why="the CI run ended as $ci_result, not as a verdict on the tests"; return 2 ;;
  esac
}

# A red run's failed log into $failed, its last lines on stderr, and run-tests.sh's flake labels into the retro log
# (they can't reach it from the desktop, so they are written from its output here).
ci_failed() {
  local f load
  failed=$(hub gh run view "$ci_id" --repo "$ci_slug" --log-failed 2>/dev/null) || failed=''
  tail -n 40 <<<"$failed" >&2
  [ -z "$burn_red" ] || return 0 # a burn-in's log may quote run-tests.sh's lines (test/land.test.ts does): no flakes from it
  while read -r f load; do
    retro_log "flake · $f · load $load · $branch · in CI${train_br[*]:+ · with ${train_br[*]}}" # riders: one run (#1419)
    say "flake: $f · in CI" # the server counts these (src/flakes.ts)
  done < <(sed -n 's/.*run-tests: \(.*\): failed in the full run, passed alone.*load \([0-9.]*\)).*/\1 \2/p' <<<"$failed")
}
# The burn-in's verdict in $failed (#1443): "<file>: failed in <n> of <N> copies at once" for each red file; nothing otherwise.
burn_lines() { sed -n 's/.*burn-in: \([^ ]*: failed in [0-9]* of [0-9]* copies at once\).*/\1/p' <<<"$failed" | sort -u; }
# The failed files, comma-separated, when $failed says every one of them passed alone (#769); fails otherwise. It
# counts on run-tests.sh's own lines: "<n> test file(s) failed; rerunning each alone…" and then one label per file.
# Without that line (more than its max_reruns files, a hang, a leak, a run that never got to the tests) it is no flake.
# Only the labels after that line count: a test's own output can quote one (test/land.test.ts does).
flake_only() {
  local at n files
  at=$(grep -n 'run-tests: [0-9][0-9]* test file(s) failed; rerunning each alone' <<<"$failed" | tail -n 1 | cut -d: -f1)
  [[ $at =~ ^[0-9]+$ ]] || return 1
  n=$(sed -n "${at}s/.*run-tests: \\([0-9][0-9]*\\) test file(s) failed.*/\\1/p" <<<"$failed")
  [[ $n =~ ^[1-9][0-9]*$ ]] || return 1
  files=$(tail -n "+$at" <<<"$failed" | sed -n 's/.*run-tests: \(.*\): failed in the full run, passed alone.*/\1/p' | sort -u)
  [ -n "$files" ] && [ "$(wc -l <<<"$files")" = "$n" ] || return 1
  sed ':a;N;$!ba;s/\n/, /g' <<<"$files"
}
# Whether $failed is a run cut off from outside before any test failed (#1377): Node's test runner printed its
# "Interrupted while running:" (a SIGINT or SIGTERM: run 44859457680 of Nov 20, at 55 s), no test failed, and run-tests.sh
# didn't stop it as a hang (its timeout sends the same signal, and a hang is a real red). It says nothing about the commit.
# #1393: so is a run killed from outside (exit 137, the desktop's out-of-memory killer): run-tests.sh's "were killed" line,
# or only GitHub's exit 137 line when the whole step went. A SIGKILL leaves Node no summary, so "no test failed" there
# means no ✖ anywhere in the log; a test that had failed before the kill is a verdict, and the run stays red.
cut_off() {
  ! grep -qF 'run-tests: the tests ran past' <<<"$failed" || return 1
  if grep -qE '(^|[[:space:]])Interrupted while running:' <<<"$failed" && ! grep -qF '✖ failing tests:' <<<"$failed"; then return 0; fi
  grep -qE 'run-tests: the tests were killed \(exit [0-9]+\)|Process completed with exit code 137\.' <<<"$failed" && ! grep -qF '✖' <<<"$failed"
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
# <from> <to>: whether the change touches a path in tools/pipeline-files.txt (a path ending / is its folder).
pipeline_touch() {
  [ -f tools/pipeline-files.txt ] || return 1
  awk 'NR == FNR { if ($0 !~ /^[[:space:]]*(#|$)/) p[++n] = $0; next }
    { for (i = 1; i <= n; i++) if ($0 == p[i] || (p[i] ~ /\/$/ && index($0, p[i]) == 1)) { hit = 1; exit } }
    END { exit !hit }' tools/pipeline-files.txt <(git diff --no-renames --name-only "$1" "$2")
}
# <rider index> <lines>: its verdict, by a rename, so it never reads half of one.
train_say() { local n=${train_n[$1]}; shift; train_tell "$n" "$@"; }
# <ticket> <lines>: the same, for a ship by its ticket (one held off the train, #1403).
train_tell() {
  local f=$train_dir/$1
  shift
  printf '%s\n' "$@" >"$f.tmp$$" && mv -f "$f.tmp$$" "$f"
}
# [<index>]: the riders from there on (all by default) leave the train with no verdict: back in line as they were.
train_drop() {
  local i v x c
  for ((i = ${1:-0}; i < ${#train_n[@]}; i++)); do
    read -r v x c <"$train_dir/${train_n[$i]}" 2>/dev/null || continue
    case $v in
      riding) rm -f "$train_dir/${train_n[$i]}" ;;
      moving) # ended after main moved: landed if main still holds it and the deploy got it live or its restart queued
        if git -C "$SOURCE" merge-base --is-ancestor "${train_tip[$i]}" main 2>/dev/null && grep -qE '^(queued|live) ' "$times" 2>/dev/null; then
          train_landed "$i"
        else train_say "$i" "back ${train_tip[$i]} ${train_was[$i]} $branch"; fi ;;
    esac
  done
  train_tip=("${train_tip[@]:0:${1:-0}}") train_br=("${train_br[@]:0:${1:-0}}") train_n=("${train_n[@]:0:${1:-0}}") train_was=("${train_was[@]:0:${1:-0}}")
}
train_landed() { # <rider index>
  local kind=restart
  ! grep -q '^live ' "$times" 2>/dev/null || kind=live
  train_say "$1" "landed ${train_tip[$1]} $kind $branch ${train_was[$1]} $((${#train_n[@]} + 1))" "${known_by[$tip]:+shipped past known flakes ${known_by[$tip]}}"
}
# "<commit> <branch>" of each ship in the train but the top one, which is "$tip $train_owner": what came off main with
# it when main goes back (taken-back), so each branch on its train commit leaves the others' commits behind.
train_others() {
  local i
  [ ${#train_n[@]} -gt 0 ] || return 0
  echo "$own $branch"
  for ((i = 0; i + 1 < ${#train_n[@]}; i++)); do echo "${train_tip[$i]} ${train_br[$i]}"; done
}
# What the ships waiting behind test their conflict prep against (prep_check): <state>/train-top while this one's gate
# runs, by a rename. Line 1: "<top> <this branch> <pid>"; then "<commit> <branch>" for each ship on it, this one first.
# Only its own is removed (top_done): a front that let go of the line for its restart (#566) leaves the next one's.
top_say() {
  local i f=$state/train-top
  [ ${#rr[@]} -gt 0 ] || return 0
  { echo "$tip $branch $$"; echo "$own $branch"; for ((i = 0; i < ${#train_n[@]}; i++)); do echo "${train_tip[$i]} ${train_br[$i]}"; done; } >"$f.tmp$$" && mv -f "$f.tmp$$" "$f"
}
top_done() { local x _ p; read -r x _ p 2>/dev/null <"$state/train-top" && [ "$p" = $$ ] && rm -f "$state/train-top"; return 0; }
# Early next train (#1366; Cara, 2026-11-20, picked "Also test next train early"). Once this train passed its gate, just
# before its deploy, early_next stacks the ship next in line, and the train it would take, on this train's top in a
# scratch worktree and pushes that to CI, so its run goes while this one deploys. Only then: two suites at once on Cara's
# desktop flaked (tests.yml), and the lands' runs go one at a time anyway. Each stack goes to <state>/stacked
# ("<onto> <commit> <result>"), which that ship's own rebase and train_build take instead of rebasing again (a re-run
# rebase is a new commit), so a train that comes out the same is the same commit, and ci_gate takes the early run as its
# own. <state>/early: "<top> <its branch> <when pushed> <this branch>"; the next landing to reach its gate counts it, or
# cancels it (early_gate). Off: LAND_EARLY=0, or for every landing, touch <state>/early-off.
early_ahead=''
early_slug() { local url; url=$(git remote get-url "$REMOTE" 2>/dev/null) || return 1; url=${url#*github.com[:/]}; echo "${url%.git}"; }
early_next() {
  local q=$state/queue t x c l nb='' nt='' r own_e wt lane_e slug free out top n
  [ "$mode" = land ] && [ "${LAND_EARLY:-1}" != 0 ] && [ ! -e "$state/early-off" ] && [ "${LAND_CI:-1}" != 0 ] && [ -n "$REMOTE" ] || return 0
  ! pipeline_touch "$old" "$tip" || return 0 # the next one runs this train's own land.sh, not this one
  local -A QUEUE_RANK=()
  local QUEUE_OLD=() QUEUE_ORDER_BY=''
  queue_order "$q"
  while read -r x t; do # the first in line that isn't on this train
    [ "${t##*/}" != "${DEPLOY_QUEUE_TICKET##*/}" ] && mapfile -t l 2>/dev/null <"$t" || continue
    [ "${l[1]:-}" = 0 ] && [ -n "${l[0]:-}" ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]}" ] || continue
    read -r x _ 2>/dev/null <"$train_dir/${t##*/}" && [[ $x = riding || $x = moving ]] && continue
    [ "${l[5]:-}" = train ] && [[ $(queue_state "${l[0]%% *}") != [Tt] ]] && nt=${t##*/} nb=${l[2]:-}
    break
  done < <(for t in "$q"/[0-9]*; do [[ ${t##*/} =~ ^[0-9]+$ ]] && printf '%s %s\n' "$(queue_key "${t##*/}")" "$t"; done | sort)
  [ -n "$nb" ] && [ "$nb" != "$branch" ] && [[ $nb != build/* ]] && r=$(git rev-parse -q --verify "refs/heads/$nb^{commit}") || return 0
  while read -r x c; do # it would leave a commit that came off main behind: not the plain rebase stacked here
    [ "$c" != "$nb" ] && git merge-base --is-ancestor "$x" "$r" 2>/dev/null && ! git merge-base --is-ancestor "$x" main 2>/dev/null && return 0
  done < <(cat "$state/taken-back" 2>/dev/null || true)
  slug=$(early_slug) || return 0
  free=$(hub gh api "repos/$slug/actions/runners" --jq "[.runners[] | select(.status == \"online\" and .busy == false and any(.labels[]; .name == \"$CI_LABEL\"))] | length" 2>/dev/null) || free=''
  [[ $free =~ ^[1-9][0-9]*$ ]] || { say "early next train: no free $CI_LABEL runner, so $nb's CI waits for its turn"; return 0; }
  wt=$(mktemp -d "${TMPDIR:-/tmp}/land-early.XXXXXX") || return 0
  if git worktree add -q --detach "$wt" "$r" >/dev/null 2>&1 && { numbers_git ours -C "$wt" "${rr[@]}" rebase -q "$tip" >/dev/null 2>&1 || { rerere_on "$wt" numbers_git ours && retro_log "train prep replayed · $nb onto $label's train ($(git rev-parse --short "$tip")), early"; }; }; then
    own_e=$(git -C "$wt" rev-parse HEAD)
  else
    git -C "$wt" "${rr[@]}" rebase --abort >/dev/null 2>&1 || true
    own_e=''
  fi
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
  rmdir "$wt" 2>/dev/null || true
  [ -n "$own_e" ] && [ "$own_e" != "$tip" ] || return 0 # a conflict is its own rebase's to report, after this ships
  read -r lane_e _ < <(git diff --no-renames --name-only "$tip" "$own_e" | "$tools/lane.sh" "$tip") || lane_e=full
  [ "$lane_e" != light ] || return 0 # it runs no CI
  echo "$tip $r $own_e" >"$state/stacked.tmp$$"
  # The train it would take, as train_build will build it once it has the line, with no verdicts said and nothing logged.
  out=$(
    early_memo=$state/stacked.tmp$$ branch=$nb own=$own_e old=$tip lane=$lane_e tip=$own_e DEPLOY_QUEUE_TICKET=$nt
    train_n=() train_br=() train_tip=() train_was=()
    say() { :; }
    retro_log() { :; }
    train_say() { :; }
    train_build >/dev/null 2>&1 || true
    echo "$tip ${#train_n[@]} ${train_br[*]}"
  ) || out=''
  read -r top n x <<<"$out" && [ -n "$top" ] || { rm -f "$state/stacked.tmp$$"; return 0; }
  mv -f "$state/stacked.tmp$$" "$state/stacked"
  # With its base (this train's top: main once it deploys), atomic, as ci_gate pushes it: the burn-in (#1443) compares with it.
  hub git push -q --atomic "$REMOTE" "+$top:refs/heads/land/$nb" "+$tip:refs/heads/land-base/$nb" 2>"$state/ci.err" || { say "early next train: pushing $nb's train to GitHub failed$(ci_said), so its CI waits for its turn"; return 0; }
  echo "$top $nb $(date +%s) $branch" >"$state/early"
  say "early next train: $nb${x:+ (with $x riding)} is stacked on this train's top and its CI starts now, while this one deploys ($(git rev-parse --short "$top")); if its train comes out the same, that run is its CI"
  retro_log "early train · $nb${x:+ + $n riders} onto $label's train ($(git rev-parse --short "$tip")) · pushed $(git rev-parse --short "$top")"
}
# At this landing's gate, with its train built: an early run on it counts (early_ahead: how long ago it started), and
# any other early run is cancelled, so it doesn't hold up this one's in the lands' one-at-a-time CI group.
early_gate() {
  local top b at fb slug run id st w
  read -r top b at fb 2>/dev/null <"$state/early" || return 0
  rm -f "$state/early"
  [[ $at =~ ^[0-9]+$ ]] && slug=$(early_slug) || return 0
  run=$(hub gh api "repos/$slug/actions/runs?head_sha=$top&per_page=20" --jq "[.workflow_runs[] | select(.path | startswith(\"$CI_WORKFLOW\"))][0] // empty | [.id, .status, .conclusion // \"-\"] | @tsv" 2>/dev/null) || run=''
  read -r id st w _ <<<"$run" || true
  if [ "$b" = "$branch" ] && [ "$top" = "$tip" ] && [[ $id =~ ^[0-9]+$ ]] && { [ "$st" != completed ] || [ "$w" = success ]; }; then
    early_ahead=$(($(date +%s) - at))
    say "early next train: CI started on this train at $(date -d "@$at" +%H:%M) while $fb's deployed, and it came out the same, so that run is its CI ($early_ahead s head start)"
    retro_log "early train · $label · counted · ${early_ahead}s head start"
    return 0
  fi
  if [ "$b" != "$branch" ]; then w="$b wasn't next in line after all"
  elif [ "$top" != "$tip" ]; then w="its train came out different from the one stacked early"
  elif [[ $id =~ ^[0-9]+$ ]]; then w="the early run failed, so it runs again" # as for a run on the same commit from a landing started again
  else w="GitHub has no run of it"; fi
  [[ ! $id =~ ^[0-9]+$ ]] || [ "$st" = completed ] || hub gh api -X POST "repos/$slug/actions/runs/$id/cancel" >/dev/null 2>&1 || true
  # Its scratch branch goes too, so a push of the same commit later starts a fresh run.
  hub git push -q "$REMOTE" ":refs/heads/land/$b" ":refs/heads/land-base/$b" >/dev/null 2>&1 || true
  say "early next train: dropped the early CI run on $b's train ($w)"
  retro_log "early train · $label · discarded · $w"
}
# <member>: the train's commit through that ship (0: this one's own, 1 on: its riders).
train_at() { if [ "$1" = 0 ]; then echo "$own"; else echo "${train_tip[$(($1 - 1))]}"; fi; }
# [<ticket>...]: those first, in that order, then the rest of the line in its order (a refill after suspects, #1346).
train_build() {
  local max=${LAND_TRAIN_MAX:-6} q=$state/queue t l b r base c cur=$own wt='' skip down_at='' down_why='' x
  local -A tried=()
  [ "$mode" = land ] && [ "$lane" != light ] && [ "${LAND_TRAIN:-1}" != 0 ] && [ ! -e "$state/train-off" ] || return 0
  [[ $max =~ ^[0-9]+$ ]] && [ "$max" -gt 0 ] || return 0
  [ ! -s "$state/bad" ] && [ ! -s "$state/refusing" ] || return 0
  [ "${LAND_CI:-1}" != 0 ] && [ -n "$REMOTE" ] && git remote get-url "$REMOTE" >/dev/null 2>&1 || return 0
  read -r down_at down_why 2>/dev/null <"$state/ci-down" || true
  ! [[ $down_at =~ ^[0-9]+$ ]] || [ $(($(date +%s) - down_at)) -ge "$CI_DOWN" ] || return 0
  ! pipeline_touch "$old" "$own" || return 0
  local -A QUEUE_RANK=()
  local QUEUE_OLD=() QUEUE_ORDER_BY=''
  queue_order "$q"
  mkdir -p -m 700 "$train_dir"
  find "$train_dir" -maxdepth 1 -type f -mmin +1440 -delete 2>/dev/null || true # a killed rider's, or one never read
  while read -r x t <&4; do # not on stdin, which git and perl below may read
    [ ${#train_n[@]} -lt "$max" ] || break
    [ "${t##*/}" != "${DEPLOY_QUEUE_TICKET##*/}" ] && [ -z "${tried[${t##*/}]:-}" ] && mapfile -t l 2>/dev/null <"$t" || continue
    tried[${t##*/}]=1
    read -r x _ 2>/dev/null <"$train_dir/${t##*/}" && [[ $x = moving || $x = refused ]] && continue # still on the train before this one, or refused by this one
    [ -z "${early_memo:-}" ] || [ "$x" != riding ] || continue # early_next: on the train before this one
    [[ $train_refused != *" ${t##*/} "* ]] || continue # refused as a suspect, though its rider already read the verdict
    [[ $train_held != *" ${t##*/} "* ]] || continue    # held off the train on a guess until the train without it has a verdict (#1403)
    [ "${l[1]:-}" = 0 ] && [ "${l[5]:-}" = train ] && [ -n "${l[0]:-}" ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]}" ] || continue
    [[ $(queue_state "${l[0]%% *}") != [Tt] ]] || continue
    b=${l[2]:-}
    [ -n "$b" ] && [ "$b" != "$branch" ] && [[ $b != build/* ]] && r=$(git rev-parse -q --verify "refs/heads/$b^{commit}") || continue
    skip=''
    base=$(git merge-base main "$r") || continue
    [ -z "$(git rev-list --merges "$base..$r")" ] || skip="it has merge commits"
    while read -r x c; do
      [ -z "$skip" ] && [ "$c" != "$b" ] && git merge-base --is-ancestor "$x" "$r" 2>/dev/null && ! git merge-base --is-ancestor "$x" main 2>/dev/null || continue
      skip="it sits on a commit that came off main"
    done < <(cat "$state/taken-back" 2>/dev/null || true)
    for x in $train_refused_tips $train_held_tips; do
      [ -z "$skip" ] && git merge-base --is-ancestor "$x" "$r" 2>/dev/null || continue
      skip="it sits on a ship this train just refused"
      [[ " $train_held_tips " != *" $x "* ]] || skip="it sits on a ship this train holds off as a likely cause"
    done
    if [ -z "$skip" ]; then
      if [ -z "$wt" ]; then
        wt=$(mktemp -d "${TMPDIR:-/tmp}/land-train.XXXXXX") && git worktree add -q --detach "$wt" "$cur" 2>/dev/null || { say "ship train: couldn't make a scratch worktree, so this ships alone"; wt=''; break; }
      fi
      # Stacked already by the early next train (early_next), else rebased here.
      if { c=$(stacked_of "$cur" "$r") && git -C "$wt" checkout -q --detach "$c" 2>/dev/null; } ||
        { git -C "$wt" checkout -q --detach "$r" 2>/dev/null && { git -C "$wt" "${rr[@]}" rebase -q --onto "$cur" "$base" >/dev/null 2>&1 || { rerere_on "$wt" git && retro_log "train prep replayed · $b onto $branch's train ($(git rev-parse --short "$cur"))"; }; }; }; then
        c=$(git -C "$wt" rev-parse HEAD)
        if [ "$c" = "$cur" ]; then skip="main already has all of it"
        elif pipeline_touch "$cur" "$c"; then skip="it changes the ship pipeline, which ships alone"
        elif ! (cd "$wt" && branch=$b && undo_guard "$cur") >/dev/null 2>&1; then skip="the undo guard stops it on the train"
        fi
      else
        git -C "$wt" "${rr[@]}" rebase --abort >/dev/null 2>&1 || true
        skip="it doesn't rebase cleanly onto the train"
      fi
    fi
    if [ -n "$skip" ]; then say "ship train: $b stays in line ($skip)"; continue; fi
    [ -z "${early_memo:-}" ] || echo "$cur $r $c" >>"$early_memo"
    train_n+=("${t##*/}") train_br+=("$b") train_tip+=("$c") train_was+=("$r")
    train_say $((${#train_n[@]} - 1)) "riding $branch"
    cur=$c
  done 4< <(for t in "$@"; do printf '%s %s\n' - "$q/$t"; done; for t in "$q"/[0-9]*; do [[ ${t##*/} =~ ^[0-9]+$ ]] && printf '%s %s\n' "$(queue_key "${t##*/}")" "$t"; done | sort)
  [ -z "$wt" ] || git worktree remove --force "$wt" >/dev/null 2>&1 || true
  [ ${#train_n[@]} -gt 0 ] || return 0
  tip=$cur short=$(git rev-parse --short "$cur")
  say "ship train: $branch takes the $((${#train_n[@]})) ships waiting behind it (${train_br[*]}): CI runs once on all $((${#train_n[@]} + 1)), and they ship together"
  retro_log "ship train · $label · ${#train_n[@]} riders: ${train_br[*]}"
}

# <commit>: the gate on it. 0: green, 1: red (its log in $failed, its run in $ci_url; $reran when it was the one fresh
# run after a red of flakes only), 2: no answer ($why).
gate() {
  local rc=0
  ci_done
  [ -z "$early_ahead" ] || ci_pushed=1 # the early run's scratch branch is this landing's to delete, however it ends
  tip=$1 short=$(git rev-parse --short "$1") failed='' reran='' burn_red=''
  ci_gate || rc=$?
  # One fresh run, never more, for a red of flakes only (#769). The scratch branch goes first so the push starts a new
  # run (pushing a commit a branch already has starts none); ci_gate then passes over the red one as stale, so it is
  # never read as the answer. A no-answer this time falls back to the run here, which must be green too. If the branch
  # won't go, there is no fresh run: it stays a red, rather than a wait for a run never started read as CI being down.
  # A run cut off before any test failed (#1377) gets the same one fresh run; cut off again, it is no answer. A red of
  # known flakes only (#1419: known_flakes) needs no fresh run: it is a green.
  local cut=''
  if [ "$rc" = 1 ]; then
    ci_failed
    if [ -n "$burn_red" ]; then
      retro_log "burn-in red · $branch${train_br[*]:+ · with ${train_br[*]}} · $(burn_lines | paste -sd';' -) · $ci_url"
    elif cut_off; then
      cut=$ci_url
    elif ! reran=$(flake_only); then
      reran=''
    elif known_flakes "$reran"; then
      say "only known flakes failed in CI ($ci_url): $known_why, so this goes on as green, with no fresh run"
      retro_log "known flake · $branch · $known_why · $ci_url"
      known_by[$1]=$known_why reran='' rc=0
    fi
    if [ -z "$cut$reran" ]; then
      :
    elif ! hub git push -q "$REMOTE" ":refs/heads/$CI_REF" 2>"$state/ci.err"; then
      if [ -n "$cut" ]; then
        why="the CI run was cut off before any test failed ($cut), and deleting $CI_REF on GitHub to start a fresh run failed$(ci_said)"
        retro_log "cut-off rerun · $branch · $cut · not started"
        rc=2
      else
        say "failed in the full run but passed alone ($reran), but deleting $CI_REF on GitHub to start a fresh run failed$(ci_said), so this stays red"
        retro_log "flake rerun · $branch · $reran · not started"
        reran=''
      fi
    else
      if [ -n "$cut" ]; then say "the CI run on $short was cut off before any test failed ($cut), so it says nothing about this commit: running CI once more"
      else say "failed in the full run but passed alone ($reran); running CI once more on $short, the land needs a fully green run"; fi
      ci_id='' ci_pushed=''
      rc=0
      ci_gate || rc=$?
      if [ "$rc" = 1 ]; then
        ci_failed
        [ -n "$burn_red" ] || ! cut_off || { why="CI was cut off twice before any test failed ($cut, $ci_url)"; [ -n "$cut" ] || why="CI's one fresh run after a red of flakes only ($reran) was cut off before any test failed ($ci_url)"; rc=2; }
      fi
      case $rc in 0) result=green ;; 1) result=red ;; *) result='no answer' ;; esac
      if [ -n "$cut" ]; then retro_log "cut-off rerun · $branch · $cut · $result"; else retro_log "flake rerun · $branch · $reran · $result"; fi
    fi
  fi
  [ "$rc" != 0 ] || greens="$greens$1 "
  return "$rc"
}
# Suspects first (#1346, Cara 2026-11-20: "we pull out the minions that touched the failing tests as they are vastly
# more likely to be the culprit"): before a bisect, a red train's real failures (run-tests.sh's labels: not the
# flakes) are pinned on ships. Each failing file first runs alone here on the train's prefixes (train_pin, #1403, Cara
# 2026-11-20, "Confirm suspects first"): the ship that turns it red is the cause, seconds a step rather than a CI run a
# step. A file perigee can't fail alone (a test only CI's machine fails) is pinned by the files instead: the ships whose
# change touched it; failing that, a file it imports by a relative path or names by its path; failing that, a file those
# import. If every real failure has a suspect, those confirmed here are refused with the failure, one only guessed
# waits off the train (train_settle; a guess naming more ships goes to the bisect), and the train is built again from
# the others plus the next ships in line, for one more CI run. Green, or red on other tests only: the held ships are
# refused. A held ship's test failed again (any label, not rerun included): back in line. A real failure back: the
# guess was wrong, and the bisect takes over on that train. Red on new real failures only: another round, up to 3. 0: done (rc as gate's, 1 only for this one alone or confirmed itself),
# 1: the bisect looks, on the train as it now is (its top red, its log in $failed).
suspect_tests='' suspect_pinned='' train_refused=' ' train_refused_tips='' train_held=' ' train_held_tips=''
held_n=() held_br=() held_was=() held_files=() held_run=() held_log=()
# The real failures in $failed, one test file a line: those that failed again alone, hung, or whose rerun stopped at
# CI's deadline. A file not rerun, or whose rerun was killed from outside (#1393), may be load or real, so it names no suspect: if it is real, the refilled train is red
# on it, and the next round sees it. Fails when there are none, or the log doesn't label every failed file.
train_real() {
  local at n out
  [ -z "$burn_red" ] || { burn_lines | sed 's/: failed in .*//' | grep .; return; } # each burn-in red file is a real failure (#1443)
  at=$(grep -n 'run-tests: [0-9][0-9]* test file(s) failed; rerunning each alone' <<<"$failed" | tail -n 1 | cut -d: -f1)
  [[ $at =~ ^[0-9]+$ ]] || return 1
  n=$(sed -n "${at}s/.*run-tests: \\([0-9][0-9]*\\) test file(s) failed.*/\\1/p" <<<"$failed")
  out=$(tail -n "+$at" <<<"$failed" | sed -n 's/.*run-tests: \([^ ]*\): \(failed in the full run, passed alone\|failed again alone\|hung when rerun alone\|rerun alone stopped\|not rerun\|killed (exit [0-9]*) when rerun alone\).*/\2 \1/p' | sort -u -k2)
  [[ $n =~ ^[1-9][0-9]*$ ]] && [ -n "$out" ] && [ "$(wc -l <<<"$out")" = "$n" ] || return 1
  out=$(sed -n 's/^\(failed again alone\|hung when rerun alone\|rerun alone stopped\) //p' <<<"$out")
  [ -n "$out" ] && echo "$out"
}
# <file>: the repo paths it imports by a relative path, as the train's top has it.
train_imports() {
  local p
  git show "$tip:$1" 2>/dev/null | grep -oE "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]\.\.?/[^'\"]+['\"]" |
    sed -E "s/.*['\"](\.[^'\"]+)['\"]$/\1/" | while read -r p; do realpath -ms --relative-to="$PWD" "$PWD/$(dirname "$1")/$p"; done | sort -u
}
# <test file>: the train members (0: this one, 1 on: its riders) its failure is pinned on, nearest first. Reads chg.
train_suspects_of() {
  local f=$1 text reach lvl m c hits
  text=$(git show "$tip:$f" 2>/dev/null) || text=''
  reach=$f
  for lvl in 0 1 2; do
    [ "$lvl" = 0 ] || reach=$(while read -r c; do [ -z "$c" ] || train_imports "$c"; done <<<"$reach" | sort -u)
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
# branches, an open fix minion) that no ship on the train changed, nor what it imports (the suspects' map). Says why
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
  [ -n "$ok" ] || { while read -r f; do [[ $f != *'(not seen on another branch'* ]] || say "$f is no known flake"; done <<<"$out"; return 1; }
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
# at LAND_PIN_LIMIT s or a checkout that fails is no answer (any other code), since a busy perigee can be that slow.
train_alone() {
  git -C "$1" checkout -q --detach "$2" 2>/dev/null || return 2
  [ -e "$1/$3" ] || return 0
  (cd "$1" && timeout -k 10 "${LAND_PIN_LIMIT:-120}" nice -n 19 "$tools/citadel-node" --test --test-force-exit --test-timeout=60000 "$3") >>"$state/train-pin.log" 2>&1 9>&- 7>&- 6>&- </dev/null
}
# <test file>: the train member (0: this one, 1 on: its riders) that turns it red run alone here: it fails at the train's
# top and passes on main, so the train's prefixes are bisected with that one file, and the answer is run once more on
# each side (red with it, green just before it) so one load failure can't pin an innocent ship. Nothing when it passes
# at the top here (a test only CI's machine fails), fails on main too, a step gives no answer, or the recheck disagrees:
# the files decide then.
train_pin() {
  local f=$1 lo=-1 hi=${#train_n[@]} mid wt r=0 before
  wt=$(mktemp -d "${TMPDIR:-/tmp}/land-pin.XXXXXX") && git worktree add -q --detach "$wt" "$tip" 2>/dev/null || return 0
  : >"$state/train-pin.log"
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
  git worktree remove --force "$wt" >/dev/null 2>&1 || true
}
# Every file the full run failed in $failed, whatever its rerun showed (a held ship's test not rerun is no pass).
train_failing() {
  local at
  [ -z "$burn_red" ] || { burn_lines | sed 's/: failed in .*//' | sort -u; return; }
  at=$(grep -n 'run-tests: [0-9][0-9]* test file(s) failed; rerunning each alone' <<<"$failed" | tail -n 1 | cut -d: -f1)
  [[ $at =~ ^[0-9]+$ ]] || return 0
  tail -n "+$at" <<<"$failed" | sed -n 's/.*run-tests: \([^ ]*\): \(failed in the full run, passed alone\|failed again alone\|hung when rerun alone\|rerun alone stopped\|not rerun\|killed (exit [0-9]*) when rerun alone\).*/\1/p' | sort -u
}
# The ships held off the train on a guess, now that the train without them has a verdict. <files>: every file it was
# red on (train_failing): a held ship with one of its tests among them goes back in line (the guess was wrong), the
# others are refused (their tests passed without them). No files: it was green, so they are all refused.
train_settle() {
  local i f t red=" $* " again
  for ((i = 0; i < ${#held_n[@]}; i++)); do
    again=''
    for f in ${held_files[$i]//,/ }; do [[ $red != *" $f "* ]] || again=1; done
    t=${held_br[$i]}
    [[ ! $t =~ ^ticket/([0-9]+)- ]] || t="#${BASH_REMATCH[1]}"
    if [ -n "$again" ]; then
      say "$t goes back in line: the train was red again on ${held_files[$i]} without it, so the guess was wrong"
      rm -f "$train_dir/${held_n[$i]}"
    else
      say "$t is refused: the train without it passed ${held_files[$i]}"
      train_tell "${held_n[$i]}" "refused $branch ${held_run[$i]} likely ${held_files[$i]}" "${held_log[$i]}"
      train_refused+="${held_n[$i]} " train_refused_tips+=" ${held_was[$i]}"
    fi
  done
  train_release
}
# The held ships back in line as they were, with no verdict (and on any exit).
train_release() {
  local n v
  for n in "${held_n[@]}"; do read -r v _ 2>/dev/null <"$train_dir/$n" && [ "$v" = riding ] && rm -f "$train_dir/$n"; done
  held_n=() held_br=() held_was=() held_files=() held_run=() held_log=() train_held=' ' train_held_tips=''
}
train_suspects() {
  local round prev=' ' f m i t v kind line sure_line held_line pin real=() hits=() keep=() was=() chg=()
  local -A sus=() sure=()
  for ((round = 1; round <= 3; round++)); do
    mapfile -t real < <(train_real) || true
    if [ ${#real[@]} = 0 ]; then
      train_release
      say "suspects: CI's log doesn't say which tests really failed, so the bisect looks for the ship"
      return 1
    fi
    train_settle $(train_failing)
    for f in "${real[@]}"; do
      [[ $prev != *" $f "* ]] || { say "red again on $f with the likely causes off the train, so the guess was wrong: the bisect looks for the ship"; return 1; }
    done
    sus=() sure=()
    train_chg
    for f in "${real[@]}"; do
      pin=''
      if [ -z "$burn_red" ]; then # a burn-in red names the file a ship added or changed itself (#1443): no run alone
        say "suspects: running $f alone on the train's commits here to find the ship that turns it red"
        pin=$(train_pin "$f")
      fi
      if [ -n "$pin" ]; then
        hits=("$pin") sure[$pin]=1
      else
        mapfile -t hits < <(train_suspects_of "$f")
        [ -z "$burn_red" ] || for m in "${hits[@]}"; do sure[$m]=1; done
      fi
      if [ ${#hits[@]} = 0 ]; then
        say "suspects: no ship on the train touched $f or what it imports, so the bisect looks for the ship"
        return 1
      fi
      for m in "${hits[@]}"; do sus[$m]+="${sus[$m]:+, }$f"; done
    done
    if [ -n "${sus[0]:-}" ] && [ -z "${sure[0]:-}" ]; then
      say "suspects: $branch itself is only a guess from the files for ${sus[0]}, and it can't wait off its own train, so the bisect looks for the ship"
      return 1
    fi
    line='' v=''
    for m in $(printf '%s\n' "${!sus[@]}" | sort -n); do
      [ -z "${sure[$m]:-}" ] || continue
      t=${train_br[$((m - 1))]} && [[ ! $t =~ ^ticket/([0-9]+)- ]] || t="#${BASH_REMATCH[1]}"
      line+="${line:+, }$t" v+="${v:+, }${sus[$m]}"
    done
    if [[ $line == *,* ]]; then # a green run without them all couldn't tell which one did it
      say "suspects: the files name more than one ship ($line) for $(tr ' ' '\n' <<<"${v//, / }" | sort -u | paste -sd ' ' | sed 's/ /, /g'), tests perigee cannot fail alone, and a green run without them all could not tell which did it, so the bisect looks for the ship"
      return 1
    fi
    line='' sure_line='' held_line=''
    for m in $(printf '%s\n' "${!sus[@]}" | sort -n); do
      t=$(train_label "$m")
      line+="${line:+, }$t (${sus[$m]})"
      if [ -n "${sure[$m]:-}" ]; then sure_line+="${sure_line:+, }$t"; else held_line+="${held_line:+, }$t"; fi
    done
    say "suspects: $line: CI is red on the ship train ($ci_url) in those tests.${sure_line:+ Run alone here, they failed with $sure_line and passed on the train before it, so that is the cause: back to its minion with the failure.}${held_line:+ $held_line: perigee cannot fail those tests alone, so the files are only a guess: they wait off the train, and are refused only if it does better without them.} The next ships in line take their places"
    retro_log "ship train suspects · $label · $line${sure_line:+ · failed alone here: $sure_line} · $ci_url"
    prev+="${real[*]} "
    keep=()
    for ((i = 0; i < ${#train_n[@]}; i++)); do
      v=${sus[$((i + 1))]:-}
      if [ -z "$v" ]; then
        keep+=("${train_n[$i]}")
      elif [ -n "${sure[$((i + 1))]:-}" ]; then
        kind="likely ${v//, /,} pinned"; [ -z "$burn_red" ] || kind="burn ${v//, /,}"
        train_say "$i" "refused $branch $ci_url $kind" "$(tail -n 40 <<<"$failed")"
        train_refused+="${train_n[$i]} " train_refused_tips+=" ${train_was[$i]}"
      else
        held_n+=("${train_n[$i]}") held_br+=("${train_br[$i]}") held_was+=("${train_was[$i]}") held_files+=("${v//, /,}") held_run+=("$ci_url") held_log+=("$(tail -n 40 <<<"$failed")")
        train_held+="${train_n[$i]} " train_held_tips+=" ${train_was[$i]}"
      fi
    done
    if [ -n "${sus[0]:-}" ]; then # this one failed alone here: the others go back in line, and this one is refused below
      suspect_tests=${sus[0]}
      [ -n "$burn_red" ] || suspect_pinned=1
      train_release
      train_drop
      rc=1
      return 0
    fi
    queue_phase "testing the train again without its likely causes"
    was=("${train_n[@]}")
    train_tip=() train_br=() train_n=() train_was=()
    tip=$own short=$(git rev-parse --short "$own")
    train_build "${keep[@]}"
    top_say
    for t in "${was[@]}"; do # a rider the train no longer takes (it no longer rebases onto it, say): back in line
      [[ " ${train_n[*]} " != *" $t "* ]] && [[ $train_held != *" $t "* ]] && read -r v _ 2>/dev/null <"$train_dir/$t" && [ "$v" = riding ] && rm -f "$train_dir/$t"
    done
    rc=0
    gate "$tip" || rc=$?
    busy_gate
    [ "$rc" = 1 ] && [ ${#train_n[@]} -gt 0 ] && continue
    case $rc in
      0) train_settle ;;
      1) f=$(train_failing); if [ -z "$f" ]; then train_release; else train_settle $f; fi ;;
      *) train_release ;;
    esac
    return 0
  done
  f=$(train_failing)
  if [ -z "$f" ]; then train_release; else train_settle $f; fi
  say "still red after 3 rounds of suspects, so the bisect looks for the ship"
  return 1
}
# A red train: which ship turned it red, by bisecting its prefixes (each assumed green below the first red one). The
# green part ships, the first red ship is refused with its own failure, and the ships after it go back in line. This
# one's own commit red: the whole train goes back in line, and this one is refused as usual. A no-answer: the train
# goes back in line, and this one falls back on its own.
train_bisect() {
  local lo=-1 hi=${#train_n[@]} mid hf=$failed hu=$ci_url hr=$reran
  say "CI is red on the ship train ($ci_url): finding the first ship that turned it red"
  queue_phase "finding the ship that turned the train red"
  while [ $((hi - lo)) -gt 1 ]; do
    mid=$(((lo + hi) / 2))
    rc=0
    gate "$(train_at "$mid")" || rc=$?
    busy_gate "$(train_at "$mid")"
    if [ "$rc" = 2 ]; then return; fi
    if [ "$rc" = 0 ]; then lo=$mid; else hi=$mid hf=$failed hu=$ci_url hr=$reran; fi
  done
  failed=$hf ci_url=$hu reran=$hr
  if [ "$hi" = 0 ]; then
    say "the bisect found $branch itself red, so the ships behind it go back in line"
    train_drop
    rc=1
    return
  fi
  say "the bisect found ${train_br[$((hi - 1))]} the first ship that turned the train red ($hu): it is refused, and the ${lo} before it ship"
  retro_log "ship train red · $label · ${train_br[$((hi - 1))]} · $hu"
  train_say $((hi - 1)) "refused $branch $hu" "$(tail -n 40 <<<"$hf")"
  train_drop "$hi"
  train_tip=("${train_tip[@]:0:$((hi - 1))}") train_br=("${train_br[@]:0:$((hi - 1))}") train_n=("${train_n[@]:0:$((hi - 1))}") train_was=("${train_was[@]:0:$((hi - 1))}")
  tip=$(train_at "$lo") short=$(git rev-parse --short "$(train_at "$lo")") rc=0
  top_say
}

# The line and the lock go before the clean-up on GitHub (#553 M14): a hung gh or push held the lock up to 60 s more.
trap 'land_rc=$?; train_release; train_drop; top_done; land_timing $land_rc || true; queue_done; exec 9>&- 7>&- 6>&-; ci_done' EXIT
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
  # The train's retest and bisect wait the same way, on the commit they test (#1361).
  busy_gate() {
    local at=${1:-$tip}
    while [ "$rc" = 2 ] && ! quiet; do
      busy_wait "$why"
      sleep "$QUIET_POLL"
      rc=0
      gate "$at" || rc=$?
    done
  }
  train_build
  top_say
  early_gate
  gate "$tip" || rc=$?
  # A train keeps its riders while it waits (#1361): they go back only once the gate gives up for good, to run here.
  busy_gate
  [ "$rc" != 1 ] || [ ${#train_n[@]} = 0 ] || train_suspects || [ ${#train_n[@]} = 0 ] || train_bisect
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
  say "no tests and no CI: nothing in this change is read by a test or the server (tools/lanes)"
  tested=$tip
elif [ "$rc" = 0 ]; then
  ci_done
  tested=$tip # CI ran the commit and nothing else, so a stray file in this worktree was never part of it
elif [ "$rc" = 1 ]; then
  burn_said=$(burn_lines | paste -sd';' - | sed 's/;/; /g')
  [ -z "$suspect_tests" ] || [ -z "$burn_said" ] || refuse "a new or changed test failed its burn-in in CI on its ship train ($ci_url): $burn_said, in $suspect_tests, which $branch changed or which imports what it changed, so it is likely the cause: the ships behind it went back in line, so $untouched. A file that fails when run as copies at once is racy (its output is above): fix the race (a shared path, a fixed port, a timing assumption), not the wait, then run this again"
  [ -z "$suspect_pinned" ] || refuse "tests failed in CI on its ship train ($ci_url) in $suspect_tests, and run alone on perigee it passed on main and failed with $branch on it, so it is the cause: the ships behind it went back in line, so $untouched. Fix it, re-test, commit, then run this again"
  [ -z "$suspect_tests" ] || refuse "tests failed in CI on its ship train ($ci_url) in $suspect_tests, which $branch changed or which imports what it changed, so it is likely the cause (a guess from the files, not a bisect): the ships behind it went back in line, so $untouched. Look into it: fix it if it is yours, re-test, commit, then run this again"
  [ -z "$burn_said" ] || refuse "a new or changed test failed its burn-in in CI ($ci_url): $burn_said, so it never reached the full suite and $untouched. A file that fails when run as copies at once is racy (its output is above): fix the race (a shared path, a fixed port, a timing assumption), not the wait, then run this again. This is the ship's own red, never a known flake"
  [ -z "$reran" ] || flake_keep
  [ -z "$reran" ] || refuse "tests failed on the rebased branch in CI again ($ci_url), on the one fresh run after a red of flakes only ($reran), so $untouched. A second red refuses whatever its labels say"
  refuse "tests failed on the rebased branch in CI ($ci_url), so $untouched"
else
  ci_done
  fellback=$why
  say "=========================================================================="
  say "CI FALLBACK: $why. Running the full suite on perigee instead."
  say "BURN-IN SKIPPED: new and changed tests were not run as 10 copies at once, since that runs only on CI, never on perigee (#1443)"
  say "=========================================================================="
  retro_log "ci fallback · $branch · $why"
  say "running the tests"
  queue_phase "running the tests since $(date +%H:%M)"
  land_mark fallback fallback
  # A file the tests saw that isn't in the commit (never git-added, or ignored) means deploy.sh tests it again.
  [ -z "$(git status --porcelain --ignored)" ] && tested=$tip || tested=
  log="$state/land-test.log"
  trc=0
  # In citadel-heavy's slot on perigee (nice 19, idle IO) at half run-tests.sh's usual concurrency, so it yields (#1254).
  # Its CPU weight is the embedder's 20, not run-tests.sh's 500, so turns outrank it. A job that took the slot since
  # quiet() looked holds it up no longer than the busy limit's rest: then citadel-heavy gives up (75), and this refuses.
  half=$(( ( ($(nproc 2>/dev/null || echo 2) + 1) / 2 + 1) / 2 ))
  left=$((QUIET_LIMIT - $(busy_waited)))
  CITADEL_HEAVY_WHAT="land.sh's suite for $branch (CI fallback)" CITADEL_HEAVY_MAX_WAIT=${LAND_HEAVY_MAX_WAIT:-$((left > 60 ? left : 60))} \
    CITADEL_TEST_CONCURRENCY=${CITADEL_TEST_CONCURRENCY:-$half} DEPLOY_TEST_CPU_WEIGHT=${DEPLOY_TEST_CPU_WEIGHT-20} \
    "$tools/citadel-heavy" --here "$tools/run-tests.sh" "$log" 9>&- 6>&- || trc=$? # without the lock's fd: a run that outlives a killed land.sh must not hold it
  [ "$trc" != 75 ] || retry_in_place "perigee's heavy slot was taken"
  [ "$trc" != 75 ] || refuse "CI and perigee both busy, try again: CI: $why; perigee's heavy slot was taken just before the suite could start, and stayed taken (citadel-heavy's lines above), so no test ran. So $untouched"
  [ "$trc" != 3 ] || refuse "no test ran: the test run could not write its files (the run-tests line above says which), so $untouched"
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
  LAND_REBASED=1 LAND_REDO=1 LAND_BUILD=$build exec bash "$tools/land.sh" "${args[@]}"
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
trap 'land_rc=$?; train_release; train_drop; top_done; land_timing $land_rc || true; [ "$(head -n 1 "$state/moving" 2>/dev/null)" != "$old $tip" ] || rm -f "$state/moving"; queue_done; exec 9>&- 7>&- 6>&-; ci_done' EXIT
moved=1
git -C "$SOURCE" merge -q --ff-only "$tip" || refuse "could not fast-forward main to $branch; nothing landed"
say "main is now at $(git log -1 --format='%h "%s"' "$tip")"
[ -z "${known_by[$tip]:-}" ] || say "shipped past known flakes ${known_by[$tip]}"
if [ ${#train_n[@]} -gt 0 ]; then
  # Each rider moves its own branch (its worktree is its own) within a poll of the line, before the deploy writes the
  # release row, which finds each ship by its branch's tip (src/releases.ts landedIn).
  me=$(queue_proc $$)
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
early_next </dev/null & wait $! || say "early next train: it stopped part way (exit $?), so the next ship's CI waits for its turn"
queue_phase "deploying"
land_mark deploy deploy

if ! DEPLOY_LOCKED=1 DEPLOY_TESTED="$tested" DEPLOY_TIMES="$times" "$here/tools/deploy.sh" 6>&-; then
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
