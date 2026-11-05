// The Needs-you inbox: everything in a scheme that waits on a person, as one list of items.
import type { Approvals } from './approvals.ts';
import type { Store } from './db.ts';

export interface InboxItem {
  /** A card kind ('approval', 'question', 'plan': the chat event's kind), 'state' for a minion in state ready or try, or 'replies' for one offering one-tap replies in another state. */
  kind: string;
  ticketId: number;
  /** When it started waiting. */
  at: number;
  /** The card as its chat shows it, so the inbox can act on it in place; none for 'state'. */
  card?: unknown;
}

/**
 * Approval cards hold up a running turn, so they come first; the rest newest first. For `person`, only
 * minions assigned to them or to no one (#197); the Taskmaster is no one's. A parked minion waits on
 * something else by design, so its cards and replies wait too (#344; Josh, 2026-11-05: "Parked minions
 * shouldnt add to the inbox badge count"); only an approval, which a running turn is stuck on, still shows.
 */
export function inboxItems(store: Store, approvals: Approvals, projectId: number, person: string): InboxItem[] {
  const assignee = (id: number) => String(store.props.forTarget('minion', id).assigned ?? '').toLowerCase();
  const tickets = store.listTickets(projectId).filter((t) => t.status !== 'closed' && ['', person.toLowerCase()].includes(assignee(t.id)));
  const ids = new Set(tickets.map((t) => t.id));
  const awake = new Set(tickets.filter((t) => t.state !== 'parked').map((t) => t.id));
  const items: InboxItem[] = [
    ...approvals.pending().filter((a) => ids.has(a.ticketId))
      .map(({ ticketId, at, card }) => ({ kind: 'approval', ticketId, at, card, eventId: store.cardEventId(ticketId, 'approval', (card as { id: string }).id) ?? undefined })),
    // A new stored card kind only needs adding to Store.openCards.
    ...store.openCards(projectId).filter((e) => awake.has(e.ticket_id)).map((e) => ({ kind: e.kind, ticketId: e.ticket_id, at: e.created_at, card: JSON.parse(e.data), eventId: e.id })),
    ...tickets.filter((t) => t.state === 'ready' || t.state === 'try').map((t) => ({ kind: 'state', ticketId: t.id, at: t.updated_at })),
    // Minions set replies as a turn ends, so a running one is listed with its chips hidden for a moment.
    ...tickets.filter((t) => t.replies && !['ready', 'try', 'parked'].includes(t.state ?? '')).map((t) => ({ kind: 'replies', ticketId: t.id, at: t.updated_at })),
  ];
  return items.sort((a, b) => Number(b.kind === 'approval') - Number(a.kind === 'approval') || b.at - a.at);
}

/** How many minions the scheme's Needs-you badge counts for `person`, who last saw each minion at `seen` (ticket id -> time): one with any item left, where a ready/try or replies item they opened since it changed stops counting, as in public/inbox.js. */
export function inboxCount(store: Store, approvals: Approvals, projectId: number, person: string, seen: Record<number, number>): number {
  const updated = new Map(store.listTickets(projectId).map((t) => [t.id, t.updated_at]));
  const waiting = inboxItems(store, approvals, projectId, person)
    .filter((i) => !((i.kind === 'state' || i.kind === 'replies') && (seen[i.ticketId] ?? 0) >= (updated.get(i.ticketId) ?? 0)));
  return new Set(waiting.map((i) => i.ticketId)).size;
}
