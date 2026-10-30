// The scheme switcher and the minions list: new-minion box, search and rows.
import { weekShare } from './cost.js';
import { ago, api, app, costText, crumbs, h, isCoordinator, isSeen, sending, setSending, setView, STATES, statusLabel, TAGS, taskmasterLabel, threadFullName, threadHref, usage, view } from './core.js';
import { loadDraft, saveDraft } from './composer.js';
import { propFilter, renderPropFilter } from './properties.js';
import { matchesPicks } from './propfilter.js';
import { threadMatches, threadSections } from './threadgroups.js';
import { withoutCount } from './progress.js';
import { startScheme } from './schemes.js';
import { renderInbox } from './inbox.js';
import { replaceHash } from './navstack.js';

// ---------- projects ----------

export const LAST_SCHEME = 'cc-scheme'; // the scheme this browser last had open

/** The app's front door: open the last scheme (or Citadel, or the first); with none, offer to make one. */
export async function openStartScheme() {
  const projects = await api('api/projects');
  let last = NaN;
  try { last = Number(localStorage.getItem(LAST_SCHEME)); } catch {}
  const id = startScheme(projects, last);
  if (id != null) return replaceHash(`#/p/${id}`); // replace: Back shouldn't bounce through here
  setView({ kind: 'projects' });
  crumbs.replaceChildren('New scheme');
  app.replaceChildren(h('div', { class: 'card new-scheme' }, h('h2', {}, 'New scheme'), newSchemeForm()));
}

/** Where a new scheme's code comes from; `soon` ones wait for #173's server side. */
const SOURCES = [
  { value: 'new', label: 'New repo (private, on GitHub too)', soon: true },
  { value: 'url', label: 'Clone from a URL', field: 'repoUrl', placeholder: 'https://github.com/caraminden/gamedevtest.git' },
  { value: 'folder', label: 'Clone a folder on perigee', field: 'folder', placeholder: '~/projects/…', soon: true },
  { value: 'none', label: 'No code (docs, research, art)' },
];

/** Name, code source and what it's about for a new scheme; on success it opens the scheme. */
function newSchemeForm() {
  const sources = SOURCES.map((s) => h('label', { class: 'source' },
    h('input', { type: 'radio', name: 'source', value: s.value, checked: s.value === 'url', disabled: !!s.soon }),
    h('span', {}, s.label, s.soon ? h('span', { class: 'muted' }, ' (soon)') : ''),
    s.field ? h('input', { name: s.field, 'data-draft': true, placeholder: s.placeholder, disabled: !!s.soon }) : ''));
  const form = h('form', {},
    h('label', {}, 'Name', h('input', { name: 'name', required: true, maxlength: 80, 'data-draft': true })),
    h('fieldset', { class: 'sources' }, h('legend', {}, 'Code'), ...sources),
    h('label', {}, "What's it about? (the Taskmaster starts from this)",
      h('textarea', { name: 'about', rows: 3, maxlength: 4000, 'data-draft': true, placeholder: 'What it is, who it is for, the first milestone' })),
    h('p', { class: 'error', hidden: true }),
    h('div', { class: 'row actions' },
      h('button', { type: 'submit', value: 'setup' }, 'Create and set up'),
      h('button', { type: 'submit', value: 'only', class: 'secondary' }, 'Create only')));
  // Only the picked source's field shows.
  const showField = () => {
    for (const l of form.querySelectorAll('label.source')) {
      const field = l.querySelector('input:not([type=radio])');
      if (field) field.hidden = !l.querySelector('input[type=radio]').checked;
    }
  };
  form.addEventListener('change', showField);
  showField();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter ?? form.querySelector('button[type=submit]');
    const label = btn.textContent;
    const err = form.querySelector('.error');
    const source = form.source.value;
    for (const b of form.querySelectorAll('button[type=submit]')) b.disabled = true;
    btn.textContent = source === 'url' ? 'Cloning…' : 'Creating…';
    try {
      const p = await api('api/projects', { method: 'POST', body: {
        name: form.name.value, source, repoUrl: form.repoUrl.value, folder: form.folder.value, about: form.about.value, setup: btn.value === 'setup',
      } });
      form.closest('dialog')?.close();
      location.hash = `#/p/${p.id}`;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      for (const b of form.querySelectorAll('button[type=submit]')) b.disabled = false;
      btn.textContent = label;
    }
  });
  return form;
}

/** The new-scheme form in a modal: a centred box on desktop, a sheet along the bottom on phones. */
export function openNewScheme() {
  const dialog = h('dialog', { class: 'new-scheme' },
    h('div', { class: 'row' }, h('h2', {}, 'New scheme'), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'close', 'aria-label': 'Close', onclick: () => dialog.close() }, '×')),
    newSchemeForm());
  dialog.addEventListener('close', () => dialog.remove());
  // A tap on the backdrop (the dialog itself, outside its content box) closes it.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  document.body.append(dialog);
  dialog.showModal();
}

let closeSchemeMenu = () => {};

/** A small menu of the schemes under the switcher button, with the new-scheme entry at the end. */
export function toggleSchemeMenu(button) {
  if (document.getElementById('scheme-menu')) return closeSchemeMenu();
  const menu = h('div', { id: 'scheme-menu', class: 'scheme-menu' },
    view.projects.map((p) => h('a', { class: `nav-item${p.id === view.projectId ? ' active' : ''}`, href: `#/p/${p.id}`, onclick: () => closeSchemeMenu() },
      h('span', { class: 'name', 'data-project-name': p.id }, p.name))),
    h('button', { type: 'button', class: 'nav-item add', onclick: () => { closeSchemeMenu(); openNewScheme(); } }, '+ New scheme'));
  const outside = (e) => { if (!menu.contains(e.target) && !button.contains(e.target)) closeSchemeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSchemeMenu(); button.focus(); } };
  closeSchemeMenu = () => {
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    closeSchemeMenu = () => {};
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  document.body.append(menu);
  button.setAttribute('aria-expanded', 'true');
  const r = button.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
}

export function newTicketForm(projectId) {
  // A one-line chat box: what you type becomes the new thread's first message. The thread names
  // and tags itself from it, and every thread gets full access.
  const box = h('textarea', { name: 'message', required: true, rows: 1, placeholder: 'New minion: what should it work on?', 'aria-label': 'Start a new minion', 'data-draft': true });
  const err = h('p', { class: 'error', hidden: true });
  const form = h('form', { class: 'new-thread' }, box, err);
  const fit = () => {
    box.style.height = 'auto';
    // Not laid out (a folded panel, or a phone's drawer still tucked away): keep the one-line default.
    if (!box.scrollHeight) { box.style.height = ''; return; }
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  };
  const draftKey = `cc-new-thread:${projectId}`;
  const draft = loadDraft(draftKey);
  if (draft) box.value = draft.message ?? '';
  requestAnimationFrame(fit);
  let busy = false;
  box.addEventListener('input', () => {
    fit();
    saveDraft(draftKey, box.value ? { message: box.value } : null);
  });
  box.addEventListener('keydown', (e) => {
    // Enter sends (on phones too, unlike the chat composer), Shift+Enter adds a line, IME composition is left alone.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !box.value.trim()) return;
    busy = true;
    box.readOnly = true;
    err.hidden = true;
    setSending(sending + 1);
    try {
      const t = await api(`api/projects/${projectId}/tickets`, { method: 'POST', body: { message: box.value } });
      saveDraft(draftKey, null);
      box.value = '';
      fit();
      location.hash = threadHref(t);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      busy = false;
      box.readOnly = false;
      setSending(sending - 1);
    }
  });
  return form;
}

export function renderSidebar() {
  const el = document.getElementById('threads');
  if (!el) return;
  const all = [...view.tickets.values()];
  document.getElementById('coordinator-row')?.replaceChildren(threadRow(view.coordinator, `#/p/${view.projectId}`));
  renderPropFilter();
  // The property filter narrows open and dismissed minions alike; the Taskmaster always shows.
  const picks = propFilter.projectId === view.projectId ? propFilter.picks : new Map();
  const tickets = picks.size ? all.filter((t) => matchesPicks(t, picks)) : all;
  // Its count depends on which minions you've seen, which changes with the rows.
  renderInbox();
  if (threadSearch.q) return renderThreadResults(el, tickets.sort((a, b) => b.updated_at - a.updated_at));
  const open = tickets.filter((t) => t.status !== 'closed');
  const closed = tickets.filter((t) => t.status === 'closed').sort((a, b) => b.updated_at - a.updated_at);
  const sections = threadSections(open, Object.keys(TAGS)).map((s) =>
    h('section', { class: `thread-group g-${s.build ? 'build' : s.key}` },
      h('h3', {}, s.build ? ['Build ', s.build, s.current ? h('span', { class: 'muted' }, ' current') : ''] : s.key === 'parked' ? 'Parked' : s.tag ? TAGS[s.tag].section : 'Other'),
      s.rows.sort(byUrgency).map((t) => threadRow(t))));
  let closedGroup = '';
  if (closed.length) {
    // Closed threads stay out of the way but can still be opened and reopened.
    closedGroup = h('details', { class: 'thread-group g-closed', open: view.showClosed }, h('summary', {}, 'Dismissed'), closed.map((t) => threadRow(t)));
    closedGroup.addEventListener('toggle', () => { view.showClosed = closedGroup.open; });
  }
  el.replaceChildren(
    ...sections, closedGroup,
    !all.length ? h('p', { class: 'muted' }, 'No minions yet. Ask the Taskmaster to start one, or type in the box above.')
      : !tickets.length ? h('p', { class: 'muted small' }, 'No minions match the filter.') : '');
}

/** Scroll the minion list (not the page) so the open minion's row is in view, after you navigate to one. */
export function revealActiveRow() {
  const row = document.querySelector('#threads .thread-row.active');
  const box = row?.closest('.sidebar');
  if (!box?.open) return;
  const dismissed = row.closest('details.g-closed');
  if (dismissed && !dismissed.open) dismissed.open = true;
  const r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - (box.clientHeight - r.height) / 2;
}

// ---------- search ----------

// The threads search, kept across thread switches within a project.
const threadSearch = { projectId: null, q: '' };

export function threadSearchBox(projectId) {
  if (threadSearch.projectId !== projectId) Object.assign(threadSearch, { projectId, q: '' });
  const input = h('input', { type: 'search', class: 'thread-search', placeholder: 'Search titles, numbers and properties…', value: threadSearch.q, autocomplete: 'off' });
  input.addEventListener('input', () => {
    threadSearch.q = input.value.trim();
    renderSidebar();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      input.value = '';
      input.dispatchEvent(new Event('input'));
    }
  });
  return input;
}

/** Search results: threads whose title, number or properties match. */
function renderThreadResults(el, tickets) {
  // The Taskmaster's row stays above the search, so results are minions only.
  const results = tickets.filter((t) => threadMatches(t, threadSearch.q));
  el.replaceChildren(
    h('section', { class: 'column' },
      h('h3', {}, 'Results', h('span', { class: 'count' }, results.length)),
      results.length
        ? results.map((t) => threadRow(t))
        : h('p', { class: 'muted small' }, 'No minion has that in its title, number or properties.')));
}

/** Rows that need you first (longest waiting at the top), then working, then waiting elsewhere, then parked. */
function byUrgency(a, b) {
  const sa = rowState(a), sb = rowState(b);
  if (sa.rank !== sb.rank) return sa.rank - sb.rank;
  return sa.rank === 0 ? (sa.since ?? a.updated_at) - (sb.since ?? b.updated_at) : b.updated_at - a.updated_at;
}

/**
 * A thread's state pill, coloured by family (one meaning each): you (amber, your move, with how
 * long it has waited), done (green), broken (red), work (blue, with steps done), wait (violet: the
 * usage reset, a deploy, CI), idle (grey: parked, dismissed).
 */
export function rowState(t) {
  const steps = t.steps ? ` ${t.steps.done}/${t.steps.total}` : '';
  const waited = (word) => `${word} ${shortAgo(t.updated_at)}`;
  if (t.approvals) return { rank: 0, fam: 'you', cell: waited('approve'), label: 'Waiting for your approval' };
  if (t.status === 'running' || t.status === 'new') return { rank: 1, fam: 'work', cell: [h('i', { class: 'pulse' }), steps.trim() || 'working'], counted: !!steps, label: 'Claude is working' };
  if (t.status === 'error' && t.state === 'limited') return limitState(t, waited);
  if (t.status === 'error') return { rank: 0, fam: 'broken', cell: waited('stuck'), label: 'Stuck: the last turn failed' };
  if (t.status === 'closed') return { rank: 5, fam: 'idle', cell: 'dismissed', label: 'Dismissed' };
  const state = STATES[t.state];
  if (t.state === 'parked') return { rank: 4, fam: 'idle', cell: 'parked', label: state.label };
  if (t.state === 'outside' || t.state === 'pending-deploy') return { rank: 2, fam: 'wait', cell: `${t.state === 'outside' ? 'waiting' : 'deploying'}${steps}`, counted: !!steps, label: state.label };
  if (t.state === 'blocked') return { rank: 2, fam: 'broken', cell: 'blocked', label: state.label };
  // An open question or plan card is the more specific ask than ready, try it or reply; timed from when it was posted.
  if (t.pending_card_at) return { rank: 0, fam: 'you', cell: `? ${shortAgo(t.pending_card_at)}`, label: 'Waiting for you to answer a question or plan', since: t.pending_card_at };
  if (t.state === 'ready') return { rank: 0, fam: 'done', cell: waited('ready'), label: state.label };
  if (t.state === 'try') return { rank: 0, fam: 'you', cell: waited('try it'), label: state.label };
  return { rank: 0, fam: 'you', cell: waited('reply'), label: 'Your move' };
}

/**
 * A minion that hit the usage limit: a countdown to its own resume when it has one, else a countdown while the account's limit is still hit, your move
 * once a later turn shows it has reset, and just "limit hit" when neither is known (the note says when).
 */
function limitState(t, waited) {
  if (t.limit_resume_at) return { rank: 2, fam: 'wait', cell: `resumes ${shortIn(t.limit_resume_at)}`, label: 'Usage limit: resumes by itself' };
  const hit = [usage?.session, usage?.weekly].find((w) => w?.status === 'rejected' && w.resetsAt > Date.now());
  if (hit) return { rank: 2, fam: 'wait', cell: `resets ${shortIn(hit.resetsAt)}`, label: STATES.limited.label };
  if (usage?.updatedAt > t.updated_at) return { rank: 0, fam: 'you', cell: waited('resume'), label: 'The usage limit has reset: send a message to carry on' };
  return { rank: 2, fam: 'wait', cell: 'limit hit', label: STATES.limited.label };
}

/** Where a minion's change is (t.ship, src/branch.ts): its colour family, and its badge in the list (none on its branch). */
export const SHIP = {
  branch: { fam: 'idle', badge: '' },
  main: { fam: 'work', badge: 'on main' },
  deploying: { fam: 'wait', badge: 'deploying' },
  live: { fam: 'done', badge: 'live' },
  failed: { fam: 'broken', badge: 'deploy failed' },
};

/** One compact row: number + short ask and the state on top, the thread's note (or what it is doing) below. */
export function threadRow(t, href = threadHref(t)) {
  const coord = isCoordinator(t);
  // The coordinator is always there to talk to; only show when it is busy.
  const st = coord && t.status !== 'running' ? { fam: '', cell: '', label: statusLabel(t) } : rowState(t);
  const quiet = st.fam === 'work' || st.fam === 'idle' || st.fam === 'wait';
  // The state cell already shows steps done, so the activity line drops its own count.
  const activity = st.counted && t.last_activity ? withoutCount(t.last_activity) : t.last_activity;
  const note = (t.status === 'running' ? activity : t.note || activity) || '';
  const share = t.cost && weekShare(t.cost);
  // People's own note (#146), on a line of its own so the minion's note keeps its place.
  const pnote = !coord && view.personNotes?.[t.id];
  const details = [
    threadFullName(t),
    [st.label, t.queued ? `${t.queued} queued` : '', coord ? '' : `started by ${t.created_by}`, `updated ${ago(t.updated_at)}`, t.cost ? `${share ? `${share} of the weekly limit, ` : ''}${costText(t.cost)} at API prices` : ''].filter(Boolean).join(' · '),
    note,
    !coord && t.ship ? `${t.ship.text} · ${t.ship.commit}` : '',
    pnote ? `✎ ${pnote.text} (${pnote.by})` : '',
  ].filter(Boolean).join('\n');
  const shipStage = !coord && t.status !== 'closed' && SHIP[t.ship?.stage];
  const ship = shipStage?.badge ? h('span', { class: `ship-badge f-${shipStage.fam}`, title: `${t.ship.text} · ${t.ship.commit}` }, shipStage.badge) : '';
  const active = view.id === t.id;
  // Rows waiting on you get a tint of their colour, stronger until you've opened them since they changed.
  // Unread (a dot and a bold title) marks any settled row that changed since you last opened it.
  const yours = !coord && st.rank === 0 ? ' yours' : '';
  const unread = !coord && st.fam !== 'work' && st.fam !== 'idle' && !isSeen(t) ? ' unread' : '';
  // No one-tap replies on list rows (#130): a stray tap on "Merge it" would ship work nobody opened.
  return h('a', { class: `thread-row s-${t.status} f-${st.fam || 'none'}${coord ? ' coordinator' : ''}${yours}${unread}${active ? ' active' : ''}`, href, title: details, 'data-id': t.id },
    h('span', { class: 'name' }, coord ? taskmasterLabel(t.project_id) : [h('i', { class: 'unread-dot' }), h('span', { class: 'num' }, t.number ?? t.id), ' ', t.title]),
    t.queued ? h('span', { class: 'queued' }, `✉ ${t.queued}`) : '',
    st.cell ? h('span', { class: 'state' }, st.cell) : '',
    note || ship ? h('span', { class: `note${quiet && !unread ? ' t' : ''}` }, ship, note) : '',
    t.cost ? h('span', { class: 'cost' }, share ? `${share} wk` : costText(t.cost)) : '',
    pnote ? h('span', { class: 'pnote' }, `✎ ${pnote.text}`) : '');
}

/** "40m", "1h40", "14h", "2d": time left, for tight spaces. */
function shortIn(ms) {
  const m = Math.max(1, Math.ceil((ms - Date.now()) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 600) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

/** "now", "5m", "3h", "2d": ages for tight spaces. */
function shortAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
