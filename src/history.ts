// A minion's chat history a page at a time, so opening a long one costs about the same as a short one.
import type { Store } from './db.ts';
import { applyEvent, createProgress } from '../public/progress.js';

export const PAGE_EVENTS = 200;
const MAX_PAGE_EVENTS = 1000;

// Plans as they stood before a page's first event, per store by "ticket:event". History is append-only,
// so an entry never goes stale; replaying a long minion's earlier events costs ~10 ms, and opens repeat.
const plansByStore = new WeakMap<Store, Map<string, unknown[]>>();
const PLANS_KEPT = 200;

/**
 * The newest page before `before` (see Store.eventsPage), with the task list as it stood just before
 * the page: a plan can outlive the turn that made it, and the readout replays the page on top of it.
 * The newest page also reaches back to the turn holding the oldest card still waiting on people.
 */
export function historyPage(store: Store, ticketId: number, opts: { before?: number; limit?: number; from?: number } = {}) {
  const before = opts.before ?? Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Math.max(1, opts.limit ?? PAGE_EVENTS), MAX_PAGE_EVENTS);
  // The newest page reaches back to a card still waiting on people, or later turns push it behind Load earlier.
  const open = opts.before == null ? store.openCardEventId(ticketId) : null;
  const from = open == null ? opts.from : Math.min(open, opts.from ?? open);
  const { events, more } = store.eventsPage(ticketId, before, limit, from);
  return { events, more, tasks: more ? planBefore(store, ticketId, events[0].id) : [] };
}

function planBefore(store: Store, ticketId: number, eventId: number) {
  const plans = plansByStore.get(store) ?? new Map<string, unknown[]>();
  plansByStore.set(store, plans);
  const key = `${ticketId}:${eventId}`;
  let tasks = plans.get(key);
  if (!tasks) {
    const p = createProgress();
    for (const row of store.planEvents(ticketId, eventId)) applyEvent(p, row.kind, JSON.parse(row.data));
    tasks = p.tasks;
    plans.set(key, tasks);
    if (plans.size > PLANS_KEPT) plans.delete(plans.keys().next().value!);
  }
  return structuredClone(tasks);
}
