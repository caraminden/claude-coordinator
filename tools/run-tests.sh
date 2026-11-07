#!/usr/bin/env bash
# The test run land.sh and deploy.sh make while holding the deploy lock, so it must always end (#377):
#   tools/run-tests.sh <log>     (from the repo to test; exits with the tests' status)
# --test-force-exit ends a test file once its tests are done even if one leaked a handle (a server a
# failed test never closed), and the time limit stops a test that hangs outright, with a line saying so.
# DEPLOY_TEST_TIMEOUT sets the limit in seconds (default 600; the suite takes 1-2 minutes).
set -uo pipefail
log=$1
limit=${DEPLOY_TEST_TIMEOUT:-600}
timeout -k 30 "$limit" node --test --test-force-exit test/ >"$log" 2>&1
rc=$?
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  echo "run-tests: the tests ran past ${limit}s and were stopped: a test hung (the hung file is the one with no results above)." | tee -a "$log" >&2
fi
exit "$rc"
