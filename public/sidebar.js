// The scheme switcher and the minions list: search and rows.
import { weekShare } from './cost.js';
import { gloss } from './help-words.js';
import { account, ago, todayPacific, api, costText, dismissedWhen, h, noAutofill, isCoordinator, isSeen, jumpHref, listGroupsOf, me, setView, statusLabel, taskmasterLabel, TYPES, threadFullName, threadHref, view } from './base.js';
import { app, crumbs, openHash, usage } from './core.js';
import { propFilter, renderPropFilter } from './properties.js';
import { matchesPicks } from './propfilter.js';
import { threadMatches, threadSections } from './threadgroups.js';
import { withoutCount } from './progress.js';
import { startScheme } from './schemes.js';
import { othersIn, presenceChip } from './presence.js';
import { refreshWelcome, welcomePanel } from './welcome.js';
import { byUrgency, cardChip, cardsYours, rowBar, rowState, rowUnread, rowWhy, SHIP, workingBy } from './threadstate.js';
import { progressTrack, waitBar, waitClock, waitLine, waitWords } from './wait.js';
import { renderInbox } from './inbox.js';
import { pendingRelease, releaseOrder } from './releases.js';
import { replaceHash } from './navstack.js';
import { openDialog } from './ui/dialog.js';
import { mountTips } from './ui/tip.js';
import { toast } from './ui/status.js';

// ---------- projects ----------

export const LAST_SCHEME = 'cc-scheme'; // the scheme this browser last had open

/** Your schemes the shelf lists above the minimized ones (#1243): not hidden or minimized, and yours (#674). Home (#1140) shows for two or more. */
export const shelfSchemes = (projects) => (projects ?? []).filter((p) => !p.hidden && !p.minimized && p.member !== false);

/** The app's front door: Home when you're in two or more schemes (#1140; Josh, 2026-11-19: "Always opens to Home"), else the last scheme (or Citadel, or the first); with none, offer to make one. */
export async function openStartScheme() {
  const projects = await api('api/projects');
  if (shelfSchemes(projects).length > 1) return replaceHash('#/home');
  let last = NaN;
  try { last = Number(localStorage.getItem(LAST_SCHEME)); } catch {}
  // A hidden scheme, or one you aren't a member of (#674), only opens by itself when it was the last one open, or there's no other.
  const shown = projects.filter((p) => (!p.hidden && p.member !== false) || p.id === last);
  const id = startScheme(shown.length ? shown : projects, last);
  if (id != null) return replaceHash(`#/p/${id}`); // replace: Back shouldn't bounce through here
  setView({ kind: 'projects' });
  crumbs.replaceChildren('New scheme');
  // In no scheme yet (#1151): the welcome says how to get into one, over the form to make one.
  const welcome = welcomePanel(null, []);
  if (welcome) refreshWelcome();
  app.replaceChildren(...(welcome ? [welcome] : []), h('div', { class: 'card new-scheme' }, h('h2', {}, 'New scheme'), newSchemeForm()));
}

/** The scheme Home (#1140) loads under it, for the chats it opens: the one on screen, else the last one open, else the start scheme. */
export async function homeScheme() {
  const projects = view?.projects?.length ? view.projects : await api('api/projects');
  const shown = shelfSchemes(projects);
  if (view?.kind === 'project' && shown.some((p) => p.id === view.projectId)) return view.projectId;
  let last = NaN;
  try { last = Number(localStorage.getItem(LAST_SCHEME)); } catch {}
  return startScheme(shown.length ? shown : projects, last);
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
  openDialog({ title: 'New scheme', className: 'new-scheme', body: newSchemeForm() });
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

/** The resting sections' headings (threadgroups.js threadSections). */
const REST = { deploying: 'Deploying', waiting: 'Waiting', parked: 'Parked' };

export function renderSidebar() {
  const el = document.getElementById('threads');
  if (!el) return;
  // Each minion's change on its way in a release (#764): its row says which, and a dismissed one stays under Deploying till it's live.
  const all = [...view.tickets.values()].map((t) => {
    const release = pendingRelease(t);
    return release ? { ...t, release } : t;
  });
  document.getElementById('coordinator-row')?.replaceChildren(threadRow(view.coordinator, `#/p/${view.projectId}`));
  renderPropFilter();
  // The property filter narrows open and dismissed minions alike; the Taskmaster always shows.
  const picks = propFilter.projectId === view.projectId ? propFilter.picks : new Map();
  const tickets = picks.size ? all.filter((t) => matchesPicks(t, picks)) : all;
  // Its count depends on which minions you've seen, which changes with the rows.
  renderInbox();
  if (threadSearch.q) return renderThreadResults(el, tickets.sort((a, b) => b.updated_at - a.updated_at));
  const open = tickets.filter((t) => t.status !== 'closed' || t.release);
  const closed = tickets.filter((t) => t.status === 'closed' && !t.release).sort((a, b) => b.updated_at - a.updated_at);
  const sections = threadSections(open, Object.keys(TYPES), listGroupsOf(view.project), releaseOrder()).map((s) =>
    h('section', { class: `thread-group g-${s.build ? 'build' : s.group ? 'promoted' : s.key}` },
      h('h3', {}, s.build ? buildHeading(s) : s.key === 'parked' ? gloss('parked', REST.parked) : s.key in REST ? REST[s.key] : s.group ? groupHeading(s.group) : TYPES[s.type].section),
      s.rows.sort((a, b) => byUrgency(a, b, usage)).map((t) => threadRow(t))));
  // Your pins (#179) on top, oldest pin first: a second copy of each row, which keeps its place below. A dismissed minion's pin waits, hidden, until it is reopened.
  const byId = new Map(open.filter((t) => t.status !== 'closed').map((t) => [t.id, t]));
  const pinned = (view.pins ?? []).map((id) => byId.get(id)).filter(Boolean);
  const pinnedGroup = pinned.length ? h('section', { class: 'thread-group g-pinned' }, h('h3', {}, 'Pinned'), pinned.map((t) => threadRow(t))) : '';
  const head = [pinnedGroup, ...sections];
  const tail = [!all.length ? h('p', { class: 'empty-state' }, 'No minions yet. Ask the Taskmaster to start one.')
    : !tickets.length ? h('p', { class: 'muted small' }, 'No minions match the filter.') : ''];
  if (!closed.length) {
    closedRows.clear();
    return finish(el, head, tail);
  }
  // Closed threads stay out of the way but can still be opened and reopened.
  // Their rows are built only while the list is open, and a row is reused until its minion or what it shows changes (#1077, #1080):
  // a big scheme has a thousand, and every minion update redraws.
  closedGroup ??= dismissedGroup();
  closedGroup.open = view.showClosed;
  fillClosed(closed);
  // The list stays in the page while the rest is swapped, so a redraw doesn't restyle its rows.
  if (closedGroup.parentNode !== el) el.replaceChildren(...head, closedGroup, ...tail);
  else {
    for (const c of [...el.childNodes]) if (c !== closedGroup) c.remove();
    closedGroup.before(...head.filter(Boolean));
    closedGroup.after(...tail.filter(Boolean));
  }
  if (whyTips?.open) whyTips.refresh();
}

function finish(el, head, tail) {
  el.replaceChildren(...head, ...tail);
  // An open chip popover follows its chip into the new rows (tip.js); its words follow the minion's news.
  if (whyTips?.open) whyTips.refresh();
}

let closedGroup = null, closedList = [];
const closedRows = new Map();
// The rows' stamps change words with the Pacific day, and their cost shares with the plan's usage (replaced, never changed in place) and the weekly limit (cost.js).
let closedUsage = null, closedDay = '', closedShare = null;

function dismissedGroup() {
  const g = h('details', { class: 'thread-group g-closed' }, h('summary', {}, 'Dismissed'));
  g.addEventListener('toggle', () => {
    view.showClosed = g.open;
    if (g.open) renderSidebar();
  });
  return g;
}

/** What a dismissed row shows besides its minion: when any of it changes the row is built again. */
function closedKey(t) {
  const note = view.personNotes?.[t.id];
  return `${view.id === t.id}|${isSeen(t)}|${ago(t.updated_at)}|${note ? `${note.text}${note.by}` : ''}|${othersIn(t).join()}|${me}`;
}

/** Fills the Dismissed list with its rows (none while it is shut), building only the rows that are new or changed. */
function fillClosed(closed) {
  const rows = [];
  if (view.showClosed) {
    const day = todayPacific();
    const share = weekShare(1);
    if (closedUsage !== usage || closedDay !== day || closedShare !== share) closedRows.clear();
    closedShare = share;
    closedDay = day;
    closedUsage = usage;
    const live = new Set();
    for (const t of closed) {
      live.add(t.id);
      const key = closedKey(t), hit = closedRows.get(t.id);
      if (hit && hit.t === t && hit.key === key) rows.push(hit.row);
      else {
        const row = threadRow(t);
        closedRows.set(t.id, { t, key, row });
        rows.push(row);
      }
    }
    for (const id of closedRows.keys()) if (!live.has(id)) closedRows.delete(id);
  } else closedRows.clear();
  // In place: a row already where it belongs isn't touched.
  if (rows.length === closedList.length && rows.every((r, i) => r === closedList[i]) && closedGroup.childElementCount === rows.length + 1) return;
  let at = closedGroup.firstElementChild.nextElementSibling;
  for (const r of rows) {
    if (r === at) at = at.nextElementSibling;
    else closedGroup.insertBefore(r, at);
  }
  while (at) {
    const next = at.nextElementSibling;
    at.remove();
    at = next;
  }
  closedList = rows;
}
/** Scroll the minion list (not the page) so the open minion's row is in view, after you navigate to one. */
export function revealActiveRow() {
  const box = document.getElementById('threads')?.closest('.sidebar');
  if (!box?.open) return;
  let row = box.querySelector('#threads .thread-row.active');
  // A dismissed minion's row isn't built while its list is shut (renderSidebar): open the list for the one you're on.
  if (!row && !view.showClosed && view.tickets?.get(view.id)?.status === 'closed') {
    view.showClosed = true;
    renderSidebar();
    row = box.querySelector('#threads .thread-row.active');
    // The property filter hides it: the list stays shut.
    if (!row) {
      view.showClosed = false;
      renderSidebar();
    }
  }
  if (!row) return;
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
  const input = h('input', { type: 'search', class: 'thread-search', placeholder: 'Search titles, numbers and properties…', value: threadSearch.q, ...noAutofill('thread-search') });
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
  const st = coord && !workingBy(t) ? { fam: '', cell: '', label: statusLabel(t) } : rowState(t, usage);
  const quiet = st.fam === 'work' || st.fam === 'idle' || st.fam === 'wait';
  // The state cell already shows steps done, so the activity line drops its own count.
  const activity = st.counted && t.last_activity ? withoutCount(t.last_activity) : t.last_activity;
  // A minion setting up its first turn has no activity yet: a word holds the subtitle's line, so the row doesn't grow (#696).
  // A dismissed minion's row says when, in Pacific (#1072); its full date and time is the hover.
  const gone = !coord && st.label === 'Dismissed' ? dismissedWhen(t.closed_at) : null;
  const note = (t.status === 'running' ? activity : t.note || activity) || (st.rank !== 1 ? '' : st.server ? st.label : t.status === 'new' ? 'Starting…' : 'Working…');
  const share = t.host_cost && weekShare(t.host_cost); // the meter is the server login's plan
  // People's own note (#146), on a line of its own so the minion's note keeps its place.
  const pnote = !coord && view.personNotes?.[t.id];
  const details = [
    threadFullName(t),
    [gone ? `Dismissed ${gone.full}` : st.label, t.queued ? `${t.queued} queued` : '', coord ? '' : `started by ${t.created_by}`, !coord && t.parent ? `from #${t.parent}` : '', `updated ${ago(t.updated_at)}`, t.cost ? `${share ? `${share} of the server login's weekly limit, ` : ''}${costText(t.cost)} at API prices` : ''].filter(Boolean).join(' · '),
    note,
    !coord && t.status !== 'closed' && t.wait ? waitWords(t.wait) : '',
    !coord && t.ship ? `${t.ship.text} · ${t.ship.commit}` : '',
    pnote ? `✎ ${pnote.text} (${pnote.by})` : '',
  ].filter(Boolean).join('\n');
  const shipStage = !coord && t.status !== 'closed' && SHIP[t.ship?.stage];
  const wait = !coord && t.status !== 'closed' && t.wait;
  // Landed and on its way (#1019): the row says where its release is ("Windows: desktop waiting for a CI runner · 22m"), not the minion's last note.
  const rel = !coord && !wait && (t.status === 'closed' || t.state === 'pending-deploy') && t.release;
  // A wait says more than the ship badge ("restart · 2 turns" over "deploying"), so the row shows one.
  const ship = shipStage?.badge && !wait ? h('span', { class: `ship-badge f-${shipStage.fam}`, title: `${t.ship.text} · ${t.ship.commit}` }, shipStage.badge) : '';
  // The chat head's bar (#573), only while it works or waits on a land, CI or a deploy (threadstate.js rowBar).
  const barOf = rowBar({ ...t, wait }, st);
  const bar = !barOf ? '' : progressTrack(barOf) || waitBar(barOf);
  // A running turn's unanswered spend alert (#723) leads the card badge, in red, and tints the row.
  const spend = !coord && t.spend_alert;
  const card = cardBadge([...(spend ? [{ kind: 'spend alert', what: `! $${spend.usd}`, href: spend.href }] : []), ...(t.open_cards ?? [])], spend, !spend && !cardsYours(t).length);
  const active = view.id === t.id;
  // Rows waiting on you get a tint of their colour, stronger until you've opened them since they changed.
  // Unread (a dot and a bold title) marks a row with something for a person that changed since you last opened it.
  const yours = !coord && st.rank === 0 ? ' yours' : '';
  const unread = !coord && rowUnread(t, st, isSeen(t)) ? ' unread' : '';
  // No one-tap replies on list rows (#130): a stray tap on "Merge it" would ship work nobody opened.
  return h('a', { class: `thread-row s-${t.status} f-${st.fam || 'none'}${coord ? ' coordinator' : ''}${yours}${unread}${spend ? ' spend' : ''}${active ? ' active' : ''}`, href, title: details, 'data-id': t.id },
    h('span', { class: 'name' }, coord ? taskmasterLabel(t.project_id) : [h('i', { class: 'unread-dot' }), h('span', { class: 'num' }, t.number ?? t.id), ' ', t.title]),
    t.queued ? h('span', { class: 'queued' }, `✉ ${t.queued}`) : '',
    // Messages the loop guard holds for a person (#1067; Josh, 2026-11-19: "a minion badge for the loop guard"): Continue is in its chat.
    t.loop_hold ? h('span', { class: 'loop-badge', title: `The loop guard holds ${t.loop_hold.n === 1 ? 'a message' : `${t.loop_hold.n} messages`} here: open the chat to continue` }, `⏸ ${t.loop_hold.n}`) : '',
    card,
    st.cell ? stateChip(t, st) : '',
    presenceChip(t),
    ownerChip(t, coord),
    wait ? h('span', { class: `note${quiet && !unread ? ' t' : ''}` }, st.server ? 'Server: ' : '', waitLine(wait), ' · ', waitClock(wait))
      : rel ? h('span', { class: `note${quiet && !unread ? ' t' : ''}` }, `${rel.target}: ${rel.text || rel.stage}`, rel.since ? [' · ', waitClock({ since: rel.since })] : '')
      : note || ship || gone ? h('span', { class: `note${quiet && !unread ? ' t' : ''}` }, ship, gone ? h('span', { class: 'closed-at', title: gone.full }, `Dismissed ${gone.short}`) : '', gone && note ? ' · ' : '', note) : '',
    t.cost && !(share && share.startsWith('<')) ? h('span', { class: 'cost' }, share ? `${share} wk` : costText(t.cost)) : '',
    pnote ? h('span', { class: 'pnote' }, `✎ ${pnote.text}`) : '',
    bar);
}

/** The rows drawn last, by id, for their chips' popovers; a check's answer per minion while its popover shows it. */
const drawn = new Map(), checks = new Map();
let whyTips = null;

/**
 * The state chip (#906; Cara picked "Popover on the chip only", 2026-11-17): a tap or hover opens why it says what it
 * says (threadstate.js rowWhy). Its empty title keeps the row's own tooltip off it. A quiet turn's dot stops.
 */
function stateChip(t, st) {
  drawn.set(t.id, { t, st });
  whyTips ??= mountTips(document.body, { selector: '.thread-row .state[data-tip-id]', body: (el) => whyBody(Number(el.dataset.tipId)), role: 'dialog', label: 'Why', tapOpens: true, className: 'why-tip' });
  return h('span', { class: `state${st.quiet ? ' quiet' : ''}`, 'data-tip-id': t.id, tabindex: 0, title: '', 'aria-label': `${st.cell}: ${st.label}` },
    st.pulse ? h('i', { class: 'pulse' }) : st.quiet ? h('i', { class: 'still' }) : '', st.cell);
}

function whyBody(id) {
  const row = drawn.get(id);
  if (!row) return null;
  const { t, st } = row, why = rowWhy(t, st);
  const check = checks.get(id);
  return h('div', { class: `why f-${st.fam || 'none'}` },
    h('b', { class: 'why-title' }, why.title),
    why.lines.map((l) => h('p', {}, l)),
    why.more ? h('p', { class: 'why-more' }, why.more) : '',
    check ? h('p', { class: `why-check${check.busy ? ' busy' : ''}` }, check.busy ? 'Checking the turn\'s process…' : check.text) : '',
    why.quiet ? h('div', { class: 'why-acts' },
      h('button', { type: 'button', class: 'secondary act-stop', onclick: () => stopTurn(t) }, 'Stop'),
      h('button', { type: 'button', class: 'secondary', disabled: !!check?.busy, onclick: () => checkTurn(t) }, 'Is this still going?')) : '',
    why.link ? h('a', { href: why.link.href, onclick: () => whyTips?.close() }, why.link.text) : '');
}

function stopTurn(t) {
  whyTips?.close();
  api(`api/tickets/${t.id}/stop`, { method: 'POST', body: {} }).catch((e) => toast(`Couldn't stop #${t.number}: ${e.message}`, { tone: 'warn', ms: 8000 }));
}

/** The server looks at the turn's process (src/quiet.ts checkProcess): no model call, no message to the minion. */
async function checkTurn(t) {
  checks.set(t.id, { busy: true });
  whyTips?.refresh();
  try {
    const r = await api(`api/tickets/${t.id}/check`, { method: 'POST', body: {} });
    checks.set(t.id, { text: r.text });
  } catch (e) {
    checks.set(t.id, { text: `Couldn't check: ${e.message}` });
  }
  if (whyTips?.open?.dataset.tipId === String(t.id)) whyTips.refresh();
}

/** Whose minion it is (#690): the owner's initial at the row's end, ringed when it's yours; nothing for nobody's or the Taskmaster. */
function ownerChip(t, coord) {
  const owner = !coord && String(t.properties?.assigned ?? '').trim();
  if (!owner) return '';
  if (owner.toLowerCase() === me?.toLowerCase()) return ''; // your own initial on every row says nothing; only other people's mark a row (#881)
  return h('span', { class: 'owner', title: `${owner}'s`, 'aria-label': `Owner: ${owner}` }, owner[0].toUpperCase());
}

/**
 * The row's open-card badge (#575, Cara 2026-11-11: "shows if they have a pending card (maybe you missed it?)
 * clicking that indicator specifically would open to the card"): it stays until the cards are answered or settled,
 * read or not, and opens the oldest. `cards` is the row's open_cards (Runner.cardLinks), oldest first.
 */
function cardBadge(cards, spend = null, theirs = false) {
  if (!cards.length) return '';
  const go = (e) => {
    // The row is a link to the chat; this goes to the card in it instead, in a new tab as a link would on ctrl or middle click.
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) window.open(new URL(cards[0].href, location.href).href, '_blank');
    else openHash(cards[0].href);
  };
  const what = spend ? `spend alert: this turn passed $${spend.stage} and has used about $${spend.usd}` : `${cards[0].what ?? cards[0].kind} card${cards[0].label ? ` "${cards[0].label}"` : ''}`;
  return h('span', {
    class: `card-badge${spend ? ' spend' : theirs ? ' theirs' : ''}`, role: 'link', tabindex: 0,
    title: cards.length > 1 ? `${cards.length} cards wait: open the oldest, the ${what}` : `Open the ${what}`,
    onclick: go, onauxclick: (e) => { if (e.button === 1) go(e); }, onkeydown: (e) => { if (e.key === 'Enter') go(e); },
  }, cardChip(cards));
}
