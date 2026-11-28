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
#                                           BURN_IN_LIMIT (135) s; with BURN_IN_TIMES (a file it keeps), one whose last
#                                           burn-in at the same content took longer than the time left is not started;
#                                           a heavy file's copies run fewer at a time, to fit the runner (below, #2290)
#   tools/burn-in.sh --importers <path>...  the test files that import those paths, nearest first, with why (no run)
#
# One file: exits 0 when every copy passed, 1 when one failed or was stopped at the limit (its output is printed, then a
# "burn-in: <file>: failed in <n> of <N> copies at once" line, which land.sh reads). BURN_IN_FILE_LIMIT (600) s per copy.
# When every copy failed, the file runs once more by itself (#2141: 36 of 61 burn-in reds in the retro #2113 were N of
# N, and some were plain reds or CI-only faults, not races), and a "burn-in: <file>: alone: failed|passed" line says
# which case it is, for land.sh's refusal. N of N alone proves nothing: racy files have reached 10 of 10.
# --ship: runs every file, and exits 1 when any had a failed copy, naming each. A file stopped at the ship's time limit has no verdict, said
# loudly: the full suite after it has its own hang limit. A file not started in time is named, as skipped. Map rules
# whose glob holds `**` are left out: they map a whole folder to guard tests that read the repo, which race on nothing.
# BURN_IN_NICE: a prefix for each copy (the flake proof's `nice -n 19`).
# BURN_IN_INNER: set off CI to 4 / copies, the in-file concurrency a test file that reads it should use (#2073); in a
# --ship run, to BURN_IN_CPUS / the copies running at a time.
# --ship fits the runner (#2290): each file's 10 copies all run and must all pass, but a heavy file's run at most k at a
# time, each next copy starting as one ends. One copy runs alone first and is weighed (weigh, below): k = BURN_IN_CPUS
# (nproc) x BURN_IN_LOAD (3) / the CPUs that copy kept busy, from 2 to all 10. A file that reads BURN_IN_INNER is
# not weighed: its in-file concurrency is capped instead (fit). Why weigh, not a flat nproc: GitHub's runners have 4 CPUs.
# On Nov 28 ten copies at once there of test/list-reads.test.ts (1.7 to 2 CPUs a copy, 3 servers) ran a load of 40 to
# 88, left 0.8 to 2.2 GB of 16 free and failed 7 to 10 of 10 copies on a 20 s boot wait (#2286); but #1327's
# fresh-session race (about 1 CPU a copy) was caught in 9 of 10 copies at 10 at once, 3 runs of 3, and in no copy of 3
# runs at 4 at a time: a light file's race needs all its copies at once. 3 x 4 CPUs runs a file of up to 1.2 CPUs 10 at
# once, list-reads 6, cabal-card-browser (3.1) 3. A 16-CPU runner (the desktop) runs every file of up to 4.8 CPUs 10 at
# once, as before. The weighing runs get 15 s on top of the limit in all (BURN_IN_WEIGH_ROOM), then come out of it.
set -uo pipefail
tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
copies=${BURN_IN_COPIES:-10}
test_limit=$((${CITADEL_TEST_TIMEOUT:-60} * 1000)) # each test, in ms, as the gate's run-tests.sh
read -ra nice_cmd <<<"${BURN_IN_NICE:-}"
unset NODE_TEST_CONTEXT # set by an outer node --test (a test of this script), it makes each copy skip its file and pass

declare -A pace_of=() # <file>: " (at most <k> at a time)" when its copies ran fewer at once than their number
declare -A alone_of=() # <file>: failed, passed or unrun (no time left), run alone after every copy failed
# <file> <copies> <seconds>: 0 clean, 1 a copy failed, 2 none failed but one was stopped at the limit.
# [at a time]: at most that many copies run at once, each next one starting as one ends, within the same <seconds>
# from the first one's start (a copy with no time left to start counts as stopped); all <copies> at once by default.
burn_one() {
  local file=$1 n=$2 limit=$3 k=${4:-$2} dir i rc fails=() stopped=() t0=$SECONDS first='' left pace=''
  dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/burn-in.XXXXXX") || { echo "burn-in: no temp folder for $file"; return 1; }
  [ "$k" -ge "$n" ] || pace=" (at most $k at a time)"
  pace_of[$file]=$pace
  for ((i = 1; i <= n; i++)); do
    while [ "$(jobs -rp | wc -l)" -ge "$k" ]; do wait -n; done
    left=$((limit - (SECONDS - t0)))
    [ "$left" -gt 0 ] || { echo 124 >"$dir/copy$i.rc"; continue; }
    mkdir -p "$dir/tmp$i"
    (
      rc=0
      TMPDIR=$dir/tmp$i timeout -k 10 "$left" "${nice_cmd[@]}" "$tools/citadel-node" --test --test-force-exit --test-timeout="$test_limit" --test-reporter=spec "$file" >"$dir/copy$i.log" 2>&1 || rc=$?
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
    echo "burn-in: $file: failed in ${#fails[@]} of $n copies at once$pace (copies ${fails[*]}), in $((SECONDS - t0)) s${stopped:+; ${#stopped[@]} more stopped at ${limit} s}"
    left=$((limit - (SECONDS - t0)))
    if [ ${#fails[@]} = "$n" ]; then
      rc=124
      if [ "$left" -ge "${BURN_IN_ALONE_MIN:-15}" ]; then # s left of its limit to bother; tests turn it up
        mkdir -p "$dir/alone" && rc=0
        TMPDIR=$dir/alone timeout -k 10 "$left" "${nice_cmd[@]}" "$tools/citadel-node" --test --test-force-exit --test-timeout="$test_limit" --test-reporter=spec "$file" >"$dir/alone.log" 2>&1 || rc=$?
      fi
      if [ "$rc" = 0 ]; then
        alone_of[$file]=passed
        echo "burn-in: $file: alone: passed, so it fails only beside its copies: a race"
      elif [ "$rc" != 124 ] && [ "$rc" != 137 ]; then
        alone_of[$file]=failed
        echo "burn-in: $file: alone: failed too, so it is no race: a plain red, or a fault of CI's own environment (a temp path, git identity, a missing tool)"
      else
        alone_of[$file]=unrun
        echo "burn-in: $file: alone: no time left to run it, so it may be a plain red or a race"
      fi
    fi
    rm -rf "$dir"
    return 1
  fi
  rm -rf "$dir"
  if [ ${#stopped[@]} -gt 0 ]; then
    echo "burn-in: $file: ${#stopped[@]} of $n copies at once$pace were stopped at ${limit} s (copies ${stopped[*]}), none failed"
    return 2
  fi
  echo "burn-in: $file: $n of $n copies at once$pace passed, in $((SECONDS - t0)) s"
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

# How many copies of a file fit <cpus> at once, since the file's own concurrency multiplies its copies (#2073: 4 copies
# of boot-check's 8-way describe ran 32 boot checks in one slot and stalled the server on Nov 25): copies x in-file
# concurrency stays within <cpus>. <file> <copies> <cpus> sets fit_k (copies at once, at least 1), fit_inner (the
# BURN_IN_INNER to export, <cpus> / fit_k, for a file that reads it; else empty) and fit_c (the file's own concurrency:
# its largest fixed number, or true). Returns 1 when that can't be capped: true, or a number over <cpus>.
# Whether <file> reads BURN_IN_INNER in its code, not only in a string (test/burn-in.test.ts' fixtures name it in quotes).
honours_inner() { grep -E 'process\.env\.BURN_IN_INNER' "$1" | grep -qvE "['\"\`](Number\()?process\.env\.BURN_IN_INNER"; }
fit() {
  local file=$1 n=$2 cpus=$3
  fit_inner='' fit_c=1 fit_k=$((n < cpus ? n : cpus))
  [ "$fit_k" -ge 1 ] || fit_k=1
  if honours_inner "$file"; then
    fit_inner=$((cpus / fit_k)) fit_c=$fit_inner
    return 0
  fi
  fit_c=$(grep -oE 'concurrency:[[:space:]]*(true|[0-9]+)' "$file" | awk '{ v = $NF; if (v == "true") t = 1; else if (v + 0 > m) m = v + 0 } END { print t ? "true" : m + 0 }')
  if [ "$fit_c" = true ] || [ "$fit_c" -gt "$cpus" ]; then fit_k=1 && return 1; fi
  [ "$fit_c" -le 1 ] || [ $((fit_k * fit_c)) -le "$cpus" ] || fit_k=$((cpus / fit_c))
  return 0
}

# <file> <seconds>: one copy run alone before a ship's copies, setting weight (the CPUs it kept busy on average, over
# its wall time) and weigh_note (a note when that run failed: the copies still decide). BURN_IN_WEIGHT skips the run
# (tests). What counts as busy, BURN_IN_WEIGH_BY: on GitHub's own runners (machine), the whole machine's busy time, as
# the job has it to itself and a test's Chromium or systemd units aren't its child processes (test/cabal-card-browser
# kept 3.1 CPUs busy there and 0.5 in its own processes, Nov 28); elsewhere (tree), the run's own processes' CPU time,
# the servers it starts included, so other jobs on a shared runner (the desktop's) don't count.
busy_ticks() { awk '/^cpu / { print $2 + $3 + $4 + $7 + $8 + $9 }' /proc/stat 2>/dev/null || echo 0; }
weigh() {
  local file=$1 limit=$2 dir t0 t1 out rc b0 b1 by=${BURN_IN_WEIGH_BY:-}
  [ -n "$by" ] || { [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] && by=machine || by=tree; }
  weigh_note='' weight=${BURN_IN_WEIGHT:-}
  [ -z "$weight" ] || return 0
  dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/burn-in-weigh.XXXXXX") || { weight=$cpus weigh_note="; it couldn't be weighed (no temp folder), so it counts as filling the runner"; return 0; }
  b0=$(busy_ticks) t0=$(date +%s%N)
  # times: this subshell's waited-for children, so the test run and everything under it.
  out=$({ TMPDIR=$dir timeout -k 10 "$limit" "${nice_cmd[@]}" "$tools/citadel-node" --test --test-force-exit --test-timeout="$test_limit" --test-reporter=spec "$file" >"$dir/run.log" 2>&1; echo "rc $?"; times; })
  t1=$(date +%s%N) b1=$(busy_ticks)
  rm -rf "$dir"
  rc=$(awk '$1 == "rc" { print $2 }' <<<"$out")
  [ "$rc" = 0 ] || weigh_note="; that run alone failed (exit $rc), and its copies still decide"
  # Stopped at its limit, its processes' CPU time is lost with them: it counts as filling the runner.
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then weight=$cpus weigh_note="; that run alone was stopped at $limit s, so it counts as filling the runner"; return 0; fi
  # The whole machine's ticks are USER_HZ, 100 a second on Linux.
  weight=$(awk -v ns=$((t1 - t0)) -v by="$by" -v ticks=$((b1 - b0)) 'function s(x) { split(x, a, /[ms]/); return a[1] * 60 + a[2] } $1 != "rc" { n++; if (n == 2) cpu = s($1) + s($2) } END { if (by == "machine" && ticks / 100 > cpu) cpu = ticks / 100; w = ns > 0 ? cpu / (ns / 1e9) : 0; printf "%.2f", w }' <<<"$out")
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
    # The heavy slot's 4 CPUs (fit, above); a file whose concurrency can't be capped is refused.
    fit "$file" "$n" 4 || {
      echo "burn-in: $file asks concurrency: $fit_c, more than the heavy slot's 4 at once; have it read BURN_IN_INNER (as test/boot-check.test.ts does) so the burn-in can cap it, or burn it in on CI"
      exit 1
    }
    [ "$fit_k" = "$n" ] || echo "burn-in: $file runs concurrency $fit_c inside each copy, so here it runs $fit_k copies, not $n"
    n=$fit_k
    [ -z "$fit_inner" ] || export BURN_IN_INNER=$fit_inner
    BURN_IN_QUEUED=1 BURN_IN_NICE=${BURN_IN_NICE:-nice -n 19} CITADEL_HEAVY_JUDGE=0 CITADEL_HEAVY_WHAT="burn-in $file x$n" \
      exec "$tools/citadel-heavy" --here bash "$tools/burn-in.sh" "$file" "$n"
  fi
  burn_one "$file" "$n" "${BURN_IN_FILE_LIMIT:-600}" && exit 0
  exit 1
fi

base=${2:?usage: burn-in.sh --ship <base>}
limit=${BURN_IN_LIMIT:-135} mapped_max=${BURN_IN_MAPPED:-3} cpus=${BURN_IN_CPUS:-$(nproc 2>/dev/null || echo 4)} load=${BURN_IN_LOAD:-3}
[[ $cpus =~ ^[1-9][0-9]*$ ]] || { echo "burn-in: BURN_IN_CPUS must be a whole number, not $cpus"; exit 1; }
[[ $load =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "burn-in: BURN_IN_LOAD must be a number, not $load"; exit 1; }
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
# Each file's last burn-in on this runner (#2138), "<seconds>\t<file>\t<blob>": a file whose last burn-in at the same
# content took longer than the time left is skipped, not started. Stopped at the limit it gives no verdict, and on Nov 25
# and 26 that cost 1,680 s over 197 ship runs and 878 s over 29 (Build 7's machine-sync, 67-93 s a run). A stopped file
# keeps one second more than the longest time it was given, so the same time left won't start it again; a failed one keeps
# nothing, as its copies stopped early. A line whose time isn't whole seconds is ignored.
times=${BURN_IN_TIMES:-}
need_of() { [ -n "$times" ] && [ -f "$times" ] && [ -r "$times" ] || { echo 0; return; }; awk -F'\t' -v f="$1" -v b="$2" '$2 == f && $3 == b && $1 ~ /^[0-9]+$/ { s = $1 } END { print s + 0 }' "$times" 2>/dev/null || echo 0; }
keep_time() {
  [ -n "$times" ] || return 0
  { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$times"; } 2>/dev/null || return 0
  # shortcut: runners sharing the file may lose a line to this trim, which only costs a file one more burn-in.
  [ "$(wc -l <"$times" 2>/dev/null || echo 0)" -le 4000 ] || { tail -n 2000 "$times" >"$times.$$" && mv -f "$times.$$" "$times"; }
}
# Every file runs, past a red one (#1564): a train with three racy riders hears of all three in one red run, not one a run.
# The weighing runs get weigh_room s more than the limit in all: 135 + 15 is the 150 s the copies had before #2290, so
# the step stays within land.sh's CI_BURN (180 s, test/ci-runner-choice.test.ts).
deadline=$((SECONDS + limit)) start=$SECONDS weigh_room=${BURN_IN_WEIGH_ROOM:-15} skipped=() slow=() nov=() red=()
for f in "${files[@]}"; do
  left=$((deadline - SECONDS))
  [ "$left" -ge 15 ] || { skipped+=("$f"); continue; }
  blob=$(git hash-object "$f" 2>/dev/null) || blob=
  need=$(need_of "$f" "$blob")
  if [ -n "$blob" ] && [ "$need" -gt "$left" ]; then
    echo "burn-in: $f: not started: its last burn-in here, at this same content, took $need s or more and $left s are left, so it would stop with no verdict"
    slow+=("$f")
    continue
  fi
  rc=0 t0=$SECONDS fit_inner=''
  if honours_inner "$f"; then
    fit "$f" "$copies" "$cpus" # its in-file concurrency is capped to fit the CPUs (#2073)
  else
    # Its weighing run is on top of the limit while weigh_room lasts, then comes out of it (at most a minute: a file
    # alone for longer can't finish its copies anyway).
    weigh "$f" "$((left < ${BURN_IN_WEIGH_LIMIT:-60} ? left : ${BURN_IN_WEIGH_LIMIT:-60}))"
    tw=$((SECONDS - t0)) && [ "$tw" -le "$weigh_room" ] || tw=$weigh_room
    deadline=$((deadline + tw)) weigh_room=$((weigh_room - tw)) left=$((deadline - SECONDS)) t0=$SECONDS
    read -r weight fit_k < <(awk -v c="$cpus" -v l="$load" -v w="$weight" -v n="$copies" 'BEGIN { k = w > 0.05 ? int(c * l / w) : n; if (k > n) k = n; if (k < 2) k = 2; printf "%.1f %d\n", w, k }')
    echo "burn-in: $f: one copy alone kept $weight of this runner's $cpus CPUs busy, so $([ "$fit_k" -ge "$copies" ] && echo "all $copies copies run at once" || echo "its $copies copies run at most $fit_k at a time") (a load of up to $load x its CPUs)${weigh_note}"
  fi
  [ "$fit_k" -ge 2 ] || [ "$copies" -lt 2 ] || fit_k=2 # copies one at a time can't race each other
  if [ -n "$fit_inner" ]; then BURN_IN_INNER=$fit_inner burn_one "$f" "$copies" "$left" "$fit_k" || rc=$?
  else burn_one "$f" "$copies" "$left" "$fit_k" || rc=$?; fi
  took=$((SECONDS - t0))
  [ "$rc" != 1 ] || red+=("$f")
  if [ "$rc" = 2 ]; then nov+=("$f") && took=$((took + 1)) && [ "$took" -gt "$need" ] || took=$need; fi
  [ "$rc" = 1 ] || [ -z "$blob" ] || keep_time "$took" "$f" "$blob"
done
[ ${#slow[@]} = 0 ] || echo "burn-in: NO VERDICT on ${slow[*]}: not started, as their last burn-in took longer than the time left (the full suite runs them next)"
[ ${#nov[@]} = 0 ] || echo "burn-in: NO VERDICT on ${nov[*]}: stopped at the ${limit} s limit (the full suite runs it next, with its own hang limit)"
[ ${#skipped[@]} = 0 ] || echo "burn-in: SKIPPED ${skipped[*]}: the ${limit} s limit ran out before they could start"
echo "burn-in: done in $((SECONDS - start)) s"
for f in "${red[@]}"; do
  case ${alone_of[$f]:-} in
    failed) echo "burn-in: refused: $f: alone: failed too, after every copy failed: a plain red or a fault of CI's own environment, not a race (its output is above); fix that" ;;
    unrun) echo "burn-in: refused: $f: alone: no time left to run it, after every copy failed: a plain red or a race (its output is above); run it alone with citadel-test to tell" ;;
    *) echo "burn-in: refused: a copy of $f failed when run $copies at once${pace_of[$f]:-}, so it is racy (its output is above); fix the race, not the wait" ;;
  esac
done
[ ${#red[@]} = 0 ] || exit 1
