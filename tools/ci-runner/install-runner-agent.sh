#!/usr/bin/env bash
# Installs Citadel's CI runner agent on a Linux PC, or in a WSL distro on a Windows one, once (Citadel #510, #1933): it
# then adds, lists and removes schemes' Linux runners when someone asks `ci_runners` with os linux. The Linux twin of
# install-runner-agent.ps1; tools/ci-runner/README.md ("Linux runners on plain Linux", "Linux runners in WSL") says
# where it fits. On a Linux PC the machine agent's elevate.sh runs it (One kind of machine H2: the one sudo paste the
# Machines page shows, on Set up for CI runners). Run it as root; running it again updates the agent and its scripts.
#
#   bash install-runner-agent.sh <citadel machines url>        # asks for the machine token, or reads CC_MACHINE_TOKEN
#
# It:
#   1. in WSL only, writes /etc/wsl.conf: systemd on, and the distro cut off from Windows (no C: drive, no running
#      Windows programs), so a CI job here can't reach its owner's files or act as them on Windows. If that changed
#      anything, it stops there and says to restart the distro, then run it again;
#      and turns systemd-timesyncd off where WSL itself keeps the clock, because two keepers skew it (#542);
#   2. installs what the agent and the runners need from the distro's archive (Node, git, curl, the runner's libicu);
#      on a Linux without apt it names what to install and stops;
#   3. downloads runner-agent.mjs, add-runner.sh, list-runners.sh and remove-runner.sh from Citadel into
#      /opt/citadel-runner-agent, root's alone (the agent never downloads code itself), and prints their SHA-256;
#   4. keeps the machine token in a file there;
#   5. installs the systemd service citadel-runner-agent (restarted if it ever stops) and waits until it connects.
# On plain Linux all runners share citadel-runners.slice, held to 75% of the PC, or the owner's own number in caps.json.
# Each scheme's runners get a user of their own (no sudo) when add-runner.sh adds them. It touches no runner and
# nothing on Windows.
set -euo pipefail

url=${1:-}
url=${url%/}
# For tests; nobody else sets it.
r=${CITADEL_TEST_ROOT:-}
dir=$r/opt/citadel-runner-agent
log=$r/var/log/citadel-runner-agent.log
units=$r/etc/systemd/system

die() { echo "install-runner-agent: $*" >&2; exit 1; }

[[ -n $url ]] || die 'usage: install-runner-agent.sh http://perigee.tail59477f.ts.net:8574'
[[ $(id -u) == 0 ]] || die 'Run this as root: sudo -i on Linux, or in PowerShell wsl -d citadel-ci -u root for WSL'
[[ $(uname -m) == x86_64 ]] || die "This PC is $(uname -m): the GitHub runner it would add is the x64 one, so only 64-bit Intel and AMD PCs work."
# WSL2 says so in its kernel's name or with /run/WSL; either is enough, as being wrong would leave Windows reachable.
osrelease=$(cat "$r/proc/sys/kernel/osrelease")
wsl=false
if [[ ${osrelease,,} == *microsoft* || -d $r/run/WSL ]]; then wsl=true; fi
token=${CC_MACHINE_TOKEN:-}
if [[ -z $token ]]; then read -rsp 'Machine token (ccm_..., from the Machines page): ' token; echo; fi
[[ $token =~ ^ccm_[0-9]+_[A-Za-z0-9_-]{43}$ ]] || die "That isn't a machine token (ccm_...) from the Machines page."

# 1. WSL only: systemd on (the runners are its services); no Windows drives or programs. [user] keeps root as the distro's
#    default. The text of wsl.conf never changes: a change makes every WSL host restart its distro.
want='# Citadel CI runners (#510, tools/ci-runner/install-runner-agent.sh): systemd for the runner services, and nothing
# of Windows reachable from here, so CI jobs never see Cara'"'"'s files or run Windows programs as her.
[boot]
systemd=true

[automount]
enabled=false
mountFsTab=false

[interop]
enabled=false
appendWindowsPath=false

[user]
default=root'
if $wsl; then
  if [[ $(cat $r/etc/wsl.conf 2>/dev/null) != "$want" ]]; then
    printf '%s\n' "$want" > "$r/etc/wsl.conf"
    echo 'Wrote /etc/wsl.conf. Restart the distro for it to take: in PowerShell, wsl --terminate citadel-ci'
    echo 'then open it again (wsl -d citadel-ci -u root) and run this same line again.'
    exit 0
  fi
  [[ -d $r/run/systemd/system ]] || die 'systemd is not running although /etc/wsl.conf turns it on: in PowerShell, wsl --terminate citadel-ci, then run this again.'
  [[ ! -d $r/mnt/c/Windows ]] || die 'C: is still mounted although /etc/wsl.conf turns that off: in PowerShell, wsl --terminate citadel-ci, then run this again.'

  # One clock keeper, not two (#542). WSL's own init (3.x) runs a chrony outside the distros that steers the kernel
  # clock they all share to the Windows clock (/dev/ptp0, every 8 s), and Ubuntu turns systemd-timesyncd on in WSL to
  # steer the same clock to NTP. Neither sees the other: each timesyncd step reads to chrony as a clock running fast or slow, it
  # retunes the kernel tick to make up for it, the clock then really runs off (+7% and -2% on 2026-11-11), and
  # timesyncd steps it again every 32 s for as long as it runs. So where WSL keeps the clock, timesyncd is off, here
  # and in every other distro on the PC (README, "Citadel's own tests").
  if grep -qa 'refclock PHC' "$r/init" 2>/dev/null && [[ -e $r/usr/lib/systemd/system/systemd-timesyncd.service ]]; then
    systemctl mask --now systemd-timesyncd
    echo 'Turned systemd-timesyncd off: WSL keeps this clock by the Windows clock, and the two fought over it (#542).'
  fi
else
  [[ -d $r/run/systemd/system ]] || die 'systemd is not running here: the runners are its services.'
fi

# 2. What it needs. libicu: the runner's .NET refuses to start without it.
if ! command -v node >/dev/null || ! command -v git >/dev/null || ! command -v curl >/dev/null || ! ldconfig -p | grep -q libicuuc; then
  command -v apt-get >/dev/null || die 'No apt-get here: install Node 18+, git, curl, ca-certificates and libicu with your package manager, then run this again.'
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends nodejs git curl ca-certificates "$(apt-cache search --names-only '^libicu[0-9]+$' | cut -d' ' -f1 | sort -V | tail -1)"
fi
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || die "Node $(node -v) is too old: the agent needs 18 or newer."

# Yield (#552; Josh, 2026-11-11: "ok, CI is using my whole desktop, can we limit it a bit?"): every runner service
# (citadel-runner-*.service, through systemd's prefix drop-in, so runners added later too; the agent matches it as
# well, harmlessly) runs niced and lightly weighted, so the Android emulator sharing this VM (#533) gets its cores
# first. What keeps the VM off the rest of the PC is .wslconfig's processors= on Windows (README, "Cap and yield").
# Runners take it at their next start.
mkdir -p "$units/citadel-runner-.service.d"
printf '%s\n' '# Citadel #552: CI yields to the emulator and anything else in this VM.' '[Service]' 'Nice=10' 'CPUWeight=20' > "$units/citadel-runner-.service.d/yield.conf"
if ! $wsl; then
  # Plain Linux (#1933): all CI in one slice, held to 75% of the PC's cores, or what caps.json says (the agent sets it).
  # In WSL, .wslconfig's processors= caps the VM. The agent's own unit matches this prefix too, so its more specific
  # yield.conf replaces that one: in the capped slice, busy CI would starve the agent that sets the cap.
  mkdir -p "$units/citadel-runner-agent.service.d"
  printf '[Service]\nSlice=system.slice\n' > "$units/citadel-runner-agent.service.d/yield.conf"
  printf 'Slice=citadel-runners.slice\n' >> "$units/citadel-runner-.service.d/yield.conf"
  printf '%s\n' '[Unit]' 'Description=Citadel CI runners, capped together' '[Slice]' 'CPUAccounting=yes' "CPUQuota=$(( $(nproc) * 75 ))%" > "$units/citadel-runners.slice"
fi

# 3. The agent and its scripts, as Citadel serves them now, in a folder only root can read or change.
systemctl stop citadel-runner-agent 2>/dev/null || true
install -d -m 700 -o root -g root "$dir"
for f in runner-agent.mjs ci-runner/add-runner.sh ci-runner/list-runners.sh ci-runner/remove-runner.sh; do
  to=$dir/${f#ci-runner/}
  curl -fsSL -o "$to" "$url/$f" || die "Couldn't download $url/$f"
  chmod 600 "$to"
  echo "$(sha256sum "$to" | cut -d' ' -f1)  ${f#ci-runner/}"
done

# 4. The token, in that folder, never on the service's command line.
( umask 077; printf '%s' "$token" > "$dir/machine-token" )

# 5. The service: started now and at every start of the distro, again a minute after it ever stops.
cat > "$units/citadel-runner-agent.service" <<EOF
[Unit]
Description=Citadel CI runner agent (adds, lists and removes schemes' Linux runners when Citadel asks)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$(command -v node) $dir/runner-agent.mjs $url --token-file $dir/machine-token --log $log
WorkingDirectory=$dir
Restart=always
RestartSec=60

[Install]
WantedBy=multi-user.target
EOF
skip=0; [[ ! -f $log ]] || skip=$(wc -l < "$log")
systemctl daemon-reload
systemctl enable --now citadel-runner-agent >/dev/null
echo 'Started. Waiting for it to connect...'
said=''
for _ in $(seq 40); do
  sleep 0.5
  said=$(tail -n +"$((skip + 1))" "$log" 2>/dev/null || true)
  grep -q 'Connected to \|refused' <<< "$said" && break
done
echo "$said"
echo
if grep -q 'Connected to ' <<< "$said"; then
  if $wsl; then
    echo 'The Linux runner agent is running and starts with the distro. Last step, on Windows: keep-wsl-up.ps1 (README, "Linux runners in WSL").'
  else
    echo 'The Linux runner agent is running and starts with this PC. Next: on the Machines page, open its line and pick the schemes it may run CI for.'
    # CI jobs run as users of their own, with no sudo, which read whatever anyone on the PC may.
    for h in "$r"/home/*; do [[ ! -d $h || $(stat -c %a "$h") != *[4567] ]] || echo "Note: $h can be read by every user here, so by CI jobs: chmod 750 '$h' closes it."; done
  fi
else
  echo 'It has not connected yet: the lines above say why (nothing above means it did not start).'
fi
echo "Its log:   tail -f $log"
echo 'Stop it:   systemctl disable --now citadel-runner-agent'
echo "Remove it: systemctl disable --now citadel-runner-agent; rm -rf $dir $units/citadel-runner-agent.service $units/citadel-runner-agent.service.d"
echo '(Removing the agent leaves every runner it added in place.)'
