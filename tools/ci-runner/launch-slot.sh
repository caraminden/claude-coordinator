#!/usr/bin/env bash
# One-job runner launcher (runner pool P2, #2269): the low-rights half, the Linux twin of launch-slot.ps1. runner-slot.sh
# start runs it as the scheme's user in the slot's transient unit:
#   launch-slot.sh <slot folder> <one-time id> <machines url>
# It wipes the last runner's registration files and writes .env with the slot's own home, then swaps the one-time id for
# the runner's just-in-time config at Citadel and starts the runner with it in ACTIONS_RUNNER_INPUT_JITCONFIG, never on a
# command line or in a file (the runner reads the variable and clears it from its own environment). Each step goes to
# <slot>/slot.log (started afresh, the last run's kept as slot.prev.log), the runner's output to <slot>/runner-console.log.
set -uo pipefail
dir=$1
once=$2
url=${3%/}
log=$dir/slot.log
[[ -f $log ]] && mv -f "$log" "$dir/slot.prev.log"
say() { printf '%s %s\n' "$(date -Is)" "$*" >> "$log"; }
fail() {
  say "error: $*"
  exit 1
}
say "launcher once ${once:0:8}: $(id -un), pid $$"
cd "$dir" || fail "no slot folder $dir"
# A runner stopped before its job leaves its registration behind (P0, #2266): never start on top of it. The last run's
# console goes too, so the agent never reads its job as this runner's.
rm -f .runner .credentials .credentials_rsaparams runner-console.log
mkdir -p home
printf '%s\n' 'DOTNET_CLI_TELEMETRY_OPTOUT=1' 'DOTNET_NOLOGO=1' "HOME=$dir/home" > .env
cfg=$(curl -fsS -X POST -H 'Content-Type: application/json' --data "{\"once\":\"$once\"}" "$url/api/machines/runner-jit" 2>&1) || fail "Citadel didn't hand over the runner's config: ${cfg:0:200}"
[[ $cfg =~ ^[A-Za-z0-9+/=]{100,}$ ]] || fail "Citadel's answer isn't a runner config"
say 'starting the runner'
ACTIONS_RUNNER_INPUT_JITCONFIG=$cfg ./run.sh > runner-console.log 2>&1
code=$?
unset cfg
say "runner exited $code"
exit "$code"
