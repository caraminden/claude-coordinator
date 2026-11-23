#!/usr/bin/env bash
# The burn-in (#1443, RL7 step 2, Cara 2026-11-21 "Go" on #1429's choices page): a test file runs as N copies at once, each
# with its own TMPDIR, so a racy test fails before it joins the gate instead of costing other ships reruns for a week.
# #1327 measured it on Nov 20: four of six first-day flaky files failed 2 to 10 of 10 copies at once at the commit that
# added them, their fixed versions failed 0 of 60, and the same ten runs one after another caught 0 or 1.
#
#   tools/burn-in.sh <test file> [copies]   one file, its copies at once (tools/flake-proof.sh's batches: the same shape)
#                                           (outside CI: at most 4, queued as one heavy job, niced: below)
#   tools/burn-in.sh --ship <base>          a ship's CI run (tests.yml): the test files it adds or changes since <base>,
#                                           then up to BURN_IN_MAPPED (3) tests tools/affected-map.txt maps its changed
#                                           source files to or that import them (in turns), one file after another, within
#                                           BURN_IN_LIMIT (150) s
#   tools/burn-in.sh --importers <path>...  the test files that import those paths, nearest first, with why (no run)
#
# One file: exits 0 when every copy passed, 1 when one failed or was stopped at the limit (its output is printed, then a
# "burn-in: <file>: failed in <n> of <N> copies at once" line, which land.sh reads). BURN_IN_FILE_LIMIT (600) s per copy.
# --ship: runs every file, and exits 1 when any had a failed copy, naming each. A file stopped at the ship's time limit has no verdict, said
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

# The tests that import a changed file (#1456, Cara 2026-11-21, "Yes, follow-up minion" on #1443's card): by a relative
# path, directly or through one more file, read as land.sh's train_imports reads them (a grep, no compiler).
# <file>...: "<file>\t<repo path it imports>" for each relative import, once.
imports_of() {
  local raw
  [ $# -gt 0 ] || return 0
  raw=$(grep -oHE "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"]\.\.?/[^'\"]+['\"]" "$@" 2>/dev/null |
    awk '{ i = index($0, ":"); f = substr($0, 1, i - 1); d = f; if (!sub(/\/[^\/]*$/, "", d)) d = "."
           s = substr($0, i + 1); sub(/^[^\047"]*[\047"]/, "", s); sub(/[\047"]$/, "", s); print f "\t" d "/" s }')
  [ -n "$raw" ] || return 0
  paste <(cut -f1 <<<"$raw") <(cut -f2 <<<"$raw" | xargs -d '\n' realpath -ms --relative-to=.) | sort -u
}
# <changed path>...: "<test>\t<why>" for each test file importing one, nearest first: a direct importer named like the
# file it imports (src/x.ts, test/x.test.ts), then the other direct importers, then those importing it through one file.
importers() {
  local t1 t2 mids=()
  shopt -s nullglob
  t1=$(imports_of test/*.test.ts test/*.test.js)
  shopt -u nullglob
  mapfile -t mids < <(cut -f2 <<<"$t1" | sort -u | while read -r f; do [ ! -f "$f" ] || echo "$f"; done)
  t2=$(imports_of "${mids[@]}")
  awk -F'\t' -v changed="$(printf '%s\n' "$@")" '
    BEGIN { n = split(changed, c, "\n"); for (i = 1; i <= n; i++) if (c[i] != "") ch[c[i]] = 1 }
    FNR == 1 { part++ }
    # Each join is built before it is assigned: awks differ on whether a[k] = ... (k in a) sees k already (mawk does).
    part == 1 { if ($2 in ch) { v = $2; if ($1 in via) v = via[$1] ", " v; via[$1] = v } next }
    $2 in ch { v = $2; if ($1 in direct) v = direct[$1] ", " v; direct[$1] = v
               b = $1; sub(/.*\//, "", b); sub(/\.test\.[jt]s$/, "", b); m = $2; sub(/.*\//, "", m); sub(/\.[^.]*$/, "", m)
               if (b == m) named[$1] = 1; next }
    $2 in via { v = $2 ", which imports " via[$2]; if ($1 in two) v = two[$1] "; " v; two[$1] = v }
    END {
      for (t in direct) print (t in named ? 0 : 1) "\t" t "\timports " direct[t]
      for (t in two) if (!(t in direct)) print 2 "\t" t "\timports " two[t]
    }' <(echo "$t2") <(echo "$t1") | sort -t$'\t' -k1,1n -k2,2 | cut -f2-
}

if [ "${1:-}" = --importers ]; then
  shift
  importers "$@"
  exit 0
fi

if [ "${1:-}" != --ship ]; then
  file=${1:?usage: burn-in.sh <test file> [copies] | burn-in.sh --ship <base>}
  [ -f "$file" ] || { echo "burn-in: no such file: $file"; exit 1; }
  n=${2:-$copies}
  # Outside CI (a turn chasing a flake on perigee), the whole run is one queued heavy job: a slot and the load gate
  # (CITADEL_HEAVY_JUDGE=0: the light-job path would skip both), nice 19, at most 4 copies (#1725; 10 at once, seven
  # times over, stalled the server on Nov 23). --here: the CI hand-off doesn't carry BURN_IN_QUEUED, and a CI re-run is
  # the way to 10. shortcut: other scripts that call a heavy tool by its absolute path still dodge tools/heavy-shim.
  if [ -z "${RUNNER_TEMP:-}${CI:-}${GITHUB_ACTIONS:-}${BURN_IN_QUEUED:-}" ]; then
    [[ $n =~ ^[1-9][0-9]*$ ]] || { echo "burn-in: copies must be a whole number, not $n"; exit 1; }
    [ "$n" -le 4 ] || { echo "burn-in: $n copies at once is CI's; here it runs 4, queued for a heavy slot (re-run CI for $n)"; n=4; }
    BURN_IN_QUEUED=1 BURN_IN_NICE=${BURN_IN_NICE:-nice -n 19} CITADEL_HEAVY_JUDGE=0 CITADEL_HEAVY_WHAT="burn-in $file x$n" \
      exec "$tools/citadel-heavy" --here bash "$tools/burn-in.sh" "$file" "$n"
  fi
  burn_one "$file" "$n" "${BURN_IN_FILE_LIMIT:-600}" && exit 0
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
imp=() imp_why=() taken=" ${direct[*]} ${mapped[*]} "
mapfile -t src_changed < <(git diff --name-only --no-renames "$base...HEAD" | grep -vE '\.test\.[jt]s$')
while IFS=$'\t' read -r f why; do
  [ -f "$f" ] && [[ $taken != *" $f "* ]] || continue
  imp+=("$f") imp_why+=("$why") taken+="$f "
done < <([ ${#src_changed[@]} = 0 ] || importers "${src_changed[@]}")
# The map's picks and the importers take turns, so neither fills the cap alone (src/db.ts maps to 3 guard tests).
picks=()
for ((i = 0; i < ${#mapped[@]} || i < ${#imp[@]}; i++)); do
  [ "$i" -ge ${#mapped[@]} ] || picks+=("${mapped[i]}")
  [ "$i" -ge ${#imp[@]} ] || picks+=("${imp[i]}")
done
if [ ${#picks[@]} -gt "$mapped_max" ]; then
  echo "burn-in: ${#picks[@]} tests are mapped to the change or import it; only the first $mapped_max are burned in (left out: ${picks[*]:$mapped_max})"
  kept=" ${picks[*]:0:$mapped_max} " was=("${mapped[@]}") mapped=()
  for f in "${was[@]}"; do [[ $kept != *" $f "* ]] || mapped+=("$f"); done
  was=("${imp[@]}") whys=("${imp_why[@]}") imp=() imp_why=()
  for ((i = 0; i < ${#was[@]}; i++)); do [[ $kept != *" ${was[i]} "* ]] || { imp+=("${was[i]}") imp_why+=("${whys[i]}"); }; done
fi
for ((i = 0; i < ${#imp[@]}; i++)); do echo "burn-in: picked ${imp[i]}: it ${imp_why[i]}"; done
files=("${direct[@]}" "${mapped[@]}" "${imp[@]}")
[ ${#files[@]} -gt 0 ] || { echo "burn-in: this change adds or changes no test file, and no test is mapped to it or imports it: nothing to burn in"; exit 0; }
echo "burn-in: ${#files[@]} file(s), $copies copies of each at once, one file after another, within $limit s: ${direct[*]:+changed: ${direct[*]}}${mapped[*]:+${direct[*]:+; }mapped from the change: ${mapped[*]}}${imp[*]:+${direct[*]}${mapped[*]:+; }importing the change: ${imp[*]}}"
# Every file runs, past a red one (#1564): a train with three racy riders hears of all three in one red run, not one a run.
deadline=$((SECONDS + limit)) skipped=() nov=() red=()
for f in "${files[@]}"; do
  left=$((deadline - SECONDS))
  [ "$left" -ge 15 ] || { skipped+=("$f"); continue; }
  rc=0
  burn_one "$f" "$copies" "$left" || rc=$?
  [ "$rc" != 1 ] || red+=("$f")
  [ "$rc" != 2 ] || nov+=("$f")
done
[ ${#nov[@]} = 0 ] || echo "burn-in: NO VERDICT on ${nov[*]}: stopped at the ${limit} s limit (the full suite runs it next, with its own hang limit)"
[ ${#skipped[@]} = 0 ] || echo "burn-in: SKIPPED ${skipped[*]}: the ${limit} s limit ran out before they could start"
echo "burn-in: done in $((limit - (deadline - SECONDS))) s"
for f in "${red[@]}"; do echo "burn-in: refused: a copy of $f failed when run $copies at once, so it is racy (its output is above); fix the race, not the wait"; done
[ ${#red[@]} = 0 ] || exit 1
