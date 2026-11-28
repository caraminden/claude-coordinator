// Where a link the desktop app's window meets goes (#1186), kept apart from Electron so test/desktop-route.test.ts can run it.
//   { kind: 'here', url }     Citadel's: load it in the window, on START's host (a citadel.zip link is moved there)
//   { kind: 'browser', url }  another site's http(s) page, mailto:, or an APP_SCHEMES link: the default browser, mail app or the app registered for it
//   { kind: 'none' }          anything else (javascript:, file:, a bad address): ignored
// Contraptions' own app schemes, handed to Windows to open their app (#1410). A fixed list, never every scheme.
const APP_SCHEMES = new Set(['peek-auras:']);

function route(href, start, aliases = []) {
  let url;
  try { url = new URL(href, start); } catch { return { kind: 'none' }; }
  if (url.protocol === 'mailto:' || APP_SCHEMES.has(url.protocol)) return { kind: 'browser', url: url.href };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'none' };
  if (url.origin === start.origin) return { kind: 'here', url: url.href };
  if (!url.username && !url.password && url.protocol === 'https:' && aliases.includes(url.hostname)) {
    return { kind: 'here', url: new URL(url.pathname + url.search + url.hash, start.origin).href };
  }
  return { kind: 'browser', url: url.href };
}

/**
 * #1148's launcher for the build at `exe` (versions\<n>\Citadel.exe, so two folders up), or null: a copy unzipped by hand
 * has none, and makes no shortcuts to itself (#2274: a test copy in Downloads took the Start menu's Citadel and never updated).
 */
function launcherOf(exe, exists) {
  const { win32 } = require('node:path');
  const launcher = win32.join(win32.dirname(exe), '..', '..', 'citadel.exe');
  return exists(launcher) ? launcher : null;
}

module.exports = { route, launcherOf };
