#!/usr/bin/env bash
# One batch of a flake proof (#1120, .github/workflows/flake-proof.yml): runs a test file as N copies at once, each with its own
# TMPDIR, under CPU load (the flakes this counts failed in a full run at load 12 to 26 and passed alone, so a quiet box would pass
# an unfixed one). Copies at once, not one after another (#1443): the ship's burn-in has the same shape (tools/burn-in.sh, which
# runs them), and #1327 measured runs in a row catching 0 or 1 in 10 where copies at once caught 9 or 10.
# The run asks Citadel before its first batch and is stopped while a ship is in line (flake-proof.yml's ask step, #1902); everything
# it starts (burners and test runs) is nice 19, so a ship's run on the same desktop gets the CPU first (#1359). The proof still runs
# under load: a quiet box would pass an unfixed flake.
# A batch fails when any copy fails or hangs. Usage: tools/flake-proof.sh test/x.test.ts [runs] [burners]
set -uo pipefail
file=${1:?usage: flake-proof.sh test/x.test.ts [runs] [burners]}
runs=${2:-10}
burners=${3:-$(( $(nproc) / 2 ))}
# Off CI tools/burn-in.sh runs at most 4 copies (#1725): refuse a bigger batch before any burner starts, not report copies that never ran.
[ -n "${RUNNER_TEMP:-}${CI:-}${GITHUB_ACTIONS:-}" ] || [ "$runs" -le 4 ] 2>/dev/null || { echo "flake-proof: $runs copies at once is a CI batch (flake-proof.yml); off CI a burn-in runs at most 4"; exit 2; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pids=()
for _ in $(seq "$burners"); do nice -n 19 bash -c 'while :; do :; done' & pids+=($!); done
trap 'kill "${pids[@]}" 2>/dev/null' EXIT
if [ "$runs" -gt 0 ]; then
  # A test that skipped (a missing tool, such as pwsh for the .ps1 lint) proves nothing, so one run first must skip none
  # (#1519 CB2). burn-in.sh keeps no copy's output, so this run is its own.
  log=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/flake-proof.XXXXXX")
  (unset NODE_TEST_CONTEXT; timeout -k 10 "${BURN_IN_FILE_LIMIT:-600}" nice -n 19 "$here/citadel-node" --test --test-force-exit --test-timeout=$((${CITADEL_TEST_TIMEOUT:-60} * 1000)) --test-reporter=spec "$file") >"$log" 2>&1
  if ! grep -q '^ℹ skipped 0$' "$log"; then
    grep -E '^ *﹣|^ℹ (skipped|fail)' "$log" | head -n 20
    rm -f "$log"
    echo "flake-proof: $file skipped a test on this runner (the lines with ﹣ above), so it proves nothing: install what it needs"; exit 1
  fi
  rm -f "$log"
  BURN_IN_NICE='nice -n 19' "$here/burn-in.sh" "$file" "$runs" || { echo "flake-proof: $file failed in its batch of $runs copies at once under load"; exit 1; }
fi
echo "flake-proof: $file: $runs clean runs at once under load"
