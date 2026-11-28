// Browser-style reload keys for the desktop app's windows (#1526), kept apart from Electron so test/desktop-keys.test.ts
// can run it. The window has no menu (main.cjs), so Electron's own Ctrl+R / F5 accelerators are gone: the window asks here.
//   Ctrl+R, F5                 -> 'reload'
//   Ctrl+Shift+R, Ctrl+F5      -> 'reload-hard' (ignoring the cache)
//   Ctrl+Shift+I, F12          -> devtoolsKey: DevTools (#1665, the right-click menu's Inspect names the key; F12: #2274)
// `input` is the object Electron's before-input-event gives; anything else is null.
function reloadKey(input) {
  if (!input || input.type !== 'keyDown' || input.alt || input.meta) return null;
  const key = String(input.key || '').toLowerCase();
  if (key === 'r' && input.control) return input.shift ? 'reload-hard' : 'reload';
  if (key === 'f5' && !input.shift) return input.control ? 'reload-hard' : 'reload';
  return null;
}

/** Ctrl+Shift+I or a bare F12: the browser's keys for DevTools. */
function devtoolsKey(input) {
  if (!input || input.type !== 'keyDown' || input.alt || input.meta) return false;
  const key = String(input.key || '').toLowerCase();
  if (key === 'f12') return !input.control && !input.shift;
  return key === 'i' && !!input.control && !!input.shift;
}
module.exports = { reloadKey, devtoolsKey };
