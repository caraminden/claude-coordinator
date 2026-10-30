#!/usr/bin/env bash
# Land a minion's branch on main: run it from the minion's worktree once its work is committed.
#   tools/land.sh
# This is the route CLAUDE.md names under "Project facts", "How a change ships". One landing at a
# time, under a lock in the scheme repo's .git:
# 1. Rebases the branch onto the local main. A conflict aborts the rebase and stops here.
# 2. Runs the check command on the rebased branch. A failure stops here, with main untouched.
# 3. Fast-forwards main in the scheme's main checkout to the branch.
# 4. Pushes main to origin from the main checkout, never forced. A failed push is reported and main
#    stays moved; the next landing pushes it again.
set -euo pipefail

# The check command, exactly as Project facts names it under "Check commands".
CHECK='npm test'

say() { echo "land: $*" >&2; }
refuse() { say "$*"; exit 1; }

[ $# -eq 0 ] || refuse "takes no arguments"
here=$(git rev-parse --show-toplevel)
branch=$(git branch --show-current)
{ [ -n "$branch" ] && [ "$branch" != main ]; } || refuse "run it from a minion's branch, not main or a detached HEAD"
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "$here has uncommitted changes: commit them first"
# The main checkout is the first entry of the worktree list.
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
[ "$(git -C "$MAIN" branch --show-current)" = main ] || refuse "$MAIN is not on main; a person needs to look"
[ -z "$(git -C "$MAIN" status --porcelain --untracked-files=no)" ] || refuse "$MAIN has uncommitted changes; a person needs to look"

state=$(git -C "$MAIN" rev-parse --absolute-git-dir)
exec 9>"$state/land.lock"
flock -w 900 9 || refuse "another landing has held the lock for 15 min; try again later"

say "rebasing $branch onto main ($(git log -1 --format='%h "%s"' main))"
if ! git rebase -q main; then
  git rebase --abort 2>/dev/null || true # nothing to abort if it never started
  refuse "the rebase onto main failed (see git's output above), so nothing landed. On conflicts: run git rebase main, resolve them keeping the other minions' changes, re-test, commit, then run this again"
fi

say "running $CHECK"
log="$state/land-check.log"
if ! bash -c "$CHECK" >"$log" 2>&1; then
  tail -n 40 "$log" >&2
  refuse "the check failed on the rebased branch (full log: $log), so main is untouched"
fi

tip=$(git rev-parse HEAD)
git -C "$MAIN" merge -q --ff-only "$tip" || refuse "could not fast-forward main to $branch; nothing landed"
say "main is now at $(git log -1 --format='%h "%s"' "$tip")"

if ! git -C "$MAIN" remote get-url origin >/dev/null 2>&1; then
  say "no origin remote, so main stays local"
  exit 0
fi
# --no-verify: .githooks/pre-push refuses every push to main on purpose; this script is the one
# route that may make it.
if out=$(GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$MAIN" push -q --no-verify origin main 2>&1); then
  say "pushed main to origin"
else
  say "main moved, but the push to origin failed: $out"
  say "the next landing pushes it again"
  exit 1
fi
