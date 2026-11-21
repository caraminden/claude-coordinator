#!/bin/sh
# Facts self-review needs first, printed when the skill loads (command injection in SKILL.md).
# Read-only, capped, never fails: a missing piece prints a line saying so.
cap() { head -n "$1"; }
root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not in a git repo: run the commands in section 1 by hand"; exit 0; }
cd "$root" || exit 0
# The base is the first argument, else the build branch this one grew from (a feeder: build/<n>, the newest
# local one that is an ancestor of HEAD and not yet in main), else main.
base=${1:-}
if [ -z "$base" ]; then
  for b in $(git for-each-ref --sort=-committerdate --format='%(refname:short)' 'refs/heads/build/*'); do
    if git merge-base --is-ancestor "$b" HEAD 2>/dev/null && ! git merge-base --is-ancestor "$b" main 2>/dev/null; then base=$b; break; fi
  done
fi
[ -n "$base" ] || base=main
git rev-parse --verify -q "$base" >/dev/null || { echo "no local branch '$base': run the commands in section 1 by hand"; exit 0; }
echo "branch: $(git rev-parse --abbrev-ref HEAD)  head: $(git rev-parse --short HEAD)  base: $base $(git rev-parse --short $base)"
dirty=$(git status --porcelain | wc -l | tr -d ' ')
[ "$dirty" != 0 ] && echo "UNCOMMITTED: $dirty paths; the stat below leaves them out. Commit, then re-run the commands in section 1"
echo "--- git diff --stat $base...HEAD (last 40 lines)"
git diff --stat "$base"...HEAD | tail -n 40
echo "--- git diff --name-only $base...HEAD (first 80)"
n=$(git diff --name-only "$base"...HEAD | wc -l | tr -d ' ')
git diff --name-only "$base"...HEAD | cap 80
[ "$n" -gt 80 ] && echo "... $n files in all; the rest are cut"
echo "--- CLAUDE.md Project facts: risk-by-file lines"
if [ -f CLAUDE.md ]; then
  out=$(awk '/^- \*\*(High risk by file|Medium risk at least|Agent instructions)/{p=1;print;next} /^- \*\*|^## /{p=0} p' CLAUDE.md | cap 40)
  [ -n "$out" ] && echo "$out" || echo "none found in CLAUDE.md: read its Project facts by hand"
else
  echo "no CLAUDE.md"
fi
