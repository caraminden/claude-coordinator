#!/usr/bin/env bash
# Prune what Citadel no longer needs. Lists by default; deletes only with --apply.
#
#   prune.sh [--apply] [--stale-backups]
#
# Every run handles:
#   - claude_state rows (the database copy of a session) of minions closed more than STATE_DAYS (14) ago.
# --stale-backups also handles the ad-hoc copies beside the database (coordinator.db.backup-*,
# coordinator.db.bak-*) once they are COPY_DAYS (7) old, the dailies' window, and only while the
# newest nightly backup in backups/ is under 2 days old and passes its restore check.
#
# "Closed N days ago" is the minion's last update while closed, which is when it was dismissed.
# Dismissed minions' worktrees are the server's job (src/worktree-sweep.ts, #660), on each minion's lane.
set -euo pipefail

DATA_DIR=${DATA_DIR:-$HOME/.local/share/claude-coordinator}
DB=$DATA_DIR/coordinator.db
STATE_DAYS=${STATE_DAYS:-14}
COPY_DAYS=${COPY_DAYS:-7}
apply=0 backups=0
for a in "$@"; do
  case $a in
    --apply) apply=1 ;;
    --stale-backups) backups=1 ;;
    *) echo "Unknown option $a" >&2; exit 2 ;;
  esac
done

# Session state is in state.db (attached as the server attaches it), or still in the main file before
# the server has moved it.
STATE_DB=$DATA_DIR/state.db
sql() {
  if [[ -f $STATE_DB ]]; then sqlite3 -cmd ".timeout 30000" -cmd "ATTACH '$STATE_DB' AS state" "$DB" "$@"
  else sqlite3 -cmd ".timeout 30000" "$DB" "$@"; fi
}
mb() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1e6 }'; }
now=$(date +%s%3N)
verb=$([[ $apply == 1 ]] && echo Deleting || echo "Would delete")

# Session state of long-closed minions.
cutoff=$((now - STATE_DAYS * 86400000))
closed_state="SELECT t.id FROM tickets t WHERE t.status = 'closed' AND t.updated_at < $cutoff"
rows=$(sql -separator $'\t' "SELECT p.name, t.number, count(*), sum(length(s.data)) FROM claude_state s JOIN tickets t ON t.id = s.ticket_id JOIN projects p ON p.id = t.project_id WHERE s.ticket_id IN ($closed_state) GROUP BY t.id ORDER BY p.name, t.number")
echo "== Session state of minions closed over $STATE_DAYS days ago"
total=0
while IFS=$'\t' read -r name num files bytes; do # tab-separated: a scheme name may have spaces
  [[ -n ${num:-} ]] || continue
  echo "$verb: $name #$num, $files files, $(mb "$bytes")"
  total=$((total + bytes))
done <<<"$rows"
echo "Total: $(mb $total)"
if [[ $apply == 1 && $total -gt 0 ]]; then
  sql "DELETE FROM claude_state WHERE ticket_id IN ($closed_state)"
  # state.db is auto_vacuum=incremental: hand the freed pages back to the disk.
  # 16 MB a step, so the server's writes to state.db never wait long behind it; stops when a step frees
  # nothing (a state.db without auto_vacuum).
  free() { sqlite3 -cmd ".timeout 30000" "$STATE_DB" "PRAGMA freelist_count;"; }
  if [[ -f $STATE_DB ]]; then
    left=$(free) was=$((left + 1))
    while ((left > 0 && left < was)); do
      sqlite3 -cmd ".timeout 30000" "$STATE_DB" "PRAGMA incremental_vacuum(4096);" >/dev/null
      was=$left left=$(free)
    done
  fi
fi

[[ $backups == 1 ]] || exit 0
echo "== Ad-hoc database copies beside coordinator.db"
latest=$(ls -1 "$DATA_DIR"/backups/coordinator-[0-9]*.db 2>/dev/null | sort | tail -n 1 || true)
if [[ -z $latest ]] || [[ -z $(find "$latest" -mmin -2880) ]] || [[ $(sqlite3 :memory: ".restore '$latest'" "PRAGMA integrity_check;") != ok ]]; then
  echo "Keeping them: no nightly backup from the last 2 days that passes its restore check."
  exit 0
fi
echo "Nightly backup checked: $latest"
total=0
for f in "$DB".backup-* "$DB".bak-*; do
  [[ -e $f ]] || continue
  if [[ -z $(find "$f" -mmin +$((COPY_DAYS * 1440))) ]]; then
    echo "Keeping (under $COPY_DAYS days old): $(basename "$f")"
    continue
  fi
  bytes=$(stat -c %s "$f")
  echo "$verb: $(basename "$f"), $(mb "$bytes")"
  total=$((total + bytes))
  if [[ $apply == 1 ]]; then rm -f -- "$f"; fi
done
echo "Total: $(mb $total)"
