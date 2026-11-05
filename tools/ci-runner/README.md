# Shared CI runners

Every scheme's GitHub Actions jobs run on self-hosted runners on Cara's Windows desktop
(DESKTOP-G248IJ8), not on GitHub's hosted runners: GitHub refuses hosted jobs on the caraminden
account, and we don't have the minutes anyway (Josh, 2026-11-05: "We need to make the default for
all schemes to use caras desktop for CI"). It copies Delve's `delve-ci` runner: a personal account's
runner serves one repo only, so each scheme's repo gets its own runner instance on that PC.

| | Each scheme's runner |
|---|---|
| Folder | `C:\actions-runner-<repo>` |
| Label | `<scheme-slug>-ci`: the scheme's name in lowercase with dashes (`Peek Auras` → `peek-auras-ci`) |
| Service | `actions.runner.<owner>-<repo>.DESKTOP-G248IJ8`, as NETWORK SERVICE, delayed automatic start, restart on failure; one job at a time |
| `.env` | telemetry off, `C:\Program Files\Git\bin` first on PATH so `bash` steps run |

**Hard rules on that PC.** Never restart or reboot it (Windows Update is paused there). Never touch
another scheme's runner, Delve's two (`delve-ci`, `delve-perf`) above all. Registration tokens last
about an hour and are never written down.

## Add a scheme's runner

1. **A machine token.** On Citadel's Machines page, add a machine of your own for the desktop
   (say `cara-desktop-ci`, runs "nothing", no folder) and copy its token (`ccm_…`) and the address
   its setup lines connect to. It never needs to connect; the token is only how the script proves
   who is asking. A machine's token works for the schemes its owner is in (an admin's for all of
   them), or, for an ownerless machine, the schemes it is lent to.
2. **The scheme's side.** Its owner has linked GitHub in Settings → Your account, and the scheme has
   a GitHub repo the owner admins. Citadel asks GitHub for the token with that login
   (`POST /api/machines/runner-token`, `src/ci-runner.ts`) and notes each one in the scheme
   Taskmaster's chat.
3. **On the desktop**, in an elevated PowerShell (Run as administrator), from a copy of this folder:

   ```powershell
   $env:CC_MACHINE_TOKEN = 'ccm_…'
   .\add-runner.ps1 -Scheme "Peek Auras" -CitadelUrl <the machines address from step 1>
   ```

   It stops without changing anything if the repo's runner folder or service already exists, so
   it is safe to run again. It checks the runner download against the SHA-256 in GitHub's release
   notes. If setup fails before the runner's service exists, it removes the folder it made;
   after that, the folder stays for `config.cmd remove`. Options: `-RunnerVersion` with
   `-RunnerSha256` (default `2.338.0`, Delve's), `-GitBin`, `-RunnerName` (default the computer
   name).

   A Claude session on that PC needs Manual permissions to run it: auto mode refused to install
   Delve's runner.
4. **Scheme-specific tools** (an engine binary, an SDK) go in the runner's `.env` by hand, as a path
   NETWORK SERVICE can read (Delve copies its Godot console exe for this), then restart only that
   runner's service.

`add-runner.ps1` has been parse-checked and linted (PSScriptAnalyzer, Windows PowerShell 5.1 and
PowerShell 7 rules) but not yet run on Windows.

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

- On the desktop: `Get-Service actions.runner.*` lists each runner and whether it is Running.
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
