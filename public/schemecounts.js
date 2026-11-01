// Which stream news can move a Needs-you count: the open scheme's badge and other schemes' pills (#188).
// Also where a Needs-you row takes you (#236).

// Chat events that open or settle a card.
const CARD_EVENTS = new Set(['question', 'question_result', 'plan', 'plan_result', 'approval', 'approval_result']);

/** A chat event that opens or settles a card (a typed answer settles one too). */
export const cardEvent = (event) => CARD_EVENTS.has(event.kind) || (event.kind === 'user_message' && !!JSON.parse(event.data).answer);

/** A minion moved into or out of ready/try, offered or lost its replies, was dismissed or reopened, changed hands, or started or ended a turn (the spinner, #248) (or is new to us). */
export const countMoved = (before, after) => !before || before.state !== after.state || !before.replies?.length !== !after.replies?.length || (before.status === 'closed') !== (after.status === 'closed')
  || before.properties?.assigned !== after.properties?.assigned || (before.status === 'running') !== (after.status === 'running');

/**
 * Other schemes' minions as the stream last showed them: `ticket` and `event` call `refetch` when
 * news may have moved those schemes' counts, so a scheme you aren't in still lights up. `forget`
 * when the counts are fetched afresh: what was last seen before then may be out of date.
 */
export function otherSchemes(refetch) {
  const last = new Map(); // ticket id -> the minion as last seen
  return {
    ticket(t) {
      const before = last.get(t.id);
      last.set(t.id, t);
      if (countMoved(before, t)) refetch();
    },
    event(event) {
      if (cardEvent(event)) refetch();
    },
    forget: () => last.clear(),
  };
}

/** Where a minion's Needs-you row takes you (#236): the oldest thing it waits on you for, as a jump target (an event id, or 'latest' for a ready, try or replies item: the minion's latest reply); null for none. */
export function rowTarget(items) {
  const oldest = items.reduce((a, b) => (b.at < a.at ? b : a));
  return oldest.eventId ?? (oldest.kind === 'state' || oldest.kind === 'replies' ? 'latest' : null);
}
