// Citadel's Windows desktop app (#1186): one Electron window on Citadel's other address, so copying from it never
// trips Defender's ClickFix check, which fires on any copy made on a citadel.zip page (#1185's report). Links to other
// sites open in the default browser; files download here, with the usual Save dialog. #1148's launcher installs and
// updates it: it starts this build, and this build says it started by writing the file CITADEL_STARTED_FILE names.
// Settings and the sign-in cookie live in %APPDATA%\Citadel (Electron's userData), never in the read-only build folder.
// Closing the window keeps it in the tray, so notifications (core.js desktopNotify) still come; Quit is the tray's menu.
const { app, BrowserWindow, Menu, Tray, nativeTheme, screen, shell, ipcMain } = require('electron');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { route } = require('./route.cjs');

const START = new URL(process.env.CITADEL_URL || 'https://cara.apps.webplatformisbestplatform.net/c/');
/** Citadel's other addresses: a link to one of these opens here, on START's host, rather than in a browser. */
const ALIASES = ['citadel.zip'];
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
 * start (the launcher may have moved); the desktop one is made once, so deleting it sticks.
 */
function shortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const launcher = join(dirname(process.execPath), '..', '..', 'citadel.exe');
  const target = existsSync(launcher) ? launcher : process.execPath;
  const link = { target, cwd: dirname(target), icon: ICON, iconIndex: 0, appUserModelId: AUMID, description: 'Citadel' };
  shell.writeShortcutLink(join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Citadel.lnk'), 'replace', link);
  const made = join(app.getPath('userData'), 'desktop-shortcut-made');
  if (!existsSync(made)) {
    shell.writeShortcutLink(join(app.getPath('desktop'), 'Citadel.lnk'), 'create', link);
    try { writeFileSync(made, ''); } catch {}
  }
}

ipcMain.on('citadel:show', show);
app.on('second-instance', show);
app.on('before-quit', () => { remember(); quitting = true; });
// The second copy only hands over (second-instance above): it quits before making a window or a tray icon.
if (first) app.whenReady().then(() => { open(); makeTray(); shortcuts(); });
