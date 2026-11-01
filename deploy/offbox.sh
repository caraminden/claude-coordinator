#!/usr/bin/env bash
# The off-box copy set (#252): what Cara's desktop pulls each night through deploy/offbox-serve.sh.
#
# backup.sh runs this after each nightly backup. It mirrors $DATA_DIR/backups into $DATA_DIR/offbox:
# - every coordinator daily and weekly, as a copy with people's linked-account secrets stripped
#   (credentials rows other than claude_runner, whose row holds only a container name and an email),
#   then VACUUMed so the deleted rows leave no bytes behind. A weekly links to its stripped daily.
# - only the newest state-<day>.db, as a hard link (claude_state holds transcripts, memory and task
#   lists, no logins).
# - SHA256SUMS, the list the desktop reads and checks each download against.
# Safe to run again: copies already made are kept unless their backup is newer, files gone from backups go here too.
set -euo pipefail
umask 077

DATA_DIR=${DATA_DIR:-$HOME/.local/share/claude-coordinator}
SRC=$DATA_DIR/backups
OUT=$DATA_DIR/offbox
mkdir -p "$OUT"
chmod 700 "$OUT"

tmp=""
trap 'rm -f ${tmp:+"$tmp"}' EXIT

# A stripped copy of backup $1 at $2, checked before it takes the name.
strip() {
  tmp=$OUT/.$(basename "$2").tmp
  rm -f "$tmp"
  cp --reflink=auto -- "$1" "$tmp"
  local has
  has=$(sqlite3 "$tmp" "PRAGMA journal_mode=DELETE;" "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'credentials';" | tail -n 1)
  if [[ $has == 1 ]]; then
    sqlite3 "$tmp" "DELETE FROM credentials WHERE kind <> 'claude_runner';" "VACUUM;"
    local left
    left=$(sqlite3 "$tmp" "SELECT count(*) FROM credentials WHERE kind <> 'claude_runner';")
    [[ $left == 0 ]] || { echo "Off-box copy of $(basename "$1") still holds $left credentials" >&2; exit 1; }
  fi
  [[ $(sqlite3 "$tmp" "PRAGMA quick_check;") == ok ]] || { echo "Off-box copy of $(basename "$1") failed its check" >&2; exit 1; }
  chmod 600 "$tmp"
  mv -f "$tmp" "$2"
  tmp=""
}

shopt -s nullglob
want=()

for f in "$SRC"/coordinator-[0-9]*.db; do
  name=$(basename "$f")
  want+=("$name")
  [[ $OUT/$name -nt $f ]] || strip "$f" "$OUT/$name" # a backup re-run the same day gets stripped again
done

# A weekly is a hard link to one of the dailies; link it to that daily's stripped copy. Once the daily
# has aged out, the weekly here stays as it was.
for f in "$SRC"/coordinator-weekly-*.db; do
  name=$(basename "$f")
  want+=("$name")
  daily=""
  for d in "$SRC"/coordinator-[0-9]*.db; do
    if [[ $d -ef $f ]]; then daily=$(basename "$d"); break; fi
  done
  if [[ -n $daily && -e $OUT/$daily ]]; then
    [[ $OUT/$name -ef $OUT/$daily ]] || ln -f "$OUT/$daily" "$OUT/$name"
  elif [[ ! -e $OUT/$name ]]; then
    strip "$f" "$OUT/$name"
  fi
done

states=("$SRC"/state-[0-9]*.db)
if ((${#states[@]})); then
  newest=$(printf '%s\n' "${states[@]}" | sort | tail -n 1)
  want+=("$(basename "$newest")")
  [[ $OUT/$(basename "$newest") -ef $newest ]] || ln -f "$newest" "$OUT/$(basename "$newest")"
fi

for f in "$OUT"/*.db; do
  name=$(basename "$f")
  [[ " ${want[*]} " == *" $name "* ]] || rm -f -- "$f"
done

sums=$OUT/.SHA256SUMS.tmp
(cd "$OUT" && for name in "${want[@]}"; do sha256sum -- "$name"; done) >"$sums"
mv -f "$sums" "$OUT/SHA256SUMS"
echo "Off-box set: ${#want[@]} files, $(du -shL "$OUT" | cut -f1)"
