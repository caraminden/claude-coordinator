---
name: run-on-windows
description: Run a test, a command or the app on the shared Windows test box and get the output and a screenshot back in minutes, outside the CI queue. Use when a native-app change needs proof on real Windows (a window, an overlay, capture, DPI, rounded corners) before or instead of waiting on CI, or to see what the app looks like.
---

# Run on Windows

The test box is a Windows 11 VM whose screen is always signed in and unlocked. It runs at 125%
with rounded corners and renders on the CPU (WARP), with no GPU. Its machine is
`citadel-test-box`, and its tools are `mcp__citadel-test-box-ws__…`. If your turn doesn't have
them, the box isn't lent to your scheme or is offline: say so and use CI. Setup and costs:
Citadel's `tools/win-test-box/README.md`.

## The loop

1. **Push your branch.** The box fetches from origin and never sees your worktree.
2. **`workspaces`.** Find your scheme's workspace (named after its repo), its tasks, and whether
   the screen is busy.
3. **`git_sync {workspace, ref: "<your branch>"}`.** This gives a detached checkout of
   origin/<branch>.
4. **Run.** A box workspace has two tasks. Each takes one argument: a whole PowerShell command
   line, run in the clone (behind `mise exec --` when the repo pins tools).
   - **`run`** has the screen: tests that open windows, overlays or capture, or the app itself.
   - **`build`** doesn't touch the screen: compiling and plain tests. It runs beside a CI desktop
     job, so build with it first and then `run` only what needs the screen.

   For example, `run_task {workspace, task: "build", args: ["cargo build --tests"]}`. Pass the
   command as one string: quoting across several args is lost on the way to PowerShell.
5. **Wait.** `run_task` waits up to 50 s, then hands back a job id. Call `job {id, wait: 50}`
   until it ends. A cold Rust build takes about 10 minutes; later ones take 1–3.
6. **To see the app:**
   - `run_task {task: "run", args: ["cargo run --release"], wait: 5}`. It comes back still running,
     with a job id.
   - `screenshot {window: "<part of its title>", delay: 3}` returns a PNG path on the server.
     Read that path to look at it. Leave `window` out for the whole screen.
   - `stop_job {id}` closes it and frees the screen. Always stop what you launched: until you do,
     it holds the screen for everyone, for up to 30 minutes.
7. **Files the tests wrote** (their own screenshots, logs) come back with `fetch_file`.

## What you get back

- **Busy:**
  - "The screen is busy: desktop CI job … for GitHub Actions" means a CI run has the screen, for
    as long as that job takes.
  - "busy … for #N" means another minion has it.

  Do the `build` side meanwhile, or try again in a few minutes. Never stop someone else's job.
- **Pixel tests:** the "Activate Windows" watermark sits in the bottom-right corner of every
  screenshot (the box is unactivated on purpose). A test that reads pixels there sees it.
- **What a pass proves:** a pass here proves Windows behaviour on a GPU-less 125% screen. It does
  not prove her GPU, HDR or a game running beside it. Say which one you proved.
- **The record:** CI still gives the verdict on a PR. The box is for proving a fix before you
  push the round trip, and for looking.
