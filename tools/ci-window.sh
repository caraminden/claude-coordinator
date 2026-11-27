#!/usr/bin/env bash
# Runs a command inside a window in the machine's CI window log: tests.yml's overlap check (#1811) keeps no suite time for a
# suite that crossed one, so a flake proof or heavy job beside a ship's run doesn't read as the code getting slower (#2082).
# The same folder and "start end" line tests.yml writes (end 0 while open). Usage: tools/ci-window.sh <command> [args...]
# Or --close, in the job's always() step: GitHub's cancel signals only the step's shell, so this script, its child, is killed
# without closing its window, which would then mark suites that never ran beside it.
win=${CITADEL_SUITE_WINDOWS:-/tmp/citadel-suite-windows-$(id -u)} # the setting is for the test
if [ "${1:-}" = --close ]; then
  for f in "$win/${GITHUB_RUN_ID:-0}"-*; do
    read -r s e 2>/dev/null <"$f" && [ "$e" = 0 ] && echo "$s $(date +%s)" >"$f"
  done
  exit 0
fi
me="$win/${GITHUB_RUN_ID:-0}-$$"
start=$(date +%s)
mkdir -p "$win" && echo "$start 0" >"$me"
# The overlap check ignores an open window untouched for 30 minutes (a killed job's): a long command keeps its own fresh.
# It ends with the job (#2221): left alive after a kill, it kept a dead window fresh and every ship's suite read as shared.
( parent=$$; trap 'kill "$s"; exit' TERM; while kill -0 "$parent" 2>/dev/null; do sleep 600 & s=$!; wait "$s"; kill -0 "$parent" 2>/dev/null && touch "$me"; done ) >/dev/null 2>&1 &
toucher=$!
trap 'kill "$toucher" 2>/dev/null; echo "$start $(date +%s)" >"$me"' EXIT
"$@"
