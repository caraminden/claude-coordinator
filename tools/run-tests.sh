#!/usr/bin/env bash
# The test run land.sh and deploy.sh make while holding the deploy lock, so it must always end (#377):
#   tools/run-tests.sh <log>     (from the repo to test; exits with the tests' status)
# --test-force-exit ends a test file once its tests are done even if one leaked a handle (a server a
# failed test never closed), and the time limit stops a test that hangs outright, with a line saying so.
# DEPLOY_TEST_TIMEOUT sets the limit in seconds (default 600; the suite takes 1-2 minutes).
# Each test (and hook) also has its own limit, CITADEL_TEST_TIMEOUT seconds (default 60; the slowest without its own
# { timeout } takes about 14 s), so one hang fails in a minute by name instead of holding the deploy lock for the whole
# limit (#999; tools/citadel-test and npm test use it too). Before any test, tools/parse-check.ts fails the run on a
# tracked .ts file that doesn't parse, which would hang every test that starts it.
#
# Test files run at most half the cores at once (#521): node's default is about 15 at a time on the 16-core box, and since
# #506 took away the idle-priority brake one run could fill it. CITADEL_TEST_CONCURRENCY overrides the number (npm test
# reads it too).
#
# A red run stays red here (Cara, 2026-11-10, "Keep failing, log it"). When it fails, each failed file runs again alone,
# once, only to label it: one that passes alone is a likely flake from load, and gets a `flake` line with the load
# average in the scheme's retro log (retro-log/<date>/land.md) so flaky files get counted. A hang is never rerun.
# The labels are what land.sh's CI gate reads (Cara, 2026-11-15, #767's card: "2 Rerun CI on flake-only red"): when
# every failed file in a CI run passed alone, it asks CI for one fresh run, which must be fully green to land. So the
# "<n> test file(s) failed; rerunning" line and the per-file labels below are its input: test/land.test.ts pins them.
# The reruns hold the deploy lock too, and a waiting land gives up after 15 minutes: DEPLOY_RERUN_TIMEOUT limits
# each in seconds (default 120, or 1.5 times the file's time in the full run when that is longer: test/land-overlap.test.ts takes
# about 190 s alone), DEPLOY_RERUN_BUDGET all of them together (default 300); a file left over is not rerun.
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
#
# Exit 3: no test ran, because its temp file or log could not be written (a full or read-only TMPDIR, an unwritable
# log): a line on stderr says which, so the caller doesn't call it a red run (#553 F12a). node --test never exits 3.
set -uo pipefail
log=$1
limit=${DEPLOY_TEST_TIMEOUT:-600}
rerun_limit=${DEPLOY_RERUN_TIMEOUT:-120}
test_limit=$((${CITADEL_TEST_TIMEOUT:-60} * 1000)) # each test, in ms (#999); a test's own { timeout } wins
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
failed=$(mktemp) || { echo "run-tests: could not make a temp file in ${TMPDIR:-/tmp} (full, or not writable), so no test ran" >&2; exit 3; }
: >"$log" || { rm -f "$failed"; echo "run-tests: could not write the log $log, so no test ran" >&2; exit 3; }

# The pipeline's own tests (#581): tools/pipeline-files.txt lists the pipeline's files and the test files that run only
# its scripts. A change that touches none of those paths against main (origin/main on CI, which has no local main)
# runs every test file but those; a run with no main to compare with or nothing changed (main itself: the nightly,
# deploy.sh in the live checkout) runs them all. With the list in the repo the log's first line says which ran.
pipeline_tier() {
  local base changed path entry entries
  base=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null) || { why="no main to compare with"; return 1; }
  # --no-renames: a pipeline file renamed away shows under its old name too.
  changed=$(git diff --no-renames --name-only "$base" HEAD) || { why="git diff against main failed"; return 1; }
  [ -n "$changed" ] || { why="nothing changed against main"; return 1; }
  mapfile -t entries < <(tr -d '\r' <"$list" | sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d')
  while IFS= read -r path; do
    for entry in "${entries[@]}"; do
      if [ "$path" = "$list" ] || [ "$path" = "$entry" ] || [[ $entry == */ && $path == "$entry"* ]]; then
        why="$path is a pipeline file"
        return 1
      fi
    done
  done <<<"$changed"
  gated=()
  for entry in "${entries[@]}"; do [[ $entry == test/*.test.* ]] && gated+=("$entry"); done
}
targets=(test/)
list=tools/pipeline-files.txt
if [ -r "$list" ]; then
  why= gated=()
  if pipeline_tier; then
    shopt -s nullglob
    targets=()
    for f in test/*.test.{ts,js,mjs,cjs,mts,cts}; do
      [[ " ${gated[*]} " == *" $f "* ]] || targets+=("$f") # node --test test/ runs these and no other (test/pipeline-files.test.ts)
    done
    shopt -u nullglob
    [ "${#targets[@]}" -gt 0 ] || targets=(test/)
    echo "run-tests: tier product (the ${#gated[@]} pipeline test files left out): this change touches nothing in $list" >>"$log"
  else
    echo "run-tests: tier all (pipeline test files included): $why" >>"$log"
  fi
fi

# The kit lane (#753, tools/lanes): a change to kit/ and light paths alone runs only the test files that read the kit
# (tools/kit-tests.ts), of those picked above. Against the same main as the tiers; the map is main's.
kit_lane() {
  local base lane
  base=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null) || return 1
  read -r lane _ < <(git diff --no-renames --name-only "$base" HEAD | "$tools/lane.sh" "$base") || return 1
  [ "$lane" = kit ]
}
if [ -r tools/lanes ] && kit_lane; then
  kit=() kept=()
  mapfile -t kit < <("$tools/citadel-node" "$tools/kit-tests.ts" 2>/dev/null)
  if [ "${#kit[@]}" -gt 0 ]; then
    if [ "${targets[*]}" = test/ ]; then
      kept=("${kit[@]}")
    else
      for f in "${targets[@]}"; do [[ " ${kit[*]} " == *" $f "* ]] && kept+=("$f"); done
    fi
  fi
  if [ "${#kept[@]}" -gt 0 ]; then
    echo "run-tests: kit lane: only the ${#kept[@]} test file(s) that read the kit (tools/kit-tests.ts)" >>"$log"
    targets=("${kept[@]}")
  else
    echo "run-tests: kit lane, but tools/kit-tests.ts picked none: running them all" >>"$log"
  fi
fi

# A tracked .ts file that doesn't parse fails the run before any test (#999): every test that starts it as a child would
# hang to the limit below. Only its "does not parse" lines count; the check itself failing (no git) is no verdict.
unparsed=$("$tools/citadel-node" --no-warnings "$tools/parse-check.ts" 2>/dev/null)
if [ -n "$unparsed" ]; then
  sed 's/^/run-tests: /; s/$/, so no test ran/' <<<"$unparsed" | tee -a "$log" >&2
  rm -f "$failed"
  exit 1
fi

progress=${log%.log}.progress
unset CITADEL_TEST_PROGRESS # the reruns below count nothing
rm -f "$progress" "$progress.tmp"
trap 'rm -f "$failed" "$progress" "$progress.tmp"' EXIT
CITADEL_TEST_PROGRESS=$progress timeout -k 30 "$limit" "${scope[@]}" "$tools/citadel-node" --test --test-concurrency="$concurrency" --test-force-exit --test-timeout="$test_limit" "${guard[@]}" --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter="$tools/failed-files-reporter.ts" --test-reporter-destination="$failed" "${targets[@]}" >>"$log" 2>&1
rc=$?
rm -f "$progress" "$progress.tmp"
load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null) || load='?'
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  echo "run-tests: the tests ran past ${limit}s and were stopped: a test hung (the hung file is the one with no results above)." | tee -a "$log" >&2
fi
[ "$rc" -eq 1 ] || exit "$rc" # green, hung or killed: nothing to rerun

mapfile -t lines <"$failed"
files=() took=() # the reporter writes "<file><tab><seconds the file took in the full run>"
for l in "${lines[@]}"; do files+=("${l%%$'\t'*}"); took+=("${l#*$'\t'}"); done
say() { echo "run-tests: $*" >>"$log"; }
[ "${#files[@]}" -gt 0 ] || exit "$rc"
if [ "${#files[@]}" -gt "$max_reruns" ]; then
  say "${#files[@]} test files failed: too many for load, so none is rerun"
  exit "$rc"
fi

# Best effort, as land.sh's conflict lines (the header as land.sh writes it: test/land.test.ts pins it): no shared folder or a failed write never changes the run's result.
log_flake() (
  set +e
  [ -n "${COORDINATOR_SHARED_DIR:-}" ] || exit 0
  dir=$COORDINATOR_SHARED_DIR/retro-log/$(date -u +%F)
  mkdir -p "$dir" || exit 0
  [ -e "$dir/land.md" ] || printf '%s\n\n' '# Retro log: land.sh' 'Written by tools/land.sh, tools/run-tests.sh and the queued restart in tools/deploy.sh (no session id, so one file per day). One line per rebase conflict, per landing that fell back from CI to the suite on perigee, per test file that failed in a land or deploy run and passed alone (flake), and per fresh CI run after a red of flakes only (flake rerun: green, red, no answer or not started). A `smoke` line per landing the smoke check refused before the line (#1012: what failed, its seconds; no timing line for it). Phase times in whole seconds (#565), - for a phase never reached: a `timing` line per landing that got in line, landed or not (line: waiting for the deploy lock; rebase; ci-queue: until a runner took the job; ci-run; fallback: the wait for a CI that gave no answer + the suite on perigee; deploy: pull, boot check and tests if any, until the restart was queued or the front end reloaded; live: from then until the deploy saw it live, the restart'"'"'s settle check included), and a `restart` line per queued restart (idle-wait: for the turns it would cut off and the lock; backup: the database copy; healthy: restart to the first healthy answer; settle: the check after it).' >>"$dir/land.md"
  branch=$(git branch --show-current 2>/dev/null)
  printf -- '- %sZ · flake · %s · load %s%s\n' "$(date -u +%T)" "$1" "$load" "${branch:+ · $branch}" >>"$dir/land.md"
) >/dev/null 2>&1

rerun_log=${log%.log}-rerun.log
: >"$rerun_log"
say "${#files[@]} test file(s) failed; rerunning each alone once to tell load from a real failure (the run fails either way; output in $rerun_log)"
# A phase of their own in the landing's place in line (#553): with the full run they could outlast the waiters' stall.
if [ -f "$tools/deploy-queue.sh" ]; then
  # shellcheck source=tools/deploy-queue.sh
  . "$tools/deploy-queue.sh"
  queue_phase "rerunning ${#files[@]} failed test file$([ "${#files[@]}" = 1 ] || echo s) since $(date +%H:%M)"
fi
SECONDS=0
for i in "${!files[@]}"; do
  f=${files[$i]}
  left=$((budget - SECONDS))
  if [ "$left" -le 0 ]; then
    say "$f: not rerun: the reruns' ${budget}s ran out"
    continue
  fi
  # A long file gets 1.5 times its own full-run time, never less than the flat limit, and never more than the budget left.
  want=$((took[i] * 3 / 2 > rerun_limit ? took[i] * 3 / 2 : rerun_limit))
  this=$((left < want ? left : want))
  echo "== $f" >>"$rerun_log"
  timeout -k 10 "$this" "${scope[@]}" "$tools/citadel-node" --test --test-force-exit --test-timeout="$test_limit" "$f" >>"$rerun_log" 2>&1
  case $? in
    0) say "$f: failed in the full run, passed alone: likely load, not your change (1-minute load $load)"; log_flake "$f" ;;
    124 | 137) say "$f: hung when rerun alone (stopped after ${this}s): a real failure" ;;
    *) say "$f: failed again alone: a real failure" ;;
  esac
done
say "the run still fails: a rerun alone only labels flakes and never turns a red run green; in CI, land.sh decides whether a red of flakes only gets one fresh run"
exit "$rc"
