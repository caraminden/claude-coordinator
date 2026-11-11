#!/usr/bin/env bash
# Land a minion's branch: run it from the minion's worktree once its work is committed.
#   tools/land.sh
# Under the deploy lock (the one tools/deploy.sh takes), so landings and deploys go one at a time:
# 1. Rebases the branch onto the local main. A conflict aborts the rebase and stops here.
# 2. Runs the tests on the rebased branch. A failure stops here, with main untouched. Not in a citadel-heavy
#    slot: the deploy lock already lets only one landing test at a time, and waiting on a slot other schemes'
#    builds can hold for an hour, while holding the lock, starved every other landing (#499).
# 3. Fast-forwards main in the scheme repo to the branch.
# 4. Runs tools/deploy.sh (it inherits the lock). If that deploys nothing because a check failed and
#    the live checkout went back, main goes back too, so main only ever holds what passed.
# For a restart that cuts off running turns (only with a person's OK), land first, then run
# tools/deploy.sh --now: it joins the restart this one queued.
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
[ $# -eq 0 ] || refuse "takes no arguments (for --now, land first, then run tools/deploy.sh --now with a person's OK)"
tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) # before the cd below, which would break a relative path to it
here=$(git rev-parse --show-toplevel)
cd "$here" # the tests run from the worktree's top, wherever in it this was started
branch=$(git branch --show-current)
{ [ -n "$branch" ] && [ "$branch" != main ]; } || refuse "run it from a minion's branch, not main or a detached HEAD"
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "$here has uncommitted changes: commit them first"
[ "$(git -C "$SOURCE" branch --show-current)" = main ] || refuse "$SOURCE is not on main; a person needs to look"
[ -z "$(git -C "$SOURCE" status --porcelain --untracked-files=no)" ] || refuse "$SOURCE has uncommitted changes; a person needs to look"

state=$(git -C "$LIVE" rev-parse --absolute-git-dir)/cc-deploy
mkdir -p -m 700 "$state"
exec 9>"$state/lock"
flock -w 900 9 || refuse "another deploy or landing has held the lock for 15 min; try again later"

old=$(git -C "$SOURCE" rev-parse main)
say "rebasing $branch onto main ($(git log -1 --format='%h "%s"' main))"
if ! git rebase -q main; then
  # Which files collide is worth a retro-log line (the architecture check counts them). Best effort: land.sh has no
  # session id, so the line goes in the day's land.md; any failure here is swallowed and the abort and refusal go on as before.
  conflicted=$(git diff --name-only --diff-filter=U 2>/dev/null | sed ':a;N;$!ba;s/\n/, /g' || true)
  (
    set +e
    [ -n "${COORDINATOR_SHARED_DIR:-}" ] || exit 0
    dir=$COORDINATOR_SHARED_DIR/retro-log/$(date -u +%F)
    mkdir -p "$dir" || exit 0
    [ -e "$dir/land.md" ] || printf '# Retro log: land.sh\n\nWritten by tools/land.sh (no session id, so one file per day). One line per rebase conflict.\n\n' >>"$dir/land.md"
    if [ -n "$conflicted" ]; then what=" onto $(git log -1 --format=%h main): $conflicted"; else what=": no conflicted files found (the rebase may not have started)"; fi
    printf -- '- %sZ · land conflict · %s%s\n' "$(date -u +%T)" "$branch" "$what" >>"$dir/land.md"
  ) >/dev/null 2>&1 || true
  git rebase --abort 2>/dev/null || true # nothing to abort if it never started (an untracked file in the way)
  refuse "the rebase onto main failed (see git's output above), so nothing landed${conflicted:+; conflicted files: $conflicted}. On conflicts: run git rebase main, resolve them keeping the other minions' changes, re-test, commit, then run this again"
fi

say "running the tests"
log="$state/land-test.log"
if ! "$tools/run-tests.sh" "$log"; then
  tail -n 40 "$log" >&2
  refuse "tests failed on the rebased branch (full log: $log), so main is untouched"
fi

tip=$(git rev-parse HEAD)
# Only when the live checkout doesn't have it (a failed check put it back, or it never pulled): main follows, unless it moved on since.
main_back() {
  if ! git -C "$LIVE" merge-base --is-ancestor "$tip" HEAD 2>/dev/null && [ "$(git -C "$SOURCE" rev-parse main)" = "$tip" ]; then
    git -C "$SOURCE" reset -q --keep "$old"
    refuse "the deploy stopped before the live checkout took it, so main is back at $(git log -1 --format=%h "$old"); $branch keeps the rebased work. Fix it and land again"
  fi
}
# Killed mid-deploy (a person's Stop, a time limit): the same rule, from here on, once the deploy has put the checkout back.
trap 'main_back; exit 130' INT
trap 'main_back; exit 143' TERM
trap 'main_back; exit 129' HUP
git -C "$SOURCE" merge -q --ff-only "$tip" || refuse "could not fast-forward main to $branch; nothing landed"
say "main is now at $(git log -1 --format='%h "%s"' "$tip")"

if ! DEPLOY_LOCKED=1 "$here/tools/deploy.sh"; then
  main_back
  refuse "the deploy failed after main moved; main keeps $(git log -1 --format=%h "$tip"). Read the deploy's output above"
fi
trap - INT TERM HUP
