#!/usr/bin/env bash
# win-ports.sh before|after STATE: the Windows half of the leak count (#1763). The suite runs in the WSL distro
# citadel-ci, which can't see Windows (no C:, no Windows programs), so keep-wsl-up.ps1's task "Citadel WSL ports" writes
# the count of Windows listening ports held by wslrelay into the distro every 10 s, as `wslrelay=N,listen=M` in
# /run/citadel-win-ports. #1753: wslrelay opened a Windows listener for each WSL server and never closed it, ~1,760 in
# 36 h, until Windows ran short of ports. With localhostForwarding=false it holds none, so a rise across a suite means
# the leak is back.
#   before: keeps the count in STATE. No count file (perigee, GitHub's runners, a PC that hasn't re-run keep-wsl-up.ps1)
#           or a stale one: says so and keeps nothing, so `after` checks nothing.
#   after:  waits for a fresh write, compares; a rise that is still there at the write after goes red.
# A false red blocks every ship, so anything it can't read is a warning, never a red.
set -uo pipefail
f=${CITADEL_WIN_PORTS:-/run/citadel-win-ports}
tick=${WIN_PORTS_TICK:-10} # seconds between the task's writes
cmd=${1:-} state=${2:-}
[[ ($cmd == before || $cmd == after) && -n $state ]] || { echo 'usage: win-ports.sh before|after STATE' >&2; exit 2; }

count() { tr -d '\r' <"$f" 2>/dev/null | sed -n 's/^wslrelay=\([0-9][0-9]*\),.*/\1/p'; }
stamp() { stat -c %i.%Y "$f" 2>/dev/null; } # each write is a rename: a new inode, so this changes even within a second
next() { # waits for the task's next write; fails after three ticks
  local was; was=$(stamp); local end=$((SECONDS + 3 * tick))
  while ((SECONDS < end)); do [[ $(stamp) != "$was" ]] && return 0; sleep 0.5; done
  return 1
}

if [[ $cmd == before ]]; then
  rm -f "$state"
  [[ -e $f ]] || { echo "win-ports: no Windows port count on this runner ($f), so it isn't checked"; exit 0; }
  if (($(date +%s) - $(stat -c %Y "$f") > 3 * tick)); then
    echo "::warning::win-ports: $f is older than $((3 * tick)) s, so the PC's task \"Citadel WSL ports\" isn't writing it (tools/ci-runner/README.md, \"Linux runners in WSL\" step 4); Windows' ports aren't checked this run"
    exit 0
  fi
  n=$(count)
  [[ -n $n ]] || { echo "::warning::win-ports: can't read $f ($(head -c 80 "$f")); Windows' ports aren't checked this run"; exit 0; }
  echo "$n" >"$state"
  echo "win-ports: wslrelay holds $n listening ports on Windows before the suite"
  exit 0
fi

[[ -s $state ]] || exit 0
was=$(<"$state")
stale="::warning::win-ports: no fresh count in $((3 * tick)) s from the PC's task \"Citadel WSL ports\"; Windows' ports aren't checked this run"
next || { echo "$stale"; exit 0; }
n=$(count)
[[ -n $n ]] || { echo "::warning::win-ports: can't read $f; Windows' ports aren't checked this run"; exit 0; }
if ((n > was)); then
  # A server another run has open right now shows too: only a count still up a write later counts.
  next || { echo "$stale"; exit 0; }
  n=$(count)
fi
if [[ -n $n ]] && ((n > was)); then
  echo "::error::wslrelay holds $n listening ports on Windows, up from $was before the suite: WSL's localhost relay is leaking Windows ports again (#1753). Check localhostForwarding=false in %UserProfile%\\.wslconfig (tools/ci-runner/README.md, \"Linux runners in WSL\" step 1)."
  exit 1
fi
echo "win-ports: wslrelay holds ${n:-?} listening ports on Windows after the suite ($was before)"
