// The scheme switcher and the minions list: new-minion box, search and rows.
import { weekShare } from './cost.js';
import { account, ago, api, costText, h, isCoordinator, isSeen, jumpHref, listGroupsOf, schemeIcon, setView, statusLabel, taskmasterLabel, TYPES, threadFullName, threadHref, view } from './base.js';
import { app, crumbs, openHash, sending, setSending, usage } from './core.js';
import { fitHeight, loadDraft, saveDraft } from './composer.js';
import { propFilter, renderPropFilter } from './properties.js';
import { matchesPicks } from './propfilter.js';
import { threadMatches, threadSections } from './threadgroups.js';
import { withoutCount } from './progress.js';
import { startScheme } from './schemes.js';
import { byUrgency, cardChip, rowBar, rowState, rowUnread, SHIP } from './threadstate.js';
import { stepTrack, waitBar, waitClock, waitWords } from './wait.js';
import { refreshSchemeCounts, renderInbox, schemeCount } from './inbox.js';
import { replaceHash } from './navstack.js';
import { continueList } from './ui/composer.js';

// ---------- projects ----------

export const LAST_SCHEME = 'cc-scheme'; // the scheme this browser last had open

/** The app's front door: open the last scheme (or Citadel, or the first); with none, offer to make one. */
export async function openStartScheme() {
  const projects = await api('api/projects');
  let last = NaN;
  try { last = Number(localStorage.getItem(LAST_SCHEME)); } catch {}
  // A hidden scheme only opens by itself when it was the last one open, or every one is hidden (#226).
  const shown = projects.filter((p) => !p.hidden || p.id === last);
  const id = startScheme(shown.length ? shown : projects, last);
  if (id != null) return replaceHash(`#/p/${id}`); // replace: Back shouldn't bounce through here
  setView({ kind: 'projects' });
  crumbs.replaceChildren('New scheme');
  app.replaceChildren(h('div', { class: 'card new-scheme' }, h('h2', {}, 'New scheme'), newSchemeForm()));
}

/** Where a new scheme's code comes from. */
const SOURCES = [
  // Anyone's own, once they've linked GitHub (#195); an admin's goes under the Citadel-wide owner.
  { value: 'new', label: 'New repo (private, on GitHub too)', linked: true },
  { value: 'url', label: 'Clone from a URL', field: 'repoUrl', placeholder: 'https://github.com/caraminden/gamedevtest.git' },
  { value: 'folder', label: 'Clone a folder on perigee', field: 'folder', placeholder: '~/projects/…', admin: true },
  { value: 'none', label: 'No code (docs, research, art)' },
];

/** Picked at first, as the mockup has. */
const DEFAULT_SOURCE = 'new';

/** Name, code source and what it's about for a new scheme; on success it opens the scheme. */
function newSchemeForm() {
  const admin = !!account?.admin;
  const sources = SOURCES.filter((s) => !s.admin || admin).map((s) => h('label', { class: 'source' },
    h('input', { type: 'radio', name: 'source', value: s.value, checked: s.value === (admin ? DEFAULT_SOURCE : 'none'), disabled: !!s.linked && !admin }),
    h('span', {}, s.label),
    s.field ? h('input', { name: s.field, 'data-draft': true, placeholder: s.placeholder }) : '',
    s.linked && !admin ? h('span', { class: 'source-note muted', hidden: true }) : ''));
  const form = h('form', {},
    h('label', {}, 'Name', h('input', { name: 'name', required: true, maxlength: 80, 'data-draft': true })),
    h('fieldset', { class: 'sources' }, h('legend', {}, 'Code'), ...sources),
    h('label', {}, "What's it about? (the Taskmaster starts from this)",
      h('textarea', { name: 'about', rows: 3, maxlength: 4000, 'data-draft': true, placeholder: 'What it is, who it is for, the first milestone' })),
    h('p', { class: 'error', hidden: true }),
    h('div', { class: 'row create-buttons' },
      h('button', { type: 'submit', value: 'setup' }, 'Create and set up'),
      h('button', { type: 'submit', value: 'only', class: 'secondary' }, 'Create only')));
  // Only the picked source's field shows.
  const showField = () => {
    for (const l of form.querySelectorAll('label.source')) {
      const field = l.querySelector('input:not([type=radio])');
      if (field) field.hidden = !l.querySelector('input[type=radio]').checked;
    }
  };
  let touched = false;
  form.addEventListener('change', () => { touched = true; showField(); });
  showField();
  if (!admin) linkedRepo(form, () => { if (!touched) { form.source.value = DEFAULT_SOURCE; showField(); } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter ?? form.querySelector('button[type=submit]');
    const label = btn.textContent;
    const err = form.querySelector('.error');
    const source = form.source.value;
    for (const b of form.querySelectorAll('button[type=submit]')) b.disabled = true;
    btn.textContent = source === 'url' || source === 'folder' ? 'Cloning…' : 'Creating…';
    try {
      // Only the picked source's own field: a non-admin's form has no folder field at all.
      const field = SOURCES.find((s) => s.value === source)?.field;
      const p = await api('api/projects', { method: 'POST', body: {
        name: form.name.value, source, ...(field && { [field]: form.elements[field].value }), about: form.about.value, setup: btn.value === 'setup',
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

/**
 * A non-admin's "New repo" goes on their own GitHub, so it waits on their link (#195): enabled and
 * named for their account once linked, otherwise a pointer to where they link it.
 */
async function linkedRepo(form, onLinked) {
  const radio = form.querySelector('input[name=source][value=new]');
  const label = radio.closest('label');
  const note = label.querySelector('.source-note');
  const gh = await api('api/me/github').catch(() => null);
  const login = gh?.configured && gh.link && !gh.link.failed ? gh.link.login : null;
  if (login) {
    radio.disabled = false;
    label.querySelector('span').textContent = `New repo (private, on your GitHub, @${login})`;
    return onLinked();
  }
  const scheme = view?.projectId ?? view?.projects?.[0]?.id;
  note.replaceChildren(gh?.link?.failed ? 'Link GitHub again in ' : 'Link GitHub in ',
    scheme != null ? h('a', { href: `#/p/${scheme}/account`, onclick: () => form.closest('dialog')?.close() }, 'Settings → Your account') : 'Settings → Your account',
    ' to make one on your own account.');
  note.hidden = false;
}

/** The new-scheme form in a modal: a centred box on desktop, a sheet along the bottom on phones. */
export function openNewScheme() {
  const dialog = h('dialog', { class: 'cui-dialog new-scheme', 'aria-label': 'New scheme' },
    h('div', { class: 'cui-dialog-head' }, h('h2', {}, 'New scheme'),
      h('button', { type: 'button', class: 'close', 'aria-label': 'Close', onclick: () => dialog.close() }, '×')),
    newSchemeForm());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

let closeSchemeMenu = () => {};

/** A small menu of the schemes under the switcher button, with the new-scheme entry at the end. */
export function toggleSchemeMenu(button) {
  if (document.getElementById('scheme-menu')) return closeSchemeMenu();
  const menu = h('div', { id: 'scheme-menu', class: 'scheme-menu' },
    view.projects.filter((p) => !p.hidden || p.id === view.projectId).map((p) => h('a', { class: `nav-item${p.id === view.projectId ? ' active' : ''}`, href: `#/p/${p.id}`, title: p.name, onclick: () => closeSchemeMenu() },
      schemeIcon(p), h('span', { class: 'name', 'data-project-name': p.id }, p.name), schemeCount(p))),
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
  // Never under the app rail (z-index 50, over the menu): the switch sits near the panel's left edge.
  const rail = document.querySelector('.citadel-rail')?.getBoundingClientRect().right || 0;
  menu.style.left = `${Math.max(rail + 8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  // The counts came with the page; other schemes' minions have moved since, so fetch them again.
  refreshSchemeCounts();
}

export function newTicketForm(projectId) {
  // A one-line chat box: what you type becomes the new thread's first message. The thread names
  // and types itself from it, and every thread gets full access.
  const box = h('textarea', { name: 'message', required: true, rows: 1, placeholder: 'New minion: what should it work on?', 'aria-label': 'Start a new minion', 'data-draft': true });
  const err = h('p', { class: 'error cui-notice', 'data-tone': 'danger', role: 'alert', hidden: true });
  const form = h('form', { class: 'new-thread' }, box, err);
  const fit = () => fitHeight(box);
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
    if (continueList(box, e)) return;
    // Enter sends (on phones too, unlike the chat composer), Shift+Enter adds a line (or the next item in a numbered list), IME composition is left alone.
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

/** A promoted group's heading: its value's label in the registry, or the value capitalised ("area: balance" → "Balance"). */
function groupHeading(group) {
  const [key, value] = group.split(/:(.*)/).map((x) => x.trim());
  const label = propFilter.projectId === view.projectId && propFilter.keys?.find((k) => k.key === key)?.values?.find((v) => v.value === value)?.label;
  return label || value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A build's heading; one with a branch (src/builds.ts) also says how many feeders are merged in and open,
 * and how far it is behind main, and in this server's own scheme links the branch's preview (src/previews.ts).
 */
function buildHeading(s) {
  const b = view.builds?.find((x) => x.build === s.build);
  return ['Build ', s.build, s.current ? h('span', { class: 'muted' }, ' current') : '',
    b ? h('span', { class: 'build-counts muted' }, `${b.merged} merged in · ${b.open} open · ${b.behind} behind main`,
      view.buildPreviews ? [' · ', h('a', { href: `../preview/build/${b.build}/`, target: '_blank', rel: 'noopener', title: `build/${b.build}'s tip on a copy of the data` }, 'Preview')] : '') : ''];
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
  const sections = threadSections(open, Object.keys(TYPES), listGroupsOf(view.project)).map((s) =>
    h('section', { class: `thread-group g-${s.build ? 'build' : s.group ? 'promoted' : s.key}` },
      h('h3', {}, s.build ? buildHeading(s) : s.key === 'parked' ? 'Parked' : s.group ? groupHeading(s.group) : TYPES[s.type].section),
      s.rows.sort((a, b) => byUrgency(a, b, usage)).map((t) => threadRow(t))));
  // Your pins (#179) on top, oldest pin first: a second copy of each row, which keeps its place below. A dismissed minion's pin waits, hidden, until it is reopened.
  const byId = new Map(open.map((t) => [t.id, t]));
  const pinned = (view.pins ?? []).map((id) => byId.get(id)).filter(Boolean);
  const pinnedGroup = pinned.length ? h('section', { class: 'thread-group g-pinned' }, h('h3', {}, 'Pinned'), pinned.map((t) => threadRow(t))) : '';
  let closedGroup = '';
  if (closed.length) {
    // Closed threads stay out of the way but can still be opened and reopened.
    closedGroup = h('details', { class: 'thread-group g-closed', open: view.showClosed }, h('summary', {}, 'Dismissed'), closed.map((t) => threadRow(t)));
    closedGroup.addEventListener('toggle', () => { view.showClosed = closedGroup.open; });
  }
  el.replaceChildren(
    pinnedGroup, ...sections, closedGroup,
    !all.length ? h('p', { class: 'empty-state' }, 'No minions yet. Ask the Taskmaster to start one, or type in the box above.')
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

// The threads search, kept across thread switches within a project. `meaning`: the last search of
// the chats by meaning (#488), which only Enter or its button runs: each costs the box a CPU-second.
const threadSearch = { projectId: null, q: '', meaning: null };

export function threadSearchBox(projectId) {
  if (threadSearch.projectId !== projectId) Object.assign(threadSearch, { projectId, q: '', meaning: null });
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
    if (e.key === 'Enter' && threadSearch.q.length >= 2) searchByMeaning();
  });
  return input;
}

/** Search the scheme's chats by meaning for the box's text; the answer shows under the title results. */
async function searchByMeaning() {
  const { projectId, q, meaning } = threadSearch;
  if (meaning?.busy && meaning.q === q) return; // a held Enter repeats: one search at a time
  const run = (threadSearch.meaning = { q, busy: true });
  renderSidebar();
  try {
    run.hits = (await api(`api/projects/${projectId}/memory?q=${encodeURIComponent(q)}&limit=10`)).hits;
  } catch (err) {
    run.error = err.message;
  }
  run.busy = false;
  if (threadSearch.meaning === run) renderSidebar(); // a newer search, or another scheme, owns the list now
}

/** One chunk the search found: its minion and date, linked to the message (or the minion), and what was said. */
function meaningHit(hit) {
  const t = { project_id: threadSearch.projectId, number: hit.number, id: hit.ticket_id, kind: hit.kind };
  const href = hit.source_kind === 'turn' ? jumpHref(t, hit.source_id) : threadHref(t);
  const day = new Date(hit.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return h('a', { class: 'meaning-hit', href, title: hit.text },
    h('span', { class: 'name' }, isCoordinator(t) ? taskmasterLabel(t.project_id) : [h('span', { class: 'num' }, hit.number), ' ', hit.title], h('span', { class: 'muted' }, ` · ${day}`)),
    h('span', { class: 'snippet' }, hit.text));
}

/** The chats-by-meaning part of the results: a button until it runs, then what it found. */
function meaningSection() {
  const { q, meaning } = threadSearch;
  const ran = meaning?.q === q ? meaning : null;
  const button = h('button', { type: 'button', class: 'secondary meaning-go', disabled: q.length < 2 || ran?.busy, onclick: searchByMeaning },
    ran?.busy ? 'Searching chats…' : ran ? 'Search again' : 'Search chats by meaning ⏎');
  const body = !ran || ran.busy ? h('p', { class: 'muted small' }, 'What people and minions said, closest in meaning first, not just exact words.')
    : ran.error ? h('p', { class: 'muted small' }, ran.error)
    : ran.hits.length ? ran.hits.map(meaningHit)
    : h('p', { class: 'muted small' }, 'Nothing in the chats comes close.');
  return h('section', { class: 'column meaning', 'aria-busy': ran?.busy ? 'true' : 'false' },
    h('h3', {}, 'In chats, by meaning', ran?.hits ? h('span', { class: 'count' }, ran.hits.length) : ''), button, body);
}

/** Search results: threads whose title, number or properties match, then the chats by meaning. */
function renderThreadResults(el, tickets) {
  // The Taskmaster's row stays above the search, so results are minions only.
  const results = tickets.filter((t) => threadMatches(t, threadSearch.q));
  el.replaceChildren(
    h('section', { class: 'column' },
      h('h3', {}, 'Results', h('span', { class: 'count' }, results.length)),
      results.length
        ? results.map((t) => threadRow(t))
        : h('div', { class: 'empty-state' },
          h('p', {}, 'No minion has “', threadSearch.q.trim(), '” in its title, number or properties.'),
          h('button', { type: 'button', class: 'secondary small', onclick: () => {
            const input = document.querySelector('.thread-search');
            if (!input) return;
            input.value = '';
            input.dispatchEvent(new Event('input'));
            input.focus();
          } }, 'Clear search'))),
    meaningSection());
}

/** One compact row: number + short ask and the state on top, the thread's note (or what it is doing) below. */
export function threadRow(t, href = threadHref(t)) {
  const coord = isCoordinator(t);
  // The coordinator is always there to talk to; only show when it is busy.
  const st = coord && t.status !== 'running' ? { fam: '', cell: '', label: statusLabel(t) } : rowState(t, usage);
  const quiet = st.fam === 'work' || st.fam === 'idle' || st.fam === 'wait';
  // The state cell already shows steps done, so the activity line drops its own count.
  const activity = st.counted && t.last_activity ? withoutCount(t.last_activity) : t.last_activity;
  const note = (t.status === 'running' ? activity : t.note || activity) || '';
  const share = t.host_cost && weekShare(t.host_cost); // the meter is the server login's plan
  // People's own note (#146), on a line of its own so the minion's note keeps its place.
  const pnote = !coord && view.personNotes?.[t.id];
  const details = [
    threadFullName(t),
    [st.label, t.queued ? `${t.queued} queued` : '', coord ? '' : `started by ${t.created_by}`, !coord && t.parent ? `from #${t.parent}` : '', `updated ${ago(t.updated_at)}`, t.cost ? `${share ? `${share} of the server login's weekly limit, ` : ''}${costText(t.cost)} at API prices` : ''].filter(Boolean).join(' · '),
    note,
    !coord && t.status !== 'closed' && t.wait ? waitWords(t.wait) : '',
    !coord && t.ship ? `${t.ship.text} · ${t.ship.commit}` : '',
    pnote ? `✎ ${pnote.text} (${pnote.by})` : '',
  ].filter(Boolean).join('\n');
  const shipStage = !coord && t.status !== 'closed' && SHIP[t.ship?.stage];
  const wait = !coord && t.status !== 'closed' && t.wait;
  // A wait says more than the ship badge ("restart · 2 turns" over "deploying"), so the row shows one.
  const ship = shipStage?.badge && !wait ? h('span', { class: `ship-badge f-${shipStage.fam}`, title: `${t.ship.text} · ${t.ship.commit}` }, shipStage.badge) : '';
  // The chat head's bar (#573), only while it works or waits on a land, CI or a deploy (threadstate.js rowBar).
  const barOf = rowBar({ ...t, wait }, st);
  const bar = !barOf ? '' : barOf.track ? stepTrack(barOf) : waitBar(barOf);
  const card = cardBadge(t.open_cards ?? []);
  const active = view.id === t.id;
  // Rows waiting on you get a tint of their colour, stronger until you've opened them since they changed.
  // Unread (a dot and a bold title) marks a row with something for a person that changed since you last opened it.
  const yours = !coord && st.rank === 0 ? ' yours' : '';
  const unread = !coord && rowUnread(t, st, isSeen(t)) ? ' unread' : '';
  // No one-tap replies on list rows (#130): a stray tap on "Merge it" would ship work nobody opened.
  return h('a', { class: `thread-row s-${t.status} f-${st.fam || 'none'}${coord ? ' coordinator' : ''}${yours}${unread}${active ? ' active' : ''}`, href, title: details, 'data-id': t.id },
    h('span', { class: 'name' }, coord ? taskmasterLabel(t.project_id) : [h('i', { class: 'unread-dot' }), h('span', { class: 'num' }, t.number ?? t.id), ' ', t.title]),
    t.queued ? h('span', { class: 'queued' }, `✉ ${t.queued}`) : '',
    card,
    st.cell ? h('span', { class: 'state' }, st.pulse && h('i', { class: 'pulse' }), st.cell) : '',
    wait ? h('span', { class: `note${quiet && !unread ? ' t' : ''}` }, waitWords(wait), ' · ', waitClock(wait))
      : note || ship ? h('span', { class: `note${quiet && !unread ? ' t' : ''}` }, ship, note) : '',
    t.cost ? h('span', { class: 'cost' }, share ? `${share} wk` : costText(t.cost)) : '',
    pnote ? h('span', { class: 'pnote' }, `✎ ${pnote.text}`) : '',
    bar);
}

/**
 * The row's open-card badge (#575, Cara 2026-11-11: "shows if they have a pending card (maybe you missed it?)
 * clicking that indicator specifically would open to the card"): it stays until the cards are answered or settled,
 * read or not, and opens the oldest. `cards` is the row's open_cards (Runner.cardLinks), oldest first.
 */
function cardBadge(cards) {
  if (!cards.length) return '';
  const go = (e) => {
    // The row is a link to the chat; this goes to the card in it instead, in a new tab as a link would on ctrl or middle click.
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) window.open(new URL(cards[0].href, location.href).href, '_blank');
    else openHash(cards[0].href);
  };
  const what = `${cards[0].kind} card${cards[0].label ? ` "${cards[0].label}"` : ''}`;
  return h('span', {
    class: 'card-badge', role: 'link', tabindex: 0,
    title: cards.length > 1 ? `${cards.length} cards wait on you: open the oldest, the ${what}` : `Open the ${what}`,
    onclick: go, onauxclick: (e) => { if (e.button === 1) go(e); }, onkeydown: (e) => { if (e.key === 'Enter') go(e); },
  }, cardChip(cards));
}
