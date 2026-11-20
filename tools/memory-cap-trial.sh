#!/usr/bin/env bash
# Does a container's memory cap hold? (#1214) Run on perigee as the user Citadel runs as:
#   bash ~/claude-coordinator/tools/memory-cap-trial.sh
# It starts two throwaway containers from the citadel-claude image the way src/containers.ts starts a person's
# container (systemd-run --user in citadel.slice, podman --cgroups=split, OOMPolicy=continue), each asked for
# 600M against a 256M cap:
#   old: the cap as podman --memory, what Citadel did until #1214. It held in a throwaway container on 2026-11-20 but
#        not in the long-lived ones (their payload cgroup had no memory controller), so its result is shown, not judged.
#   new: the cap as MemoryMax on the systemd unit, what Citadel does now. Expect an OOM kill inside that unit only.
# No MemoryHigh in the trial: with no swap, a unit past MemoryHigh is throttled to a crawl and never reaches MemoryMax
# in the minute this waits (the first run, 2026-11-20, sat at 221M of 256M).
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
  if systemctl --user is-active -q "$unit"; then echo "  $unit: still running after 60 s, stopping it"; systemctl --user stop "$unit"; fi
  local log peak
  log=$(journalctl --user -u "$unit" --no-pager -o cat 2>/dev/null)
  peak=$(systemctl --user show -p MemoryPeak --value "$unit" 2>/dev/null)
  systemctl --user reset-failed "$unit" 2>/dev/null
  echo "  $unit: peak ${peak:-?}"
  # -x: the journal's "Started" line quotes the whole command, GOT-600M included; only the container's own output is the line alone.
  echo "$log" | grep -E -x 'GOT-600M|.*OOM killer.*' | sed 's/^/    /'
  if echo "$log" | grep -q -x 'GOT-600M'; then return 0; fi
  if echo "$log" | grep -q 'OOM killer'; then return 1; fi
  return 3
}

echo "old way: podman --memory 256m"
trial old -- --memory 256m; old=$?
echo "new way: MemoryMax=256M on the unit"
trial new -p MemoryMax=256M -p MemorySwapMax=0 --; new=$?

case $old in 0) echo "old: got 600M past its 256m cap";; 1) echo "old: OOM-killed at its 256m cap";; *) echo "old: no result (code $old)";; esac
[ $new -eq 1 ] && echo "new: OOM-killed inside its own unit" || echo "new: not OOM-killed (code $new)"
if [ $new -eq 1 ]; then echo PASS; else echo FAIL; exit 1; fi
