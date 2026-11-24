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

/** The stream moved a minion in or out of Dismissed: the count follows, for ones the page knew about. */
export function noteTicketChange(before, ticket) {
  const s = closedState();
  // A minion the page never read, now open and not just created: it was dismissed and reopened, so the count drops (a new minion is minutes old).
  if (!before) {
    if (ticket.status !== 'closed' && ticket.created_at < Date.now() - 300_000) s.total = Math.max(0, s.total - 1);
    return;
  }
  if (before.status !== 'closed' && ticket.status === 'closed') s.total++;
  else if (before.status === 'closed' && ticket.status !== 'closed') s.total = Math.max(0, s.total - 1);
}

/** A reconnect's fresh open list, with the dismissed rows already loaded kept (the fresh copy of any that reopened wins). */
export function mergeOpen(open, dismissed) {
  const old = view.tickets;
  const next = new Map(open.map((t) => [t.id, t]));
  for (const t of old.values()) if (t.status === 'closed' && !next.has(t.id)) next.set(t.id, t);
  states.set(next, { ...closedState(old) });
  // One dismissed while the stream was down is no longer in the fresh open list: restart the paging so the next read brings it.
  if ([...old.values()].some((t) => t.status !== 'closed' && !next.has(t.id))) Object.assign(closedState(next), { cursor: null, more: true });
  setClosedTotal(next, dismissed);
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
