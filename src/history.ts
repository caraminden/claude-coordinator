// A minion's chat history a page at a time, so opening a long one costs about the same as a short one.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pagePlanKey, type Store } from './db.ts';
import { applyEvent, createProgress } from '../public/progress.js';

type Progress = ReturnType<typeof createProgress>;
/** The task-list rules a saved state was built by: one from another public/progress.js is rebuilt in full, so no deploy leaves old counts (#530). */
const PLAN_RULES = createHash('sha256').update(readFileSync(new URL('../public/progress.js', import.meta.url))).digest('hex').slice(0, 16);

/** A task-list state as saved in settings (planKey, pagePlanKey): it holds every event up to `upTo`. */
export const packPlan = (p: Progress, upTo: number) => ({ rules: PLAN_RULES, upTo, p: { ...p, pendingCreates: [...p.pendingCreates], finished: undefined } });

/** A saved state back (packPlan), or null when it's missing, malformed or from other task-list rules. */
export function unpackPlan(saved: any): { upTo: number; p: Progress } | null {
  const usable = saved?.rules === PLAN_RULES && Number.isInteger(saved.upTo) && Array.isArray(saved.p?.tasks) && Array.isArray(saved.p.pendingCreates);
  return usable ? { upTo: saved.upTo, p: { ...saved.p, pendingCreates: new Map(saved.p.pendingCreates), finished: null } } : null;
}

export const PAGE_EVENTS = 200;
const MAX_PAGE_EVENTS = 1000;

// Plans as they stood before a page's first event, per store by "ticket:event". History is append-only,
// so an entry never goes stale; replaying a long minion's earlier events costs ~10 ms, and opens repeat.
const plansByStore = new WeakMap<Store, Map<string, unknown[]>>();
const PLANS_KEPT = 200;
// Each chat's replay state at the furthest page start read, so a newer page (a growing chat's newest page starts
// later each open) replays only the events since, not the whole history: 1.3 s for a Taskmaster on live (#609).
// It's saved too (pagePlanKey), so the first open after a restart resumes as well: 590 ms cold for a Taskmaster (#613).
const replaysByStore = new WeakMap<Store, Map<number, { before: number; p: Progress }>>();

/**
 * The newest page before `before` (see Store.eventsPage), with the task list as it stood just before
 * the page: a plan can outlive the turn that made it, and the readout replays the page on top of it.
 * The newest page also reaches back to the turn holding the oldest card still waiting on people.
 */
export function historyPage(store: Store, ticketId: number, opts: { before?: number; limit?: number; from?: number } = {}) {
  const before = opts.before ?? Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Math.max(1, opts.limit ?? PAGE_EVENTS), MAX_PAGE_EVENTS);
  // The newest page reaches back to a card still waiting on people, or later turns push it behind Load earlier.
  // shortcut: a card with more than MAX_PAGE_EVENTS after it stays behind Load earlier; page towards it if that bites.
  const open = opts.before == null ? store.openCardEventId(ticketId, MAX_PAGE_EVENTS) : null;
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
    const replays = replaysByStore.get(store) ?? new Map();
    replaysByStore.set(store, replays);
    let at = replays.get(ticketId);
    if (!at) {
      const saved = unpackPlan(store.getSetting(pagePlanKey(ticketId)));
      if (saved) at = { before: saved.upTo + 1, p: saved.p };
    }
    const resume = at && at.before <= eventId;
    const p = resume ? structuredClone(at!.p) : createProgress();
    for (const row of store.planEvents(ticketId, eventId, resume ? at!.before - 1 : 0)) applyEvent(p, row.kind, JSON.parse(row.data), row.created_at);
    if (!at || resume) {
      replays.delete(ticketId); // re-added last, so the oldest-used chat goes first
      replays.set(ticketId, { before: eventId, p: structuredClone(p) });
      if (replays.size > PLANS_KEPT) replays.delete(replays.keys().next().value!);
      if (at?.before !== eventId) store.setSetting(pagePlanKey(ticketId), packPlan(p, eventId - 1));
    }
    tasks = p.tasks;
    plans.set(key, tasks);
    if (plans.size > PLANS_KEPT) plans.delete(plans.keys().next().value!);
  }
  return structuredClone(tasks);
}
