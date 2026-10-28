// The Needs-you inbox: everything in any scheme that waits on a person, as one list of items.
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
export function inboxItems(store: Store, approvals: Approvals): InboxItem[] {
  const items: InboxItem[] = [
    ...approvals.pending().map(({ ticketId, at, card }) => ({ kind: 'approval', ticketId, at, card })),
    // A new stored card kind only needs adding to Store.openCards.
    ...store.openCards().map((e) => ({ kind: e.kind, ticketId: e.ticket_id, at: e.created_at, card: JSON.parse(e.data) })),
  ];
  return items.sort((a, b) => Number(b.kind === 'approval') - Number(a.kind === 'approval') || b.at - a.at);
}
