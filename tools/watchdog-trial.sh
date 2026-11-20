#!/usr/bin/env bash
# The watchdog's trial on a scratch unit (#1135), run on perigee before installing
# deploy/claude-coordinator.service.d/watchdog.conf. It starts this checkout's server.ts as a transient user unit with
# the drop-in's settings, on an empty data folder in preview mode (no turns, no pushes) and a free port, then:
#   1. load: 150 s of HTTP requests plus half the CPUs busy; the server must not be restarted;
#   2. hang: its event loop is blocked through the inspector; systemd must restart it inside 75 s, and the new
#      server must record the restart as a health event.
# It stops and removes its own unit and folder. Never touches claude-coordinator.service. Takes about 5 minutes.
#   bash tools/watchdog-trial.sh [load seconds, default 150]
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
load_s=${1:-150}
unit="citadel-watchdog-trial-$$"
data=$(mktemp -d "${TMPDIR:-/tmp}/watchdog-trial.XXXXXX")
free_port() { while :; do p=$(shuf -i 20000-60000 -n1); ss -ltn "sport = :$p" | grep -q LISTEN || { echo "$p"; return; }; done; }
port=$(free_port)
insp=$(free_port)
burners=()
cleanup() {
  for b in "${burners[@]}"; do kill "$b" 2>/dev/null || true; done
  systemctl --user stop "$unit" 2>/dev/null || true
  rm -rf "${data:?}"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
mainpid() { systemctl --user show "$unit" -p MainPID --value; }
up() { for _ in $(seq 60); do curl -sf -o /dev/null "http://127.0.0.1:$port/" && return 0; sleep 1; done; return 1; }

systemd-run --user --quiet --unit="$unit" --collect \
  -p WatchdogSec=60 -p NotifyAccess=all -p WatchdogSignal=SIGKILL -p Restart=always -p RestartSec=3 \
  -p "ExecStopPost=-/usr/bin/node $root/tools/watchdog-exit.ts" \
  --working-directory="$root" \
  --setenv=PATH="$PATH" --setenv=HOST=127.0.0.1 --setenv=PORT="$port" --setenv=DATA_DIR="$data" \
  --setenv=PREVIEW=1 --setenv=BOOT_CHECK=1 --setenv=CLAUDE_BIN=/bin/false --setenv=CLAUDE_CONFIG_DIR="$data/claude" \
  --setenv=COORDINATOR_PASSWORD=watchdog-trial-password --setenv=SESSION_SECRET="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" \
  /usr/bin/node --inspect=127.0.0.1:"$insp" "$root/server.ts"
up || fail "the scratch server didn't answer on port $port in 60 s"
first=$(mainpid)
echo "Scratch unit $unit up: pid $first, port $port."
journalctl --user -u "$unit" -g "watchdog is on" -o cat | tail -1

echo "1. Load for $load_s s: HTTP requests and $(( $(nproc) / 2 )) busy CPUs."
for _ in $(seq $(( $(nproc) / 2 ))); do timeout "$load_s" sh -c 'while :; do :; done' & burners+=($!); done
for _ in 1 2 3 4 5 6 7 8; do timeout "$load_s" sh -c "while :; do curl -s -o /dev/null http://127.0.0.1:$port/; curl -s -o /dev/null http://127.0.0.1:$port/api/projects; done" & burners+=($!); done
wait "${burners[@]}" 2>/dev/null || true
burners=()
[ "$(mainpid)" = "$first" ] || fail "restarted under load (pid $first is now $(mainpid))"
[ "$(systemctl --user show "$unit" -p NRestarts --value)" = 0 ] || fail "NRestarts isn't 0 after the load"
echo "   Not restarted under load; last ping $(systemctl --user show "$unit" -p WatchdogTimestamp --value)."

echo "2. Hang: blocking the event loop through the inspector."
node --input-type=module -e '
  const [{ webSocketDebuggerUrl }] = await (await fetch(`http://127.0.0.1:${process.argv[1]}/json/list`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "while (true) {}" } }));
  setTimeout(() => process.exit(0), 500);' "$insp"
t0=$(date +%s)
while [ "$(mainpid)" = "$first" ] || [ "$(mainpid)" = 0 ]; do
  [ $(( $(date +%s) - t0 )) -lt 120 ] || fail "not restarted 120 s after the hang"
  sleep 1
done
took=$(( $(date +%s) - t0 ))
[ "$took" -le 75 ] || fail "restarted, but after $took s (limit 75)"
echo "   Restarted after $took s: pid $(mainpid)."
up || fail "the restarted server didn't answer in 60 s"
journalctl --user -u "$unit" -g "Watchdog timeout" -o cat | tail -1
event=$(sqlite3 -readonly "$data/coordinator.db" "SELECT detail FROM health_events WHERE kind = 'watchdog'")
[ -n "$event" ] || fail "no watchdog health event after the restart"
echo "   Health event: $event"
echo "PASS"
