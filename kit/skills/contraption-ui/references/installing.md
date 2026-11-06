# Installing as its own app

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules).

Each contraption installs as its own app beside Citadel's, all on Citadel's one origin, so Chrome
tells them apart only by the manifest (Cara, 2026-11-04: "I want each app to be able to install
independently"). The starter's `manifest.webmanifest` has the shape; replace `my-app` and add the icons.

- **`id` and `scope` are `/apps/<name>/`**, written root-absolute with the trailing slash. A relative
  `id` resolves against the origin, not the manifest, so `"./"` is `/`: Citadel's id.
- **`start_url` inside the scope**, and never a scope wider than yours: `/` or `/apps/` stops every
  other app installing on that device.
- **Link it relatively**: `<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">`.
  `/manifest.webmanifest` is Citadel's. Without `crossorigin` the fetch has no login and fails.
- **Icons: a 192 and a 512 px PNG** with purpose `any` (a maskable 512 too, ideally), served by your app.
  An SVG alone gets no Install on Android, only "Add to home screen". Also `name` and
  `display: "standalone"`.
- A service worker is optional; if you have one, its scope is `/apps/<name>/`.

The app rail has an **Install <your title>** button for you, framed in Citadel or on your own page,
which picks the way this browser can install you (the browser's dialog, your page in a new tab or in
Chrome itself, or the iOS Share hint; [rail-and-drawers.md](../rail-and-drawers.md), "Installing you"). Opened from Citadel's
rail, your page is in a frame and Chrome only sees Citadel's page, so that button is the way in.
Every deploy checks the above and logs `Warning (installing as its own app): …` lines when it's wrong
(Citadel's `src/pwa-check.ts`). Full detail and the Android caveats:
`shared/project/specs/contraptions/app-rail.md`, "Installing your contraption as its own app".
