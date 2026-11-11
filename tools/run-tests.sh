#!/usr/bin/env bash
# The test run land.sh and deploy.sh make while holding the deploy lock, so it must always end (#377):
#   tools/run-tests.sh <log>     (from the repo to test; exits with the tests' status)
# --test-force-exit ends a test file once its tests are done even if one leaked a handle (a server a
# failed test never closed), and the time limit stops a test that hangs outright, with a line saying so.
# DEPLOY_TEST_TIMEOUT sets the limit in seconds (default 600; the suite takes 1-2 minutes).
#
# Test files run at most half the cores at once (#521): node's default is about 15 at a time on the 16-core box, and since
# #506 took away the idle-priority brake one run could fill it. CITADEL_TEST_CONCURRENCY overrides the number (npm test
# reads it too).
#
# A red run stays red (Cara, 2026-11-10, "Keep failing, log it"). When it fails, each failed file runs again alone,
# once, only to label it: one that passes alone is a likely flake from load, and gets a `flake` line with the load
# average in the scheme's retro log (retro-log/<date>/land.md) so flaky files get counted. A hang is never rerun.
# The reruns hold the deploy lock too, and a waiting land gives up after 15 minutes: DEPLOY_RERUN_TIMEOUT limits
# each in seconds (default 120), DEPLOY_RERUN_BUDGET all of them together (default 300); a file left over is not rerun.
#
# Landing tests win over routine checks (#503): the run and its reruns get their own systemd scope in citadel.slice
# with CPUWeight=500, beside the host turns' slice and each person's container (100 each) and under the server's
# 1000, so the one test run holding the deploy lock isn't starved by minions' builds and the server stays first.
# When it runs in a unit of the user manager (the landing turn, or the server for a container's land tool), the
# scope is bound to it, so stopping that unit still stops the tests, as before. DEPLOY_TEST_CPU_WEIGHT sets the
# weight (empty: no scope). Without a user systemd to ask (no bus, no such slice) it runs as before, unweighted.
#
# While the full run goes, <log without .log>.progress holds its file counts (#545: tools/citadel-node and
# tools/progress-reporter.ts), for the landing's wait in Citadel; it goes once the full run ends, before any rerun.
set -uo pipefail
log=$1
limit=${DEPLOY_TEST_TIMEOUT:-600}
rerun_limit=${DEPLOY_RERUN_TIMEOUT:-120}
budget=${DEPLOY_RERUN_BUDGET:-300}
concurrency=${CITADEL_TEST_CONCURRENCY:-$((($(nproc 2>/dev/null || echo 2) + 1) / 2))}
max_reruns=5 # more failed files than this is a broken change, not load
tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
weight=${DEPLOY_TEST_CPU_WEIGHT-500}
# npm test's leak guard, on the full run only: green tests that leave processes running are a red run (a rerun only labels).
guard=()
[ -r test/leak-guard.ts ] && guard=(--test-global-setup=test/leak-guard.ts)
cgroup=$(sed -n 's|^0::||p' /proc/self/cgroup 2>/dev/null)
scope=(systemd-run --user --scope --quiet --collect --slice=citadel.slice -p "CPUWeight=$weight")
# Only a unit below the user manager: a login's session-N.scope belongs to the system manager, which --user can't bind to.
[[ $cgroup =~ /user@[0-9]+\.service/.+/([^/]+\.(service|scope))$ ]] && scope+=(-p "BindsTo=${BASH_REMATCH[1]}")
scope+=(--)
[ -n "$weight" ] && timeout 20 "${scope[@]}" true >/dev/null 2>&1 || scope=()
failed=$(mktemp)
progress=${log%.log}.progress
unset CITADEL_TEST_PROGRESS # the reruns below count nothing
rm -f "$progress" "$progress.tmp"
trap 'rm -f "$failed" "$progress" "$progress.tmp"' EXIT
CITADEL_TEST_PROGRESS=$progress timeout -k 30 "$limit" "${scope[@]}" "$tools/citadel-node" --test --test-concurrency="$concurrency" --test-force-exit "${guard[@]}" --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter="$tools/failed-files-reporter.ts" --test-reporter-destination="$failed" test/ >"$log" 2>&1
rc=$?
rm -f "$progress" "$progress.tmp"
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
  [ -e "$dir/land.md" ] || printf '# Retro log: land.sh\n\nWritten by tools/land.sh and tools/run-tests.sh (no session id, so one file per day). One line per rebase conflict, per landing that fell back from CI to the suite on perigee, and per test file that failed in a land or deploy run and passed alone (flake).\n\n' >>"$dir/land.md"
  branch=$(git branch --show-current 2>/dev/null)
  printf -- '- %sZ · flake · %s · load %s%s\n' "$(date -u +%T)" "$1" "$load" "${branch:+ · $branch}" >>"$dir/land.md"
) >/dev/null 2>&1

rerun_log=${log%.log}-rerun.log
: >"$rerun_log"
say "${#files[@]} test file(s) failed; rerunning each alone once to tell load from a real failure (the run fails either way; output in $rerun_log)"
SECONDS=0
for f in "${files[@]}"; do
  left=$((budget - SECONDS))
  if [ "$left" -le 0 ]; then
    say "$f: not rerun: the reruns' ${budget}s ran out"
    continue
  fi
  this=$((left < rerun_limit ? left : rerun_limit))
  echo "== $f" >>"$rerun_log"
  timeout -k 10 "$this" "${scope[@]}" "$tools/citadel-node" --test --test-force-exit "$f" >>"$rerun_log" 2>&1
  case $? in
    0) say "$f: failed in the full run, passed alone: likely load, not your change (1-minute load $load)"; log_flake "$f" ;;
    124 | 137) say "$f: hung when rerun alone (stopped after ${this}s): a real failure" ;;
    *) say "$f: failed again alone: a real failure" ;;
  esac
done
say "the run still fails: a rerun only labels flakes, it never turns a red run green"
exit "$rc"
