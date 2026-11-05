// Schemes a person hid for themselves (#226): out of the shelf's list, the switcher and the badges,
// collapsed under "Hidden (N)" with Unhide, and a note inside one opened by its link. Only ever your own.
import { api, h, me, schemeIcon, view } from './core.js';
import { schemeCount } from './inbox.js';
import { openNewScheme } from './sidebar.js';

let hiddenOpen = false; // whether the shelf's Hidden section is unfolded, kept across redraws

export const isHidden = (projectId) => !!view?.projects?.find((p) => p.id === projectId)?.hidden;

/** Hide or unhide a scheme for you, then redraw what shows it. */
export async function setHidden(p, hidden) {
  try {
    await api(`api/projects/${p.id}/hidden`, { method: 'PUT', body: { hidden } });
  } catch (err) {
    return alert(err.message);
  }
  await refreshHidden();
}

/** A hide changed for someone (this tab or another of theirs): only theirs redraws. */
export function onHiddenChanged(name) {
  if (name === me) refreshHidden();
}

async function refreshHidden() {
  if (view?.kind !== 'project') return;
  view.projects = await api('api/projects').catch(() => view.projects);
  renderSchemesShelf();
  renderHiddenNote();
  document.getElementById('hide-scheme')?.replaceWith(hideButton(view.project));
}

const row = (p, button) => h('div', { class: 'scheme-row' },
  h('a', { class: `nav-item${p.id === view.projectId ? ' active' : ''}`, href: `#/p/${p.id}` },
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
  el.replaceChildren(h('h3', {}, 'Schemes'),
    ...shown.map((p) => row(p, h('button', {
      type: 'button', class: 'scheme-hide', 'aria-label': `Hide ${p.name}`,
      title: `Hide ${p.name} from your lists, badges and notifications. Only for you; you stay in it.`, onclick: () => setHidden(p, true),
    }, 'Hide'))),
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
