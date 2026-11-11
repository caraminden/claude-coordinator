// Which stream news can move a Needs-you count: the open scheme's badge and other schemes' pills (#188).
// Also where a Needs-you row takes you (#236).

// Chat events that open or settle a card.
const CARD_EVENTS = new Set(['question', 'question_result', 'plan', 'plan_result', 'approval', 'approval_result']);

/** A chat event that opens or settles a card (a typed answer settles one too). */
export const cardEvent = (event) => CARD_EVENTS.has(event.kind) || (event.kind === 'user_message' && !!JSON.parse(event.data).answer);

/** A minion moved into or out of ready/try, offered or lost its replies, was dismissed or reopened, or changed hands (or is new to us). */
export const countMoved = (before, after) => !before || before.state !== after.state || !before.replies?.length !== !after.replies?.length || (before.status === 'closed') !== (after.status === 'closed')
  || before.properties?.assigned !== after.properties?.assigned;

/**
 * A minion or Taskmaster whose turn is doing work, for the spinner and its number (#248, #278). A turn
 * held open on an approval card waits on a person, not working (#373; Cara, 2026-11-07: "it should only
 * count actually working minions"). `t.approvals` is how many of its cards wait, as runner.view sends it.
 */
export const isWorking = (t) => t?.status === 'running' && !t.approvals;

/** A minion started or ended work: the spinner beside the count (#248). */
export const turnMoved = (before, after) => isWorking(before) !== isWorking(after);

/**
 * What a scheme's pill shows (`p` as api/projects sends it): the Needs-you count, the spinner while a
 * turn runs (#248) and how many minions are working when that's more than one (#278; Cara,
 * 2026-11-02: "Only show if number > 1"). The spinner shows beside the count, not only at zero (#314;
 * Josh, 2026-11-05: "I think actually the blue spinner and number of minions should show regardless
 * of badge"). `changed`: the count differs from `seenInbox`, the one last seen in the scheme (#498), and
 * shows even at zero. `label` covers it all, for the tooltip and screen readers; empty when the pill is hidden.
 */
export function schemePill(p) {
  const need = p.inbox || 0;
  const busy = !!p.running;
  // The count moved, up or down, since this person last had the scheme open (#498; Cara, 2026-11-11: "a different color or something if the number has changed").
  const changed = p.seenInbox != null && need !== p.seenInbox;
  const parts = [];
  if (need || changed) parts.push(`${need || 'None'} waiting on you${changed ? ` (${p.seenInbox} when you last opened it)` : ''}`);
  if (busy) parts.push(p.working ? `${p.working} minion${p.working === 1 ? '' : 's'} working` : 'Taskmaster working');
  return { need, busy, working: busy && p.working > 1 ? p.working : 0, changed, label: parts.join(' · ') };
}

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
      if (countMoved(before, t) || turnMoved(before, t)) refetch();
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
