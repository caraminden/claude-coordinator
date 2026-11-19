// Held mail in a chat (#1067, Josh picked "C · A next-turn inbox card", 2026-11-19), as plain data so node tests can import
// it (thread.js and heldcard.js build the nodes). A held message is "waiting" while the ticket still lists its event id in
// held_ids: the inbox card over the composer shows it, and its bubble stays out of the log until a turn reads it.

/** Held mail the Taskmaster only keeps for tracking: the server's wording for a note that needs nothing done. */
export const TRACKING = /^\(for your tracking; nothing to do\)\s*/;

/** A held message's state, or null if it was never held: waiting (the card shows it) or read, with the read bubble's tag. */
export function heldLine(data, eventId, ticket) {
  if (!data?.mail) return null;
  const waiting = !!ticket?.held_ids?.includes(eventId);
  return { waiting, tag: data.parked ? 'left while parked' : 'held mail', title: data.parked ? 'Left while it was parked, read when it was unparked' : 'Held for its next turn, read then' };
}

/** The one-line hint over the composer while the open minion is parked (a message waits), or null. */
export function composerHint(t) {
  return parkedChat(t) ? "This minion is parked: messages wait until it's unparked." : null;
}

const parkedChat = (t) => !!(t.parked_for || t.state === 'parked') && t.kind !== 'coordinator' && t.status !== 'closed' && t.status !== 'running';

/** src/msg-settings.ts NEVER_HOLD_KINDS (test/held-list.test.ts keeps them equal): each `need`, and Citadel's own notes. */
export const NEVER_HOLD_KINDS = ['start', 'unpark', 'decision', 'relay', 'ask', 'fyi', 'note'];

/** What a kind of held mail is called on the never-hold menu and the Messages setting: a sender's `need`, or Citadel's notes. */
export const kindLabel = (k) => (k === 'note' ? "Citadel's notes" : `need: ${k}`);

/**
 * The inbox card for a chat (`t`, a ticket view), or null when nothing waits: the count, who reads it and when, a "Needs
 * you" row for a loop-guard hold, the mail grouped by sender (each section's kinds the scheme still holds, from `never`,
 * its msg_never_hold), and what the footer offers (`deliver`, `unpark`, or nothing while a turn runs).
 */
export function heldModel(t, never = '', fmt = String) {
  const items = t.held_mail?.items ?? [];
  const loop = t.loop_hold ?? null;
  if (!items.length && !loop) return null;
  const reader = t.kind === 'coordinator' ? 'the Taskmaster' : `#${t.number}`;
  const parked = parkedChat(t);
  const off = new Set(never.split(',').filter(Boolean));
  const by = new Map();
  for (const m of items) by.set(m.author, [...(by.get(m.author) ?? []), m]);
  const sections = [...by].map(([author, list]) => ({
    author, items: list,
    preview: (list.at(-1).text ?? '').replace(TRACKING, '').split('\n').find((l) => l.trim()) ?? '',
    kinds: parked ? [] : [...new Set(list.flatMap((m) => (m.parked ? [] : m.note ? ['note'] : m.need ? [m.need] : [])))].filter((k) => !off.has(k)),
  }));
  const sub = !items.length ? 'Held by the loop guard'
    : parked ? "It's parked: read when it's unparked"
      : t.held_mail.until ? `Read then, or by ${fmt(t.held_mail.until)}` : 'Read then';
  const footer = !items.length ? null
    : t.status === 'closed' ? { text: "Read if it's reopened", action: null }
    : t.status === 'running' ? { text: `All ${items.length} go in its next turn`, action: null }
      : { text: `All ${items.length} go in one turn`, action: parked ? 'unpark' : 'deliver' };
  return { count: items.length + (loop ? 1 : 0), title: `Waiting for ${reader}'s next turn`, sub, loop, sections, footer };
}
