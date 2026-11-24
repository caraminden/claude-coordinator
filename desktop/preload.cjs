// The desktop app's page side (#1186): tells Citadel's page it runs in the app (no Download app button, notifications
// down the live stream, a way to bring the window forward), and gives it the installed web app's title bar layout.
const { contextBridge, ipcRenderer } = require('electron');

// capture and inspect serve the right-click menu (#1665, pick.js): Point's screenshot crop and Inspect.
contextBridge.exposeInMainWorld('citadelDesktop', {
  app: 'electron',
  show: () => ipcRenderer.send('citadel:show'),
  capture: (rect) => ipcRenderer.invoke('citadel:capture', rect),
  inspect: (x, y) => ipcRenderer.send('citadel:inspect', x, y),
  // The sign-in page's saved password (#1754, main.cjs): { canSave, login: { login, password } | null }, save, forget.
  savedLogin: () => ipcRenderer.invoke('citadel:login-saved'),
  saveLogin: (login, password) => ipcRenderer.invoke('citadel:login-save', login, password),
  forgetLogin: () => ipcRenderer.invoke('citadel:login-forget'),
});

// The window's controls sit over the page (main.cjs titleBarOverlay) and Chromium reports their strip
// (navigator.windowControlsOverlay, env(titlebar-area-*)), but answers `display-mode` with "browser", and the page asks
// `(display-mode: window-controls-overlay)` for its title bar layout and drag strips. So that one question is answered
// yes: in the page's matchMedia (before its scripts run) and in its stylesheets' @media rules and theme-color metas.
const WCO = '\\(\\s*display-mode\\s*:\\s*window-controls-overlay\\s*\\)';
const YES = '(min-width: 0px)';
const has = (query) => new RegExp(WCO, 'i').test(query);
const wco = (query) => String(query).replace(new RegExp(WCO, 'gi'), YES);

contextBridge.executeInMainWorld({
  func: (pattern, yes) => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query) => real(String(query).replace(new RegExp(pattern, 'gi'), yes));
  },
  args: [WCO, YES],
});

/** Turn on the page's WCO rules in a stylesheet, nested rules and @imports included; another site's sheet is skipped. */
function rewrite(sheet) {
  let rules;
  try { rules = sheet.cssRules; } catch { return; }
  for (const rule of rules) {
    if (rule.media && has(rule.media.mediaText)) rule.media.mediaText = wco(rule.media.mediaText);
    if (rule.styleSheet) rewrite(rule.styleSheet);
    else if (rule.cssRules) rewrite(rule);
  }
}

function sweep() {
  for (const sheet of document.styleSheets) rewrite(sheet);
  for (const meta of document.querySelectorAll('meta[name=theme-color][media]')) if (has(meta.media)) meta.media = wco(meta.media);
}

/** Pass the title bar colour the page picks (index.html's theme-color metas, base.js tintTitleBar) to the window controls. */
function watchTitleBar() {
  let last = null;
  const send = () => {
    const meta = [...document.querySelectorAll('meta[name=theme-color]')].find((m) => !m.media || matchMedia(wco(m.media)).matches);
    if (meta && meta.content !== last) ipcRenderer.send('citadel:title-bar', (last = meta.content));
  };
  new MutationObserver(send).observe(document.head, { subtree: true, attributes: true, attributeFilter: ['content', 'media'], childList: true });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', send);
  send();
}

addEventListener('DOMContentLoaded', () => {
  sweep();
  // A stylesheet still loading, or added later, is swept once it loads.
  document.addEventListener('load', (e) => { if (e.target instanceof HTMLLinkElement) sweep(); }, true);
  new MutationObserver(sweep).observe(document.head, { childList: true });
  watchTitleBar();
});
