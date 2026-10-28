// The Needs-you inbox: everything in a scheme that waits on a person, as one list of items.
import type { Approvals } from './approvals.ts';
import type { Store } from './db.ts';

export interface InboxItem {
  /** A card kind ('approval', 'question', 'plan': the chat event's kind), or 'state' for a minion in state ready or try. */
  kind: string;
  ticketId: number;
  /** When it started waiting. */
  at: number;
  /** The card as its chat shows it, so the inbox can act on it in place; none for 'state'. */
  card?: unknown;
}

/** Approval cards hold up a running turn, so they come first; the rest newest first. */
export function inboxItems(store: Store, approvals: Approvals, projectId: number): InboxItem[] {
  const tickets = store.listTickets(projectId).filter((t) => t.status !== 'closed');
  const ids = new Set(tickets.map((t) => t.id));
  const items: InboxItem[] = [
    ...approvals.pending().filter((a) => ids.has(a.ticketId)).map(({ ticketId, at, card }) => ({ kind: 'approval', ticketId, at, card })),
    // A new stored card kind only needs adding to Store.openCards.
    ...store.openCards(projectId).map((e) => ({ kind: e.kind, ticketId: e.ticket_id, at: e.created_at, card: JSON.parse(e.data) })),
    ...tickets.filter((t) => t.state === 'ready' || t.state === 'try').map((t) => ({ kind: 'state', ticketId: t.id, at: t.updated_at })),
  ];
  return items.sort((a, b) => Number(b.kind === 'approval') - Number(a.kind === 'approval') || b.at - a.at);
}
