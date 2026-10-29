#!/usr/bin/env bash
# Land a minion's branch: run it from the minion's worktree once its work is committed.
#   tools/land.sh
# Under the deploy lock (the one tools/deploy.sh takes), so landings and deploys go one at a time:
# 1. Rebases the branch onto the local main. A conflict aborts the rebase and stops here.
# 2. Runs the tests on the rebased branch. A failure stops here, with main untouched.
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

[ $# -eq 0 ] || refuse "takes no arguments (for --now, land first, then run tools/deploy.sh --now with a person's OK)"
here=$(git rev-parse --show-toplevel)
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
  git rebase --abort
  refuse "the rebase onto main hit conflicts, so nothing landed. Run git rebase main, resolve them keeping the other minions' changes, re-test, commit, then run this again"
fi

say "running the tests"
log="$state/land-test.log"
if ! node --test test/ >"$log" 2>&1; then
  tail -n 40 "$log" >&2
  refuse "tests failed on the rebased branch (full log: $log), so main is untouched"
fi

tip=$(git rev-parse HEAD)
git -C "$SOURCE" merge -q --ff-only "$tip" || refuse "could not fast-forward main to $branch; nothing landed"
say "main is now at $(git log -1 --format='%h "%s"' "$tip")"

if ! DEPLOY_LOCKED=1 "$here/tools/deploy.sh"; then
  # Only when the live checkout went back (a failed check): main follows it, unless it moved on since.
  if ! git -C "$LIVE" merge-base --is-ancestor "$tip" HEAD 2>/dev/null && [ "$(git -C "$SOURCE" rev-parse main)" = "$tip" ]; then
    git -C "$SOURCE" reset -q --keep "$old"
    refuse "the deploy failed before going live, so main is back at $(git log -1 --format=%h "$old"); $branch keeps the rebased work. Fix it and land again"
  fi
  refuse "the deploy failed after main moved; main keeps $(git log -1 --format=%h "$tip"). Read the deploy's output above"
fi
