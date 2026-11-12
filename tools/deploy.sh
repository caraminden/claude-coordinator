#!/usr/bin/env bash
# Safe deploys for Citadel. Run it from a minion once its work is on main:
#   tools/deploy.sh          (--now: restart even if that cuts off running turns; only with a person's OK)
# 1. Fast-forwards the live checkout to main, runs the tests (unless tools/land.sh just ran them on that
#    same commit, DEPLOY_TESTED), and boots the new code on a spare port
#    against a copy of the database (tools/boot-check.ts). Any failure, or a kill, puts the checkout
#    back; nothing restarts.
# 2. A change to public/ only: SIGHUP, and the server reloads its front end. No restart, no killed turns.
# 3. Anything else: queues the fixed-name restart unit, which restarts straight away (running turns
#    carry on in their own units and the new server re-attaches; it only waits while turns a restart
#    would cut off are running, see interruptible, or for 60 s on a server that is up but doesn't answer), waits up to 30 s for a healthy server, checks it is still
#    healthy 30 s later, and tags it last-good. If the new code doesn't come up or stay up, it rolls the checkout back to last-good and restarts
#    again. It reports how it went in the deploying minion's chat (failures as errors, which push) and
#    in the journal. Before restarting it copies the database to backups/pre-deploy-<commit>.db (newest
#    3 kept, rotated only after a healthy deploy), so a rollback that can't read what the new code
#    wrote can be restored by hand. No copy, no restart.
#    The restart holds the restart lock (tools/deploy-queue.sh) from the database copy until it ends, and this takes
#    it before the pull: no pull, reload or restart while another restart is still being judged (#566).
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
BOOT_TIMEOUT=${DEPLOY_BOOT_TIMEOUT:-420} # boot-check.ts gives up by itself at 180 s, twice over
IDLE_POLL=${DEPLOY_IDLE_POLL:-10} # seconds between looks at the running turns (tests shrink it)
UNKNOWN_WAIT=${DEPLOY_UNKNOWN_WAIT:-60} # how long a restart waits on a server that is up but doesn't answer
NOW=${DEPLOY_NOW:-} # set: restart without waiting for interruptible turns (--now)
HEALTHY_WAIT=${DEPLOY_HEALTHY_WAIT:-30}
SETTLE=${DEPLOY_SETTLE:-30} # after the first healthy answer, check again this much later (#520)
REPORT_WAIT=${DEPLOY_REPORT_WAIT:-30} # seconds to wait for the server to take a deploy report
REPORT_RETRY=${DEPLOY_REPORT_RETRY:-60} # and how long to keep trying one that never reached it
REMOTE=${DEPLOY_REMOTE-origin} # set it empty to skip the push (dev copies)
BACKUPS=${DEPLOY_BACKUPS:-3} # pre-deploy copies of the database to keep

say() { echo "deploy: $*" >&2; }
git_live() { git -C "$LIVE" "$@"; }
short() { git_live log -1 --format='%h "%s"' "$1"; }

# For land.sh's timing line (#565): "queued <t>" once the restart is queued or the front end reloaded, "live <t>" once
# it is live, in the file land.sh names in DEPLOY_TIMES (trusted with DEPLOY_LOCKED only). Never fails the deploy.
TIMES=
mark() { [ -z "$TIMES" ] || { echo "$1 $(date +%s)" >>"$TIMES"; } 2>/dev/null || true; }

# A line in the scheme's retro log, as tools/land.sh's retro_log writes it (the same header: test/land.test.ts pins
# it). The queued restart's timing line goes there. Best effort: any failure is swallowed.
retro_log() (
  set +eu
  [ -n "${COORDINATOR_SHARED_DIR:-}" ] || exit 0
  dir=$COORDINATOR_SHARED_DIR/retro-log/$(date -u +%F)
  mkdir -p "$dir" || exit 0
  [ -e "$dir/land.md" ] || printf '%s\n\n' '# Retro log: land.sh' 'Written by tools/land.sh, tools/run-tests.sh and the queued restart in tools/deploy.sh (no session id, so one file per day). One line per rebase conflict, per landing that fell back from CI to the suite on perigee, and per test file that failed in a land or deploy run and passed alone (flake). Phase times in whole seconds (#565), - for a phase never reached: a `timing` line per landing that got in line, landed or not (line: waiting for the deploy lock; rebase; ci-queue: until a runner took the job; ci-run; fallback: the wait for a CI that gave no answer + the suite on perigee; deploy: pull, boot check and tests if any, until the restart was queued or the front end reloaded; live: from then until the deploy saw it live, the restart'"'"'s settle check included), and a `restart` line per queued restart (idle-wait: for the turns it would cut off and the lock; backup: the database copy; healthy: restart to the first healthy answer; settle: the check after it).' >>"$dir/land.md"
  printf -- '- %sZ · %s\n' "$(date -u +%T)" "$1" >>"$dir/land.md"
) >/dev/null 2>&1 || true

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
# A server just restarted can take a while to answer (#520: 10 s stalls, so the old 10 s limit gave up on
# reports it then posted), so each try waits REPORT_WAIT s. One that never reached the server (dropped, or a
# 5xx, or no connection made in time) goes again with backoff for about a minute; one sent with no answer
# in time doesn't, since the server has it queued and a second would post twice.
post_report() {
  local api=$1 token=$2 ticket=$3 ok=$4 text=$5 body out code connected rc left pause=1 start=$SECONDS
  body=$(node -e 'const k=process.argv[1];console.log(JSON.stringify({ok:k!=="fail",warn:k==="warn",text:process.argv[2]}))' "$ok" "$text")
  while :; do
    rc=0
    out=$(curl -sS -o /dev/null -w '%{http_code} %{time_connect}' --max-time "$REPORT_WAIT" -X POST "$api/api/tickets/$ticket/deploy" \
      -K - -H 'Content-Type: application/json' -d "$body" 2>/dev/null <<<"header = \"Authorization: Bearer $token\"") || rc=$? # the token on stdin: a command line is readable by every process
    read -r code connected <<<"$out"
    [ "$rc" = 0 ] && [ "${code:0:1}" = 2 ] && return 0
    # curl's 28 is any timeout: only one after the connection was made means the server has the report.
    if [ "$rc" = 28 ] && [ "${connected//[0.]/}" != "" ]; then
      say "no answer from the server within $REPORT_WAIT s to the report for minion $ticket's chat; it likely still arrives"
      return 0
    fi
    [ "$rc" = 0 ] && [ "${code:0:1}" != 5 ] && break
    left=$((REPORT_RETRY - (SECONDS - start)))
    [ "$left" -gt 0 ] || break
    sleep $((pause < left ? pause : left))
    pause=$((pause * 2))
  done
  say "could not post the report to minion $ticket's chat ($([ "$rc" = 0 ] && echo "HTTP $code" || echo "curl exit $rc"))"
}

# Live already, so the minion running this deploy hears now (and is dismissed when its turn ends).
report_me() {
  if [ -n "${COORDINATOR_TICKET:-}" ] && [ -n "${COORDINATOR_TOKEN:-}" ]; then
    post_report "${COORDINATOR_API:-$URL}" "$COORDINATOR_TOKEN" "$COORDINATOR_TICKET" "${2:-ok}" "$1"
  fi
}

# What the landings waiting in line see of the queued restart, which holds the lock with no ticket (deploy-queue.sh).
restart_phase() {
  local stat
  stat=$(cat "/proc/$$/stat") && stat=${stat##*) } || return 0
  # shellcheck disable=SC2206
  stat=($stat)
  printf '%s\n' "$$ ${stat[19]}" "$1 since $(date +%H:%M)" >"$STATE/restart.tmp" && mv -f "$STATE/restart.tmp" "$STATE/restart"
}

# Tell the minions that asked for this deploy, and the journal. $1 is ok, warn or fail. All at once (#553): the
# restart still holds its lock here (letting go first would let the next deploy find this unit "already" queued,
# with its restart behind it), and a server that is down costs REPORT_RETRY s a report, which one after another
# outlasted the landings waiting in line.
# A minion whose own commit is older than what this restart was for hears which was its own (#553 M11): the report is
# about the tip, and the failure may be in either. The commits are in reporter-commits ("<ticket> <commit>"), not a field of
# reporters, which a restart queued by an older copy of this file reads as three fields.
report() {
  local ok=$1 text=$2 api token ticket mine tip own
  case "$ok" in ok) say "$text" ;; warn) say "WARNING: $text" ;; *) say "FAILED: $text" ;; esac
  [ -f "$STATE/reporters" ] || return 0
  restart_phase "posting its reports"
  tip=${R_TARGET:-$(git_live rev-parse HEAD)}
  while read -r api token ticket; do
    mine=$(awk -v t="$ticket" '$1 == t { c = $2 } END { print c }' "$STATE/reporter-commits" 2>/dev/null) || mine=
    own=
    [ -z "$mine" ] || [ "$mine" = "$tip" ] || own=" This restart was for your $(short "$mine") and the newer commits up to $(short "$tip")."
    post_report "$api" "$token" "$ticket" "$ok" "$text$own" &
  done < <(tac "$STATE/reporters" | sort -su -k3,3) # one note per minion, with the newest of its turns' tokens
  wait
  rm -f "$STATE/reporters" "$STATE/reporter-commits"
}

# Push live commit $1 to $REMOTE's main, so GitHub matches what runs and keeps a copy off the box.
# Never forced: if GitHub's main has commits that aren't live, git rejects it and we only report that.
# Prints a sentence to add to the deploy's report; a failed push returns 1 (a warn report), but never
# fails the deploy.
push_github() {
  [ -n "$REMOTE" ] || return 0
  local out why fix=""
  # Main goes out as the box's own gh login, not the GitHub account of the turn that ran the deploy (#182).
  # --no-verify: .githooks/pre-push refuses every push to main on purpose; this is the one meant to make it.
  if out=$(env -u GH_TOKEN -u GITHUB_TOKEN GH_CONFIG_DIR="$HOME/.config/gh" GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$LIVE" push -q --no-verify "$REMOTE" "$1:refs/heads/main" 2>&1); then
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
# One that doesn't answer while its unit is still up (slow or stuck) is not down: ? keeps the wait going, but only
# for DEPLOY_UNKNOWN_WAIT s (60) of unbroken silence (#553): after that the restart goes ahead.
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
  echo "$out" # first, so a copy that fails still names its file
  if [ ! -e "$out" ]; then
    tmp=$dir/.pre-deploy.db.tmp
    (umask 077 && mkdir -p "$dir" && rm -f "$tmp" && sqlite3 "$DB" ".timeout 30000" "VACUUM INTO '$tmp'" && sqlite3 "$tmp" "PRAGMA journal_mode = WAL" >/dev/null && mv -f "$tmp" "$out") || { rm -f "$tmp"; return 1; }
  fi
}

# Keep the newest $BACKUPS pre-deploy copies. Only after a healthy deploy, so fixing forward after a
# failed one never rotates out the clean copy its report named.
rotate_backups() {
  { ls -1t "$(dirname "$DB")"/backups/pre-deploy-*.db 2>/dev/null || true; } | tail -n +$((BACKUPS + 1)) | xargs -r rm -f -- || true
}

# Wait up to HEALTHY_WAIT s for the service to answer healthy from commit $1.
healthy() {
  for _ in $(seq "$HEALTHY_WAIT"); do
    sleep 1
    [ "$(health commit)" = "$1" ] && systemctl --user is-active -q "$SERVICE" && return 0
  done
  return 1
}

main_pid() { systemctl --user show -p MainPID --value "$SERVICE" 2>/dev/null || true; }

# Restart the service and wait for it to answer healthy from commit $1 (else 1), then again SETTLE s later
# from the same process (else 2): a server can answer once and die in its first minute, and systemd's
# Restart=always would bring it back healthy-looking (#520). The second check gets the same wait, as that
# first minute is slow (re-attaching turns, startup checks) and slow isn't down.
restart_healthy() {
  R_UP='' R_SETTLED='' # for the restart's timing line
  systemctl --user restart "$SERVICE" || return 1
  healthy "$1" || return 1
  R_UP=$(date +%s)
  local pid
  pid=$(main_pid)
  sleep "$SETTLE"
  healthy "$1" && [ "$(main_pid)" = "$pid" ] || return 2
  R_SETTLED=$(date +%s)
}

# The queued restart's line in the retro log (#565), when it ends however it ends.
restart_timing() (
  set +eu
  local now up settled
  now=$(date +%s)
  span() { if [ -n "$1" ]; then echo $((${2:-$now} - $1)); else echo -; fi; } # <start> [<end>, else now]; - if it never started
  read -r up settled <<<"${R_FIRST-$R_UP $R_SETTLED}"
  retro_log "restart · ${R_COMMIT:-$(git_live rev-parse --short HEAD)} · idle-wait $(span "$R_START" "$R_LOCK") · backup $(span "$R_LOCK" "$R_BACKUP") · healthy $([ -n "$up" ] && span "$R_RESTART" "$up" || echo -) · settle $([ -n "$settled" ] && span "$up" "$settled" || echo -) · $R_OUT"
) >/dev/null 2>&1

# How many running turns a restart would cut off ($1), and which (#584): "2 running turns (Citadel #412 Usage bar,
# Citadel Taskmaster)". The server gives the turns' minion ids, not names (/api/health answers without a login, and the
# minions list shows a scheme only to its members), so the names come from the database: 5 at most, then how many
# more, then the server jobs the count holds besides turns. An older server that gives no ids, or a database that
# can't be read, leaves the count alone.
turns() {
  local names
  if [ "$1" = 1 ]; then printf '1 running turn'; else printf '%s running turns' "${1:-some}"; fi
  names=$(curl -fsS --max-time 3 "$URL/api/health" 2>/dev/null | (cd /tmp && node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const h = JSON.parse(s), ids = h.interruptibleTurns;
      if (!Array.isArray(ids)) return;
      const db = new (require("node:sqlite").DatabaseSync)(process.argv[1], { readOnly: true });
      const q = db.prepare("select t.kind, t.number, t.title, p.name from tickets t left join projects p on p.id = t.project_id where t.id = ?");
      const named = ids.map((id) => q.get(Number(id))).filter(Boolean)
        .map((t) => `${t.name ?? "?"} ${t.kind === "coordinator" ? "Taskmaster" : `#${t.number} ${String(t.title).replace(/\s+/g, " ").trim().slice(0, 40)}`}`);
      const more = ids.length - Math.min(named.length, 5), jobs = (Number(h.interruptible) || 0) - ids.length;
      const out = [...named.slice(0, 5), ...(more > 0 ? [`${more} more`] : []), ...(jobs > 0 ? [`${jobs} server job${jobs === 1 ? "" : "s"}`] : [])];
      if (out.length) console.log(out.join(", "));
    });' "$DB") 2>/dev/null || true)
  if [ -n "$names" ]; then echo " ($names)"; else echo; fi
}

# Queued as the restart unit: restart once no turn would be cut off (at once with --now), roll back if
# the new code doesn't come up or stay up.
restart() {
  case "$0" in */cc-deploy/restart-*.sh) rm -f "$0" ;; esac # the unit's private copy (see deploy), never the tracked script; bash keeps reading it from the open file
  init_state
  # Its timing line (#565): epoch seconds of each step, and how it ended (any exit not given one was cut off).
  unset R_FIRST
  R_START=$(date +%s) R_LOCK='' R_BACKUP='' R_RESTART='' R_UP='' R_SETTLED='' R_COMMIT='' R_TARGET='' R_OUT=stopped
  trap 'restart_timing || true; rm -f "$STATE/restart"' EXIT
  local i=0 n unknown='' told=''
  # $STATE/now: a --now deploy that found this restart already queued and waiting.
  while [ -z "$NOW" ] && [ ! -e "$STATE/now" ]; do
    n=$(interruptible)
    if [ "$n" = 0 ]; then
      sleep 2
      n=$(interruptible)
      [ "$n" = 0 ] && break
    fi
    # A server that stays up but silent (#553: seen after a failed rollback) can't say whether a turn runs, and
    # would never say none does: after a short while that is a broken server, which a restart is the cure for.
    if [ "$n" = '?' ]; then
      unknown=${unknown:-$SECONDS}
      if [ $((SECONDS - unknown)) -ge "$UNKNOWN_WAIT" ]; then
        say "the server has not answered for $((SECONDS - unknown)) s while its unit is up, so it can't say which turns are running: restarting now"
        break
      fi
    else
      unknown=
    fi
    # Said at the start and every 15 min (#553): the wait is up to 2 h, and the journal showed nothing of it.
    if [ -z "$told" ] || [ $((SECONDS - told)) -ge 900 ]; then
      told=$SECONDS
      if [ "$n" = '?' ]; then say "the server is not answering while its unit is up; waiting at most $UNKNOWN_WAIT s for it to say which turns are running"
      else say "waiting for $(turns "$n") a restart would cut off to finish, at most $(((IDLE_TRIES - i) * 10 / 60)) min more; tools/deploy.sh --now restarts without waiting"; fi
    fi
    i=$((i + 1))
    if [ "$i" -ge "$IDLE_TRIES" ]; then
      R_OUT="gave up waiting for turns"
      report fail "Gave up after $((IDLE_TRIES * 10 / 60)) min waiting for the turns a restart would cut off (ones not in a unit of their own) to finish, so nothing restarted. The checkout is at $(short HEAD), but the server still runs $(health commit | cut -c1-7). Run tools/deploy.sh again to queue another restart, or with a person's OK, tools/deploy.sh --now."
      exit 1
    fi
    sleep "$IDLE_POLL"
  done

  # The restart lock, not the deploy lock (#566, tools/deploy-queue.sh): the next landing rebases and passes its gate
  # beside this, and takes this lock before it moves main or the checkout.
  if ! exec 7>"$STATE/restart.lock"; then # under set -e it would end here with no word to anyone (#553 F12b)
    R_OUT="could not open the restart lock"
    report fail "Could not open the restart lock $STATE/restart.lock, so nothing restarted: a person needs to look at it. The checkout is at $(short HEAD), but the server still runs $(health commit | cut -c1-7)."
    exit 1
  fi
  flock 7
  R_LOCK=$(date +%s)
  rm -f "$STATE/now"
  local target good saved
  restart_phase "copying the database"
  target=$(git_live rev-parse HEAD)
  R_COMMIT=${target:0:7} R_TARGET=$target
  # The copy's own error goes in the report (#553 F12e), not only the journal.
  if ! saved=$(backup_db "$target" 2>"$STATE/backup.err"); then
    local cause
    cause=$(grep -v '^[[:space:]]*$' "$STATE/backup.err" 2>/dev/null | head -n 1 | cut -c1-200) || true
    cat "$STATE/backup.err" >&2 2>/dev/null || true
    R_OUT="no database copy"
    report fail "Could not copy the database to ${saved:-$(dirname "$DB")/backups/}${cause:+ ($cause)} before restarting on $(short "$target"), so nothing restarted. The checkout is at $(short "$target"), but the server still runs $(health commit | cut -c1-7). Free some disk or fix the copy, then run tools/deploy.sh again."
    exit 1
  fi
  cat "$STATE/backup.err" >&2 2>/dev/null || true # what the copy said, for the journal, as before
  rm -f "$STATE/backup.err"
  R_BACKUP=$(date +%s)
  [ -n "$saved" ] && say "database copied to $saved"
  say "restarting $SERVICE on $(short "$target")"
  restart_phase "restarting $SERVICE on ${target:0:7}"
  local rc=0
  R_RESTART=$(date +%s)
  restart_healthy "$target" || rc=$?
  R_OUT=$([ "$rc" = 0 ] && echo live || echo "rolled back") R_FIRST="$R_UP $R_SETTLED" # the rollback's restart_healthy sets them again
  if [ "$rc" = 0 ]; then
    git_live tag -f last-good "$target" >/dev/null
    rm -f "$STATE/bad"
    rotate_backups
    local pushed kind=ok
    pushed=$(push_github "$target") || kind=warn
    report "$kind" "Deployed $(short "$target"): the server restarted and is healthy.$pushed"
    return 0
  fi
  local why="the server did not answer healthy on it within ${HEALTHY_WAIT} s"
  [ "$rc" = 2 ] && why="the server answered healthy on it, then stopped answering or was restarted within ${SETTLE} s"
  good=$(git_live rev-parse -q --verify 'last-good^{commit}' || true)
  if [ -z "$good" ] || [ "$good" = "$target" ]; then
    R_OUT="failed, nothing to roll back to"
    report fail "Deploy of $(short "$target") failed: $why, and there is no older last-good commit to roll back to. Check journalctl --user -u $SERVICE."
    exit 1
  fi
  say "rolling back to last-good $(short "$good")"
  restart_phase "rolling back to ${good:0:7}"
  git_live reset -q --hard "$good"
  # Written once the checkout is back, so land.sh finds its commit gone from it. For the deploy that waits on this restart, and for the landings after it while main keeps the commit (land.sh).
  # The commit stays the first one that failed while it is still part of what failed now: a landing on top of it
  # that is rolled back too goes off main again, and the first is what main still holds.
  local held=
  [ ! -s "$STATE/bad" ] || read -r held _ <"$STATE/bad" || true
  { [ -n "$held" ] && git_live merge-base --is-ancestor "$held" "$target" 2>/dev/null && ! git_live merge-base --is-ancestor "$held" "$good" 2>/dev/null; } || held=$target
  echo "$held $good $(date +%s) $target" >"$STATE/bad"
  # Code from before turn units can't re-attach: it would resume turns that still run. Stop them, so
  # it resumes them alone.
  if ! git_live cat-file -e "$good:src/turn-wrapper.ts" 2>/dev/null; then
    say "last-good predates turn units; stopping the running turns so it resumes them"
    systemctl --user stop "$(turn_units)" || true
  fi
  if restart_healthy "$good"; then
    report fail "Deploy of $(short "$target") failed: $why. Rolled back to last-good $(short "$good"), which is up and healthy.${saved:+ The database from before the deploy is in $saved, should the rollback have trouble with what the new code wrote.} A landing takes its commit back off main; after a deploy by hand main still has it: fix forward and deploy again. Details: journalctl --user -u $SERVICE."
  else
    R_OUT="failed, and so did the rollback"
    touch "$STATE/FAILED"
    report fail "Deploy of $(short "$target") failed: $why, and the rollback to $(short "$good") did not come up healthy either. The service is likely down: check journalctl --user -u $SERVICE.${saved:+ The database from before the deploy is in $saved.}"
  fi
  exit 1
}

deploy() {
  init_state
  # The line for the lock, shared with tools/land.sh. Sourced here, not at the top: the queued restart
  # runs a private copy of this file alone, and takes the lock outside the line.
  # shellcheck source=tools/deploy-queue.sh
  . "$(dirname "${BASH_SOURCE[0]}")/deploy-queue.sh"
  # DEPLOY_LOCKED: run by tools/land.sh, which already holds the lock on fd 9 and its place in the line. Trusted
  # (DEPLOY_TESTED with it) only when fd 9 really is this lock file: a leaked env (a test run under a deploy, a
  # nested run) must still wait in line and lock (#514).
  local inherited=
  if [ -n "${DEPLOY_LOCKED:-}" ]; then
    if [ /dev/fd/9 -ef "$STATE/lock" ]; then inherited=1 TIMES=${DEPLOY_TIMES:-}; else say "DEPLOY_LOCKED is set but fd 9 isn't the deploy lock; taking the lock"; fi
  fi
  if [ -z "$inherited" ]; then
    DEPLOY_TESTED=
    queue_lock "$STATE" "tools/deploy.sh" || exit 1
  fi
  # The restart lock too (#566), unless land.sh holds it on fd 7: a restart still being judged has its verdict first.
  if [ -z "$inherited" ] || ! [ /dev/fd/7 -ef "$STATE/restart.lock" ]; then
    restart_lock "$STATE" || exit 1
  fi
  [ -n "$inherited" ] || deploy_unchecked_back "$STATE" "$LIVE" # a deploy killed outright (#553); land.sh has done it when the lock is its own
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
  # $STATE/unchecked: for a kill no trap sees (SIGKILL), the next holder of the lock does the same (deploy-queue.sh).
  local boot_pid=''
  undo() { [ -z "$boot_pid" ] || kill "$boot_pid" 2>/dev/null || true; say "putting the checkout back to $(short "$prev")"; git_live reset -q --hard "$prev"; rm -f "$STATE/unchecked"; }
  trap 'undo; exit 130' INT
  trap 'undo; exit 143' TERM
  trap 'undo; exit 129' HUP
  echo "$prev" >"$STATE/unchecked"
  git_live pull -q --ff-only "$SOURCE" main
  new=$(git_live rev-parse HEAD)
  running=$(health commit)
  kind=$(change_kind "$LIVE" "$running" "$new")
  if [ "$kind" = none ]; then
    trap - INT TERM HUP
    rm -f "$STATE/unchecked" "$STATE/bad" # a revert of the commit that was rolled back ends here: main is good again
    say "nothing to deploy: the server already runs $(short "$new")"
    mark queued
    mark live
    report_me "Nothing to deploy: the server already runs $(short "$new")."
    return 0
  fi
  say "deploying $(short "$new") ($kind change)"

  # Put the checkout back on any failure from here until the restart is queued.
  trap undo ERR
  # DEPLOY_TESTED: the commit tools/land.sh just tested, so the same commit isn't tested twice under the lock;
  # a stray file here (an untracked test) wasn't in that run, so then it tests again.
  if [ "${DEPLOY_TESTED:-}" = "$new" ] && [ -z "$(git_live status --porcelain --ignored)" ]; then
    say "skipping the tests: land.sh just ran them on $(short "$new")"
  else
    say "running the tests"
    queue_phase "deploying: running the tests since $(date +%H:%M)"
    local trc=0
    (cd "$LIVE" && tools/run-tests.sh "$STATE/test.log" 9>&- 7>&-) || trc=$? # without the locks' fds: a run that outlives a killed deploy must not hold it
    if [ "$trc" = 3 ]; then
      say "no test ran: the test run could not write its files (the run-tests line above says which); nothing deployed"
      false
    elif [ "$trc" != 0 ]; then
      tail -n 40 "$STATE/test.log" >&2
      say "tests failed (full log: $STATE/test.log); nothing deployed"
      false
    fi
  fi
  queue_phase "deploying: boot check since $(date +%H:%M)"
  say "boot check: the new code on a spare port with a copy of the database"
  # A limit from outside (#553): boot-check.ts's own is a timer, which a blocking call in the new code defeats, and a
  # check that never returns would hold the lock until a person killed it. timeout stops the check's whole process
  # group, the server and browser it started included. In the background with a wait, so a TERM here runs undo at
  # once (it stops the check) rather than after the check ends. Not as `node`: ananicy would idle it
  # (deploy/priority.md); no lock fd, as with the tests.
  local boot_rc=0 boot_since=$SECONDS
  timeout -k 10 "$BOOT_TIMEOUT" "$LIVE/tools/citadel-node" "$LIVE/tools/boot-check.ts" "$LIVE" "$DB" >"$STATE/boot.out" 9>&- 7>&- &
  boot_pid=$!
  wait "$boot_pid" || boot_rc=$?
  boot_pid=
  version=$(cat "$STATE/boot.out")
  if [ "$boot_rc" != 0 ]; then
    # 124: timeout stopped it. 137 only past the limit (its KILL after a TERM that didn't take): sooner, something else killed it.
    if [ "$boot_rc" = 124 ] || { [ "$boot_rc" = 137 ] && [ $((SECONDS - boot_since)) -ge "$BOOT_TIMEOUT" ]; }; then
      say "the boot check hung: stopped after $BOOT_TIMEOUT s, far past its own limit. That is not a verdict on the change (a failed check says what broke): run it again, and if it hangs again, look for a call in the new code that blocks the server's start. Nothing deployed"
    else
      say "boot check failed; nothing deployed"
    fi
    false
  fi
  trap - ERR INT TERM HUP
  rm -f "$STATE/unchecked"

  queue_phase "deploying: going live"
  if [ "$kind" = frontend ] && [ "$(health reload)" = sighup ]; then
    systemctl --user kill -s HUP --kill-whom=main "$SERVICE"
    mark queued
    for _ in $(seq 10); do
      sleep 1
      if [ "$(health version)" = "$version" ]; then
        mark live
        git_live tag -f last-good "$new" >/dev/null
        rm -f "$STATE/bad"
        say "live now: the server reloaded the front end ($version); open tabs reload when idle. No restart."
        local pushed kind=ok
        pushed=$(push_github "$new") || kind=warn
        report_me "Deployed $(short "$new"): the server reloaded the front end, no restart.$pushed" "$kind"
        return 0
      fi
    done
    say "the server did not pick up the new front end on SIGHUP; queuing a restart instead"
  fi

  # The restart runs after this turn ends, so remember who to tell how it went, and which commit was this deploy's.
  # Only once a restart is queued (#553 M10): a line for none would go to whichever restart came next. The restart
  # reads it only once it has the lock, which this holds until below, or after its 2 h wait for turns.
  reporter() {
    if [ -n "${COORDINATOR_TICKET:-}" ] && [ -n "${COORDINATOR_TOKEN:-}" ]; then
      (umask 077 && echo "${COORDINATOR_API:-$URL} $COORDINATOR_TOKEN $COORDINATOR_TICKET" >>"$STATE/reporters" && echo "$COORDINATOR_TICKET $new" >>"$STATE/reporter-commits")
    fi
  }
  # The unit runs a private copy of the version just pulled, so a later pull or a rollback can't
  # rewrite the script under it.
  local copy="$STATE/restart-$new-$$.sh"
  cp "$LIVE/tools/deploy.sh" "$copy"
  local out
  if out=$(systemd-run --user --collect --unit="$UNIT" --description="Restart $SERVICE (tools/deploy.sh)" \
    --setenv=DEPLOY_LIVE="$LIVE" --setenv=DEPLOY_SERVICE="$SERVICE" --setenv=DEPLOY_URL="$URL" --setenv=DEPLOY_DB="$DB" \
    --setenv=DEPLOY_IDLE_TRIES="$IDLE_TRIES" --setenv=DEPLOY_HEALTHY_WAIT="$HEALTHY_WAIT" --setenv=DEPLOY_SETTLE="$SETTLE" --setenv=DEPLOY_REPORT_WAIT="$REPORT_WAIT" --setenv=DEPLOY_REMOTE="$REMOTE" \
    --setenv=DEPLOY_NOW="$NOW" --setenv=DEPLOY_UNKNOWN_WAIT="$UNKNOWN_WAIT" --setenv=DEPLOY_IDLE_POLL="$IDLE_POLL" --setenv=DEPLOY_BACKUPS="$BACKUPS" --setenv=PATH="$PATH" \
    --setenv=COORDINATOR_SHARED_DIR="${COORDINATOR_SHARED_DIR:-}" \
    bash "$copy" restart 2>&1 9>&- 7>&-); then
    reporter
    mark queued
    if [ -n "$NOW" ]; then say "restart queued as $UNIT with --now: it restarts at once, cutting off turns not in a unit of their own (this one too, if so)"
    else say "restart queued as $UNIT: running turns carry on through it, and it reports here"; fi
  elif grep -qi 'already' <<<"$out"; then
    rm -f "$copy"
    reporter
    mark queued
    if [ -n "$NOW" ]; then
      touch "$STATE/now"
      say "a restart is already queued as $UNIT; with --now it goes ahead at once and deploys this too, and reports here"
    else say "a restart is already queued as $UNIT; it will deploy this too and report here"; fi
    return 0
  else
    rm -f "$copy"
    say "could not queue the restart ($(grep -v '^[[:space:]]*$' <<<"$out" | head -n 1 | cut -c1-200)), so nothing restarted: the live checkout is at $(short "$new"), but the server still runs $(health commit | cut -c1-7). Run tools/deploy.sh again to queue it"
    exit 1
  fi
  # The queued restart takes the restart lock before it restarts: let go, or it waits out the wait below. The deploy
  # lock goes with it, so the next in line rebases and passes its gate while that restart is judged (#566).
  queue_done ok
  flock -u 9
  flock -u 7
  # Usually it is live within seconds and checked again SETTLE s later (last-good moves); say how that went here, as
  # this turn carries on through the restart. A rollback fails this deploy (#553), so land.sh takes the commit off main.
  local bad was limit=$((HEALTHY_WAIT * 2 + SETTLE + 15))
  was=$(cat "$STATE/bad" 2>/dev/null || true)
  for _ in $(seq "$limit"); do
    sleep 1
    if git_live merge-base --is-ancestor "$new" last-good 2>/dev/null; then
      mark live
      say "live now: the server restarted on $(short "$new") and stayed healthy"
      return 0
    fi
    bad=$(cat "$STATE/bad" 2>/dev/null || true)
    if [ -n "$bad" ] && [ "$bad" != "$was" ] && git_live merge-base --is-ancestor "$new" "${bad##* }" 2>/dev/null; then
      say "the restart on $(short "${bad##* }") failed and was rolled back; its report in this chat says why (see journalctl --user -u $UNIT)"
      exit 1
    fi
  done
  # The usual reason (#553): the restart waits for running turns, up to 2 h, and this line was all the landing heard.
  local n
  n=$(interruptible)
  if [ -z "$NOW" ] && [[ $n =~ ^[1-9][0-9]*$ ]]; then
    say "not live yet: the restart is waiting for $(turns "$n") a restart would cut off to finish (at most $((IDLE_TRIES * 10 / 60)) min more), and reports here when it is live. To restart without waiting: tools/deploy.sh --now (see journalctl --user -u $UNIT)"
  else
    say "not live yet after $limit s; the restart reports here when it is (see journalctl --user -u $UNIT)"
  fi
}

case "${1:-}" in
  '') deploy ;;
  --now) NOW=1 deploy ;;
  restart) restart ;;
  interruptible) interruptible ;;
  waiting-on) turns "$(interruptible)" ;;
  turn-units) turn_units ;;
  change-kind) change_kind "$2" "$3" "$4" ;;
  push-github) push_github "$2" ;;
  post-report) post_report "$2" "$3" "$4" "$5" "$6" ;;
  backup-db) backup_db "$2" ;;
  rotate-backups) rotate_backups ;;
  *) echo "usage: $0 [--now | interruptible | waiting-on | turn-units | change-kind <dir> <from> <to> | push-github <commit> | post-report <api> <token> <ticket> <ok|warn|fail> <text> | backup-db <commit> | rotate-backups]" >&2; exit 2 ;;
esac
