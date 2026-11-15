# 0005: Contraptions on their own hosts (`<name>.citadel.zip`)

Date: 2026-11-14. Minion #709, from #441's report. Cara, 2026-11-14, on #709's plan card: "Plan approved:
build it this way."

## Context

Contraptions were served at `/apps/<name>/` on Citadel's own host, so a contraption's page shared Citadel's
origin. Any script on it (the contraption's own, or anything it renders) could call Citadel's whole API as
the person looking at it, with their `cc_session` cookie riding along, and read Citadel's page through the
frame. The proxy kept `cc_session` from the contraption's *server*, but nothing kept it from the *page*.
Citadel had `citadel.zip` with a wildcard (`*.citadel.zip` reaches the same `127.0.0.1:8573`, with its own
certs, tailnet-only), so every contraption can have an origin of its own.

## Decision

With `APPS_DOMAIN` set (live: `citadel.zip`), each contraption is served at `<name>.<APPS_DOMAIN>`, still
under `/apps/<name>/` so nothing in a contraption's paths, manifest or service changes. Unset (dev copies,
previews, tests) keeps the old same-origin serving. `src/apps.ts` has the routing.

- **Host routing.** `<name>.<APPS_DOMAIN>` (from `X-Forwarded-Host` or `Host`) serves only that
  contraption, Citadel UI's files under `/apps/_citadel/`, the rail's `/apps/_citadel/api/mine` and
  `/apps/_citadel/icon/<name>`, and the sign-in handoff `/_citadel/enter`. `/` goes to `/apps/<name>/`.
  Anything else is a 404: Citadel's API and pages don't exist there.
- **Signing in once, not per app.** People sign in to Citadel only. A page load of `/apps/<name>/` on
  either Citadel host answers 302 to `<name>.<APPS_DOMAIN>/_citadel/enter?t=<token>`, with a sealed
  token that lasts 60 s, is good once, and names its app. The app host swaps it for its own cookie,
  `cc_app` (HttpOnly, 180 days, renewed like `cc_session`; over HTTPS `SameSite=None; Secure;
  Partitioned` so it works in Citadel's frame from either Citadel hostname). A browser that blocks it
  gets a page saying so, not a redirect loop. `cc_app` names one app: it isn't a Citadel session, and
  `cc_session` isn't one of it.
- **The proxy never passes or sets a login.** Both cookies are stripped from what the contraption's
  server sees; a `Set-Cookie` from it naming either, or carrying `Domain=`, is dropped.
- **Writes and websockets on an app host need its own Origin.** `cc_app` is `SameSite=None`, so a write
  or upgrade whose `Origin` isn't the host itself gets a 403.
- **Citadel↔contraption talk is postMessage** (`citadel-frame-1`, `FRAME` in `public/rail.js`), checked
  on `e.source`, since neither page can read the other now: the top bar strip, Alt+\`, the phone rail
  handle, and Citadel's layer over a contraption's installed window.
- **Citadel's CSP** adds `frame-src` and `frame-ancestors` for `*.<APPS_DOMAIN>` (`framedWithApps`).

## Consequences

- A contraption's page can't call Citadel's API as the person or read `cc_session`. Proof: a stub
  contraption on its own host in a dev copy (`citadel-dev-copy start --apps-hosts`) sees its person's
  identity header, an empty `document.cookie`, a 404 for `/c/api/me` on its host and a blocked fetch to
  Citadel's. `test/app-hosts.test.ts` and `test/frame-protocol-browser.test.ts` hold it.
- **Same-site, not same-origin.** `<name>.citadel.zip` is same-site with `citadel.zip`, so `cc_session`
  (SameSite=Lax) still rides on requests a contraption's page makes to the apex. What stops them: Citadel's
  API refuses a write whose `Origin` isn't its own host, `/backup/send` checks Origin too, nothing answers
  with CORS headers (so a cross-origin read fails), and the main host's websockets only go to `/apps/`.
  A new main-host route that writes on a GET, or a CORS header, would reopen this.
  A contraption's page can also set a cookie named `cc_session` or `cc_app` for the whole domain
  (`document.cookie`; the proxy only filters its server's `Set-Cookie`). Readers try every cookie of the
  name and keep the first that verifies, so a junk one can't lock someone out; one the contraption's
  author got signed for themselves could still sign the person in as them. Accepted: contraptions are
  written by the members, and the cure (`__Host-` cookies) needs HTTPS everywhere and signs everyone out.
- **Relative links to Citadel or another app keep working.** A page load on an app host of a path that
  isn't its own app (Mandate's `/c/#/p/5/t/12` with `target="_top"`, its `/c/?next=` sign-in, `/apps/toc/`)
  goes to Citadel's host at the apex, which shows it or hands it to that app's host. Someone on
  `cara.apps.webplatformisbestplatform.net` who follows one lands on `citadel.zip`, which shares no
  cookie with it, so they may sign in there once.
- **Open paths still pass on Citadel's host** for non-page requests (websockets and fetches carry no
  login or identity): Peek Auras' PC link dials `wss://<citadel host>/apps/peek-auras/link`. Their
  answers there carry `Content-Security-Policy: sandbox`, so one can't open as a document on Citadel's
  origin (an `<object>` asks with `Accept: */*`, not as a page). An open path's page load goes to the
  app host like any other, for anyone, signed in or not.
- **Signing out of Citadel doesn't sign the apps out.** `cc_app` lives until it expires, as `cc_session`
  does today: neither has server-side revocation. Disabling a person still refuses both at once.
- **A contraption must allow being framed by Citadel.** One that sends `X-Frame-Options: SAMEORIGIN` or
  `frame-ancestors 'self'` showed before because Citadel was its origin; now it shows a blank frame.
  `frame-ancestors https://citadel.zip https://cara.apps.webplatformisbestplatform.net` (or no header)
  is what it needs.
- **Per-origin browser state starts over once.** An installed contraption, its service worker, its
  storage and its push subscription belonged to Citadel's origin. People reinstall from the new host and
  turn push back on once (Mandate users included). The old installed window still opens: its page
  redirects to the app host, shown inside it with the browser's out-of-scope strip.
- **Dragging apps into order happens in Citadel only.** On a contraption's own host the rail draws your
  order but doesn't offer the drag, since the save is Citadel's API.
- **Kit checks that read a frame's document** (the WCO rig's `kit/skills/run-on-windows/scripts/wco/checks/lib.js`
  reads `contentDocument`) can't reach a contraption on its own host; they need `APPS_DOMAIN` unset, or
  the same postMessage route.
- **Needs from outside Citadel:** Caddy passes `Host` (or `X-Forwarded-Host`) and `X-Forwarded-Proto:
  https` for `*.citadel.zip`; `APPS_DOMAIN=citadel.zip` in the service's env file, then a restart.
