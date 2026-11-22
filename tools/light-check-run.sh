#!/usr/bin/env bash
# The light check's run (#1620; tools/light-check.sh starts it): on CI's side runner, through heavy-ci.ts, in a snapshot of
# a ship's branch rebased onto main. Args: <main's commit>. Runs the ship's own and affected test files once
# (citadel-test --affected against main), then each file that failed alone, on this commit and on main, as land.sh's
# train_alone does. Its last line is the verdict light-check.sh reads:
#   light check: green
#   light check: red: <file>, <file>       failed in the run, failed again alone here, and pass alone on main (or main
#                                          hasn't got them): the ship's own
#   light check: no verdict: <why>         flakes, main's own red, a run cut off, a setup that failed
# It always exits 0 once it has a verdict, so heavy-ci.ts's own status means only "it didn't run".
# LIGHT_CHECK_LIMIT (240 s) is the affected run's limit, LIGHT_CHECK_BUDGET (600 s) the whole run's (no file is pinned
# past it), LIGHT_CHECK_FILES (4) the most files pinned. LIGHT_CHECK_TEST and LIGHT_CHECK_NODE stand in for
# tools/citadel-test and tools/citadel-node in tests.
set -uo pipefail
base=${1:?usage: light-check-run.sh <main commit>}
ct=${LIGHT_CHECK_TEST:-tools/citadel-test} node=${LIGHT_CHECK_NODE:-tools/citadel-node}
budget=${LIGHT_CHECK_BUDGET:-600} pin=${LIGHT_CHECK_PIN:-90}
verdict() { echo "light check: $*"; exit 0; }
git cat-file -e "$base^{commit}" 2>/dev/null || verdict "no verdict: main's commit $base isn't in this checkout"
out=$(mktemp) main=''
trap 'rm -f "$out" "$out.alone"; [ -z "$main" ] || git worktree remove --force "$main" >/dev/null 2>&1' EXIT
rc=0
"$ct" --affected --base "$base" --timeout "${LIGHT_CHECK_LIMIT:-240}" >"$out" 2>&1 </dev/null || rc=$?
tail -n 60 "$out"
case $rc in
  0) verdict green ;;
  124 | 137) verdict "no verdict: the affected tests ran past ${LIGHT_CHECK_LIMIT:-240}s" ;;
  2) verdict "no verdict: citadel-test couldn't run them (its lines above say why)" ;;
esac
# The failed files, as citadel-test's reporter names them ("✖ test/x.test.ts:12 › name"), the first few.
mapfile -t failed < <(sed -n 's/^✖ \(test\/[^ :]*\.test\.[a-z]*\).*/\1/p' "$out" | awk '!seen[$0]++' | head -n "${LIGHT_CHECK_FILES:-4}")
[ ${#failed[@]} -gt 0 ] || verdict "no verdict: red (status $rc) with no test file named"
# <dir> <file>: 0 passes alone, 1 fails, else no answer.
alone() {
  [ -e "$1/$2" ] || return 0
  (cd "$1" && timeout -k 10 "$pin" "$node" --test --test-force-exit --test-timeout=60000 "$2") >>"$out.alone" 2>&1 </dev/null
  local s=$?
  [ $s = 0 ] && return 0
  [ $s = 124 ] || [ $s = 137 ] && return 2
  return 1
}
bad=() unsure=()
for f in "${failed[@]}"; do
  if [ $SECONDS -ge "$budget" ]; then unsure+=("$f (out of time)"); continue; fi
  s=0; alone . "$f" || s=$?
  [ $s = 1 ] || { [ $s = 0 ] || unsure+=("$f (hung alone)"); continue; }
  git cat-file -e "$base:$f" 2>/dev/null || { bad+=("$f"); continue; } # new with this ship
  if [ -z "$main" ]; then
    main=$(mktemp -d) && git worktree add -q --detach "$main" "$base" >/dev/null 2>&1 || { main=''; unsure+=("$f (no checkout of main)"); continue; }
  fi
  s=0; alone "$main" "$f" || s=$?
  case $s in 0) bad+=("$f") ;; 1) unsure+=("$f (red on main too)") ;; *) unsure+=("$f (hung on main)") ;; esac
done
if [ ${#bad[@]} -gt 0 ]; then
  echo "--- run alone:"; tail -n 40 "$out.alone"
  verdict "red: $(printf '%s, ' "${bad[@]}" | sed 's/, $//')"
fi
[ ${#unsure[@]} -gt 0 ] && verdict "no verdict: $(printf '%s, ' "${unsure[@]}" | sed 's/, $//')"
verdict "no verdict: $(printf '%s, ' "${failed[@]}" | sed 's/, $//') passed alone (flakes)"
