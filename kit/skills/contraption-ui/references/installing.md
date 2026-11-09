# Installing as its own app

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules).

Each contraption installs as its own app beside Citadel's, all on Citadel's one origin, so Chrome
tells them apart only by the manifest (Cara, 2026-11-04: "I want each app to be able to install
independently"), and every contraption ships one with a rail icon (Cara, 2026-11-09: "both of these
should be the default behavior for new contraptions"). The starter has both: `manifest.webmanifest`
(replace `my-app`), `icon.svg` and `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, which are
stand-ins to redraw (render the PNGs from your SVG, e.g. `rsvg-convert -w 512 icon.svg -o icon-512.png`;
the maskable one without the rounded corners, its mark inside the middle 80%).

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
Every deploy checks the above (Citadel's `src/pwa-check.ts`) and fills an empty registry icon from
your manifest; what's wrong comes back as **To do** lines, and goes to your home scheme's Taskmaster
(references/api.md, "Running and deploying"). Full detail and the Android caveats:
`shared/project/specs/contraptions/app-rail.md`, "Installing your contraption as its own app".
