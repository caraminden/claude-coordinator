#!/usr/bin/env bash
# Land a minion's branch: run it from the minion's worktree once its work is committed.
#   tools/land.sh
# Under the deploy lock (the one tools/deploy.sh takes), so landings and deploys go one at a time, in the
# order they asked (tools/deploy-queue.sh): it says its place in line, and waits as long as the line moves.
# The restart the landing before it queued may still be running: steps 1 and 2 go on beside it, and steps 3 and 4
# wait for its verdict (the restart lock, #566). If that restart was rolled back and its commit came off main,
# steps 1 and 2 are done again without it.
# 1. Rebases the branch onto the local main. A conflict aborts the rebase and stops here. If the rebase
#    changed land.sh itself, the rebased copy takes over from here, still holding the lock.
# 2. Needs the full suite green on the rebased commit, with main untouched otherwise. Cara's desktop runs it
#    (.github/workflows/tests.yml) and this waits for that run; when CI can't answer it says CI FALLBACK and runs
#    the suite here (tools/run-tests.sh). See "The gate" below. The run here is not in a citadel-heavy slot: the
#    deploy lock already lets only one landing test at a time, and waiting on a slot other schemes' builds can
#    hold for an hour, while holding the lock, starved every other landing (#499).
# 3. Fast-forwards main in the scheme repo to the branch.
# 4. Runs tools/deploy.sh (it inherits the lock, and skips its own test run when the live checkout
#    lands on the commit that just passed). If that deploys nothing because a check failed and
#    the live checkout went back, main goes back too, so main only ever holds what passed.
# For a restart that cuts off running turns (only with a person's OK), land first, then run
# tools/deploy.sh --now: it joins the restart this one queued.
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
  [ -e "$dir/land.md" ] || printf '%s\n\n' '# Retro log: land.sh' 'Written by tools/land.sh, tools/run-tests.sh and the queued restart in tools/deploy.sh (no session id, so one file per day). One line per rebase conflict, per landing that fell back from CI to the suite on perigee, and per test file that failed in a land or deploy run and passed alone (flake). Phase times in whole seconds (#565), - for a phase never reached: a `timing` line per landing that got in line, landed or not (line: waiting for the deploy lock; rebase; ci-queue: until a runner took the job; ci-run; fallback: the wait for a CI that gave no answer + the suite on perigee; deploy: pull, boot check and tests if any, until the restart was queued or the front end reloaded; live: from then until the deploy saw it live, the restart'"'"'s settle check included), and a `restart` line per queued restart (idle-wait: for the turns it would cut off and the lock; backup: the database copy; healthy: restart to the first healthy answer; settle: the check after it).' >>"$dir/land.md"
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
  if [ -n "${t[landed]}" ]; then out=landed; [ -n "${t[live]}" ] || out="landed, not live yet"
  elif [ "$rc" = 1 ]; then out="refused at $phase"
  else out="stopped at $phase"; [ "$rc" = 0 ] || out="$out (exit $rc)"; fi # a kill before the signal traps can end it with 0
  if [ -n "${t[live]}" ]; then live=$((${t[live]} - ${t[queued]:-${t[live]}})); else live=-; fi
  retro_log "timing · $branch · line $(span "${t[start]}" "${t[lock]}") · rebase $(span "${t[lock]}" "${t[ci]}") · ci-queue $ciq · ci-run $cir · fallback $fb · deploy $(span "${t[deploy]}" "${t[queued]}") · live $live · $out"
  rm -f "$times"
) >/dev/null 2>&1

# A turn in its person's Claude container (#213) has no deploy lock, user bus or GitHub login here.
[ "${COORDINATOR_CONTAINER:-}" != 1 ] || refuse "this turn runs in a container: call the land tool (mcp__thread) instead, which runs land.sh on the host"
# Inside a slot it would hold a heavy slot, shared by every scheme, while it waits on the deploy lock.
[ -z "${CITADEL_HEAVY_HELD:-}" ] || refuse "run it on its own, not under citadel-heavy: it would hold a heavy slot other schemes need while it waits for the deploy lock"
[ $# -eq 0 ] || refuse "takes no arguments (for --now, land first, then run tools/deploy.sh --now with a person's OK)"
tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) # before the cd below, which would break a relative path to it
self=$(stat -c %d:%i "$tools/land.sh") # which file bash is reading; the rebase below may replace it
here=$(git rev-parse --show-toplevel)
cd "$here" # the tests run from the worktree's top, wherever in it this was started
branch=$(git branch --show-current)
{ [ -n "$branch" ] && [ "$branch" != main ]; } || refuse "run it from a minion's branch, not main or a detached HEAD"
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "$here has uncommitted changes: commit them first"

state=$(git -C "$LIVE" rev-parse --absolute-git-dir)/cc-deploy
mkdir -p -m 700 "$state"
# LAND_REBASED: this is the rebased land.sh, started below by the one that rebased, and it holds the lock on fd 9.
# LAND_REDO with it: main went back while this waited for the restart ahead, so this starts over, once (1: the rebase
# is still to do; 2: done, by the copy that started this one).
resumed= redo=
[ -n "${LAND_REBASED:-}" ] && [ /dev/fd/9 -ef "$state/lock" ] && resumed=1 redo=${LAND_REDO:-}
unset LAND_REBASED LAND_REDO
quiet=$resumed
[ "$redo" != 1 ] || quiet=
times=$state/times-$$ # the same in the rebased copy, which is this process
if [ -z "$resumed" ]; then
  rm -f "$times" # what a killed landing with this pid left
  land_mark start line
fi
# shellcheck source=tools/deploy-queue.sh
. "$tools/deploy-queue.sh"
# The rebased copy is the same process, so the ticket it was started with (none, from a land.sh older than the
# line) still names it; only the trap that removes it at the end has to be set again.
if [ -z "$resumed" ]; then
  queue_lock "$state" "$branch" || { land_timing 1; exit 1; }
  land_mark lock rebase
fi
trap 'land_timing $? || true; queue_done' EXIT
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

old=$(git -C "$SOURCE" rev-parse main)
# A commit that came off main again (its restart was rolled back) while this branch was already rebased onto it
# (#566: the gate runs beside that restart) is still under this branch, and a plain rebase would carry it back onto
# main. It is left behind, unless it is this branch's own.
under=
while read -r t b; do
  [ "$b" != "$branch" ] && git merge-base --is-ancestor "$t" HEAD 2>/dev/null && ! git merge-base --is-ancestor "$t" main 2>/dev/null || continue
  { [ -n "$under" ] && git merge-base --is-ancestor "$t" "$under"; } || under=$t
done < <(cat "$state/taken-back" 2>/dev/null || true)
[ -z "$under" ] || say "$branch sits on $(git log -1 --format='%h "%s"' "$under"), which came off main when its deploy was rolled back: leaving it behind"
[ -n "$quiet" ] || queue_phase "rebasing onto main"
[ -n "$quiet" ] || say "rebasing $branch onto main ($(git log -1 --format='%h "%s"' main))"
if ! git rebase -q ${under:+--onto} main ${under:+"$under"}; then
  # Which files collide is worth a retro-log line (the architecture check counts them).
  conflicted=$(git diff --name-only --diff-filter=U 2>/dev/null | sed ':a;N;$!ba;s/\n/, /g' || true)
  if [ -n "$conflicted" ]; then what=" onto $(git log -1 --format=%h main): $conflicted"; else what=": no conflicted files found (the rebase may not have started)"; fi
  retro_log "land conflict · $branch$what"
  git rebase --abort 2>/dev/null || true # nothing to abort if it never started (an untracked file in the way)
  refuse "the rebase onto main failed (see git's output above), so nothing landed${conflicted:+; conflicted files: $conflicted}. On conflicts: run git rebase ${under:+--onto }main${under:+ $(git rev-parse --short "$under")}, resolve them keeping the other minions' changes, re-test, commit, then run this again"
fi
# Bash goes on reading the file it started from, so a rebase that replaced land.sh would land with the old one (#500):
# go on in the rebased one instead. It keeps the lock on fd 9, and its own rebase finds nothing to do.
[ -n "$quiet" ] || [ "$(stat -c %d:%i "$tools/land.sh")" = "$self" ] || LAND_REBASED=1 LAND_REDO=${redo:+2} exec bash "$tools/land.sh"

# <state>/bad: "<commit> <last-good> <when> <what it restarted on>", left by the restart that rolled <commit>'s deploy back (tools/deploy.sh).
# While main still holds that commit every deploy pulls it in again and is rolled back too (#553), so only its fix
# may land: a branch that changes a file that deploy changed, or one the lander vouches for with LAND_FIX=1.
bad_check() {
  local bad good rest
  [ -s "$state/bad" ] || return 0
  read -r bad good rest <"$state/bad" || true
  git -C "$SOURCE" merge-base --is-ancestor "$bad" main 2>/dev/null || { rm -f "$state/bad"; return 0; }
  [ -z "${LAND_FIX:-}" ] || return 0
  ! comm -12 <(git diff --name-only "$good" "$bad" | sort) <(git diff --name-only main HEAD | sort) | grep -q . || return 0
  refuse "main holds $(git log -1 --format='%h "%s"' "$bad"), whose deploy was rolled back (the restart on it failed: its report is in the chat of the minion that deployed it), and $branch changes none of the files that deploy changed, so its deploy would be rolled back too. Nothing landed. Land the fix for it first (or its revert); if $branch is that fix, run LAND_FIX=1 tools/land.sh (the land tool can't pass it: from a turn in a container, ask the Taskmaster or a person to run that in $PWD)"
}
bad_check

# The gate (#523): the full suite, green on this exact commit. Cara's desktop runs it (.github/workflows/tests.yml, on
# the Linux runner in WSL) so perigee doesn't: the commit goes to a scratch branch land/<branch> on GitHub, and this
# waits for that run, still holding the lock. Landings are one at a time whatever the lock does (the one behind
# can't know its commit until this one moves main), so letting go of it would speed nobody up. The wait is bounded
# instead: no runner online, GitHub not answering, a job no runner starts within LAND_CI_START seconds or a run not
# done within LAND_CI_TIMEOUT all fall back, loudly, to the run on perigee (also LAND_CI=0, for when CI itself is
# broken). A red run is red: it refuses, and never falls back.
tip=$(git rev-parse HEAD)
short=$(git rev-parse --short HEAD)
REMOTE=${DEPLOY_REMOTE-origin}
CI_WORKFLOW=.github/workflows/tests.yml
CI_LABEL=citadel-ci-linux
CI_REF=land/$branch
CI_STEP='the full suite' # the workflow's step that runs the tests; a run that fails in any other never ran them
CI_DOWN=${LAND_CI_DOWN:-600} # how long one landing's unanswered wait for CI spares the next ones theirs
CI_START=${LAND_CI_START:-90} CI_LIMIT=${LAND_CI_TIMEOUT:-360} CI_POLL=${LAND_CI_POLL:-5}
# As the box's own gh login, like deploy.sh's push of main (#182), whoever's turn this is; never holding the lock.
hub() { env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 timeout 30 "$@" 9>&- 7>&-; }
ci_slug='' ci_id='' ci_status='' ci_result='' ci_url='' ci_pushed='' why=''
# The newest run of the workflow on this commit, into ci_*; nothing when there is none. Fails when GitHub doesn't answer.
ci_run() {
  local run
  run=$(hub gh api "repos/$ci_slug/actions/runs?head_sha=$tip&per_page=20" --jq "[.workflow_runs[] | select(.path | startswith(\"$CI_WORKFLOW\"))][0] // empty | [.id, .status, .conclusion // \"-\", .html_url] | @tsv" 2>/dev/null) || return 1
  read -r ci_id ci_status ci_result ci_url <<<"$run" || true
}
# Leaves nothing behind on GitHub: a run nobody waits for is cancelled, and the scratch branch goes.
ci_done() {
  [ -z "$ci_id" ] || [ "$ci_status" = completed ] || hub gh api -X POST "repos/$ci_slug/actions/runs/$ci_id/cancel" >/dev/null 2>&1 || true
  [ -z "$ci_pushed" ] || hub git push -q "$REMOTE" ":refs/heads/$CI_REF" >/dev/null 2>&1 || true
  ci_id='' ci_pushed=''
}
ci_down() { printf '%s %s\n' "$(date +%s)" "$why" >"$state/ci-down" 2>/dev/null || true; }
# 0: green on this commit. 1: red. 2: no answer, with the reason in $why.
ci_gate() {
  local url online step stale='' started=$SECONDS waited ci_taken=''
  [ "${LAND_CI:-1}" != 0 ] || { why="LAND_CI=0 was set"; return 2; }
  { [ -n "$REMOTE" ] && url=$(git remote get-url "$REMOTE" 2>/dev/null); } || { why="this repo has no ${REMOTE:-GitHub} remote"; return 2; }
  ci_slug=${url#*github.com[:/]} ci_slug=${ci_slug%.git}
  # A CI outage is paid once (#553): a landing that waited out a limit leaves a note, and those of the next minutes
  # go straight to the run here instead of each waiting to learn the same thing.
  local down_at='' down_why='' now
  now=$(date +%s)
  read -r down_at down_why 2>/dev/null <"$state/ci-down" || true
  if [[ $down_at =~ ^[0-9]+$ ]] && [ $((now - down_at)) -lt "$CI_DOWN" ]; then
    why="CI gave no answer to a landing $((now - down_at)) s ago ($down_why), so this one doesn't wait for it (it is asked again from $(date -d "@$((down_at + CI_DOWN))" +%H:%M))"
    return 2
  fi
  ci_run || { why="GitHub didn't answer"; return 2; }
  # A run of this commit that is green or still going (a landing stopped and started again) will do; otherwise a new one.
  if [ -z "$ci_id" ] || { [ "$ci_status" = completed ] && [ "$ci_result" != success ]; }; then
    stale=$ci_id ci_id=''
    # shortcut: with the repo variable CI_RUNNER=github (hosted runners) this finds no runner and falls back; look at the variable too if that is ever used for long.
    online=$(hub gh api "repos/$ci_slug/actions/runners" --jq "[.runners[] | select(.status == \"online\" and any(.labels[]; .name == \"$CI_LABEL\"))] | length" 2>/dev/null) || { why="GitHub didn't say which runners are online"; return 2; }
    [ "$online" -gt 0 ] 2>/dev/null || { why="no $CI_LABEL runner is online (they run only while Cara is logged on to her desktop)"; return 2; }
    ci_pushed=1
    # Forced on purpose: land/<branch> is a scratch branch only this script writes and deletes, so there is no one's work to overwrite.
    hub git push -q "$REMOTE" "+$tip:refs/heads/$CI_REF" 2>/dev/null || { why="pushing $short to GitHub failed"; return 2; }
  fi
  say "waiting for CI on $short: the full suite on Cara's desktop (at most $((CI_LIMIT / 60)) min, then it runs here)"
  queue_phase "waiting for CI since $(date +%H:%M)"
  while :; do
    ci_run || true # one missed answer is not a verdict: the limits below end the wait
    [ "$ci_id" != "$stale" ] || ci_id='' ci_status=''
    if [ -z "$ci_taken" ] && { [ "$ci_status" = in_progress ] || [ "$ci_status" = completed ]; }; then ci_taken=1; land_mark cirun; fi # a runner took it
    [ "$ci_status" != completed ] || break
    waited=$((SECONDS - started))
    if [ "$ci_status" != in_progress ] && [ "$waited" -ge "$CI_START" ]; then why="no runner started the job within ${CI_START}s"; ci_down; return 2; fi
    if [ "$waited" -ge "$CI_LIMIT" ]; then why="CI didn't finish within ${CI_LIMIT}s"; ci_down; return 2; fi
    sleep "$CI_POLL"
  done
  case $ci_result in
    success) rm -f "$state/ci-down"; say "CI passed on $short in $((SECONDS - started))s ($ci_url)" ;;
    failure)
      # Red only when the tests ran: a run that failed setting up (no user manager, a download) says nothing about this commit.
      step=$(hub gh api "repos/$ci_slug/actions/runs/$ci_id/jobs" --jq '[.jobs[].steps[] | select(.conclusion == "failure") | .name][0] // empty' 2>/dev/null) || step=''
      [ "${step:-$CI_STEP}" = "$CI_STEP" ] || { why="the CI run failed in its setup step \"$step\", before any test ran ($ci_url): the runner needs fixing"; return 2; }
      return 1 ;;
    timed_out) return 1 ;;
    *) why="the CI run ended as $ci_result, not as a verdict on the tests"; return 2 ;;
  esac
}

trap 'land_timing $? || true; ci_done; queue_done' EXIT
fellback=
rc=0
land_mark ci ci
ci_gate || rc=$?
land_mark gate
if [ "$rc" = 0 ]; then
  ci_done
  tested=$tip # CI ran the commit and nothing else, so a stray file in this worktree was never part of it
elif [ "$rc" = 1 ]; then
  failed=$(hub gh run view "$ci_id" --repo "$ci_slug" --log-failed 2>/dev/null) || true
  tail -n 40 <<<"$failed" >&2
  # run-tests.sh's flake lines can't reach the retro log from the desktop, so they are written from its output here.
  while read -r f load; do
    retro_log "flake · $f · load $load · $branch · in CI"
  done < <(sed -n 's/.*run-tests: \(.*\): failed in the full run, passed alone.*load \([0-9.]*\)).*/\1 \2/p' <<<"$failed")
  refuse "tests failed on the rebased branch in CI ($ci_url), so main is untouched"
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
  if ! "$tools/run-tests.sh" "$log" 9>&-; then # without the lock's fd: a run that outlives a killed land.sh must not hold it
    tail -n 40 "$log" >&2
    refuse "tests failed on the rebased branch (full log: $log), so main is untouched"
  fi
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
  flock -u 7
  exec 7>&-
  LAND_REBASED=1 LAND_REDO=1 exec bash "$tools/land.sh"
fi

# Only when the live checkout doesn't have it (a failed check or a rolled-back restart put it back, or it never pulled): main follows, unless it moved on since.
moved=
main_back() {
  [ -n "$moved" ] || return 0
  # A deploy killed outright never put the checkout back; only with the lock, which a deploy that got as far as queuing its restart has let go of.
  # Nor beside a restart being judged on that checkout (#566): then the next landing does it, with both locks.
  ! flock -n 9 2>/dev/null || ! flock -n 7 2>/dev/null || deploy_unchecked_back "$state" "$LIVE"
  git -C "$LIVE" merge-base --is-ancestor "$tip" HEAD 2>/dev/null && return 0
  if [ "$(git -C "$SOURCE" rev-parse main)" = "$tip" ]; then
    taken_back "$state" "$tip" "$branch" # first: the landing behind looks for it the moment main goes back
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
printf '%s\n' "$old $tip" "$branch" >"$state/moving"
trap 'land_timing $? || true; [ "$(head -n 1 "$state/moving" 2>/dev/null)" != "$old $tip" ] || rm -f "$state/moving"; ci_done; queue_done' EXIT
moved=1
git -C "$SOURCE" merge -q --ff-only "$tip" || refuse "could not fast-forward main to $branch; nothing landed"
say "main is now at $(git log -1 --format='%h "%s"' "$tip")"
queue_phase "deploying"
land_mark deploy deploy

if ! DEPLOY_LOCKED=1 DEPLOY_TESTED="$tested" DEPLOY_TIMES="$times" "$here/tools/deploy.sh"; then
  main_back
  refuse "the deploy failed after main moved; main keeps $(git log -1 --format=%h "$tip"). Read the deploy's output above"
fi
trap - INT TERM HUP
land_mark landed
queue_done ok
[ -z "$fellback" ] || say "landed on perigee's own test run, not CI: $fellback"
