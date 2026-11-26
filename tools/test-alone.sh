#!/usr/bin/env bash
# One test file run alone, for the ship scripts' questions about a red (#1863): tools/land.sh and
# tools/own-check.sh. Niced, with the checkout's packages (tools/test-deps.sh), stopped at LAND_PIN_LIMIT s (120).
#   test-alone.sh run <checkout> <test file>     its output; 0 when it passes or the checkout hasn't got it, 1 when it
#                                                fails, anything else is no answer: stopped, or it could not run here
#                                                (its packages, or a module of them, are missing).
#   test-alone.sh stopped <log> <commit> <main>  a suite run-tests.sh stopped at its limit: prints each file that had
#                                                failed or was still running (6 at most, none started past 5 min) that fails or hangs alone at
#                                                <commit> and passes on <main>. From the repo; the runs' output on stderr.
set -uo pipefail
tools=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 2

alone() { # <checkout> <test file>
  local out r=0 limit=${LAND_PIN_LIMIT:-120} began
  [ -e "$1/$2" ] || return 0
  if ! "$tools/test-deps.sh" "$1" 2>&1; then echo "test-alone: $2 did not run: its packages are missing"; return 2; fi
  out=$(mktemp) || return 2
  began=$SECONDS
  (cd "$1" && timeout -k 10 "$limit" nice -n 19 "$tools/citadel-node" --test --test-force-exit --test-timeout=60000 "$2") >"$out" 2>&1 </dev/null || r=$?
  [ "$r" != 137 ] || [ $((SECONDS - began)) -ge "$limit" ] || r=2 # killed from outside before its limit (#1393): not its hang
  cat "$out"
  if [ "$r" = 1 ] && "$tools/test-deps.sh" missing "$out"; then
    echo "test-alone: $2 could not run here (a package is missing): no verdict"
    r=2
  fi
  rm -f "$out"
  return "$r"
}

case ${1:-} in
  run) alone "$2" "$3" ;;
  stopped)
    wt=$(mktemp -d "${TMPDIR:-/tmp}/land-stopped.XXXXXX") || exit 2
    trap 'git worktree remove --force "$wt" >/dev/null 2>&1; rm -rf "${wt:?}"' EXIT
    git worktree add -q --detach "$wt" "$3" >&2 || exit 2
    mapfile -t files < <({
      sed -n 's/^run-tests: had a failed test when it was stopped: //p' "$2" | tr ' ' '\n'
      sed -nE 's/^still running: ([^ ]+) \(.*/\1/p' "$2"
    } | sed "s|^$PWD/||" | awk 'NF && !s[$0]++' | head -n 6)
    for f in "${files[@]}"; do
      [ "$SECONDS" -lt 300 ] || break # the ship line waits behind this: a busy perigee can make each run long
      r=0 m=0
      git -C "$wt" checkout -q --detach "$3" && alone "$wt" "$f" >&2 || r=$?
      case $r in 1 | 124 | 137) ;; *) continue ;; esac
      git -C "$wt" checkout -q --detach "$4" && alone "$wt" "$f" >&2 || m=$?
      [ "$m" != 0 ] || echo "$f"
    done ;;
  *) echo "usage: test-alone.sh run <checkout> <test file> | stopped <log> <commit> <main>" >&2; exit 2 ;;
esac
