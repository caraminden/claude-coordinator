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
 * minions assigned to them or to no one (#197); the Taskmaster is no one's.
 */
export function inboxItems(store: Store, approvals: Approvals, projectId: number, person?: string): InboxItem[] {
  const assignee = (id: number) => String(store.props.forTarget('minion', id).assigned ?? '').toLowerCase();
  const tickets = store.listTickets(projectId).filter((t) => t.status !== 'closed' && (person === undefined || ['', person.toLowerCase()].includes(assignee(t.id))));
  const ids = new Set(tickets.map((t) => t.id));
  const items: InboxItem[] = [
    ...approvals.pending().filter((a) => ids.has(a.ticketId)).map(({ ticketId, at, card }) => ({ kind: 'approval', ticketId, at, card })),
    // A new stored card kind only needs adding to Store.openCards.
    ...store.openCards(projectId).filter((e) => ids.has(e.ticket_id)).map((e) => ({ kind: e.kind, ticketId: e.ticket_id, at: e.created_at, card: JSON.parse(e.data) })),
    ...tickets.filter((t) => t.state === 'ready' || t.state === 'try').map((t) => ({ kind: 'state', ticketId: t.id, at: t.updated_at })),
    // Minions set replies as a turn ends, so a running one is listed with its chips hidden for a moment.
    ...tickets.filter((t) => t.replies && t.state !== 'ready' && t.state !== 'try').map((t) => ({ kind: 'replies', ticketId: t.id, at: t.updated_at })),
  ];
  return items.sort((a, b) => Number(b.kind === 'approval') - Number(a.kind === 'approval') || b.at - a.at);
}

/** How many items the scheme's Needs-you badge counts for `person`, who last saw each minion at `seen` (ticket id -> time): a ready/try or replies minion they opened since it changed stops counting, as in public/inbox.js. */
export function inboxCount(store: Store, approvals: Approvals, projectId: number, person: string, seen: Record<number, number>): number {
  const updated = new Map(store.listTickets(projectId).map((t) => [t.id, t.updated_at]));
  return inboxItems(store, approvals, projectId, person)
    .filter((i) => !((i.kind === 'state' || i.kind === 'replies') && (seen[i.ticketId] ?? 0) >= (updated.get(i.ticketId) ?? 0))).length;
}
