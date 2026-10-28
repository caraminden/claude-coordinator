// The scheme switcher and the minions list: new-minion box, search and rows.
import { ago, api, app, crumbs, h, isCoordinator, isSeen, sending, setSending, setView, STATES, statusLabel, TAGS, taskmasterLabel, threadFullName, threadHref, view } from './core.js';
import { loadDraft, saveDraft } from './composer.js';
import { threadMatches, threadSections } from './threadgroups.js';
import { withoutCount } from './progress.js';
import { startScheme } from './schemes.js';

// ---------- projects ----------

export const LAST_SCHEME = 'cc-scheme'; // the scheme this browser last had open

/** The app's front door: open the last scheme (or Citadel, or the first); with none, offer to make one. */
export async function openStartScheme() {
  const projects = await api('/api/projects');
  let last = NaN;
  try { last = Number(localStorage.getItem(LAST_SCHEME)); } catch {}
  const id = startScheme(projects, last);
  if (id != null) return location.replace(`#/p/${id}`); // replace: Back shouldn't bounce through here
  setView({ kind: 'projects' });
  crumbs.replaceChildren('New scheme');
  app.replaceChildren(h('div', { class: 'card new-scheme' }, h('h2', {}, 'New scheme'), newSchemeForm()));
}

/** Name and repo for a new scheme; on success it opens the scheme. */
function newSchemeForm() {
  const form = h('form', {},
    h('label', {}, 'Name', h('input', { name: 'name', required: true, maxlength: 80, 'data-draft': true })),
    h('label', {}, 'Git repo URL (optional; each minion gets its own worktree)',
      h('input', { name: 'repoUrl', 'data-draft': true, placeholder: 'https://github.com/caraminden/gamedevtest.git' })),
    h('p', { class: 'error', hidden: true }),
    h('button', { type: 'submit' }, 'Create scheme'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const err = form.querySelector('.error');
    btn.disabled = true;
    btn.textContent = form.repoUrl.value ? 'Cloning…' : 'Creating…';
    try {
      const p = await api('/api/projects', { method: 'POST', body: { name: form.name.value, repoUrl: form.repoUrl.value } });
      form.closest('dialog')?.close();
      location.hash = `#/p/${p.id}`;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Create scheme';
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
      const t = await api(`/api/projects/${projectId}/tickets`, { method: 'POST', body: { message: box.value } });
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
  const tickets = [...view.tickets.values()];
  document.getElementById('coordinator-row')?.replaceChildren(threadRow(view.coordinator, `#/p/${view.projectId}`));
  if (threadSearch.q) return renderThreadResults(el, tickets.sort((a, b) => b.updated_at - a.updated_at));
  const open = tickets.filter((t) => t.status !== 'closed');
  const closed = tickets.filter((t) => t.status === 'closed').sort((a, b) => b.updated_at - a.updated_at);
  const sections = threadSections(open, Object.keys(TAGS)).map((s) =>
    h('section', { class: `thread-group g-${s.build ? 'build' : s.key}` },
      h('h3', {}, s.build ? ['Build ', s.build, s.current ? h('span', { class: 'muted' }, ' current') : ''] : s.tag ? TAGS[s.tag].section : 'Other'),
      s.rows.sort(byUrgency).map((t) => threadRow(t))));
  let closedGroup = '';
  if (closed.length) {
    // Closed threads stay out of the way but can still be opened and reopened.
    closedGroup = h('details', { class: 'thread-group g-closed', open: view.showClosed }, h('summary', {}, 'Dismissed'), closed.map((t) => threadRow(t)));
    closedGroup.addEventListener('toggle', () => { view.showClosed = closedGroup.open; });
  }
  el.replaceChildren(
    ...sections, closedGroup,
    tickets.length ? '' : h('p', { class: 'muted' }, 'No minions yet. Ask the Taskmaster to start one, or type in the box above.'));
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
  const ra = rowState(a).rank, rb = rowState(b).rank;
  if (ra !== rb) return ra - rb;
  return ra === 0 ? a.updated_at - b.updated_at : b.updated_at - a.updated_at;
}

/**
 * A thread's state cell: ❓ / ✅ / 🧪 when it is your move (with how long it has waited), ● x/y while
 * Claude works, ⏳ ⛔ when it waits on something else, 🧊 parked, ⚠️ stuck.
 */
export function rowState(t) {
  const steps = t.steps ? ` ${t.steps.done}/${t.steps.total}` : '';
  const waited = () => {
    const days = Date.now() - t.updated_at >= 86_400_000;
    return h('b', { class: days ? 'st' : 'm' }, shortAgo(t.updated_at));
  };
  if (t.approvals) return { rank: 0, cls: 'q', cell: ['✋ ', waited()], label: 'Waiting for your approval' };
  if (t.status === 'running' || t.status === 'new') return { rank: 1, cls: 'w', cell: [`●${steps}`], counted: !!steps, label: 'Claude is working' };
  if (t.status === 'error') return { rank: 0, cls: 'st', cell: ['⚠️'], label: 'Stuck: the last turn failed' };
  if (t.status === 'closed') return { rank: 5, cls: 'm', cell: ['✓'], label: 'Dismissed' };
  const state = STATES[t.state];
  if (t.state === 'parked') return { rank: 4, cls: 'm', cell: [state.emoji], label: state.label };
  if (t.state === 'outside' || t.state === 'pending-deploy') return { rank: 2, cls: 'w', cell: [`${state.emoji}${steps}`], counted: !!steps, label: state.label };
  if (t.state === 'blocked') return { rank: 2, cls: 'st', cell: [state.emoji], label: state.label };
  if (state) return { rank: 0, cls: 'ok', cell: [state.emoji, ' ', waited()], label: state.label };
  return { rank: 0, cls: 'q', cell: ['❓ ', waited()], label: 'Your move' };
}

/** One compact row: number + short ask and the state on top, the thread's note (or what it is doing) below. */
function threadRow(t, href = threadHref(t)) {
  const coord = isCoordinator(t);
  // The coordinator is always there to talk to; only show when it is busy.
  const st = coord && t.status !== 'running' ? { cls: '', cell: [], label: statusLabel(t) } : rowState(t);
  const working = st.cls === 'w' || st.cls === 'm';
  // The state cell already shows steps done, so the activity line drops its own count.
  const activity = st.counted && t.last_activity ? withoutCount(t.last_activity) : t.last_activity;
  const note = (t.status === 'running' ? activity : t.note || activity) || '';
  const details = [
    threadFullName(t),
    [st.label, t.queued ? `${t.queued} queued` : '', coord ? '' : `started by ${t.created_by}`, `updated ${ago(t.updated_at)}`].filter(Boolean).join(' · '),
    note,
  ].filter(Boolean).join('\n');
  const active = (view.id ?? view.fileTicket?.id) === t.id;
  // Rows waiting on you get a tinted background (red when the thread is stuck), so they stand out.
  // Faint once you've opened the thread since it last changed; vibrant again when it changes.
  const yours = !coord && st.rank === 0 ? ` yours${st.cls === 'st' ? ' stuck' : ''}${isSeen(t) ? ' seen' : ''}` : '';
  return h('a', { class: `thread-row s-${t.status}${coord ? ' coordinator' : ''}${yours}${active ? ' active' : ''}`, href, title: details, 'data-id': t.id },
    h('span', { class: 'name' }, coord ? taskmasterLabel(t.project_id) : [h('span', { class: 'num' }, t.number ?? t.id), ' ', t.title]),
    t.queued ? h('span', { class: 'queued' }, `✉ ${t.queued}`) : '',
    h('span', { class: `state ${st.cls}` }, st.cell),
    note ? h('span', { class: `note${working ? ' t' : ''}` }, note) : '');
}

/** "now", "5m", "3h", "2d": ages for tight spaces. */
function shortAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
