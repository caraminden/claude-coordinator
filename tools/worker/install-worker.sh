#!/usr/bin/env bash
# Sets up this Linux PC, or a WSL distro made for it on a Windows one (install-worker.ps1 does that part and calls this),
# to run its owner's Citadel minions (Build 7). On Linux the machine agent's elevate.sh runs it (One kind of machine H2: the
# one sudo paste the Machines page shows); an agent from before shows the whole command. Run it as root; running it
# again updates what it installed and keeps every sign-in.
#
#   bash install-worker.sh <citadel machines url> [--workers N] [--threads N] [--memory GB] [--disk GB] (each left out: sized from this PC)
#
# The machine token comes from CC_MACHINE_TOKEN, or it asks. It:
#   1. in WSL only, turns systemd-timesyncd off before anything else (one distro's timesyncd skews the clock every distro
#      on the PC shares, #542), then writes /etc/wsl.conf: systemd on, and no Windows drives or programs in here. If
#      that changed anything it stops with status 10: restart the distro and run this again (install-worker.ps1 does);
#   2. installs podman, git, curl and Node from the distro's archive;
#   3. makes the user citadel-worker (no password, and sudo only for step 4's one command), which runs everything, held to the caps;
#   4. keeps the token and caps in /etc/citadel-worker, which minions can't reach, and lets the worker set its threads and memory to
#      the Machines page's through sudo, for that one command (citadel-worker page-caps) and nothing else;
#   5. starts the worker as that user's service, at every boot, and waits until it reaches Citadel.
# Signing in to Claude and GitHub is the owner's, after: `citadel-worker signin` and `citadel-worker signin-github`.
set -euo pipefail

die() { echo "install-worker: $*" >&2; exit 1; }

# For tests; nobody else sets it.
r=${CITADEL_TEST_ROOT:-}
etc=$r/etc/citadel-worker
user=citadel-worker
home=$r/home/$user
units=$r/etc/systemd/system

url=${1:-}
url=${url%/}
[[ $url =~ ^https?://[A-Za-z0-9.:-]+$ ]] || die 'usage: install-worker.sh <citadel machines url> [--workers N] [--threads N] [--memory GB] [--disk GB] (each left out: sized from this PC)'
shift
caps=("$@")
[[ $(id -u) == 0 ]] || die 'Run this as root (with sudo).'
[[ $(uname -m) == x86_64 ]] || die "This PC is $(uname -m), and the minions' image is for 64-bit Intel and AMD PCs."

osrelease=$(cat "$r/proc/sys/kernel/osrelease")
wsl=false
if [[ ${osrelease,,} == *microsoft* || -d $r/run/WSL ]]; then wsl=true; fi

# 1. WSL. The clock comes before anything else: a fresh Ubuntu starts timesyncd by itself.
if $wsl; then
  [[ ! -e $r/usr/lib/systemd/system/systemd-timesyncd.service ]] || systemctl mask --now systemd-timesyncd
  want='# Citadel minion workers (tools/worker/install-worker.sh): systemd for the worker, and nothing of Windows in here.
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
  if [[ $(cat "$r/etc/wsl.conf" 2>/dev/null) != "$want" ]]; then
    printf '%s\n' "$want" > "$r/etc/wsl.conf"
    echo 'Wrote /etc/wsl.conf: this distro restarts once for it to take.'
    exit 10
  fi
  [[ ! -d $r/mnt/c/Windows ]] || die 'C: is still mounted although /etc/wsl.conf turns that off: in PowerShell, wsl --terminate citadel-workers, then run the command again.'
fi
[[ -d $r/run/systemd/system ]] || die 'systemd is not running here, and the worker is its service.'

token=${CC_MACHINE_TOKEN:-}
if [[ -z $token ]]; then read -rsp 'Machine token (ccm_..., from the Machines page): ' token; echo; fi
[[ $token =~ ^ccm_[0-9]+_[A-Za-z0-9_-]{43}$ ]] || die "That isn't a machine token (ccm_...) from the Machines page."
unset CC_MACHINE_TOKEN

# 2. What it needs.
missing=()
for c in podman newuidmap git curl node findmnt sudo visudo; do command -v $c >/dev/null || missing+=("$c"); done
if [[ ${#missing[@]} -gt 0 ]]; then
  command -v apt-get >/dev/null || die "Install these with your package manager, then run this again: ${missing[*]} (Node 18 or newer, and podman set up for rootless use)."
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends podman uidmap slirp4netns passt fuse-overlayfs catatonit netavark aardvark-dns dbus-user-session git curl ca-certificates nodejs util-linux sudo
fi
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || die "Node $(node -v) is too old: the worker needs 18 or newer."

# 3. Its user: rootless podman, its home its own.
id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --comment 'Citadel minion worker' "$user"
for f in subuid subgid; do
  # useradd gives a range on most distros; podman needs one.
  touch "$r/etc/$f"
  grep -q "^$user:" "$r/etc/$f" && continue
  next=$(awk -F: 'BEGIN { n = 524288 } $2 + $3 > n { n = $2 + $3 } END { print n }' "$r/etc/$f")
  echo "$user:$next:65536" >> "$r/etc/$f"
done
chmod 700 "$home"
uid=$(id -u "$user")

# Folders made after a container starts must reach it: "/" shared, at every boot (WSL mounts it private).
cat > "$units/citadel-worker-mounts.service" <<'UNIT'
[Unit]
Description=Citadel minion worker: share mounts with its containers
DefaultDependencies=no
After=local-fs.target
Before=systemd-user-sessions.service

[Service]
Type=oneshot
ExecStart=/bin/mount --make-rshared /
# The owner's host folders (citadel-worker folder add), before the worker starts. Not there yet on a first install.
ExecStart=-/usr/local/bin/citadel-worker mount-folders
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now citadel-worker-mounts

# 4. Its program, as Citadel serves it now, and the owner's settings, which its user can read but not change.
install -d -m 750 -o root -g "$user" "$etc"
# What is in that user's home is written as that user: run again, minions may have put anything there, a link to one of root's files included.
as() { (cd / && runuser -u "$user" -- env HOME="$home" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"); }
as mkdir -p "$home/app" "$home/worker" "$home/.config/systemd/user"
got=$(mktemp)
trap 'rm -f "$got"' EXIT
get() {
  curl -fsSL -o "$got" "$url/$1" || die "Couldn't download $url/$1"
  echo "$(sha256sum "$got" | cut -d' ' -f1)  ${1##*/}"
}
get worker-agent.mjs
as tee "$home/app/worker-agent.mjs" < "$got" > /dev/null
get worker-setup/citadel-worker
install -m 755 "$got" "$r/usr/local/bin/citadel-worker"
( umask 077; printf '%s' "$token" > "$etc/machine-token" )
chown "root:$user" "$etc/machine-token"
chmod 640 "$etc/machine-token"
"$r/usr/local/bin/citadel-worker" caps --no-restart ${caps[@]+"${caps[@]}"}
# The one root command the worker may run (#2085): its threads and memory from the Machines page, which citadel-worker page-caps checks. Its
# own PATH and nothing of the caller's environment: else sudo could keep that user's PATH, and its own bash or node run as root.
sudoers=$r/etc/sudoers.d/citadel-worker
mkdir -p "$r/etc/sudoers.d"
cat > "$sudoers.new" <<'SUDO'
# Citadel minion worker (tools/worker/install-worker.sh): it may set its own threads and memory to its Machines page's, and nothing else.
Defaults:citadel-worker env_reset, secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
citadel-worker ALL=(root) NOPASSWD: /usr/local/bin/citadel-worker page-caps *
SUDO
chmod 440 "$sudoers.new"
if visudo -cqf "$sudoers.new"; then
  mv -f "$sudoers.new" "$sudoers"
  grep -Eqs '^[@#]includedir /etc/sudoers\.d' "$r/etc/sudoers" || echo "Note: /etc/sudoers doesn't read /etc/sudoers.d here, so the Machines page can't raise this PC's threads and memory: citadel-worker caps does."
else
  rm -f "$sudoers.new"
  echo "Note: this PC's sudo refused the worker's rule, so the Machines page can't raise this PC's threads and memory: citadel-worker caps does."
fi
# When this install ran: with one token on two PCs, Citadel goes with the newest.
date +%s%3N > "$etc/installed"
chmod 644 "$etc/installed"

# 5. The service, as that user's own, so every container of it is inside the caps.
loginctl enable-linger "$user"
for _ in $(seq 40); do [[ ! -S $r/run/user/$uid/bus ]] || break; sleep 0.5; done
as tee "$home/.config/systemd/user/citadel-worker.service" > /dev/null <<EOF
[Unit]
Description=Citadel minion worker

[Service]
# Its own newest program, taken at each start; the copy here serves when Citadel can't be reached.
ExecStartPre=-/bin/sh -c 'curl -fsSL --max-time 30 -o $home/app/worker-agent.mjs.new $url/worker-agent.mjs && mv -f $home/app/worker-agent.mjs.new $home/app/worker-agent.mjs'
ExecStart=$(command -v node) $home/app/worker-agent.mjs $url $etc/config.json
WorkingDirectory=$home
StandardOutput=append:$home/worker.log
StandardError=append:$home/worker.log
Restart=always
RestartSec=10
# 64: a newer install has this machine's token.
RestartPreventExitStatus=64
# Minions mid-turn run on while the program restarts.
KillMode=process

[Install]
WantedBy=default.target
EOF
log=$home/worker.log
skip=0
[[ ! -f $log ]] || skip=$(as cat "$log" | wc -l)
as systemctl --user daemon-reload
as systemctl --user enable citadel-worker
as systemctl --user restart citadel-worker
echo 'Started. Waiting for it to reach Citadel...'
said=''
for _ in $(seq "${CITADEL_TEST_WAIT:-60}"); do
  sleep 0.5
  said=$(as tail -n +"$((skip + 1))" "$log" 2>/dev/null || true)
  ! grep -q "Connected to \|can't start" <<< "$said" || break
done
echo "$said"
echo
if grep -q 'Connected to ' <<< "$said"; then
  echo 'The worker is running. It builds its image now (about 5 minutes the first time); its row on the Machines page follows it.'
  echo 'Next, on that row: sign in to Claude and GitHub, then run the self-test.'
else
  echo "It has not reached Citadel yet: the lines above say why, or look in $log"
  exit 1
fi
