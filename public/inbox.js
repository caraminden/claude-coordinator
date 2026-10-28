// The Needs-you inbox: everything in the scheme waiting on a person, with its badge in the minions panel.
import { ago, api, h, isCoordinator, isSeen, STATES, taskmasterLabel, threadHref, view } from './core.js';
import { approvalCard, planCard, questionCard } from './thread.js';

// The scheme's items as the server last sent them (src/inbox.ts), and the scheme they belong to.
const inbox = { projectId: null, items: [], timer: 0 };
// Chat events that open or settle a card.
const CARD_EVENTS = new Set(['question', 'plan', 'plan_result', 'approval', 'approval_result']);

const ticketOf = (id) => (view?.coordinator?.id === id ? view.coordinator : view?.tickets?.get(id));
// A ready/try minion you've opened since it changed goes faint and stops counting; cards count until answered.
const faded = (item) => item.kind === 'state' && isSeen(ticketOf(item.ticketId) ?? { id: item.ticketId, updated_at: 0 });

/** Fetch the scheme's items again, then redraw the badge and (if open) the page. */
export async function refreshInbox() {
  if (view?.kind !== 'project') return;
  const projectId = view.projectId;
  const { items } = await api(`/api/projects/${projectId}/inbox`).catch(() => ({ items: null }));
  if (!items || view?.projectId !== projectId) return;
  Object.assign(inbox, { projectId, items });
  renderInbox();
}

/** A burst of changes (a card answered, then the turn starting) fetches once. */
function refreshSoon() {
  clearTimeout(inbox.timer);
  inbox.timer = setTimeout(refreshInbox, 300);
}

/** A chat event from the stream: refetch when it opens or settles a card in this scheme. */
export function inboxEvent(event) {
  if (view?.kind !== 'project' || !ticketOf(event.ticket_id)) return;
  if (CARD_EVENTS.has(event.kind) || (event.kind === 'user_message' && JSON.parse(event.data).answer)) refreshSoon();
}

/** A minion changed: refetch when it moved into or out of ready/try, or was dismissed or reopened. */
export function inboxTicket(before, after) {
  if (!before || before.state !== after.state || (before.status === 'closed') !== (after.status === 'closed')) refreshSoon();
}

/** Redraw what shows the inbox: the badge row and count in the minions panel, and the page if open. */
export function renderInbox() {
  if (view?.kind !== 'project' || inbox.projectId !== view.projectId) return;
  const items = inbox.items.filter((i) => ticketOf(i.ticketId));
  const count = items.filter((i) => !faded(i)).length;
  const tab = document.getElementById('inbox-count');
  if (tab) {
    tab.textContent = count || '';
    tab.hidden = !count;
  }
  document.getElementById('inbox-row')?.replaceChildren(
    h('a', { class: `inbox-link${view.main === 'inbox' ? ' active' : ''}`, href: `#/p/${view.projectId}/inbox`, title: 'Everything in this scheme waiting on you' },
      h('span', { class: 'label' }, 'Needs you'),
      count ? h('span', { class: 'count' }, count) : h('span', { class: 'muted' }, items.length ? 'all seen' : 'nothing')));
  const list = document.getElementById('inbox-list');
  if (list) renderList(list, items);
}

/** The Needs-you page; renderInbox fills it. */
export function inboxPage() {
  return h('section', { class: 'artifacts-main inbox-page' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Needs you'), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, '×')),
      h('div', { class: 'meta' }, 'Cards waiting on a person and minions ready for you, newest first. Approvals come first: they hold up a turn.')),
    h('div', { id: 'inbox-list' }, h('p', { class: 'muted' }, 'Loading…')));
}

// Cards already on the page, by key, so a refresh keeps half-typed answers and notes.
const shown = new Map();

function renderList(list, items) {
  if (!items.length) {
    shown.clear();
    return list.replaceChildren(h('p', { class: 'muted empty' }, 'Nothing is waiting on you in this scheme.'));
  }
  const keep = new Map();
  list.replaceChildren(...items.map((item) => {
    const key = item.card ? `${item.kind}:${item.card.id}` : `state:${item.ticketId}:${ticketOf(item.ticketId).updated_at}`;
    const el = shown.get(key) ?? inboxItem(item);
    el.classList.toggle('seen', faded(item));
    keep.set(key, el);
    return el;
  }));
  shown.clear();
  for (const [k, el] of keep) shown.set(k, el);
}

/** One item: which minion and how long it has waited, then the card itself or the minion's note. */
function inboxItem(item) {
  const t = ticketOf(item.ticketId);
  const state = item.kind === 'state' ? STATES[t.state] : null;
  const head = h('div', { class: 'inbox-head' },
    h('a', { class: 'who-link', href: threadHref(t) }, isCoordinator(t) ? taskmasterLabel(t.project_id) : [h('span', { class: 'num' }, t.number ?? t.id), ' ', t.title]),
    h('span', { class: 'muted' }, ` · ${ago(item.at)}`));
  if (state) {
    return h('a', { class: 'inbox-item state-item', href: threadHref(t) }, head,
      h('div', { class: 'state-line' }, h('span', { class: 'chip' }, `${state.emoji} ${t.state === 'try' ? 'Try it' : 'Ready'}`), ' ', t.note || state.label));
  }
  const card = item.kind === 'approval' ? approvalCard(t.id, item.card)
    : item.kind === 'plan' ? planCard(t.id, item.card)
      : item.kind === 'question' ? questionCard(t.id, item.card)
        // A card kind this front end doesn't know yet still links to its chat.
        : h('div', { class: 'qcard' }, h('a', { href: threadHref(t) }, 'Open the chat to answer it'));
  return h('div', { class: 'inbox-item' }, head, card);
}
