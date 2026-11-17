#!/usr/bin/env bash
# The off-box copy set (#252): what Cara's desktop pulls each night through deploy/offbox-serve.sh.
#
# backup.sh runs this after each nightly backup. It mirrors $DATA_DIR/backups into $DATA_DIR/offbox:
# - every coordinator daily and weekly, as a copy with people's linked-account secrets stripped
#   (credentials rows other than claude_runner, whose row holds only a container name and an email)
#   and every saved secret (stored_secrets, #838), and the contraption turn audit (players' words, #844; backup.sh
#   already drops it, this covers copies from before #850),
#   then VACUUMed so the deleted rows leave no bytes behind. A weekly links to its stripped daily.
# - only the newest state-<day>.db, as a hard link (claude_state holds transcripts, memory and task
#   lists, no logins).
# - SHA256SUMS, the list the desktop reads and checks each download against.
# - every registered contraption's newest nightly backups, as hard links under apps/ (#828, below).
# - every Android app's release key and its password file, as hard links under keys/ (#837, below).
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
  sqlite3 "$tmp" "PRAGMA journal_mode=DELETE;" >/dev/null
  # Each table holding secrets or players' words, and which of its rows must not go off-box. A backup from before a table existed lacks it.
  local table drop has left
  for table in credentials stored_secrets contraption_turn_audit; do
    drop=$([[ $table == credentials ]] && echo "kind <> 'claude_runner'" || echo 1)
    has=$(sqlite3 "$tmp" "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '$table';")
    [[ $has == 1 ]] || continue
    sqlite3 "$tmp" "DELETE FROM $table WHERE $drop;"
    left=$(sqlite3 "$tmp" "SELECT count(*) FROM $table WHERE $drop;")
    [[ $left == 0 ]] || { echo "Off-box copy of $(basename "$1") still holds $left $table rows" >&2; exit 1; }
  done
  sqlite3 "$tmp" "VACUUM;"
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

# Contraptions' own nightly backups (#828), every registered app's, all its people's data included.
# The convention: an app's data folder is $APPS_DATA/<name> (Citadel sets DATA_DIR so on its units), and
# a nightly backup job writes finished copies into backups/<YYYY-MM-DD>/ there (Mandate's does, at 03:30).
# The newest $APP_DAYS of those folders come here as hard links, as apps/<name>/<day>/<file>: no extra
# disk on perigee. Only plain files with plain names: never a SQLite -wal, -shm or -journal, a dotfile or a
# half-written .tmp or .part. An app with no dated folders is skipped and named in the run's output.
APPS_DATA=${APPS_DATA:-$HOME/.local/share}
APP_DAYS=${APP_DAYS:-7}
app_name='^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$' # CONTRAPTION_NAME in src/contraptions.ts
file_name='^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$'  # what offbox-serve.sh and citadel-pull.ps1 accept
declare -A app_want=()
apps_with=() apps_without=() apps_stale=()
today=$(date +%F)
apps=$(sqlite3 -readonly "$DATA_DIR/coordinator.db" ".timeout 30000" "SELECT name FROM contraptions ORDER BY name" 2>/dev/null) ||
  { echo "Off-box set: couldn't read the contraptions registry, so no app backups this run" >&2; apps=""; }
for app in $apps; do
  [[ $app =~ $app_name ]] || continue
  days=()
  for d in "$APPS_DATA/$app/backups"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
    [[ -d $d && ! -L $d ]] && days+=("$(basename "$d")")
  done
  if ((${#days[@]} == 0)); then apps_without+=("$app"); continue; fi
  mapfile -t days < <(printf '%s\n' "${days[@]}" | sort -r | head -n "$APP_DAYS")
  [[ ${days[0]} == "$today" ]] || apps_stale+=("$app (newest ${days[0]})")
  files=0
  for day_ in "${days[@]}"; do
    for f in "$APPS_DATA/$app/backups/$day_"/*; do
      name=$(basename "$f")
      [[ -f $f && ! -L $f && $name =~ $file_name && $name != *..* ]] || continue
      [[ $name == *-wal || $name == *-shm || $name == *-journal || $name == *.tmp || $name == *.part ]] && continue
      rel=apps/$app/$day_/$name
      if [[ ! $OUT/$rel -ef $f ]]; then
        mkdir -p "$OUT/apps/$app/$day_"
        # A hard link where it can; another filesystem gets a copy. A file the app pruned meanwhile, or one
        # that can't be read, is left out and named, so one app can't stop Citadel's own set.
        if ! ln -f -- "$f" "$OUT/$rel" 2>/dev/null; then
          tmp=$OUT/.app.tmp
          if ! { cp --reflink=auto -- "$f" "$tmp" && mv -f "$tmp" "$OUT/$rel"; }; then
            echo "Off-box set: couldn't link or copy $rel, left out" >&2
            continue
          fi
          tmp=""
        fi
      fi
      app_want[$rel]=1
      files=$((files + 1))
    done
  done
  apps_with+=("$app ($files files, ${#days[@]} days)")
done
if [[ -d $OUT/apps ]]; then
  while IFS= read -r -d '' f; do
    [[ -n ${app_want[${f#"$OUT"/}]:-} ]] || rm -f -- "$f"
  done < <(find "$OUT/apps" \( -type f -o -type l \) -print0)
  find "$OUT/apps" -mindepth 1 -type d -empty -delete
fi
mapfile -t app_files < <(printf '%s\n' "${!app_want[@]}" | sort)
[[ ${app_files[0]:-} ]] && want+=("${app_files[@]}")

# Every Android app's release key (#837; Cara, 2026-11-17, "Every release key"): keys/<app>-release.jks and its
# .pass from $KEY_DIR, as hard links (mode 600, no extra disk), for as long as each exists there. A lost key means
# every phone has to uninstall the app to take its next update. Only those two names: nothing else in that folder
# (mandate-google-services.json and the like) goes. Nothing here ever writes into a link, so the key itself is never touched.
KEY_DIR=${KEY_DIR:-$HOME/.config/citadel-android}
keys=()
for f in "$KEY_DIR"/*-release.jks "$KEY_DIR"/*-release.pass; do
  name=$(basename "$f")
  [[ -f $f && ! -L $f && ${name%-release.*} =~ $app_name ]] || continue
  rel=keys/$name
  if [[ ! $OUT/$rel -ef $f ]]; then
    mkdir -p "$OUT/keys"
    if ! ln -f -- "$f" "$OUT/$rel" 2>/dev/null; then
      tmp=$OUT/.key.tmp
      if ! { cp -- "$f" "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$OUT/$rel"; }; then
        echo "Off-box set: couldn't link or copy $rel, left out" >&2
        continue
      fi
      tmp=""
    fi
  fi
  keys+=("$rel")
done
if [[ -d $OUT/keys ]]; then
  for f in "$OUT/keys"/* "$OUT/keys"/.[!.]*; do
    [[ " ${keys[*]} " == *" ${f#"$OUT"/} "* && -f $f && ! -L $f ]] || rm -rf -- "$f"
  done
fi
((${#keys[@]})) && want+=("${keys[@]}")

sums=$OUT/.SHA256SUMS.tmp
(cd "$OUT" && for name in "${want[@]}"; do sha256sum -- "$name"; done) >"$sums"
mv -f "$sums" "$OUT/SHA256SUMS"
echo "Off-box set: ${#want[@]} files, $(du -shL "$OUT" | cut -f1)"
list() { local s; s=$(printf '%s, ' "$@"); echo "${s%, }"; }
((${#apps_with[@]})) && echo "App backups: $(list "${apps_with[@]}")"
((${#apps_stale[@]})) && echo "App backups not from today (a job that runs after this one, or one that stopped): $(list "${apps_stale[@]}")"
((${#apps_without[@]})) && echo "Apps with no nightly backups, skipped: $(list "${apps_without[@]}")"
((${#keys[@]})) && echo "Release keys: $((${#keys[@]})) files"
exit 0
