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
# main and deploy once for them all. A red train first refuses the ships whose change touched its really failing tests
# (train_suspects, #1346) and runs again with the next ships in line in their places; failing that, it is bisected by
# its prefixes: the green part ships, the first ship that turned it red is refused with its own failure, and the ships
# after it stay in line. Each rider waits in line
# as before and reads its verdict from <state>/train/<its ticket> (train_verdict below). Off: LAND_TRAIN=0, or for
# every landing, touch <state>/train-off.
# A ship refused by the pipeline, not its change, keeps its ticket and rides the next train, once (retry_in_place, #1360).
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
    retro_log "timing · $label · line $(span "${t[start]}" "${t[lock]}") · rebase $(span "${t[lock]}" "${t[ci]}") · ci-queue $ciq · ci-run $cir · fallback $fb · deploy $(span "${t[deploy]}" "${t[queued]}") · live $live · $out"
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
early_check() {
  local out rc=0 files at
  out=$(numbers_git ours -c "attr.tree=$1" merge-tree --write-tree --name-only --no-messages ${under:+"--merge-base=$under"} "$1" HEAD 2>/dev/null) || rc=$?
  [ "$rc" = 1 ] || return 0
  files=$(sed -n '2,${/^$/q;p}' <<<"$out" | sort -u | sed ':a;N;$!ba;s/\n/, /g')
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
unset LAND_REBASED LAND_REDO LAND_BUILD LAND_RETRY_NOW LAND_RETRIED
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
#   refused <front> <the red CI run> [likely <tests>]   the bisect found it the first ship that turned the train red, or
#                                                with likely: the real failures in <tests> (comma-separated) map to its change (#1346); the
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
      rm -f "$f"
      [ "$at" = "$a" ] || { [ "$at" = "$d" ] && git reset -q --keep "$a"; } ||
        say "$branch moved after the train took it, so it stays as it is; what shipped of it is $(git rev-parse --short "$a")"
      say "shipped in $c's ship train of $e ships, with one CI run and one deploy for them all"
      say "main is now at $(git log -1 --format='%h "%s"' "$a"), in $c's ship train"
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
  git "$2" --abort 2>/dev/null || true # nothing to abort if it never started (an untracked file in the way)
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
    numbers_git ours rebase -q ${under:+--onto} main ${under:+"$under"} || conflict main rebase "the rebase onto main failed (see git's output above), so nothing landed" ;;
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
# #1377: a run cut off before any test failed gets the same one fresh run, and cut off again it is no answer.
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
# As the box's own gh login, like deploy.sh's push of main (#182), whoever's turn this is; never holding the lock.
hub() { env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 timeout 30 "$@" 9>&- 7>&- 6>&-; }
ci_slug='' ci_id='' ci_status='' ci_result='' ci_url='' ci_pushed='' why=''
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
retry_in_place() {
  [ -z "$retried" ] || { say "refused by the pipeline again ($1), after its one retry in place ($retried), so it is refused this time"; return 0; }
  [ "$mode" = land ] && [ -n "${DEPLOY_QUEUE_TICKET:-}" ] && [ -e "$DEPLOY_QUEUE_TICKET" ] || return 0
  say "refused by the pipeline ($1), not your change: keeping its place in line and riding the next train, once"
  train_drop
  ci_done
  retried=$1
  trap 'land_timing $? || true; queue_done' EXIT
  queue_wait_check() { train_verdict || true; }
  flock -u 9
  QUEUE_KEEP=$DEPLOY_QUEUE_TICKET QUEUE_YIELD=yield queue_lock "$state" "$branch" || { land_timing 1; exit 1; }
  unset -f queue_wait_check
  train_verdict held
  say "back at the front after its retry in place: starting over from the rebase"
  LAND_REBASED=1 LAND_RETRY_NOW=1 LAND_RETRIED=$retried exec bash "$tools/land.sh" "${args[@]}"
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
  [ -z "$ci_pushed" ] || hub git push -q "$REMOTE" ":refs/heads/$CI_REF" >/dev/null 2>&1 || true
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
  local url online='' online_at='' step stale='' started=$SECONDS waited ci_taken='' taken_at='' nap down n told='' limit=$CI_LIMIT rerun_wait='' ran
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
    # Forced on purpose: land/<branch> is a scratch branch only this script writes and deletes, so there is no one's work to overwrite.
    hub git push -q "$REMOTE" "+$tip:refs/heads/$CI_REF" 2>"$state/ci.err" || { why="pushing $short to GitHub failed$(ci_said)"; return 2; }
  fi
  say "waiting for CI on $short: the full suite on Cara's desktop (up to $((CI_START_ONLINE / 60)) min for a runner to start it while one is online, then at most $((CI_LIMIT / 60)) min for the run; past that it runs here once perigee is quiet)"
  queue_phase "waiting for CI since $(date +%H:%M)"
  while :; do
    ci_run || true # one missed answer is not a verdict: the limits below end the wait
    [ "$ci_id" != "$stale" ] || ci_id='' ci_status=''
    if [ -z "$ci_taken" ] && { [ "$ci_status" = in_progress ] || [ "$ci_status" = completed ]; }; then # a runner took it
      ci_taken=1 taken_at=$SECONDS
      land_mark cirun
      [ "$ci_status" = completed ] || queue_phase "waiting for CI: running since $(date +%H:%M)"
    fi
    [ "$ci_status" != completed ] || break
    waited=$((SECONDS - started))
    # Past a limit the suite runs here, but only on a quiet perigee: until then this keeps waiting for the run (busy_wait).
    why='' down=''
    if [ -n "$ci_taken" ]; then
      ran=$((SECONDS - taken_at))
      if [ "$ran" -ge "$limit" ]; then
        if [ -z "$rerun_wait" ] && ci_rerunning; then
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
  while read -r f load; do
    retro_log "flake · $f · load $load · $branch · in CI"
    say "flake: $f · in CI" # the server counts these (src/flakes.ts)
  done < <(sed -n 's/.*run-tests: \(.*\): failed in the full run, passed alone.*load \([0-9.]*\)).*/\1 \2/p' <<<"$failed")
}
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
cut_off() {
  grep -qE '(^|[[:space:]])Interrupted while running:' <<<"$failed" && ! grep -qF '✖ failing tests:' <<<"$failed" && ! grep -qF 'run-tests: the tests ran past' <<<"$failed"
}

# The ship train (#1166), the front's side: up to LAND_TRAIN_MAX plain lands waiting behind this one, in line order,
# each replayed onto the one before it in a scratch worktree, so CI runs once on the top. Its riders: own=this ship's
# commit, then train_tip, train_br, train_n (its ticket), train_was (its tip as the train took it). Not for a ship
# with no CI to answer (one ship's fallback run is all perigee should take on), nor while deploys are refusing or
# rolled back. A waiter is passed over, and keeps its place, when it changes the pipeline (tools/pipeline-files.txt:
# those land alone), has merge commits, sits on a commit that came off main, conflicts with the train, or fails the
# undo guard against it.
own=$tip train_tip=() train_br=() train_n=() train_was=() greens=' '
# <from> <to>: whether the change touches a path in tools/pipeline-files.txt (a path ending / is its folder).
pipeline_touch() {
  [ -f tools/pipeline-files.txt ] || return 1
  awk 'NR == FNR { if ($0 !~ /^[[:space:]]*(#|$)/) p[++n] = $0; next }
    { for (i = 1; i <= n; i++) if ($0 == p[i] || (p[i] ~ /\/$/ && index($0, p[i]) == 1)) { hit = 1; exit } }
    END { exit !hit }' tools/pipeline-files.txt <(git diff --no-renames --name-only "$1" "$2")
}
# <rider index> <lines>: its verdict, by a rename, so it never reads half of one.
train_say() {
  local f=$train_dir/${train_n[$1]}
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
  train_say "$1" "landed ${train_tip[$1]} $kind $branch ${train_was[$1]} $((${#train_n[@]} + 1))"
}
# "<commit> <branch>" of each ship in the train but the top one, which is "$tip $train_owner": what came off main with
# it when main goes back (taken-back), so each branch on its train commit leaves the others' commits behind.
train_others() {
  local i
  [ ${#train_n[@]} -gt 0 ] || return 0
  echo "$own $branch"
  for ((i = 0; i + 1 < ${#train_n[@]}; i++)); do echo "${train_tip[$i]} ${train_br[$i]}"; done
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
    [[ $train_refused != *" ${t##*/} "* ]] || continue # refused as a suspect, though its rider already read the verdict
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
    for x in $train_refused_tips; do
      [ -z "$skip" ] && git merge-base --is-ancestor "$x" "$r" 2>/dev/null || continue
      skip="it sits on a ship this train just refused"
    done
    if [ -z "$skip" ]; then
      if [ -z "$wt" ]; then
        wt=$(mktemp -d "${TMPDIR:-/tmp}/land-train.XXXXXX") && git worktree add -q --detach "$wt" "$cur" 2>/dev/null || { say "ship train: couldn't make a scratch worktree, so this ships alone"; wt=''; break; }
      fi
      if git -C "$wt" checkout -q --detach "$r" 2>/dev/null && git -C "$wt" rebase -q --onto "$cur" "$base" >/dev/null 2>&1; then
        c=$(git -C "$wt" rev-parse HEAD)
        if [ "$c" = "$cur" ]; then skip="main already has all of it"
        elif pipeline_touch "$cur" "$c"; then skip="it changes the ship pipeline, which ships alone"
        elif ! (cd "$wt" && branch=$b && undo_guard "$cur") >/dev/null 2>&1; then skip="the undo guard stops it on the train"
        fi
      else
        git -C "$wt" rebase --abort >/dev/null 2>&1 || true
        skip="it doesn't rebase cleanly onto the train"
      fi
    fi
    if [ -n "$skip" ]; then say "ship train: $b stays in line ($skip)"; continue; fi
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
  tip=$1 short=$(git rev-parse --short "$1") failed='' reran=''
  ci_gate || rc=$?
  # One fresh run, never more, for a red of flakes only (#769). The scratch branch goes first so the push starts a new
  # run (pushing a commit a branch already has starts none); ci_gate then passes over the red one as stale, so it is
  # never read as the answer. A no-answer this time falls back to the run here, which must be green too. If the branch
  # won't go, there is no fresh run: it stays a red, rather than a wait for a run never started read as CI being down.
  # A run cut off before any test failed (#1377) gets the same one fresh run; cut off again, it is no answer.
  local cut=''
  if [ "$rc" = 1 ]; then
    ci_failed
    if cut_off; then
      cut=$ci_url
    elif ! reran=$(flake_only); then
      reran=''
    fi
    if [ -z "$cut$reran" ]; then
      :
    elif ! hub git push -q "$REMOTE" ":refs/heads/$CI_REF" 2>"$state/ci.err"; then
      if [ -n "$cut" ]; then
        why="the CI run was cut off before any test failed ($cut), and deleting $CI_REF on GitHub to start a fresh run failed$(ci_said)"
        retro_log "cut-off rerun · $branch · $cut · not started"
        rc=2
      else
        say "only flakes failed ($reran), but deleting $CI_REF on GitHub to start a fresh run failed$(ci_said), so this stays red"
        retro_log "flake rerun · $branch · $reran · not started"
        reran=''
      fi
    else
      if [ -n "$cut" ]; then say "the CI run on $short was cut off before any test failed ($cut), so it says nothing about this commit: running CI once more"
      else say "only flakes failed ($reran); running CI once more on $short, the land needs a fully green run"; fi
      ci_id='' ci_pushed=''
      rc=0
      ci_gate || rc=$?
      if [ "$rc" = 1 ]; then
        ci_failed
        ! cut_off || { why="CI was cut off twice before any test failed ($cut, $ci_url)"; [ -n "$cut" ] || why="CI's one fresh run after a red of flakes only ($reran) was cut off before any test failed ($ci_url)"; rc=2; }
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
# flakes) are pinned on the ships whose change touched each failing test file; failing that, a file it imports by a
# relative path or names by its path; failing that, a file those import. If every real failure has a suspect, the
# suspects are refused with the failure, and the train is built again from the others plus the next ships in line, for
# one more CI run. Red again on any of the same tests: the guess was wrong, and the bisect takes over on that train. Red
# on new tests only: another round, up to 3. 0: done (rc as gate's, 1 only for this one alone or a suspect itself), 1:
# the bisect looks, on the train as it now is (its top red, its log in $failed).
suspect_tests='' train_refused=' ' train_refused_tips=''
# The real failures in $failed, one test file a line: those that failed again alone, hung, or whose rerun stopped at
# CI's deadline. A file not rerun may be load or real, so it names no suspect: if it is real, the refilled train is red
# on it, and the next round sees it. Fails when there are none, or the log doesn't label every failed file.
train_real() {
  local at n out
  at=$(grep -n 'run-tests: [0-9][0-9]* test file(s) failed; rerunning each alone' <<<"$failed" | tail -n 1 | cut -d: -f1)
  [[ $at =~ ^[0-9]+$ ]] || return 1
  n=$(sed -n "${at}s/.*run-tests: \\([0-9][0-9]*\\) test file(s) failed.*/\\1/p" <<<"$failed")
  out=$(tail -n "+$at" <<<"$failed" | sed -n 's/.*run-tests: \([^ ]*\): \(failed in the full run, passed alone\|failed again alone\|hung when rerun alone\|rerun alone stopped\|not rerun\).*/\2 \1/p' | sort -u -k2)
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
train_suspects() {
  local round prev=' ' f m i t v line real=() hits=() keep=() was=() chg=()
  local -A sus=()
  for ((round = 1; round <= 3; round++)); do
    mapfile -t real < <(train_real) || true
    if [ ${#real[@]} = 0 ]; then
      say "suspects: CI's log doesn't say which tests really failed, so the bisect looks for the ship"
      return 1
    fi
    for f in "${real[@]}"; do
      [[ $prev != *" $f "* ]] || { say "red again on $f with the likely causes off the train, so the guess was wrong: the bisect looks for the ship"; return 1; }
    done
    chg=() sus=()
    for ((m = 0; m <= ${#train_n[@]}; m++)); do
      if [ "$m" = 0 ]; then chg[0]=$(git diff --no-renames --name-only "$old" "$own"); else chg[m]=$(git diff --no-renames --name-only "$(train_at $((m - 1)))" "$(train_at "$m")"); fi
    done
    for f in "${real[@]}"; do
      mapfile -t hits < <(train_suspects_of "$f")
      if [ ${#hits[@]} = 0 ]; then
        say "suspects: no ship on the train touched $f or what it imports, so the bisect looks for the ship"
        return 1
      fi
      for m in "${hits[@]}"; do sus[$m]+="${sus[$m]:+, }$f"; done
    done
    line=''
    for m in $(printf '%s\n' "${!sus[@]}" | sort -n); do
      if [ "$m" = 0 ]; then t=$branch; else t=${train_br[$((m - 1))]}; fi
      [[ ! $t =~ ^ticket/([0-9]+)- ]] || t="#${BASH_REMATCH[1]}"
      line+="${line:+, }$t (${sus[$m]})"
    done
    say "suspects: $line: CI is red on the ship train ($ci_url) in tests only their changes touched, so they are likely the cause: they go back to their minions with the failure, and the next ships in line take their places"
    retro_log "ship train suspects · $label · $line · $ci_url"
    prev+="${real[*]} "
    keep=()
    for ((i = 0; i < ${#train_n[@]}; i++)); do
      if [ -n "${sus[$((i + 1))]:-}" ]; then
        v=${sus[$((i + 1))]}
        train_say "$i" "refused $branch $ci_url likely ${v//, /,}" "$(tail -n 40 <<<"$failed")"
        train_refused+="${train_n[$i]} " train_refused_tips+=" ${train_was[$i]}"
      else keep+=("${train_n[$i]}"); fi
    done
    if [ -n "${sus[0]:-}" ]; then # this one is a suspect too: the others go back in line, and this one is refused below
      suspect_tests=${sus[0]}
      train_drop
      rc=1
      return 0
    fi
    queue_phase "testing the train again without its likely causes"
    was=("${train_n[@]}")
    train_tip=() train_br=() train_n=() train_was=()
    tip=$own short=$(git rev-parse --short "$own")
    train_build "${keep[@]}"
    for t in "${was[@]}"; do # a rider the train no longer takes (it no longer rebases onto it, say): back in line
      [[ " ${train_n[*]} " != *" $t "* ]] && read -r v _ 2>/dev/null <"$train_dir/$t" && [ "$v" = riding ] && rm -f "$train_dir/$t"
    done
    rc=0
    gate "$tip" || rc=$?
    busy_gate
    [ "$rc" = 1 ] && [ ${#train_n[@]} -gt 0 ] || return 0
  done
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
}

# The line and the lock go before the clean-up on GitHub (#553 M14): a hung gh or push held the lock up to 60 s more.
trap 'land_rc=$?; train_drop; land_timing $land_rc || true; queue_done; exec 9>&- 7>&- 6>&-; ci_done' EXIT
fellback=
rc=0
failed=''
reran=''
land_mark ci ci
if [ "$lane" = light ]; then
  rc=light
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
  gate "$tip" || rc=$?
  # A train keeps its riders while it waits (#1361): they go back only once the gate gives up for good, to run here.
  busy_gate
  [ "$rc" != 1 ] || [ ${#train_n[@]} = 0 ] || train_suspects || [ ${#train_n[@]} = 0 ] || train_bisect
  if [ "$rc" = 2 ] && [ ${#train_n[@]} -gt 0 ]; then
    say "the ship train goes back in line, since CI gave no answer ($why): $branch goes on alone"
    train_drop
    tip=$own short=$(git rev-parse --short "$own")
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
  [ -z "$suspect_tests" ] || refuse "tests failed in CI on its ship train ($ci_url) in $suspect_tests, which $branch changed or which imports what it changed, so it is likely the cause (a guess from the files, not a bisect): the ships behind it went back in line, so $untouched. Look into it: fix it if it is yours, re-test, commit, then run this again"
  [ -z "$reran" ] || refuse "tests failed on the rebased branch in CI again ($ci_url), on the one fresh run after a red of flakes only ($reran), so $untouched. A second red refuses whatever its labels say"
  refuse "tests failed on the rebased branch in CI ($ci_url), so $untouched"
else
  ci_done
  fellback=$why
  say "=========================================================================="
  say "CI FALLBACK: $why. Running the full suite on perigee instead."
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
    ! flakes=$(flake_only) || retry_in_place "only flakes failed on perigee: $flakes"
    refuse "tests failed on the rebased branch (full log: $kept), so $untouched"
  fi
fi
if [ "$mode" = full ]; then
  [ -z "$fellback" ] || say "merged on perigee's own test run, not CI: $fellback"
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
trap 'land_rc=$?; train_drop; land_timing $land_rc || true; [ "$(head -n 1 "$state/moving" 2>/dev/null)" != "$old $tip" ] || rm -f "$state/moving"; queue_done; exec 9>&- 7>&- 6>&-; ci_done' EXIT
moved=1
git -C "$SOURCE" merge -q --ff-only "$tip" || refuse "could not fast-forward main to $branch; nothing landed"
say "main is now at $(git log -1 --format='%h "%s"' "$tip")"
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
