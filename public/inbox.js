// The Needs-you inbox: everything in the scheme waiting on a person, as a strip at the top of the
// minions list, minimized to a count until you open it.
import { ago, api, h, heldWhilePressed, phase, isCoordinator, isSeen, jumpHref, schemeIcon, taskmasterLabel, threadHref, view } from './base.js';
import { answeredItems, putBackCards, withoutCards, cardEvent, countMoved, isShipping, isWorking, itemTicket, minionCount, openPill, otherSchemes, rowTarget, schemePill, seenInScheme, stripItems, syncBadge, turnMoved, wantsBadge } from './schemecounts.js';
import { TM_VIEW } from './mine.js';
import { iconSrc } from './schemes.js';
import { askWhy, mentions } from './threadstate.js';
import { mountTips } from './ui/tip.js';

/** @import { ChatEvent, InboxItem, SchemeListed, Ticket, View } from './types.js' */
/** @import { MinionLike, SeenHere } from './schemecounts.js' */
/** What a row of the strip names its minion by: a whole minion, or the little the page knows of one. @typedef {Pick<Ticket, 'id' | 'project_id' | 'number' | 'kind' | 'title'>} RowTicket */

// The scheme's items as the server last sent them (src/inbox.ts), and the scheme they belong to.
/** @type {{ projectId: number | null, items: InboxItem[], timer: ReturnType<typeof setTimeout> | 0, countsTimer: ReturnType<typeof setTimeout> | 0 }} */
const inbox = { projectId: null, items: [], timer: 0, countsTimer: 0 };
// Items a person answered here whose answer the server's list hasn't dropped yet: left out of every count at the click (#1409).
/** @type {Map<string, InboxItem>} */
const answered = new Map(); // item key -> item
// Each scheme's items as last fetched, so a scheme you switch to draws its strip (or none) in its first paint instead of popping it in after.
/** @type {Map<number, InboxItem[]>} */
const inboxSeen = new Map();

// Another Taskmaster session of a split scheme (#919) included: the Overlord's cards count for everyone (#1400).
/** @param {number} id */
const ticketOf = (id) => itemTicket(view, id);
// A ready/complete/try minion you've opened since it changed goes faint and stops counting; cards count until answered.
// A mention (#1149) goes once you've opened its chat since it came.
/** @param {InboxItem} item */
const faded = (item) => (item.kind === 'replies' && isSeen(/** @type {Pick<Ticket, 'id' | 'updated_at'>} */ (ticketOf(item.ticketId) ?? { id: item.ticketId, updated_at: 0 }))) || (item.kind === 'mention' && (view?.seen?.[item.ticketId] ?? 0) >= item.at);

/**
 * The newest mention of you in each minion's chat, as its row shows it (#1149).
 * @param {InboxItem[]} items
 */
export function mentionMap(items) {
  /** @type {Map<number, { by: string | undefined, at: number }>} */
  const out = new Map();
  for (const i of items) if (i.kind === 'mention' && !((out.get(i.ticketId)?.at ?? -Infinity) > i.at)) out.set(i.ticketId, { by: /** @type {NonNullable<InboxItem['card']>} */ (i.card).by, at: i.at });
  return out;
}
/** @param {Map<number, { at: number }>} map */
const mentionKeys = (map) =>
  [...map]
    .map(([id, m]) => `${id}:${m.at}`)
    .sort()
    .join();

/**
 * A card was answered here (#1409): the strip, the pill, the app badge and the minion's row chip drop it now, not
 * when the server's list arrives. Returns the undo for a refused answer. shortcut: a minion update already in flight
 * from before the answer can put the row's chip back for a moment; the server's list settles it.
 * @param {number} ticketId
 * @param {number | string | ((item: InboxItem) => boolean)} which
 */
export function answerNow(ticketId, which) {
  const hit = answeredItems(inbox.items, ticketId, which);
  if (!hit.length) return () => {};
  const t = itemTicket(view, ticketId);
  const { open_cards: cards, replies } = t ?? {};
  for (const i of hit) answered.set(i.key, i);
  holdAnswered(t);
  const redraw = () => import('./sidebar.js').then((m) => m.renderSidebar());
  redraw();
  return () => {
    for (const i of hit) answered.delete(i.key);
    putBackCards(view, ticketId, t, { open_cards: cards, replies });
    redraw();
  };
}

/**
 * A minion update from the stream, before the page keeps it: what its person answered here and the server hasn't dropped yet stays off its row.
 * @param {MinionLike | undefined} ticket
 */
export function holdAnswered(ticket) {
  const mine = [...answered.values()].filter((i) => i.ticketId === ticket?.id);
  if (!mine.length) return;
  if (/** @type {MinionLike} */ (ticket).open_cards) /** @type {MinionLike} */ (ticket).open_cards = withoutCards(/** @type {NonNullable<MinionLike['open_cards']>} */ (/** @type {MinionLike} */ (ticket).open_cards), mine);
  if (mine.some((i) => i.kind === 'replies')) /** @type {MinionLike} */ (ticket).replies = [];
}

/** Fetch the scheme's items again, then redraw the strip. */
export async function refreshInbox() {
  if (view?.kind !== 'project') return;
  // Home's list (#1140) moves with the same news as every scheme's counts.
  if (view.home) import('./home.js').then((m) => m.refreshHomeSoon());
  const projectId = view.projectId;
  const mine = ++fetchSeq;
  const items = await fetchInbox(projectId);
  // Two fetches overlap: the older answer, landing last, must not draw over the newer (WP10, #1858).
  if (mine < drawnSeq) return;
  drawnSeq = mine;
  takeItems(projectId, items);
}
let fetchSeq = 0;
let drawnSeq = 0;

/**
 * Draw a scheme's items as fetched: by refreshInbox, or by the scheme's open, which fetched them just now (project.js).
 * @param {number} projectId
 * @param {InboxItem[] | null} items
 */
export function takeItems(projectId, items) {
  if (!items || view?.kind !== 'project' || view.projectId !== projectId) return;
  Object.assign(inbox, { projectId, items });
  for (const k of answered.keys()) if (!items.some((i) => i.key === k)) answered.delete(k); // the server caught up
  // A new or gone mention changes its minion's row (#1149), so the whole list redraws; renderSidebar draws the strip too.
  // Imported when needed: sidebar.js imports this module, and loads browser-only code the Node tests can't.
  if (mentionKeys(mentions) !== mentionKeys(mentionMap(items))) import('./sidebar.js').then((m) => m.renderSidebar());
  else renderInbox();
}

/**
 * Whether a scheme's first paint waits for its items (#1533): a scheme seen before draws its last, and a shut strip is one line
 * whatever the items are, so it holds its place while they come. Only an opened strip, whose rows push the list down, waits.
 * @param {number} projectId
 */
export const stripWaits = (projectId) => !inboxSeen.has(projectId) && stripOpen();

/**
 * A scheme's items, kept for its next first paint; null when the fetch failed.
 * @param {number} projectId
 * @returns {Promise<InboxItem[] | null>}
 */
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

let countsOwed = false; // other schemes' news a hidden tab put off (countsSoon)

/** Fetch every scheme's count again and redraw their pills; the open scheme's pill stays the badge's own. */
export function refreshSchemeCounts() {
  countsOwed = false;
  return api('api/projects')
    .then(
      (projects) => {
        if (view?.kind === 'project') view.projects = projects;
        for (const p of projects) {
          for (const el of document.querySelectorAll(`[data-scheme-inbox="${p.id}"]`)) el.replaceWith(schemeCount(p));
          // A favicon a merge added or changed since the page drew it.
          for (const el of document.querySelectorAll(`[data-scheme-icon="${p.id}"]`)) if (el.getAttribute('src') !== iconSrc(p)) el.replaceWith(schemeIcon(p));
        }
        updateBadge();
      },
      () => {},
    )
    .then(refreshInbox);
}

/**
 * Fetch the counts again soon: at most one fetch every 2 s however fast news comes, so the pills keep moving in a busy
 * minute (a restarting timer starved them, #1528). A hidden tab leaves news that only spins a pill until it's shown;
 * news that can move a Needs-you count (`badge`) still fetches, as it keeps the installed app's badge right.
 */
function countsSoon(badge = true) {
  if (globalThis.document?.hidden && !badge) return void (countsOwed = true);
  if (inbox.countsTimer) return;
  inbox.countsTimer = setTimeout(() => {
    inbox.countsTimer = 0;
    countsOwed = false;
    refreshSchemeCounts();
  }, 2000);
}
/** The tab is back (core.js): fetch the counts a hidden spell put off. */
export const countsIfOwed = () => countsOwed && countsSoon();

// Other schemes' news.
const others = otherSchemes(countsSoon);

/** A chat event from the stream: refetch when it opens or settles a card, in this scheme or another. */
/** @param {ChatEvent} event */
export function inboxEvent(event) {
  if (view?.kind !== 'project') return;
  // Lazily, like the sidebar: home.js pulls in the app shell (core, sidebar), which a node test can't load.
  if (view.home) import('./home.js').then((m) => m.homeEvent(event));
  if (!ticketOf(event.ticket_id)) {
    others.event(event);
    if (cardEvent(event) && inbox.items.some((i) => i.ticketId === event.ticket_id)) refreshSoon();
  } else if (cardEvent(event)) refreshSoon();
}

/**
 * One of this scheme's minions changed: refetch when that can move the count; a turn starting or ending only redraws the spinner.
 * @param {Ticket | undefined} before
 * @param {Ticket} after
 */
export function inboxTicket(before, after) {
  if (countMoved(before, after)) refreshSoon();
  else if (turnMoved(before, after)) {
    renderInbox();
    if (/** @type {View} */ (view).home) import('./home.js').then((m) => m.refreshHomeSoon()); // Home's Working now
  }
}

/** The counts came afresh with the page (or after the stream dropped): news the watcher missed meanwhile mustn't hide the next change. */
export const forgetOtherSchemes = () => others.forget();

/**
 * Another scheme's minion changed (#188).
 * @param {Ticket} ticket
 */
export function inboxOtherTicket(ticket) {
  if (view?.kind === 'project') others.ticket(ticket);
}

// What each kind of item asks of you, as a chip on its minion's row.
/** @type {Record<string, string>} */
const ASKS = { approval: '✋ Approve', question: '❓ Question', notice: '🔔 Notice', doc: '🗳️ Picks', secret: '🔑 Secret', plan: '📋 Plan', replies: '💬 Reply', mention: '@ Mention', quiet: '💤 Quiet', loop: '⏸ Loop guard' };
const OPEN_KEY = 'cc-inbox-open'; // whether this browser keeps the strip opened

// One strip, kept across scheme pages so it doesn't flicker as they redraw. Made on first use: a module's top-level code must not call into another while they load.
/** @type {HTMLElement | null} */
let strip = null;
// The opened list of rows, kept across redraws.
/** @type {HTMLElement | null} */
let list = null;

/** The strip for the minions panel (showProject puts it above the Taskmaster's row). */
export function inboxStrip() {
  strip ??= h('div', { class: 'inbox-strip', hidden: true });
  return strip;
}

/** A scheme's pill for the scheme lists: the spinner while a turn runs, then the Needs-you count (schemePill says what shows); hidden when neither. */
/** @param {Pick<SchemeListed, 'id' | 'inbox' | 'running' | 'working' | 'shipping'> & { fresh?: boolean }} p */
export function schemeCount(p) {
  // No words on the pill (Cara, 2026-11-17): its reason is the popover, hover or a long press, as a tap opens the scheme (#906).
  pillTips ??= mountTips(document.body, { selector: '.scheme-count[data-tip]', acts: '.scheme-count' });
  // The scheme you're in is marked by what this page saw of it (#548), not the server's word, which another tab writes too.
  const { need, busy, working, shipping, fresh, label } = schemePill(openPill(p, view?.projectId, seenHere));
  // The CSP refuses a style attribute; the CSSOM isn't blocked.
  const shipDots = () => {
    const i = h('i', {}, h('u', {}, '.'), h('u', {}, '.'), h('u', {}, '.'));
    i.style.setProperty('--ship-delay', `-${Date.now() % 1500}ms`);
    return i;
  };
  return h(
    'span',
    { class: 'scheme-count', 'data-scheme-inbox': p.id, hidden: !need && !busy && !shipping, role: label ? 'img' : null, 'data-tip': label || null, 'aria-label': label || null },
    busy ? h('span', { class: 'busy', 'aria-hidden': 'true' }, phase(h('i'), 900), working ? h('b', {}, working) : null) : null,
    shipping ? h('span', { class: 'ship', 'aria-hidden': 'true' }, h('b', {}, shipping), shipDots()) : null,
    need ? h('span', { class: `need${fresh ? ' fresh' : ''}`, 'aria-hidden': 'true' }, need) : null,
  );
}

/** @type {ReturnType<typeof mountTips> | null} */
let pillTips = null;

/** @type {{ on: boolean | null }} */
const badge = { on: null };
/** The installed app's icon badge follows the purple pills (#980). */
export const updateBadge = () => syncBadge(wantsBadge(view?.projects, view?.projectId, seenHere), badge);

// The items each scheme last told the server you saw (sorted keys, joined), so a redraw with nothing new writes nothing.
/** @type {Map<number, string>} */
const seenSent = new Map();
// The open scheme's waiting items you've seen (seenInScheme), the chat you were on at the last redraw, and whether anything's new.
// pill: the open scheme's count and spinner as its strip has them, which every draw of its pill uses (openPill, #1400).
/** @type {SeenHere & { chatId: number | null, keys: Set<string> }} */
const seenHere = { projectId: null, chatId: null, keys: new Set(), fresh: false, pill: null };

/** Record the items you've seen waiting in the scheme you're in on the server when they change (#539), behind the page. */
/**
 * @param {number} projectId
 * @param {string[]} keys
 */
function markItemsSeen(projectId, keys) {
  const p = /** @type {View} */ (view).projects?.find((q) => q.id === projectId);
  if (p) p.fresh = seenHere.fresh;
  const sig = [...keys].sort().join('\n');
  if (!p || seenSent.get(projectId) === sig) return;
  seenSent.set(projectId, sig);
  // A failed write tries again at the next redraw.
  api(`api/projects/${projectId}/seen-items`, { method: 'PUT', body: { keys } }).catch(() => {
    if (seenSent.get(projectId) === sig) seenSent.delete(projectId);
  });
}

/**
 * Another tab or device of yours saw what waits in a scheme (#539): fetch the counts again so the server says
 * whether anything is still new, since the other tab may have seen less than this one shows.
 * @param {number} projectId
 */
export function onSeenItems(projectId) {
  if (projectId === view?.projectId) return;
  seenSent.delete(projectId); // what the server holds is theirs now: write ours again when you're back in it
  countsSoon();
}

/** Redraw the strip: the count while minimized; opened, one row per waiting minion, linking to its chat. */
export function renderInbox() {
  if (view?.kind !== 'project' || heldWhilePressed(renderInbox)) return;
  if (inbox.projectId !== view.projectId) {
    const seen = inboxSeen.get(view.projectId);
    if (!seen) return holdStrip();
    Object.assign(inbox, { projectId: view.projectId, items: seen });
  }
  mentions.clear();
  for (const [id, m] of mentionMap(inbox.items)) mentions.set(id, m);
  // A dismissed minion is never in your inbox (#589), even while the server's list still has it: your own dismiss shows at once.
  // Nothing else drops: the badge away from the scheme counts the same items (#1400).
  const items = stripItems(view, inbox.items, new Set(answered.keys()));
  const strip = inboxStrip();
  // Minions, not items: one waiting on two things is one to see to (Cara, 2026-11-01).
  const all = items.filter((i) => !faded(i));
  const waiting = all;
  const count = minionCount(waiting);
  const shown = minionCount(all);
  // A scheme you hid (#226) keeps its strip but no pill.
  const hidden = view.projects?.find((p) => p.id === /** @type {View} */ (view).projectId)?.hidden;
  // Every Taskmaster session's turn spins it, as the server's pill does: a split scheme's Overlord too (#919).
  const running = !hidden && [view.coordinator, ...view.tickets.values(), ...(view.taskmasters ?? []).map((tm) => itemTicket(view, tm.id))].some(isWorking);
  const working = hidden ? 0 : [...view.tickets.values()].filter((t) => t.kind !== 'coordinator' && isWorking(t)).length;
  const shipping = hidden ? 0 : [...view.tickets.values()].filter((t) => t.kind !== 'coordinator' && isShipping(t)).length;
  // Settings or Artifacts (no chat open) isn't moving minions: coming back to the same chat sees nothing more.
  const moved = seenHere.projectId !== view.projectId || (view.id != null && seenHere.chatId !== view.id);
  const keys = seenInScheme(seenHere.keys, waiting, view.id, moved);
  const pill = { inbox: hidden ? 0 : count, running, working, shipping };
  Object.assign(seenHere, { projectId: view.projectId, chatId: view.id ?? seenHere.chatId, keys, fresh: waiting.some((i) => !keys.has(i.key)), pill });
  if (!hidden) markItemsSeen(view.projectId, [...keys]);
  for (const el of document.querySelectorAll(`[data-scheme-inbox="${view.projectId}"]`)) el.replaceWith(schemeCount({ id: view.projectId, ...pill }));
  updateBadge();
  strip.hidden = false;
  if (!items.length) {
    // Stays when empty, same height as the toggle, so the list below never moves; nothing to open (hidden schemes show no count).
    strip.classList.remove('open');
    list?.remove();
    const empty = h('div', { class: 'inbox-toggle inbox-empty' }, `Nothing needs you${working ? ` · ${working} working` : ''}`);
    return strip.replaceChildren(empty);
  }
  const open = stripOpen();
  // A minion's items share its row, in the order of its most urgent one. A card addressed to you is a row like the rest,
  // linking to it in its chat (Cara, 2026-11-14: "It should just link to the chat that has the card like it used to").
  /** @type {Map<number, InboxItem[]>} */
  const rows = new Map();
  for (const i of items) {
    if (!rows.has(i.ticketId)) rows.set(i.ticketId, []);
    /** @type {InboxItem[]} */ (rows.get(i.ticketId)).push(i);
  }
  const toggle = h(
    'button',
    { type: 'button', class: 'inbox-toggle', 'aria-expanded': String(open), title: open ? 'Minimize' : 'Show what waits on you' },
    h('span', { class: 'label' }, 'Needs you'),
    shown ? h('span', { class: 'count' }, shown) : h('span', { class: 'muted' }, 'all seen'),
    h('span', { class: 'spacer' }),
    h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
  );
  toggle.addEventListener('click', () => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '0' : '1');
    } catch {}
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

/** The strip as you last left it: opened (its rows showing) or shut. */
function stripOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** A scheme whose items haven't come yet: the shut strip's one line, so nothing below moves when they do (#1533). */
function holdStrip() {
  if (!strip) return; // not placed yet: showProject draws it before the first renderInbox
  strip.hidden = false;
  strip.classList.remove('open');
  list?.remove();
  strip.replaceChildren(h('div', { class: 'inbox-toggle inbox-empty', 'aria-busy': 'true' }, 'Needs you…'));
}

/**
 * A waiting minion: its number and title, what it asks of you, and how long the newest ask has waited.
 */
/** @type {ReturnType<typeof mountTips> | null} */
let inboxTips = null;
/** @param {InboxItem[]} items */
export function inboxRow(items) {
  const { from } = items[0];
  // A minion the page hasn't heard of yet still gets a row, by its id, until its first update names it.
  const t = /** @type {RowTicket} */ (ticketOf(items[0].ticketId)) ?? (from ? { id: items[0].ticketId, project_id: from.projectId, number: from.number, kind: from.kind, title: from.title } : { id: items[0].ticketId, project_id: /** @type {View} */ (view).projectId, number: null, kind: 'ticket', title: '' });
  /** @type {Map<string, { n: number, why: string, at: number }>} */
  const asks = new Map();
  for (const i of items) {
    const ask = i.kind === 'spend' ? `💸 Over $${/** @type {NonNullable<InboxItem['card']>} */ (i.card).stage}` : (ASKS[i.card?.notice ? 'notice' : i.card?.doc ? 'doc' : i.card?.secret ? 'secret' : i.kind] ?? i.kind);
    // The chip's popover says why it's here (#906): the newest of its kind.
    const was = asks.get(ask);
    asks.set(ask, { n: (was?.n ?? 0) + 1, why: was && was.at > i.at ? was.why : askWhy(i, t), at: Math.max(was?.at ?? 0, i.at) });
  }
  // A tap on a chip opens its why, not the minion (tip.js tapOpens).
  inboxTips ??= mountTips(document.body, { selector: '.inbox-row .chip[data-tip]', tapOpens: true });
  const seen = items.every(faded);
  const target = rowTarget(items);
  // Another person's Taskmaster (#919) shows only in Everyone: its card addressed to you opens there (#1400).
  const everyone = /** @type {View} */ (view).taskmasters?.some((x) => x.id === t.id && x.person_id != null && x.id !== /** @type {View} */ (view).coordinator?.id);
  const open = everyone
    ? () => {
        try {
          localStorage.setItem(TM_VIEW, 'everyone');
        } catch {}
      }
    : null;
  return h(
    'a',
    { class: `inbox-row${seen ? ' seen' : ''}${/** @type {View} */ (view).id === t.id ? ' active' : ''}`, href: target ? jumpHref(t, target) : threadHref(t), onclick: open },
    h('span', { class: 'name' }, from ? `${from.scheme} ` : '', isCoordinator(t) ? (from ? 'Taskmaster' : taskmasterLabel(t.project_id)) : [h('span', { class: 'num' }, t.number ?? t.id), ' ', t.title]),
    h(
      'span',
      { class: 'asks' },
      [...asks].map(([ask, { n, why }]) => h('span', { class: 'chip', tabindex: 0, 'data-tip': why, 'data-tip-row': t.id }, n > 1 ? `${ask} ×${n}` : ask)),
    ),
    // No one-tap replies on these rows (#130): a stray tap on "Merge it" would ship work nobody opened.
    h('span', { class: 'muted when' }, ago(Math.max(...items.map((i) => i.at)))),
  );
}
