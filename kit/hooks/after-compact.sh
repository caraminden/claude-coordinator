#!/usr/bin/env bash
# SessionStart hook, matcher "compact" (kit/hooks/hooks.json): after a compaction, puts back what a
# summary blurs, the branch, head and uncommitted files, and points the session at the record (the
# requester's words, the checklist, handoff files) instead of the summary's paraphrase. Its output
# joins the compacted context. Turns compact at about 250k, Taskmasters' at 180k (autoCompactWindow in the runner's per-turn settings).
# Hooks run in the session's folder; CLAUDE_PROJECT_DIR is that folder when Claude Code sets it.
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
echo "[after-compact] This conversation was just compacted. Before acting on anything the summary"
echo "paraphrases (someone's ask, an open question, a go-ahead), re-read it at the source: their"
echo "latest messages, your checklist, the PR, the handoff file. Don't redo work the summary"
echo "says is done; check it in git."
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
branch="$(git branch --show-current 2>/dev/null)"
echo "Branch: ${branch:-detached} at $(git log -1 --format='%h %s' 2>/dev/null)"
upstream="$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || true)"
if [ -n "$upstream" ]; then
  echo "Against $upstream: $(git rev-list --left-right --count "$upstream...HEAD" 2>/dev/null \
    | awk '{ print $2 " ahead, " $1 " behind" }')"
fi
changes="$(git status --short 2>/dev/null)"
if [ -n "$changes" ]; then
  echo "Uncommitted ($(printf '%s\n' "$changes" | wc -l) files, first 15):"
  printf '%s\n' "$changes" | head -15
else
  echo "Working tree clean."
fi
exit 0
