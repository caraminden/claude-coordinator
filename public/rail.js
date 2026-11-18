// The app rail (#238): Citadel and the contraptions enabled for you, as icons down the left edge,
// drawn only when you have at least one (Cara, 2026-11-01: "B · An app rail on the left edge", "Only
// shows if you have an app enabled"). Wide screens: a fixed column with the page moved right of it.
// Phones: hidden, and slid out as a list by a swipe right past the left drawer (drawers.js, in Citadel
// and in a contraption that uses it), else a left-edge swipe or its handle in a contraption. A
// contraption can place it instead (mountRail): an icon column where the slot is narrow, a list where
// it's wide; a slot hidden on a phone leaves the switcher to slide out as above.
// Citadel imports this; a contraption's page loads it as /apps/_citadel/rail.js, which draws the rail
// by itself. Every contraption opens inside Citadel's window (#/apps/<name>, frames.js; #274): there a
// contraption's rail.js draws nothing and lends Citadel's rail instead. What a contraption includes and leaves free: kit/skills/contraption-ui/rail-and-drawers.md.
// Standalone on purpose (its own styles, and no imports but the files beside it: appswitch.js, reorder.js and
// Citadel UI's ui/), since contraptions load it from outside Citadel's pages.

import { dragReorder, inOrder, moved } from './reorder.js';
import { optimistic } from './ui/optimistic.js';

const NARROW = '(max-width: 800px)'; // drawers.js's breakpoint
const EDGE = 44; // px from the left edge a contraption's swipe has to start in, as in drawers.js
const inContraption = import.meta.url.includes('/apps/_citadel/');
// Citadel's own root: "/c/" live, "/preview/N/c/" in a preview; from a contraption, the host's /c/ (src/http.ts ownPath),
// or with contraptions on their own hosts (src/apps.ts), Citadel's address as /apps/_citadel/api/mine gives it.
let root = new URL(inContraption ? '../../c/' : './', import.meta.url);

/**
 * Citadel and a contraption's page may be on different origins (src/apps.ts, APPS_DOMAIN), so they talk only by
 * postMessage, each checking the other window is the one it framed or was framed by. Contraption → Citadel: hello
 * { installed }, rail { open }, bar (its .cui-topbar, frames.js), key and blur (Alt+`, appswitch.js). Citadel →
 * contraption: state { hasRail, narrow }, strip { vars }. A contraption's installed window → Citadel's page in its
 * layer: layer { app }, go { app }; and back: layer-close. Nothing secret goes in one, so the target is '*'.
 */
export const FRAME = 'citadel-frame-1';
const isMessage = (e, from) => !!from && e.source === from && e.data?.protocol === FRAME && typeof e.data.type === 'string';
const post = (win, type, data = {}) => win?.postMessage({ protocol: FRAME, type, ...data }, '*');
const framedIn = typeof window === 'object' && window.parent !== window ? window.parent : null;

// Inside Citadel's frame (frames.js): Citadel's rail is the rail, and this page's switcher opens it. Its state comes from Citadel.
let hostState = { hasRail: false };
const host = inContraption && framedIn ? {
  openRail: () => post(framedIn, 'rail', { open: true }),
  closeRail: () => post(framedIn, 'rail', { open: false }),
  hasRail: () => hostState.hasRail,
} : null;
/** The contraption showing: this page's own, or in Citadel the one framed (null in Citadel's own views). */
const showing = () => (inContraption ? location.pathname.match(/\/apps\/([^/]+)\//) : location.hash.match(/^#\/apps\/([^/]+)$/))?.[1] ?? null;

/**
 * Whether this page runs inside an app's own native shell (a Capacitor WebView loading the contraption by `server.url`):
 * a single-app window, where the switcher rail, its swipe handle and Alt+` have nothing to switch to. Needs nothing from
 * the app: Capacitor injects `window.Capacitor` even for a remote page (`isNativePlatform()` true, `getPlatform()` 'android'
 * or 'ios'), and a shell of another make can add "CitadelApp" to its user agent (capacitor.config `appendUserAgent`).
 */
export function inNativeApp(win = typeof window === 'object' ? window : null) {
  if (!win) return false;
  const cap = win.Capacitor;
  try {
    if (typeof cap?.isNativePlatform === 'function' ? cap.isNativePlatform() : cap?.getPlatform?.() && cap.getPlatform() !== 'web') return true;
  } catch {}
  return /\bCitadelApp\b/.test(win.navigator?.userAgent ?? '');
}

/**
 * The rail's entries for the contraptions `mine` (GET /api/contraptions/mine), with `current` the
 * contraption showing (null: Citadel's own views): Citadel first, then each contraption, which opens in
 * Citadel's window (#/apps/<name>): in the page from Citadel itself, through Citadel's root from a
 * contraption's own page. None at all when nothing is enabled. One that isn't up (its service is down,
 * or its keys don't open) is a greyed tile, so the page fetches nothing from it; the rail asks again every
 * 15 s until it's back (recheckSoon).
 */
export function railItems(mine, current, citadel = '/', inCitadel = false) {
  if (!mine?.length) return [];
  const items = mine.map((c) => {
    const down = c.up === false;
    // Through Citadel UI's own route (src/apps.ts kit), so a page never loads another contraption's host.
    const icon = !c.icon || down ? null : /^https?:/.test(c.icon) ? c.icon : `/apps/_citadel/icon/${c.name}`;
    return { name: c.name, title: c.title, href: `${inCitadel ? '' : citadel}#/apps/${c.name}`, icon, current: c.name === current, down };
  });
  return [{ name: null, title: 'Citadel', href: citadel, icon: `${citadel}icon.svg`, current: !items.some((i) => i.current) }, ...items];
}

/**
 * Whether an entry opens apart from this page, from `installed`: a contraption's own installed app, whose
 * every other entry is Citadel's. It opens in Citadel's layer over the page, in the same window (#311,
 * Josh 2026-11-04: "Same window, as Citadel"). A link would leave the app's scope: Chrome's strip with a
 * close X, a Custom Tab on Android, or a second window (#274's new-window handoff).
 * Findings: shared/project/reports/app-switching-across-apps-2026-11-04.md.
 */
export const opensApart = (item, installed) => installed && !item.current;

let nav = null;
let backdrop = null;
let handle = null;
let shown = 0; // bumped by each show and hide, so a fetch that finishes after signing out draws nothing
let opener = null; // where focus was before the switcher opened
let slot = null; // the contraption's own container for it (mountRail), else it is fixed to the left edge
let edgeTaken = false; // drawers.js has a left drawer, so the left edge is its (leaveEdge)
// Framed, it's Citadel's window that is narrow or not (the frame is the rail's width narrower), as Citadel's state says.
const narrow = host ? Object.assign(new EventTarget(), { matches: false }) : typeof matchMedia === 'function' ? matchMedia(NARROW) : null;
const installed = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches;
// Citadel's page in a contraption's layer (below): the contraption under it, whose entry puts the layer away (its layer message).
const inLayer = !inContraption && !!framedIn;
let layerApp;

let layer = null; // a contraption's installed window: Citadel's page over it, kept once opened (#311)
let layerOpener = null;

/** In a contraption's installed window: show Citadel's page over this one at `item`, in the same window. */
function openLayer(item) {
  closeRail();
  // Citadel's entry goes back to Citadel's last own view, as its own rail's does: Citadel's page knows which (go).
  const go = (f) => { post(f.contentWindow, 'layer', { app: showing() }); post(f.contentWindow, 'go', { app: item.name }); };
  const frame = layer?.firstChild;
  if (!frame) {
    layer = document.createElement('div');
    layer.className = 'citadel-layer';
    const f = document.createElement('iframe');
    f.title = 'Citadel';
    f.src = item.href;
    f.addEventListener('load', () => go(f));
    layer.append(f);
    document.documentElement.append(layer); // beside <body>, which goes inert under it
  } else {
    go(frame);
    layer.hidden = false;
  }
  if (!document.body.inert) layerOpener = document.activeElement;
  document.body.inert = true;
  layer.firstChild.focus();
}

/** Back to the contraption's own page. */
function closeLayer() {
  if (!layer || layer.hidden) return;
  layer.hidden = true;
  document.body.inert = false;
  if (layerOpener?.isConnected) layerOpener.focus({ preventScroll: true });
  else layer.firstChild.blur();
  layerOpener = null;
}

/** Whether the rail is showing (so the phone's swipe past the left panel has somewhere to go). */
export const hasRail = () => (host ? host.hasRail() && narrow.matches : !!nav);

/** Citadel: tell its contraption frames whether its rail is there to lend, and whether its window is narrow. */
const frameWindows = () => [...document.querySelectorAll('#frames iframe')].map((f) => f.contentWindow);
function tellFrames(to = frameWindows()) {
  if (inContraption) return;
  for (const w of to) post(w, 'state', { hasRail: !!nav, narrow: !!narrow?.matches });
}

/** drawers.js: a swipe from the left edge pulls out its left drawer, and only past that the switcher (false: not any more). */
export function leaveEdge(taken = true) {
  edgeTaken = taken;
  handle?.remove();
  handle = null;
  if ((nav || host) && !slot) addHandle();
}

/** A contraption's slim tab on the left edge that opens the switcher, unless drawers.js has that edge. */
function addHandle() {
  if (!inContraption || edgeTaken) return;
  handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'citadel-rail-handle';
  handle.title = 'Apps';
  handle.setAttribute('aria-label', 'Open apps');
  handle.hidden = !!host && !narrow?.matches;
  handle.addEventListener('click', openRail);
  document.body.append(handle);
}

/** Phones: slide the rail out as the app switcher, over whatever is open. */
export function openRail() {
  if (host) return host.openRail();
  if (!nav || !narrow?.matches) return;
  if (nav.classList.contains('placed')) {
    // A slot showing on a phone is the contraption's own switcher page; a hidden one lends the switcher out.
    if (slot.getClientRects().length) return;
    nav.classList.remove('placed');
    backdrop ??= makeBackdrop();
    document.body.append(backdrop, nav);
    nav.getBoundingClientRect(); // lay it out shut first, so it slides in
  }
  if (!nav.classList.contains('open')) opener = document.activeElement;
  nav.classList.add('open');
  backdrop.hidden = false;
  (nav.querySelector('a.current') ?? nav.querySelector('a'))?.focus({ preventScroll: true });
}

export function closeRail() {
  if (host) return host.closeRail();
  if (!nav?.classList.contains('open')) return;
  nav.classList.remove('open');
  backdrop.hidden = true;
  if (nav.contains(document.activeElement)) opener?.isConnected ? opener.focus({ preventScroll: true }) : document.activeElement.blur();
  opener = null;
}

/**
 * A contraption places the rail itself, in `el`: its left edge on wide screens (56px wide), its
 * leftmost swipe page on a phone. Resolves to whether there is a rail (false: nothing enabled, drop the page).
 */
export function mountRail(el) {
  if (host) return showRail(); // false: drop the slot, Citadel's rail is beside the frame
  slot = el;
  el.style.containerType = 'inline-size'; // the rail lays itself out by the slot's width
  return showRail();
}

/**
 * How the rail's Install button installs the app showing (#297; Josh, 2026-11-05: "Citadel's kit, every
 * app"), or null to hide it. `own`: on the app's own page (else Citadel's, the app framed, where the
 * browser only sees Citadel). `standalone`: this page is an installed app's. `prompt`: the browser handed
 * over beforeinstallprompt. `installed`: this browser has installed the app before.
 *   prompt: the browser's own install dialog.
 *   intent: Android: open the app's page in Chrome proper (an installed app's links open in a Custom Tab, whose menu has no Install).
 *   tab:    open the app's page in a new tab, whose own button then installs it.
 *   ios:    iOS has no prompt: say Share, then Add to Home Screen.
 */
export function installMode({ own, standalone, prompt, installed, android, ios }) {
  if (installed || (own && standalone)) return null;
  if (own) return prompt ? 'prompt' : ios ? 'ios' : android ? 'intent' : null; // a desktop browser with no prompt can't
  return standalone && android ? 'intent' : 'tab';
}

/** An Android link that opens `url` in Chrome itself, or as a plain link where Chrome isn't there. */
export const chromeIntent = (url) =>
  `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=${url.protocol.slice(0, -1)};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url.href)};end`;

const INSTALL_TIPS = {
  prompt: (t) => `Install ${t} as its own app`,
  intent: (t) => `Open ${t} in Chrome, where you can install it as its own app`,
  tab: (t) => `Open ${t} on its own page, where your browser offers to install it as its own app`,
  ios: (t) => `How to add ${t} to your Home Screen`,
};
const ua = typeof navigator === 'object' ? navigator.userAgent : '';
const isAndroid = /Android/i.test(ua);
const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
let installPrompt = null; // beforeinstallprompt, kept for the button: a contraption's own page only
// Shared by Citadel and every app on the origin, so Citadel's rail knows an app's page saw itself installed.
const installedKey = (name) => `citadel-installed:${name}`;
const knownInstalled = (name) => { try { return localStorage.getItem(installedKey(name)) === '1'; } catch { return false; } };
const markInstalled = (name, on) => { try { if (on) localStorage.setItem(installedKey(name), '1'); else localStorage.removeItem(installedKey(name)); } catch {} };
// Framed in Citadel, a contraption's page shares what its own window saw (hello), since its storage is its origin's.
if (typeof window === 'object' && host) post(framedIn, 'hello', { installed: knownInstalled(showing()) });
if (typeof window === 'object' && inContraption && !host) {
  const me = showing();
  if (me && installed) markInstalled(me, true);
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // the rail's button offers it instead of Chrome's banner; Chrome's menu still has Install
    installPrompt = e;
    if (me) markInstalled(me, false); // offered, so not installed (any more)
    syncInstall();
  });
  addEventListener('appinstalled', () => {
    installPrompt = null;
    if (me) markInstalled(me, true);
    syncInstall();
  });
}
// Citadel's rail: an app installed from the tab its button opened hides the button here too.
if (typeof window === 'object' && !inContraption) addEventListener('storage', (e) => { if (e.key?.startsWith('citadel-installed:')) syncInstall(); });

function installButton() {
  const b = document.createElement('button');
  Object.assign(b, { type: 'button', className: 'install', hidden: true });
  // A down arrow into a tray, drawn here since this file brings no icons.
  b.innerHTML = '<span class="glyph"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></span><span class="label"></span>';
  b.addEventListener('click', async () => {
    closeRail();
    const name = showing();
    const url = new URL(`/apps/${name}/`, location.href);
    const mode = b.dataset.mode;
    if (mode === 'prompt' && installPrompt) {
      const p = installPrompt;
      installPrompt = null; // one use each
      syncInstall();
      try {
        await p.prompt();
        if ((await p.userChoice).outcome === 'accepted') markInstalled(name, true);
      } catch {}
      syncInstall();
    } else if (mode === 'intent') location.href = chromeIntent(url);
    else if (mode === 'tab') open(shortUrls.get(name) ?? url, '_blank', 'noopener'); // a person sees the app's own host when there is one (#827)
    else if (mode === 'ios') showHint(`To add ${b.dataset.title} to your Home Screen: in Safari, tap Share, then Add to Home Screen.`);
  });
  return b;
}

/** Show or hide the Install button for the app showing, and say what it will do. */
function syncInstall() {
  const b = nav?.querySelector('button.install');
  if (!b) return;
  const name = showing();
  const title = name && nav.querySelector(`a[data-app="${CSS.escape(name)}"] .label`)?.textContent;
  const mode = title ? installMode({ own: inContraption, standalone: installed, prompt: !!installPrompt, installed: knownInstalled(name), android: isAndroid, ios: isIOS }) : null;
  b.hidden = !mode;
  b.dataset.mode = mode ?? '';
  if (!mode) return;
  b.dataset.title = title;
  b.title = INSTALL_TIPS[mode](title);
  b.querySelector('.label').textContent = `Install ${title}`;
}

let hint = null;
/** A short note by the rail's foot, gone at the next tap or after 10 s. */
function showHint(text) {
  hint?.remove();
  hint = document.createElement('div');
  hint.className = 'citadel-rail-hint';
  hint.setAttribute('role', 'status');
  hint.textContent = text;
  document.body.append(hint);
  const gone = () => { hint?.remove(); hint = null; removeEventListener('pointerdown', gone, true); };
  setTimeout(() => addEventListener('pointerdown', gone, true), 0);
  setTimeout(gone, 10_000);
}

// Citadel's own view before a frame, where its entry goes back to (#675, Cara 2026-11-14: "If I switch from a contraption
// back to citadel can we maintain the state of which minion I was looking at?"). Kept in the tab's sessionStorage, so a
// reload on a frame (a deploy's front-end reload) still goes back there, and in localStorage for a phone app the system
// restarted or a contraption's own window; #/ (the start scheme) only when neither holds one.
const viewKey = `citadel-last-view:${root.pathname}`;
const storedView = () => { try { return sessionStorage.getItem(viewKey) ?? localStorage.getItem(viewKey); } catch { return null; } };
let lastView = (!inContraption && storedView()) || '#/';

/** In Citadel: mark the view showing (Citadel or a framed contraption), and point Citadel's entry back at its last own view. */
function syncRail() {
  if (inContraption || !nav) return;
  const now = showing();
  // Not a share's address (#/share?…), which only passes through on its way to a frame.
  if (!now && !location.hash.startsWith('#/share') && lastView !== (lastView = location.hash || '#/')) { // never a bare root: that link would reload Citadel, frames and all
    try { sessionStorage.setItem(viewKey, lastView); localStorage.setItem(viewKey, lastView); } catch {}
  }
  for (const a of nav.querySelectorAll('a[data-app]')) {
    const here = (a.dataset.app || null) === now;
    a.classList.toggle('current', here);
    if (here) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  nav.querySelector('a').href = root.pathname + lastView;
  syncInstall();
}

/** Take the rail away (signing out). */
export function hideRail() {
  shown++;
  // Citadel signing out: the next person starts afresh. Not a framed contraption's rail, which hides itself as it loads.
  if (!inContraption) {
    lastView = '#/';
    try { sessionStorage.removeItem(viewKey); localStorage.removeItem(viewKey); } catch {}
  }
  clearRail();
}

function clearRail() {
  clearTimeout(recheck);
  recheck = 0;
  for (const el of [nav, backdrop, handle]) el?.remove();
  nav = backdrop = handle = null;
  document.documentElement.classList.remove('has-citadel-rail');
  tellFrames();
}

function makeBackdrop() {
  const el = document.createElement('div');
  el.className = 'citadel-rail-backdrop';
  el.hidden = true;
  el.addEventListener('click', closeRail);
  return el;
}

const RECHECK_MS = 15_000;
const ICON_TRIES = 8; // about two minutes: a restart, not an icon that's gone
let recheck = 0; // a timer while an app is greyed out, so it comes back once it's up (#311)
let drawn = ''; // the entries drawn (but which is current, syncRail's), to redraw only when a recheck finds them changed
const entries = (items) => JSON.stringify(items.map(({ current, ...i }) => i));
let person = null; // a contraption's page: who is signed in, for Alt+` (appswitch.js)
// Citadel's own answers (drag to reorder) only where Citadel is this page's origin: a contraption's own host can't reach them.
const atCitadel = () => root.origin === location.origin;

/** Each app's own address, https://<name>.<domain>/, from `mine` when Citadel serves apps on their own hosts (APPS_DOMAIN, #827). */
const shortUrls = new Map();

/**
 * The rail's entries, or null when Citadel didn't answer (no answer, or a 5xx from it or its proxy while it restarts).
 * A contraption's page asks its own host (src/apps.ts kit), which also says who is signed in and where Citadel is.
 */
const fetchItems = async () => {
  try {
    const res = await fetch(inContraption ? '/apps/_citadel/api/mine' : new URL('api/contraptions/mine', root), { headers: { Accept: 'application/json' } });
    if (res.status >= 500) return null;
    // An unread body keeps the request open (a proxy's 401 that never ends): let go of it, so the page can go network-idle.
    if (!res.ok) res.body?.cancel().catch(() => {});
    let mine = res.ok ? await res.json() : [];
    if (inContraption) {
      person = mine?.name ?? null;
      if (mine?.citadel) root = new URL(mine.citadel);
      mine = mine?.apps ?? [];
    }
    shortUrls.clear();
    for (const c of mine ?? []) if (c?.url) shortUrls.set(c.name, c.url);
    // A drop still saving: the rail keeps it, though this answer may predate it.
    return railItems(dragged ? inOrder(mine, (c) => c.name, dragged) : mine, showing(), atCitadel() ? root.pathname : root.href, !inContraption);
  } catch {
    return null;
  }
};

/** Ask again soon; an open switcher, a hidden page or no answer (Citadel restarting) waits for the next round. */
function recheckSoon() {
  if (recheck) return;
  recheck = setTimeout(async () => {
    recheck = 0;
    if (!nav) return;
    if (nav.classList.contains('open') || document.hidden) return recheckSoon();
    const mark = shown;
    const items = await fetchItems();
    if (mark !== shown || !nav) return;
    if (!items || nav.classList.contains('open') || entries(items) === drawn) return recheckSoon();
    drawRail(items);
  }, RECHECK_MS);
}

/** An icon that failed (its app restarting): its letter for now, the icon back in place once it loads. */
function retryIcon(pic, tile, tries = 1) {
  setTimeout(() => {
    if (!tile.isConnected) return;
    const again = Object.assign(new Image(), { alt: '' });
    again.onload = () => tile.isConnected && tile.replaceWith(again);
    again.onerror = () => tries < ICON_TRIES && retryIcon(pic, tile, tries + 1);
    again.src = pic.src;
  }, RECHECK_MS);
}

/** Fetch your contraptions and draw the rail, or take it away when there are none. */
export async function showRail() {
  if (inNativeApp()) { hideRail(); return false; } // an app's own shell: no rail, handle or Alt+` switcher
  if (host) {
    // Framed in Citadel: no rail of its own, just the phone's way to Citadel's switcher.
    hideRail();
    addStyles();
    addHandle();
    return false;
  }
  const mark = ++shown;
  const items = await fetchItems();
  if (mark !== shown) return false;
  if (!items) {
    // Citadel restarting: keep the rail drawn and ask again, or with none drawn yet, try the whole show again.
    if (nav) recheckSoon();
    else setTimeout(() => mark === shown && showRail(), RECHECK_MS);
    return !!nav;
  }
  return drawRail(items);
}

let switching = false;
/** A contraption's own page: Alt+` switches apps here too (appswitch.js, served beside this file). */
function startSwitch() {
  if (switching || !inContraption || host || !person) return;
  switching = true;
  import('./appswitch.js').then((m) => m.initAppSwitch(person), () => (switching = false));
}

function drawRail(items) {
  clearRail();
  if (!items.length) return false;
  startSwitch();
  drawn = entries(items);
  if (items.some((i) => i.down)) recheckSoon();
  addStyles();
  nav = document.createElement('nav');
  nav.className = slot ? 'citadel-rail placed' : 'citadel-rail';
  nav.setAttribute('aria-label', 'Apps');
  items.forEach((item, i) => {
    if (i === 1) nav.append(document.createElement('hr'));
    const a = document.createElement('a');
    a.href = item.href;
    a.dataset.app = item.name ?? '';
    a.title = item.down ? `${item.title} (unavailable)` : item.title;
    if (item.current) { a.className = 'current'; a.setAttribute('aria-current', 'page'); }
    if (item.down) a.classList.add('down');
    const tile = document.createElement('span');
    tile.className = 'tile';
    tile.textContent = item.title.slice(0, 1).toUpperCase();
    let pic = tile;
    if (item.icon) {
      pic = document.createElement('img');
      pic.src = item.icon;
      pic.alt = '';
      pic.addEventListener('error', () => {
        pic.replaceWith(tile);
        retryIcon(pic, tile);
      }, { once: true });
    }
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.title;
    a.append(pic, label);
    // Already here: just put the switcher away.
    a.addEventListener('click', (e) => {
      if (a.classList.contains('current')) e.preventDefault();
      closeRail();
      if (e.defaultPrevented) return;
      if (inLayer && layerApp !== undefined && (a.dataset.app || null) === layerApp) {
        e.preventDefault();
        post(framedIn, 'layer-close');
      } else if (inContraption && opensApart(item, installed)) {
        e.preventDefault();
        openLayer(item);
      }
    });
    nav.append(a);
  });
  nav.append(installButton());
  // Press and hold an app (or drag it with a mouse) to move it; Citadel stays first (#649).
  if (atCitadel()) dragReorder(nav, { items: appLinks, onDrop: reorderApps });
  syncRail();
  syncInstall();
  if (slot) {
    slot.append(nav);
    return true;
  }
  backdrop = makeBackdrop();
  document.body.append(backdrop, nav);
  document.documentElement.classList.add('has-citadel-rail');
  addHandle();
  tellFrames();
  return true;
}

const appLinks = () => [...nav.querySelectorAll('a[data-app]:not([data-app=""])')];
let dragged = null; // the app names of a drop not yet saved
let drops = 0; // counts drops: each saves the whole list, so an older one's Retry has nothing to add

/** Move an app from `from` to `to`: on the rail at once, saved behind; a failed save puts it back. */
function reorderApps(from, to) {
  const keys = moved(appLinks().map((a) => a.dataset.app), from, to);
  const drop = ++drops;
  let before = null; // the order just before this drop showed, to put back if its save fails
  let stale = false; // a Retry once a newer drop has been made: that one's order stands, so this does nothing
  const show = (order) => {
    if (!nav) return;
    const end = nav.querySelector('button.install');
    for (const a of inOrder(appLinks(), (a) => a.dataset.app, order)) nav.insertBefore(a, end);
    drawn = entries(inOrder(JSON.parse(drawn), (i) => i.name ?? '', ['', ...order]));
  };
  optimistic({
    sets: 'order:apps',
    apply: () => {
      stale = drop !== drops;
      if (stale || !nav) return;
      before = appLinks().map((a) => a.dataset.app);
      show(dragged = keys);
    },
    send: async () => {
      if (stale) return;
      const res = await fetch(new URL('api/me/order/apps', root), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
    },
    undo: () => {
      if (!before) return;
      dragged = null;
      show(before);
    },
    label: 'save the order of your apps',
  }).then(() => dragged === keys && (dragged = null), () => {});
}

// Closing: Escape, a swipe back left across it, or a new view in Citadel.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !nav?.classList.contains('open')) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // just the switcher: a drawer under it stays
    closeRail();
  }, true);
  let swipe = null;
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const open = nav?.classList.contains('open');
    // Open: a drag on it or its backdrop. Shut, in a contraption without drawers.js or a slot: one from the left edge.
    swipe = (nav || host) && !nav?.classList.contains('placed') && narrow.matches && e.touches.length === 1
      && (open ? nav.contains(e.target) || e.target === backdrop : inContraption && !slot && !edgeTaken && t.clientX <= EDGE)
      ? { x: t.clientX, y: t.clientY, open } : null;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!swipe) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipe.x;
    const sideways = Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(t.clientY - swipe.y) * 1.2;
    if (sideways && swipe.open && dx < 0) closeRail();
    if (sideways && !swipe.open && dx > 0) openRail();
    swipe = null;
  });
  addEventListener('hashchange', () => {
    closeRail();
    syncRail();
  });
  addEventListener('message', (e) => {
    const d = e.data;
    if (!inContraption) {
      // Citadel: a framed contraption's rail.js lends Citadel's rail through these.
      const frame = [...document.querySelectorAll('#frames iframe')].find((f) => f.contentWindow === e.source);
      if (isMessage(e, frame?.contentWindow)) {
        const name = frame.dataset.app;
        if (d.type === 'hello') {
          if (name && typeof d.installed === 'boolean' && d.installed !== knownInstalled(name)) { markInstalled(name, d.installed); syncInstall(); }
          tellFrames([e.source]);
        } else if (d.type === 'rail') d.open ? openRail() : closeRail();
      } else if (inLayer && isMessage(e, framedIn)) {
        // Citadel's page in a contraption's installed window: which contraption is under it, and where to go.
        const app = d.app === null || (typeof d.app === 'string' && /^[a-z0-9-]+$/.test(d.app)) ? d.app : undefined;
        if (app === undefined) return;
        if (d.type === 'layer') layerApp = app;
        else if (d.type === 'go') location.hash = app ? `#/apps/${app}` : lastView;
      }
    } else if (host && isMessage(e, framedIn) && d.type === 'state') {
      // A framed contraption: Citadel's rail and window, as Citadel says.
      hostState = { hasRail: !!d.hasRail };
      if (narrow.matches !== !!d.narrow) {
        narrow.matches = !!d.narrow;
        narrow.dispatchEvent(new Event('change'));
      }
      reportBar();
    } else if (host && isMessage(e, framedIn) && d.type === 'strip') {
      // The title bar strip's room, for a page whose .cui-topbar runs up into it (frames.js fit).
      for (const k of STRIP_VARS) if (Number.isFinite(d.vars?.[k])) document.documentElement.style.setProperty(`--citadel-${k}`, `${d.vars[k]}px`);
    } else if (!host && layer && isMessage(e, layer.firstChild?.contentWindow) && d.type === 'layer-close') closeLayer();
  });
  narrow?.addEventListener('change', () => {
    tellFrames();
    if (host && handle) handle.hidden = !narrow.matches;
    closeRail();
    // Lent out from its slot on a phone: back into the slot on a wide screen.
    if (!narrow.matches && slot && nav && nav.parentElement !== slot) {
      nav.classList.add('placed');
      slot.append(nav);
    }
  });
}

const STRIP_VARS = ['strip-h', 'strip-start', 'strip-end', 'strip-row', 'safe-top'];
// What counts as a control on the bar (base.css's no-drag list): the window's drag regions leave holes over these.
const CONTROLS = 'a, button, input, select, textarea, summary, label, [tabindex]';
let watchedBar;
let barQueued = false;

/**
 * A framed contraption: tell Citadel about this page's .cui-topbar (frames.js fit): where it and its controls are, its
 * colour and the page's title, again whenever it changes, so Citadel can fit it to the title bar strip.
 * shortcut: a bar drawn after the page's load without a resize counts from the next resize or Citadel state; observe the body if one does.
 */
function reportBar() {
  const bar = document.querySelector('.cui-topbar');
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
  // A modal dialog over the bar (#772): its backdrop's colour, so Citadel stops dragging by the bar and tints the strip under it.
  const modal = document.querySelector(':modal');
  post(framedIn, 'bar', {
    title: document.title,
    bar: bar ? box(bar) : null,
    controls: bar ? [...bar.querySelectorAll(CONTROLS)].filter((el) => el.getClientRects().length).map(box) : [],
    color: bar ? getComputedStyle(bar).backgroundColor : null,
    backdrop: modal ? getComputedStyle(modal, '::backdrop').backgroundColor : null,
  });
  if (watchedBar === undefined) {
    // From the first report, with or without a bar: a page may add its bar as it narrows (ToC's phone header).
    document.addEventListener('scroll', reportSoon, { capture: true, passive: true });
    addEventListener('resize', reportSoon);
    document.fonts?.ready.then(reportSoon);
    // A dialog opening or closing (showModal and close set and clear its open attribute).
    new MutationObserver(reportSoon).observe(document.documentElement, { subtree: true, attributeFilter: ['open'] });
  }
  if (bar === watchedBar) return;
  watchedBar = bar;
  if (!bar) return;
  new MutationObserver(reportSoon).observe(bar, { subtree: true, childList: true, attributes: true, characterData: true });
  new ResizeObserver(reportSoon).observe(bar);
}

function reportSoon() {
  if (barQueued) return;
  barQueued = true;
  requestAnimationFrame(() => { barQueued = false; reportBar(); });
}

/** A framed contraption: Alt+` and the keys that follow while Alt is held are Citadel's switcher's (appswitch.js), so they go to it. */
function forwardKeys() {
  let switching = false;
  const on = (e) => {
    if (!switching && !(e.type === 'keydown' && e.code === 'Backquote' && e.altKey && !e.ctrlKey && !e.metaKey)) return;
    if (!switching && document.querySelector('dialog:modal')) return;
    switching = !(e.type === 'keyup' && !e.altKey);
    e.preventDefault();
    e.stopPropagation();
    const { type, code, key, altKey, shiftKey, ctrlKey, metaKey, isComposing } = e;
    post(framedIn, 'key', { event: { type, code, key, altKey, shiftKey, ctrlKey, metaKey, isComposing } });
  };
  addEventListener('keydown', on, true);
  addEventListener('keyup', on, true);
  addEventListener('blur', () => { switching = false; post(framedIn, 'blur'); });
}

/** The switcher as a list (a phone, or a wide slot), for the rail matched by `r`. */
const list = (r) => `
  ${r} { align-items: stretch; gap: 6px;
    padding: calc(14px + var(--top-inset, env(safe-area-inset-top, 0px))) 12px calc(14px + env(safe-area-inset-bottom, 0px)) calc(12px + env(safe-area-inset-left, 0px)); }
  ${r} :is(a, button.install) { width: auto; height: auto; padding: 10px; gap: 12px; justify-content: flex-start; border-radius: 10px; }
  ${r} a.current { box-shadow: none; background: #3b3631; font-weight: 600; }
  ${r} :is(img, .tile, .glyph) { width: 36px; height: 36px; opacity: 1; }
  ${r} .label { position: static; width: auto; height: auto; clip-path: none; overflow: hidden; text-overflow: ellipsis; }
  ${r} hr { width: auto; margin: 4px 10px; }`;

// A constructed sheet, since Citadel's Content-Security-Policy (and maybe a contraption's) refuses inline <style>.
let sheet = null;
function addStyles() {
  if (sheet) return;
  sheet = new CSSStyleSheet();
  sheet.replaceSync(`
html.has-citadel-rail { --citadel-rail: calc(56px + env(safe-area-inset-left, 0px)); padding-left: var(--citadel-rail); }
.citadel-rail { position: fixed; top: 0; bottom: 0; left: 0; z-index: 50; box-sizing: border-box; width: var(--citadel-rail);
  display: flex; flex-direction: column; align-items: center; gap: 10px; overflow-y: auto; margin: 0;
  padding: calc(10px + var(--top-inset, env(safe-area-inset-top, 0px))) 0 calc(10px + env(safe-area-inset-bottom, 0px)) env(safe-area-inset-left, 0px);
  background: #2a2622; color: #f4efe9; font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { .citadel-rail { background: #0f0e0d; border-right: 1px solid #34322e; } }
.citadel-rail :is(a, button.install) { flex: none; box-sizing: border-box; width: 42px; height: 42px; padding: 4px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center; color: inherit; text-decoration: none; -webkit-tap-highlight-color: transparent; }
.citadel-rail a.current { box-shadow: inset 0 0 0 2px #fff; }
.citadel-rail :is(a, button.install):focus-visible { outline: 2px solid #fb923c; outline-offset: 1px; }
.citadel-rail img, .citadel-rail .tile { flex: none; width: 34px; height: 34px; border-radius: 9px; opacity: 0.65; }
.citadel-rail .tile { display: flex; align-items: center; justify-content: center; background: #5a534c; font-weight: 650; }
.citadel-rail a:is(.current, :hover, :focus-visible) :is(img, .tile) { opacity: 1; }
.citadel-rail a.down .tile { opacity: 0.35; }
.citadel-rail a.reorder-dragging { background: #3a3530; }
.citadel-rail a.reorder-dragging :is(img, .tile) { opacity: 1; }
.citadel-rail .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.citadel-rail :is(a, button)[hidden] { display: none; }
.citadel-rail button.install { margin-top: auto; border: 0; background: none; font: inherit; text-align: start; cursor: pointer; }
.citadel-rail .glyph { flex: none; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; opacity: 0.65; }
.citadel-rail button.install:is(:hover, :focus-visible) .glyph { opacity: 1; }
.citadel-rail hr { flex: none; width: 26px; border: 0; border-top: 1px solid #5a534c; margin: 2px 0; }
.citadel-rail-backdrop, .citadel-rail-handle { display: none; }
.citadel-rail-hint { position: fixed; z-index: 60; left: calc(var(--citadel-rail, 0px) + 12px); bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  box-sizing: border-box; max-width: min(340px, calc(100vw - 24px)); padding: 10px 14px; border-radius: 10px;
  background: #2a2622; color: #f4efe9; box-shadow: 0 4px 18px rgb(0 0 0 / 0.3); font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
@media ${NARROW} { .citadel-rail-hint { left: 12px; } }
.citadel-layer { position: fixed; inset: 0; z-index: 2147483000; background: Canvas; }
.citadel-layer[hidden] { display: none; }
.citadel-layer iframe { display: block; width: 100%; height: 100%; border: 0; }
.citadel-rail-handle[hidden] { display: none !important; }
/* Placed in a contraption's slot: it fills the slot, and the slot's width picks column or list below. */
.citadel-rail.placed { position: static; width: auto; min-height: 100%; height: 100%; z-index: auto; visibility: visible; transform: none; box-shadow: none; transition: none; }
@container (min-width: 120px) { ${list('.citadel-rail.placed')} }
@media ${NARROW} {
  html.has-citadel-rail { padding-left: 0; }
  .citadel-rail:not(.placed) { width: min(86vw, 340px); visibility: hidden; transform: translateX(-100%);
    box-shadow: 0 0 24px rgb(0 0 0 / 0.3); transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1), visibility 0.25s; overscroll-behavior: contain; }
  .citadel-rail.open { visibility: visible; transform: none; }
  ${list('.citadel-rail:not(.placed)')}
  .citadel-rail-backdrop:not([hidden]) { display: block; position: fixed; inset: 0; z-index: 49; background: rgb(0 0 0 / 0.4); touch-action: none; }
  .citadel-rail-handle { display: block; position: fixed; top: 50%; left: env(safe-area-inset-left, 0px); z-index: 48; width: 1.1rem; height: 4rem; margin-top: -2rem;
    padding: 0; border: 0; background: none; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .citadel-rail-handle::before { content: ''; position: absolute; top: 0.6rem; bottom: 0.6rem; left: 3px; width: 4px; border-radius: 999px; background: #8a847c; opacity: 0.6; }
}
@media (prefers-reduced-motion: reduce) { .citadel-rail { transition: none; } }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

// A framed contraption reports its bar and passes Alt+` on from the start.
if (typeof document !== 'undefined' && host) {
  reportBar();
  forwardKeys();
  // Leaving the page: the next one may have no bar (or no rail.js to say so).
  addEventListener('pagehide', () => post(framedIn, 'bar', { title: '', bar: null, controls: [], color: null }));
}

// Last, so the styles above are defined when a framed page draws its handle straight away.
// <html data-citadel-rail="slot">: the contraption calls mountRail itself.
if (typeof document !== 'undefined' && inContraption && document.documentElement.dataset.citadelRail !== 'slot') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showRail);
  else showRail();
}
