// Which of the Overlord's events show in every person's Mine (#920): what's marked for everyone, and its
// cards' answers and results so the cards settle there. src/db.ts MINE_EVENTS is the same rule as a query.

/** Whether an Overlord event (a row with its JSON `data`) shows in Mine. */
export function inMine(event) {
  if (['question_result', 'plan_result', 'approval_result'].includes(event.kind)) return true;
  const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  return data?.everyone === true || (event.kind === 'user_message' && (data?.answer != null || data?.plan != null));
}

/**
 * Your Taskmaster's chat merged with the scheme's other sessions (thread.js appendEvent), or null when the
 * scheme has one Taskmaster. `taskmasters` is the project payload's list; `mode` is 'mine' or 'everyone'.
 * Mine adds the Overlord's for-everyone items; Everyone adds every session whole (src/routes/projects.ts).
 */
export function mergedView(projectId, ownId, taskmasters, mode) {
  if (!(taskmasters?.length > 1) || !taskmasters.some((t) => t.id === ownId)) return null;
  const everyone = mode === 'everyone';
  const others = taskmasters.filter((t) => t.id !== ownId && (everyone || t.person_id == null));
  return {
    mode: everyone ? 'everyone' : 'mine',
    src: `api/projects/${projectId}/taskmaster-events?view=${everyone ? 'everyone' : 'mine'}`,
    // Someone who hasn't written yet has the Overlord as theirs (src/routes/projects.ts): Mine filters it too.
    parts: [{ id: ownId, mine: !everyone && taskmasters.find((t) => t.id === ownId).person_id == null }, ...others.map((t) => ({
      id: t.id, mine: !everyone, overlord: t.person_id == null,
      label: t.person_id == null ? 'Overlord' : `${t.person_name ?? 'Someone'}'s Taskmaster`,
    }))],
    states: new Map(), // thread.js: each other session's drawing state
    last: ownId, // the session the newest drawn event was in
  };
}

/** Whether a live event belongs in the merged view (core.js onEvent). */
export function inMerged(merged, event) {
  const part = merged?.parts.find((p) => p.id === event.ticket_id);
  return !!part && (!part.mine || inMine(event));
}
