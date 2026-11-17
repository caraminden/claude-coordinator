// The Needs-you inbox: everything in a scheme that waits on a person, as one list of items.
import type { Approvals } from './approvals.ts';
import type { Store } from './db.ts';
import { openSpend, type SpendState } from './spend-alert.ts';

export interface InboxItem {
  /** A card kind ('approval', 'question', 'plan': the chat event's kind), 'spend' for a running turn's unanswered spend alert (#723), 'state' for a minion in state ready, complete or try, 'quiet' for a running turn gone quiet (#906), or 'replies' for one offering one-tap replies in another state. */
  kind: string;
  ticketId: number;
  /** When it started waiting. */
  at: number;
  /** The card as its chat shows it, so the inbox can act on it in place; none for 'state'. */
  card?: unknown;
  /** Names this item while it waits, so a scheme's pill can tell a new one from one you saw (#539). */
  key: string;
  /** The chat event that posted the card, to open the chat at it. */
  eventId?: number;
  /** On a card addressed to you from another scheme (directCards, #687): where it asks from, to draw its row. */
  from?: { projectId: number; scheme: string; number: number | null; kind: string; title: string };
}

/** Whether a stored card is for `person`: a card to everyone (no `to`), or one addressed to them (#687). */
const forPerson = (card: { to?: string }, person: string) => !card.to || card.to.toLowerCase() === person.toLowerCase();

/**
 * Approval cards hold up a running turn, so they come first; the rest newest first. For `person`, only
 * minions assigned to them or to no one (#197); the Taskmaster is no one's. A parked minion waits on
 * something else by design, so its cards and replies wait too (#344; Josh, 2026-11-05: "Parked minions
 * shouldnt add to the inbox badge count"); only an approval, which a running turn is stuck on, still shows.
 */
export function inboxItems(store: Store, approvals: Approvals, projectId: number, person: string): InboxItem[] {
  // A value stored before #582 may name the person by their login or GitHub login.
  const assignee = (id: number) => {
    const a = String(store.props.forTarget('minion', id).assigned ?? '');
    return (a && store.props.personName(a) || a).toLowerCase();
  };
  const all = store.listTickets(projectId).filter((t) => t.status !== 'closed');
  const tickets = all.filter((t) => ['', person.toLowerCase()].includes(assignee(t.id)));
  // Who asked for a minion (#906): its requestedBy, else who created it.
  const requester = (t: { id: number; created_by: string | null }) => {
    const r = String(store.props.forTarget('minion', t.id).requestedBy ?? '') || t.created_by || '';
    return (r && store.props.personName(r) || r).toLowerCase();
  };
  const ids = new Set(tickets.map((t) => t.id));
  const awake = new Set(tickets.filter((t) => t.state !== 'parked').map((t) => t.id));
  const items: InboxItem[] = [
    ...approvals.pending().filter((a) => ids.has(a.ticketId))
      .map(({ ticketId, at, card }) => ({ kind: 'approval', ticketId, at, card, eventId: store.cardEventId(ticketId, 'approval', (card as { id: string }).id) ?? undefined, key: `approval:${(card as { id: string }).id}` })),
    // A new stored card kind only needs adding to Store.openCards.
    // A card addressed to one person (#687) is theirs alone, whoever the minion is assigned to and even while it's parked.
    ...store.openCards(projectId).map((e) => ({ e, card: JSON.parse(e.data) }))
      .filter(({ e, card }) => (card.to ? forPerson(card, person) : awake.has(e.ticket_id)))
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
    ...tickets.filter((t) => ['ready', 'complete', 'try'].includes(t.state ?? '')).map((t) => ({ kind: 'state', ticketId: t.id, at: t.updated_at, key: `state:${t.id}` })),
    // Minions set replies as a turn ends, so a running one is listed with its chips hidden for a moment.
    ...tickets.filter((t) => t.replies && !['ready', 'complete', 'try', 'parked'].includes(t.state ?? '')).map((t) => ({ kind: 'replies', ticketId: t.id, at: t.updated_at, key: `replies:${t.id}` })),
  ];
  return items.sort((a, b) => Number(b.kind === 'approval') - Number(a.kind === 'approval') || b.at - a.at);
}

/** The items the scheme's Needs-you badge counts for `person`, who last saw each minion at `seen` (ticket id -> time): a ready/try or replies item they opened since it changed stops counting, as in public/inbox.js. */
export function inboxWaiting(store: Store, approvals: Approvals, projectId: number, person: string, seen: Record<number, number>): InboxItem[] {
  const updated = new Map(store.listTickets(projectId).map((t) => [t.id, t.updated_at]));
  return inboxItems(store, approvals, projectId, person)
    .filter((i) => !((i.kind === 'state' || i.kind === 'replies') && (seen[i.ticketId] ?? 0) >= (updated.get(i.ticketId) ?? 0)));
}

/** How many minions the badge counts: one with any item left in `inboxWaiting` (minions, not items: Cara, 2026-11-01). */
export const minionCount = (items: InboxItem[]) => new Set(items.map((i) => i.ticketId)).size;

/** How many minions the scheme's Needs-you badge counts for `person` (inboxWaiting says which items count). */
export function inboxCount(store: Store, approvals: Approvals, projectId: number, person: string, seen: Record<number, number>): number {
  return minionCount(inboxWaiting(store, approvals, projectId, person, seen));
}

/**
 * Cards addressed to `person` from their other schemes (#687; Cara, 2026-11-14, "Keep, add cross-scheme"): every
 * scheme's Needs-you list shows them as rows linking to the card in its chat (#697), though only the asking scheme's
 * count includes them.
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
