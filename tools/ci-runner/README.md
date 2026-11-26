# Shared CI runners

Every scheme's GitHub Actions jobs run on self-hosted runners on a member's own PC, not on GitHub's
hosted runners: GitHub refuses hosted jobs on the caraminden account, and we don't have the minutes
anyway (Josh, 2026-11-05: "We need to make the default for all schemes to use caras desktop for CI").
A personal account's runner serves one repo only, so each scheme's repo gets its own runner instance
on each PC that runs its CI (Delve's `delve-ci` shape).

This page is for **the PC's owner**: the person who lends a PC to CI. Any member can (#1933). The worked example
throughout is Cara's Windows desktop (DESKTOP-G248IJ8), the first one; its names, sizes and dated notes are that PC's,
not settings yours must copy.

## Add your PC

One PC is one row on Citadel's Machines page, and CI is one of its roles (Build 7). Nobody asks for "a runner for
scheme X" (Josh, 2026-11-25: "there should be one connection that multiple schemes can use"; #2064):

1. On the PC's row, switch **CI runners** on and press **Set up**. It shows the one install line for the runner
   agent, with the row's own token, to run as administrator on the PC: the Windows agent for Windows jobs, and on a
   Windows PC the Linux one too, in a WSL distro of its own ([Linux runners in WSL](#linux-runners-in-wsl-510);
   [plain Linux](#linux-runners-on-plain-linux-1933)). Set up waits for the agent to connect, then tests it.
2. Pick schemes under **Runs CI for**. Every scheme you're in is ticked once the agent connects, and a scheme you join
   or make later is ticked too; untick one you don't want. A scheme's runners can go on it only when you own it, you
   are in that scheme and you lent it.
3. That's all. When a ticked scheme's workflow asks for its label (`<scheme-slug>-ci`, `<scheme-slug>-ci-linux`), or a
   job waits for one, Citadel registers one runner for it on a PC lending it CI (`src/ci-auto.ts`, every 2 minutes;
   with several, the owner's order on the Machines page, then the most room). Unticking a scheme takes its runners off
   that PC. Idle runners cost a service each and nothing else. Only when no PC lends a scheme CI while its jobs wait
   do its members get one card naming PCs they could ask. Set the [caps](#your-own-caps) if 75% of the PC is too much.

`ci_runners` (below) stays for odd cases: a second runner, a [role](#runner-roles-1934), a list. A **CI runner host**
row (**Add a CI runner host** on the Machines page, before Build 7) still works, and Citadel never takes its runners
off by itself. An admin's new host is shared, with no owner, and runs CI for no scheme until an admin ticks one.

CI jobs run code from the repos you lend to, as accounts of their own without administrator rights. Don't lend a PC
to a scheme whose members you wouldn't let run programs on it.

| | Each scheme's runner |
|---|---|
| Folder | `C:\actions-runner-<repo>`, then `-2` … for more instances (up to 4), each with a `.citadel-runner` marker |
| Label | `<scheme-slug>-ci`: the scheme's name in lowercase with dashes (`Peek Auras` → `peek-auras-ci`) |
| Service | `actions.runner.<owner>-<repo>.<PC>` (then `…-2` …), as NETWORK SERVICE, delayed automatic start, restart on failure; one job at a time |
| `.env` | telemetry off, `C:\Program Files\Git\bin` first on PATH so `bash` steps run, and tool folders of its own: `MISE_DATA_DIR`, `MISE_CACHE_DIR`, `MISE_STATE_DIR`, `RUSTUP_HOME` and `CARGO_HOME` under `<its folder>\tools\` (#370: runners sharing NETWORK SERVICE's one profile broke each other's mise and cargo on Peek Auras). Runners added before #370 don't have these; remove and add them again to get them |

**Hard rules on a PC that hosts CI.** Never restart or reboot it for CI (Windows Update is paused on Cara's). Never touch
another scheme's runner, Delve's (`C:\actions-runner`, `-2`, `-3`, `-4`, `-perf`) above all.
Registration tokens (and the Linux scripts' removal tokens) last about an hour and are never written down.

## How runners get there

Citadel installs them itself (#328; Josh, 2026-11-05: "Citadel installs it itself"). The **CI runner
agent** (`public/runner-agent.mjs`) runs on the PC as SYSTEM (as root on Linux), from a scheduled task, and dials
out to Citadel like a machine agent. It does three things, when Citadel needs a scheme's runner (above) or a member
of the scheme asks:

| Ask | What runs on a Windows PC |
|---|---|
| `add`, with a count of 1 to 4 | `add-runner.ps1 -Scheme <id> -Count <n>`: installs the missing instances, then Citadel waits until GitHub shows them Idle. With a `role`, Citadel gives the new ones its labels ([Runner roles](#runner-roles-1934)) and waits until they are online |
| `list` | `list-runners.ps1`: every `actions.runner.*` service, its state and folder, and whether Citadel made it |
| `remove` | `remove-runner.ps1 -Scheme <id>`: only folders whose `.citadel-runner` marker names the scheme's repo. Citadel takes each runner off GitHub; the script then deletes its service and folder |

With `os: linux` (`{"op": "add", "count": 1, "os": "linux"}`) the same three go to a **Linux** runner agent (in WSL, or on a
Linux PC) instead, which runs `add-runner.sh`, `list-runners.sh` or `remove-runner.sh`: see
[Linux runners in WSL](#linux-runners-in-wsl-510) and
[on plain Linux](#linux-runners-on-plain-linux-1933). With more than one PC, `host` names the one an `add` goes to.

Citadel asks by itself for a scheme's first runner (above). People and Taskmasters ask, for odd cases, with the
`ci_runners` tool (a minion's or the Taskmaster's), or `POST /api/projects/<id>/ci-runners` with
`{"op": "add", "count": 2}`. Citadel checks the asker is in the scheme. An `add` or `remove` posts one note in the scheme Taskmaster's chat when it ends, with the
agent's output (and any tokens its scripts fetched) collapsed under it; a `list` posts none.

What keeps the agent narrow:
- **Only its own scripts.** It runs the scripts installed next to it, with a scheme id and a
  count, and refuses any other job or field. It never downloads code: installing again is how
  its scripts change.
- **One job at a time.** It's killed after 15 minutes, and it never restarts the PC.
- **It never sees a token.** The scripts fetch their own registration tokens (the Linux
  `remove-runner.sh` a removal token) from Citadel with the agent's machine token, and its output is scrubbed of anything token-shaped
  before it goes back.
- **Remove only removes what add made.** It acts only on folders with the scheme's marker and
  never on Delve's paths. A runner made by hand, Peek Auras' included, has no marker, so the
  agent can't remove it.
- **Remove runs nothing from a runner's folder** (#476). CI jobs run as the runner's account
  (NETWORK SERVICE, or the person for a session runner) and can write that folder, while
  `remove-runner.ps1` runs as SYSTEM, so it never runs the runner's own `config.cmd remove`.
  Instead it asks Citadel (`/api/machines/runner-token`, kind `delete`, with the runner's name
  and the label its kind carries) to delete the runner on GitHub, which Citadel does with the
  scheme owner's GitHub login and only for a runner carrying that label: `<slug>-ci` for a
  service runner, the logon task's `<slug>-desktop` for a session runner, both from what an
  admin made. A name GitHub no longer lists counts as removed. Then the script stops and deletes the Windows
  service (`sc.exe`), ends what still runs from the folder and deletes the folder, without
  following a link in it. The name comes from the service's name, which only an admin sets;
  the folder's `.runner` is read (as JSON) only for a session runner, which has no service, or
  a service name GitHub cut at 80 characters. The remaining limit: Citadel can't tell two
  runners with the same label on different PCs apart, so in those two cases a job that
  rewrote `.runner` could make the removal take another PC's runner of the same kind off
  GitHub instead. If Citadel or GitHub refuses (GitHub won't
  delete a runner in the middle of a job), that runner's service and folder stay, the script
  says why, and running it again finds it.
- **Locked-down folder.** Its folder, `C:\ProgramData\citadel-runner-agent`, is writable only by
  Administrators and SYSTEM.

Session runners (below) are added by hand, not by the agent: their logon task is for the person
who runs `add-runner.ps1`, and the agent runs as SYSTEM. The agent's `list` shows them and its
`remove` removes them.

## Runner roles (#1934)

What a runner is for is its labels, which workflows' `runs-on` picks. `ci_runners add` takes a `role`, and Citadel sets that
role's labels on the runners the add makes, through GitHub's API with the scheme owner's login, as soon as GitHub lists each:

| Role | Labels (`L` is `<scheme-slug>-ci`, or `<scheme-slug>-ci-linux` with `os: linux`) | For |
|---|---|---|
| `land` | `L` | ships, and any job that asks for `L` alone |
| `side` | `L`, `L-side` | work that can wait: proofs, heavy jobs, suites started by hand |
| `long` | `L`, `L-side`, `L-long` | long jobs (`citadel-heavy --long`); it takes side work while there is none |
| `check` | `L-check` | a ship's own check, nothing else |

- **No role:** on a PC with no land runner for the scheme, while another PC has one, the new runners are **side** ones: that is
  what a second PC's first runner becomes. Anywhere else they keep the labels the PC's script gives by position (the
  first `L`; on Linux, the ones after it `L-side` too).
- **Only new runners.** One already on GitHub keeps its labels, whoever gave them; an add that makes no new runner says so, and
  fails if a role was asked for. To change one, `ci_runners remove` and add again, or by hand as the repo's admin:
  `gh api -X PUT repos/<owner>/<repo>/actions/runners/<id>/labels -f 'labels[]=…'` (it replaces the custom labels).
- **Every add asks GitHub first** for the runners already there, so one is refused while GitHub can't answer, or while the
  scheme's owner has no GitHub login.
- **Limits.** The hold on side work while a ship runs (`src/ci-hold.ts`, #1902) is by repo, not by PC: a second PC's side runner
  waits too. A `side` or `long` runner carries `L`, since side jobs ask for both, so a ship's job can still start on one: for
  Citadel, keep land runners on one PC, and expect a ship on a second PC's side runner when the first PC's are busy or off.
  For a few seconds after it registers, a new runner has its script's labels. If Citadel restarts during an add, the
  runners keep those; look on GitHub, and use the line above.

## Install the runner agent (the PC's owner, once)

1. On a PC's own row, CI's **Set up** shows this step's whole line with the row's token: run it and skip the rest. On a
   CI runner host (before Build 7): on Citadel's Machines page, press **Add a CI runner host** under the list and name it (Cara's is
   `cara-desktop-runners`). Copy its token (`ccm_…`) and the address its setup lines connect to.
2. Easiest: the page shows the whole line, address and token filled in, right after you add the host (or make a new token for it). Copy that and skip to the end of this step. By hand: open PowerShell **as administrator** and paste this. Put that address in
   `$u` and the token in place of `ccm_…`:

   ```powershell
   $u = 'http://perigee.tail59477f.ts.net:8574'; iwr "$u/ci-runner/install-runner-agent.ps1" -UseBasicParsing -OutFile "$env:TEMP\install-runner-agent.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install-runner-agent.ps1" -CitadelUrl $u -MachineToken 'ccm_…'
   ```

   It checks that Node 18+ and Git for Windows are there, creates and locks the folder,
   downloads the agent and its scripts (printing their SHA-256), registers the task
   **Citadel runner agent** (SYSTEM, at startup, retried every 5 minutes), starts it and waits
   until it connects, then proves the CPU cap (#552, "Cap and yield" below). There's no reboot and no runner is registered or removed. The Machines page then shows
   it online.
3. Run the same line again whenever these scripts change, to update the agent. The lines it
   prints at the end say how to stop or remove it; removing the agent leaves its runners in place. Installing again keeps `caps.json`.

## By hand (the fallback)

`add-runner.ps1` still runs by itself in an elevated PowerShell, from a copy of this folder:

```powershell
$env:CC_MACHINE_TOKEN = 'ccm_…'
.\add-runner.ps1 -Scheme "Peek Auras" -CitadelUrl <the machines address> -Count 1
```

- The token is any machine token that may act for the scheme: a machine owned by someone in
  the scheme (a CI runner host must be lent to it too), or an ownerless one lent to it or open to every scheme.
- The scheme's owner must have linked GitHub in Settings → Your account, and the scheme must
  have a GitHub repo that owner admins. Citadel asks GitHub for the token with that login
  (`POST /api/machines/runner-token`, `src/ci-runner.ts`) and notes each one in the scheme
  Taskmaster's chat, under the job's note when a runner agent job fetched it.
- Each instance takes a folder `C:\actions-runner-<repo>` (then `-2` …) and the runner name
  `<PC>` (then `<PC>-2` …).
- An instance whose folder or service already exists is skipped, so re-running is safe.
- The download is checked against the SHA-256 in GitHub's release notes.
- If setup fails before the service exists, the folder it made is deleted; after that, the
  folder stays for `remove-runner.ps1`.
- Options: `-RunnerVersion` with `-RunnerSha256` (default `2.338.0`, Delve's), `-GitBin`,
  `-RunnerName` (default the computer name).

A Claude session on that PC needs Manual permissions to run it: auto mode refused to install
Delve's runner.

**Scheme-specific tools** (an engine binary, an SDK) go in the runner's `.env` by hand, as a path
NETWORK SERVICE can read (Delve copies its Godot console exe for this). Then restart only that
runner's service.

**What has been tested.** Every script here passes the Windows CI kit's `.ps1` lint
(`kit/skills/scheme-setup/templates/windows-ci/lint-ps1.ps1`: parse, type names and static
members on Windows PowerShell 5.1 and 7, PSScriptAnalyzer with their compatibility rules), which
`npm test` runs (`test/ps1-lint.test.ts`, with pwsh and PSScriptAnalyzer installed for cara on
perigee; it skips where they're missing). Apart from that, the Windows side hasn't run here: the
SYSTEM task, the folder lock, the real `config.cmd` add, the removal's `sc.exe` stop and delete, and
session mode's logon task (Peek Auras' own setup script, which it copies, has run on Cara's PC).
`remove-runner.ps1` does run in that test under pwsh on Linux, against a fake Citadel with the
Windows cmdlets and `sc.exe` stood in for: a `config.cmd` planted in the folder never runs. The agent's job handling
and the Citadel side have tests, with a fake PowerShell.

## Session runners (jobs that open windows)

A service runs in session 0, which has no desktop: jobs that open windows, draw overlays or read
the screen fail there. Those go to the scheme's one **session runner** (#370, Peek Auras' desktop
runner and Delve's `delve-perf` shape), which runs as a person, in their logon session.

| | The session runner |
|---|---|
| Folder, name | `C:\actions-runner-<repo>-desktop`, `<PC>-desktop`, with a `.citadel-runner` marker (`"mode": "session"`) |
| Label | `<scheme-slug>-desktop` |
| Runs as | whoever ran `add-runner.ps1 -Session`, only while they're logged on |
| Started by | the logon task `GitHub runner <scheme-slug>-desktop`, through `conhost.exe --headless` and `start-runner.ps1` (Peek Auras' launcher), which restarts `run.cmd` a minute after it ends and logs each step to `launcher.log` in the folder |
| Desktop | a hidden one named after the label, so nothing shows on screen; with `-Visible`, the person's own |

Add it in an **elevated** PowerShell, logged on as the person whose session it uses (a Claude
session on the PC needs Manual permissions for this, as for the fallback below). `start-runner.ps1`
must sit beside `add-runner.ps1`: the agent's folder has both once the agent is installed again
after #370, or download both:

```powershell
$u = 'http://perigee.tail59477f.ts.net:8574'; $d = "$env:TEMP\citadel-ci"; mkdir -Force $d | Out-Null
foreach ($f in 'add-runner.ps1', 'start-runner.ps1') { iwr "$u/ci-runner/$f" -UseBasicParsing -OutFile "$d\$f" }
$env:CC_MACHINE_TOKEN = 'ccm_…'
powershell -NoProfile -ExecutionPolicy Bypass -File "$d\add-runner.ps1" -Scheme "Peek Auras" -CitadelUrl $u -Session -Visible
```

- `-Session` adds the session runner and nothing else: no service runners, and it takes no
  `-Count`. Build runners register by themselves ([Add your PC](#add-your-pc)).
- `-Visible` runs its jobs on the person's own desktop. **Screen tests need it**: a hidden desktop
  refuses screen reads (`BitBlt`: "Access is denied") and capture. The session must also stay
  unlocked; a locked PC refuses them too. Without `-Visible`, windows open on a hidden desktop that
  nothing can read, which suits jobs that only need a desktop to exist.
- Running it again with `-Session` rewrites the launcher and the logon task, stopping the runner's
  old processes (and any job on it). That's how to switch `-Visible` on or off.
- It refuses to run as SYSTEM, and refuses `-Visible` without `-Session`.

**After Remote Desktop:** closing a Remote Desktop window leaves the session disconnected, with no
screen, so screen reads fail. Before leaving, in an administrator PowerShell inside the session:
`tscon ((Get-Process -Id $PID).SessionId) /dest:console`, which hands the session back to the PC's
own monitor, unlocked.

A scheme's `desktop.yml` checks the screen first and reports its desktop jobs as NOT RUN when it
can't be read: the Windows CI kit, `kit/skills/scheme-setup/templates/windows-ci/`.

## Linux runners in WSL (#510)

Some jobs only run on Linux (Theory of Crafting's PoB LuaJIT tests and its `chrome-headless-shell` browser tests). Those go to
**Linux runners** in a WSL2 distro on the same PC (Cara, 2026-11-10: "Linux runner in WSL2"), added and removed by a
second copy of the runner agent that runs inside that distro.

| | Each scheme's Linux runner |
|---|---|
| Where | the WSL distro `citadel-ci`, which belongs to the Windows account that installed it |
| Folder | `/opt/actions-runner-<repo>`, then `-2` … (up to 4), the scheme's user's alone, with a `.citadel-runner` marker for people (`"mode": "linux"`) |
| Label | `<scheme-slug>-ci-linux` (`theory-of-crafting-ci-linux`); GitHub adds `self-hosted`, `Linux`, `X64`. Every runner but the first also gets `<scheme-slug>-ci-linux-side`, for long jobs that must leave the first one free |
| Name | `<PC>-linux`, then `<PC>-linux-2` … |
| Runs as | the scheme's own user `ci-<repo>-<6 hex>` (no sudo), so one scheme's jobs can't touch another's runners; one job at a time |
| Service | `citadel-runner-<owner>-<repo>[-n].service`, which `add-runner.sh` writes itself from the runner's `svc.sh` template; its first line `# citadel-repo=<owner>/<repo>` is Citadel's record of whose it is |
| `.env` | telemetry off, and `HOME` in its own folder, so runners never share tool caches (#370) |
| Agent | `/opt/citadel-runner-agent` (root's alone), the systemd service `citadel-runner-agent`, its own machine host on the Machines page |
| Kept up by | the logon task **Citadel WSL runners** (`keep-wsl-up.ps1`), which holds the distro open: WSL stops a distro seconds after the last program using it exits, and its services with it |

The distro is **cut off from Windows** (`/etc/wsl.conf`: no `C:` mount, no running Windows programs), because a CI job
there runs inside its owner's own WSL and could otherwise read their files or run programs as them. Install a scheme's
system packages (a `-dev` library, a browser's shared libraries) by hand, as root in the distro, like a Windows
runner's scheme-specific tools.

What it shares with the Windows agent: it runs only its own scripts, with the numbers Citadel's job carries; never
downloads code (installing again is how its scripts change); never sees a registration token (the scripts fetch it);
one job at a time, ended after 15 minutes. As root it never runs a file from a runner folder (CI jobs can write
there): `config.sh` runs as the scheme's user, with the registration token in its environment, never its command
line, and no machine token. `remove` trusts only the service files in `/etc/systemd/system`, root's alone
(`remove-runner.sh` refuses if that ever stops being true), never a folder's marker, which a job could forge; it
deletes the scheme's user with its last runner.

Its one limit: WSL distros are each Windows user's own, so the task runs **while its owner is logged on**, like the
session runners. After a reboot, the Linux runners come back when they log on. (A SYSTEM task can't reliably start a
user's distro, and a distro of SYSTEM's own is unproven.)

### Set it up (the PC's owner, once)

Nothing here needs Administrator or a reboot. On Cara's desktop (checked on 2026-11-10): it has WSL 3.0.5 with
VirtualMachinePlatform Enabled and no distros yet. **If any step says a reboot or a Windows feature is needed, stop
there and tell the minion**: the PC is never restarted for this.

1. **The distro.** In a normal PowerShell:

   ```powershell
   wsl --install Ubuntu-24.04 --name citadel-ci
   ```

   If it asks for a UNIX user name and password, give any (`cara` will do); nothing uses them. It opens a shell in
   the distro when it's done: type `exit`. ([Microsoft's install guide](https://learn.microsoft.com/en-us/windows/wsl/install)
   says more; if `--name` is refused, stop and tell the minion.)
   Then turn off WSL's localhost relay. In its default NAT networking, `wslrelay.exe` opens a Windows listening
   socket for every port a WSL program listens on, and on Cara's PC it never closed them after the test suites'
   servers did: ~1,760 piled up in 36 hours (Nov 22–24), until Windows ran short of ports and Citadel froze for
   seconds at a time (#1753). Nothing here needs it: the runners, ToC's runners and the Android emulator's tunnel
   all connect outward from WSL. The cost: Windows can't open a server in any of the PC's WSL distros at
   `localhost` (the distro's own IP, `wsl -d <distro> hostname -I`, still works). In the same PowerShell:

   ```powershell
   $f = "$env:UserProfile\.wslconfig"; $t = if (Test-Path $f) { Get-Content -Raw $f } else { '' }
   if ($t -match '(?m)^[^\S\r\n]*localhostForwarding\s*=') { $t = $t -replace '(?m)^[^\S\r\n]*localhostForwarding[^\S\r\n]*=[^\r\n]*', 'localhostForwarding=false' } elseif ($t -match '(?m)^\[wsl2\]') { $t = $t -replace '(?m)^\[wsl2\][^\S\r\n]*(?=\r?$)', "[wsl2]`r`nlocalhostForwarding=false" } else { $t = "[wsl2]`r`nlocalhostForwarding=false`r`n`r`n" + $t }
   Set-Content -Path $f -Value $t -Encoding ASCII; Get-Content $f
   wsl --shutdown
   ```

   Each CI suite checks this itself once step 4's task runs (`win-ports.sh`). To check it by hand (after a suite has
   run there), this should print a number near zero for wslrelay:

   ```powershell
   $r = @(Get-Process wslrelay -ErrorAction SilentlyContinue).Id; "wslrelay listeners: " + @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $r -contains $_.OwningProcess }).Count; "listeners inside citadel-ci: " + (wsl -d citadel-ci -u root -- sh -c 'ss -Hltn | wc -l')
   ```

   (`networkingMode=mirrored`, step 3's fallback, also has no relay; `localhostForwarding` only applies to NAT.)
2. **Its host on Citadel.** On a PC's own row, CI's **Set up** shows step 3's line with the row's token (no host to add).
   On a CI runner host (before Build 7): on Citadel's Machines page, press **Add a CI runner host** and name it
   (Cara's is `cara-desktop-linux`). Leave the install line open on the **Linux in WSL** tab and press **Copy**. Give the host
   the schemes that should get Linux runners (Theory of Crafting) under its line, as for the Windows host.
3. **The Linux agent.** In PowerShell, open a root shell in the distro, then paste the line:

   ```powershell
   wsl -d citadel-ci -u root
   ```

   The first time, it writes `/etc/wsl.conf` and stops. Restart the distro and paste the same line again:

   ```powershell
   exit
   wsl --terminate citadel-ci
   wsl -d citadel-ci -u root
   ```

   The second run installs Node, git and the runner's libraries, starts the agent and waits until it connects. The
   Machines page then shows it online.
   If it can't reach Citadel's address, WSL's network isn't reaching the tailnet: add these two lines to
   `%UserProfile%\.wslconfig` (make the file if it's not there), run `wsl --shutdown`, and start this step again
   ([`.wslconfig` settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#wslconfig)):

   ```ini
   [wsl2]
   networkingMode=mirrored
   ```

4. **Keep it up.** Back in a normal PowerShell (not the distro), with the address the Machines page shows, already filled in below
   (`http://perigee.tail59477f.ts.net:8574`, the live server's `MACHINES_URL`; the log's "Machines connect at" line shows it):

   ```powershell
   $u = 'http://perigee.tail59477f.ts.net:8574'; iwr "$u/ci-runner/keep-wsl-up.ps1" -UseBasicParsing -OutFile "$env:TEMP\keep-wsl-up.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\keep-wsl-up.ps1"
   ```

   It registers the task **Citadel WSL runners** for you and says when `citadel-ci` is Running. It also registers
   **Citadel WSL ports** (#1763), which tells `citadel-ci` every 10 s how many Windows listening ports `wslrelay`
   holds (`/run/citadel-win-ports`); each suite reads it before and after (`win-ports.sh`) and goes red on a rise still
   there a write later, step 1's leak come back. A PC set up before it shipped runs this line once more to get it; until
   then the suite says there is no count and checks nothing.
5. **The runners.** They register by themselves once a lent scheme's workflow asks for `<scheme-slug>-ci-linux`
   ([Add your PC](#add-your-pc)). What a job needs beyond Node and git is a setup step in its workflow, so any lent PC
   runs it.

To update the Linux agent and its scripts later, run step 3's line again (the token is the host's; make a new one on
the Machines page if it's lost). To stop everything: `Disable-ScheduledTask -TaskName 'Citadel WSL runners'`, then
`wsl --terminate citadel-ci`.

**What has been tested** (#510): the scripts ran end to end on perigee against a fake Citadel, a fake runner
tarball and stubbed `systemctl`, `runuser`, `useradd` and `userdel` (`test/runner-linux-scripts.test.ts`), and
`keep-wsl-up.ps1` passes the `.ps1` lint. Nothing has run in WSL yet: the real `config.sh` and runner service,
systemd in the distro, the tailnet from WSL's network, and whether the logon task really holds the distro up are
first tried by Cara's setup.

## Linux runners on plain Linux (#1933)

A Linux PC (or VM) runs the same agent as the WSL distro, installed by the same script, without the WSL steps: no
`wsl.conf`, no logon task, no `.wslconfig`. It needs systemd, a 64-bit Intel or AMD processor, and root for the install. Debian and Ubuntu get what's
missing from `apt`; on another distro, install Node 18+, git, curl, ca-certificates and libicu first (the script
names them and stops).

1. Add the host on the Machines page and leave its install line on the **Linux** tab ("Add your PC" above).
2. In a root shell on the PC (`sudo -i`), paste the line. It starts `citadel-runner-agent` and waits until it connects.
   It also names any home folder that every user of the PC can read, CI jobs included, with the line that closes it.
3. Lend it, then ask for runners with `os: linux`.

Everything in the table and the paragraphs under "Linux runners in WSL" holds here (folders, labels, users, services),
except what is about the distro itself. The runners start with the PC, with nobody logged on. All of them share
`citadel-runners.slice`, held to 75% of the PC's cores ([Your own caps](#your-own-caps)). A runner the PC had before
this takes the slice at its next start. To update, run the line again.

**What has been tested** (#1933, Nov 25 2026): the install, on a fresh Debian 12 VM (x64, software-emulated, 2 cores)
against a stand-in Citadel. It installed with no WSL step and no `/etc/wsl.conf`, connected, and answered a list job; a
busy loop in the slice used 149% of one core (75% of the PC), then 81% after `caps.json` said 40; a second install kept
`caps.json`. Not tried: a real GitHub runner added on plain Linux, another distro, and `caps.json` on a real Windows PC.

## Load samples (#534)

Each runner agent also samples its PC every 30 seconds and posts the sample to Citadel, which keeps 14 days of
them (`src/ci-load.ts`). It is read-only: it changes no runner, count, VM setting or workflow. The Releases page's
Overview tab shows the result under **CI PC load**, to everyone signed in: a verdict, CPU
and memory now, the last 24 hours with hard restarts marked, and each pool of runners (a repo and its labels)
with how many are busy and what waits.

- **What a sample holds.** The whole PC's CPU, memory and disk; each runner's share of the CPU (its
  `Runner.Listener` and everything it started); on Windows also the threads waiting for a core, how long since
  the person at the PC last touched it (`quser`), with Hyper-V on the PC's true CPU and each guest's share (the
  host's own counters leave guests out), the hottest ACPI thermal zone where the firmware reports one, and the
  restarts with no clean shutdown (Kernel-Power 41) of the last 14 days. `sample-load.ps1` reads what Node can't;
  the agent in WSL reads `/proc`. What a PC can't report is left empty, never guessed.
- **The verdict**, over the last 15 minutes: **overloading** (with someone at the PC, the CPU at 90% or more for two
  thirds of that time, or memory under 10% free; it says whether the runners are the cause), **crashed under load** (a hard restart with CI
  jobs running; it holds for 24 hours and never says to add a runner), **could do more** (jobs have waited over
  2 minutes with every runner of their pool busy and the CPU under 60%), **full** (jobs wait and the PC is busy
  too), else **fine**. A verdict that holds for 30 minutes (a crash at once) becomes one quiet Mandate item for
  the schemes with runners there, taken away when it ends. It never rings.
- **Turning it on** on a PC installed before it shipped: the agents never update themselves, so run each host's
  install line again. Windows: step 2 of "Install the runner agent" above, for the Windows runner host. WSL:
  `wsl -d citadel-ci -u root`, then step 3 of "Set it up" under "Linux runners in WSL", for the WSL runner host.
  Until then the panel shows the queues from GitHub and "No samples yet".
- **Not yet seen on the real PC** (2026-11-11): `quser` under SYSTEM, the Hyper-V counters and the thermal zone.
  The first hour of samples says which of them the desktop reports.

## Cap and yield (#552)

Josh, 2026-11-11: "ok, CI is using my whole desktop, can we limit it a bit?", and he picked **Cap and yield**: CI runs
at below-normal priority so the PC stays responsive, and all CI together is held to about 75% of the CPU. Runner
counts stay; jobs just run slower when it's busy. The PC has 16 cores, 32 threads.

| Part | What holds it | Its share |
|---|---|---|
| Windows runners, every one on the PC (Delve's, Peek's, Mandate's, ToC's, the session runners) | `keep-runners.ps1`, which the Windows agent keeps running: one job object, `Global\CitadelCiRunners` | below-normal priority, all together at most 75% (`CI_CPU_PERCENT` in `public/runner-agent.mjs`) |
| The WSL VM (Citadel's and ToC's Linux runners, and the Android emulator, #533) | `processors=24` (16 until Cara raised it on 2026-11-22, #1606) in Cara's `%UserProfile%\.wslconfig`; inside it, the runners niced (`citadel-runner-.service.d/yield.conf`, written by `install-runner-agent.sh`) | at most 24 of the 32 threads; the emulator's 4 cores come first |
| The test box VM (Peek's desktop tests) | `Set-VMProcessor -Count 6 -Maximum 75 -RelativeWeight 50`, set by `tools/win-test-box/new-test-box.ps1` | about 4.5 of 32 threads, already; left as it is |

### Your own caps

The PC's owner sets how much of it CI may use, in a file `caps.json` beside the agent. Both settings are optional;
without the file (no PC had one before #1933) today's 75 and 30 hold.

```json
{ "cpu_percent": 50, "squeeze_percent": 20 }
```

| Setting | What it caps | Default |
|---|---|---|
| `cpu_percent` | all CI on the PC together | 75 |
| `squeeze_percent` | the other runners, together, while a scheme's ship runs on the PC ("Ships go first"); never above `cpu_percent` | 30 |

Both are whole percents of the PC, 1 to 100. A value that isn't is logged and its default used. On Windows, the 10%
the others get while Citadel's own ship runs comes down with `squeeze_percent` below 10.

- **Windows:** `C:\ProgramData\citadel-runner-agent\caps.json`, written as administrator. Then restart the task
  **Citadel runner agent** (end it and run it, in Task Scheduler).
- **Linux:** `/opt/citadel-runner-agent/caps.json`, written as root. Then `systemctl restart citadel-runner-agent`.
- **WSL:** the same file, for `squeeze_percent` only: `.wslconfig`'s `processors` is what holds the VM down (below).

A restart of the agent leaves the runners and their jobs going. Installing again keeps the file.

**Windows.** Every 15 seconds `keep-runners.ps1` finds each `RunnerService.exe` and `Runner.Listener.exe` and
everything started under them, and puts what isn't held yet into the job. The job runs everything in it at below-normal
priority and caps all of it together at 75% of every core (a hard cap: past it, the job's threads wait for the next
scheduling interval). A process started by one in the job is in the job from its start, so a step's cargo, MSBuild,
node or dotnet is held too; the sweep only catches runners that started before it did. Breakaway is refused (#1268,
Nov 21): Git Bash asks for it whenever a job allows it, so with it allowed every program a `shell: bash` step started
(Peek's cargo and everything under it) left the job and the ship squeeze; refused, Git Bash starts them in the job as
usual. A tool that insists on breaking away would now fail to start; none on this PC has been seen to. A runner already in another job (a session runner's logon task puts it in one) gets a job of its own,
nested in that one, with the same limits (so a busy session runner can take more than the shared 75%, at
below-normal priority still). In the first 30 minutes after the PC starts, it also starts any `actions.runner.*`
service that is set to start automatically but is stopped, at most every 5 minutes each (the BIOS reboot of 2026-11-11
left them all stopped); a runner stopped after that stays stopped. It never stops, removes or re-registers a runner.

It comes back by itself: the agent starts it at every boot and every install, and again a minute after it ever ends;
it ends with the agent. A job's limits stay on its processes while they run, so an agent install leaves the running
runners capped.

**Proof.** `keep-runners.ps1 -Prove` runs a throwaway job capped at 50% with two slots in it, as the ship squeeze
below sets them up: one with no cap of its own and one squeezed to 10% of the PC. Each starts one CPU-burning
grandchild per core. It reports whether the grandchildren are in their slots and the job, at below-normal priority,
what share of the PC each slot and the job used, and that the squeezed slot speeds up once its squeeze is lifted.
Where Git Bash is installed it also starts a ping through bash in the squeezed slot and checks the ping stayed there
(with breakaway allowed it doesn't: tried on the test box, Nov 21). `install-runner-agent.ps1` runs it at its end; it touches no runner. By hand, in an administrator
PowerShell: `powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\citadel-runner-agent\keep-runners.ps1 -Prove`.

**WSL** (by hand, once, as the Windows account that owns the distro). WSL's VM has no job object Windows can cap; `.wslconfig` is what limits it
([`.wslconfig` settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#wslconfig)). In a normal PowerShell:

```powershell
$f = "$env:UserProfile\.wslconfig"; $t = if (Test-Path $f) { Get-Content -Raw $f } else { '' }
if ($t -match '(?m)^[^\S\r\n]*processors\s*=') { $t = $t -replace '(?m)^[^\S\r\n]*processors[^\S\r\n]*=[^\r\n]*', 'processors=24' } elseif ($t -match '(?m)^\[wsl2\]') { $t = $t -replace '(?m)^\[wsl2\][^\S\r\n]*(?=\r?$)', "[wsl2]`r`nprocessors=24" } else { $t = "[wsl2]`r`nprocessors=24`r`n`r`n" + $t }
Set-Content -Path $f -Value $t -Encoding ASCII; Get-Content $f
```

It takes at the next `wsl --shutdown`, which stops every distro: Citadel's and ToC's Linux runners (a run in flight
fails, and `land.sh` falls back to perigee), and the Android emulator. Do it when neither is busy; the logon tasks
**Citadel WSL runners** and **Citadel WSL citadel-android** start both again within 5 minutes. The runners' nice
needs the WSL agent installed again (step 3 of "Set it up"), or as root in the distro:
`mkdir -p /etc/systemd/system/citadel-runner-.service.d && printf '[Service]\nNice=10\nCPUWeight=20\n' > /etc/systemd/system/citadel-runner-.service.d/yield.conf && systemctl daemon-reload`.
Runners take it at their next start, which the `wsl --shutdown` gives them.

**What has been tested** (#552): the job type compiles with struct sizes matching Windows x64 (pwsh on perigee),
every script passes the `.ps1` lint, and the agent's start of `keep-runners.ps1` runs in `test/runner-agent.test.ts`
with a fake PowerShell. The job itself has only run where `-Prove` runs: on the desktop, at the agent's next install.

## Ships go first (#1268)

Cara, 2026-11-20, "Plan approved: build it this way. ("Ships go first on the CI desktop: while any scheme's ship run
is going, every other runner there drops to about a third of the PC")". On Nov 19, 23:13-23:35 PST, Peek's Windows
builds and the test box took the whole PC and Citadel's ship suite in WSL outran `land.sh`'s 6-minute wait. So while
any scheme's ship run (a `land/…` branch: Peek's, Mandate's, ToC's, Citadel's) has a job on a runner of a PC, every other
runner on that PC is squeezed, and no other PC's (#1934); Delve's PR checks are not ships (Cara, "No, ship branches only"). Nothing changes when
no ship is running: the 75% cap above is all there is. Citadel's own ships go first (Cara, 2026-11-21, picked
"Citadel's ship goes first" on #1268's card): while one runs, another scheme's ship on the same PC is left off its list and squeezed
like any other runner; on its own, that ship still counts. Before Windows held the squeeze, a Peek ship and a Citadel
ship running together had the PC over 20 cores in 46% of samples (#1477's
keeper log, `shared/project/reports/ships-first-windows-squeeze-2026-11-21.md`).

- **Who knows a ship is running.** Citadel (`src/ci-ships.ts`) asks GitHub every 15 seconds which `land/…` runs are
  in progress in each repo with runners on a CI PC, and which self-hosted runner each running job is on, and sends each PC's
  agents that list (repo and runner name) of its own ships (#1934). Same-named runners in two repos are told apart by repo.
- **Whose PC a runner is on.** Its agent's newest load sample lists it; before one does, its name starts with the PC's
  hostname. The Windows and WSL agents of one PC count as one PC because they report one hostname, WSL's default: give
  `citadel-ci` a hostname of its own and neither squeezes for the other's ships. A ship on no known PC squeezes none.
- **Windows.** The agent writes the list to `C:\ProgramData\citadel-runner-agent\ships.json` with an expiry 2 minutes
  out. `keep-runners.ps1` gives each runner its own slot, a job named `Global\CitadelCiRunner-<folder>` nested in the
  shared 75% job, names it from the runner's `.runner` file, and re-reads `ships.json` every 2 seconds. While a ship
  runs, the slots not on a ship share `-SqueezePercent` (30, `SQUEEZE_PERCENT` in `public/runner-agent.mjs`) of the
  PC, or `-CitadelSqueezePercent` (10, `WINDOWS_CITADEL_SQUEEZE_PERCENT`) while one of the ships is Citadel's own (the
  watch marks those `first: true` in `ships.json`; Josh, 2026-11-24, picked "Squeeze Peek's builds harder" on the
  Taskmaster's card, replacing Cara's Nov 20 30% for that case; Linux stays at 30), split evenly among the ones running a job; a ship's slot keeps no cap of its own (only the shared 75%). A
  runner whose slot can't nest in the shared job (a session runner already in its logon task's job) gets the same
  share of the PC on its own job.
- **WSL.** The Linux agent finds each `citadel-runner-*` service's folder, names it the same way, and sets
  `systemctl set-property --runtime <unit> CPUQuota=` on every runner not on a ship: 30% of the VM's cores split among
  the ones running a job (with `processors=24`, 720% for one, 360% for two). An empty `CPUQuota=` lifts it.
- **Lifting.** An empty list lifts the squeeze at once (both agents get one every 15 seconds); if Citadel goes quiet
  (restart, GitHub hiccup, the agent's link down), it lifts after 2 minutes on its own. A repo whose reads keep failing
  keeps its last ships for 2 minutes, then drops them. A rate limit from GitHub lifts the squeeze at once and pauses the
  watch for 5 minutes. A restarted WSL agent clears every runner's quota at start, in case the one before died mid-ship.
- **Every scheme.** Any repo with a runner on this PC is watched, through its own scheme's GitHub login. Only the
  priority is keyed to Citadel's repo (the live checkout's origin): when both run, its ships keep their share. A squeezed build still runs, just slower, and returns to its normal share the moment the
  ship ends.

**Install (the PC's owner, once, on a PC installed before it shipped).** Both agents need the new scripts; the lines below reuse each agent's own
token from its folder, so nothing needs copying. In PowerShell **as administrator**:

```powershell
$u = 'http://perigee.tail59477f.ts.net:8574'; iwr "$u/ci-runner/install-runner-agent.ps1" -UseBasicParsing -OutFile "$env:TEMP\install-runner-agent.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install-runner-agent.ps1" -CitadelUrl $u -MachineToken (Get-Content -Raw "$env:ProgramData\citadel-runner-agent\machine-token").Trim()
```

It ends with `-Prove`, which now proves the squeeze too. Then, for WSL, in the distro as root (`wsl -d citadel-ci -u root`):

```bash
u='http://perigee.tail59477f.ts.net:8574'; f=$(mktemp) && curl -fsSL "$u/ci-runner/install-runner-agent.sh" -o "$f" && CC_MACHINE_TOKEN=$(cat /opt/citadel-runner-agent/machine-token) bash "$f" "$u"
```

Neither restarts a runner or the PC; running jobs keep going and are squeezed from the next sweep.

**What has been tested** (#1268): the watcher against a fake GitHub and each PC's own list (`test/ci-ships.test.ts`), the hub
sending two agents on two PCs each its own (`test/machine-relay.test.ts`), the Linux quotas and the ships file (`test/runner-agent.test.ts`),
and `keep-runners.ps1`'s share maths, `ships.json` reading and runner naming in pwsh on perigee with the job calls
faked (`test/keep-runners.test.ts`). Nested job objects themselves only run where `-Prove` runs: on the desktop, at
the install above, and on the test box, where `-Prove` passed on Nov 21 and its Git Bash check failed with breakaway
allowed again.

**Why it didn't hold on Windows at first** (#1477's report, `reports/ships-first-windows-squeeze-2026-11-21.md` in
the shared folder): Peek's `windows` workflow runs its steps in Git Bash, Git Bash asked for breakaway because the
jobs allowed it, and every cargo it started left the slot for a job of its own (the keeper's "was in another job
already" lines: cargo, cargo-fmt, rustfmt, sccache) that the squeeze never touched. Refusing breakaway keeps them in.

## Point the workflows at it

Each job's `runs-on`, with the scheme's label:

```yaml
runs-on: ${{ vars.CI_RUNNER == 'github' && 'ubuntu-latest' || fromJSON('["self-hosted", "peek-auras-ci"]') }}
defaults:
  run:
    shell: bash
```

`shell: bash` makes steps run the same in Git's bash on the desktop as on a hosted Linux runner;
without it, a Windows runner runs `run:` steps in PowerShell.

For Linux jobs, `runs-on: [self-hosted, <scheme-slug>-ci-linux]`; they need no `shell: bash`.

## Citadel's own tests (#523)

Citadel's suite runs on its Linux runners (`citadel-ci-linux`; two of them, but the workflow lets one land's suite
run at a time: two at once on that PC failed in a different file every run, 2026-11-11). Only the lands' runs may take
the first runner: flake proofs (`flake-proof.yml`), heavy jobs (`citadel-heavy.yml`, #1347), the desktop build (`desktop.yml`), the nightly and runs started by hand ask for the side label
`citadel-ci-linux-side`, which `-linux-2` and the long runner `-linux-3` carry (#1240: on 2026-11-20 proofs held both runners for three hours and
every land fell back to perigee). A new runner gets its labels from the add's role ([Runner roles](#runner-roles-1934)).
Without a runner carrying it, those wait in GitHub's queue (up to a day) while lands go on; `test/ci-runner-choice.test.ts` fails on a workflow job that could take the first runner.
Long jobs (`citadel-heavy --long`, `src/long-jobs.ts`) have a third runner, `-linux-3`, the only one carrying
`citadel-ci-linux-long` (#1592: on 2026-11-22 a long job held the side runner from 02:04 to 07:30 and five flake proofs
queued behind it). It carries the side label too, so it takes side work while no long job runs (#1646, Cara, 2026-11-22,
"Long runner helps out": with `-linux-2` alone, proofs and heavy jobs queued about 45 minutes an hour while `-linux-3`
sat idle: `shared/project/reports/side-runner-queue-2026-11-22.md`). A long job can
wait behind one side job there; `-linux-2` never takes a long job. `citadel-heavy.yml` takes a `long` input, and the pump sends it when the
workflow declares one, so a scheme whose workflow lacks it keeps its long jobs on the side runner. A long runner is added
with `role: long` (to stop it taking side work, as before #1646, as the repo's admin:
`gh api -X DELETE repos/caraminden/claude-coordinator/actions/runners/<id>/labels/citadel-ci-linux-side`). Without a runner
carrying the long label, a long job waits in GitHub's queue for a day and is then lost.
A ship's own check (#1567, `tools/own-check.sh`) has a runner of its own too, which carries only
`citadel-ci-linux-check`: `tests.yml` sends every `check/**` run there, one at a time (group `citadel-check`), niced, so
Cara's desktop runs at most one check beside a land's run. It is added with `role: check`. With no runner
online carrying the check label, `land.sh` runs no check and ships go to the line as before.
`.github/workflows/tests.yml` runs on every push to a `land/**` or `check/**` branch, and `tools/land.sh` is the only
thing that pushes there (`check/**` through `tools/own-check.sh`, above): it sends the rebased commit to `land/<branch>`, waits for the run on that exact commit
while it holds the deploy lock, and deletes the branch again. A land that touches no pipeline file leaves out the
pipeline's own test files (#581, `tools/pipeline-files.txt`), so the whole suite also runs on main every night at
13:30 UTC. That run and any started by hand are in a concurrency group of their own (a run waiting in the lands' group
would cancel the land waiting there), niced.
**Deploys first** (#1902; Josh, 2026-11-24: "while a ship is in line, nothing optional runs on the CI desktop"):
`src/ci-hold.ts` stops heavy jobs and suites started by hand on a branch while a ship is in line or
testing, or main's full run waits or runs, and starts each again, from its beginning, once the line has been empty for
5 minutes (1 at night, 23:00 to 06:00 Pacific; longer each time the same run is stopped again). Main's full run waits for
a gap in the ships, 4 hours at most, then goes once the ship running ends, and the next ships wait for it: Citadel's label stays only on the side runner till main's run is over, an hour at most (Josh, 2026-11-25, picked "Wait for a gap, max 4 h", then "After 4 h, ships wait": beside a ship it hit its 10-minute limit and gave no verdict); while it waits, ships' own checks and early runs still go. A ship's `land/**` run is never touched, and another scheme's heavy jobs are
held 4 hours at most. Citadel's own heavy jobs and hand-started suites are held 2 hours at most for ships (Josh, 2026-11-25, picked "2 hours"): past that they run beside them, one Citadel job at a time, and main's run stops one only once main itself can go (so while one runs, ships' own checks and early runs are skipped).
**One flake proof beside ships** (Josh, 2026-11-25, picked "Let them run, one at a time" on #1902's card; it narrows both his earlier
picks, for flake proofs only): one proof starts and runs on whatever the ship line does, and the next, the longest held first, starts when it ends.
A ship, its own check and the early next train never wait for one; main's run stops one once it may start, as before; heavy jobs and suites never run beside one: each waits for the one that runs, and goes before the next if it may start.
No proof starts while a ship's red tests run again alone (`rerun failed files alone`); one already running goes on.
**One Citadel job at a time** (#1906; Josh, 2026-11-24: "Citadel never runs two heavy jobs at once"): the runs of Citadel's
own repo go one by one, in the order ship, main's full run, a ship's own check (`check/**`, a light check) or the early next
train (`early/**`), then heavy jobs and suites started by hand, then flake proofs. A job is let in when it asks; one told to wait is
stopped and started again by itself. A ship's run stops whatever runs but a flake proof and a job past its 2 hours, main's included, until main's has
waited 4 hours for ships: then it runs beside them (#1902's cap, two of them then run at once, as with a proof and the caps below). An own check or early run starts only
on an idle desktop (`ci_busy` in `deploy-queue.sh` before the push, the ask after): its ship goes on without it, and the stopped run
comes back only while its branch is there. A job that has run 4 hours keeps no other
waiting, and none waits behind lower ones past 24 hours (a proof waits its turn; main's run waits for ships 4 hours). Other
schemes' jobs neither take nor wait for the place. Compare ships before and after with `node tools/ship-runs.ts --at <when>`. A job asks before it starts (`tools/ci-hold-ask.ts`, the run's OIDC token, `POST /api/ci-hold`) and
goes ahead when Citadel doesn't answer. Held jobs show on the CI page ("One job at a time"); one held 2 hours is told to
its scheme's Taskmaster (one note an hour at most; main's run only once it is 2 hours past its own 4-hour limit), and its minion's list row says
since when and why (#1984). Off switch: `touch` the deploy state folder's `hold-off`, which also lets Citadel's jobs run side by side again; touch it too while `CI_RUNNER=github`, since the hold can't see that those runs are not on the desktop.
**One Peek build while Citadel ships** (#1902; Josh, 2026-11-25, picked "Yes, use labels"): while a ship holds the desktop,
`src/runner-cap.ts` takes `peek-auras-ci` off all but one of Peek's runners on that PC, with the Peek scheme owner's GitHub login, and puts
it back when the line is clear, after 4 hours in one stretch, or at once with `hold-off`. Running jobs finish; queued ones wait at GitHub. It writes down
what it takes off first, so a restart puts it back; with Citadel down, or rolled back to a version without this, the label stays off (`hold-off` first, or give it back in the repo's Settings → Actions → Runners). Peek's own ship can wait behind a
Peek build already queued. Its screen jobs (`peek-auras-desktop`) and heavy runner are not part of it.
The workflow runs `tools/run-tests.sh`, the same run `land.sh` makes on perigee, and fails when any test is
skipped: perigee skips none, so a skip means the runner lacks something. What the suite needs goes in the runner's
own home, with no root: Node, `pwsh` with PSScriptAnalyzer for the `.ps1` lint, Chrome's headless shell for the
browser tests, and `libatomic1` and `sqlite3` unpacked from their `.deb`s. Those last two are tidier installed once
in the distro (`wsl -d citadel-ci -u root`, then `apt-get install -y libatomic1 sqlite3`); the workflow uses the
distro's as soon as they are there.

One thing does need root, once: the runner's user needs its own systemd manager, because turns in tests start
their units with `systemd-run --user` as they do on perigee. As root in the distro,
`loginctl enable-linger ci-claude-coordinator-4590fb` (the user `ci_runners` made; the workflow's step names it
when it's missing).

The workflow's step "the runner's clock" fails when the distro's kernel clock runs more than 1% off its raw clock
for 2 minutes (it measures again every 10 s, #900). `land.sh` reads that failure as `runner clock`, not a red: it falls back to the suite on
perigee and leaves its CI-down note, so the landings of the next 10 minutes don't each spend a run learning it.
That happens when two programs keep the same clock (#542). Every WSL distro on the PC shares one kernel, so one
clock. WSL's own init (3.x) runs a chrony outside the distros, where `ps` doesn't show it, that steers that clock
to the Windows clock every 8 s. Ubuntu also turns `systemd-timesyncd` on in WSL, in each distro, which steers it
to NTP. Each timesyncd step looks to chrony like a clock running fast or slow, so it retunes the kernel tick to
make up for it; the clock then really runs off, and timesyncd steps it again every 32 s, for as long as it runs.
On 2026-11-11 the clocks ran 7% fast (tick 10721), and after a reboot 2% slow (tick about 9784), and tests that
time things failed at random. The raw clock was right throughout (within 0.005% of NTP), so setting the tick back
by hand only lasts until chrony's next update, seconds later.

The fix is one keeper: `install-runner-agent.sh` masks `systemd-timesyncd` when WSL has its own, and so does the
Android distro's `deploy/desktop/android/setup.sh`. One distro with it still on skews the clock for all of them:
masking it in `citadel-ci` alone changed nothing, and masking it in `citadel-android` as well brought the tick
back to 10000 within 20 seconds. So any distro on that PC needs it, once, from PowerShell; it survives reboots and
`wsl --shutdown`:

```powershell
wsl -d <distro> -u root -- systemctl mask --now systemd-timesyncd
```

`wsl -l -v` lists the distros. A distro added later turns timesyncd on again, so `keep-wsl-up.ps1` also registers
the task **Citadel WSL clock** (#900): every 5 minutes it masks `systemd-timesyncd` in each distro that is running
(it starts none, and leaves alone any distro where WSL doesn't keep the clock), and writes each one it masked to
`%LOCALAPPDATA%\citadel-wsl-clock.log`. Running `keep-wsl-up.ps1` again picks it up.

To look at the clock from a CI job without root: the tick is `adjtimex`'s `tick`
field (10000 when nothing is wrong), and a timesyncd in another distro shows as a UDP socket in `/proc/net/udp`
that opens for a tenth of a second every 32 s, with the wall clock stepping as it closes. The clock now follows
the Windows clock, so it is as right as that is (a steady 0.4 s behind NTP once it had settled, 2026-11-11).

When the runner can't answer (Cara is logged off, GitHub is down, no runner takes the job within 90 s, the run
takes more than `LAND_CI_TIMEOUT`, 9 minutes), `land.sh` prints `CI FALLBACK` with the reason, runs the suite on perigee as it used
to, and adds a `ci fallback` line to the day's retro log (`retro-log/<date>/land.md`), so they can be counted. A red
run refuses the landing; it never falls back. Two exceptions (ADR 0006): a red in which every failed file passed when
`run-tests.sh` reran it alone (#769) gets one fresh run of the same commit, which must be fully green to land, and a
`flake rerun` line in the retro log; a run cut off before any test failed (#1377; killed from outside too, #1393) gets the same one fresh run and a
`cut-off rerun` line, and cut off again it is no answer, which falls back. `LAND_CI=0 tools/land.sh` skips CI, for when the runner itself is broken.

## Runner folders stay on C: (the Dev Drive was retired, #1344)

Every runner's folders are real folders on C:. No junction or symlink under a runner folder, apart from the runner's
own `bin` and `externals`.

From Nov 20 to Nov 22, 2026, Peek Auras' four build runners kept `_work`, `cargo`, `rustup` and `mise` on a
[Dev Drive](https://learn.microsoft.com/en-us/windows/dev-drive/), R:, through junctions at the old paths. It was
retired (Cara, 2026-11-22: "Delete it all", "Stay on C:") because:

- **No gain was measured.** After a day, runner -2 on R: was 6 to 9% faster than the other three by median, but slower
  by mean on release builds, with day-to-day noise of about 25%. The Defender exclusions (#286) already give most of
  what a Dev Drive buys.
- **It didn't survive a reboot.** Windows doesn't re-attach a virtual disk at boot. The SYSTEM task that was meant to
  do it failed with no log after the reboot on Nov 22. The runners started anyway, and every job failed with ENOTDIR on
  the dangling junctions. Junctions also break checkout's token match, because git sees the R: path and not the C:
  path the runner reports (Peek #862).

Peek's write-up: `r-drive-2026-11-22.md` in the Citadel scheme's shared folder, `inbox/Peek-Auras/`.

A retry would need all four of these:

- No junctions. Point the runner's `.runner` `workFolder` and its env at the drive.
- keep-runners attaches the drive before it starts any runner, and logs any error from the attach.
- One deliberate, tested reboot before anything relies on the drive.
- A week-long A/B against runners on C:, not a single day.

## Check it

- `ci_runners list`, or on the PC `Get-Service actions.runner.*`, lists each runner and whether it is Running.
  A runner's own log is in `C:\actions-runner-<repo>\_diag`.
- On GitHub: the repo's Settings → Actions → Runners shows it Idle or Active, or
  `gh api repos/<owner>/<repo>/actions/runners --jq '.runners[] | [.name, .status, .busy] | @tsv'`.
- A queued job that never starts means no online runner has its labels: check the label in
  `runs-on` matches the runner's.

## Fall back to hosted runners

When a scheme's CI PC is off for a while, set the repo variable `CI_RUNNER` to `github`
(`gh variable set CI_RUNNER --body github --repo <owner>/<repo>`) and jobs run on `ubuntu-latest`;
delete it (`gh variable delete CI_RUNNER --repo <owner>/<repo>`) to come back. Hosted jobs spend
Actions minutes, and the caraminden account can't run them at all while its payment fails, so ask
Cara before switching.
