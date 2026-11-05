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
| `.env` | telemetry off, `C:\Program Files\Git\bin` first on PATH so `bash` steps run |

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
scheme, and notes every ask and its outcome in the scheme Taskmaster's chat. Scheme setup calls
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

Session-mode runners (a hidden desktop for screen tests) aren't covered yet. They come from
Peek Auras #83's working steps once those exist.

## Install the runner agent (Cara, once)

1. On Citadel's Machines page, add a machine named `cara-desktop-runners` that runs nothing
   and has no folder. Copy its token (`ccm_…`) and the address its setup lines connect to.
   Being Cara's, it may act for every scheme.
2. On the desktop, open PowerShell **as administrator** and paste this. Put that address in
   `$u` and the token in place of `ccm_…`:

   ```powershell
   $u = 'http://perigee:8574'; iwr "$u/ci-runner/install-runner-agent.ps1" -UseBasicParsing -OutFile "$env:TEMP\install-runner-agent.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install-runner-agent.ps1" -CitadelUrl $u -MachineToken 'ccm_…'
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
  Taskmaster's chat.
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

**What has been tested.** The PowerShell scripts parse, and PSScriptAnalyzer passes with the
Windows PowerShell 5.1 and PowerShell 7 rules. Apart from that, the Windows side hasn't run
yet: the SYSTEM task, the folder lock, and the real `config.cmd` add and remove. The agent's
job handling and the Citadel side have tests, with a fake PowerShell.

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
