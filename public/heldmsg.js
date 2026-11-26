/** @import { Ticket } from './types.js' */

// Held mail in a chat, as plain data so node tests can import it (thread.js builds the nodes). A held message is "waiting"
// while the ticket still lists its event id in held_ids: its bubble shows dashed with a quiet "Not sent yet" row and a small
// Deliver button (Josh, 2026-11-20: "make the held mail messages we show to users a lot less intense, maybe we go back to how
// it used to look with a small less intrusive "deliver" button"; #1067's inbox card is gone). While the minion is working it's
// "queued" instead: its bubble shows dashed, tagged "not sent yet" (Josh, 2026-11-19: "messages into a turn like this can be
// the old less intense view").

/** Held mail the Taskmaster only keeps for tracking: the server's wording for a note that needs nothing done. */
export const TRACKING = /^\(for your tracking; nothing to do\)\s*/;

/** A held message's state, or null if it was never held: waiting (the card shows it), queued into a working minion (its bubble
 * shows, `text` on its tag), or read, with the read bubble's tag. */
/**
 * @typedef {{ mail?: boolean, startHold?: unknown, parked?: unknown }} HeldData
 * @param {HeldData | null | undefined} data @param {number} eventId @param {Ticket} ticket
 */
export function heldLine(data, eventId, ticket) {
  if (!data?.mail) return null;
  const held = !!ticket?.held_ids?.includes(eventId);
  const queued = held && ticket.status === 'running';
  return { waiting: held && !queued, queued, text: 'Not sent yet: held mail, read on its next turn.', ...heldTag(data) };
}

// A start card's wait (#1757) isn't a seal, so its held messages say so.
/** @param {HeldData} data */
const heldTag = (data) =>
  data.startHold ? { tag: 'left before it started', title: 'Left while it waited for its start card, read when a person started it' } : data.parked ? { tag: 'left while sealed', title: 'Left while it was sealed, read when it was unsealed' } : { tag: 'held mail', title: 'Held for its next turn, read then' };

/** The one-line hint over the composer while the open minion is parked (a message waits), or null. */
/** @param {Ticket} t */
export function composerHint(t) {
  if (parkedChat(t)) return "This minion is sealed: messages wait until it's unsealed.";
  // Not sealed (#1757), but nothing runs until a person answers its start card.
  if (t.start_hold && t.kind !== 'coordinator' && t.status !== 'closed') return 'This minion waits for a go on its start card: messages wait until it starts.';
  return asleepChat(t) ? "This minion is asleep: a message or a card's answer wakes it." : null;
}

/** Asleep (#1636): out of Needs you and keepalives until something starts its turn. */
/** @param {Ticket} t */
export const asleepChat = (t) => !!t.asleep && t.kind !== 'coordinator' && t.status !== 'closed';
/** @param {Ticket} t */
const parkedChat = (t) => !!(t.parked_for || t.state === 'parked') && t.kind !== 'coordinator' && t.status !== 'closed' && t.status !== 'running';

/** src/msg-settings.ts NEVER_HOLD_KINDS (test/held-list.test.ts keeps them equal): each `need`, and Citadel's own notes. */
export const NEVER_HOLD_KINDS = ['start', 'unpark', 'decision', 'relay', 'ask', 'fyi', 'note'];

/** What a kind of held mail is called on the never-hold menu and the Messages setting: a sender's `need`, or Citadel's notes. */
/** @param {string} k */
export const kindLabel = (k) => (k === 'note' ? "Citadel's notes" : `need: ${k}`);
