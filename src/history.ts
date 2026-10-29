// A minion's chat history a page at a time, so opening a long one costs about the same as a short one.
import type { Store } from './db.ts';
import { applyEvent, createProgress } from '../public/progress.js';

export const PAGE_EVENTS = 200;
const MAX_PAGE_EVENTS = 1000;

/**
 * The newest page before `before` (see Store.eventsPage), with the task list as it stood just before
 * the page: a plan can outlive the turn that made it, and the readout replays the page on top of it.
 */
export function historyPage(store: Store, ticketId: number, opts: { before?: number; limit?: number; from?: number } = {}) {
  const before = opts.before ?? Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Math.max(1, opts.limit ?? PAGE_EVENTS), MAX_PAGE_EVENTS);
  const { events, more } = store.eventsPage(ticketId, before, limit, opts.from);
  const p = createProgress();
  if (more) for (const row of store.planEvents(ticketId, events[0].id)) applyEvent(p, row.kind, JSON.parse(row.data));
  return { events, more, tasks: p.tasks };
}
