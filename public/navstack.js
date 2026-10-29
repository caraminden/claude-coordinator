// Back and Forward in the thread bar. The browser won't say whether there is a forward entry, or
// whether going back would leave the app, so this keeps its own copy of the tab's history within
// Citadel: the addresses visited and where in them we are. It lives in sessionStorage (one tab, kept
// over a reload), and each history entry carries its stack's id and place in history.state, so a
// move by any means (these buttons, Alt+←, a phone's back swipe, the viewer's ×) lands on the
// right place. A link, the sidebar or the × adds an entry; replaceHash swaps the current one.

const KEY = 'cc-nav';
const MAX = 100; // entries kept per stack
const KEEP = 4; // stacks kept: one per time this tab loaded the app afresh

/**
 * The stack after landing on `hash`. `at` is the place the history entry carries when it is one of
 * this stack's (a move back or forward); otherwise the entry is new, and replaces the current one
 * when `replaced`, or else goes after it, dropping whatever was forward of it.
 */
export function step(stack, { hash, at, replaced }) {
  let entries = [...stack.entries];
  let idx = stack.idx;
  if (at != null) idx = Math.min(Math.max(at, 0), entries.length - 1);
  else if (!replaced) {
    entries = [...entries.slice(0, idx + 1), hash];
    idx = entries.length - 1;
  }
  entries[idx] = hash;
  if (entries.length > MAX) {
    const drop = entries.length - MAX;
    entries = entries.slice(drop);
    idx = Math.max(idx - drop, 0);
  }
  return { ...stack, entries, idx };
}

export const canGoBack = (stack) => !!stack && stack.idx > 0;
export const canGoForward = (stack) => !!stack && stack.idx < stack.entries.length - 1;

let stack = null;
let replacing = null; // the hash replaceHash is going to, until its hashchange arrives

function load() {
  try { return JSON.parse(sessionStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

function save(stacks) {
  stacks[stack.id] = { ...stack, at: Date.now() };
  const ids = Object.keys(stacks).sort((a, b) => stacks[b].at - stacks[a].at);
  for (const id of ids.slice(KEEP)) delete stacks[id];
  try { sessionStorage.setItem(KEY, JSON.stringify(stacks)); } catch {}
}

/** Note where the tab is now, after a page load or any move. */
function sync() {
  const hash = location.hash || '#/';
  const stacks = load();
  const mark = history.state?.ccNav;
  // This tab's own stack first: it is the newest, and the only one when sessionStorage is off.
  const known = mark && (stack?.id === mark.id ? stack : stacks[mark.id]);
  if (known) stack = step(known, { hash, at: mark.idx });
  else if (stack && !mark) stack = step(stack, { hash, replaced: replacing === hash });
  // A fresh load, or an entry whose stack was dropped: start again here, with nothing to go back to.
  else stack = { id: Math.random().toString(36).slice(2, 10), entries: [hash], idx: 0 };
  replacing = null;
  try { history.replaceState({ ...history.state, ccNav: { id: stack.id, idx: stack.idx } }, ''); } catch {}
  save(stacks);
  updateButtons();
}

/** Swap the current address for `hash` without adding a history entry (location.replace, told to the stack). */
export function replaceHash(hash) {
  const target = new URL(hash, location.href).hash;
  if (target !== location.hash) replacing = target;
  location.replace(hash);
}

export const canBack = () => canGoBack(stack);
export const canForward = () => canGoForward(stack);
/** Never off the site: with nothing earlier in Citadel, Back does nothing. */
export function goBack() { if (canBack()) history.back(); }
export function goForward() { if (canForward()) history.forward(); }

/** The thread bar's buttons are rebuilt often; between rebuilds, keep them in step with moves. */
function updateButtons() {
  for (const b of document.querySelectorAll('button.nav-back')) b.disabled = !canBack();
  for (const b of document.querySelectorAll('button.nav-forward')) b.disabled = !canForward();
}

if (typeof window !== 'undefined') {
  // Both, since a move between two entries with the same address fires only popstate; sync is
  // idempotent, so the pair a hash move fires counts once.
  window.addEventListener('popstate', sync);
  window.addEventListener('hashchange', sync);
  sync();
}
