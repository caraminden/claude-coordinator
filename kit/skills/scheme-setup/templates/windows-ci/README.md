# Windows CI kit

What a scheme that builds a Windows app starts its CI from (Citadel #370). It is Peek Auras' setup, Citadel's
first native Windows scheme, after a week of finding out what goes wrong (Peek Auras' desktop-app retro, 2026-11-07).
Copied from `caraminden/peek-auras` (`docs/windows-ci.md`, "The kit, for other schemes", and `tools/ci-win/`); each
file says which of Peek's it came from.

| File | Goes to | What it is |
|---|---|---|
| `windows.yml` | `.github/workflows/windows.yml` | Build, lint and the tests that need no desktop, on the build runners (`<scheme-slug>-ci`) |
| `desktop.yml` | `.github/workflows/desktop.yml` | The screen gate, then the tests that open windows, on the session runner (`<scheme-slug>-desktop`) |
| `screen-check.ps1` | `tools/ci-win/screen-check.ps1` | Reads the whole screen the way desktop tests do; exit 0 read, 1 refused, 2 broken (Peek's) |
| `lint-ps1.ps1` | `tools/ci-win/lint-ps1.ps1` | Parse and lint for `.ps1` files (below) |

Swap `<scheme-slug>` for the scheme's label stem (`Peek Auras` → `peek-auras`), and replace each workflow's
placeholder step, which fails on purpose until it is replaced.

## What it gets right from day one

- **One workflow and one concurrency group per runner class.** Peek's desktop runner went offline while its jobs
  shared a concurrency group with the build, and it held main's build verdict. Here `windows.yml` (group `windows-<ref>`) and
  `desktop.yml` (group `desktop-<ref>`) never wait on each other.
- **Skipped never looks green.** `desktop.yml`'s `screen` job checks the session runner can read its screen. If it
  can't, the desktop jobs are skipped and `screen` warns "desktop tests NOT RUN" with Windows' reason. GitHub still
  calls that run a success, so anything that reads results must count skipped desktop jobs as NOT RUN. A broken check
  exits 2 and goes red, and `windows.yml` runs it too, so a broken check can't hide as NOT RUN forever. Peek shipped
  a version that skipped every desktop job while showing green.
- **Tool folders per runner.** Citadel's `add-runner.ps1` gives each runner `MISE_DATA_DIR`, `MISE_CACHE_DIR`,
  `MISE_STATE_DIR`, `RUSTUP_HOME` and `CARGO_HOME` under its own folder (`<runner>\tools\…`, in its `.env`). Every
  build runner runs as NETWORK SERVICE, so they shared one profile, and two jobs starting at once broke each other's
  mise (`spawn EBUSY`) and cargo (not found mid-sync).
- **The session runner.** Jobs that open windows or read the screen can't run in a service (session 0 has no
  desktop). In Citadel's repo (`caraminden/claude-coordinator`), `tools/ci-runner/add-runner.ps1 -Session` adds one runner that runs as the person who
  ran it, started by a logon task, on a hidden desktop; with `-Visible`, on their own desktop. A hidden desktop
  refuses screen reads and capture, so a scheme whose tests read the screen needs `-Visible` and an unlocked
  session. `tools/ci-runner/README.md` there has the steps.
- **A .ps1 lint before the push.** `lint-ps1.ps1` reports syntax errors, type names that exist neither on Windows
  PowerShell 5.1 nor PowerShell 7 for Windows, static members (`[Type]::Name`, enum values too) those types don't
  have, and PSScriptAnalyzer's rules, including its 5.1 and 7 syntax, command and type compatibility checks. It runs
  on perigee, where pwsh and PSScriptAnalyzer are installed for cara:
  `pwsh -NoProfile -File tools/ci-win/lint-ps1.ps1 $(git ls-files '*.ps1')`. Put that line in the scheme's
  CLAUDE.md check commands. `windows.yml` runs it again on Windows. It can't catch what only fails at run time, such
  as a value an enum refuses: Peek's CopyPixelOperation bug would still have got through.

## Hosted runners prove little here

`windows-latest` is a VM with no GPU, at 100% display scaling, with square window corners. Ten of Peek's test
assumptions broke on their first run on a real PC after passing there. It is the fallback (`CI_RUNNER=github`, after
asking Cara), not evidence that desktop code works.

## Still to come

Peek Auras is building a Hyper-V VM kit for a desktop runner that doesn't depend on anyone's own session: an
always-unlocked console, a real GPU where possible, 125% scaling (Citadel #369 takes it on). It isn't copied here
yet. Read `caraminden/peek-auras` for its progress, and bring it in once it has run.
