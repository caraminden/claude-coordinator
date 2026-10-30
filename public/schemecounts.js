// Which stream news can move a Needs-you count: the open scheme's badge and other schemes' pills (#188).

// Chat events that open or settle a card.
const CARD_EVENTS = new Set(['question', 'question_result', 'plan', 'plan_result', 'approval', 'approval_result']);

/** A chat event that opens or settles a card (a typed answer settles one too). */
export const cardEvent = (event) => CARD_EVENTS.has(event.kind) || (event.kind === 'user_message' && !!JSON.parse(event.data).answer);

/** A minion moved into or out of ready/try, offered or lost its replies, or was dismissed or reopened (or is new to us). */
export const countMoved = (before, after) => !before || before.state !== after.state || !before.replies?.length !== !after.replies?.length || (before.status === 'closed') !== (after.status === 'closed');

/**
 * Other schemes' minions as the stream last showed them: `ticket` and `event` call `refetch` when
 * news may have moved those schemes' counts, so a scheme you aren't in still lights up.
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
  };
}
