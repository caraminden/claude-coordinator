#!/usr/bin/env bash
# Installs Citadel's CI runner agent inside the WSL distro on Cara's desktop, once (Citadel #510): it then adds, lists
# and removes schemes' Linux runners when someone asks `ci_runners` with os linux. The Linux twin of
# install-runner-agent.ps1; tools/ci-runner/README.md ("Linux runners in WSL") says where it fits. Run it as root in
# the distro (`wsl -d citadel-ci -u root`); running it again updates the agent and its scripts to Citadel's current ones.
#
#   bash install-runner-agent.sh <citadel machines url>        # asks for the machine token, or reads CC_MACHINE_TOKEN
#
# It:
#   1. installs what the agent and the runners need from Ubuntu's archive (Node, git, curl, the runner's libicu);
#   2. writes /etc/wsl.conf: systemd on, and the distro cut off from Windows (no C: drive, no running Windows
#      programs), so a CI job here can't reach Cara's files or act as her on Windows. If that changed anything, it
#      stops and says to restart the distro, then run it again;
#   3. makes the user citadel-ci, which every runner's jobs run as (no sudo);
#   4. downloads runner-agent.mjs, add-runner.sh, list-runners.sh and remove-runner.sh from Citadel into
#      /opt/citadel-runner-agent, root's alone (the agent never downloads code itself), and prints their SHA-256;
#   5. keeps the machine token in a file there;
#   6. installs the systemd service citadel-runner-agent (restarted if it ever stops) and waits until it connects.
# It touches no runner and nothing on Windows.
set -euo pipefail

url=${1:-}
url=${url%/}
dir=/opt/citadel-runner-agent
log=/var/log/citadel-runner-agent.log

die() { echo "install-runner-agent: $*" >&2; exit 1; }

[[ -n $url ]] || die 'usage: install-runner-agent.sh <the address the Machines page shows>'
[[ $(id -u) == 0 ]] || die 'Run this as root: in PowerShell, wsl -d citadel-ci -u root'
token=${CC_MACHINE_TOKEN:-}
if [[ -z $token ]]; then read -rsp 'Machine token (ccm_..., from the Machines page): ' token; echo; fi
[[ $token =~ ^ccm_[0-9]+_[A-Za-z0-9_-]{43}$ ]] || die "That isn't a machine token (ccm_...) from the Machines page."

# 1. What it needs. libicu: the runner's .NET refuses to start without it.
if ! command -v node >/dev/null || ! command -v git >/dev/null || ! command -v curl >/dev/null || ! ldconfig -p | grep -q libicuuc; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends nodejs git curl ca-certificates "$(apt-cache search --names-only '^libicu[0-9]+$' | cut -d' ' -f1 | sort -V | tail -1)"
fi
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || die "Node $(node -v) is too old: the agent needs 18 or newer."

# 2. systemd on (the runners are its services); no Windows drives or programs. [user] keeps root as the distro's default.
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
if [[ $(cat /etc/wsl.conf 2>/dev/null) != "$want" ]]; then
  printf '%s\n' "$want" > /etc/wsl.conf
  echo 'Wrote /etc/wsl.conf. Restart the distro for it to take: in PowerShell, wsl --terminate citadel-ci'
  echo 'then open it again (wsl -d citadel-ci -u root) and run this same line again.'
  exit 0
fi
[[ -d /run/systemd/system ]] || die 'systemd is not running although /etc/wsl.conf turns it on: in PowerShell, wsl --terminate citadel-ci, then run this again.'
[[ ! -d /mnt/c/Windows ]] || die 'C: is still mounted although /etc/wsl.conf turns that off: in PowerShell, wsl --terminate citadel-ci, then run this again.'

# 3. The runners' user: no password, no sudo.
id citadel-ci >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash citadel-ci

# 4. The agent and its scripts, as Citadel serves them now, in a folder only root can read or change.
systemctl stop citadel-runner-agent 2>/dev/null || true
install -d -m 700 -o root -g root "$dir"
for f in runner-agent.mjs ci-runner/add-runner.sh ci-runner/list-runners.sh ci-runner/remove-runner.sh; do
  to=$dir/${f#ci-runner/}
  curl -fsSL -o "$to" "$url/$f" || die "Couldn't download $url/$f"
  chmod 600 "$to"
  echo "$(sha256sum "$to" | cut -d' ' -f1)  ${f#ci-runner/}"
done

# 5. The token, in that folder, never on the service's command line.
( umask 077; printf '%s' "$token" > "$dir/machine-token" )

# 6. The service: started now and at every start of the distro, again a minute after it ever stops.
cat > /etc/systemd/system/citadel-runner-agent.service <<EOF
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
skip=$(wc -l < "$log" 2>/dev/null || echo 0)
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
  echo 'The Linux runner agent is running and starts with the distro. Last step, on Windows: keep-wsl-up.ps1 (README, "Linux runners in WSL").'
else
  echo 'It has not connected yet: the lines above say why (nothing above means it did not start).'
fi
echo "Its log:   tail -f $log"
echo 'Stop it:   systemctl disable --now citadel-runner-agent'
echo "Remove it: systemctl disable --now citadel-runner-agent; rm -rf $dir /etc/systemd/system/citadel-runner-agent.service"
echo '(Removing the agent leaves every runner it added in place.)'
