#!/usr/bin/env bash
# Does a container's memory cap hold? (#1214) Run on perigee as the user Citadel runs as:
#   bash ~/claude-coordinator/tools/memory-cap-trial.sh
# It starts two throwaway containers from the citadel-claude image the way src/containers.ts starts a person's
# container (systemd-run --user in citadel.slice, podman --cgroups=split, OOMPolicy=continue), each asked for
# 600M against a 256M cap:
#   old: the cap as podman --memory, what Citadel did until #1214. Expect it to get its 600M: the cap never held.
#   new: the cap as MemoryMax on the systemd unit, what Citadel does now. Expect an OOM kill inside that unit only.
# Each takes a few seconds and holds at most 600M; nothing else is touched. Prints PASS or FAIL.
set -u
image=$(podman images --format '{{.Repository}}:{{.Tag}}' localhost/citadel-claude | head -n 1)
[ -n "$image" ] || { echo "FAIL: no localhost/citadel-claude image on this box"; exit 1; }
# `tail` holds a whole line in memory, and /dev/zero has no newlines: 600M of it needs 600M of RAM.
grab='head -c 600M /dev/zero | tail >/dev/null && echo GOT-600M'

trial() { # name, extra systemd-run properties..., --, extra podman arguments...
  local unit="citadel-cap-trial-$1-$$" props=() pod=()
  shift
  while [ $# -gt 0 ] && [ "$1" != -- ]; do props+=("$1"); shift; done
  [ $# -gt 0 ] && shift
  pod=("$@")
  systemd-run --user --quiet --unit="$unit" --slice=citadel.slice -p TimeoutStopSec=20 -p OOMPolicy=continue "${props[@]}" \
    podman run --rm --init --userns=keep-id --network=host --cgroups=split "${pod[@]}" "$image" sh -c "$grab" || return 2
  for _ in $(seq 60); do systemctl --user is-active -q "$unit" || break; sleep 1; done
  local log peak
  log=$(journalctl --user -u "$unit" --no-pager -o cat 2>/dev/null)
  peak=$(systemctl --user show -p MemoryPeak --value "$unit" 2>/dev/null)
  systemctl --user reset-failed "$unit" 2>/dev/null
  echo "  $unit: peak ${peak:-?}"
  echo "$log" | grep -E 'GOT-600M|OOM|oom' | sed 's/^/    /'
  if echo "$log" | grep -q 'GOT-600M'; then return 0; fi
  if echo "$log" | grep -qi 'oom'; then return 1; fi
  return 3
}

echo "old way: podman --memory 256m"
trial old -- --memory 256m; old=$?
echo "new way: MemoryMax=256M on the unit"
trial new -p MemoryHigh=200M -p MemoryMax=256M -p MemorySwapMax=0 --; new=$?

[ $old -eq 0 ] && echo "old: got 600M past its 256m cap (the cap never held)" || echo "old: did not get 600M (code $old)"
[ $new -eq 1 ] && echo "new: OOM-killed inside its own unit" || echo "new: not OOM-killed (code $new)"
if [ $new -eq 1 ]; then echo PASS; else echo FAIL; exit 1; fi
