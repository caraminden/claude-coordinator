// The Needs-you inbox: everything in the scheme waiting on a person, as a strip at the top of the
// minions list, minimized to a count until you open it.
import { ago, api, h, isCoordinator, isSeen, STATES, taskmasterLabel, threadHref, view } from './core.js';
import { cardEvent, countMoved, otherSchemes } from './schemecounts.js';

// The scheme's items as the server last sent them (src/inbox.ts), and the scheme they belong to.
const inbox = { projectId: null, items: [], timer: 0, countsTimer: 0 };

const ticketOf = (id) => (view?.coordinator?.id === id ? view.coordinator : view?.tickets?.get(id));
// A ready/try minion you've opened since it changed goes faint and stops counting; cards count until answered.
const faded = (item) => (item.kind === 'state' || item.kind === 'replies') && isSeen(ticketOf(item.ticketId) ?? { id: item.ticketId, updated_at: 0 });

/** Fetch the scheme's items again, then redraw the strip. */
export async function refreshInbox() {
  if (view?.kind !== 'project') return;
  const projectId = view.projectId;
  const { items } = await api(`api/projects/${projectId}/inbox`).catch(() => ({ items: null }));
  if (!items || view?.projectId !== projectId) return;
  Object.assign(inbox, { projectId, items });
  renderInbox();
}

/** A burst of changes (a card answered, then the turn starting) fetches once. */
function refreshSoon() {
  clearTimeout(inbox.timer);
  inbox.timer = setTimeout(refreshInbox, 300);
}

/** Fetch every scheme's count again and redraw their pills; the open scheme's pill stays the badge's own. */
export function refreshSchemeCounts() {
  return api('api/projects').then((projects) => {
    if (view?.kind === 'project') view.projects = projects;
    for (const p of projects) for (const el of document.querySelectorAll(`[data-scheme-inbox="${p.id}"]`)) el.replaceWith(schemeCount(p));
    renderInbox();
  }, () => {});
}

// Other schemes' news, refetching their counts at most once a second.
const others = otherSchemes(() => {
  clearTimeout(inbox.countsTimer);
  inbox.countsTimer = setTimeout(refreshSchemeCounts, 1000);
});

/** A chat event from the stream: refetch when it opens or settles a card, in this scheme or another. */
export function inboxEvent(event) {
  if (view?.kind !== 'project') return;
  if (!ticketOf(event.ticket_id)) others.event(event);
  else if (cardEvent(event)) refreshSoon();
}

/** One of this scheme's minions changed: refetch when that can move the count. */
export function inboxTicket(before, after) {
  if (countMoved(before, after)) refreshSoon();
}

/** Another scheme's minion changed (#188). */
export function inboxOtherTicket(ticket) {
  if (view?.kind === 'project') others.ticket(ticket);
}

// What each kind of item asks of you, as a chip on its minion's row.
const ASKS = { approval: '✋ Approve', question: '❓ Question', plan: '📋 Plan', ready: '✅ Ready', try: '🧪 Try it', replies: '💬 Reply' };
const OPEN_KEY = 'cc-inbox-open'; // whether this browser keeps the strip opened

// One strip, kept across scheme pages so it doesn't flicker as they redraw. Made on first use: a module's top-level code must not call into another while they load.
let strip = null;

/** The strip for the minions panel (showProject puts it above the Taskmaster's row). */
export function inboxStrip() {
  strip ??= h('div', { class: 'inbox-strip', hidden: true });
  return strip;
}

/** A scheme's Needs-you count (`inbox` from api/projects) as a pill for the scheme lists; hidden at zero. */
export function schemeCount(p) {
  return h('span', { class: 'scheme-count', 'data-scheme-inbox': p.id, hidden: !p.inbox, title: 'Waiting on you' }, p.inbox || '');
}

/** Redraw the strip: the count while minimized; opened, one row per waiting minion, linking to its chat. */
export function renderInbox() {
  if (view?.kind !== 'project' || inbox.projectId !== view.projectId) return;
  const items = inbox.items.filter((i) => ticketOf(i.ticketId));
  const strip = inboxStrip();
  const count = items.filter((i) => !faded(i)).length;
  for (const el of document.querySelectorAll(`[data-scheme-inbox="${view.projectId}"]`)) el.replaceWith(schemeCount({ id: view.projectId, inbox: count }));
  strip.hidden = !items.length;
  if (!items.length) return strip.replaceChildren();
  let open = false;
  try { open = localStorage.getItem(OPEN_KEY) === '1'; } catch {}
  // A minion's items share its row, in the order of its most urgent one.
  const rows = new Map();
  for (const i of items) {
    if (!rows.has(i.ticketId)) rows.set(i.ticketId, []);
    rows.get(i.ticketId).push(i);
  }
  const toggle = h('button', { type: 'button', class: 'inbox-toggle', 'aria-expanded': String(open), title: open ? 'Minimize' : 'Show what waits on you' },
    h('span', { class: 'label' }, 'Needs you'),
    count ? h('span', { class: 'count' }, count) : h('span', { class: 'muted' }, 'all seen'),
    h('span', { class: 'muted' }, `${rows.size} minion${rows.size === 1 ? '' : 's'}`),
    h('span', { class: 'spacer' }),
    h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'));
  toggle.addEventListener('click', () => {
    try { localStorage.setItem(OPEN_KEY, open ? '0' : '1'); } catch {}
    renderInbox();
  });
  strip.classList.toggle('open', open);
  strip.replaceChildren(toggle, open ? h('div', { class: 'inbox-rows' }, [...rows.values()].map(inboxRow)) : '');
}

/** A waiting minion: its number and title, what it asks of you, and how long the newest ask has waited. */
function inboxRow(items) {
  const t = ticketOf(items[0].ticketId);
  const asks = new Map();
  for (const i of items) {
    const ask = ASKS[i.kind === 'state' ? t.state : i.kind] ?? i.kind;
    asks.set(ask, (asks.get(ask) ?? 0) + 1);
  }
  const seen = items.every(faded);
  return h('a', { class: `inbox-row${seen ? ' seen' : ''}${view.id === t.id ? ' active' : ''}`, href: threadHref(t) },
    h('span', { class: 'name' }, isCoordinator(t) ? taskmasterLabel(t.project_id) : [h('span', { class: 'num' }, t.number ?? t.id), ' ', t.title]),
    h('span', { class: 'asks' }, [...asks].map(([ask, n]) => h('span', { class: 'chip' }, n > 1 ? `${ask} ×${n}` : ask))),
    // No one-tap replies on these rows (#130): a stray tap on "Merge it" would ship work nobody opened.
    h('span', { class: 'muted when' }, ago(Math.max(...items.map((i) => i.at)))));
}
