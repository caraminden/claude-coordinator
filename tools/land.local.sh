# shellcheck shell=bash
# Citadel's settings for the kit's core (tools/land-core.sh, a link to kit/skills/scheme-setup/templates/land.sh) as
# tools/land.sh's ship-time merge driver (numbers_git: land-core.sh --merge, #1221, #1418). Only the merge rules:
# Citadel ships on tools/land.sh, never on the core (the second ship path was deleted, #2099; ADR 0026).
# This copy's tools (the branch's own, as land.sh runs them).
CITADEL_TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Citadel numbers_git (#1221), the prompt budget's sums, the size list's and judges' counts (#1917) and README's Layout rows
# (#2104): ship-time merges in place of a stopped rebase.
MERGES='src/db.ts hook
src/db.ts append ^const\ MIGRATIONS
test/prompt-budget.test.ts sum ^const\ (BUDGET|KIT_BUDGET|TOOLS_BUDGET)\ =
test/size-budget.test.ts count ^\ \ .[[:alnum:]/._-]+.:\ \[[0-9]+,|^\ \ \ \ ([0-9]+|[^[:alnum:][:space:]].*[^[:alnum:][:space:]]),$
test/size-budget.test.ts append ^export\ const\ ALLOWED:
test/judges.test.ts count ^\ \ .[[:alnum:]/._-]+.:\ \{\ why:\ .*,\ calls:\ [0-9]+\ \},$
test/judges.test.ts append ^const\ NOT_JUDGES:
test/prompt-baseline.json main
README.md rows ^##\ Layout$
test/typecheck-baseline.json hook'

# Core hook (MERGES src/db.ts hook): Citadel's numbers_git driver, ship-numbers.ts merge; git's own merge without it.
# A tools/ without ship-numbers.ts (mid-rebase) falls back to the worktree's tools/ (git runs drivers from its root).
land_merge() {
  local t=$CITADEL_TOOLS
  [ -f "$t/ship-numbers.ts" ] || t=tools
  if [ -f "$t/ship-numbers.ts" ] && [ "${5:-}" = test/typecheck-baseline.json ]; then
    "$t/citadel-node" --no-warnings "$t/ship-numbers.ts" baseline "$1" "$2" "$3" "$4" # main's copy, measured again after the rebase (#2141)
  elif [ -f "$t/ship-numbers.ts" ]; then
    "$t/citadel-node" --no-warnings "$t/ship-numbers.ts" merge "$1" "$2" "$3" "$4"
  elif [ -z "${LAND_MERGE_DIFF3:-}" ]; then
    git merge-file "$3" "$2" "$4"
  else
    return 1
  fi
}
