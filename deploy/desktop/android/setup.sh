#!/usr/bin/env bash
# Sets up Citadel's shared Android emulator in a WSL2 distro of its own on Cara's desktop (#533). Cara runs
# it as root in the distro `citadel-android`, with the address the Machines page shows for agents
# (README.md beside this file has her steps):
#
#   bash setup.sh <citadel machines url> [<ssh login on perigee>]
#
# Run it again to update or repair: every step skips what is already there. It:
#   1. writes /etc/wsl.conf: systemd on, and the distro cut off from Windows. If that changed anything it
#      stops there and says to restart the distro, then run it again;
#   2. installs what it needs from Ubuntu's archive (ssh, curl, unzip, a JRE for the SDK's tools, libX11);
#   3. makes the user `android` (in the kvm group, no sudo) that everything below runs as;
#   4. downloads citadel-android and install-sdk.sh from Citadel into /opt/citadel-android (root's);
#   5. installs the Android SDK, the emulator and the `citadel` AVD, as on perigee (a few GB, once);
#   6. makes an SSH key and asks perigee, with it, for the two things the emulator must share with perigee:
#      perigee's adb key (so its adb server is let in) and its console token (so `sms` and `down` work
#      from there). Until Cara has added the SSH key on perigee it prints the line to add and stops;
#   7. installs three services: the emulator (started on demand, stops itself when idle), its starter on
#      127.0.0.1:18590, and the tunnel, which dials perigee and puts the starter and the emulator's two
#      ports on perigee's loopback. perigee can't reach this PC, so everything goes through that tunnel.
#      The tunnel also gives the emulator perigee's adb server on 127.0.0.1:15037 here: the emulator runs
#      adb commands of its own, and a second adb server here would take the phone away from perigee's.
# It touches nothing on Windows and never restarts the PC.
set -euo pipefail

url=${1:-}
url=${url%/}
target=${2:-cara@perigee.tail59477f.ts.net}
dir=/opt/citadel-android
user=android
home=/home/$user
key=$home/.ssh/citadel_android
# perigee's side of the key: it may hold these three ports open on perigee's loopback, and reach perigee's adb server.
helper='/home/cara/claude-coordinator/deploy/desktop/android/perigee-key.sh'
ports=(18590 5554 5555)
adb_here=15037 # not 5037: with WSL's mirrored networking that is Windows' own adb server, when Cara runs one

die() { echo "setup: $*" >&2; exit 1; }
as_android() { runuser -u "$user" -- env HOME="$home" "$@"; }

[[ -n $url ]] || die 'usage: setup.sh <the address the Machines page shows> [<ssh login on perigee>]'
[[ $(id -u) == 0 ]] || die 'Run this as root: in PowerShell, wsl -d citadel-android -u root'
cd / # root's home isn't readable by the user the steps below run as

# 1. systemd on (the emulator and the tunnel are its services); no Windows drives or programs.
want='# Citadel'"'"'s Android emulator (#533, deploy/desktop/android/setup.sh): systemd for its services, and nothing of
# Windows reachable from here.
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
  echo 'Wrote /etc/wsl.conf. Restart the distro for it to take: in PowerShell, wsl --terminate citadel-android'
  echo 'then open it again (wsl -d citadel-android -u root) and run this same line again.'
  exit 0
fi
[[ -d /run/systemd/system ]] || die 'systemd is not running although /etc/wsl.conf turns it on: in PowerShell, wsl --terminate citadel-android, then run this again.'
[[ -e /dev/kvm ]] || die 'There is no /dev/kvm here, so the emulator would crawl. Stop and tell the minion.'

# One clock keeper for the whole WSL VM (#542): every distro shares one kernel clock, WSL's own chrony already
# keeps it by the Windows clock, and this distro's systemd-timesyncd stepping it too skewed every distro's clock by
# 2% (tools/ci-runner/README.md, "Citadel's own tests").
if grep -qa 'refclock PHC' /init 2>/dev/null && [[ $(systemctl is-enabled systemd-timesyncd 2>/dev/null) != masked ]]; then
  systemctl mask --now systemd-timesyncd
  echo 'Turned systemd-timesyncd off: WSL keeps the clock by the Windows clock, and the two fought over it (#542).'
fi

# 2. What it needs. libX11: the headless emulator still links against it.
java=/usr/lib/jvm/java-21-openjdk-amd64
if ! command -v ssh >/dev/null || ! command -v curl >/dev/null || ! command -v unzip >/dev/null || [[ ! -x $java/bin/java ]] || ! ldconfig -p | grep -q 'libX11\.so\.6'; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends openssh-client curl ca-certificates unzip openjdk-21-jre-headless libx11-6
fi

# 3. Its user. The kvm group is what lets the emulator use hardware virtualisation.
id "$user" >/dev/null 2>&1 || useradd -m -s /bin/bash "$user"
usermod -aG kvm "$user"
install -d -o "$user" -g "$user" -m 700 "$home/.ssh" "$home/.heavy"
install -d -o "$user" -g "$user" -m 750 "$home/.android"

# 4. The tool and the SDK installer, as Citadel serves them now. Moved into place, never written over: a running
#    emulator's service is still reading the old file.
install -d -m 755 "$dir"
for f in citadel-android install-sdk.sh; do
  curl -fsSL -o "$dir/.$f.new" "$url/android-desktop/$f" || die "Couldn't download $url/android-desktop/$f"
  chmod 755 "$dir/.$f.new"
  mv -f "$dir/.$f.new" "$dir/$f"
  echo "$(sha256sum "$dir/$f" | cut -d' ' -f1)  $f"
done

# 5. The SDK, the emulator and the AVD.
as_android CITADEL_ANDROID_JAVA_HOME="$java" bash "$dir/install-sdk.sh"
sdk=$home/.local/share/android-sdk
# Its own libraries are in emulator/lib64, which the emulator's launcher puts on the path; only the system's can be missing.
missing=$(LD_LIBRARY_PATH="$sdk/emulator/lib64" ldd "$sdk"/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless | grep 'not found' || true)
[[ -z $missing ]] || die "The emulator is missing system libraries; tell the minion: $missing"

# 6. The key, and what perigee shares.
[[ -f $key ]] || as_android ssh-keygen -q -t ed25519 -N '' -C citadel-android -f "$key"
ssh_opts=(-i "$key" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
if ! facts=$(as_android ssh "${ssh_opts[@]}" "$target" facts 2>/dev/null) || ! grep -q '^adbkey' <<< "$facts"; then
  listen=$(printf 'permitlisten="127.0.0.1:%s",' "${ports[@]}")
  echo
  echo "perigee doesn't know this distro's key yet (or $target can't be reached from here)."
  echo 'SSH into perigee as usual and run this one line there. It lets the key hold those three ports open on'
  echo "perigee's own loopback, reach perigee's adb server and ask one script two questions, nothing else (no shell):"
  echo
  echo "echo 'restrict,port-forwarding,${listen}permitopen=\"127.0.0.1:5037\",command=\"$helper\" $(cat "$key.pub")' >> ~/.ssh/authorized_keys"
  echo
  echo 'Then run this same setup line again.'
  exit 0
fi
adbkey=$(sed -n 's/^adbkey //p' <<< "$facts")
[[ -n $adbkey ]] || die "perigee has no adb key (~/.android/adbkey) yet. Tell the minion."
# The emulator works the public half out itself; one left from another key would only mislead.
rm -f "$home/.android/adbkey.pub"
# An empty token file turns the console's check off, which is right when perigee has none either.
( umask 077; base64 -d <<< "$adbkey" > "$home/.android/adbkey"; sed -n 's/^token //p' <<< "$facts" > "$home/.emulator_console_auth_token" )
chown "$user:$user" "$home/.android/adbkey" "$home/.emulator_console_auth_token"

# 7. The services.
cat > /etc/systemd/system/citadel-android.service <<EOF
# Written by Citadel's deploy/desktop/android/setup.sh (#533). Never enabled: its starter starts it, and it
# stops itself after 15 minutes with no citadel-android call on perigee.
[Unit]
Description=Citadel's shared headless Android emulator (stops itself when idle)

[Service]
User=$user
Environment=ANDROID_HOME=$sdk
Environment=CITADEL_HEAVY_DIR=$home/.heavy
Environment=CITADEL_ANDROID_ROLE=desktop
Environment=CITADEL_ANDROID_CORES=4
Environment=CITADEL_ANDROID_MEMORY=4096
# perigee's adb server, through the tunnel: where the emulator announces itself and sends its own adb commands.
Environment=ANDROID_ADB_SERVER_PORT=$adb_here
ExecStart=$dir/citadel-android serve
# TERM to the serve loop, which shuts the emulator down cleanly (saving quick boot); the rest after that.
KillMode=mixed
TimeoutStopSec=120
EOF
cat > /etc/systemd/system/citadel-android-starter.socket <<EOF
# Written by Citadel's deploy/desktop/android/setup.sh (#533). perigee's citadel-android connects here through
# the tunnel: to start the emulator, and after each step to mark it used.
[Unit]
Description=Starter for Citadel's shared Android emulator (loopback)

[Socket]
ListenStream=127.0.0.1:${ports[0]}
Accept=yes
MaxConnections=16

[Install]
WantedBy=sockets.target
EOF
cat > /etc/systemd/system/citadel-android-starter@.service <<EOF
# Written by Citadel's deploy/desktop/android/setup.sh (#533). One connection to the starter.
[Unit]
Description=Start Citadel's shared Android emulator, or mark it used

[Service]
Type=oneshot
User=$user
StandardOutput=socket
StandardError=journal
ExecStart=/usr/bin/touch $home/.heavy/android.used
ExecStart=+/usr/bin/systemctl start --no-block citadel-android.service
ExecStart=/usr/bin/echo "asked the desktop to start citadel-android.service"
EOF
ssh_run="/usr/bin/ssh -i $key -o BatchMode=yes -o ConnectTimeout=10"
cat > /etc/systemd/system/citadel-android-tunnel.service <<EOF
# Written by Citadel's deploy/desktop/android/setup.sh (#533). perigee can't open a connection to this PC, so
# this dials perigee and holds the starter and the emulator's console and adb ports open on perigee's loopback.
# Before each start it has perigee end a tunnel left over from before a restart, which would still hold the ports.
[Unit]
Description=Tunnel from Citadel's Android emulator to perigee
After=network-online.target
Wants=network-online.target

[Service]
User=$user
ExecStartPre=-$ssh_run $target takeover
ExecStart=$ssh_run -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:$adb_here:127.0.0.1:5037$(printf ' -R 127.0.0.1:%s:127.0.0.1:%s' "${ports[0]}" "${ports[0]}" "${ports[1]}" "${ports[1]}" "${ports[2]}" "${ports[2]}") $target
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now citadel-android-starter.socket >/dev/null
systemctl enable citadel-android-tunnel.service >/dev/null
systemctl restart citadel-android-tunnel.service

echo 'Installed. Waiting for the tunnel to hold...'
ok=''
for _ in $(seq 15); do
  sleep 2
  # Up, and past the moment a refused port would have ended it.
  if [[ $(systemctl show -p SubState --value citadel-android-tunnel.service) == running ]] && (( $(date +%s) - $(date -d "$(systemctl show -p ExecMainStartTimestamp --value citadel-android-tunnel.service)" +%s) >= 5 )); then ok=1; break; fi
done
echo
if [[ -n $ok ]]; then
  echo 'The tunnel to perigee is up, and the emulator starts when a minion asks for it.'
  echo "Last step, on Windows: keep-wsl-up.ps1 -Distro citadel-android (README, \"Keep it up\")."
else
  journalctl -u citadel-android-tunnel.service -n 6 --no-pager || true
  echo
  echo "The tunnel isn't holding yet. If the lines above say a port forwarding failed, perigee's own emulator"
  echo 'starter still has port 18590: run the perigee line from the README ("Switch perigee over"), and the'
  echo 'tunnel connects by itself within 10 seconds. Check with: systemctl status citadel-android-tunnel'
fi
