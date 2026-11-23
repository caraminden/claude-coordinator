// Contraptions inside Citadel's window (#274, Cara 2026-11-02: "Mandate inside Citadel"): #/apps/<name>
// shows the contraption in a frame over Citadel's page, beside the rail. It's inside Citadel's scope, so
// an installed Citadel shows no out-of-scope strip and opens no second window. Each frame stays alive
// once opened, hidden while you're elsewhere, so switching back keeps your place in it; Citadel's page
// stays under it (inert), scroll and all. The framed page's own rail.js draws no rail and lends Citadel's.

import { frameKey } from './appswitch.js';
import { api, h, icon, tintTitleBar } from './base.js';
import { canBack, canForward, goBack, goForward, replaceHash } from './navstack.js';
import { FRAME } from './rail.js';

const frames = new Map();
let box = null;
let probe = null; // the title bar strip's area (style.css), to measure
let nav = null; // Citadel's ‹ › ×, over the frame's end
let strip = null; // an app with no .cui-topbar: its icon and name in the title bar strip, beside ‹ › ×
let drag = null; // the frame's .cui-topbar as the window's drag regions (mirrorBar)
const bars = new WeakMap(); // frame → its page's last bar message (rail.js reportBar): it may be on another origin

/**
 * The top bar (#666, Josh 2026-11-13: "Citadel part, then each app adopts"). An app whose page has a .cui-topbar
 * (Citadel UI) runs up into the title bar strip, told the strip's room through --citadel-strip-*; Citadel's ‹ › ×
 * sit over its end. An app without one stays under the strip, which shows the app's name and ‹ › × instead of
 * Citadel's page beneath. The frame's page tells its bar (rail.js reportBar) as it starts and as the bar changes; this
 * fits it on each message, on each load and as the window changes, and tells the page the strip's room back.
 */
function fit() {
  const frame = [...frames.values()].find((f) => !f.hidden);
  if (!frame || !framed()) return;
  const got = bars.get(frame);
  const bar = got?.bar ?? null;
  document.documentElement.classList.toggle('frame-topbar', !!bar);
  const name = frame.dataset.app;
  const entry = railEntry(name);
  strip.replaceChildren(
    h('img', { src: entry?.querySelector('img')?.src ?? `/apps/_citadel/icon/${name}`, alt: '' }),
    h('b', {}, appTitle(frame)));
  // In the installed app the window controls take the bar's colour (under a modal's backdrop), or the strip's.
  tintTitleBar(bar && got.color, got?.backdrop);
  mirrorBar(got, frame);
  if (!bar) return;
  const area = probe.getBoundingClientRect();
  const left = box.getBoundingClientRect().left;
  const end = nav.getBoundingClientRect();
  const vars = { 'strip-h': area.height, 'strip-start': Math.max(0, area.left - left), 'strip-end': innerWidth - end.left, 'strip-row': end.height, 'safe-top': area.top };
  frame.contentWindow.postMessage({ protocol: FRAME, type: 'strip', vars }, '*');
}

const railEntry = (name) => document.querySelector(`.citadel-rail a[data-app="${CSS.escape(name)}"]`);
/** A frame's app as people know it: its rail label, else its page's title, else its name. */
const appTitle = (frame) => railEntry(frame.dataset.app)?.querySelector('.label')?.textContent || bars.get(frame)?.title || frame.dataset.app;

/** A rectangle from a frame's message, or null if it isn't one. */
const rect = (r) => (r && ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(r[k])) ? r : null);
/**
 * The installed app's window takes its drag regions from this page only, never from a frame (#667): the frame's
 * own app-region did nothing, so a click on its bar's buttons dragged the window, unless Citadel's page beneath
 * had a control at that spot. So the bar is mirrored here: a drag box over it with a no-drag hole over each of its
 * controls (base.css's list). Later regions win, so #frames, after Citadel's page, overrides the page's regions
 * beneath; the box sits before .frame-nav, so ‹ › × stay clickable. While a modal dialog is open over the bar
 * (#772) only the title bar strip above it drags, so the dialog's own head and ✕ take clicks.
 */
function mirrorBar(got, frame) {
  const r = rect(got?.bar);
  drag.hidden = !r;
  if (!r) return drag.replaceChildren();
  const fr = frame.getBoundingClientRect();
  const place = (el, b, x, y) => (Object.assign(el.style, { left: `${x + b.left}px`, top: `${y + b.top}px`, width: `${b.width}px`, height: `${b.height}px` }), el);
  if (got.backdrop !== null) {
    const area = probe.getBoundingClientRect();
    const left = Math.max(area.left, fr.left);
    place(drag, { left, top: area.top, width: Math.max(0, area.right - left), height: area.height }, 0, 0);
    return drag.replaceChildren();
  }
  place(drag, r, fr.left, fr.top);
  const controls = Array.isArray(got.controls) ? got.controls.map(rect).filter(Boolean) : [];
  drag.replaceChildren(...controls.map((c) => place(h('div'), c, -r.left, -r.top)));
}

if (typeof window !== 'undefined') {
  addEventListener('resize', fit);
  navigator.windowControlsOverlay?.addEventListener('geometrychange', fit);
  document.addEventListener('visibilitychange', () => stale.size && catchUp());
  // A frame's page (rail.js): its bar, and Alt+` while it has the keys (appswitch.js). Only from Citadel's own frames.
  addEventListener('message', (e) => {
    const frame = [...frames.values()].find((f) => f.contentWindow === e.source);
    const d = e.data;
    if (!frame || d?.protocol !== FRAME) return;
    if (d.type === 'bar') {
      bars.set(frame, { title: typeof d.title === 'string' ? d.title : '', bar: rect(d.bar), controls: d.controls, color: typeof d.color === 'string' ? d.color : null, backdrop: typeof d.backdrop === 'string' ? d.backdrop : null });
      if (!frame.hidden) fit();
    } else if (d.type === 'held' && stale.has(frame.dataset.app)) frame.dataset.update = 'held';
    else if (d.type === 'reloading' && stale.has(frame.dataset.app)) frame.dataset.update = 'reloading';
    else if (d.type === 'key' && d.event && typeof d.event === 'object') frameKey(d.event);
    else if (d.type === 'blur') frameKey(null);
    else if (d.type === 'leave') leave();
  });
}

/** Citadel's last own view, where the rail's Citadel entry goes (rail.js; its stored copy before the rail is drawn). */
function ownView() {
  const back = document.querySelector('.citadel-rail a[data-app=""]');
  if (back) return new URL(back.href).hash || '#/';
  const key = `citadel-last-view:${new URL('./', import.meta.url).pathname}`; // rail.js viewKey
  try { return sessionStorage.getItem(key) ?? localStorage.getItem(key) ?? '#/'; } catch { return '#/'; }
}

/** Leave the contraption for Citadel's last own view. */
function leave() {
  location.hash = ownView();
}

/**
 * #765 (Cara 2026-11-15: "Sometimes when I open citadel via the PWA link on my phone, it opens to mandate"): a phone
 * brings an installed app back as it was left, and once it has closed it in the background Chrome reloads the address
 * it showed, so Citadel's icon could open on a framed contraption. The tap sends the page no word (Android has no
 * launchQueue), so an installed Citadel on a phone opens on its own last view when it loads on a contraption's address
 * (`away` unset) or comes back after `AWAY` ms or more out of sight; a shorter trip (a photo picker, a quick switch) keeps it.
 */
export const AWAY = 30_000;
export const opensOnCitadel = ({ phoneApp, hash, away }) => phoneApp && /^#\/apps\//.test(hash) && (away === undefined || away >= AWAY);

if (typeof window !== 'undefined') {
  const ua = navigator.userAgent;
  const phoneApp = matchMedia('(display-mode: standalone)').matches
    && (/Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)); // rail.js isAndroid, isIOS
  // Before core.js routes: no frame is made, and Back doesn't lead into it.
  if (opensOnCitadel({ phoneApp, hash: location.hash })) replaceHash(ownView());
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && opensOnCitadel({ phoneApp, hash: location.hash, away: Date.now() - hiddenAt })) replaceHash(ownView());
  });
}

/**
 * No clipboard for a framed page (#1086), said outright: a frame on Citadel's own origin (no APPS_DOMAIN, a dev copy) would
 * otherwise get it by default, as the policy's default is the page's own origin.
 */
const NO_CLIPBOARD = ["clipboard-read 'none'", "clipboard-write 'none'"];

/**
 * What a sandboxed page a minion wrote (an artifact, artifacts.js) gets: fullscreen, and no clipboard, so a Copy button in it
 * copies the old way inside its click (the kit's mockkit.js does) and nothing copies on its own.
 */
export const ARTIFACT_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';
export const ARTIFACT_ALLOW = ['fullscreen *', ...NO_CLIPBOARD].join('; ');

/**
 * What a framed contraption may ask the browser for (#892). With APPS_DOMAIN, /apps/<name>/ on Citadel's host redirects to
 * https://<name>.<domain>/ (#709), so the frame ends on another origin than its src attribute; Chrome gives a bare
 * `allow="microphone"` to the src's origin only, and getUserMedia in the page was refused. `*` delegates to whatever origin
 * the frame is on: it only ever reaches Citadel's own contraption hosts, and the browser still asks the person.
 * No clipboard (#1086): Chrome lets a focused page's navigator.clipboard.writeText run with no click, and a hidden frame
 * stays loaded. Without it a Copy button still copies the old way inside its click (Citadel UI's copyText falls back).
 */
export const FRAME_ALLOW = [...['microphone', 'camera', 'fullscreen'].map((f) => `${f} *`), ...NO_CLIPBOARD].join('; ');

/** A contraption frame's `allow`: clipboard writes only for an app whose citadel-app.json asks for them (clipboardApps, below). */
export const frameAllow = (clipboard) => (clipboard ? FRAME_ALLOW.replace("clipboard-write 'none'", 'clipboard-write *') : FRAME_ALLOW);

// The apps whose citadel-app.json asks for clipboard writes, fetched once when the first frame opens. A frame made before the
// answer starts with none, and one that now gets more reloads with them, since a loaded page keeps the ones it started with.
// Only that once: a later deploy asking for the clipboard reaches its frame at the next reload, not under someone using it.
// Fetched here, not taken from rail.js: rail.js is served to apps, so its exports and events are their contract.
let clipboardApps = new Set();
const appClipboard = (name) => clipboardApps.has(name);
let asked = false;
function askClipboard() {
  if (asked) return;
  asked = true;
  api('api/contraptions/mine').then((mine) => {
    clipboardApps = new Set((mine ?? []).flatMap((c) => (c?.clipboard ? [c.name] : [])));
    for (const [name, frame] of frames) {
      const allow = frameAllow(appClipboard(name));
      if (frame.allow === allow) continue;
      frame.allow = allow;
      frame.src = frame.src;
    }
  }, () => { asked = false; }); // no answer: the next frame asks again
}

/** Show contraption `name` (its frame made on first visit), at address `src` if given: an open frame reloads there. */
export function showFrame(name, src) {
  askClipboard();
  if (!box) {
    box = document.createElement('div');
    box.id = 'frames';
    probe = h('div', { class: 'frame-probe', 'aria-hidden': 'true' });
    strip = h('div', { class: 'frame-strip' });
    // The chat header's ‹ › × (thread.js renderTicketHead): its buttons, icons and history.
    nav = h('span', { class: 'frame-nav' },
      h('button', { type: 'button', class: 'nav-btn nav-back', title: 'Back', 'aria-label': 'Back', disabled: !canBack(), onclick: goBack }, icon('back')),
      h('button', { type: 'button', class: 'nav-btn nav-forward', title: 'Forward', 'aria-label': 'Forward', disabled: !canForward(), onclick: goForward }, icon('forward')),
      h('button', { type: 'button', class: 'close-view', title: 'Close', 'aria-label': 'Close', onclick: leave }, icon('close')));
    drag = h('div', { class: 'frame-drag', 'aria-hidden': 'true', hidden: true });
    box.append(probe, strip, drag, nav);
    document.body.append(box);
  }
  let frame = frames.get(name);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.allow = frameAllow(appClipboard(name));
    frame.src = src ?? `/apps/${name}/`;
    frame.title = name;
    frame.dataset.app = name;
    frame.addEventListener('load', () => {
      // Each load of its page is the version live then: whatever was waiting for a deploy is done.
      stale.delete(name);
      dismissed.delete(name);
      showOffer();
      delete frame.dataset.update;
      fit();
    });
    box.append(frame);
    frames.set(name, frame);
  } else if (src) {
    // A deep link navigates the frame, which takes up its allow as it is now: the app's opt-in may have changed.
    frame.allow = frameAllow(appClipboard(name));
    frame.src = src;
  }
  for (const [n, f] of frames) f.hidden = n !== name;
  setFramed(true);
  fit();
  frame.focus();
}

/** Back to Citadel's own page. */
export const hideFrames = () => setFramed(false);

/** Whether a contraption is showing over Citadel's page. */
export const framed = () => document.documentElement.classList.contains('framed');

/** Signing out: drop every frame, so the next person never sees one. */
export function dropFrames() {
  setFramed(false);
  box?.remove();
  box = probe = nav = strip = drag = offer = null;
  frames.clear();
  stale.clear();
  dismissed.clear();
  clearTimeout(askTimer);
}

/**
 * An app's deploy reaches its open frame (#1690, Cara 2026-11-23, "In Citadel, every app"): a frame keeps the page it loaded,
 * so after a deploy it ran the old code until someone knew to reload it. As Citadel's own front end does (core.js
 * reloadWhenIdle, "Reload out of sight"), a frame catches up out of sight: while another view shows or the window is hidden,
 * its page (rail.js) is asked to reload itself where it is, and says `held` instead while it holds unsent text. A frame on
 * screen, or held, gets a one-click offer; leaving it or hiding the window asks it again. Pages without Citadel's rail.js
 * never answer, so they only get the offer.
 */
export function appDeployed(name) {
  const frame = frames.get(name);
  if (!frame) return;
  stale.add(name);
  dismissed.delete(name);
  frame.dataset.update = 'new';
  catchUp();
}

const stale = new Set(); // apps whose open frame runs an older version than the live one
const dismissed = new Set(); // their offer put away with ✕: they still reload out of sight
const ASK_EVERY = 5000; // a held frame is asked again: its text may have been sent since
let askTimer = null;
let offer = null;
const onScreen = (frame) => !frame.hidden && framed() && !document.hidden;

function catchUp() {
  clearTimeout(askTimer);
  askTimer = null;
  for (const name of stale) {
    const frame = frames.get(name);
    if (frame && !onScreen(frame)) frame.contentWindow?.postMessage({ protocol: FRAME, type: 'deployed', auto: true }, '*');
  }
  if (stale.size) askTimer = setTimeout(catchUp, ASK_EVERY);
  showOffer();
}

/** The offer over the frame on screen, if its app has a newer version and it wasn't put away. */
function showOffer() {
  const frame = [...frames.values()].find((f) => !f.hidden);
  const name = frame?.dataset.app;
  if (!box || !name || !stale.has(name) || dismissed.has(name)) {
    offer?.remove();
    offer = null;
    return;
  }
  if (offer?.dataset.app === name) return;
  offer?.remove();
  offer = h('div', { class: 'cui-notice frame-update', 'data-tone': 'info', 'data-app': name, role: 'status' },
    h('span', {}, `${appTitle(frame)} has a new version`),
    h('button', { type: 'button', class: 'cui-btn cui-small', onclick: () => reloadFrame(frame) }, 'Reload'),
    h('button', { type: 'button', class: 'cui-btn cui-ghost', 'aria-label': 'Later', title: 'Later: it reloads by itself once you leave it', onclick: () => { dismissed.add(name); showOffer(); } }, '✕'));
  box.append(offer);
}

/** Reload: the offer goes at once and the page reloads where it is; one that can't (no rail.js) starts again at its address in Citadel. */
function reloadFrame(frame) {
  const name = frame.dataset.app;
  dismissed.add(name);
  showOffer();
  frame.contentWindow?.postMessage({ protocol: FRAME, type: 'deployed', auto: false }, '*');
  setTimeout(() => {
    if (frames.get(name) === frame && stale.has(name) && frame.dataset.update !== 'reloading') frame.src = frame.src;
  }, 1500);
}

function setFramed(on) {
  document.documentElement.classList.toggle('framed', on);
  // Leaving a contraption gives the window controls back their plain colour.
  if (!on) tintTitleBar(null);
  for (const el of document.querySelectorAll('body > .topbar, body > main')) el.inert = on;
  if (stale.size) catchUp(); // a frame just left catches up out of sight; one just shown gets its offer
}

// The contraptions that take shares from the phone's Share sheet (#375), in order of preference. Only
// Mandate so far, so a share goes straight to it; a second one would want a picker here.
const SHARE_TAKERS = ['mandate'];

/**
 * Where a share goes (#/share?title=&text=&url=, from the manifest's share_target): the first of your
 * contraptions `mine` (GET api/contraptions/mine) that takes shares, at its address with each field
 * passed on as it came, as share_title, share_text and share_url; null when none of yours takes shares.
 */
export function shareTarget(search, mine) {
  const name = SHARE_TAKERS.find((n) => mine?.some?.((c) => c.name === n));
  if (!name) return null;
  const got = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const k of ['title', 'text', 'url']) if (got.has(k)) params.set(`share_${k}`, got.get(k));
  return { name, src: `/apps/${name}/?${params}` };
}
