# The shared Android emulator on Cara's desktop (#533)

The emulator every scheme's minions test on (`citadel-android`, the `citadel:android-app` skill) runs in a
WSL2 distro of its own, `citadel-android`, on Cara's desktop, where it has hardware acceleration and RAM to
spare. Before this it ran on perigee, took about 4.3 GB of its 29 GB and was OOM-killed in the Nov 10 jam.
Cara picked the move on 2026-11-11 ("Move it to the desktop"); nothing changes in what a minion types.

## How it fits together

perigee can't open a connection to the desktop, so the desktop dials perigee: one SSH tunnel, held by a
service in the distro, puts four of the distro's ports on perigee's loopback.

| On perigee's loopback | Is | Used by |
|---|---|---|
| `127.0.0.1:18590` | the starter in the distro: a connection starts the emulator and marks it used | `citadel-android up` and every other step |
| `127.0.0.1:5555` | the emulator's adb port | perigee's adb server |
| `127.0.0.1:5554` | the emulator's console | `citadel-android sms` and `down` |
| `127.0.0.1:18591` | the emulator's gRPC port, open only for feeding its microphone | `citadel-android mic` and `mic-check` (#843) |

- **The adb server stays on perigee** (`deploy/citadel-android-adb.service`, on `127.0.0.1:5037`). So the phone
  is still `emulator-5554`, and `adb reverse` and `adb forward` still end on perigee, where the dev servers are.
- **The emulator's own adb commands** go to perigee's adb server too, through the same tunnel (the distro's
  `127.0.0.1:15037`). A second adb server in the distro would take the phone away from perigee's.
- **It starts on demand** and stops itself after 15 minutes with no `citadel-android` call, as before. It gets
  4 cores and 4 GB there.
- **While the desktop is away** (asleep, restarting, Cara not logged on) there is no emulator: `citadel-android`
  says so within about 10 seconds and exits 1. Nothing falls back to perigee. When the PC is back, the tunnel
  reconnects by itself within about a minute.
- **The key** the tunnel logs in with can do three things on perigee and nothing else: hold those four ports,
  reach perigee's adb server, and run [`perigee-key.sh`](perigee-key.sh) (hand the distro perigee's adb key and
  console token; end a tunnel left over from before a restart). It gets no shell. Reaching the adb server
  does mean the distro could ask the phone for an `adb reverse` or `forward` to any port on perigee's
  loopback, as any turn on perigee can.
- `10.0.2.2` inside the phone is now the desktop's distro, not perigee. Reach a perigee server with
  `adb reverse`, as the skill says.

## Setup (once, about 20 minutes, most of it a download)

Nothing here needs Administrator or a reboot. **If a step asks for a reboot or a Windows feature, stop and
tell the minion**: the PC is never restarted for this. The setup line is safe to paste again at any point; it
skips what is done.

1. **The distro.** In a normal PowerShell on the desktop:

   ```powershell
   wsl --install Ubuntu-24.04 --name citadel-android
   ```

   If it asks for a UNIX user name and password, give any; nothing uses them. Type `exit` when it opens a shell.

2. **Setup, first run.** Open a root shell in the distro and paste the setup line, with the address Citadel's
   Machines page shows for agents (the same one the CI runners' steps use), already filled in below
   (`http://perigee.tail59477f.ts.net:8574`, the live server's `MACHINES_URL`; the log's "Machines connect at" line shows it):

   ```powershell
   wsl -d citadel-android -u root
   ```

   ```bash
   u='http://perigee.tail59477f.ts.net:8574'; f=$(mktemp) && curl -fsSL "$u/android-desktop/setup.sh" -o "$f" && bash "$f" "$u"
   ```

   It writes `/etc/wsl.conf` and stops. Restart the distro and open it again:

   ```powershell
   exit
   wsl --terminate citadel-android
   wsl -d citadel-android -u root
   ```

3. **Setup, second run.** Paste the same setup line. It installs the Android SDK and the phone (a few GB,
   several minutes), then prints one long line that starts with `echo 'restrict,port-forwarding,`. Copy it.

4. **On perigee.** SSH into perigee as usual and paste that line. Then switch perigee over: its own emulator
   stops, and its adb server starts as a small service of its own.

   ```bash
   systemctl --user disable --now citadel-android-starter.socket
   systemctl --user stop citadel-android.service
   ~/.local/share/android-sdk/platform-tools/adb kill-server
   systemctl --user enable --now ~/claude-coordinator/deploy/citadel-android-adb.service
   ```

5. **Setup, third run.** Back in the distro, paste the same setup line once more. It fetches what perigee
   shares, installs the services and waits for the tunnel. It should end with "The tunnel to perigee is up".

6. **Keep it up.** In a normal PowerShell (not the distro), with the same address:

   ```powershell
   $u = 'http://perigee.tail59477f.ts.net:8574'; iwr "$u/ci-runner/keep-wsl-up.ps1" -UseBasicParsing -OutFile "$env:TEMP\keep-wsl-up.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\keep-wsl-up.ps1" -Distro citadel-android
   ```

   It registers the logon task **Citadel WSL citadel-android**, which holds the distro open: WSL stops a distro
   seconds after the last program using it exits, and the tunnel with it.

7. **Tell the minion.** It boots the phone from a host turn and a container turn and checks a screenshot.

The phone starts empty: apps, Chrome tabs and logins on perigee's old phone don't come along.

## Updating

Paste the setup line again in the distro (`wsl -d citadel-android -u root`). It downloads the current
`citadel-android` and rewrites the services. A change to `tools/citadel-android` that only touches perigee's
side (most of them) needs nothing here.

## Adding the mic port

The synthetic microphone (`citadel-android mic`, #843) added a fourth port, 18591, to the tunnel. A key line added
before then allows only three, and the tunnel refuses to start until perigee's line allows the fourth. Once, in
this order:

1. **On perigee**, add the port to the key's line (it ends in `citadel-android`):

   ```bash
   sed -i '/citadel-android$/{/18591/!s/permitlisten="127.0.0.1:5555",/&permitlisten="127.0.0.1:18591",/}' ~/.ssh/authorized_keys
   ```

2. **In the distro** (`wsl -d citadel-android -u root`), paste the setup line again. It rewrites the emulator's
   service with the gRPC port and the tunnel with the fourth port. The phone's next boot is a cold one (about a
   minute longer), because its microphone setting changed.

## When it doesn't work

All of these run in the distro's root shell (`wsl -d citadel-android -u root`) unless they say perigee.

| What you see | Look at | Usually |
|---|---|---|
| `citadel-android`: "the emulator's desktop isn't connected" | `systemctl status citadel-android-tunnel` | The PC slept or the distro stopped: `wsl -l -v` in PowerShell shows whether `citadel-android` is Running; the logon task from step 6 starts it. |
| The tunnel restarts every 10 seconds with "remote port forwarding failed" | `journalctl -u citadel-android-tunnel -n 20` | Something on perigee holds 18590, 5554, 5555 or 18591: perigee's old starter is still enabled (step 4), or an emulator runs there. Naming 18591 alone after an update: perigee's key line lacks the mic port ("Adding the mic port"). |
| The tunnel says "Permission denied" | the same | The key's line isn't in perigee's `~/.ssh/authorized_keys` (step 4). Paste the setup line again to see it. |
| The tunnel can't resolve or reach perigee | `ssh -i /home/android/.ssh/citadel_android cara@perigee.tail59477f.ts.net facts` | WSL isn't reaching the tailnet: add `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig`, then `wsl --shutdown` ([`.wslconfig` settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#wslconfig)). That stops the CI distro too; its logon task restarts it. |
| `up` gives up after 6 minutes | `journalctl -u citadel-android -n 50` | The emulator's own log. "/dev/kvm" errors: `ls -l /dev/kvm` must show group `kvm`. |
| The phone shows as `offline` or `unauthorized` on perigee | paste the setup line again | perigee's adb key changed; setup fetches it again. Then `citadel-android down` and `up`. |
| perigee's adb server keeps restarting while the phone is up | `journalctl --user -u citadel-android-adb -n 20` on perigee | The distro's adb is a different protocol version from perigee's, and each kills the other's server. Update perigee's platform-tools (`tools/android/install-sdk.sh`) or paste the setup line again, so both are current. |

## Going back to perigee

The old services stay in `deploy/` until the move has held for a week. To go back:

```bash
# in the distro
systemctl disable --now citadel-android-tunnel citadel-android-starter.socket; systemctl stop citadel-android
# on perigee
systemctl --user disable --now citadel-android-adb.service
systemctl --user enable --now citadel-android-starter.socket
```

perigee's phone is as it was left. To remove the desktop's side for good: `wsl --unregister citadel-android`
and `Unregister-ScheduledTask 'Citadel WSL citadel-android'` in PowerShell, and delete the key's line
(it ends in `citadel-android`) from perigee's `~/.ssh/authorized_keys`.

## What was checked

On 2026-11-11 the whole arrangement ran on perigee with a network-isolated stand-in for the distro and a
private sshd using the same key options: `up` (40 s cold, 6 s quick boot), `shot`, `adb reverse` to a server
on the perigee side, `sms`, a 30 MB push, `down`, the tunnel dropping and returning, `takeover` of a frozen
tunnel, and the key refusing a shell and other ports. Not rehearsed there: `setup.sh` itself, systemd's units
and WSL, which first run in Cara's steps above.
