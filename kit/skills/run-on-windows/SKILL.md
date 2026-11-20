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
   the screen is busy.
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
   until it ends. A cold Rust build takes about 10 minutes; later ones take 1–3.
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

## Citadel as an installed app (WCO)

For a Citadel change that only shows in the installed desktop app with the title bar overlay (WCO) on: drag
regions, clicks in the top bar, a framed contraption's `.cui-topbar`. Emulation on perigee can't hit-test drag
regions; only a real installed window can. The rig is `scripts/wco/` (`rig.ts`'s header lists its commands):
- an empty-data dev copy of your worktree, with a fixture contraption (`wco-fixture`, served from `fixture/`);
- a driver on the box that installs it as an Edge app and runs checks with real mouse clicks and drags,
  sending back PASS/FAIL lines and a screenshot of the window.

1. **Up**, from your worktree: `node kit/skills/run-on-windows/scripts/wco/rig.ts up`. It prints the
   `run_task` line that starts the driver on the box.
2. **Driver:** run the `run` line. It stays running, holding the screen, until `down`. Then
   `node …/rig.ts status` until `ready` is true; installing takes about 20 s.
3. **Check:** `node …/rig.ts run topbar` runs #667's check over a scheme page, a page with Citadel's own
   `.topbar` and an artifact page. Every bar button clicks, the empty bar drags the window, and ‹ › × work.
   It exits 1 on any FAIL; the shots land in `$TMPDIR/wco-rig/shots/`. `rig.ts run modal` is #772's: a framed
   app's wide `.cui-dialog` opens below the strip, its ✕ clicks, the strip above it drags and the controls dim.
   `rig.ts run corner` is #890's: at three window widths no control sits under the caption buttons, and they sit
   on the page colour, not white. `rig.ts run hint` checks #890's one-time ⌃ note stays away with the title
   bar hidden. Edge's app window has no ⌃ (the title bar is always hidden), so the side with it showing can't be
   driven here. `rig.ts run contraption-window` checks a contraption's page at top level (an app's own
   window) keeps a link to its own app.
   - A new check is a file in `checks/`, using `checks/lib.js`'s helpers (`openFixture`, `click`, `drag`,
     `expect`, `snap`).
   - A new fixture page is a file in `fixture/`, opened with `openFixture('<file>')`.
   - `rig.ts js '<code>'` runs one snippet in the app window.
4. **After editing `public/`:** `node …/rig.ts reload`. The dev copy reads assets at boot; this also
   reloads the app page.
5. **Clean up:** `node …/rig.ts down` stops the driver (which uninstalls the app) and the dev copy, then
   prints a `build` line. Run it: it removes the leftover shortcuts and uninstall entries that name the rig's
   profile, and the temp profile. A `left (not the rig profile)` line is a Citadel app someone else installed:
   leave it. The rig never touches the box's workspace checkout.

Use Edge, which the driver does. Chrome for Testing is a dead end: its app window never offers the overlay. A
CDP `PWA.install` opens in a tab, so the driver installs through Edge's own address-bar chip and dialog.

## Citadel's desktop app (Electron, #1186)

`scripts/electron-app/drag.mjs` starts `desktop/` from the box's checkout on the WCO rig's dev copy (`rig.ts up`, no driver
needed: pass the rig URL from its `run_task` line and a route), signed in. It then drags with the real mouse from each header's
empty space in the title bar strip and from a point below it, and clicks each panel's ‹. It prints DRAGS or no drag per
point, and leaves a shot at `%TEMP%\electron-drag.png`. After editing `public/`, `kill -HUP` the rig's `devPid` (state.json):
`rig.ts reload` wants the Edge driver. Electron is the one in `%LOCALAPPDATA%\defender-copy`. A turn without the
`tailscale` command sets `RIG_HOST=perigee.tail59477f.ts.net` for `rig.ts up`.

## What you get back

- **Busy:**
  - "The screen is busy: desktop CI job … for GitHub Actions" means a CI run has the screen, for
    as long as that job takes.
  - "busy … for #N" means another minion has it.

  Do the `build` side meanwhile, or try again in a few minutes. Never stop someone else's job.
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
