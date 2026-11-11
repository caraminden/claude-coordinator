#!/usr/bin/env bash
# Lists every GitHub Actions runner in the WSL distro on Cara's desktop (Citadel #510), the Linux twin of
# list-runners.ps1: each runner folder in /opt, its systemd service's state, and whether Citadel made it (a
# .citadel-runner marker names the repo it serves). Read-only.
set -euo pipefail
root=${CITADEL_RUNNER_ROOT:-/opt}

found=0
for dir in "$root"/actions-runner*/; do
  dir=${dir%/}
  [[ -d $dir ]] || continue
  found=1
  unit=$( [[ -f $dir/.service ]] && cat "$dir/.service" || true)
  state=$( [[ -n $unit ]] && { systemctl is-active "$unit" || true; } || echo 'no service')
  whose="not Citadel's"
  [[ -f $dir/.citadel-runner ]] && whose="Citadel's, for $(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).repo) } catch { console.log("(its marker does not read)") }' "$dir/.citadel-runner")"
  echo "${unit:-(no service)}  $state  $dir  ($whose)"
done
[[ $found == 1 ]] || echo 'No Linux runners in this distro.'
