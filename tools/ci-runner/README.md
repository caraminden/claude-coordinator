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

1. On Citadel's Machines page, add a machine named `cara-desktop-runners` that runs nothing
   and has no folder. Copy its token (`ccm_…`) and the address its setup lines connect to.
   Being Cara's, it may act for every scheme.
2. Easiest: the page shows the whole line, address and token filled in, on its **CI runner agent** tab right after you add the machine (or make a new token). Copy that and skip to the end of this step. By hand: open PowerShell **as administrator** and paste this. Put that address in
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
