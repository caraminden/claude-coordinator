#!/usr/bin/env bash
# One batch of a flake proof (#1120, .github/workflows/flake-proof.yml): runs a test file as N copies at once, each with its own
# TMPDIR, under CPU load (the flakes this counts failed in a full run at load 12 to 26 and passed alone, so a quiet box would pass
# an unfixed one). Copies at once, not one after another (#1443): the ship's burn-in has the same shape (tools/burn-in.sh, which
# runs them), and #1327 measured runs in a row catching 0 or 1 in 10 where copies at once caught 9 or 10.
# Before the batch it waits while a ship's tests run (tests.yml on a land branch) is queued or running, and everything it starts
# (burners and test runs) is nice 19, so a ship's run on the same desktop gets the CPU first (#1359). The proof still runs under
# load: a quiet box would pass an unfixed flake.
# A batch fails when any copy fails or hangs. Usage: tools/flake-proof.sh test/x.test.ts [runs] [burners]
set -uo pipefail
file=${1:?usage: flake-proof.sh test/x.test.ts [runs] [burners]}
runs=${2:-10}
burners=${3:-$(( $(nproc) / 2 ))}
# Off CI tools/burn-in.sh runs at most 4 copies (#1725): refuse a bigger batch before any burner starts, not report copies that never ran.
[ -n "${RUNNER_TEMP:-}${CI:-}${GITHUB_ACTIONS:-}" ] || [ "$runs" -le 4 ] 2>/dev/null || { echo "flake-proof: $runs copies at once is a CI batch (flake-proof.yml); off CI a burn-in runs at most 4"; exit 2; }
# Same read and same give-up as tests.yml's "wait for the lands" step: only runs from the last 15 minutes count, a failed read
# counts as a ship running, and after 30 minutes (60 looks, 30 s apart) it starts anyway. Without GH_TOKEN (a run by hand) it skips.
wait_for_ships() {
  [ -n "${GH_TOKEN:-}" ] || { echo "flake-proof: no GH_TOKEN, not waiting for ships"; return 0; }
  local busy since status n
  for _ in $(seq "${FLAKE_PROOF_WAIT_LOOKS:-60}"); do
    busy=0
    since=$(date -u -d '15 minutes ago' +%FT%TZ)
    for status in queued in_progress; do
      n=$(curl -fsS -H "Authorization: Bearer $GH_TOKEN" "${GITHUB_API_URL:-https://api.github.com}/repos/$GITHUB_REPOSITORY/actions/workflows/tests.yml/runs?event=push&status=$status&created=%3E$since&per_page=1" \
        | python3 -c 'import json, sys; print(json.load(sys.stdin)["total_count"])') || n=x
      [ "$n" = x ] && echo "flake-proof: could not read the $status ship runs from GitHub (the curl line above says why)"
      [ "$n" = x ] && n=1
      busy=$((busy + n))
    done
    [ "$busy" = 0 ] && { echo "flake-proof: no ship's tests are running: starting the batch"; return 0; }
    echo "flake-proof: $busy ship run(s) queued or running, or unknown; waiting"
    sleep "${FLAKE_PROOF_WAIT_SLEEP:-30}"
  done
  echo "flake-proof: ship runs kept going (or GitHub unread) for 30 minutes: starting anyway, niced"
}
wait_for_ships
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
