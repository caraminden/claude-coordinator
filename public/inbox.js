// The Needs-you inbox: everything in the scheme waiting on a person, as a strip at the top of the
// minions list, minimized to a count until you open it.
import { ago, api, h, isCoordinator, isSeen, jumpHref, me, schemeIcon, STATES, taskmasterLabel, threadHref, view } from './base.js';
import { cardEvent, countMoved, isWorking, otherSchemes, rowTarget, schemePill, seenInScheme, syncBadge, turnMoved, wantsBadge } from './schemecounts.js';
import { iconSrc } from './schemes.js';
import { askWhy } from './threadstate.js';
import { homeEvent, refreshHomeSoon } from './home.js';
import { mountTips } from './ui/tip.js';

// The scheme's items as the server last sent them (src/inbox.ts), and the scheme they belong to.
const inbox = { projectId: null, items: [], timer: 0, countsTimer: 0 };
// Each scheme's items as last fetched, so a scheme you switch to draws its strip (or none) in its first paint instead of popping it in after.
const inboxSeen = new Map();

const ticketOf = (id) => (view?.coordinator?.id === id ? view.coordinator : view?.tickets?.get(id));
// A ready/complete/try minion you've opened since it changed goes faint and stops counting; cards count until answered.
const faded = (item) => item.kind === 'replies' && isSeen(ticketOf(item.ticketId) ?? { id: item.ticketId, updated_at: 0 });

/** Fetch the scheme's items again, then redraw the strip. */
export async function refreshInbox() {
  if (view?.kind !== 'project') return;
  // Home's list (#1140) moves with the same news as every scheme's counts.
  if (view.home) refreshHomeSoon();
  const projectId = view.projectId;
  const items = await fetchInbox(projectId);
  if (!items || view?.projectId !== projectId) return;
  Object.assign(inbox, { projectId, items });
  renderInbox();
}

/** A scheme's items, kept for its next first paint; null when the fetch failed. Showing a scheme waits on this (project.js). */
export async function fetchInbox(projectId) {
  const { items } = await api(`api/projects/${projectId}/inbox`).catch(() => ({ items: null }));
  if (items) inboxSeen.set(projectId, items);
  return items;
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
    for (const el of document.querySelectorAll('[data-scheme-inbox="home"]')) el.replaceWith(homeCount(projects.filter((p) => !p.hidden && p.member !== false)));
    for (const p of projects) {
      for (const el of document.querySelectorAll(`[data-scheme-inbox="${p.id}"]`)) el.replaceWith(schemeCount(p));
      // A favicon a merge added or changed since the page drew it.
      for (const el of document.querySelectorAll(`[data-scheme-icon="${p.id}"]`)) if (el.getAttribute('src') !== iconSrc(p)) el.replaceWith(schemeIcon(p));
    }
    // Refetch, not just redraw: another scheme's minion dismissed or reopened takes its cards addressed to you (#687) with it.
    updateBadge();
    refreshInbox();
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
  homeEvent(event);
  if (!ticketOf(event.ticket_id)) {
    others.event(event);
    // A card another scheme addressed to you (#687), or news of one this list shows, redraws this list too.
    if (cardEvent(event) && (inbox.items.some((i) => i.ticketId === event.ticket_id) || JSON.parse(event.data).to === me)) refreshSoon();
  } else if (cardEvent(event)) refreshSoon();
}

/** One of this scheme's minions changed: refetch when that can move the count; a turn starting or ending only redraws the spinner. */
export function inboxTicket(before, after) {
  if (countMoved(before, after)) refreshSoon();
  else if (turnMoved(before, after)) {
    renderInbox();
    if (view.home) refreshHomeSoon(); // Home's Working now
  }
}

/** The counts came afresh with the page (or after the stream dropped): news the watcher missed meanwhile mustn't hide the next change. */
export const forgetOtherSchemes = () => others.forget();

/** Another scheme's minion changed (#188). */
export function inboxOtherTicket(ticket) {
  if (view?.kind === 'project') others.ticket(ticket);
}

// What each kind of item asks of you, as a chip on its minion's row.
const ASKS = { approval: '✋ Approve', question: '❓ Question', notice: '🔔 Notice', doc: '🗳️ Picks', secret: '🔑 Secret', plan: '📋 Plan', replies: '💬 Reply', quiet: '💤 Quiet', loop: '⏸ Loop guard' };
const OPEN_KEY = 'cc-inbox-open'; // whether this browser keeps the strip opened

// One strip, kept across scheme pages so it doesn't flicker as they redraw. Made on first use: a module's top-level code must not call into another while they load.
let strip = null;
// The opened list of rows, kept across redraws.
let list = null;

/** The strip for the minions panel (showProject puts it above the Taskmaster's row). */
export function inboxStrip() {
  strip ??= h('div', { class: 'inbox-strip', hidden: true });
  return strip;
}

/** A scheme's pill for the scheme lists: the spinner while a turn runs, then the Needs-you count (schemePill says what shows); hidden when neither. */
export function schemeCount(p) {
  // No words on the pill (Cara, 2026-11-17): its reason is the popover, hover or a long press, as a tap opens the scheme (#906).
  pillTips ??= mountTips(document.body, { selector: '.scheme-count[data-tip]', acts: '.scheme-count' });
  // The scheme you're in is marked by what this page saw of it (#548), not the server's word, which another tab writes too.
  const { need, busy, working, fresh, label } = schemePill(p.id === view?.projectId && seenHere.projectId === p.id ? { ...p, fresh: seenHere.fresh } : p);
  return h('span', { class: 'scheme-count', 'data-scheme-inbox': p.id, hidden: !need && !busy, role: label ? 'img' : null, 'data-tip': label || null, 'aria-label': label || null },
    busy ? h('span', { class: 'busy', 'aria-hidden': 'true' }, h('i'), working ? h('b', {}, working) : null) : null,
    need ? h('span', { class: `need${fresh ? ' fresh' : ''}`, 'aria-hidden': 'true' }, need) : null);
}

let pillTips = null;

/** The Home line's pill (#1140): every shelf scheme's counts summed, purple when any of them is. */
export const homeCount = (schemes) => schemeCount({
  id: 'home',
  inbox: schemes.reduce((n, p) => n + (p.inbox || 0), 0),
  running: schemes.some((p) => p.running),
  working: schemes.reduce((n, p) => n + (p.running ? p.working || 1 : 0), 0),
  fresh: schemes.some((p) => schemePill(p.id === view?.projectId && seenHere.projectId === p.id ? { ...p, fresh: seenHere.fresh } : p).fresh),
});

const badge = { on: null };
/** The installed app's icon badge follows the purple pills (#980). */
export const updateBadge = () => syncBadge(wantsBadge(view?.projects, view?.projectId, seenHere), badge);

// The items each scheme last told the server you saw (sorted keys, joined), so a redraw with nothing new writes nothing.
const seenSent = new Map();
// The open scheme's waiting items you've seen (seenInScheme), the chat you were on at the last redraw, and whether anything's new.
const seenHere = { projectId: null, chatId: null, keys: new Set(), fresh: false };

/** Record the items you've seen waiting in the scheme you're in on the server when they change (#539), behind the page. */
function markItemsSeen(projectId, keys) {
  const p = view.projects?.find((q) => q.id === projectId);
  if (p) p.fresh = seenHere.fresh;
  const sig = [...keys].sort().join('\n');
  if (!p || seenSent.get(projectId) === sig) return;
  seenSent.set(projectId, sig);
  // A failed write tries again at the next redraw.
  api(`api/projects/${projectId}/seen-items`, { method: 'PUT', body: { keys } }).catch(() => { if (seenSent.get(projectId) === sig) seenSent.delete(projectId); });
}

/**
 * Another tab or device of yours saw what waits in a scheme (#539): fetch the counts again so the server says
 * whether anything is still new, since the other tab may have seen less than this one shows.
 */
export function onSeenItems(projectId) {
  if (projectId === view?.projectId) return;
  seenSent.delete(projectId); // what the server holds is theirs now: write ours again when you're back in it
  clearTimeout(inbox.countsTimer);
  inbox.countsTimer = setTimeout(refreshSchemeCounts, 1000);
}

/** Redraw the strip: the count while minimized; opened, one row per waiting minion, linking to its chat. */
export function renderInbox() {
  if (view?.kind !== 'project') return;
  if (inbox.projectId !== view.projectId) {
    const seen = inboxSeen.get(view.projectId);
    if (!seen) return;
    Object.assign(inbox, { projectId: view.projectId, items: seen });
  }
  // A dismissed minion is never in your inbox (#589), even while the server's list still has it: your own dismiss shows at once.
  // Cards addressed to you from your other schemes (`from`, #687) show here too, though only their own scheme's pill counts them.
  const items = inbox.items.filter((i) => i.from || (ticketOf(i.ticketId) && ticketOf(i.ticketId).status !== 'closed'));
  const strip = inboxStrip();
  // Minions, not items: one waiting on two things is one to see to (Cara, 2026-11-01).
  const all = items.filter((i) => !faded(i));
  const waiting = all.filter((i) => !i.from);
  const count = new Set(waiting.map((i) => i.ticketId)).size;
  const shown = new Set(all.map((i) => i.ticketId)).size;
  // A scheme you hid (#226) keeps its strip but no pill.
  const hidden = view.projects?.find((p) => p.id === view.projectId)?.hidden;
  const running = !hidden && [view.coordinator, ...view.tickets.values()].some(isWorking);
  const working = hidden ? 0 : [...view.tickets.values()].filter((t) => t.kind !== 'coordinator' && isWorking(t)).length;
  // Settings or Artifacts (no chat open) isn't moving minions: coming back to the same chat sees nothing more.
  const moved = seenHere.projectId !== view.projectId || (view.id != null && seenHere.chatId !== view.id);
  const keys = seenInScheme(seenHere.keys, waiting, view.id, moved);
  Object.assign(seenHere, { projectId: view.projectId, chatId: view.id ?? seenHere.chatId, keys, fresh: waiting.some((i) => !keys.has(i.key)) });
  if (!hidden) markItemsSeen(view.projectId, [...keys]);
  for (const el of document.querySelectorAll(`[data-scheme-inbox="${view.projectId}"]`)) el.replaceWith(schemeCount({ id: view.projectId, inbox: hidden ? 0 : count, running, working }));
  updateBadge();
  strip.hidden = false;
  if (!items.length) {
    // Stays when empty, same height as the toggle, so the list below never moves; nothing to open (hidden schemes show no count).
    strip.classList.remove('open');
    list?.remove();
    const empty = h('div', { class: 'inbox-toggle inbox-empty' }, `Nothing needs you${working ? ` · ${working} working` : ''}`);
    return strip.replaceChildren(empty);
  }
  let open = false;
  try { open = localStorage.getItem(OPEN_KEY) === '1'; } catch {}
  // A minion's items share its row, in the order of its most urgent one. A card addressed to you is a row like the rest,
  // linking to it in its chat (Cara, 2026-11-14: "It should just link to the chat that has the card like it used to").
  const rows = new Map();
  for (const i of items) {
    if (!rows.has(i.ticketId)) rows.set(i.ticketId, []);
    rows.get(i.ticketId).push(i);
  }
  const toggle = h('button', { type: 'button', class: 'inbox-toggle', 'aria-expanded': String(open), title: open ? 'Minimize' : 'Show what waits on you' },
    h('span', { class: 'label' }, 'Needs you'),
    shown ? h('span', { class: 'count' }, shown) : h('span', { class: 'muted' }, 'all seen'),
    h('span', { class: 'spacer' }),
    h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'));
  toggle.addEventListener('click', () => {
    try { localStorage.setItem(OPEN_KEY, open ? '0' : '1'); } catch {}
    renderInbox();
  });
  strip.classList.toggle('open', open);
  // The list stays in place across redraws (renderSidebar redraws on every minion update), keeping its scroll (#668)
  // only the toggle and the rows are new.
  list ??= h('div', { class: 'inbox-rows' });
  // Shut, the rows aren't in the page: they're built when it opens (the toggle redraws).
  list.replaceChildren(...(open ? [...rows.values()].map((r) => inboxRow(r)) : []));
  if (strip.firstChild) strip.firstChild.replaceWith(toggle);
  else strip.append(toggle);
  if (open && list.parentNode !== strip) strip.append(list);
  else if (!open) list.remove();
}

/**
 * A waiting minion: its number and title, what it asks of you, and how long the newest ask has waited. One from
 * another scheme (a card addressed to you there, #687) names that scheme.
 */
let inboxTips = null;
export function inboxRow(items, { href = (to) => to, scheme = null } = {}) {
  const { from } = items[0];
  const t = ticketOf(items[0].ticketId) ?? { id: items[0].ticketId, project_id: from.projectId, number: from.number, kind: from.kind, title: from.title };
  const asks = new Map();
  for (const i of items) {
    const ask = i.kind === 'spend' ? `💸 Over $${i.card.stage}` : ASKS[i.card?.notice ? 'notice' : i.card?.doc ? 'doc' : i.card?.secret ? 'secret' : i.kind] ?? i.kind;
    // The chip's popover says why it's here (#906): the newest of its kind.
    const was = asks.get(ask);
    asks.set(ask, { n: (was?.n ?? 0) + 1, why: was && was.at > i.at ? was.why : askWhy(i, t), at: Math.max(was?.at ?? 0, i.at) });
  }
  // A tap on a chip opens its why, not the minion (tip.js tapOpens).
  inboxTips ??= mountTips(document.body, { selector: '.inbox-row .chip[data-tip]', tapOpens: true });
  const seen = items.every(faded);
  const target = rowTarget(items);
  return h('a', { class: `inbox-row${seen ? ' seen' : ''}${view.id === t.id ? ' active' : ''}`, href: href(target ? jumpHref(t, target) : threadHref(t)) },
    // Home (#1140) names the scheme with its tag, in its own hue (`scheme`); a scheme's own strip as words.
    h('span', { class: 'name' }, from ? (scheme ? [scheme(from.scheme), ' '] : `${from.scheme} `) : '',
      isCoordinator(t) ? (from ? 'Taskmaster' : taskmasterLabel(t.project_id)) : [h('span', { class: 'num' }, t.number ?? t.id), ' ', t.title]),
    h('span', { class: 'asks' }, [...asks].map(([ask, { n, why }]) => h('span', { class: 'chip', tabindex: 0, 'data-tip': why, 'data-tip-row': t.id }, n > 1 ? `${ask} ×${n}` : ask))),
    // No one-tap replies on these rows (#130): a stray tap on "Merge it" would ship work nobody opened.
    h('span', { class: 'muted when' }, ago(Math.max(...items.map((i) => i.at)))));
}
