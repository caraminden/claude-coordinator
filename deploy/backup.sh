#!/usr/bin/env bash
# Nightly backup of Citadel's database (run by claude-coordinator-backup.timer).
#
# Takes an online copy with `VACUUM INTO` (one read transaction, safe while the server is writing; a
# stepped `.backup` restarts on every write and can run for minutes, #497), proves it restores, then
# keeps the newest 7 dailies and 4 weeklies under $DATA_DIR/backups, all mode 600. Session state
# (state.db) gets its own state-<day>.db, 3 dailies and no weeklies. Hand-made copies
# there (coordinator-before-<what>.db, taken before a risky change) go once they are 7 days old, when
# the dailies cover the same days. deploy.sh keeps its own pre-deploy-*.db copies.
# Then offbox.sh refreshes $DATA_DIR/offbox, which Cara's desktop pulls each night (#252).
# A weekly is a hard link to that Sunday's daily (or the first daily of a week with no weekly yet),
# so it costs no extra space until the daily ages out.
set -euo pipefail
umask 077

DATA_DIR=${DATA_DIR:-$HOME/.local/share/claude-coordinator}
DB=$DATA_DIR/coordinator.db
DIR=$DATA_DIR/backups
DAILIES=${DAILIES:-7}
WEEKLIES=${WEEKLIES:-4}
STATE_DAILIES=${STATE_DAILIES:-3}

[[ -f $DB ]] || { echo "No database at $DB" >&2; exit 1; }
mkdir -p "$DIR"
chmod 700 "$DIR"

day=$(date +%F)
week=$(date +%G-W%V)
out=$DIR/coordinator-$day.db
tmp=$DIR/.coordinator-$day.db.tmp
rm -f "$tmp"
trap 'rm -f "$tmp"' EXIT

sqlite3 "$DB" ".timeout 30000" "VACUUM INTO '$tmp'"
# The contraption turn audit (#844) holds players' words for 14 days only, so no copy keeps it (#850).
# secure_delete zeroes the freed pages, so no trace is left without a second VACUUM of the whole file.
if [[ $(sqlite3 "$tmp" "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'contraption_turn_audit'") == 1 ]]; then
  sqlite3 "$tmp" "PRAGMA journal_mode = MEMORY" "PRAGMA secure_delete = ON" "DELETE FROM contraption_turn_audit" >/dev/null
fi
sqlite3 "$tmp" "PRAGMA journal_mode = WAL" >/dev/null # like the live file, so a restore is a drop-in

# The restore check: load the copy into a scratch in-memory database the way a restore would,
# and require a clean integrity check and the tables the app can't start without.
check=$(sqlite3 :memory: ".restore '$tmp'" "PRAGMA integrity_check;" "SELECT count(*) FROM projects;" "SELECT count(*) FROM tickets;")
mapfile -t lines <<<"$check"
if [[ ${lines[0]} != ok || ${lines[1]:-0} -lt 1 || ${lines[2]:-0} -lt 1 ]]; then
  echo "Backup failed its restore check: $check" >&2
  exit 1
fi

chmod 600 "$tmp"
mv -f "$tmp" "$out"
trap - EXIT

weekly=$DIR/coordinator-weekly-$week.db
if [[ ! -e $weekly ]]; then
  ln -f "$out" "$weekly"
elif [[ $(date +%u) == 7 ]]; then
  ln -f "$out" "$weekly" # Sunday's copy wins for the week.
fi

# Retention: names sort by date, so drop all but the newest N of each kind.
prune() { ls -1 "$DIR"/$1 2>/dev/null | sort -r | tail -n +$(($2 + 1)) | xargs -r rm -f --; }
prune 'coordinator-[0-9]*.db' "$DAILIES"
prune 'coordinator-weekly-*.db' "$WEEKLIES"
find "$DIR" -maxdepth 1 -name 'coordinator-before-*' -mmin +$((DAILIES * 1440)) -delete

# Session state (state.db): big, and only recent minions need it, so a few dailies and no weeklies.
state=$DATA_DIR/state.db
state_note=""
if [[ -f $state ]]; then
  sout=$DIR/state-$day.db
  tmp=$DIR/.state-$day.db.tmp
  rm -f "$tmp"
  trap 'rm -f "$tmp"' EXIT
  sqlite3 "$state" ".timeout 30000" "VACUUM INTO '$tmp'"
  sqlite3 "$tmp" "PRAGMA journal_mode = WAL" >/dev/null
  scheck=$(sqlite3 :memory: ".restore '$tmp'" "PRAGMA integrity_check;" "SELECT 'rows', count(*) FROM claude_state;")
  [[ $scheck == ok$'\n'rows\|* ]] || { echo "Session state backup failed its restore check: $scheck" >&2; exit 1; }
  chmod 600 "$tmp"
  mv -f "$tmp" "$sout"
  trap - EXIT
  prune 'state-[0-9]*.db' "$STATE_DAILIES"
  state_note=", sessions to $(basename "$sout") ($(du -h "$sout" | cut -f1))"
fi

echo "Backed up to $out ($(du -h "$out" | cut -f1); projects ${lines[1]}, minions ${lines[2]}), weekly $(basename "$weekly")$state_note"

# The copy set Cara's desktop pulls, with people's linked-account secrets stripped (#252).
"$(dirname "$0")/offbox.sh"
