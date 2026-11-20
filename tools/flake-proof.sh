#!/usr/bin/env bash
# One batch of a flake proof (#1120, .github/workflows/flake-proof.yml): runs a test file N times in a row, each run under CPU
# load (the flakes this counts failed in a full run at load 12 to 26 and passed alone, so a quiet box would pass an unfixed one).
# Stops at the first red run. Usage: tools/flake-proof.sh test/x.test.ts [runs] [burners]
set -uo pipefail
file=${1:?usage: flake-proof.sh test/x.test.ts [runs] [burners]}
runs=${2:-10}
burners=${3:-$(( $(nproc) / 2 ))}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pids=()
for _ in $(seq "$burners"); do bash -c 'while :; do :; done' & pids+=($!); done
trap 'kill "${pids[@]}" 2>/dev/null' EXIT
for i in $(seq "$runs"); do
  "$here/citadel-node" --test --test-force-exit "$file" || { echo "flake-proof: $file failed on run $i of $runs under load"; exit 1; }
done
echo "flake-proof: $file: $runs clean runs under load"
