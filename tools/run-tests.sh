#!/usr/bin/env bash
# The test run land.sh and deploy.sh make while holding the deploy lock, so it must always end (#377):
#   tools/run-tests.sh <log>     (from the repo to test; exits with the tests' status)
# --test-force-exit ends a test file once its tests are done even if one leaked a handle (a server a
# failed test never closed), and the time limit stops a test that hangs outright, with a line saying so.
# DEPLOY_TEST_TIMEOUT sets the limit in seconds (default 600; the suite takes 1-2 minutes).
#
# A red run stays red (Cara, 2026-11-10, "Keep failing, log it"). When it fails, each failed file runs again alone,
# once, only to label it: one that passes alone is a likely flake from load, and gets a `flake` line with the load
# average in the scheme's retro log (retro-log/<date>/land.md) so flaky files get counted. A hang is never rerun.
# DEPLOY_RERUN_TIMEOUT limits each rerun in seconds (default 180).
set -uo pipefail
log=$1
limit=${DEPLOY_TEST_TIMEOUT:-600}
rerun_limit=${DEPLOY_RERUN_TIMEOUT:-180}
max_reruns=5 # more failed files than this is a broken change, not load
tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
failed=$(mktemp)
trap 'rm -f "$failed"' EXIT
timeout -k 30 "$limit" node --test --test-force-exit --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter="$tools/failed-files-reporter.ts" --test-reporter-destination="$failed" test/ >"$log" 2>&1
rc=$?
load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null) || load='?'
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  echo "run-tests: the tests ran past ${limit}s and were stopped: a test hung (the hung file is the one with no results above)." | tee -a "$log" >&2
fi
[ "$rc" -eq 1 ] || exit "$rc" # green, hung or killed: nothing to rerun

mapfile -t files <"$failed"
say() { echo "run-tests: $*" >>"$log"; }
[ "${#files[@]}" -gt 0 ] || exit "$rc"
if [ "${#files[@]}" -gt "$max_reruns" ]; then
  say "${#files[@]} test files failed: too many for load, so none is rerun"
  exit "$rc"
fi

# Best effort, as land.sh's conflict lines: no shared folder or a failed write never changes the run's result.
log_flake() (
  set +e
  [ -n "${COORDINATOR_SHARED_DIR:-}" ] || exit 0
  dir=$COORDINATOR_SHARED_DIR/retro-log/$(date -u +%F)
  mkdir -p "$dir" || exit 0
  [ -e "$dir/land.md" ] || printf '# Retro log: land.sh\n\nWritten by tools/land.sh and tools/run-tests.sh (no session id, so one file per day). One line per rebase conflict, and per test file that failed in a land or deploy run and passed alone (flake).\n\n' >>"$dir/land.md"
  branch=$(git branch --show-current 2>/dev/null)
  printf -- '- %sZ · flake · %s · load %s%s\n' "$(date -u +%T)" "$1" "$load" "${branch:+ · $branch}" >>"$dir/land.md"
) >/dev/null 2>&1

rerun_log=${log%.log}-rerun.log
: >"$rerun_log"
say "${#files[@]} test file(s) failed; rerunning each alone once to tell load from a real failure (the run fails either way; output in $rerun_log)"
for f in "${files[@]}"; do
  echo "== $f" >>"$rerun_log"
  timeout -k 10 "$rerun_limit" node --test --test-force-exit "$f" >>"$rerun_log" 2>&1
  case $? in
    0) say "$f: failed in the full run, passed alone: likely load, not your change (1-minute load $load)"; log_flake "$f" ;;
    124 | 137) say "$f: hung when rerun alone (stopped after ${rerun_limit}s): a real failure" ;;
    *) say "$f: failed again alone: a real failure" ;;
  esac
done
say "the run still fails: a rerun only labels flakes, it never turns a red run green"
exit "$rc"
