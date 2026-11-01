// The app rail (#238): Citadel and the contraptions enabled for you, as icons down the left edge,
// drawn only when you have at least one (Cara, 2026-11-01: "B · An app rail on the left edge", "Only
// shows if you have an app enabled"). Wide screens: a fixed column with the page moved right of it.
// Phones: hidden, and slid out as a list by a swipe right past the left panel (drawers.js in Citadel;
// a left-edge swipe or its handle in a contraption).
// Citadel imports this; a contraption's page loads it as /apps/_citadel/rail.js, which draws the rail
// by itself. What a contraption includes and leaves free: shared/project/specs/contraptions/app-rail.md.
// Standalone on purpose (no imports, its own styles), since contraptions load it from outside Citadel's pages.

const NARROW = '(max-width: 800px)'; // drawers.js's breakpoint
const EDGE = 44; // px from the left edge a contraption's swipe has to start in, as in drawers.js
const inContraption = import.meta.url.includes('/apps/_citadel/');
// Citadel's own root: "/" live, "/preview/N/" in a preview; from a contraption, the host's root.
const root = new URL(inContraption ? '../../' : './', import.meta.url);

/**
 * The rail's entries for the contraptions `mine` (GET /api/contraptions/mine) seen from the page at
 * `here` (a path): Citadel first, then each contraption. None at all when nothing is enabled.
 */
export function railItems(mine, here, citadel = '/') {
  if (!mine?.length) return [];
  const items = mine.map((c) => {
    const base = `/apps/${c.name}/`;
    const icon = !c.icon ? null : /^(\/apps\/|https?:)/.test(c.icon) ? c.icon : base + c.icon.replace(/^\//, '');
    return { name: c.name, title: c.title, href: base, icon, current: here.startsWith(base) };
  });
  const inCitadel = !items.some((i) => i.current);
  return [{ name: null, title: 'Citadel', href: citadel, icon: `${citadel}icon.svg`, current: inCitadel }, ...items];
}

let nav = null;
let backdrop = null;
let handle = null;
let shown = 0; // bumped by each show and hide, so a fetch that finishes after signing out draws nothing
let opener = null; // where focus was before the switcher opened
const narrow = typeof matchMedia === 'function' ? matchMedia(NARROW) : null;

/** Whether the rail is showing (so the phone's swipe past the left panel has somewhere to go). */
export const hasRail = () => !!nav;

/** Phones: slide the rail out as the app switcher, over whatever is open. */
export function openRail() {
  if (!nav || !narrow?.matches) return;
  if (!nav.classList.contains('open')) opener = document.activeElement;
  nav.classList.add('open');
  backdrop.hidden = false;
  (nav.querySelector('a.current') ?? nav.querySelector('a'))?.focus({ preventScroll: true });
}

export function closeRail() {
  if (!nav?.classList.contains('open')) return;
  nav.classList.remove('open');
  backdrop.hidden = true;
  if (nav.contains(document.activeElement)) opener?.isConnected ? opener.focus({ preventScroll: true }) : document.activeElement.blur();
  opener = null;
}

/** Take the rail away (signing out). */
export function hideRail() {
  shown++;
  for (const el of [nav, backdrop, handle]) el?.remove();
  nav = backdrop = handle = null;
  document.documentElement.classList.remove('has-citadel-rail');
}

/** Fetch your contraptions and draw the rail, or take it away when there are none. */
export async function showRail() {
  const mark = ++shown;
  let mine = [];
  try {
    const res = await fetch(new URL('api/contraptions/mine', root), { headers: { Accept: 'application/json' } });
    if (res.ok) mine = await res.json();
  } catch {}
  if (mark !== shown) return;
  const items = railItems(mine, location.pathname, root.pathname);
  hideRail();
  if (!items.length) return;
  addStyles();
  nav = document.createElement('nav');
  nav.className = 'citadel-rail';
  nav.setAttribute('aria-label', 'Apps');
  items.forEach((item, i) => {
    if (i === 1) nav.append(document.createElement('hr'));
    const a = document.createElement('a');
    a.href = item.href;
    a.title = item.title;
    if (item.current) { a.className = 'current'; a.setAttribute('aria-current', 'page'); }
    let pic;
    if (item.icon) {
      pic = document.createElement('img');
      pic.src = item.icon;
      pic.alt = '';
    } else {
      pic = document.createElement('span');
      pic.className = 'tile';
      pic.textContent = item.title.slice(0, 1).toUpperCase();
    }
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.title;
    a.append(pic, label);
    // Already here: just put the switcher away.
    a.addEventListener('click', (e) => {
      if (item.current) e.preventDefault();
      closeRail();
    });
    nav.append(a);
  });
  backdrop = document.createElement('div');
  backdrop.className = 'citadel-rail-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('click', closeRail);
  document.body.append(backdrop, nav);
  document.documentElement.classList.add('has-citadel-rail');
  if (inContraption) {
    handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'citadel-rail-handle';
    handle.title = 'Apps';
    handle.setAttribute('aria-label', 'Open apps');
    handle.addEventListener('click', openRail);
    document.body.append(handle);
  }
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
    // Open: a drag on it or its backdrop. Shut, in a contraption only: one from the left edge (Citadel's drawers.js does its own).
    swipe = nav && narrow.matches && e.touches.length === 1 && (open ? nav.contains(e.target) || e.target === backdrop : inContraption && t.clientX <= EDGE)
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
  addEventListener('hashchange', closeRail);
  narrow?.addEventListener('change', closeRail);
  if (inContraption) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showRail);
    else showRail();
  }
}

// A constructed sheet, since Citadel's Content-Security-Policy (and maybe a contraption's) refuses inline <style>.
let sheet = null;
function addStyles() {
  if (sheet) return;
  sheet = new CSSStyleSheet();
  sheet.replaceSync(`
html.has-citadel-rail { --citadel-rail: calc(56px + env(safe-area-inset-left, 0px)); padding-left: var(--citadel-rail); }
.citadel-rail { position: fixed; top: 0; bottom: 0; left: 0; z-index: 50; box-sizing: border-box; width: var(--citadel-rail);
  display: flex; flex-direction: column; align-items: center; gap: 10px; overflow-y: auto; margin: 0;
  padding: calc(10px + env(safe-area-inset-top, 0px)) 0 calc(10px + env(safe-area-inset-bottom, 0px)) env(safe-area-inset-left, 0px);
  background: #2a2622; color: #f4efe9; font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { .citadel-rail { background: #0f0e0d; border-right: 1px solid #34322e; } }
.citadel-rail a { flex: none; box-sizing: border-box; width: 42px; height: 42px; padding: 4px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center; color: inherit; text-decoration: none; -webkit-tap-highlight-color: transparent; }
.citadel-rail a.current { box-shadow: inset 0 0 0 2px #fff; }
.citadel-rail a:focus-visible { outline: 2px solid #fb923c; outline-offset: 1px; }
.citadel-rail img, .citadel-rail .tile { flex: none; width: 34px; height: 34px; border-radius: 9px; opacity: 0.65; }
.citadel-rail .tile { display: flex; align-items: center; justify-content: center; background: #5a534c; font-weight: 650; }
.citadel-rail a:is(.current, :hover, :focus-visible) :is(img, .tile) { opacity: 1; }
.citadel-rail .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.citadel-rail hr { flex: none; width: 26px; border: 0; border-top: 1px solid #5a534c; margin: 2px 0; }
.citadel-rail-backdrop, .citadel-rail-handle { display: none; }
@media ${NARROW} {
  html.has-citadel-rail { padding-left: 0; }
  .citadel-rail { width: min(86vw, 340px); align-items: stretch; gap: 6px; visibility: hidden; transform: translateX(-100%);
    padding: calc(14px + env(safe-area-inset-top, 0px)) 12px calc(14px + env(safe-area-inset-bottom, 0px)) calc(12px + env(safe-area-inset-left, 0px));
    box-shadow: 0 0 24px rgb(0 0 0 / 0.3); transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1), visibility 0.25s; overscroll-behavior: contain; }
  .citadel-rail.open { visibility: visible; transform: none; }
  .citadel-rail a { width: auto; height: auto; padding: 10px; gap: 12px; justify-content: flex-start; border-radius: 10px; }
  .citadel-rail a.current { box-shadow: none; background: #3b3631; font-weight: 600; }
  .citadel-rail img, .citadel-rail .tile { width: 36px; height: 36px; opacity: 1; }
  .citadel-rail .label { position: static; width: auto; height: auto; clip-path: none; overflow: hidden; text-overflow: ellipsis; }
  .citadel-rail hr { width: auto; margin: 4px 10px; }
  .citadel-rail-backdrop:not([hidden]) { display: block; position: fixed; inset: 0; z-index: 49; background: rgb(0 0 0 / 0.4); touch-action: none; }
  .citadel-rail-handle { display: block; position: fixed; top: 50%; left: env(safe-area-inset-left, 0px); z-index: 48; width: 1.1rem; height: 4rem; margin-top: -2rem;
    padding: 0; border: 0; background: none; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .citadel-rail-handle::before { content: ''; position: absolute; top: 0.6rem; bottom: 0.6rem; left: 3px; width: 4px; border-radius: 999px; background: #8a847c; opacity: 0.6; }
}
@media (prefers-reduced-motion: reduce) { .citadel-rail { transition: none; } }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
