// The Needs-you inbox: everything in a scheme that waits on a person, as one list of items.
import type { Approvals } from './approvals.ts';
import type { Project, Store, Ticket } from './db.ts';
import { inOrder } from '../public/reorder.js';
import { minionCount as sharedMinionCount } from '../public/schemecounts.js';
import { openMentions } from './mentions.ts';
import { loopHolds } from './minion-relay.ts';
import { openSpend, type SpendState } from './spend-alert.ts';
import { pacificDay } from './pacific.ts';
import { SLEEP_PREFIX } from './needs.ts';
import { drain, pace } from './breathe.ts';

export interface InboxItem {
  /** A card kind ('approval', 'question', 'plan': the chat event's kind), 'spend' for a running turn's unanswered spend alert (#723), 'quiet' for a running turn gone quiet (#906), 'loop' for messages the loop guard holds for a person's Continue (#1067), 'mention' for a message that @mentions them (#1149), or 'replies' for one offering one-tap replies in another state. */
  kind: string;
  ticketId: number;
  /** When it started waiting. */
  at: number;
  /** The card as its chat shows it, so the inbox can act on it in place; none for 'replies', 'quiet' or 'loop'. */
  card?: unknown;
  /** Names this item while it waits, so a scheme's pill can tell a new one from one you saw (#539). */
  key: string;
  /** The chat event that posted the card, to open the chat at it. */
  eventId?: number;
  /** On a card from another scheme (directCards, #687; no route serves it since 2026-11-19, docs/adr/0015): where it asks from. */
  from?: { projectId: number; scheme: string; number: number | null; kind: string; title: string };
}

/** Whether a stored card is for `person`: a card to everyone (no `to`), or one addressed to them (#687). */
const forPerson = (card: { to?: string }, person: string) => !card.to || card.to.toLowerCase() === person.toLowerCase();

/**
 * Approval cards hold up a running turn, so they come first; the rest newest first. For `person`, only
 * minions assigned to them or to no one (#197); the Taskmaster is no one's. A sealed minion waits on
 * something else by design, so its cards and replies wait too (#344; Josh, 2026-11-05: "Sealed minions
 * shouldnt add to the inbox badge count"); only an approval, which a running turn is stuck on, still shows. An asleep
 * minion (#1636) is left out the same way, its cards to one person too; approvals still show.
 */
export function inboxItems(store: Store, approvals: Approvals, projectId: number, person: string): InboxItem[] {
  const all = store.listTickets(projectId).filter((t) => t.status !== 'closed');
  // One read for every open minion's properties in a request's read scope (src/read-scope.ts, #1527), for minionPerson and requester.
  store.props.warmTargets('minion', all.map((t) => t.id));
  store.warmSettings(all.filter((t) => t.status === 'running').map((t) => `turn:${t.id}`));
  // In a split scheme (#919) a person's own Taskmaster is theirs alone; the Overlord's (coordinator_of null) is everyone's.
  // A minion is its assignee's, the scheme owner's once they're gone (Store.minionPerson, as push, #1449), else everyone's.
  const me = store.findUser('name', person)?.id;
  const tickets = all.filter((t) => [null, me].includes(store.minionPerson(t)) && (t.coordinator_of == null || t.coordinator_of === me));
  // Who asked for a minion (#906): its requestedBy, else who created it.
  const requester = (t: { id: number; created_by: string | null }) => {
    const r = String(store.props.forTarget('minion', t.id).requestedBy ?? '') || t.created_by || '';
    return (r && store.props.personName(r) || r).toLowerCase();
  };
  const ids = new Set(tickets.map((t) => t.id));
  const asleep = new Set(store.settingsWithPrefix(SLEEP_PREFIX).map((r) => Number(r.key.slice(SLEEP_PREFIX.length))));
  const awake = new Set(tickets.filter((t) => t.state !== 'parked' && !asleep.has(t.id)).map((t) => t.id));
  const items: InboxItem[] = [
    ...approvals.pending().filter((a) => ids.has(a.ticketId))
      .map(({ ticketId, at, card }) => ({ kind: 'approval', ticketId, at, card, eventId: store.cardEventId(ticketId, 'approval', (card as { id: string }).id) ?? undefined, key: `approval:${(card as { id: string }).id}` })),
    // A new stored card kind only needs adding to Store.openCards.
    // A card addressed to one person (#687) is theirs alone, whoever the minion is assigned to and even while it's sealed, but not asleep (#1636).
    ...store.openCards(projectId).map((e) => ({ e, card: JSON.parse(e.data) }))
      .filter(({ e, card }) => (card.to ? forPerson(card, person) && !asleep.has(e.ticket_id) : awake.has(e.ticket_id)))
      .map(({ e, card }) => ({ kind: e.kind, ticketId: e.ticket_id, at: e.created_at, card, eventId: e.id, key: `${e.kind}:${e.id}` })),
    // A running turn past a spend stage (#723), until Keep going or the turn's end; the runner keeps a turn's spend in its saved turn.
    ...tickets.filter((t) => t.status === 'running').flatMap((t) => {
      const spend = openSpend(store.getSetting<{ spend?: SpendState }>(`turn:${t.id}`)?.spend);
      return spend ? [{ kind: 'spend', ticketId: t.id, at: spend.at, card: spend, eventId: spend.event, key: `spend:${spend.event}` }] : [];
    }),
    // A running turn gone quiet (#906; Cara, 2026-11-17, "Yes, for the requester"): in its requester's Needs you only, until it talks again.
    ...all.filter((t) => t.status === 'running' && requester(t) === person.toLowerCase()).flatMap((t) => {
      const since = store.getSetting<{ quiet?: number }>(`turn:${t.id}`)?.quiet;
      return since ? [{ kind: 'quiet', ticketId: t.id, at: since, key: `quiet:${t.id}:${since}` }] : [];
    }),
    // Messages the loop guard holds (#1067; Josh, 2026-11-19, "Needs-you + chat"), until a person continues them.
    ...[...loopHolds(store)].filter(([id]) => ids.has(id)).map(([ticketId, hold]) => ({ kind: 'loop', ticketId, at: hold.at, card: hold, key: `loop:${ticketId}:${hold.at}` })),
    // A message that @mentions them (#1149; Josh, 2026-11-20: "Needs you, and counted"), until they open its chat; theirs whoever the minion's assignee, but not while it's asleep (#1636), like a card to them.
    ...openMentions(store, projectId, person, store.seenTimes(person, projectId)).filter((m) => all.some((t) => t.id === m.ticketId) && !asleep.has(m.ticketId))
      .map((m) => ({ kind: 'mention', ticketId: m.ticketId, at: m.at, card: { by: m.by, text: m.text }, eventId: m.eventId, key: `mention:${m.eventId}` })),
    // Ready, try and complete are for a person to look at, not answers, so they're not here (#1121; Josh, 2026-11-19: "Answers only").
    // Minions set replies as a turn ends, so a running one is listed with its chips hidden for a moment.
    ...tickets.filter((t) => t.replies && awake.has(t.id) && !['ready', 'complete', 'try'].includes(t.state ?? '')).map((t) => ({ kind: 'replies', ticketId: t.id, at: t.updated_at, key: `replies:${t.id}` })),
  ];
  return items.sort((a, b) => Number(b.kind === 'approval') - Number(a.kind === 'approval') || b.at - a.at);
}

/** The items the scheme's Needs-you badge counts for `person`, who last saw each minion at `seen` (ticket id -> time): a replies item they opened since it changed stops counting, as in public/inbox.js. */
export function inboxWaiting(store: Store, approvals: Approvals, projectId: number, person: string, seen: Record<number, number>): InboxItem[] {
  const updated = new Map(store.listTickets(projectId).map((t) => [t.id, t.updated_at]));
  return inboxItems(store, approvals, projectId, person)
    .filter((i) => !(i.kind === 'replies' && (seen[i.ticketId] ?? 0) >= (updated.get(i.ticketId) ?? 0)));
}

/** How many minions the badge counts: one with any item left in `inboxWaiting`; the open scheme's strip counts with the same function (#1400). */
export const minionCount: (items: InboxItem[]) => number = sharedMinionCount;

/** How many minions the scheme's Needs-you badge counts for `person` (inboxWaiting says which items count). */
export function inboxCount(store: Store, approvals: Approvals, projectId: number, person: string, seen: Record<number, number>): number {
  return minionCount(inboxWaiting(store, approvals, projectId, person, seen));
}

/**
 * Cards addressed to `person` from their other schemes (#687; Cara, 2026-11-14, "Keep, add cross-scheme"): every
 * scheme's Needs-you list showed them as rows linking to the card in its chat (#697). Josh, 2026-11-19: "you shouldnt
 * see others schemes stuff in inbox unless/until we have the citadel wide page", so no route serves this now; it waits
 * for that page.
 */
export function directCards(store: Store, projectId: number, person: string): InboxItem[] {
  const user = store.findUser('name', person);
  if (!user) return [];
  const items: InboxItem[] = [];
  for (const pid of store.memberSchemes(user.id)) {
    if (pid === projectId || store.hiddenProjects(user.id).has(pid)) continue;
    const scheme = store.getProject(pid)?.name ?? '';
    for (const e of store.openCards(pid)) {
      const card = JSON.parse(e.data);
      if (!card.to || !forPerson(card, person)) continue;
      const t = store.getTicket(e.ticket_id)!;
      items.push({ kind: e.kind, ticketId: e.ticket_id, at: e.created_at, card, eventId: e.id, key: `${e.kind}:${e.id}`, from: { projectId: pid, scheme, number: t.number, kind: t.kind, title: t.title } });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}

/** A new visit to Home starts after this long without one of its fetches (#1140). */
export const HOME_VISIT_GAP = 30 * 60_000;
/** A first visit to Home shows what shipped in the day before it. */
export const HOME_FIRST_LOOK = 24 * 3_600_000;

/**
 * When this person's visit to Home started counting what shipped (#1140; Josh, 2026-11-19, "Last visit to Home"): the
 * end of their last visit, kept for the whole of this one, so a live refresh doesn't empty the list. Stored per person.
 */
export function homeSince(store: Store, person: string, now: number): number {
  const key = `home-visit:${person.toLowerCase()}`;
  const was = store.getSetting<{ since: number; last: number }>(key);
  const since = !was ? now - HOME_FIRST_LOOK : now - was.last > HOME_VISIT_GAP ? was.last : was.since;
  store.setSetting(key, { since, last: now });
  return since;
}

export interface HomeView {
  /** What waits on the person, each with `from` naming its scheme and minion: Taskmasters first, then oldest first (Josh, 2026-11-19, "Taskmasters first"). */
  items: InboxItem[];
  /**
   * Their schemes in their shelf's order, as counts only (Josh, 2026-11-20, "Counts per scheme": "a high level summary
   * of what is going on and what shipped, but not the individual minons"): minions waiting on them, working now, and
   * shipped since `since`, with `daily`, the minions shipped on each of the last HOME_DAYS Pacific days, oldest first.
   */
  schemes: { id: number; name: string; waiting: number; working: number; shipped: number; daily: number[] }[];
  since: number;
  /** The Pacific days `daily` counts, "2026-11-20", oldest first. */
  days: string[];
}

/** How many days Home's activity bars go back. */
export const HOME_DAYS = 14;

/** `ms` as its Pacific day, "2026-11-20". */

/** How often Home's held ship notes drop the ones past the window (HomeBucketCache). */
export const HOME_BUCKETS_MS = 60_000;

/** Minions shipped per scheme per Pacific day over the last HOME_DAYS days: project -> day -> tickets. */
export type HomeBuckets = Map<number, Map<string, Set<number>>>;

type ShipNote = { ticket_id: number; project_id: number; at: number };

/** How far back the ship notes behind the buckets go. */
const homeWindow = (now: number) => now - (HOME_DAYS + 1) * 86_400_000;

/** Event ids per step of the cache's first read: a cold read of 15 days' notes at once held the loop 3-10.7 s (#1414). */
const HOME_FILL_IDS = 5_000;

/** One pass over ship notes, each note's day worked out once. */
function bucketShips(notes: ShipNote[]): HomeBuckets {
  const out: HomeBuckets = new Map();
  for (const n of notes) {
    const days = out.get(n.project_id) ?? out.set(n.project_id, new Map()).get(n.project_id)!;
    const day = pacificDay(n.at);
    (days.get(day) ?? days.set(day, new Set()).get(day)!).add(n.ticket_id);
  }
  return out;
}

/**
 * The server's copy of the window's ship notes and their buckets, the same for everyone. A ship note is written once,
 * so each call reads only the notes past the last event read. The first read goes a
 * range of event ids at a time, yielding between them: await ready() before homeView. Without a cache (a test), every
 * call reads fresh. shortcut: a note written into ids freed by deleting the newest events, between two calls, is
 * missed until the server restarts; key on a delete counter if that ever shows.
 */
export class HomeBucketCache {
  private held: { store: Store; mark: number; at: number; notes: ShipNote[]; buckets: HomeBuckets } | null = null;
  private filling: Promise<void> | null = null;

  /** Fills the cache once per store, paced; later calls return at once. */
  ready(store: Store, now = Date.now()): Promise<void> {
    if (this.held?.store === store) return Promise.resolve();
    return (this.filling ??= pace(this.fillSteps(store, now)).finally(() => (this.filling = null)));
  }

  private *fillSteps(store: Store, now: number): Generator<void, void> {
    // eventIdAt past every event is one past the newest id.
    const top = store.eventIdAt(Number.MAX_SAFE_INTEGER);
    const notes: ShipNote[] = [];
    for (let from = store.eventIdAt(homeWindow(now)); from < top; from += HOME_FILL_IDS) {
      notes.push(...store.shippedNotes(0, [from, Math.min(from + HOME_FILL_IDS, top)]));
      yield;
    }
    this.held = { store, mark: top, at: now, notes, buckets: bucketShips(notes) };
  }

  /** The window's notes and buckets: each call reads the notes past the last event read (a few rows, on events_notes). */
  get(store: Store, now: number): { notes: ShipNote[]; buckets: HomeBuckets } {
    if (this.held?.store !== store) drain(this.fillSteps(store, now));
    const h = this.held!;
    const top = store.eventIdAt(Number.MAX_SAFE_INTEGER);
    // top < mark: the newest events were deleted and their ids may come back, so read the window afresh.
    if (top < h.mark) return drain(this.fillSteps(store, now)), this.get(store, now);
    const fresh = top > h.mark ? store.shippedNotes(0, [h.mark, top]) : [];
    h.mark = top;
    // Old notes leave the window once a minute; the buckets are worked out again only when the notes changed.
    const prune = now - h.at >= HOME_BUCKETS_MS || now < h.at;
    if (prune) {
      // A minion deleted since drops out, and one moved to another scheme counts there, as a fresh read would have it.
      const where = new Map<number, number | null>();
      for (const n of h.notes) if (!where.has(n.ticket_id)) where.set(n.ticket_id, store.getTicket(n.ticket_id)?.project_id ?? null);
      h.notes = h.notes.filter((n) => n.at >= homeWindow(now) && where.get(n.ticket_id) != null).map((n) => ({ ...n, project_id: where.get(n.ticket_id)! }));
      h.at = now;
    }
    if (fresh.length) h.notes = [...h.notes, ...fresh];
    if (prune || fresh.length) h.buckets = bucketShips(h.notes);
    return h;
  }
}

/** The last HOME_DAYS Pacific days up to `now`'s, oldest first. */
export function homeDays(now: number): string[] {
  // Calendar steps back from today's Pacific date, so a 23- or 25-hour day can't skip or repeat one.
  const [y, m, d] = pacificDay(now).split('-').map(Number);
  return Array.from({ length: HOME_DAYS }, (_, i) => new Date(Date.UTC(y, m - 1, d - (HOME_DAYS - 1 - i))).toISOString().slice(0, 10));
}

/**
 * Home (#1140, #1217): everything waiting on a person across the schemes they own or are a member of and haven't
 * hidden, and each scheme's counts. Admin reach doesn't add schemes: Home is about the person. `busy` says whether a
 * minion's turn is doing work, as api/projects counts it. A minion shipped twice in a span (a follow-up hand-off)
 * counts once.
 */
export function homeView(store: Store, approvals: Approvals, who: { name: string; uid?: number }, busy: (t: Ticket) => boolean, since: number, now = Date.now(), cache?: HomeBucketCache): HomeView {
  const hidden = store.hiddenProjects(who.uid ?? -1);
  const ids = inOrder([...store.memberSchemes(who.uid)].filter((id) => !hidden.has(id)), (id: number) => id, who.uid === undefined ? [] : store.listOrder(who.uid, 'schemes')) as number[];
  const schemes = ids.map((id) => store.getProject(id)).filter((p): p is Project => !!p);
  const days = homeDays(now);
  const held = cache?.get(store, now);
  const buckets = held ? held.buckets : bucketShips(store.shippedNotes(homeWindow(now)));
  // "Shipped since your last visit" comes from the held notes when the visit is inside their window.
  const sinceShips = held && since >= homeWindow(now) ? held.notes : store.shippedNotes(since);
  const items: InboxItem[] = [];
  const out: HomeView['schemes'] = [];
  for (const p of schemes) {
    const tickets = store.listTickets(p.id);
    const byId = new Map(tickets.map((t) => [t.id, t]));
    const waiting = inboxWaiting(store, approvals, p.id, who.name, store.seenTimes(who.name, p.id));
    for (const i of waiting) {
      const t = byId.get(i.ticketId);
      if (t) items.push({ ...i, from: { projectId: p.id, scheme: p.name, number: t.number, kind: t.kind, title: t.title } });
    }
    // Another person's own Taskmaster in a split scheme (#919) is theirs.
    const working = tickets.filter((t) => t.status !== 'closed' && (t.coordinator_of == null || t.coordinator_of === who.uid) && busy(t)).length;
    const mine = buckets.get(p.id);
    const daily = days.map((d) => mine?.get(d)?.size ?? 0);
    out.push({ id: p.id, name: p.name, waiting: minionCount(waiting), working, shipped: new Set(sinceShips.filter((n) => n.project_id === p.id && n.at >= since).map((n) => n.ticket_id)).size, daily });
  }
  const isTaskmaster = (i: InboxItem) => Number(i.from?.kind === 'coordinator');
  items.sort((a, b) => isTaskmaster(b) - isTaskmaster(a) || a.at - b.at);
  return { items, schemes: out, since, days };
}
