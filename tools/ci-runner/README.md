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
Registration and removal tokens last about an hour and are never written down.

## How runners get there

Citadel installs them itself (#328; Josh, 2026-11-05: "Citadel installs it itself"). The **CI runner
agent** (`public/runner-agent.mjs`) runs on the desktop as SYSTEM, from a scheduled task, and dials
out to Citadel like a machine agent. It does three things, and only when a member of the scheme asks:

| Ask | What runs on the desktop |
|---|---|
| `add`, with a count of 1 to 4 | `add-runner.ps1 -Scheme <id> -Count <n>`: installs the missing instances, then Citadel waits until GitHub shows them Idle |
| `list` | `list-runners.ps1`: every `actions.runner.*` service, its state and folder, and whether Citadel made it |
| `remove` | `remove-runner.ps1 -Scheme <id>`: only folders whose `.citadel-runner` marker names the scheme's repo |

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
- **It never sees a token.** The scripts fetch their own registration and removal tokens from
  Citadel with the agent's machine token, and its output is scrubbed of anything token-shaped
  before it goes back.
- **Remove only removes what add made.** It acts only on folders with the scheme's marker and
  never on Delve's paths. A runner made by hand, Peek Auras' included, has no marker, so the
  agent can't remove it.
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
   $u = '<the address the Machines page shows>'; iwr "$u/ci-runner/install-runner-agent.ps1" -UseBasicParsing -OutFile "$env:TEMP\install-runner-agent.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install-runner-agent.ps1" -CitadelUrl $u -MachineToken 'ccm_…'
   ```

   It checks that Node 18+ and Git for Windows are there, creates and locks the folder,
   downloads the agent and its three scripts (printing their SHA-256), registers the task
   **Citadel runner agent** (SYSTEM, at startup, retried every 5 minutes), starts it and waits
   until it connects. There's no reboot and no runner is touched. The Machines page then shows
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
SYSTEM task, the folder lock, the real `config.cmd` add and remove, and session mode's logon task
(Peek Auras' own setup script, which it copies, has run on Cara's PC). The agent's job handling
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
$u = '<the address the Machines page shows>'; $d = "$env:TEMP\citadel-ci"; mkdir -Force $d | Out-Null
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
| Label | `<scheme-slug>-ci-linux` (`theory-of-crafting-ci-linux`); GitHub adds `self-hosted`, `Linux`, `X64` |
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

4. **Keep it up.** Back in a normal PowerShell (not the distro), with the address the Machines page shows:

   ```powershell
   $u = '<the address the Machines page shows>'; iwr "$u/ci-runner/keep-wsl-up.ps1" -UseBasicParsing -OutFile "$env:TEMP\keep-wsl-up.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\keep-wsl-up.ps1"
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

Citadel's full suite runs on its Linux runners (`citadel-ci-linux`; two of them, but the workflow lets one suite
run at a time: two at once on that PC failed in a different file every run, 2026-11-11).
`.github/workflows/tests.yml` runs on every push to a `land/**` branch, and `tools/land.sh` is the only
thing that pushes there: it sends the rebased commit to `land/<branch>`, waits for the run on that exact commit
while it holds the deploy lock, and deletes the branch again. The workflow runs `tools/run-tests.sh`, the same run `land.sh` makes on perigee, and fails when any test is
skipped: perigee skips none, so a skip means the runner lacks something. What the suite needs goes in the runner's
own home, with no root: Node, `pwsh` with PSScriptAnalyzer for the `.ps1` lint, Chrome's headless shell for the
browser tests, and `libatomic1` and `sqlite3` unpacked from their `.deb`s. Those last two are tidier installed once
in the distro (`wsl -d citadel-ci -u root`, then `apt-get install -y libatomic1 sqlite3`); the workflow uses the
distro's as soon as they are there.

One thing does need root, once: the runner's user needs its own systemd manager, because turns in tests start
their units with `systemd-run --user` as they do on perigee. As root in the distro,
`loginctl enable-linger ci-claude-coordinator-4590fb` (the user `ci_runners` made; the workflow's step names it
when it's missing).

The workflow's step "the runner's clock" fails when the distro's kernel clock is skewed. On 2026-11-11 its tick
was 10721 instead of 10000 (who set it is not known): every clock but the raw one ran 7% fast, NTP stepped the
wall clock back 2.2 s every 32 s, and tests that time things failed at random. As root in the distro, this sets
it back and prints 0:
`python3 -c "import ctypes;b=(ctypes.c_long*26)();ctypes.cast(b,ctypes.POINTER(ctypes.c_uint))[0]=0x4000;b[11]=10000;print(ctypes.CDLL(None).adjtimex(b))"`
(`wsl --shutdown` from Windows resets it too, and stops every runner in the distro while it restarts.)

When the runner can't answer (Cara is logged off, GitHub is down, no runner takes the job within 90 s, the run
takes more than 6 minutes), `land.sh` prints `CI FALLBACK` with the reason, runs the suite on perigee as it used
to, and adds a `ci fallback` line to the day's retro log (`retro-log/<date>/land.md`), so they can be counted. A red
run refuses the landing; it never falls back. `LAND_CI=0 tools/land.sh` skips CI, for when the runner itself is broken.

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
