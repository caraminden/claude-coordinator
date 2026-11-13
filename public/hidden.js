// Schemes a person hid for themselves (#226): out of the shelf's list, the switcher and the badges,
// collapsed under "Hidden (N)" with Unhide, and a note inside one opened by its link. Only ever your own. Hiding
// lives on the scheme's Members tab, not on the list's rows (Cara, 2026-11-12: "Lets move the hide button to just
// a setting, its not worth the cost of making the scheme button look weird and short").
import { api, h, me, schemeIcon, view } from './base.js';
import { schemeCount } from './inbox.js';
import { openNewScheme } from './sidebar.js';
import { optimistic } from './ui/optimistic.js';
import { releaseRows, releasesLink } from './releases.js';

let hiddenOpen = false; // whether the shelf's Hidden section is unfolded, kept across redraws

export const isHidden = (projectId) => !!view?.projects?.find((p) => p.id === projectId)?.hidden;

/** Hide or unhide a scheme for you: the shelf and its note show it at once, and everything showing it redraws once the server has it. */
export function setHidden(p, hidden) {
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
  }).then(() => refreshSchemes(), () => {}); // a failure already said so in its toast
}

/** A hide changed for someone (this tab or another of theirs): only theirs redraws. */
export function onHiddenChanged(name) {
  if (name === me) refreshSchemes();
}

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
  view.projects = projects;
  redrawHidden();
}

function redrawHidden() {
  if (view?.kind !== 'project') return;
  renderSchemesShelf();
  renderHiddenNote();
  document.getElementById('hide-scheme')?.replaceWith(hideButton(view.project));
}

const row = (p, button = null) => h('div', { class: 'scheme-row' },
  h('a', { class: `nav-item${p.id === view.projectId ? ' active' : ''}`, href: `#/p/${p.id}`, title: p.name },
    schemeIcon(p), h('span', { class: 'name', 'data-project-name': p.id }, p.name), p.hidden ? null : schemeCount(p)),
  button);

/** The shelf's Schemes column: the ones you haven't hidden, + New scheme, then the hidden ones collapsed away. */
export function renderSchemesShelf() {
  const el = document.getElementById('schemes-shelf');
  if (!el) return;
  const shown = view.projects.filter((p) => !p.hidden);
  const hidden = view.projects.filter((p) => p.hidden);
  const folded = hidden.length ? h('details', { class: 'hidden-schemes', open: hiddenOpen },
    h('summary', {}, `Hidden (${hidden.length})`),
    hidden.map((p) => row(p, h('button', { type: 'button', class: 'scheme-hide', title: `Show ${p.name} in your lists again`, onclick: () => setHidden(p, false) }, 'Unhide')))) : null;
  folded?.addEventListener('toggle', () => (hiddenOpen = folded.open));
  el.replaceChildren(h('h3', {}, 'Schemes', h('span', { class: 'spacer' }), releasesLink()),
    // Each scheme's targets sit under its row (#626): what it ships and how far the next release is.
    ...shown.flatMap((p) => [row(p), releaseRows(p.id)]),
    h('button', { type: 'button', class: 'nav-item add', onclick: openNewScheme }, '+ New scheme'),
    ...(folded ? [folded] : []));
}

/** "Hidden · Unhide" above the minions, in a scheme you hid and opened anyway. */
export function renderHiddenNote() {
  const el = document.getElementById('hidden-note');
  if (!el) return;
  el.hidden = !isHidden(view.projectId);
  el.replaceChildren(...(el.hidden ? [] : ['Hidden from your lists', ' · ',
    h('button', { type: 'button', class: 'link', onclick: () => setHidden(view.project, false) }, 'Unhide')]));
}

/** Hide or Unhide for the open scheme, on the Members tab. */
export function hideButton(p) {
  const hidden = isHidden(p.id);
  return h('button', { type: 'button', id: 'hide-scheme', class: 'secondary small', onclick: () => setHidden(p, !hidden) },
    hidden ? `Unhide ${p.name}` : `Hide ${p.name} for me`);
}
