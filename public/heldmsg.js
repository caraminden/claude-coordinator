// How a person sees a message that hasn't reached its minion yet, as plain data so node tests can import it
// (thread.js builds the nodes). A held message is "waiting" while the ticket still lists its event id in held_ids.

/** The status line for a held message's bubble, or null if it was never held. */
export function heldLine(data, eventId, ticket) {
  if (!data?.mail) return null;
  const waiting = !!ticket?.held_ids?.includes(eventId);
  if (data.parked) {
    return waiting
      ? { waiting, unpark: true, text: "Not sent yet: this minion is parked. It reads this when it's unparked." }
      : { waiting, unpark: false, text: 'Read by the minion when it was unparked.' };
  }
  if (data.cold) {
    return waiting
      ? { waiting, unpark: false, text: 'Not sent yet: this chat was idle over 55 minutes, so it is read on the next turn, or within 3 hours.' }
      : { waiting, unpark: false, text: 'Read on its next turn.' };
  }
  return waiting
    ? { waiting, unpark: false, text: 'Not sent yet: held mail, read on its next turn.' }
    : { waiting, unpark: false, text: 'Read on its next turn.' };
}

/** The one-line hint over the composer while the open minion is parked (a message waits), or null. */
export function composerHint(t) {
  const parked = (t.parked_for || t.state === 'parked') && t.kind !== 'coordinator' && t.status !== 'closed' && t.status !== 'running';
  return parked ? "This minion is parked: messages wait until it's unparked." : null;
}
