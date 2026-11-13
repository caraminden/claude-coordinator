// Contraptions inside Citadel's window (#274, Cara 2026-11-02: "Mandate inside Citadel"): #/apps/<name>
// shows the contraption in a frame over Citadel's page, beside the rail. It's inside Citadel's scope, so
// an installed Citadel shows no out-of-scope strip and opens no second window. Each frame stays alive
// once opened, hidden while you're elsewhere, so switching back keeps your place in it; Citadel's page
// stays under it (inert), scroll and all. The framed page's own rail.js draws no rail and lends Citadel's.

import { h, icon, tintTitleBar } from './base.js';
import { canBack, canForward, goBack, goForward } from './navstack.js';

const frames = new Map();
let box = null;
let probe = null; // the title bar strip's area (style.css), to measure
let nav = null; // Citadel's ‹ › ×, over the frame's end
let strip = null; // an app with no .cui-topbar: its icon and name in the title bar strip, beside ‹ › ×

/**
 * The top bar (#666, Josh 2026-11-13: "Citadel part, then each app adopts"). An app whose page has a .cui-topbar
 * (Citadel UI) runs up into the title bar strip, told the strip's room through --citadel-strip-*; Citadel's ‹ › ×
 * sit over its end. An app without one stays under the strip, which shows the app's name and ‹ › × instead of
 * Citadel's page beneath. Called by the frame's own rail.js as it starts, on each load, and as the window changes.
 */
function fit() {
  const frame = [...frames.values()].find((f) => !f.hidden);
  if (!frame || !framed()) return;
  let doc = null;
  try { doc = frame.contentDocument; } catch {}
  // shortcut: a bar the app draws after its load event counts from the next resize or visit; observe the page if one does.
  const bar = doc?.querySelector('.cui-topbar') ?? null;
  document.documentElement.classList.toggle('frame-topbar', !!bar);
  const name = frame.dataset.app;
  const entry = document.querySelector(`.citadel-rail a[data-app="${CSS.escape(name)}"]`);
  strip.replaceChildren(
    h('img', { src: entry?.querySelector('img')?.src ?? `/apps/${name}/icon.svg`, alt: '' }),
    h('b', {}, entry?.querySelector('.label')?.textContent || doc?.title || name));
  // In the installed app the window controls take the bar's colour, or the strip's.
  tintTitleBar(bar);
  if (!bar) return;
  const area = probe.getBoundingClientRect();
  const left = box.getBoundingClientRect().left;
  const end = nav.getBoundingClientRect();
  const vars = { h: area.height, start: Math.max(0, area.left - left), end: innerWidth - end.left, row: end.height };
  for (const [k, v] of Object.entries(vars)) doc.documentElement.style.setProperty(`--citadel-strip-${k}`, `${v}px`);
}
if (typeof window !== 'undefined') {
  window.citadelFrameFit = fit;
  addEventListener('resize', fit);
  navigator.windowControlsOverlay?.addEventListener('geometrychange', fit);
}

/** Leave the contraption for Citadel's last own view, where the rail's Citadel entry goes (rail.js). */
function leave() {
  const back = document.querySelector('.citadel-rail a[data-app=""]');
  location.hash = (back && new URL(back.href).hash) || '#/';
}

/** Show contraption `name` (its frame made on first visit), at address `src` if given: an open frame reloads there. */
export function showFrame(name, src) {
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
    box.append(probe, strip, nav);
    document.body.append(box);
  }
  let frame = frames.get(name);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.src = src ?? `/apps/${name}/`;
    frame.title = name;
    frame.dataset.app = name;
    frame.addEventListener('load', fit);
    box.append(frame);
    frames.set(name, frame);
  } else if (src) frame.src = src;
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
  box = probe = nav = strip = null;
  frames.clear();
}

function setFramed(on) {
  document.documentElement.classList.toggle('framed', on);
  for (const el of document.querySelectorAll('body > .topbar, body > main')) el.inert = on;
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
