#!/usr/bin/env bash
# Safe deploys for Citadel. Run it from a minion once its work is on main:
#   tools/deploy.sh          (--now: restart even if that cuts off running turns; only with a person's OK)
# 1. Fast-forwards the live checkout to main, runs the tests, and boots the new code on a spare port
#    against a copy of the database (tools/boot-check.ts). Any failure, or a kill, puts the checkout
#    back; nothing restarts.
# 2. A change to public/ only: SIGHUP, and the server reloads its front end. No restart, no killed turns.
# 3. Anything else: queues the fixed-name restart unit, which restarts straight away (running turns
#    carry on in their own units and the new server re-attaches; it only waits while turns a restart
#    would cut off are running, see interruptible), waits up to 30 s for a healthy server and tags it
#    last-good. If the new code doesn't come up, it rolls the checkout back to last-good and restarts
#    again. It reports how it went in the deploying minion's chat (failures as errors, which push) and
#    in the journal. Before restarting it copies the database to backups/pre-deploy-<commit>.db (newest
#    3 kept, rotated only after a healthy deploy), so a rollback that can't read what the new code
#    wrote can be restored by hand. No copy, no restart.
# 4. Once the new code is live (either way), pushes that commit to GitHub's main, never forced. A failed
#    push is logged and shows in the report, but the deploy stands.
# Every path and name can be overridden with DEPLOY_* variables, which is how it is tested on a dev copy.
set -euo pipefail

# A turn in its person's Claude container (#213) can't deploy: the land tool runs land.sh (and this) on the host.
[ "${COORDINATOR_CONTAINER:-}" != 1 ] || { echo "deploy: this turn runs in a container: land with the land tool (mcp__thread) instead" >&2; exit 1; }
LIVE=${DEPLOY_LIVE:-$HOME/claude-coordinator}
SOURCE=${DEPLOY_SOURCE:-$HOME/.local/share/claude-coordinator/projects/2/repo}
SERVICE=${DEPLOY_SERVICE:-claude-coordinator}
URL=${DEPLOY_URL:-http://127.0.0.1:8573}
DB=${DEPLOY_DB:-$HOME/.local/share/claude-coordinator/coordinator.db}
UNIT=${DEPLOY_UNIT:-cc-restart-when-idle}
IDLE_TRIES=${DEPLOY_IDLE_TRIES:-720} # 10 s apart: 2 h
NOW=${DEPLOY_NOW:-} # set: restart without waiting for interruptible turns (--now)
HEALTHY_WAIT=${DEPLOY_HEALTHY_WAIT:-30}
REMOTE=${DEPLOY_REMOTE-origin} # set it empty to skip the push (dev copies)
BACKUPS=${DEPLOY_BACKUPS:-3} # pre-deploy copies of the database to keep

say() { echo "deploy: $*" >&2; }
git_live() { git -C "$LIVE" "$@"; }
short() { git_live log -1 --format='%h "%s"' "$1"; }

# A field of the running server's /api/health, or nothing if it doesn't answer (or predates it).
health() {
  curl -fsS --max-time 3 "$URL/api/health" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[process.argv[1]]??"")}catch{}})' "$1" || true
}

# frontend if every file changed between two commits is under public/, none if nothing changed,
# server otherwise (and whenever the running commit is unknown).
change_kind() {
  local dir=$1 from=$2 to=$3 files
  if [ -z "$from" ] || ! git -C "$dir" cat-file -e "$from^{commit}" 2>/dev/null; then echo server; return; fi
  files=$(git -C "$dir" diff --name-only "$from" "$to")
  if [ -z "$files" ]; then echo none
  elif grep -qv '^public/' <<<"$files"; then echo server
  else echo frontend; fi
}

STATE=""
init_state() {
  STATE=$(git_live rev-parse --absolute-git-dir)/cc-deploy
  mkdir -p -m 700 "$STATE"
}

# Post a deploy report in one minion's chat: ok, warn (live, but something needs a look: shows as an
# error and notifies) or fail. ok and warn dismiss a minion in pending-deploy.
post_report() {
  local api=$1 token=$2 ticket=$3 ok=$4 text=$5
  curl -fsS --max-time 10 -X POST "$api/api/tickets/$ticket/deploy" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "$(node -e 'const k=process.argv[1];console.log(JSON.stringify({ok:k!=="fail",warn:k==="warn",text:process.argv[2]}))' "$ok" "$text")" >/dev/null ||
    say "could not post the report to minion $ticket's chat"
}

# Live already, so the minion running this deploy hears now (and is dismissed when its turn ends).
report_me() {
  if [ -n "${COORDINATOR_TICKET:-}" ] && [ -n "${COORDINATOR_TOKEN:-}" ]; then
    post_report "${COORDINATOR_API:-$URL}" "$COORDINATOR_TOKEN" "$COORDINATOR_TICKET" "${2:-ok}" "$1"
  fi
}

# Tell the minions that asked for this deploy, and the journal. $1 is ok, warn or fail.
report() {
  local ok=$1 text=$2 api token ticket
  case "$ok" in ok) say "$text" ;; warn) say "WARNING: $text" ;; *) say "FAILED: $text" ;; esac
  [ -f "$STATE/reporters" ] || return 0
  while read -r api token ticket; do
    post_report "$api" "$token" "$ticket" "$ok" "$text"
  done < <(tac "$STATE/reporters" | sort -su -k3,3) # one note per minion, with the newest of its turns' tokens
  rm -f "$STATE/reporters"
}

# Push live commit $1 to $REMOTE's main, so GitHub matches what runs and keeps a copy off the box.
# Never forced: if GitHub's main has commits that aren't live, git rejects it and we only report that.
# Prints a sentence to add to the deploy's report; a failed push returns 1 (a warn report), but never
# fails the deploy.
push_github() {
  [ -n "$REMOTE" ] || return 0
  local out why fix=""
  # Main goes out as the box's own gh login, not the GitHub account of the turn that ran the deploy (#182).
  if out=$(env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$LIVE" push -q "$REMOTE" "$1:refs/heads/main" 2>&1); then
    say "pushed $(git_live rev-parse --short "$1") to $REMOTE main"
    echo " Pushed to GitHub."
    return 0
  fi
  if grep -qE '\[rejected\]|non-fast-forward|fetch first' <<<"$out"; then
    why="its main has commits that aren't live, so nothing was forced"
    fix="GitHub main has diverged: a person needs to look."
  else
    # git's first fatal/error line names the cause; the last line is often just advice.
    why=$(awk '/^(fatal|error):/ && !e {e=$0} NF {l=$0} END {print e != "" ? e : l != "" ? l : "no answer within 60 s"}' <<<"$out")
    grep -qiE 'could not read Username|Authentication failed|Invalid username|error: 40[13]|Permission denied' <<<"$out" &&
      fix="GitHub refused the login: run gh auth status as $(id -un) and log in again if it has expired."
  fi
  local msg="Not pushed to GitHub: $why. The next deploy will retry.${fix:+ $fix}"
  say "$msg"
  logger -t "$UNIT" -- "$msg" 2>/dev/null || true
  echo " $msg"
  return 1
}

running_minions() {
  (cd /tmp && node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync(process.argv[1],{readOnly:true}).prepare(\"select count(*) c from tickets where status='running'\").get().c)" "$DB") 2>/dev/null || echo '?'
}

# Running turns a restart would cut off: those not in a unit of their own. A server from before turn
# units doesn't say, and every one of its turns would be cut off; a server that is down has none left.
# One that doesn't answer while its unit is still up (slow or stuck) is not down: ? keeps the wait going.
interruptible() {
  local n
  n=$(health interruptible)
  if [ -n "$n" ]; then echo "$n"
  elif [ -n "$(health ok)" ]; then running_minions
  elif systemctl --user is-active -q "$SERVICE" 2>/dev/null; then echo '?'
  else echo 0; fi
}

# The units of the turns this server runs (src/runner.ts names them after its data dir).
turn_units() {
  local tag
  tag=$(printf %s "$(dirname "$DB")/run/turns" | sha256sum | cut -c1-8)
  echo "citadel-turn-$tag-*.service"
}

# Copy the database to backups/pre-deploy-<commit $1>.db before the new code migrates it. Prints the
# copy's path; no database (a dev copy) prints nothing. A copy already there stays: a retry after a
# rollback would otherwise replace the clean copy with what the failed code left. VACUUM INTO copies in
# one read transaction: sqlite3's .backup steps 100 pages at a time and restarts on every write the
# live server makes in between, so on a busy box it ran for minutes (#497). The copy is set back to WAL
# like the live file, so restoring it by hand is a drop-in.
backup_db() {
  [ -f "$DB" ] || return 0
  local dir out tmp
  dir=$(dirname "$DB")/backups
  out=$dir/pre-deploy-$(git_live rev-parse --short "$1").db || return 1
  if [ ! -e "$out" ]; then
    tmp=$dir/.pre-deploy.db.tmp
    (umask 077 && mkdir -p "$dir" && rm -f "$tmp" && sqlite3 "$DB" ".timeout 30000" "VACUUM INTO '$tmp'" && sqlite3 "$tmp" "PRAGMA journal_mode = WAL" >/dev/null && mv -f "$tmp" "$out") || { rm -f "$tmp"; return 1; }
  fi
  echo "$out"
}

# Keep the newest $BACKUPS pre-deploy copies. Only after a healthy deploy, so fixing forward after a
# failed one never rotates out the clean copy its report named.
rotate_backups() {
  { ls -1t "$(dirname "$DB")"/backups/pre-deploy-*.db 2>/dev/null || true; } | tail -n +$((BACKUPS + 1)) | xargs -r rm -f -- || true
}

# Restart the service and wait for it to answer healthy from commit $1.
restart_healthy() {
  systemctl --user restart "$SERVICE" || return 1
  for _ in $(seq "$HEALTHY_WAIT"); do
    sleep 1
    [ "$(health commit)" = "$1" ] && systemctl --user is-active -q "$SERVICE" && return 0
  done
  return 1
}

# Queued as the restart unit: restart once no turn would be cut off (at once with --now), roll back if
# the new code doesn't come up.
restart() {
  rm -f "$0" # a private copy (see deploy); bash keeps reading it from the open file
  init_state
  local i=0
  # $STATE/now: a --now deploy that found this restart already queued and waiting.
  while [ -z "$NOW" ] && [ ! -e "$STATE/now" ]; do
    if [ "$(interruptible)" = 0 ]; then
      sleep 2
      [ "$(interruptible)" = 0 ] && break
    fi
    i=$((i + 1))
    if [ "$i" -ge "$IDLE_TRIES" ]; then
      report fail "Gave up after $((IDLE_TRIES * 10 / 60)) min waiting for the turns a restart would cut off (ones not in a unit of their own) to finish, so nothing restarted. The checkout is at $(short HEAD), but the server still runs $(health commit | cut -c1-7). Run tools/deploy.sh again to queue another restart, or with a person's OK, tools/deploy.sh --now."
      exit 1
    fi
    sleep 10
  done

  exec 9>"$STATE/lock"
  flock 9
  rm -f "$STATE/now"
  local target good saved
  target=$(git_live rev-parse HEAD)
  if ! saved=$(backup_db "$target"); then
    report fail "Could not copy the database to backups/ before restarting on $(short "$target") (see journalctl --user -u $UNIT), so nothing restarted. The checkout is at $(short "$target"), but the server still runs $(health commit | cut -c1-7). Free some disk or fix the copy, then run tools/deploy.sh again."
    exit 1
  fi
  [ -n "$saved" ] && say "database copied to $saved"
  say "restarting $SERVICE on $(short "$target")"
  if restart_healthy "$target"; then
    git_live tag -f last-good "$target" >/dev/null
    rotate_backups
    local pushed kind=ok
    pushed=$(push_github "$target") || kind=warn
    report "$kind" "Deployed $(short "$target"): the server restarted and is healthy.$pushed"
    return 0
  fi
  local why="the server did not answer healthy on it within ${HEALTHY_WAIT} s"
  good=$(git_live rev-parse -q --verify 'last-good^{commit}' || true)
  if [ -z "$good" ] || [ "$good" = "$target" ]; then
    report fail "Deploy of $(short "$target") failed: $why, and there is no older last-good commit to roll back to. Check journalctl --user -u $SERVICE."
    exit 1
  fi
  say "rolling back to last-good $(short "$good")"
  git_live reset -q --hard "$good"
  # Code from before turn units can't re-attach: it would resume turns that still run. Stop them, so
  # it resumes them alone.
  if ! git_live cat-file -e "$good:src/turn-wrapper.ts" 2>/dev/null; then
    say "last-good predates turn units; stopping the running turns so it resumes them"
    systemctl --user stop "$(turn_units)" || true
  fi
  if restart_healthy "$good"; then
    report fail "Deploy of $(short "$target") failed: $why. Rolled back to last-good $(short "$good"), which is up and healthy.${saved:+ The database from before the deploy is in $saved, should the rollback have trouble with what the new code wrote.} main still has the bad commit: fix forward and deploy again. Details: journalctl --user -u $SERVICE."
  else
    touch "$STATE/FAILED"
    report fail "Deploy of $(short "$target") failed: $why, and the rollback to $(short "$good") did not come up healthy either. The service is likely down: check journalctl --user -u $SERVICE.${saved:+ The database from before the deploy is in $saved.}"
  fi
  exit 1
}

deploy() {
  init_state
  # DEPLOY_LOCKED: run by tools/land.sh, which already holds the lock on fd 9.
  [ -n "${DEPLOY_LOCKED:-}" ] || exec 9>"$STATE/lock"
  flock -w 900 9 || { say "another deploy has held the lock for 15 min; try again later"; exit 1; }
  [ -f "$STATE/FAILED" ] && say "warning: the last rollback failed too (see journalctl --user -u $UNIT); carrying on" && rm -f "$STATE/FAILED"
  if [ -n "$(git_live status --porcelain --untracked-files=no)" ]; then
    say "$LIVE has local changes; refusing to deploy over them"
    exit 1
  fi

  local prev new running kind version
  prev=$(git_live rev-parse HEAD)
  # The first deploy has nothing to roll back to; what's running now is the best last-good there is.
  if ! git_live rev-parse -q --verify last-good >/dev/null && systemctl --user is-active -q "$SERVICE"; then
    git_live tag last-good "$(health commit | grep . || echo "$prev")"
  fi
  # Killed (a person's Stop, a time limit) from the pull until the restart is queued: put the checkout
  # back too, so it never sits on untested code with nothing queued.
  undo() { say "putting the checkout back to $(short "$prev")"; git_live reset -q --hard "$prev"; }
  trap 'undo; exit 130' INT
  trap 'undo; exit 143' TERM
  trap 'undo; exit 129' HUP
  git_live pull -q --ff-only "$SOURCE" main
  new=$(git_live rev-parse HEAD)
  running=$(health commit)
  kind=$(change_kind "$LIVE" "$running" "$new")
  if [ "$kind" = none ]; then
    trap - INT TERM HUP
    say "nothing to deploy: the server already runs $(short "$new")"
    report_me "Nothing to deploy: the server already runs $(short "$new")."
    return 0
  fi
  say "deploying $(short "$new") ($kind change)"

  # Put the checkout back on any failure from here until the restart is queued.
  trap undo ERR
  say "running the tests"
  if ! (cd "$LIVE" && tools/run-tests.sh "$STATE/test.log"); then
    tail -n 40 "$STATE/test.log" >&2
    say "tests failed (full log: $STATE/test.log); nothing deployed"
    false
  fi
  say "boot check: the new code on a spare port with a copy of the database"
  if ! version=$(node "$LIVE/tools/boot-check.ts" "$LIVE" "$DB"); then
    say "boot check failed; nothing deployed"
    false
  fi
  trap - ERR INT TERM HUP

  if [ "$kind" = frontend ] && [ "$(health reload)" = sighup ]; then
    systemctl --user kill -s HUP --kill-whom=main "$SERVICE"
    for _ in $(seq 10); do
      sleep 1
      if [ "$(health version)" = "$version" ]; then
        git_live tag -f last-good "$new" >/dev/null
        say "live now: the server reloaded the front end ($version); open tabs reload when idle. No restart."
        local pushed kind=ok
        pushed=$(push_github "$new") || kind=warn
        report_me "Deployed $(short "$new"): the server reloaded the front end, no restart.$pushed" "$kind"
        return 0
      fi
    done
    say "the server did not pick up the new front end on SIGHUP; queuing a restart instead"
  fi

  # The restart runs after this turn ends, so remember who to tell how it went.
  if [ -n "${COORDINATOR_TICKET:-}" ] && [ -n "${COORDINATOR_TOKEN:-}" ]; then
    (umask 077 && echo "${COORDINATOR_API:-$URL} $COORDINATOR_TOKEN $COORDINATOR_TICKET" >>"$STATE/reporters")
  fi
  # The unit runs a private copy of the version just pulled, so a later pull or a rollback can't
  # rewrite the script under it.
  local copy="$STATE/restart-$new-$$.sh"
  cp "$LIVE/tools/deploy.sh" "$copy"
  local out
  if out=$(systemd-run --user --collect --unit="$UNIT" --description="Restart $SERVICE (tools/deploy.sh)" \
    --setenv=DEPLOY_LIVE="$LIVE" --setenv=DEPLOY_SERVICE="$SERVICE" --setenv=DEPLOY_URL="$URL" --setenv=DEPLOY_DB="$DB" \
    --setenv=DEPLOY_IDLE_TRIES="$IDLE_TRIES" --setenv=DEPLOY_HEALTHY_WAIT="$HEALTHY_WAIT" --setenv=DEPLOY_REMOTE="$REMOTE" \
    --setenv=DEPLOY_NOW="$NOW" --setenv=DEPLOY_BACKUPS="$BACKUPS" --setenv=PATH="$PATH" \
    bash "$copy" restart 2>&1); then
    if [ -n "$NOW" ]; then say "restart queued as $UNIT with --now: it restarts at once, cutting off turns not in a unit of their own (this one too, if so)"
    else say "restart queued as $UNIT: running turns carry on through it, and it reports here"; fi
  elif grep -qi 'already' <<<"$out"; then
    rm -f "$copy"
    if [ -n "$NOW" ]; then
      touch "$STATE/now"
      say "a restart is already queued as $UNIT; with --now it goes ahead at once and deploys this too, and reports here"
    else say "a restart is already queued as $UNIT; it will deploy this too and report here"; fi
    return 0
  else
    rm -f "$copy"
    say "could not queue the restart: $out"
    exit 1
  fi
  # The queued restart takes the lock before it restarts: let go, or it waits out the 60 s below.
  flock -u 9
  # Usually it is live within seconds; say so here, as this turn carries on through the restart.
  for _ in $(seq 60); do
    sleep 1
    if [ "$(health commit)" = "$new" ]; then
      say "live now: the server restarted on $(short "$new")"
      return 0
    fi
  done
  say "not live yet after 60 s; the restart reports here when it is (see journalctl --user -u $UNIT)"
}

case "${1:-}" in
  '') deploy ;;
  --now) NOW=1 deploy ;;
  restart) restart ;;
  interruptible) interruptible ;;
  turn-units) turn_units ;;
  change-kind) change_kind "$2" "$3" "$4" ;;
  push-github) push_github "$2" ;;
  backup-db) backup_db "$2" ;;
  rotate-backups) rotate_backups ;;
  *) echo "usage: $0 [--now | restart | interruptible | turn-units | change-kind <dir> <from> <to> | push-github <commit> | backup-db <commit> | rotate-backups]" >&2; exit 2 ;;
esac
