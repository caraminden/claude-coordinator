// The dismissed minions load on demand, a page at a time, newest first (closed-list-on-demand): a scheme page
// opens with its open minions and a count of the dismissed; their rows come when the Dismissed list is opened,
// scrolled, searched or linked to. The state belongs to a scheme's minion list (its Map), so another scheme's
// load, or a redraw from a new Map, never reads another's cursor.
import { api, view } from './base.js';

export const CLOSED_PAGE = 50;
const states = new WeakMap();

/** A list's paging state: `total` the server's count of dismissed minions, `cursor` the oldest row of the pages read, `more` whether older ones remain. */
export function closedState(list = view?.tickets) {
  let s = states.get(list);
  if (!s) states.set(list, (s = { total: 0, cursor: null, more: true, busy: null, failed: false }));
  return s;
}

/** The scheme load's answer: how many are dismissed in all (a scheme with none has nothing to page). */
export function setClosedTotal(list, total) {
  const s = closedState(list);
  s.total = total ?? 0;
  if (!s.total && !s.cursor) s.more = false;
}

/** What a scheme left in the page cache carries back with it: the pages read so far. */
export const closedSnapshot = (list) => {
  const { total, cursor, more } = closedState(list);
  return { total, cursor, more };
};
export function restoreClosed(list, snap) {
  if (snap) Object.assign(closedState(list), snap);
}

/** The dismissed minions the page has, newest first. */
export const loadedClosed = (list = view.tickets) => [...list.values()].filter((t) => t.status === 'closed');

/** The Dismissed list's count: the server's, never below the rows already in hand. */
export const closedCount = (list = view.tickets) => Math.max(closedState(list).total, loadedClosed(list).length);

/** Was it dismissed as the count last had it? A minion the page never read and not just created was (a new minion is minutes old). */
const wasClosed = (before, t) => (before ? before.status === 'closed' : t.created_at < Date.now() - 300_000);

/** The stream moved a minion in or out of Dismissed: the count follows, for ones the page knew about. */
export function noteTicketChange(before, ticket) {
  const s = closedState();
  if (ticket.status !== 'closed') {
    if (wasClosed(before, ticket)) s.total = Math.max(0, s.total - 1);
  } else if (before && before.status !== 'closed') s.total++;
}

/**
 * Which of two copies to keep when a fetch answers: `now` on the page, `before` on it as the fetch began. The newer; on a
 * tie the one the stream brought meanwhile, else the fetched one (some changes leave updated_at alone).
 */
export const freshest = (now, before, fetched) => (now?.updated_at > fetched.updated_at || (now && now !== before && now.updated_at === fetched.updated_at) ? now : fetched);

/**
 * A reconnect's fresh open list on the one shown, `before` as it was when the fetch began: what the stream brought
 * meanwhile stands unless the answer is newer, and the dismissed rows already loaded are kept (the fresh copy of any that reopened wins).
 */
export function mergeOpen(open, dismissed, before) {
  const old = view.tickets;
  const next = new Map(open.map((t) => [t.id, freshest(old.get(t.id), before.get(t.id), t)]));
  let total = dismissed ?? 0;
  for (const t of open) if (next.get(t.id).status === 'closed' && t.status !== 'closed') total++;
  let gone = false;
  for (const t of old.values()) {
    if (next.has(t.id)) continue;
    const live = before.get(t.id) !== t; // came while the fetch was on its way
    if (t.status === 'closed' || live) next.set(t.id, t);
    else gone = true;
    if (live && t.status !== 'closed' && wasClosed(before.get(t.id), t)) total--;
  }
  states.set(next, { ...closedState(old) });
  // One dismissed while the stream was down is no longer in the fresh open list: restart the paging so the next read brings it.
  if (gone) Object.assign(closedState(next), { cursor: null, more: true });
  setClosedTotal(next, Math.max(0, total));
  return next;
}

/** Read the next page of dismissed minions into the list; one read at a time (a second call waits on the first). Resolves with whether it worked. */
export function loadMoreClosed(list = view.tickets) {
  const s = closedState(list);
  if (s.busy) return s.busy;
  if (!s.more) return Promise.resolve(true);
  const { projectId } = view;
  const q = new URLSearchParams({ tickets: 'closed', limit: String(CLOSED_PAGE) });
  if (s.cursor) {
    q.set('before', s.cursor.t);
    q.set('before_id', s.cursor.id);
  }
  s.failed = false;
  const run = (s.busy = api(`api/projects/${projectId}?${q}`)
    .then(
      (r) => {
        if (view?.kind !== 'project' || view.tickets !== list) return false; // another scheme's load owns the page now
        // The stream may have brought a fresher copy meanwhile (one reopened, say): that one stays.
        for (const t of r.tickets) if (!list.has(t.id)) list.set(t.id, t);
        const last = r.tickets.at(-1);
        if (last) s.cursor = { t: last.updated_at, id: last.id };
        s.more = !!r.more;
        if (typeof r.dismissed === 'number') s.total = r.dismissed;
        return true;
      },
      () => {
        s.failed = true;
        return false;
      },
    )
    .finally(() => {
      if (s.busy === run) s.busy = null;
    }));
  return run;
}

/** Read pages until `done()` or none are left; false if one failed. */
async function loadUntil(list, done) {
  const s = closedState(list);
  while (s.more && !done()) if (!(await loadMoreClosed(list))) return false;
  return true;
}

/** Every dismissed minion updated after `since` (the recap's). */
export const loadClosedSince = (since) =>
  loadUntil(view.tickets, () => {
    const c = closedState().cursor;
    return c && c.t <= since;
  });
/** All of them (a property filter has to look at every row). */
export const loadAllClosed = () => loadUntil(view.tickets, () => false);

/** One dismissed minion by its number (a link to it): put in the list, or null when the scheme has none. */
export async function fetchClosedByNumber(number) {
  const list = view.tickets;
  const [t] = (await api(`api/projects/${view.projectId}?tickets=closed&number=${number}`)).tickets;
  if (t && view.tickets === list && !list.has(t.id)) list.set(t.id, t);
  return t ?? null;
}

/** The dismissed minions whose number, title or properties match `q`, asked of the server: { tickets, more }. */
export async function searchClosed(q) {
  const { tickets, more } = await api(`api/projects/${view.projectId}?tickets=closed&limit=${CLOSED_PAGE}&q=${encodeURIComponent(q)}`);
  return { tickets, more: !!more };
}
