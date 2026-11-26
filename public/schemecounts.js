// Which stream news can move a Needs-you count: the open scheme's badge and other schemes' pills (#188).
// Also where a Needs-you row takes you (#236).

/** @import { SchemeListed } from './types.js' */
/** The fields of a minion this file reads, all optional: the server passes its own row shapes and a test a partial one. @typedef {{ id?: number, kind?: string, project_id?: number, status?: string, updated_at?: number, state?: string | null, replies?: string[], approvals?: number, server_work?: { kind: string } | null, asleep?: unknown, loop_hold?: unknown, spend_alert?: { event?: number } | null, properties?: Record<string, unknown>, open_cards?: { href?: string }[] }} TicketBits */
/** A minion or Taskmaster as the page knows it: a whole one, or the few fields a Taskmaster session of a split scheme lists. @typedef {TicketBits & { id: number }} MinionLike */
/** The open scheme's strip as inbox.js keeps it (seenHere): its pill's count and spinner and whether anything is new. @typedef {{ projectId?: number | null, pill?: Partial<Pick<SchemeListed, 'inbox' | 'running' | 'working' | 'shipping'>> | null, fresh: boolean }} SeenHere */
/** What a page or test hands over of the open scheme's page (`view`): the minions it lists and the Taskmaster sessions. @typedef {{ projectId?: number, coordinator?: MinionLike, tickets?: Map<number, MinionLike>, taskmasters?: { id: number, person_id?: number | null, person_name?: string | null, status?: string, updated_at?: number, ticket?: MinionLike }[] }} ViewBits */
/** A chat event's kind and data, which is all cardEvent reads. @typedef {{ kind: string, data: string, ticket_id?: number }} EventBits */
/** What schemePill reads of a scheme's row. @typedef {Partial<Pick<SchemeListed, 'inbox' | 'running' | 'working' | 'shipping' | 'fresh'>>} PillSource */

// Chat events that open or settle a card.
const CARD_EVENTS = new Set(['question', 'question_result', 'plan', 'plan_result', 'approval', 'approval_result']);

/** A chat event that opens or settles a card (a typed answer settles one too). */
/** @param {EventBits} event */
export const cardEvent = (event) => CARD_EVENTS.has(event.kind) || (event.kind === 'user_message' && !!JSON.parse(event.data).answer);

/**
 * A minion moved into or out of ready/complete/try, offered or lost its replies, was dismissed or reopened, changed hands, raised or cleared a spend alert, or had the loop guard hold or release messages (or is new to us).
 * @param {TicketBits | undefined} before
 * @param {TicketBits} after
 */
export const countMoved = (before, after) =>
  !before ||
  before.state !== after.state ||
  !before.asleep !== !after.asleep ||
  !before.replies?.length !== !after.replies?.length ||
  (before.status === 'closed') !== (after.status === 'closed') ||
  before.properties?.assigned !== after.properties?.assigned ||
  before.spend_alert?.event !== after.spend_alert?.event ||
  !before.loop_hold !== !after.loop_hold;

/**
 * A minion or Taskmaster whose turn is doing work, for the spinner and its number (#248, #278). A turn
 * held open on an approval card waits on a person, not working (#373; Cara, 2026-11-07: "it should only
 * count actually working minions"). `t.approvals` is how many of its cards wait, as runner.view sends it. Only a
 * running turn counts: the server working for it (`t.server_work`) is `isShipping`, apart (#1294; Cara, 2026-11-20: "Running only").
 * @param {TicketBits | null | undefined} t
 */
export const isWorking = (t) => !!t && !t.approvals && t.status === 'running';

/** The server works for a minion with no turn running: its ship waits in the line, lands or deploys (#727, #1294). A job it waits for (#1890) is no ship.
 * @param {TicketBits | null | undefined} t
 */
export const isShipping = (t) => !!t && !t.approvals && t.status !== 'running' && t.status !== 'closed' && !!t.server_work && t.server_work.kind !== 'job';

/**
 * A minion started or ended work, or began or stopped waiting on the server: the spinner and the waiting dots (#248, #1294).
 * @param {TicketBits | undefined} before
 * @param {TicketBits} after
 */
export const turnMoved = (before, after) => isWorking(before) !== isWorking(after) || isShipping(before) !== isShipping(after);

/**
 * What a scheme's pill shows (`p` as api/projects sends it): the Needs-you count, the spinner while a
 * turn runs (#248) and how many minions are working when that's more than one (#278; Cara,
 * 2026-11-02: "Only show if number > 1"). The spinner shows beside the count, not only at zero (#314;
 * Josh, 2026-11-05: "I think actually the blue spinner and number of minions should show regardless
 * of badge"). `fresh`: something waits on you that wasn't waiting when you last had the scheme open, as
 * the server's `fresh` says (#498, #539), for the violet count. `label` covers it all, for the tooltip and screen
 * readers; empty when the pill is hidden.
 * @param {PillSource & { id?: number }} p
 */
export function schemePill(p) {
  const need = p.inbox || 0;
  const busy = !!p.running;
  // New items, not a moved count (#539; Cara, 2026-11-11: "a different color or something if the number has changed";
  // Josh, 2026-11-11: "Only when it went up", then "if one went up and one went down, or even 2 went down it should
  // still be purple"). Items only going away leave it plain, and at zero there's nothing to show.
  const fresh = need > 0 && !!p.fresh;
  const shipping = /** @type {number} */ (p.shipping) > 0 ? /** @type {number} */ (p.shipping) : 0;
  const parts = [];
  if (need) parts.push(`${need} need${need === 1 ? 's' : ''} your answer${fresh ? ' (something new since you last opened it)' : ''}`);
  if (busy) parts.push(p.working ? `${p.working} minion${p.working === 1 ? '' : 's'} working` : 'Taskmaster working');
  if (shipping) parts.push(`${shipping} waiting to ship`);
  return { need, busy, working: busy && /** @type {number} */ (p.working) > 1 ? /** @type {number} */ (p.working) : 0, shipping, fresh, label: parts.join(' · ') };
}

/**
 * Whether the installed app's icon wears a badge: any visible scheme's pill is purple (`schemePill(p).fresh`, the one
 * source of that colour). A plain dot, not a count: purple is per scheme, so a number would be ambiguous (#980).
 * `projects` as api/projects sends them; the open scheme's `fresh` is this page's own (`seen`, as inbox.js holds it).
 * @param {(PillSource & { id: number, hidden?: boolean })[] | undefined} projects
 * @param {number | null | undefined} openId
 * @param {SeenHere | null} seen
 */
export const wantsBadge = (projects, openId, seen) => (projects || []).some((p) => !p.hidden && schemePill(openPill(p, openId, seen)).fresh);

/**
 * The scheme you're in, as this page saw it (`seen`: inbox.js's seenHere): its strip's count and spinner (`seen.pill`) and
 * whether anything's new, over the server's word, which lags it or another tab wrote. Every draw of its pill goes through
 * this, so a scheme-list refresh can't put the server's older count back for a moment (#1400).
 * @template {{ id: number }} P
 * @param {P} p
 * @param {number | null | undefined} openId
 * @param {SeenHere | null} seen
 */
export const openPill = (p, openId, seen) => (p.id === openId && seen?.projectId === p.id ? { ...p, ...seen.pill, fresh: seen.fresh } : p);

/**
 * Set or clear the app badge to match `want`, only when it changed since the last call (`state.on`), and only where
 * the browser has the Badging API. Returns whether it called.
 * @param {boolean} want
 * @param {{ on: boolean | null }} state
 * @param {Navigator} [nav]
 */
export function syncBadge(want, state, nav = globalThis.navigator) {
  if (!nav || !('setAppBadge' in nav) || state.on === want) return false;
  state.on = want;
  (want ? nav.setAppBadge() : nav.clearAppBadge()).catch?.(() => {});
  return true;
}

/**
 * Which of the open scheme's waiting items (`{ key, ticketId }`) you've seen, given what you'd seen at the last
 * redraw and the chat open now (#548; Josh, 2026-11-11: "put the purple up on the scheme you are viewing unless you
 * are actively looking at the minion that is now asking for something and until you move minions"). Opening a chat
 * (`moved`) sees all of it; staying put, you see only what the chat you're on asks, and the rest is new to you.
 * @param {Set<string>} seen
 * @param {{ key: string, ticketId: number }[]} waiting
 * @param {number} chatId
 * @param {boolean} moved
 */
export const seenInScheme = (seen, waiting, chatId, moved) => new Set(waiting.filter((i) => moved || seen.has(i.key) || i.ticketId === chatId).map((i) => i.key));

/**
 * Other schemes' minions as the stream last showed them: `ticket` and `event` call `refetch(badge)` when
 * news may have moved those schemes' counts (`badge` when it may move a Needs-you count, not only a spinner), so a scheme you aren't in still lights up. `forget`
 * when the counts are fetched afresh: what was last seen before then may be out of date.
 * @param {(badge: boolean) => void} refetch
 */
export function otherSchemes(refetch) {
  /** @type {Map<number, TicketBits>} */
  const last = new Map(); // ticket id -> the minion as last seen
  return {
    /** @param {TicketBits & { id: number }} t */
    ticket(t) {
      const before = last.get(t.id);
      last.set(t.id, t);
      // true: the news can move a Needs-you count (and the app's badge); false: only a spinner
      if (countMoved(before, t)) refetch(true);
      else if (turnMoved(before, t)) refetch(false);
    },
    /** @param {EventBits} event */
    event(event) {
      if (cardEvent(event)) refetch(true);
    },
    forget: () => last.clear(),
  };
}

/**
 * Where a minion's Needs-you row takes you (#236): the oldest thing it waits on you for, as a jump target (an event id, or 'latest' for a ready, try or replies item: the minion's latest reply); null for none.
 * @param {{ at: number, kind: string, eventId?: number }[]} items
 */
export function rowTarget(items) {
  const oldest = items.reduce((a, b) => (b.at < a.at ? b : a));
  return oldest.eventId ?? (['replies', 'loop'].includes(oldest.kind) ? 'latest' : null);
}

/**
 * How many minions a scheme's Needs-you badge counts: minions, not items (Cara, 2026-11-01). The server's pills and the open scheme's own use this one count (#1400).
 * @param {{ ticketId: number }[]} items
 */
export const minionCount = (items) => new Set(items.map((i) => i.ticketId)).size;

/**
 * The minion or Taskmaster a Needs-you item is on, as the open scheme's page knows it (`view`): your Taskmaster, the
 * minions list, or another Taskmaster session of a split scheme (#919), which the page lists in `taskmasters` without
 * its ticket. Undefined for a minion the page hasn't heard of yet.
 * @param {ViewBits | null | undefined} view
 * @param {number} id
 * @returns {MinionLike} Undefined at run time for a minion the page hasn't heard of; typed whole so callers' `?.` and `??` stay as written.
 */
export function itemTicket(view, id) {
  if (view?.coordinator?.id === id) return view.coordinator;
  const t = view?.tickets?.get(id);
  if (t) return t;
  const tm = view?.taskmasters?.find((x) => x.id === id);
  if (!tm) return /** @type {MinionLike} */ (/** @type {unknown} */ (undefined)); // typed whole, see @returns
  return tm.ticket ?? { id, kind: 'coordinator', project_id: /** @type {number} */ (/** @type {ViewBits} */ (view).projectId), status: tm.status ?? 'idle', updated_at: tm.updated_at ?? 0 };
}

/**
 * What the open scheme's strip lists and its pill counts: every item the server sent (src/inbox.ts, the same list the
 * badge away from the scheme counts), less those on a minion this page has seen dismissed (#589), which drop at once.
 * Nothing else is left out, so the badge never counts what a click doesn't show (#1400: the Overlord's card counted
 * on the rail and vanished from the strip, so the pill popped between the two counts).
 * @template {{ ticketId: number, key: string, kind?: string }} I
 * @param {ViewBits | null | undefined} view
 * @param {I[]} items
 * @param {Set<string>} [answered]
 * @returns {I[]}
 */
export const stripItems = (view, items, answered = new Set()) => items.filter((i) => itemTicket(view, i.ticketId)?.status !== 'closed' && !answered.has(i.key) && !sleeping(view, i));
/**
 * An item an asleep minion (#1636) no longer shows, as src/inbox.ts drops it: its cards and replies, not what a running turn is stuck on.
 * @param {ViewBits | null | undefined} view
 * @param {{ ticketId: number, kind?: string }} i
 */
const sleeping = (view, i) => !!itemTicket(view, i.ticketId)?.asleep && !['approval', 'spend', 'quiet', 'loop'].includes(/** @type {string} */ (i.kind));

/**
 * The items a person just answered on a minion: its card with that id (an item's `card.id` is the question, plan or approval id), or the ones `which` (a function of the item) picks. #1409 drops them from every count at the click.
 * @template {{ ticketId: number, card?: { id?: number | string } }} I
 * @param {I[]} items
 * @param {number} ticketId
 * @param {number | string | ((item: I) => boolean)} which
 */
export const answeredItems = (items, ticketId, which) => items.filter((i) => i.ticketId === ticketId && (typeof which === 'function' ? which(i) : i.card?.id === which));

/**
 * A refused answer's undo: the cards go back on the minion row as it is now, since a stream update may have replaced the object the answer began with (WP11, #1858).
 * @param {ViewBits | null | undefined} view
 * @param {number} ticketId
 * @param {TicketBits | undefined} was
 * @param {{ open_cards?: { href?: string }[], replies?: string[] }} back
 */
export function putBackCards(view, ticketId, was, back) {
  const live = itemTicket(view, ticketId) ?? was;
  if (live) Object.assign(live, back);
}

/**
 * A row's open_cards less the answered items' cards (a card link names its chat event, `?e=<eventId>`, as the item does).
 * @template {{ href?: string }} C
 * @param {C[]} cards
 * @param {{ eventId?: number }[]} answered
 * @returns {C[]}
 */
export const withoutCards = (cards, answered) => cards.filter((c) => !answered.some((i) => c.href?.endsWith(`?e=${i.eventId}`)));
