#!/usr/bin/env bash
# The burn-in (#1443, RL7 step 2, Cara 2026-11-21 "Go" on #1429's choices page): a test file runs as N copies at once, each
# with its own TMPDIR, so a racy test fails before it joins the gate instead of costing other ships reruns for a week.
# #1327 measured it on Nov 20: four of six first-day flaky files failed 2 to 10 of 10 copies at once at the commit that
# added them, their fixed versions failed 0 of 60, and the same ten runs one after another caught 0 or 1.
#
#   tools/burn-in.sh <test file> [copies]   one file, its copies at once (tools/flake-proof.sh's batches: the same shape)
#   tools/burn-in.sh --ship <base>          a ship's CI run (tests.yml): the test files it adds or changes since <base>,
#                                           then up to BURN_IN_MAPPED (3) tests tools/affected-map.txt maps its changed
#                                           source files to, one file after another, within BURN_IN_LIMIT (150) s
#
# One file: exits 0 when every copy passed, 1 when one failed or was stopped at the limit (its output is printed, then a
# "burn-in: <file>: failed in <n> of <N> copies at once" line, which land.sh reads). BURN_IN_FILE_LIMIT (600) s per copy.
# --ship: exits 1 on the first file with a failed copy. A file stopped at the ship's time limit has no verdict, said
# loudly: the full suite after it has its own hang limit. A file not started in time is named, as skipped. Map rules
# whose glob holds `**` are left out: they map a whole folder to guard tests that read the repo, which race on nothing.
# BURN_IN_NICE: a prefix for each copy (the flake proof's `nice -n 19`).
set -uo pipefail
tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
copies=${BURN_IN_COPIES:-10}
test_limit=$((${CITADEL_TEST_TIMEOUT:-60} * 1000)) # each test, in ms, as the gate's run-tests.sh
read -ra nice_cmd <<<"${BURN_IN_NICE:-}"
unset NODE_TEST_CONTEXT # set by an outer node --test (a test of this script), it makes each copy skip its file and pass

# <file> <copies> <seconds>: 0 clean, 1 a copy failed, 2 none failed but one was stopped at the limit.
burn_one() {
  local file=$1 n=$2 limit=$3 dir i rc fails=() stopped=() t0=$SECONDS first=''
  dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/burn-in.XXXXXX") || { echo "burn-in: no temp folder for $file"; return 1; }
  for ((i = 1; i <= n; i++)); do
    mkdir -p "$dir/tmp$i"
    (
      rc=0
      TMPDIR=$dir/tmp$i timeout -k 10 "$limit" "${nice_cmd[@]}" "$tools/citadel-node" --test --test-force-exit --test-timeout="$test_limit" --test-reporter=spec "$file" >"$dir/copy$i.log" 2>&1 || rc=$?
      echo "$rc" >"$dir/copy$i.rc"
    ) &
  done
  wait
  for ((i = 1; i <= n; i++)); do
    rc=$(cat "$dir/copy$i.rc" 2>/dev/null || echo 1)
    case $rc in
      0) ;;
      124 | 137) stopped+=("$i") ;;
      *) fails+=("$i") ;;
    esac
  done
  if [ ${#fails[@]} -gt 0 ]; then
    first=${fails[0]}
    echo "burn-in: $file, copy $first of $n (its output from the failing tests on; the other failed copies' are like it or in the run's temp folder):"
    if grep -q '✖ failing tests:' "$dir/copy$first.log"; then sed -n '/✖ failing tests:/,$p' "$dir/copy$first.log" | head -n 80
    else tail -n 40 "$dir/copy$first.log"; fi
    echo "burn-in: $file: failed in ${#fails[@]} of $n copies at once (copies ${fails[*]}), in $((SECONDS - t0)) s${stopped:+; ${#stopped[@]} more stopped at ${limit} s}"
    rm -rf "$dir"
    return 1
  fi
  rm -rf "$dir"
  if [ ${#stopped[@]} -gt 0 ]; then
    echo "burn-in: $file: ${#stopped[@]} of $n copies at once were stopped at ${limit} s (copies ${stopped[*]}), none failed"
    return 2
  fi
  echo "burn-in: $file: $n of $n copies at once passed, in $((SECONDS - t0)) s"
}

if [ "${1:-}" != --ship ]; then
  file=${1:?usage: burn-in.sh <test file> [copies] | burn-in.sh --ship <base>}
  [ -f "$file" ] || { echo "burn-in: no such file: $file"; exit 1; }
  burn_one "$file" "${2:-$copies}" "${BURN_IN_FILE_LIMIT:-600}" && exit 0
  exit 1
fi

base=${2:?usage: burn-in.sh --ship <base>}
limit=${BURN_IN_LIMIT:-150} mapped_max=${BURN_IN_MAPPED:-3}
git rev-parse -q --verify "$base^{commit}" >/dev/null || { echo "burn-in: SKIPPED: no commit $base to compare with, so nothing was burned in"; exit 0; }
rc=0
out=$("$tools/citadel-node" --no-warnings "$tools/affected.ts" --base "$base" 2>&1) || rc=$?
# 3 is the map's `full` fallback: its run lines still stand.
[ "$rc" = 0 ] || [ "$rc" = 3 ] || { echo "burn-in: SKIPPED: tools/affected.ts couldn't read the change (exit $rc): $out"; exit 0; }
direct=() mapped=()
while IFS=$'\t' read -r kind file why; do
  [ "$kind" = run ] && [ -f "$file" ] || continue
  if [[ $why == *touched* ]]; then direct+=("$file")
  elif grep -qvE '\*\*' <<<"${why//, /$'\n'}"; then mapped+=("$file") # one rule without ** is enough
  fi
done <<<"$out"
if [ ${#mapped[@]} -gt "$mapped_max" ]; then
  echo "burn-in: the change maps to ${#mapped[@]} tests; only the first $mapped_max are burned in (left out: ${mapped[*]:$mapped_max})"
  mapped=("${mapped[@]:0:$mapped_max}")
fi
files=("${direct[@]}" "${mapped[@]}")
[ ${#files[@]} -gt 0 ] || { echo "burn-in: this change adds or changes no test file and maps to none: nothing to burn in"; exit 0; }
echo "burn-in: ${#files[@]} file(s), $copies copies of each at once, one file after another, within $limit s: ${direct[*]:+changed: ${direct[*]}}${mapped[*]:+${direct[*]:+; }mapped from the change: ${mapped[*]}}"
deadline=$((SECONDS + limit)) skipped=() nov=()
for f in "${files[@]}"; do
  left=$((deadline - SECONDS))
  [ "$left" -ge 15 ] || { skipped+=("$f"); continue; }
  rc=0
  burn_one "$f" "$copies" "$left" || rc=$?
  [ "$rc" != 1 ] || { echo "burn-in: refused: a copy of $f failed when run $copies at once, so it is racy (its output is above); fix the race, not the wait"; exit 1; }
  [ "$rc" != 2 ] || nov+=("$f")
done
[ ${#nov[@]} = 0 ] || echo "burn-in: NO VERDICT on ${nov[*]}: stopped at the ${limit} s limit (the full suite runs it next, with its own hang limit)"
[ ${#skipped[@]} = 0 ] || echo "burn-in: SKIPPED ${skipped[*]}: the ${limit} s limit ran out before they could start"
echo "burn-in: done in $((limit - (deadline - SECONDS))) s"
