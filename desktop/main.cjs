// Citadel's Windows desktop app (#1186): one Electron window on Citadel's other address, so copying from it never
// trips Defender's ClickFix check, which fires on any copy made on a citadel.zip page (#1185's report). Links to other
// sites open in the default browser; files download here, with the usual Save dialog. #1148's launcher installs and
// updates it: it starts this build, and this build says it started by writing the file CITADEL_STARTED_FILE names.
// Settings and the sign-in cookie live in %APPDATA%\Citadel (Electron's userData), never in the read-only build folder.
const { app, BrowserWindow, Menu, nativeTheme, shell, ipcMain } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { route } = require('./route.cjs');

const START = new URL(process.env.CITADEL_URL || 'https://cara.apps.webplatformisbestplatform.net/c/');
/** Citadel's other addresses: a link to one of these opens here, on START's host, rather than in a browser. */
const ALIASES = ['citadel.zip'];
/** The strip the window controls sit in, as tall as Edge's installed-app title bar so the page's top bar fits it. */
const STRIP = 33;
/** index.html's theme colours for the title bar overlay, used until the page reports its own (preload.cjs). */
const PLAIN = { light: '#f6f5f2', dark: '#161514' };

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('Citadel.Desktop');
Menu.setApplicationMenu(null);

let win = null;

function overlay(color) {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: color || (dark ? PLAIN.dark : PLAIN.light), symbolColor: dark ? '#e8e6e3' : '#2b2a28', height: STRIP };
}

function open(url = START.href) {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 360, minHeight: 400,
    title: 'Citadel', icon: join(__dirname, 'icon.png'), show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? PLAIN.dark : PLAIN.light,
    titleBarStyle: 'hidden', titleBarOverlay: overlay(),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: true },
  });
  const wc = win.webContents;
  win.once('ready-to-show', () => win.show());
  // The page's CSS and scripts ask `(display-mode: window-controls-overlay)` for the installed web app's title bar
  // layout; Electron answers "browser", so it is told the mode the window really has.
  wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) emulateOverlay(wc, 'start'); });
  wc.on('did-navigate', () => emulateOverlay(wc, 'navigate'));
  wc.once('did-finish-load', started);
  wc.setWindowOpenHandler(({ url }) => {
    const r = route(url, START, ALIASES);
    if (r.kind === 'here') { if (wc.getURL() !== r.url) wc.loadURL(r.url); }
    else if (r.kind === 'browser') shell.openExternal(r.url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => {
    const r = route(e.url, START, ALIASES);
    if (r.kind === 'here' && r.url === e.url) return;
    e.preventDefault();
    if (r.kind === 'here') wc.loadURL(r.url);
    else if (r.kind === 'browser') shell.openExternal(r.url);
  });
  wc.on('context-menu', (_e, p) => contextMenu(wc, p));
  win.on('closed', () => { win = null; });
  win.loadURL(url);
}

function emulateOverlay(wc, when) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'window-controls-overlay' }] })
      .then(() => console.log('emulate ok', when, wc.getURL()), (err) => console.warn('emulate failed', when, err.message));
  } catch (err) { console.warn('emulate attach failed', when, err.message); }
}

/** Tell #1148's launcher this build is up, once its window has a page in it. */
function started() {
  const file = process.env.CITADEL_STARTED_FILE;
  if (file) try { writeFileSync(file, 'started'); } catch {}
}

/** Right-click: the edit actions and, on a link, copying its address; spelling suggestions in a text box. */
function contextMenu(wc, p) {
  const items = [];
  for (const s of p.dictionarySuggestions ?? []) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
  if (items.length) items.push({ type: 'separator' });
  if (p.linkURL) items.push({ label: 'Copy link address', click: () => require('electron').clipboard.writeText(p.linkURL) }, { type: 'separator' });
  if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
  else if (p.selectionText) items.push({ role: 'copy' });
  if (items.length) Menu.buildFromTemplate(items).popup();
}

// The page's own title bar colour (base.js tintTitleBar sets index.html's theme-color metas; preload.cjs watches them).
ipcMain.on('citadel:title-bar', (e, color) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) w.setTitleBarOverlay(overlay(color));
});

app.on('second-instance', () => {
  if (!win) return open();
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.whenReady().then(() => open());
app.on('window-all-closed', () => app.quit());
