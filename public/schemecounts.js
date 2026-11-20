// Which stream news can move a Needs-you count: the open scheme's badge and other schemes' pills (#188).
// Also where a Needs-you row takes you (#236).

// Chat events that open or settle a card.
const CARD_EVENTS = new Set(['question', 'question_result', 'plan', 'plan_result', 'approval', 'approval_result']);

/** A chat event that opens or settles a card (a typed answer settles one too). */
export const cardEvent = (event) => CARD_EVENTS.has(event.kind) || (event.kind === 'user_message' && !!JSON.parse(event.data).answer);

/** A minion moved into or out of ready/complete/try, offered or lost its replies, was dismissed or reopened, changed hands, raised or cleared a spend alert, or had the loop guard hold or release messages (or is new to us). */
export const countMoved = (before, after) => !before || before.state !== after.state || !before.replies?.length !== !after.replies?.length || (before.status === 'closed') !== (after.status === 'closed')
  || before.properties?.assigned !== after.properties?.assigned || before.spend_alert?.event !== after.spend_alert?.event || !before.loop_hold !== !after.loop_hold;

/**
 * A minion or Taskmaster whose turn is doing work, for the spinner and its number (#248, #278). A turn
 * held open on an approval card waits on a person, not working (#373; Cara, 2026-11-07: "it should only
 * count actually working minions"). `t.approvals` is how many of its cards wait, as runner.view sends it. The server
 * working for it with no turn of its own (`t.server_work`, a handed-off land) counts too (#727).
 */
export const isWorking = (t) => !!t && !t.approvals && (t.status === 'running' || (t.status !== 'closed' && !!t.server_work));

/** A minion started or ended work: the spinner beside the count (#248). */
export const turnMoved = (before, after) => isWorking(before) !== isWorking(after);

/**
 * What a scheme's pill shows (`p` as api/projects sends it): the Needs-you count, the spinner while a
 * turn runs (#248) and how many minions are working when that's more than one (#278; Cara,
 * 2026-11-02: "Only show if number > 1"). The spinner shows beside the count, not only at zero (#314;
 * Josh, 2026-11-05: "I think actually the blue spinner and number of minions should show regardless
 * of badge"). `fresh`: something waits on you that wasn't waiting when you last had the scheme open, as
 * the server's `fresh` says (#498, #539), for the violet count. `label` covers it all, for the tooltip and screen
 * readers; empty when the pill is hidden.
 */
export function schemePill(p) {
  const need = p.inbox || 0;
  const busy = !!p.running;
  // New items, not a moved count (#539; Cara, 2026-11-11: "a different color or something if the number has changed";
  // Josh, 2026-11-11: "Only when it went up", then "if one went up and one went down, or even 2 went down it should
  // still be purple"). Items only going away leave it plain, and at zero there's nothing to show.
  const fresh = need > 0 && !!p.fresh;
  const parts = [];
  if (need) parts.push(`${need} need${need === 1 ? 's' : ''} your answer${fresh ? ' (something new since you last opened it)' : ''}`);
  if (busy) parts.push(p.working ? `${p.working} minion${p.working === 1 ? '' : 's'} working` : 'Taskmaster working');
  return { need, busy, working: busy && p.working > 1 ? p.working : 0, fresh, label: parts.join(' · ') };
}

/**
 * Whether the installed app's icon wears a badge: any visible scheme's pill is purple (`schemePill(p).fresh`, the one
 * source of that colour). A plain dot, not a count: purple is per scheme, so a number would be ambiguous (#980).
 * `projects` as api/projects sends them; the open scheme's `fresh` is this page's own (`seen`, as inbox.js holds it).
 */
export const wantsBadge = (projects, openId, seen) =>
  (projects || []).some((p) => !p.hidden && !p.minimized && schemePill(p.id === openId && seen?.projectId === p.id ? { ...p, fresh: seen.fresh } : p).fresh);

/**
 * Set or clear the app badge to match `want`, only when it changed since the last call (`state.on`), and only where
 * the browser has the Badging API. Returns whether it called.
 */
export function syncBadge(want, state, nav = globalThis.navigator) {
  if (!nav || !('setAppBadge' in nav) || state.on === want) return false;
  state.on = want;
  (want ? nav.setAppBadge() : nav.clearAppBadge()).catch?.(() => {});
  return true;
}

/**
 * Which of the open scheme's waiting items (`{ key, ticketId }`) you've seen, given what you'd seen at the last
 * redraw and the chat open now (#548; Josh, 2026-11-11: "put the purple up on the scheme you are viewing unless you
 * are actively looking at the minion that is now asking for something and until you move minions"). Opening a chat
 * (`moved`) sees all of it; staying put, you see only what the chat you're on asks, and the rest is new to you.
 */
export const seenInScheme = (seen, waiting, chatId, moved) =>
  new Set(waiting.filter((i) => moved || seen.has(i.key) || i.ticketId === chatId).map((i) => i.key));

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
  return oldest.eventId ?? (['replies', 'loop'].includes(oldest.kind) ? 'latest' : null);
}
