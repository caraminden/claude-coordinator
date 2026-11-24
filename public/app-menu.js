// Citadel's right-click menu inside an app (#1665; Cara picked take B on #1661, 2026-11-22: "B · Citadel's own menu").
// rail.js mounts it on every app page that loads /apps/_citadel/rail.js: right-click (or Shift+F10 / the Menu key) gets
// Citadel UI's menu (ui/menu.js) with Point at this and Point and draw… (inside Citadel's frame, where a chat is to point
// into), then the app's own items for what was clicked, added with citadel.menu.add() and shown under "From <app>", then
// Copy. In the desktop app it ends with Reload and Inspect. Text boxes and Shift+right-click keep the browser's own; on a phone a long press opens it as a
// sheet on an app's own items and links only (#1670), and plain text keeps the phone's selection. Point and Inspect go up to Citadel's page (pick.js), which owns the chat box and the desktop app's
// screenshot and DevTools. Served to apps beside rail.js, so it imports only the files beside it.
import { mountMenus } from './ui/menu.js';
import { copyText } from './ui/markdown.js';
import { toast } from './ui/status.js';
import { PICKABLE, cropBox, cropPart, describePart } from './pick-crop.js';

const added = []; // { selector, items, kind, name }, in the order added

/** The app's own items (rail.d.ts `menu`), also on `window.citadel.menu` for a page that doesn't import. */
export const menu = {
  add(selector, items, { kind, name } = {}) {
    if (typeof selector !== 'string' || typeof items !== 'function') throw new TypeError('citadel.menu.add(selector, items): a CSS selector and a function returning the items');
    const entry = { selector, items, kind, name };
    added.push(entry);
    return () => {
      const i = added.indexOf(entry);
      if (i >= 0) added.splice(i, 1);
    };
  },
};

const shorten = (t, n = 60) => {
  const s = String(t ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const copy = (text, what) => copyText(text).then((ok) => toast(ok ? `${what} copied` : `Could not copy the ${what.toLowerCase()}`));

/** The added entry whose match is nearest to `t` (a later one wins a tie), with the element it matched. */
function ownMatch(t) {
  let best = null;
  for (const a of added) {
    let el = null;
    try {
      el = t.closest(a.selector);
    } catch {} // a bad selector matches nothing
    if (el && (!best || best.el === el || best.el.contains(el))) best = { a, el };
  }
  return best;
}

/**
 * The menu for `target` in an app, as ui/menu.js's spec; null leaves the browser's own. `ctx`: { framed, title(),
 * desktop(), post(type, data) }, from rail.js: whether Citadel frames the page, the app's name, whether that's the
 * desktop app, and a message up to Citadel's page.
 */
export function appMenuFor(target, e, ctx) {
  if (target.closest('.citadel-rail, .citadel-layer')) return null;
  const title = ctx.title();
  const desktop = ctx.desktop();
  const foot = desktop || matchMedia('(pointer: coarse)').matches ? undefined : "Shift+right-click: the browser's own menu";
  const point = (el, label = 'Point at this') => (ctx.framed ? [{ label, icon: '📍', point: true, run: () => pointAt(el, ctx) }, { label: 'Point and draw…', icon: '✎', point: true, run: () => pointAt(el, ctx, true) }, '-'] : []);
  const [x, y] = e?.clientX || e?.clientY ? [e.clientX, e.clientY] : centre(target);
  const inspect = { label: 'Inspect', icon: '⌕', keys: 'Ctrl+Shift+I', run: () => ctx.post('inspect', { x, y }) };
  const reload = { label: `Reload ${title}`, icon: '↻', keys: 'Ctrl+R', run: () => location.reload() };
  // This menu cancels the desktop app's own, which offers Reload this app in every app (#1691), so each desktop menu keeps one.
  const tail = desktop ? ['-', reload, inspect] : [];
  const hue = document.querySelector('meta[name=theme-color]:not([media])')?.content;
  const appTone = hue ? { hue } : { tone: 'violet' };

  const sel = getSelection();
  const picked = sel && !sel.isCollapsed && sel.containsNode(target, true) ? sel.toString() : '';
  if (picked.trim()) {
    return { kind: 'Selected text', tone: 'info', name: `“${shorten(picked, 40)}”`, foot, items: [{ label: 'Copy', icon: '⧉', keys: 'Ctrl+C', run: () => copy(picked, 'Text') }, ...tail] };
  }
  const own = ownMatch(target);
  if (own) {
    const items = (own.a.items(own.el, e) ?? []).map((it) => (it && it !== '-' ? { ...it, from: title } : it));
    const text = own.el.innerText?.trim();
    return { kind: own.a.kind ?? `${title} item`, ...appTone, name: shorten(own.a.name?.(own.el) ?? text, 50), foot, items: [...point(own.el), ...items, text && '-', text && { label: 'Copy text', icon: '⧉', run: () => copy(text, 'Text') }, ...tail] };
  }
  const link = target.closest('a[href]');
  if (link) {
    return {
      kind: 'Link',
      tone: 'info',
      name: shorten(link.textContent) || link.href,
      foot,
      items: [
        ...point(link),
        { label: 'Open', icon: '→', run: () => link.click() },
        // The desktop app sends a new tab to the browser or back into its one window itself (desktop/main.cjs).
        !desktop && { label: 'Open in a new tab', icon: '↗', run: () => window.open(link.href, '_blank', 'noopener') },
        { label: 'Copy link address', icon: '🔗', run: () => copy(link.href, 'Link') },
        ...tail,
      ],
    };
  }
  const page = [{ label: `Copy link to ${title}`, icon: '🔗', run: () => copy(location.href, 'Link') }, reload];
  const end = desktop ? ['-', inspect] : [];
  const part = target.closest(PICKABLE);
  if (part && part !== document.body) return { kind: 'Part', tone: 'neutral', name: describePart(part, title, '').label.split(' · ')[0], foot, items: [...point(part), ...page, ...end] };
  return { kind: title, ...appTone, name: document.title && document.title !== title ? document.title : undefined, foot, items: [...point(document.body, 'Point at this page'), ...page, ...end] };
}

const centre = (el) => {
  const r = el.getBoundingClientRect();
  return [Math.max(0, r.left) + Math.min(r.width / 2, 24), Math.max(0, r.top) + Math.min(r.height / 2, 14)];
};

/**
 * Point at `el` from inside Citadel's frame: its note, with this page's crop of it, or in the desktop app its place in
 * the frame, which Citadel's page screenshots (exact, where the copied crop can miss a picture or a canvas).
 */
async function pointAt(el, ctx, draw = false) {
  const note = describePart(el, ctx.title(), `${location.pathname}${location.search}${location.hash}`);
  if (ctx.desktop()) return ctx.post('point', { note, draw, rect: cropBox(el) });
  ctx.post('point', { note, draw, crop: await cropPart(el) });
}

/**
 * A phone's long press (#1670) opens the sheet only on what an app added with menu.add() and on links, so plain text
 * keeps the phone's own selection; a selection in progress keeps it too.
 */
export function pressable(t) {
  const sel = getSelection();
  if (sel && !sel.isCollapsed && sel.containsNode(t, true)) return false;
  return !!(ownMatch(t) || t.closest('a[href]'));
}

/** Wire the page's right-click and a phone's long press to the app menu; rail.js calls it once on an app's page. */
export function mountAppMenu(ctx) {
  globalThis.citadel = Object.assign(globalThis.citadel ?? {}, { menu });
  // iPhone's own link preview would cover the sheet. A constructed sheet, which a strict CSP allows (as rail.js does).
  const noCallout = new CSSStyleSheet();
  noCallout.replaceSync('a[href] { -webkit-touch-callout: none; }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, noCallout];
  const off = mountMenus({ menuFor: (t, e) => appMenuFor(t, e, ctx), longPress: (t) => pressable(t) });
  return () => {
    off();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== noCallout);
  };
}
