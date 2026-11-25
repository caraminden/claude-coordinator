#!/usr/bin/env bash
# Lists every GitHub Actions runner on this Linux PC or in this WSL distro (Citadel #510), the Linux twin of
# list-runners.ps1: Citadel's runners (the units add-runner.sh wrote, each naming its repo) with their state, then any
# other runner folder in /opt, which Citadel didn't make and never touches. Read-only.
set -euo pipefail
root=${CITADEL_RUNNER_ROOT:-/opt}
units=${CITADEL_RUNNER_UNITS:-/etc/systemd/system}

found=0
ours=()
for unit in "$units"/citadel-runner-*.service; do
  [[ -f $unit ]] || continue
  found=1
  dir=$(sed -n 's/^WorkingDirectory=//p' "$unit")
  ours+=("$dir")
  echo "$(basename "$unit")  $(systemctl is-active "$(basename "$unit")" || true)  $dir  (Citadel's, for $(sed -n '1s/^# citadel-repo=//p' "$unit"), as $(sed -n 's/^User=//p' "$unit"))"
done
for dir in "$root"/actions-runner*/; do
  dir=${dir%/}
  [[ -d $dir && ! " ${ours[*]} " =~ " $dir " ]] || continue
  found=1
  echo "(no Citadel unit)  -  $dir  (not Citadel's)"
done
[[ $found == 1 ]] || echo 'No Linux runners in this distro.'
