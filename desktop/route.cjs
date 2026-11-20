// Where a link the desktop app's window meets goes (#1186), kept apart from Electron so test/desktop-route.test.ts can run it.
//   { kind: 'here', url }     Citadel's: load it in the window, on START's host (a citadel.zip link is moved there)
//   { kind: 'browser', url }  another site's http(s) page, or mailto:: the default browser or mail app
//   { kind: 'none' }          anything else (javascript:, file:, a bad address): ignored
function route(href, start, aliases = []) {
  let url;
  try { url = new URL(href, start); } catch { return { kind: 'none' }; }
  if (url.protocol === 'mailto:') return { kind: 'browser', url: url.href };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'none' };
  if (url.origin === start.origin) return { kind: 'here', url: url.href };
  if (!url.username && !url.password && url.protocol === 'https:' && aliases.includes(url.hostname)) {
    return { kind: 'here', url: new URL(url.pathname + url.search + url.hash, start.origin).href };
  }
  return { kind: 'browser', url: url.href };
}

module.exports = { route };
