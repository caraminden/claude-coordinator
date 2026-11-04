// Alt+` switches between Citadel and your contraptions, like Alt-Tab (#292, Cara 2026-11-03: "ok lets
// do alt + `", after first picking plain Tab and then remembering Tab in text boxes). Hold Alt: each
// tap of ` moves on through the apps, most recently used first, and Shift+` moves back; releasing Alt
// switches to the one highlighted, Esc cancels, a click on a tile switches at once. One quick Alt+`
// flips to the app you were last in. The apps are the rail's (rail.js), so with no contraption enabled
// there is no rail and Alt+` does nothing. Caught in Citadel's window and inside every contraption's
// frame (frames.js; same origin), so it works wherever you are in Citadel. A contraption's own page (its
// installed window or a tab) gets it from the kit's rail.js too (#311, Josh 2026-11-04: "Yes, everywhere").
// Tab is left alone.

/** ` by where it sits on the keyboard, so every layout gets the key left of 1. */
export const KEY = 'Backquote';
const MAX_RECENT = 30;

/**
 * The apps in switching order: `current` first, then the rest most recently used first (`recent`,
 * newest first), then any never used, in the rail's order (`names`). '' is Citadel.
 */
export function appOrder(recent, names, current) {
  const ok = new Set(names);
  return [...new Set([current, ...recent, ...names])].filter((n) => ok.has(n));
}

/** `recent` with `name` moved to the front. */
export const remember = (recent, name) => [name, ...recent.filter((n) => n !== name)].slice(0, MAX_RECENT);

/**
 * What one key event does to the switcher. `state` is null (shut) or { order, index }; `order` is the
 * list it would open on. Returns the next state, what happened (open, move, commit with `to`, cancel,
 * or null) and whether the event is the switcher's (so the page never sees it).
 */
export function switchKey(state, e, order) {
  const down = e.type === 'keydown';
  if (!state) {
    // Not Ctrl or Meta: AltGr is Ctrl+Alt on Windows, and Cmd+` is the Mac's own window switcher.
    const opens = down && e.code === KEY && e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing && order.length > 1;
    if (!opens) return { state: null, act: null, consume: false };
    return { state: { order, index: e.shiftKey ? order.length - 1 : 1 }, act: 'open', consume: true };
  }
  const n = state.order.length;
  const move = (by) => ({ state: { ...state, index: (state.index + by + n) % n }, act: 'move', consume: true });
  const commit = (consume) => ({ state: null, act: 'commit', to: state.order[state.index], consume });
  // Letting go of Alt switches (its keyup no longer has altKey, whichever key name the system gives it).
  if (!down) return e.altKey ? { state, act: null, consume: false } : commit(true);
  if (e.key === 'Escape') return { state: null, act: 'cancel', consume: true };
  if (e.key === 'Enter') return commit(true);
  // Alt let go somewhere we didn't hear: switch, and let this key through.
  if (!e.altKey) return commit(false);
  if (e.code === KEY) return move(e.shiftKey ? -1 : 1);
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return move(1);
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') return move(-1);
  // Anything else while Alt is held is the switcher's, so no Alt+letter shortcut fires mid-switch.
  return { state, act: null, consume: true };
}

// ---------- in the page ----------

let person = null;
let state = null;
let box = null;
let cancelled = false; // Esc while Alt is held: its release is still the switcher's
const hooked = new WeakSet(); // documents: a frame's window object stays the same across its navigations

const storeKey = () => `citadel-app-switch:${person}`;
function recent() {
  try { return JSON.parse(localStorage.getItem(storeKey())) ?? []; } catch { return []; }
}
// A contraption's own page (/apps/<name>/…), else Citadel's.
const own = typeof location === 'undefined' ? null : location.pathname.match(/^\/apps\/([^/]+)\//)?.[1] ?? null;
/** The app showing: a contraption's name, or '' for Citadel's own views. */
const showing = () => own ?? location.hash.match(/^#\/apps\/([^/]+)$/)?.[1] ?? '';
function record() {
  if (!person) return;
  try { localStorage.setItem(storeKey(), JSON.stringify(remember(recent(), showing()))); } catch {}
}

/** Start switching for `name` (signed in), counting where they are now as used. */
export function initAppSwitch(name) {
  person = name;
  record();
}

/** The rail's apps, the one you're in kept even if it's greyed out. */
function entries() {
  return [...document.querySelectorAll('.citadel-rail a')]
    .map((a) => ({
      name: a.dataset.app ?? '',
      title: a.querySelector('.label')?.textContent ?? a.title,
      a,
      current: a.classList.contains('current'),
      down: a.classList.contains('down'),
    }))
    .filter((x) => x.current || !x.down);
}

function onKey(e) {
  if (!person) return;
  if (cancelled && e.type === 'keyup' && !e.altKey) {
    cancelled = false;
    return e.preventDefault();
  }
  if (!state && !(e.type === 'keydown' && e.code === KEY && e.altKey)) return;
  let order = state?.order ?? [];
  if (!state) {
    // A modal dialog owns the page until it's closed.
    if (document.querySelector('dialog:modal') || e.view?.document.querySelector('dialog:modal')) return;
    const list = entries();
    const byName = new Map(list.map((x) => [x.name, x]));
    order = appOrder(recent(), list.map((x) => x.name), list.find((x) => x.current)?.name ?? '').map((n) => byName.get(n));
  }
  const r = switchKey(state, e, order);
  if (r.consume) {
    e.preventDefault(); // also the Alt keyup, which on Windows would focus the menu bar
    e.stopPropagation();
  }
  state = r.state;
  if (r.act === 'open' || r.act === 'move') draw();
  if (r.act === 'cancel') {
    shut();
    cancelled = e.altKey;
  }
  if (r.act === 'commit') go(r.to);
}

function shut() {
  state = null;
  box?.remove();
  box = null;
}

function go(item) {
  shut();
  if (item && !item.current) item.a.click(); // the rail's own link: Citadel's last view, or the contraption's frame
}

// Its own sheet, so a contraption's page gets it too: Citadel's colours as theme.css names them, else Citadel's own.
let sheet = null;
function addStyles() {
  if (sheet) return;
  sheet = new CSSStyleSheet();
  sheet.replaceSync(`
.app-switch { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 1rem; background: rgb(0 0 0 / 0.25); }
.app-switch-list { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem; max-width: min(46rem, 100%); padding: 0.75rem; border: 1px solid var(--citadel-border, var(--line)); border-radius: 14px; background: var(--citadel-surface, var(--panel)); color: var(--citadel-text, var(--ink)); box-shadow: 0 12px 40px rgb(0 0 0 / 0.3); font-size: var(--citadel-size-small, var(--size-small)); }
.app-switch-list [role=option] { box-sizing: border-box; width: 6.5rem; padding: 0.75rem 0.5rem; display: flex; flex-direction: column; align-items: center; gap: 0.5rem; border-radius: var(--citadel-radius-lg, var(--radius-lg)); cursor: pointer; }
.app-switch-list [role=option][aria-selected=true] { background: color-mix(in srgb, var(--citadel-accent, var(--accent)) 14%, var(--citadel-surface, var(--panel))); box-shadow: inset 0 0 0 2px var(--citadel-accent, var(--accent)); font-weight: 600; }
.app-switch-pic { width: 48px; height: 48px; flex: none; border-radius: 12px; }
span.app-switch-pic { display: flex; align-items: center; justify-content: center; background: var(--citadel-code-bg, var(--code-bg)); border: 1px solid var(--citadel-border, var(--line)); box-sizing: border-box; font-size: 1.3rem; font-weight: 650; }
.app-switch-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3; }
.app-switch-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

function draw() {
  addStyles();
  if (!box) {
    box = document.createElement('div');
    box.className = 'app-switch';
    box.addEventListener('click', (e) => {
      const tile = e.target.closest('[role=option]');
      if (!tile) return shut();
      go(state?.order[Number(tile.dataset.i)]);
    });
    const list = document.createElement('div');
    list.className = 'app-switch-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Switch app');
    const status = document.createElement('div');
    status.className = 'app-switch-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    box.append(list, status);
    state.order.forEach((item, i) => {
      const tile = document.createElement('div');
      tile.setAttribute('role', 'option');
      tile.dataset.i = i;
      tile.id = `app-switch-${i}`;
      tile.title = item.title;
      const pic = item.a.querySelector('img, .tile')?.cloneNode(true) ?? document.createElement('span');
      pic.classList.add('app-switch-pic');
      const label = document.createElement('span');
      label.className = 'app-switch-label';
      label.textContent = item.title;
      tile.append(pic, label);
      list.append(tile);
    });
    document.body.append(box);
  }
  const list = box.querySelector('[role=listbox]');
  for (const tile of list.children) tile.setAttribute('aria-selected', String(Number(tile.dataset.i) === state.index));
  list.setAttribute('aria-activedescendant', `app-switch-${state.index}`);
  box.querySelector('[role=status]').textContent = `${state.order[state.index].title}, ${state.index + 1} of ${state.order.length}`;
}

/** Listen in a window: Citadel's, or a contraption frame's (again after each navigation in it). */
function hook(win) {
  if (!win || hooked.has(win.document)) return;
  hooked.add(win.document);
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('keyup', onKey, true);
  // Focus left the browser window mid-switch (the system's own Alt-Tab, say): no keyup will come.
  win.addEventListener('blur', () => setTimeout(() => { if (state && !document.hasFocus()) shut(); }));
}

if (typeof document !== 'undefined') {
  hook(window);
  // A contraption's frame (frames.js) loads, or loads a new page: listen in it. Same origin, no sandbox.
  document.addEventListener('load', (e) => {
    if (e.target.tagName !== 'IFRAME' || !e.target.closest('#frames')) return;
    try { hook(e.target.contentWindow); } catch {}
  }, true);
  addEventListener('hashchange', () => {
    shut();
    record();
    // Back in Citadel from a frame: focus was in the now-hidden frame, so keys would go nowhere.
    if (!showing() && document.activeElement?.tagName === 'IFRAME') document.activeElement.blur();
  });
}
