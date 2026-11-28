// Citadel's Windows desktop app (#1186): one Electron window, so it is not Chrome. It was first kept off citadel.zip
// because Defender's ClickFix check fires on copies made on a citadel.zip page in Chrome (#1185's report); #1640 moved
// it onto citadel.zip (Cara, 2026-11-22). KNOWN: the check fires in Chrome. UNTESTED: whether it fires in this
// Electron window, so #1640 asks Cara after publishing; if it does, put the old address back in START and ALIASES. Links to other
// sites open in the default browser; files download here, with the usual Save dialog. #1148's launcher installs and
// updates it: it starts this build, and this build says it started by writing the file CITADEL_STARTED_FILE names.
// Settings and the sign-in cookie live in %APPDATA%\Citadel (Electron's userData), never in the read-only build folder.
// Closing the window keeps it in the tray, so notifications (core.js desktopNotify) still come; Quit is the tray's menu.
const { app, BrowserWindow, Menu, Tray, nativeTheme, safeStorage, screen, shell, ipcMain } = require('electron');
const { copyFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { route, launcherOf } = require('./route.cjs');
const { reloadKey, devtoolsKey } = require('./keys.cjs');
const { appFrame } = require('./app-frame.cjs');
const { savedLogin, fromCitadel } = require('./saved-login.cjs');

const START = new URL(process.env.CITADEL_URL || 'https://citadel.zip/c/');
/** Citadel's other addresses: a link to one of these opens here, on START's host, rather than in a browser. */
const ALIASES = ['cara.apps.webplatformisbestplatform.net'];
/** The strip the window controls sit in, as tall as Edge's installed-app title bar so the page's top bar fits it. */
const STRIP = 33;
/** index.html's theme colours for the title bar overlay, used until the page reports its own (preload.cjs). */
const PLAIN = { light: '#f6f5f2', dark: '#161514' };

const ICON = join(__dirname, 'icon.ico');
const AUMID = 'Citadel.Desktop';

// One copy at a time: starting a second (the shortcut again) brings the first one's window forward (second-instance).
// It still says it started, or #1148's launcher would count the build as failed on this PC and never run it again.
const first = app.requestSingleInstanceLock();
if (!first) { started(); app.quit(); }
app.setAppUserModelId(AUMID);
Menu.setApplicationMenu(null);
let win = null;
let tray = null;
let quitting = false;

function overlay(color) {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: color || (dark ? PLAIN.dark : PLAIN.light), symbolColor: dark ? '#e8e6e3' : '#2b2a28', height: STRIP };
}

/** Where the window was (%APPDATA%\Citadel\window.json): its size, place and whether it was maximised. */
const PLACE = () => join(app.getPath('userData'), 'window.json');

/**
 * The window's last size and place, if it still lands on a screen; else most of the main screen (Cara, 2026-11-20:
 * "it was just hard to grab because the window started small").
 */
function placement() {
  try {
    const p = JSON.parse(readFileSync(PLACE(), 'utf8'));
    const a = screen.getDisplayMatching(p).workArea;
    const overlap = Math.min(p.x + p.width, a.x + a.width) - Math.max(p.x, a.x) >= 100 && Math.min(p.y + 40, a.y + a.height) - Math.max(p.y, a.y) >= 20;
    if (p.width >= 360 && p.height >= 400 && overlap) return p;
  } catch {}
  const a = screen.getPrimaryDisplay().workArea;
  const width = Math.round(a.width * 0.9), height = Math.round(a.height * 0.9);
  return { x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width, height };
}

function remember() {
  if (!win || win.isDestroyed()) return;
  try { writeFileSync(PLACE(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
}

function open(url = START.href) {
  const place = placement();
  win = new BrowserWindow({
    x: place.x, y: place.y, width: place.width, height: place.height, minWidth: 360, minHeight: 400,
    title: 'Citadel', icon: ICON, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? PLAIN.dark : PLAIN.light,
    titleBarStyle: 'hidden', titleBarOverlay: overlay(),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: true },
  });
  const wc = win.webContents;
  win.once('ready-to-show', () => { if (place.maximized) win.maximize(); win.show(); });
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
  // No menu means no Ctrl+R / F5 accelerators (#1526): handle the browser's reload keys here, in every window.
  wc.on('before-input-event', (e, input) => {
    if (devtoolsKey(input)) { e.preventDefault(); return wc.toggleDevTools(); }
    const k = reloadKey(input);
    if (!k) return;
    e.preventDefault();
    if (k === 'reload-hard') wc.reloadIgnoringCache(); else wc.reload();
  });
  wc.on('context-menu', (_e, p) => contextMenu(wc, p));
  win.on('close', (e) => { remember(); if (!quitting) { e.preventDefault(); win.hide(); } });
  // Windows logging off or shutting down: no before-quit then, and a close held back would stall it.
  win.on('session-end', () => { remember(); quitting = true; });
  win.on('closed', () => { win = null; });
  win.loadURL(url);
}

/** Tell #1148's launcher this build is up, once its window has a page in it. */
function started() {
  const file = process.env.CITADEL_STARTED_FILE;
  if (file) try { writeFileSync(file, 'started'); } catch {}
}

/**
 * Right-click in a text box (or a Shift+right-click; the page's own menu takes the rest, #1663): the edit actions and, on a link,
 * copying its address; spelling suggestions in a text box. In an app's frame that doesn't show its own menu: Reload this app and
 * Inspect too (#1691).
 */
function contextMenu(wc, p) {
  const items = [];
  for (const s of p.dictionarySuggestions ?? []) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
  if (items.length) items.push({ type: 'separator' });
  if (p.linkURL) items.push({ label: 'Copy link address', click: () => require('electron').clipboard.writeText(p.linkURL) }, { type: 'separator' });
  if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
  else if (p.selectionText) items.push({ role: 'copy' });
  // In an app's frame the menu always shows (#1691): an app without the kit's own menu (rail.js) got none on plain space.
  const app = appFrame(p.frame);
  if (app) {
    if (items.length && items.at(-1).type !== 'separator') items.push({ type: 'separator' });
    items.push({ label: 'Reload this app', click: () => { try { app.reload(); } catch {} } }, { label: 'Inspect', accelerator: 'Ctrl+Shift+I', click: () => wc.inspectElement(p.x, p.y) });
  }
  if (items.length) Menu.buildFromTemplate(items).popup();
}

// The page's own title bar colour (base.js tintTitleBar sets index.html's theme-color metas; preload.cjs watches them).
ipcMain.on('citadel:title-bar', (e, color) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) w.setTitleBarOverlay(overlay(color));
});

function show() {
  if (!win) return open();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** The tray icon: click to show the window, right-click for Quit. */
function makeTray() {
  tray = new Tray(ICON);
  tray.setToolTip('Citadel');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Citadel', click: show }, { type: 'separator' }, { label: 'Quit Citadel', click: () => app.quit() }]));
  tray.on('click', show);
}

/**
 * Start menu and desktop shortcuts to #1148's launcher (two folders up from this build, versions\<n>\), so updates
 * run; with the app's id, which Windows needs to show its notifications. The Start menu one is rewritten on each
 * start (the launcher may have moved); the desktop one is made once, so deleting it sticks. A copy with no launcher
 * (a test build unzipped by hand) writes none (#2274): it took the Start menu's Citadel for itself, and never updates.
 */
function shortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const target = launcherOf(process.execPath, existsSync);
  if (!target) return;
  // The icon is copied out of the build folder (#2274): a taskbar pin is a copy of this shortcut that nothing rewrites, and
  // versions\<n>\ goes away two builds later, taking the pin's logo with it.
  let icon = join(app.getPath('userData'), 'icon.ico');
  try { copyFileSync(ICON, icon); } catch { icon = ICON; }
  const link = { target, cwd: dirname(target), icon, iconIndex: 0, appUserModelId: AUMID, description: 'Citadel' };
  shell.writeShortcutLink(join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Citadel.lnk'), 'replace', link);
  const made = join(app.getPath('userData'), 'desktop-shortcut-made');
  if (!existsSync(made)) {
    shell.writeShortcutLink(join(app.getPath('desktop'), 'Citadel.lnk'), 'create', link);
    try { writeFileSync(made, ''); } catch {}
  }
}

ipcMain.on('citadel:show', show);

// The page's right-click menu (#1665): Point's crop is a screenshot of the part (window CSS pixels), exact inside an app's
// frame too, and Inspect opens DevTools on the element at (x, y).
ipcMain.handle('citadel:capture', async (e, r) => {
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : NaN);
  const rect = { x: n(r?.left), y: n(r?.top), width: n(r?.width), height: n(r?.height) };
  if (!(rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.width <= 8192 && rect.height <= 8192)) return null;
  return (await e.sender.capturePage(rect)).toPNG();
});
ipcMain.on('citadel:inspect', (e, x, y) => {
  if (Number.isFinite(x) && Number.isFinite(y)) e.sender.inspectElement(Math.round(x), Math.round(y));
});
// The sign-in page's saved password (#1754): filled in, never sent by itself; only Citadel's own top page may ask.
const saved = () => savedLogin(app.getPath('userData'), safeStorage);
ipcMain.handle('citadel:login-saved', (e) => (fromCitadel(e.senderFrame, START) ? { canSave: saved().available(), login: saved().get() } : null));
ipcMain.handle('citadel:login-save', (e, login, password) => fromCitadel(e.senderFrame, START) && saved().save(login, password));
ipcMain.handle('citadel:login-forget', (e) => fromCitadel(e.senderFrame, START) && saved().forget());
app.on('second-instance', show);
app.on('before-quit', () => { remember(); quitting = true; });
// The second copy only hands over (second-instance above): it quits before making a window or a tray icon.
if (first) app.whenReady().then(() => { open(); makeTray(); shortcuts(); });
