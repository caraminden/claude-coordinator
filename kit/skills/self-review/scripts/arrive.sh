#!/bin/sh
# Facts self-review needs first, printed when the skill loads (command injection in SKILL.md).
# Read-only, capped, never fails: a missing piece prints a line saying so.
cap() { head -n "$1"; }
root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not in a git repo: run the commands in section 1 by hand"; exit 0; }
cd "$root" || exit 0
# The base is the first argument, else the build branch this one grew from (a feeder: build/<n>, the newest
# local one not yet in main that shares a commit with HEAD that main lacks; a feeder behind its build's tip
# still counts), else main.
base=${1:-}
if [ -z "$base" ]; then
  for b in $(git for-each-ref --sort=-committerdate --format='%(refname:short)' 'refs/heads/build/*'); do
    git merge-base --is-ancestor "$b" main 2>/dev/null && continue
    mb=$(git merge-base "$b" HEAD 2>/dev/null) || continue
    git merge-base --is-ancestor "$mb" main 2>/dev/null || { base=$b; break; }
  done
fi
[ -n "$base" ] || base=main
git rev-parse --verify -q "$base" >/dev/null || { echo "no local branch '$base': run the commands in section 1 by hand"; exit 0; }
echo "branch: $(git rev-parse --abbrev-ref HEAD)  head: $(git rev-parse --short HEAD)  base: $base $(git rev-parse --short $base)"
# A feeder's reviewers read the build's tip (references/review-extras.md, "A feeder"): say what other feeders merged since it started.
case $base in build/*)
  behind=$(git rev-list --count --no-merges HEAD.."$base")
  if [ "$behind" != 0 ]; then
    echo "BEHIND: $base has $behind commits this branch lacks (other feeders' merges, and main if the build took it in). Rebase onto it before the review (references/review-extras.md, \"A feeder\"); newest first, at most 15:"
    git log --oneline --no-merges HEAD.."$base" | cap 15
  fi ;;
esac
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
# A ship script this diff touches that is now byte-identical to the kit's template is a straight sync (section 4).
tpl=$(cd "$(dirname "$0")/../../scheme-setup/templates" 2>/dev/null && pwd)
if [ -n "$tpl" ]; then
  for f in land.sh land.local.sh; do
    git diff --name-only "$base"...HEAD | grep -qx "tools/$f" || continue
    if git show "HEAD:tools/$f" 2>/dev/null | cmp -s - "$tpl/$f"; then
      echo "--- SHIP SCRIPT SYNC: tools/$f is byte-identical to the kit template (section 4: medium if no other high-risk file changed)"
    else
      echo "--- SHIP SCRIPT EDIT: tools/$f differs from the kit template (section 4: high)"
    fi
  done
fi
