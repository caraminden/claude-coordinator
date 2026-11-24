---
name: run-on-windows
description: Run a test, a command or the app on the shared Windows test box and get the output and a screenshot back in minutes, outside the CI queue. Use when a native-app change needs proof on real Windows (a window, an overlay, capture, DPI, rounded corners) before or instead of waiting on CI, to see what the app looks like, or to test Citadel as an installed app (title bar overlay, drag regions, top bar clicks).
---

# Run on Windows

The test box is a Windows 11 VM whose screen is always signed in and unlocked. It runs at 125%
with rounded corners and draws on the CPU (WARP) unless a job asks for the GPU. Its machine is
`citadel-test-box`, and its tools are `mcp__citadel-test-box-ws__…`. If your turn doesn't have
them, the box is offline, isn't lent to your scheme or has Workspace tools off: say so (the
Taskmaster's machines tool shows which) and use CI. Setup and costs:
Citadel's `tools/win-test-box/README.md`.

## The loop

1. **Push your branch.** The box fetches from origin and never sees your worktree.
2. **`workspaces`.** Find your scheme's workspace (named after its repo), its tasks, and whether
   who has the screen and who waits in its line.
3. **`git_sync {workspace, ref: "<your branch>"}`.** This gives a detached checkout of
   origin/<branch>.
4. **Run.** A box workspace has two or three tasks. Each takes one argument: a whole PowerShell command
   line, run in the clone (behind `mise exec --` when the repo pins tools).
   - **`run`** has the screen: tests that open windows, overlays or capture, or the app itself.
   - **`build`** doesn't touch the screen: compiling and plain tests. It runs beside a CI desktop
     job, so build with it first and then `run` only what needs the screen.
   - **`run-gpu`**, once the box has its GPU: like `run`, with Cara's GPU switched on in the box
     for this job only, so Direct3D gets real hardware. Everything else draws in software, so
     golden pictures stay `run`'s. It prints the adapter an app gets by default; exit 2 means the
     box has no GPU yet (use CI or a person), 3 that it didn't come on (`gpu.ps1 -Check` in `build`).
     A person can switch GPU jobs off on the Machines page: then `run-gpu` is refused, and one
     running is stopped ("Stopped by the GPU jobs switch"). Don't retry: use `run`, or ask.

   For example, `run_task {workspace, task: "build", args: ["cargo build --tests"]}`. Pass the
   command as one string: quoting across several args is lost on the way to PowerShell.
5. **Wait.** `run_task` waits up to 50 s, then hands back a job id. Call `job {id, wait: 50}`
   until it ends. A cold Rust build takes about 10 minutes; later ones take 1–3. If someone has
   the screen, a `run`, `run-gpu` or other screen task takes a place in the box's one line, which
   CI desktop jobs share. It comes back "waiting in line for the screen (job …)", naming who has
   the screen and how many are ahead. It starts by itself when its turn comes, and its 30 minutes
   count from then. Citadel follows a queued job for you, which keeps its place: end your turn,
   and a message comes to your chat when it gets the screen and again when it ends, with its exit
   code and last lines. Calling `job` yourself still works if you'd rather keep your turn. If your
   turn is stopped or you're closed while it waits, it leaves the line. `stop_job` leaves it too.
6. **To see the app:**
   - `run_task {task: "run", args: ["cargo run --release"], wait: 5}`. It comes back still running,
     with a job id.
   - `screenshot {window: "<part of its title>", delay: 3}` returns a PNG path on the server.
     Read that path to look at it. Leave `window` out for the whole screen.
   - `stop_job {id}` closes it and frees the screen. Always stop what you launched: until you do,
     it holds the screen for everyone, for up to 30 minutes.
7. **Files the tests wrote** (their own screenshots, logs) come back with `fetch_file`.

**A rig you build stays.** Commit a reusable test rig you build for the box (scripts, a driver, a fixture
page) under this skill's `scripts/`, with a line here, so the next minion starts from it.

Scripts already here besides the WCO rig:
- `scripts/defender-copy/check.ps1`: does copying in a window raise Defender's SuspClip.B (#1185, #1186). Run it with the `run` task; it installs Electron into `%LOCALAPPDATA%\defender-copy` the first time.
- `scripts/electron-app/place.mjs`: where the desktop app's window opens (fresh profile, saved place, off-screen place, maximised); no server needed.
- `scripts/electron-app/install.ps1`: the first-install zip unzipped and its launcher started, as a person does it; `-Keep` leaves it up for a screenshot.

## Testing Citadel itself

Testing Citadel as an installed app (title bar overlay, drag regions, top bar clicks) or its Electron desktop app (drag, reload timing,
keys): read `references/citadel-desktop.md` first; its rigs live under `scripts/wco/` and `scripts/electron-app/`.

## What you get back

- **Waiting in line:** "waiting in line for the screen … desktop CI job … for GitHub Actions has
  the screen" means a CI run has it, for as long as that job takes; "… for Peek Auras #N" means
  another minion. End your turn and wait for Citadel's message, or wait with `job`. A queued job
  holds its workspace, so `build` and `git_sync` there are refused until it starts and ends, or
  you stop it: build first, as step 4 says.
  Never stop someone else's job.
- **Busy:** only `screenshot` says "The screen is busy". It waits 50 s in line and can't keep a
  place. Try again in a few minutes, or take it while your own `run` job has the screen.
- **Pixel tests:** the box is unactivated on purpose, so an "Activate Windows" watermark may
  appear in the bottom-right corner. The first screenshots (2026-11-10) had none, but Windows can
  add it later, so keep pixel checks out of that corner.
- **What a pass proves:** a pass here proves Windows behaviour on a 125% screen, in software
  drawing, or with `run-gpu` on real Direct3D hardware. It never proves HDR or hardware overlays
  (the box's screen supports neither, GPU or not) or a game running beside it. Say which you proved.
- **What the box can't do** (WARP, a Hyper-V screen): exclusive fullscreen fails, and capturing
  a maximised window can give a black frame (Peek Auras, 2026-11-10). Skip such a test on the box
  rather than chase it, and say so.
- **The record:** CI still gives the verdict on a PR. The box is for proving a fix before you
  push the round trip, and for looking.
