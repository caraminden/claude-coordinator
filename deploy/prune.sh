#!/usr/bin/env bash
# Prune what Citadel no longer needs. Lists by default; deletes only with --apply.
#
#   prune.sh [--apply] [--stale-backups]
#
# Every run handles:
#   - claude_state rows (the database copy of a session) of minions closed more than STATE_DAYS (14) ago;
#   - git worktrees of minions closed more than WORKTREE_DAYS (30) ago. Branches are kept, and the
#     runner recreates the worktree from its branch if the minion is reopened. Worktrees with
#     uncommitted changes are listed and skipped.
# --stale-backups also handles the ad-hoc copies beside the database (coordinator.db.backup-*,
# coordinator.db.bak-*), and only once a nightly backup in backups/ passes its restore check.
#
# "Closed N days ago" is the minion's last update while closed, which is when it was dismissed.
set -euo pipefail

DATA_DIR=${DATA_DIR:-$HOME/.local/share/claude-coordinator}
DB=$DATA_DIR/coordinator.db
STATE_DAYS=${STATE_DAYS:-14}
WORKTREE_DAYS=${WORKTREE_DAYS:-30}
apply=0 backups=0
for a in "$@"; do
  case $a in
    --apply) apply=1 ;;
    --stale-backups) backups=1 ;;
    *) echo "Unknown option $a" >&2; exit 2 ;;
  esac
done

sql() { sqlite3 -cmd ".timeout 30000" "$DB" "$@"; }
mb() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1e6 }'; }
now=$(date +%s%3N)
verb=$([[ $apply == 1 ]] && echo Deleting || echo "Would delete")

# Session state of long-closed minions.
cutoff=$((now - STATE_DAYS * 86400000))
closed_state="SELECT t.id FROM tickets t WHERE t.status = 'closed' AND t.updated_at < $cutoff"
rows=$(sql -separator ' ' "SELECT p.name, t.number, count(*), sum(length(s.data)) FROM claude_state s JOIN tickets t ON t.id = s.ticket_id JOIN projects p ON p.id = t.project_id WHERE s.ticket_id IN ($closed_state) GROUP BY t.id ORDER BY p.name, t.number")
echo "== Session state of minions closed over $STATE_DAYS days ago"
total=0
while read -r name num files bytes; do
  [[ -n ${num:-} ]] || continue
  echo "$verb: $name #$num, $files files, $(mb "$bytes")"
  total=$((total + bytes))
done <<<"$rows"
echo "Total: $(mb $total)"
if [[ $apply == 1 && $total -gt 0 ]]; then
  sql "DELETE FROM claude_state WHERE ticket_id IN ($closed_state)"
fi

# Worktrees of long-closed minions; their branches stay.
cutoff=$((now - WORKTREE_DAYS * 86400000))
echo "== Worktrees of minions closed over $WORKTREE_DAYS days ago (branches kept)"
total=0
while IFS=$'\t' read -r name num cwd repo; do
  [[ -n ${cwd:-} && -d $cwd && -f $cwd/.git && $cwd == "$DATA_DIR"/projects/* ]] || continue
  if [[ -n $(git -C "$cwd" status --porcelain 2>/dev/null) ]]; then
    echo "Skipping (uncommitted changes): $name #$num, $cwd"
    continue
  fi
  kb=$(du -sk "$cwd" | cut -f1)
  echo "$verb: $name #$num, $cwd, $(mb $((kb * 1024)))"
  total=$((total + kb * 1024))
  if [[ $apply == 1 ]]; then git -C "$repo" worktree remove "$cwd"; fi
done < <(sql -separator $'\t' "SELECT p.name, t.number, t.cwd, p.repo_dir FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.status = 'closed' AND t.kind = 'ticket' AND t.branch IS NOT NULL AND p.repo_dir IS NOT NULL AND t.updated_at < $cutoff ORDER BY p.name, t.number")
echo "Total: $(mb $total)"

[[ $backups == 1 ]] || exit 0
echo "== Ad-hoc database copies beside coordinator.db"
latest=$(ls -1 "$DATA_DIR"/backups/coordinator-[0-9]*.db 2>/dev/null | sort | tail -n 1 || true)
if [[ -z $latest ]] || [[ $(sqlite3 :memory: ".restore '$latest'" "PRAGMA integrity_check;") != ok ]]; then
  echo "Keeping them: no nightly backup that passes its restore check yet."
  exit 0
fi
echo "Nightly backup checked: $latest"
total=0
for f in "$DB".backup-* "$DB".bak-*; do
  [[ -e $f ]] || continue
  bytes=$(stat -c %s "$f")
  echo "$verb: $(basename "$f"), $(mb "$bytes")"
  total=$((total + bytes))
  if [[ $apply == 1 ]]; then rm -f -- "$f"; fi
done
echo "Total: $(mb $total)"
