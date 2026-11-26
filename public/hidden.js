// Schemes a person hid for themselves (#226): out of the shelf's list, the switcher and the badges,
// collapsed under "Hidden (N)" with Unhide, and a note inside one opened by its link. Only ever your own. Hiding
// lives on the scheme's Members tab, not on the list's rows (Cara, 2026-11-12: "Lets move the hide button to just
// a setting, its not worth the cost of making the scheme button look weird and short").
import { account, api, h, me, schemeIcon, view } from './base.js';
import { gloss } from './help-words.js';
import { schemeSwitchHash } from './scheme-switch.js';
import { schemeCount } from './inbox.js';
import { rememberHomeLine } from './home.js';
import { openNewScheme } from './sidebar.js';
import { optimistic } from './ui/optimistic.js';
import { dragReorder, inOrder, moved } from './reorder.js';
import { releaseRows } from './releases.js';
import { ciChip, releasesChip } from './ci.js';
import { statusChip } from './status.js';

/** @import { Scheme, SchemeListed, View } from './types.js' */
/** A scheme to hide or unhide: the open one, or a row of the shelf. @typedef {Pick<Scheme, 'id' | 'name'> & { hidden?: boolean }} HideTarget */

let hiddenOpen = false; // whether the shelf's Hidden section is unfolded, kept across redraws
let othersOpen = false; // the same for its Other schemes section
/** @type {HTMLElement | null} */
let schemesChip = null; // the CI chip beside Releases
/** @type {HTMLElement | null} */
let statusChipEl = null; // the Status chip beside it (#1123)
/** @type {HTMLElement | null} */
let releasesChipEl = null; // and the Releases chip (#1423): three doors to one page's tabs

// Your schemes: ones you own or were added to and haven't hidden. Admin reach (the flag, or the Citadel scheme) opens the
// rest too, but they sit apart under Other schemes, never mixed into yours (#674). A list from before #674 has no flag: yours.
/** @param {SchemeListed} p */
const onShelf = (p) => !p.hidden && p.member !== false;

/** @param {number} projectId */
export const isHidden = (projectId) => !!view?.projects?.find((p) => p.id === projectId)?.hidden;

/** Hide or unhide a scheme for you: the shelf and its note show it at once, and everything showing it redraws once the server has it. */
/**
 * @param {HideTarget} p
 * @param {boolean} hidden
 */
export function setHidden(p, hidden) {
  /** @param {boolean} on */
  const show = (on) => {
    for (const x of new Set([p, view?.projects?.find((q) => q.id === p.id)])) if (x) x.hidden = on;
    redrawHidden();
  };
  optimistic({
    sets: `hidden:${p.id}`,
    apply: () => show(hidden),
    send: () => api(`api/projects/${p.id}/hidden`, { method: 'PUT', body: { hidden } }),
    undo: () => !!p.hidden === hidden && show(!hidden), // unless something else changed it since
    label: `${hidden ? 'hide' : 'unhide'} ${p.name}`,
  }).then(
    () => refreshSchemes(),
    () => {},
  ); // a failure already said so in its toast
}

/** A hide changed for someone (this tab or another of theirs): only theirs redraws. */
/** @param {string} name */
export function onHiddenChanged(name) {
  if (name === me) refreshSchemes();
}

/** @type {ReturnType<typeof setTimeout> | 0} */
let retryTimer = 0;
let retries = 0;

/** Fetch the schemes again and redraw them. A failed fetch (a restart's gap) keeps the list shown and tries again, backing off to 30 s (#491). */
export async function refreshSchemes() {
  clearTimeout(retryTimer);
  if (view?.kind !== 'project' || !me) return;
  const projects = await api('api/projects').catch(() => null);
  if (view?.kind !== 'project' || !me) return;
  if (!projects) {
    retryTimer = setTimeout(refreshSchemes, Math.min(30_000, 1000 * 2 ** retries++));
    return;
  }
  retries = 0;
  // A drop still saving: the list keeps it, though this answer may predate it.
  /** @type {View} */ (view).projects = dragged ? inOrder(projects, (p) => p.id, dragged) : projects;
  redrawHidden();
}

function redrawHidden() {
  if (view?.kind !== 'project') return;
  renderSchemesShelf();
  renderHiddenNote();
  document.getElementById('hide-scheme')?.replaceWith(hideButton(/** @type {View} */ (view).project));
}

// quiet: no count or spinner, for the ones you hid and the ones you aren't in.
/**
 * @param {SchemeListed} p
 * @param {HTMLElement | null} [button]
 * @param {boolean} [quiet]
 */
const row = (p, button = null, quiet = p.hidden) =>
  h(
    'div',
    { class: 'scheme-row' },
    h(
      'a',
      {
        class: `nav-item${p.id === /** @type {View} */ (view).projectId && !(/** @type {View} */ (view).home) ? ' active' : ''}`,
        href: schemeSwitchHash(location.hash, p.id, !!account?.admin),
        title: p.name,
        // The hash at the click, not at the draw: the page may have changed since the shelf was drawn.
        onclick: (/** @type {MouseEvent} */ e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
          e.preventDefault();
          location.hash = schemeSwitchHash(location.hash, p.id, !!account?.admin);
        },
      },
      schemeIcon(p),
      h('span', { class: 'name', 'data-project-name': p.id }, p.name),
      quiet ? null : schemeCount(p),
    ),
    button,
  );

/** @type {number[] | null} */
let dragged = null; // the scheme ids of a drop not yet saved
let drops = 0; // counts drops: each saves the whole list, so an older one's Retry has nothing to add

/** Move a scheme from `from` to `to` among the shown ones: at once here, saved behind; a failed save puts it back (#649). */
/**
 * @param {number} from
 * @param {number} to
 */
function reorderSchemes(from, to) {
  const shown = /** @type {View} */ (view).projects.filter(onShelf).map((p) => p.id);
  // The rest keep their place after the shown, so Unhide brings one back where it was among them.
  const keys = [...moved(shown, from, to), .../** @type {View} */ (view).projects.filter((p) => !onShelf(p)).map((p) => p.id)];
  const drop = ++drops;
  /** @type {number[] | null} */
  let before = null; // the order just before this drop showed, to put back if its save fails
  let stale = false; // a Retry once a newer drop has been made: that one's order stands, so this does nothing
  /** @param {number[]} order */
  const show = (order) => {
    /** @type {View} */ (view).projects = inOrder(/** @type {View} */ (view).projects, (p) => p.id, order);
    renderSchemesShelf();
  };
  optimistic({
    sets: 'order:schemes',
    apply: () => {
      stale = drop !== drops;
      if (stale) return;
      before = /** @type {View} */ (view).projects.map((p) => p.id);
      show((dragged = keys));
    },
    send: () => (stale ? /** @type {Promise<unknown>} */ (/** @type {unknown} */ (null)) : api('api/me/order/schemes', { method: 'PUT', body: { keys } })),
    undo: () => {
      if (!before) return;
      dragged = null;
      show(before);
    },
    label: 'save the order of your schemes',
  }).then(
    () => dragged === keys && (dragged = null),
    () => {},
  );
}

/** The shelf's Schemes column: yours you haven't hidden, + New scheme, then the others and the hidden ones collapsed away. */
export function renderSchemesShelf() {
  const el = document.getElementById('schemes-shelf');
  if (!el) return;
  // Press and hold (or drag with a mouse) a scheme to move it; its release lines move with it.
  dragReorder(el, {
    items: () => [.../** @type {NodeListOf<HTMLElement>} */ (el.querySelectorAll(':scope > .scheme-row'))],
    carry: (row) => (row.nextElementSibling?.classList.contains('rel-rows') ? [/** @type {HTMLElement} */ (row.nextElementSibling)] : []),
    onDrop: reorderSchemes,
  });
  const shown = /** @type {View} */ (view).projects.filter(onShelf);
  const others = /** @type {View} */ (view).projects.filter((p) => !p.hidden && !onShelf(p));
  const hidden = /** @type {View} */ (view).projects.filter((p) => p.hidden);
  // Opened by itself while you're in one of them, so the open scheme's row shows.
  const elsewhere = others.length
    ? h(
        'details',
        { class: 'hidden-schemes other-schemes', open: othersOpen || others.some((p) => p.id === /** @type {View} */ (view).projectId) },
        h('summary', { title: "Schemes you can open but aren't a member of" }, `Other schemes (${others.length})`),
        others.map((p) => row(p, null, true)),
      )
    : null;
  elsewhere?.addEventListener('toggle', () => (othersOpen = elsewhere.open));
  const folded = hidden.length
    ? h(
        'details',
        { class: 'hidden-schemes', open: hiddenOpen },
        h('summary', {}, `Hidden (${hidden.length})`),
        hidden.map((p) => row(p, h('button', { type: 'button', class: 'scheme-hide', title: `Show ${p.name} in your lists again`, onclick: () => setHidden(p, false) }, 'Unhide'))),
      )
    : null;
  folded?.addEventListener('toggle', () => (hiddenOpen = folded.open));
  // One chip per shelf, kept across redraws: a new one would read /api/ci again (Cara, 2026-11-18: the CI button "next to the Releases button").
  if (!schemesChip?.isConnected) schemesChip = ciChip();
  if (!statusChipEl?.isConnected) statusChipEl = statusChip();
  if (!releasesChipEl?.isConnected) releasesChipEl = releasesChip();
  // Home (#1140): everything waiting on you across your schemes, for someone in two or more. No pill (Josh, 2026-11-20: "and the orange badge, its all duplicate honestly"; "you can just go home if you want to only see the actionables").
  const home = shown.length >= 2 ? h('div', { class: 'home-shelf' }, h('a', { class: `nav-item${/** @type {View} */ (view).home ? ' active' : ''}`, href: '#/home', title: 'What waits on you in every scheme' }, h('span', { class: 'home-mark', 'aria-hidden': 'true' }, '⌂'), h('span', { class: 'name' }, 'Home'))) : null;
  rememberHomeLine(!!home);
  el.replaceChildren(
    h('h3', {}, gloss('scheme', 'Schemes'), h('span', { class: 'spacer' }), statusChipEl, schemesChip, releasesChipEl),
    /** @type {Node} */ (home), // null when there is nothing to show
    // Each scheme's targets sit under its row (#626): what it ships and how far the next release is.
    ...shown.flatMap((p) => [row(p), releaseRows(p.id)]),
    h('button', { type: 'button', class: 'nav-item add', onclick: openNewScheme }, '+ New scheme'),
    ...(elsewhere ? [elsewhere] : []),
    ...(folded ? [folded] : []),
  );
}

/** "Hidden · Unhide" above the minions, in a scheme you hid and opened anyway. */
export function renderHiddenNote() {
  const el = document.getElementById('hidden-note');
  if (!el) return;
  el.hidden = !isHidden(/** @type {View} */ (view).projectId);
  el.replaceChildren(...(el.hidden ? [] : ['Hidden from your lists', ' · ', h('button', { type: 'button', class: 'link', onclick: () => setHidden(/** @type {View} */ (view).project, false) }, 'Unhide')]));
}

/** Hide or Unhide for the open scheme, on the Members tab. */
/** @param {HideTarget} p */
export function hideButton(p) {
  const hidden = isHidden(p.id);
  return h('button', { type: 'button', id: 'hide-scheme', class: 'secondary small', onclick: () => setHidden(p, !hidden) }, hidden ? `Unhide ${p.name}` : `Hide ${p.name} for me`);
}
