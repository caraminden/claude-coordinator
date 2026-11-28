# Citadel as an installed app (WCO) and Citadel's desktop app (Electron)

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

`scripts/electron-app/reload.mjs` (#1697) times reloads the same way (`reload.mjs <rig URL> - 6`): reload to the app drawn and
to the splash gone, and each front file as 200, 304 or served from cache. Touch `shell-cache-off` in the dev copy's data folder
first when live has the service worker's shell off, or every file comes from the worker.

`scripts/electron-app/keys.mjs` (#1691) needs no dev copy: it serves its own page (a text box and three app frames: same host,
sandboxed, cross-site) and runs a published build (`keys.mjs 9`), the checkout's `desktop/` on the newest build's Electron
(`keys.mjs checkout`) or an Edge app window (`keys.mjs edge`). `keys` presses Ctrl+R, F5, Ctrl+Shift+R and Ctrl+F5 with focus
in each place; `rclick` reads the menu each right-click opens (UI Automation: Electron's menus aren't Win32 menus) and invokes
Reload this app. While an elevated window has the box's foreground (the `front` line names it), Windows drops injected input:
set `RIG_INPUT=cdp` to send it through DevTools, which takes the same browser-side path but skips Windows' message loop.
`stuck` (#2263) presses the same keys with the page stuck on Reconnecting… (its live stream asked and never answered, the
server since recovered, a service worker serving `/c/` from cache) and passes when the reloaded page's stream connects.

`scripts/electron-app/stuck-live.mjs` (#2263) does that on Citadel's real page: a published build (`stuck-live.mjs <rig URL> 11`)
or `checkout` on the WCO rig's dev copy (`rig.ts up`, no driver), signed in, through a proxy on the box that holds the live
stream the way a booting server did (#2260). It drops the stream, waits for the Reconnecting… chip, lets go, presses each
reload key with focus in the page and in the text box (DevTools input), and passes when a new page loads and its stream
answers within 8 s, well inside the page's own 30 s retry. `RIG_HELD=1` keeps the hold through one Ctrl+R: the window
still reloads and the new page sticks again, as on a server still booting. Under the `run` task, PowerShell may report
exit 1 for the app's stderr line alone: read the PASS/FAIL lines and the last `fails` count.
