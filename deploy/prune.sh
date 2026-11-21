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
# The pause after each transaction on state.db, so the server's writes get in (#1480).
PAUSE=${PAUSE:-0.25}
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
  if [[ -f $STATE_DB ]]; then sqlite3 -cmd ".timeout 30000" -cmd "ATTACH '$STATE_DB' AS state" -cmd "PRAGMA state.synchronous = NORMAL" "$DB" "$@"
  else sqlite3 -cmd ".timeout 30000" -cmd "PRAGMA synchronous = NORMAL" "$DB" "$@"; fi
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
  # Short transactions with a pause between: each holds state.db's write lock, and the server's writer, which polls a
  # held lock every 100 ms, gets in during the pause. One DELETE of 2.5 GB held it for 27 s and stalled the server (#1480).
  # A step's cost varies 100-fold with the load and with where its pages are, so each step's size follows the last one's
  # time, aiming at 0.1-0.25 s: halved when slower, doubled when faster, between lo and hi.
  us() { echo "${EPOCHREALTIME/[.,]/}"; }
  n=0 longest=0
  timed() {
    local t
    t=$(us)
    "$@"
    t=$(($(us) - t)) n=$((n + 1))
    ((t <= longest)) || longest=$t
    if ((t > 250000 && size > lo)); then size=$((size / 2)); elif ((t < 100000 && size < hi)); then size=$((size * 2)); fi
    sleep "$PAUSE"
  }
  took() { awk -v w="$1" -v n=$n -v u=$longest -v e="$2" 'BEGIN { printf "%s in %d steps, the longest %.2f s%s\n", w, n, u / 1e6, e }'; n=0 longest=0; }

  # The rows, listed once (a read: no lock), deleted in batches of about `size` bytes of data and at most 1000 rows.
  # The closed check again in each: a minion reopened since the list keeps its state.
  list=() i=0 size=8000000 lo=1000000 hi=64000000
  out=$(sql "SELECT rowid, length(data) FROM claude_state WHERE ticket_id IN ($closed_state) ORDER BY rowid")
  [[ -z $out ]] || mapfile -t list <<<"$out"
  batch() { sql "DELETE FROM claude_state WHERE rowid IN ($ids) AND ticket_id IN ($closed_state)"; }
  while ((i < ${#list[@]})); do
    ids='' b=0
    for ((k = 0; k < 1000 && i < ${#list[@]} && b < size; k++, i++)); do
      ids+=${ids:+,}${list[i]%|*} b=$((b + ${list[i]#*|}))
    done
    timed batch
  done
  took Deleted .

  # state.db is auto_vacuum=incremental: hand the freed pages back to the disk, at most 4096 pages (16 MB) a step. Right
  # after the deletes a step is slowest (each free page at the file's end is looked up in the whole freelist: 4096 pages
  # took 7 s on a copy, 90 ms later on; a 64 MB cache, more than the freelist's trunk pages, halves it). Each step counts
  # the free pages before and after itself, so the server freeing pages between steps can't end it early; it stops at 0
  # free or a step that freed nothing.
  if [[ -f $STATE_DB && $(sqlite3 "$STATE_DB" "PRAGMA auto_vacuum;") == 2 ]]; then # 2: incremental
    st() { sqlite3 -cmd ".timeout 30000" -cmd "PRAGMA synchronous = NORMAL" -cmd "PRAGMA cache_size = -65536" "$STATE_DB" "PRAGMA freelist_count;" "$@" "PRAGMA freelist_count;"; }
    vacuum() { local o; o=$(st "PRAGMA incremental_vacuum($size);"); was=${o%%$'\n'*} left=${o##*$'\n'}; }
    left=$(st | tail -n 1) was=$((left + 1)) size=64 lo=8 hi=4096
    while ((left > 0 && left < was)); do timed vacuum; done
    took Vacuumed "; $left pages still free."
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
