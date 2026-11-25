#!/usr/bin/env bash
# [DEBUG-2009] probe, never ships
here=$(cd "$(dirname "$0")" && pwd)
export PROBE_LOG=$RUNNER_TEMP/probe.log
echo "cores $(nproc)"; [ -r /proc/pressure/cpu ] && echo psi ok
for r in 1 2 3; do
  : >"$PROBE_LOG"
  for i in $(seq 18); do read -r l _ </proc/loadavg; [ "${l%.*}" -lt 5 ] && break; sleep 5; done
  (for i in $(seq 90); do echo "S $i $(cat /proc/loadavg) $(head -1 /proc/pressure/cpu)"; sleep 1; done) & s=$!
  nice -n 19 "$here/burn-in.sh" "$1" 10 | tail -60
  kill $s; echo "== round $r"; cat "$PROBE_LOG"
done
exit 1
