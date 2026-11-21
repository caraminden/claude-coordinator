#!/usr/bin/env bash
# Commit titles that lost their "#N:" (#1489). Usage: tools/commit-titles.sh <base>, run in the branch's worktree.
# A rebase stopped on a conflict and continued with GIT_EDITOR=true used to read a "#N: ..." title as a comment and
# drop it (core.commentChar, src/workspace.ts keepTitles, stops that for new work). Exit 0 when fine; exit 1 and one
# line naming the first commit when a commit of <base>..HEAD has an empty subject, or has no "#N" while another
# commit in that range has one. A branch whose commits have none of them (a plain scheme) is fine.
base=${1:?usage: commit-titles.sh <base>}
subjects=$(git log --no-merges --format='%h %s' "$base..HEAD") || exit 2
numbered='^[0-9a-f]+ (WIP )?#[0-9]+'
empty='^[0-9a-f]+ *$'
if grep -qE "$numbered" <<<"$subjects" || grep -qE "$empty" <<<"$subjects"; then
  bad=$(grep -vE "$numbered" <<<"$subjects" | head -n 1)
  if [ -n "$bad" ]; then
    echo "commit ${bad%% *} (\"${bad#* }\") lost its #N: title, which a rebase continued with GIT_EDITOR=true drops: reword it (git commit --amend, or git rebase -i) to start with #N:, then run this again"
    exit 1
  fi
fi
exit 0
