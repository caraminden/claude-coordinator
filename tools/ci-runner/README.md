# Shared CI runners

Every scheme's GitHub Actions jobs run on self-hosted runners on Cara's Windows desktop
(DESKTOP-G248IJ8), not on GitHub's hosted runners: GitHub refuses hosted jobs on the caraminden
account, and we don't have the minutes anyway (Josh, 2026-11-05: "We need to make the default for
all schemes to use caras desktop for CI"). It copies Delve's `delve-ci` runner: a personal account's
runner serves one repo only, so each scheme's repo gets its own runner instance on that PC.

| | Each scheme's runner |
|---|---|
| Folder | `C:\actions-runner-<repo>`, then `-2` … for more instances (up to 4), each with a `.citadel-runner` marker |
| Label | `<scheme-slug>-ci`: the scheme's name in lowercase with dashes (`Peek Auras` → `peek-auras-ci`) |
| Service | `actions.runner.<owner>-<repo>.DESKTOP-G248IJ8` (then `…-2` …), as NETWORK SERVICE, delayed automatic start, restart on failure; one job at a time |
| `.env` | telemetry off, `C:\Program Files\Git\bin` first on PATH so `bash` steps run, and tool folders of its own: `MISE_DATA_DIR`, `MISE_CACHE_DIR`, `MISE_STATE_DIR`, `RUSTUP_HOME` and `CARGO_HOME` under `<its folder>\tools\` (#370: runners sharing NETWORK SERVICE's one profile broke each other's mise and cargo on Peek Auras). Runners added before #370 don't have these; remove and add them again to get them |

**Hard rules on that PC.** Never restart or reboot it (Windows Update is paused there). Never touch
another scheme's runner, Delve's (`C:\actions-runner`, `-2`, `-3`, `-4`, `-perf`) above all.
Registration tokens (and the Linux scripts' removal tokens) last about an hour and are never written down.

## How runners get there

Citadel installs them itself (#328; Josh, 2026-11-05: "Citadel installs it itself"). The **CI runner
agent** (`public/runner-agent.mjs`) runs on the desktop as SYSTEM, from a scheduled task, and dials
out to Citadel like a machine agent. It does three things, and only when a member of the scheme asks:

| Ask | What runs on the desktop |
|---|---|
| `add`, with a count of 1 to 4 | `add-runner.ps1 -Scheme <id> -Count <n>`: installs the missing instances, then Citadel waits until GitHub shows them Idle |
| `list` | `list-runners.ps1`: every `actions.runner.*` service, its state and folder, and whether Citadel made it |
| `remove` | `remove-runner.ps1 -Scheme <id>`: only folders whose `.citadel-runner` marker names the scheme's repo. Citadel takes each runner off GitHub; the script then deletes its service and folder |

With `os: linux` (`{"op": "add", "count": 1, "os": "linux"}`) the same three go to the **Linux** runner agent in WSL
on the same PC instead, which runs `add-runner.sh`, `list-runners.sh` or `remove-runner.sh`: see
[Linux runners in WSL](#linux-runners-in-wsl-510).

People and Taskmasters ask with the `ci_runners` tool (a minion's or the Taskmaster's), or
`POST /api/projects/<id>/ci-runners` with `{"op": "add", "count": 2}`. Citadel checks the asker is in the
scheme. An `add` or `remove` posts one note in the scheme Taskmaster's chat when it ends, with the
agent's output (and any tokens its scripts fetched) collapsed under it; a `list` posts none. Scheme setup calls
`ci_runners add` when it gives a scheme CI (the `citadel:scheme-setup` skill).

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

## Install the runner agent (Cara, once)

1. On Citadel's Machines page, press **Add a CI runner host** under the list (admins see
   it) and name it `cara-desktop-runners`. Copy its token (`ccm_…`) and the address its setup lines connect to.
   Being Cara's, it may act for every scheme.
2. Easiest: the page shows the whole line, address and token filled in, right after you add the host (or make a new token for it). Copy that and skip to the end of this step. By hand: open PowerShell **as administrator** and paste this. Put that address in
   `$u` and the token in place of `ccm_…`:

   ```powershell
   $u = 'http://perigee.tail59477f.ts.net:8574'; iwr "$u/ci-runner/install-runner-agent.ps1" -UseBasicParsing -OutFile "$env:TEMP\install-runner-agent.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install-runner-agent.ps1" -CitadelUrl $u -MachineToken 'ccm_…'
   ```

   It checks that Node 18+ and Git for Windows are there, creates and locks the folder,
   downloads the agent and its scripts (printing their SHA-256), registers the task
   **Citadel runner agent** (SYSTEM, at startup, retried every 5 minutes), starts it and waits
   until it connects, then proves the CPU cap (#552, "Cap and yield" below). There's no reboot and no runner is registered or removed. The Machines page then shows
   `cara-desktop-runners` online.
3. Run the same line again whenever these scripts change, to update the agent. The lines it
   prints at the end say how to stop or remove it; removing the agent leaves its runners in place.

## By hand (the fallback)

`add-runner.ps1` still runs by itself in an elevated PowerShell, from a copy of this folder:

```powershell
$env:CC_MACHINE_TOKEN = 'ccm_…'
.\add-runner.ps1 -Scheme "Peek Auras" -CitadelUrl <the machines address> -Count 1
```

- The token is any machine token that may act for the scheme: a machine owned by someone in
  the scheme (an admin's works for all of them), or an ownerless one lent to it.
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
  `-Count`. Build runners come from `ci_runners add` as before.
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
| Where | the WSL distro `citadel-ci`, which belongs to the Windows account that installed it (Cara's) |
| Folder | `/opt/actions-runner-<repo>`, then `-2` … (up to 4), the scheme's user's alone, with a `.citadel-runner` marker for people (`"mode": "linux"`) |
| Label | `<scheme-slug>-ci-linux` (`theory-of-crafting-ci-linux`); GitHub adds `self-hosted`, `Linux`, `X64`. Every runner but the first also gets `<scheme-slug>-ci-linux-side`, for long jobs that must leave the first one free |
| Name | `<PC>-linux`, then `<PC>-linux-2` … |
| Runs as | the scheme's own user `ci-<repo>-<6 hex>` (no sudo), so one scheme's jobs can't touch another's runners; one job at a time |
| Service | `citadel-runner-<owner>-<repo>[-n].service`, which `add-runner.sh` writes itself from the runner's `svc.sh` template; its first line `# citadel-repo=<owner>/<repo>` is Citadel's record of whose it is |
| `.env` | telemetry off, and `HOME` in its own folder, so runners never share tool caches (#370) |
| Agent | `/opt/citadel-runner-agent` (root's alone), the systemd service `citadel-runner-agent`, its own machine host on the Machines page |
| Kept up by | the logon task **Citadel WSL runners** (`keep-wsl-up.ps1`), which holds the distro open: WSL stops a distro seconds after the last program using it exits, and its services with it |

The distro is **cut off from Windows** (`/etc/wsl.conf`: no `C:` mount, no running Windows programs), because a CI job
there runs inside Cara's own WSL and could otherwise read her files or run programs as her. Install a scheme's
system packages (a `-dev` library, a browser's shared libraries) by hand, as root in the distro, like a Windows
runner's scheme-specific tools.

What it shares with the Windows agent: it runs only its own scripts, with the numbers Citadel's job carries; never
downloads code (installing again is how its scripts change); never sees a registration token (the scripts fetch it);
one job at a time, ended after 15 minutes. As root it never runs a file from a runner folder (CI jobs can write
there): `config.sh` runs as the scheme's user, with the registration token in its environment, never its command
line, and no machine token. `remove` trusts only the service files in `/etc/systemd/system`, root's alone
(`remove-runner.sh` refuses if that ever stops being true), never a folder's marker, which a job could forge; it
deletes the scheme's user with its last runner.

Its one limit: WSL distros are each Windows user's own, so the task runs **while Cara is logged on**, like the
session runners. After a reboot, the Linux runners come back when she logs on. (A SYSTEM task can't reliably start a
user's distro, and a distro of SYSTEM's own is unproven.)

### Set it up (Cara, once)

Nothing here needs Administrator or a reboot. Checked on 2026-11-10: the desktop has WSL 3.0.5 with
VirtualMachinePlatform Enabled and no distros yet. **If any step says a reboot or a Windows feature is needed, stop
there and tell the minion**: the PC is never restarted for this.

1. **The distro.** In a normal PowerShell:

   ```powershell
   wsl --install Ubuntu-24.04 --name citadel-ci
   ```

   If it asks for a UNIX user name and password, give any (`cara` will do); nothing uses them. It opens a shell in
   the distro when it's done: type `exit`. ([Microsoft's install guide](https://learn.microsoft.com/en-us/windows/wsl/install)
   says more; if `--name` is refused, stop and tell the minion.)
2. **Its host on Citadel.** On Citadel's Machines page, press **Add a CI runner host** and name it
   `cara-desktop-linux`. Leave the install line open on the **Linux in WSL** tab and press **Copy**. Give the host
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
   Machines page then shows `cara-desktop-linux` online.
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

   It registers the task **Citadel WSL runners** for you and says when `citadel-ci` is Running.
5. **The runners.** A minion or Taskmaster of the scheme asks `ci_runners` with `op: add`, `os: linux` and a count.
   Then the scheme's own system packages go in by hand (`wsl -d citadel-ci -u root`, then `apt-get install …`).

To update the Linux agent and its scripts later, run step 3's line again (the token is the host's; make a new one on
the Machines page if it's lost). To stop everything: `Disable-ScheduledTask -TaskName 'Citadel WSL runners'`, then
`wsl --terminate citadel-ci`.

**What has been tested** (#510): the scripts ran end to end on perigee against a fake Citadel, a fake runner
tarball and stubbed `systemctl`, `runuser`, `useradd` and `userdel` (`test/runner-linux-scripts.test.ts`), and
`keep-wsl-up.ps1` passes the `.ps1` lint. Nothing has run in WSL yet: the real `config.sh` and runner service,
systemd in the distro, the tailnet from WSL's network, and whether the logon task really holds the distro up are
first tried by Cara's setup.

## Load samples (#534)

Each runner agent also samples its PC every 30 seconds and posts the sample to Citadel, which keeps 14 days of
them (`src/ci-load.ts`). It is read-only: it changes no runner, count, VM setting or workflow. The Machines page
shows the result under **CI desktop load**, to everyone signed in: a verdict, CPU
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
- **Turning it on** (Cara, after the change is live): the agents never update themselves, so run each host's
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
| The WSL VM (Citadel's and ToC's Linux runners, and the Android emulator, #533) | `processors=16` in Cara's `%UserProfile%\.wslconfig`; inside it, the runners niced (`citadel-runner-.service.d/yield.conf`, written by `install-runner-agent.sh`) | at most 16 of the 32 threads; the emulator's 4 cores come first |
| The test box VM (Peek's desktop tests) | `Set-VMProcessor -Count 6 -Maximum 75 -RelativeWeight 50`, set by `tools/win-test-box/new-test-box.ps1` | about 4.5 of 32 threads, already; left as it is |

**Windows.** Every 15 seconds `keep-runners.ps1` finds each `RunnerService.exe` and `Runner.Listener.exe` and
everything started under them, and puts what isn't held yet into the job. The job runs everything in it at below-normal
priority and caps all of it together at 75% of every core (a hard cap: past it, the job's threads wait for the next
scheduling interval). A process started by one in the job is in the job from its start, so a step's cargo, MSBuild,
node or dotnet is held too; the sweep only catches runners that started before it did, and processes that asked to
break away (one whose parent ended before the next sweep stays out: breakaway is allowed because refusing it makes
the tool that asks fail to start). A runner already in another job (a session runner's logon task puts it in one) gets a job of its own,
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
what share of the PC each slot and the job used, and that the squeezed slot speeds up once its squeeze is lifted. `install-runner-agent.ps1` runs it at its end; it touches no runner. By hand, in an administrator
PowerShell: `powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\citadel-runner-agent\keep-runners.ps1 -Prove`.

**WSL** (by hand, once, as Cara). WSL's VM has no job object Windows can cap; `.wslconfig` is what limits it
([`.wslconfig` settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#wslconfig)). In a normal PowerShell:

```powershell
$f = "$env:UserProfile\.wslconfig"; $t = if (Test-Path $f) { Get-Content -Raw $f } else { '' }
if ($t -match '(?m)^[^\S\r\n]*processors\s*=') { $t = $t -replace '(?m)^[^\S\r\n]*processors[^\S\r\n]*=[^\r\n]*', 'processors=16' } elseif ($t -match '(?m)^\[wsl2\]') { $t = $t -replace '(?m)^\[wsl2\][^\S\r\n]*(?=\r?$)', "[wsl2]`r`nprocessors=16" } else { $t = "[wsl2]`r`nprocessors=16`r`n`r`n" + $t }
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
any scheme's ship run (a `land/…` branch: Peek's, Mandate's, ToC's, Citadel's) has a job on a runner here, every other
runner on the PC is squeezed; Delve's PR checks are not ships (Cara, "No, ship branches only"). Nothing changes when
no ship is running: the 75% cap above is all there is.

- **Who knows a ship is running.** Citadel (`src/ci-ships.ts`) asks GitHub every 15 seconds which `land/…` runs are
  in progress in each repo with runners here, and which self-hosted runner each running job is on, and sends that list
  (repo and runner name) to both runner agents. Same-named runners in two repos are told apart by repo.
- **Windows.** The agent writes the list to `C:\ProgramData\citadel-runner-agent\ships.json` with an expiry 2 minutes
  out. `keep-runners.ps1` gives each runner its own slot, a job named `Global\CitadelCiRunner-<folder>` nested in the
  shared 75% job, names it from the runner's `.runner` file, and re-reads `ships.json` every 2 seconds. While a ship
  runs, the slots not on a ship share `-SqueezePercent` (30, `SQUEEZE_PERCENT` in `public/runner-agent.mjs`) of the
  PC, split evenly among the ones running a job; a ship's slot keeps no cap of its own (only the shared 75%). A
  runner whose slot can't nest in the shared job (a session runner already in its logon task's job) gets the same
  share of the PC on its own job.
- **WSL.** The Linux agent finds each `citadel-runner-*` service's folder, names it the same way, and sets
  `systemctl set-property --runtime <unit> CPUQuota=` on every runner not on a ship: 30% of the VM's cores split among
  the ones running a job (with `processors=16`, 480% for one, 240% for two). An empty `CPUQuota=` lifts it.
- **Lifting.** An empty list lifts the squeeze at once (both agents get one every 15 seconds); if Citadel goes quiet
  (restart, GitHub hiccup, the agent's link down), it lifts after 2 minutes on its own. A repo whose reads keep failing
  keeps its last ships for 2 minutes, then drops them. A rate limit from GitHub lifts the squeeze at once and pauses the
  watch for 5 minutes. A restarted WSL agent clears every runner's quota at start, in case the one before died mid-ship.
- **Every scheme.** Any repo with a runner on this PC is watched, through its own scheme's GitHub login; nothing is
  keyed to Citadel's repo. A squeezed build still runs, just slower, and returns to its normal share the moment the
  ship ends.

**Install (Cara, once, after this ships).** Both agents need the new scripts; the lines below reuse each agent's own
token from its folder, so nothing needs copying. In PowerShell **as administrator**:

```powershell
$u = 'http://perigee.tail59477f.ts.net:8574'; iwr "$u/ci-runner/install-runner-agent.ps1" -UseBasicParsing -OutFile "$env:TEMP\install-runner-agent.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install-runner-agent.ps1" -CitadelUrl $u -MachineToken (Get-Content -Raw "$env:ProgramData\citadel-runner-agent\machine-token").Trim()
```

It ends with `-Prove`, which now proves the squeeze too. Then, for WSL, in the distro as root (`wsl -d citadel-ci -u root`):

```bash
u='http://perigee.tail59477f.ts.net:8574'; f=$(mktemp) && curl -fsSL "$u/ci-runner/install-runner-agent.sh" -o "$f" && CC_MACHINE_TOKEN=$(cat /opt/citadel-runner-agent/machine-token) bash "$f" "$u"
```

Neither restarts a runner or the PC; running jobs keep going and are squeezed from the next sweep.

**What has been tested** (#1268): the watcher against a fake GitHub (`test/ci-ships.test.ts`), the hub sending the
list to both agents (`test/machine-relay.test.ts`), the Linux quotas and the ships file (`test/runner-agent.test.ts`),
and `keep-runners.ps1`'s share maths, `ships.json` reading and runner naming in pwsh on perigee with the job calls
faked (`test/keep-runners.test.ts`). Nested job objects themselves only run where `-Prove` runs: on the desktop, at
the install above.

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
`citadel-ci-linux-side`, which only `-linux-2` carries (#1240: on 2026-11-20 proofs held both runners for three hours and
every land fell back to perigee). Runners added before #1240 got the side label by hand, as the repo's admin:
`gh api -X POST repos/caraminden/claude-coordinator/actions/runners/<id>/labels -f 'labels[]=citadel-ci-linux-side'`.
Without a runner carrying it, those wait in GitHub's queue (up to a day) while lands go on; `test/ci-runner-choice.test.ts` fails on a workflow job that could take the first runner.
`.github/workflows/tests.yml` runs on every push to a `land/**` branch, and `tools/land.sh` is the only
thing that pushes there: it sends the rebased commit to `land/<branch>`, waits for the run on that exact commit
while it holds the deploy lock, and deletes the branch again. A land that touches no pipeline file leaves out the
pipeline's own test files (#581, `tools/pipeline-files.txt`), so the whole suite also runs on main every night at
13:30 UTC. That run and any started by hand are in a concurrency group of their own (a run waiting in the lands' group
would cancel the land waiting there): they wait for the lands' runs, up to 30 minutes, then run niced beside any
that start. The workflow runs `tools/run-tests.sh`, the same run `land.sh` makes on perigee, and fails when any test is
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
takes more than 6 minutes), `land.sh` prints `CI FALLBACK` with the reason, runs the suite on perigee as it used
to, and adds a `ci fallback` line to the day's retro log (`retro-log/<date>/land.md`), so they can be counted. A red
run refuses the landing; it never falls back. Two exceptions (ADR 0006): a red in which every failed file passed when
`run-tests.sh` reran it alone (#769) gets one fresh run of the same commit, which must be fully green to land, and a
`flake rerun` line in the retro log; a run cut off before any test failed (#1377) gets the same one fresh run and a
`cut-off rerun` line, and cut off again it is no answer, which falls back. `LAND_CI=0 tools/land.sh` skips CI, for when the runner itself is broken.

## A Dev Drive for Peek's build runners (#1344)

A trial (Cara, 2026-11-20 16:37 PST: "G. Dev Drive on the desktop: Go"): one of Peek Auras' build runners,
`DESKTOP-G248IJ8-2`, keeps its work on a [Dev Drive](https://learn.microsoft.com/en-us/windows/dev-drive/) (ReFS, and
fewer file system filters than C:). If its Test and Build release steps get 5% or more faster over a day, against the
other three, those move too; if not, it moves back.

How: the runner's four work folders (`_work`, which holds the checkout and cargo's `target`, then `cargo`, `rustup`
and `mise`) are copied to `R:\peek-auras-2`, and each old path becomes a junction to its copy. The runner, its `.env`
and the workflows keep the same paths, so nothing else changes and cargo's warm `target` stays warm. The old folders
stay beside them as `<name>.pre-devdrive` until the trial ends; that's how it moves back. The Dev Drive is a 200 GB
virtual disk that grows as it fills (`C:\DevDrive\ci-runners.vhdx`, about 40 GB per runner), attached at boot by a
SYSTEM task.

What it doesn't change: Defender already skips these folders (#286), so the new folders get the same exclusion and
the trial measures the drive alone. Nothing here restarts the PC, touches another scheme's runner, or edits a `.env`.

Every step runs `dev-drive.ps1` from this folder in **PowerShell as administrator** on the desktop; open that window
once and keep it for the whole step. The script knows only Peek's four build runners, so it can't reach another
scheme's. Its header lists every step. Two things it refuses: running Move, Back or Cleanup within half an hour of a
boot (Citadel's keep-runners task starts stopped runners then, and could start one mid-copy), and a drive at R: that
isn't the `ci-runners` ReFS one.

This is the one exception to the hard rules above for Peek's runners: it stops and starts them, on Cara's go.

### 1. Check the PC can do it (changes nothing)

```powershell-admin
iwr 'http://perigee.tail59477f.ts.net:8574/ci-runner/dev-drive.ps1' -UseBasicParsing -OutFile "$env:TEMP\dev-drive.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\dev-drive.ps1" -Do Check
```

`fsutil devdrv query` should say developer volumes are enabled; if it says they aren't supported, Windows is older than
22621.2338 and the trial stops here. It should say `R: is free`, and C: needs the free room it names.

### 2. Make the Dev Drive (once)

```powershell-admin
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\dev-drive.ps1" -Do MakeDrive
```

The last line should call R: a trusted developer volume. A SYSTEM task, `Attach CI Dev Drive`, attaches the disk again
at boot, before the runner services start (they start delayed).

### 3. Move runner -2 onto it

It waits for the runner's current job to end, then stops the runner (GitHub gives its next job to another runner
meanwhile), copies, links and starts it again. Copying about 35 GB takes a few minutes. If a job lands in the
seconds between the wait and the stop, that job is cancelled; its ship just runs again.

```powershell-admin
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\dev-drive.ps1" -Do Move -Runner DESKTOP-G248IJ8-2
```

The table at the end should list four junctions. Each folder moves on its own and the runner starts again even after
an error, so a stop halfway leaves it working: what moved points at R:, the rest is where it was. Running the line
again carries on where it stopped.

### 4. Measure (the minion)

After a day, the minion reads every green Test and Build release step of `windows.yml` with `gh` and compares runner
-2 with the other three, the day before and the day after (each runner's ratio to the others, since their medians
already differ by up to 15% on the same day), with how many runs each number comes from. The first run on -2 after
the move is left out: it may build cold once.

### 5a. It helped: move the other three

One at a time, so at least two runners always take jobs. They need about 110 GB more on C: until the old copies go;
Check prints the room.

```powershell-admin
iwr 'http://perigee.tail59477f.ts.net:8574/ci-runner/dev-drive.ps1' -UseBasicParsing -OutFile "$env:TEMP\dev-drive.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\dev-drive.ps1" -Do Move -Runner DESKTOP-G248IJ8, DESKTOP-G248IJ8-3, DESKTOP-G248IJ8-4
```

Once they've all run green for a day, the old copies can go (about 35 GB each back on C:). It deletes a runner's old
copy only where its junction points at R:, and never follows a link inside it. After this, 5b can't run.

```powershell-admin
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\dev-drive.ps1" -Do Cleanup -Runner DESKTOP-G248IJ8, DESKTOP-G248IJ8-2, DESKTOP-G248IJ8-3, DESKTOP-G248IJ8-4
```

### 5b. It didn't help: move runner -2 back

Only before any Cleanup. The old folders come back (a day stale, so its next build recompiles what changed), then the
Dev Drive goes. Removing a junction removes only the link, never what it points at.

```powershell-admin
iwr 'http://perigee.tail59477f.ts.net:8574/ci-runner/dev-drive.ps1' -UseBasicParsing -OutFile "$env:TEMP\dev-drive.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\dev-drive.ps1" -Do Back -Runner DESKTOP-G248IJ8-2
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\dev-drive.ps1" -Do RemoveDrive
```

### If R: is missing

After a power cut, jobs on a moved runner fail at checkout if the task didn't attach the disk. Attach it by hand
(nothing else needs doing; the runners pick it up on their next job):

```powershell-admin
iwr 'http://perigee.tail59477f.ts.net:8574/ci-runner/dev-drive.ps1' -UseBasicParsing -OutFile "$env:TEMP\dev-drive.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\dev-drive.ps1" -Do Attach
```

## Check it

- `ci_runners list`, or on the desktop `Get-Service actions.runner.*`, lists each runner and whether it is Running.
  A runner's own log is in `C:\actions-runner-<repo>\_diag`.
- On GitHub: the repo's Settings → Actions → Runners shows it Idle or Active, or
  `gh api repos/<owner>/<repo>/actions/runners --jq '.runners[] | [.name, .status, .busy] | @tsv'`.
- A queued job that never starts means no online runner has its labels: check the label in
  `runs-on` matches the runner's.

## Fall back to hosted runners

When the desktop is off for a while, set the repo variable `CI_RUNNER` to `github`
(`gh variable set CI_RUNNER --body github --repo <owner>/<repo>`) and jobs run on `ubuntu-latest`;
delete it (`gh variable delete CI_RUNNER --repo <owner>/<repo>`) to come back. Hosted jobs spend
Actions minutes, and the caraminden account can't run them at all while its payment fails, so ask
Cara before switching.
