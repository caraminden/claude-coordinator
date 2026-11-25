#!/usr/bin/env bash
# Does a Taskmaster answer while its person's minions hold their container at its limit? (#1882) Run on perigee as the
# user Citadel runs as:
#   bash ~/claude-coordinator/tools/taskmaster-room-trial.sh
# It fills a throwaway container to its MemoryHigh (256M, no swap, so it can't give any back), then times the same
# stand-in for a turn (a process that starts, fills 200M, a Taskmaster turn's size, and prints) started two ways:
#   old: inside the full container, where a Taskmaster's turns ran until #1882.
#   new: in a container of its own in citadel-taskmasters.slice, started from cold, as src/claude-link.ts does.
# No model call and no login. Holds at most 700M for a minute or two and stops what it started. Prints PASS or FAIL.
set -u
limit=60 # seconds either way may take
image=$(podman images --format '{{.Repository}}:{{.Tag}}' localhost/citadel-claude | head -n 1)
[ -n "$image" ] || { echo "FAIL: no localhost/citadel-claude image on this box"; exit 1; }
full=citadel-claude-trial-full-$$ own=citadel-claude-trial-own-$$
turn='Buffer.alloc(200 << 20, 1); console.log("ANSWERED")'
# Grows until the kernel throttles it, then keeps asking: the container stays at its limit.
hog='const a = []; setInterval(() => a.push(Buffer.alloc(4 << 20, 1)), 20)'

start() { # name, slice, systemd properties..., --, command...
  local name=$1 slice=$2 props=()
  shift 2
  while [ "$1" != -- ]; do props+=(-p "$1"); shift; done
  shift
  systemd-run --user --collect --quiet --unit="$name" --slice="$slice" -p TimeoutStopSec=20 -p OOMPolicy=continue "${props[@]}" \
    podman run --rm --name "$name" --init --userns=keep-id --network=host --cgroups=split "$image" "$@"
}
stop() { podman rm -f -t 0 "$1" >/dev/null 2>&1; systemctl --user stop "$1" 2>/dev/null; }
trap 'stop "$full"; stop "$own"' EXIT
running() { for _ in $(seq 150); do [ "$(podman container inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ] && return; sleep 0.2; done; return 1; }
now() { date +%s%N; }
ms() { echo $((($(now) - $1) / 1000000)); }

# MemoryMax well over MemoryHigh: the trial is about being throttled, not OOM-killed.
start "$full" citadel.slice MemoryHigh=256M MemoryMax=1G MemorySwapMax=0 -- node -e "$hog" && running "$full" || { echo "FAIL: the full container didn't start"; exit 1; }
# At its limit: past 90% of MemoryHigh and throttled by it at least once.
cg=/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value "$full")
for _ in $(seq 60); do
  high=$(awk '$1 == "high" { print $2 }' "$cg/memory.events")
  held=$(cat "$cg/memory.current")
  [ "${high:-0}" -gt 0 ] && [ "${held:-0}" -gt $((230 << 20)) ] && break
  sleep 0.5
done
echo "full container: $((${held:-0} >> 20))M of 256M, throttled ${high:-0} times"
[ "${high:-0}" -gt 0 ] || { echo "FAIL: the container never reached its limit, so this proves nothing"; exit 1; }

# Still full, and still being throttled: a hog that died would make both timings mean nothing.
still() {
  local was=${high:-0}
  high=$(awk '$1 == "high" { print $2 }' "$cg/memory.events" 2>/dev/null)
  [ "${high:-0}" -gt "$was" ] && [ "$(cat "$cg/memory.current" 2>/dev/null || echo 0)" -gt $((230 << 20)) ] || { echo "FAIL: the full container didn't stay at its limit $1, so this proves nothing"; exit 1; }
}

t=$(now)
old=$(timeout -k 5 "$limit" podman exec "$full" node -e "$turn" 2>/dev/null); oldrc=$?; oldms=$(ms "$t")
still 'while the old way ran'
# 124 and 137 are timeout's own: it was stuck. Any other failure with no answer isn't the stall this looks for.
[ "$old" = ANSWERED ] || [ "$oldrc" = 124 ] || [ "$oldrc" = 137 ] || { echo "FAIL: the old way broke (exit $oldrc) rather than stalled"; exit 1; }
[ "$old" = ANSWERED ] && echo "old (in the full container): answered in $oldms ms" || echo "old (in the full container): no answer in $oldms ms"
t=$(now)
start "$own" citadel-taskmasters.slice MemoryHigh=3G MemoryMax=4G MemorySwapMax=2G ManagedOOMPreference=omit -- sleep infinity && running "$own" || { echo "FAIL: the Taskmaster's container didn't start"; exit 1; }
new=$(timeout -k 5 "$limit" podman exec "$own" node -e "$turn" 2>/dev/null); newms=$(ms "$t")
still 'while the new way ran'
[ "$new" = ANSWERED ] && echo "new (its own container, started from cold): answered in $newms ms" || echo "new (its own container): no answer in $newms ms"
# What it costs to keep it up with no turn in it.
echo "its own container, idle: $(($(cat "/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value "$own")/memory.current") >> 20))M"
if [ "$new" = ANSWERED ] && { [ "$old" != ANSWERED ] || [ "$oldms" -gt $((newms * 3)) ]; }; then echo PASS; else echo FAIL; exit 1; fi
