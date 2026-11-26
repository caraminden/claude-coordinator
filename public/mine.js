// Which of the Overlord's events show in every person's Mine (#920): what's marked for everyone, and its
// cards' answers and results so the cards settle there. src/db.ts MINE_EVENTS is the same rule as a query.

/** The few fields of a Taskmaster session this file reads (GET api/projects/:id `taskmasters`). @typedef {{ id: number, person_id: number | null, person_name: string | null }} TaskmasterBits */
/** One session in a merged chat: yours, or another's (with its label, and whether it is the Overlord's). @typedef {{ id: number, mine: boolean, overlord?: boolean, label?: string }} MergedPart */
/** A merged Taskmaster chat's description. @typedef {{ mode: 'mine' | 'everyone', src: string, parts: MergedPart[], states: Map<number, Partial<import('./types.js').View>>, last: number }} Merged */

/** Where this device keeps Mine or Everyone (#920): thread.js's switch, and a Needs-you row whose card only Everyone shows (#1400). */
export const TM_VIEW = 'cc-tm-view';

/**
 * Whether an Overlord event (a row with its JSON `data`) shows in Mine.
 * @param {{ kind: string, data: string | object }} event
 */
export function inMine(event) {
  if (['question_result', 'question_more', 'card_reply', 'plan_result', 'approval_result'].includes(event.kind)) return true;
  /** @type {{ everyone?: unknown, answer?: unknown, plan?: unknown } | null} */
  const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  return data?.everyone === true || (event.kind === 'user_message' && (data?.answer != null || data?.plan != null));
}

/**
 * Your Taskmaster's chat merged with the scheme's other sessions (thread.js appendEvent), or null when the
 * scheme has one Taskmaster. `taskmasters` is the project payload's list; `mode` is 'mine' or 'everyone'.
 * Mine adds the Overlord's for-everyone items; Everyone adds every session whole (src/routes/projects.ts).
 * @param {number} projectId
 * @param {number | null} ownId null matches no Taskmaster, so it returns null
 * @param {TaskmasterBits[] | null | undefined} taskmasters
 * @param {string} mode
 * @returns {Merged | null}
 */
export function mergedView(projectId, ownId, taskmasters, mode) {
  if (!((taskmasters?.length ?? 0) > 1) || !(/** @type {TaskmasterBits[]} */ (taskmasters).some((t) => t.id === ownId))) return null;
  const everyone = mode === 'everyone';
  const others = /** @type {TaskmasterBits[]} */ (taskmasters).filter((t) => t.id !== ownId && (everyone || t.person_id == null));
  return {
    mode: everyone ? 'everyone' : 'mine',
    src: `api/projects/${projectId}/taskmaster-events?view=${everyone ? 'everyone' : 'mine'}`,
    // Someone who hasn't written yet has the Overlord as theirs (src/routes/projects.ts): Mine filters it too.
    parts: [
      { id: /** @type {number} */ (ownId), mine: !everyone && /** @type {TaskmasterBits} */ (/** @type {TaskmasterBits[]} */ (taskmasters).find((t) => t.id === ownId)).person_id == null },
      ...others.map((t) => ({
        id: t.id,
        mine: !everyone,
        overlord: t.person_id == null,
        label: t.person_id == null ? 'Overlord' : `${t.person_name ?? 'Someone'}'s Taskmaster`,
      })),
    ],
    states: new Map(), // thread.js: each other session's drawing state
    last: /** @type {number} */ (ownId), // the session the newest drawn event was in
  };
}

/**
 * Whether a live event belongs in the merged view (core.js onEvent).
 * @param {Merged | null | undefined} merged
 * @param {{ ticket_id: number, kind: string, data: string | object }} event
 */
export function inMerged(merged, event) {
  const part = merged?.parts.find((p) => p.id === event.ticket_id);
  return !!part && (!part.mine || inMine(event));
}
