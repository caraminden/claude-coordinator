// A minion's chat history a page at a time, so opening a long one costs about the same as a short one.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pagePlanKey, type Store } from './db.ts';
import { applyEvent, createProgress, planPlace } from '../public/progress.js';
import { cutEvent } from '../public/eventcut.js';

type Progress = ReturnType<typeof createProgress>;
/** The task-list rules a saved state was built by: one from another public/progress.js is rebuilt in full, so no deploy leaves old counts (#530). */
const PLAN_RULES = createHash('sha256')
  .update(readFileSync(new URL('../public/progress.js', import.meta.url)))
  .digest('hex')
  .slice(0, 16);

/** A task-list state as saved in settings (planKey, pagePlanKey): it holds every event up to `upTo`. */
export const packPlan = (p: Progress, upTo: number) => ({ rules: PLAN_RULES, upTo, p: { ...p, pendingCreates: [...p.pendingCreates], finished: undefined } });

type SavedPlan = { rules?: unknown; upTo: number; p: Omit<Progress, 'pendingCreates' | 'finished'> & { pendingCreates: [unknown, unknown][] } };

/** A saved state back (packPlan), or null when it's missing, malformed or from other task-list rules. */
export function unpackPlan(saved: SavedPlan | null): { upTo: number; p: Progress } | null {
  const usable = saved?.rules === PLAN_RULES && Number.isInteger(saved.upTo) && Array.isArray(saved.p?.tasks) && Array.isArray(saved.p.pendingCreates);
  return usable ? { upTo: saved.upTo, p: { ...saved.p, pendingCreates: new Map(saved.p.pendingCreates), finished: null } } : null;
}

export const PAGE_EVENTS = 200;
const MAX_PAGE_EVENTS = 1000;

// Plans as they stood before a page's first event, per store by "ticket:event". History is append-only,
// so an entry never goes stale; replaying a long minion's earlier events costs ~10 ms, and opens repeat.
const plansByStore = new WeakMap<Store, Map<string, PagePlan>>();
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
  // Long tool inputs and results go as a beginning; an opened action fetches the whole event (eventcut.js).
  return { events: events.map(cutEvent), more, ...(more ? planBefore(store, ticketId, events[0].id) : { tasks: [] }) };
}

/** The plan before a page: its steps, and where it is among them (#1923). */
type PagePlan = { tasks: Progress['tasks']; plan?: ReturnType<typeof planPlace> };

function planBefore(store: Store, ticketId: number, eventId: number): PagePlan {
  const plans = plansByStore.get(store) ?? new Map<string, PagePlan>();
  plansByStore.set(store, plans);
  const key = `${ticketId}:${eventId}`;
  let plan = plans.get(key);
  if (!plan) {
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
    plan = { tasks: p.tasks, plan: planPlace(p) };
    plans.set(key, plan);
    if (plans.size > PLANS_KEPT) plans.delete(plans.keys().next().value!);
  }
  return structuredClone(plan);
}

/** A Taskmaster session in a merged chat (#920): `mine` keeps only what Mine shows from the Overlord (public/mine.js). */
export type Part = { id: number; mine?: boolean };

/**
 * Several Taskmaster sessions as one chat, a page before `before` (Mine and Everyone, #920). Event ids are
 * global, so one id cursor pages them all: the page starts where the session with more history behind it
 * starts latest, and everything from there on comes from every session, so paging back never skips or
 * repeats an event. The first part is the viewer's own session: its task list rides along as in historyPage.
 */
export function mergedPage(store: Store, parts: Part[], opts: { before?: number; limit?: number; from?: number } = {}) {
  const before = opts.before ?? Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Math.max(1, opts.limit ?? PAGE_EVENTS), MAX_PAGE_EVENTS);
  const pages = parts.map((p) => {
    if (!p.mine) return store.eventsPage(p.id, before, limit);
    // A filtered session pages by what shows, so a run of hidden work costs no page.
    const rows = store.eventsBefore(p.id, before, limit + 1, true);
    return { events: rows.slice(0, limit).reverse(), more: rows.length > limit };
  });
  const behind = pages.filter((p) => p.more).map((p) => p.events[0].id);
  let start = behind.length ? Math.max(...behind) : 0;
  // The newest page reaches back to a card still waiting in any session, as historyPage does.
  const open = opts.before == null ? parts.map((p) => store.openCardEventId(p.id, MAX_PAGE_EVENTS)).filter((id) => id != null) : [];
  start = Math.min(start, ...open, opts.from ?? start);
  const events = parts
    .flatMap((p, i) => {
      const page = pages[i];
      const first = page.events[0]?.id ?? before;
      const reach = page.more && start < first ? store.eventsBetween(p.id, start, first, p.mine) : [];
      return reach.concat(page.events.filter((e) => e.id >= start));
    })
    .sort((a, b) => a.id - b.id);
  const more = parts.some((p) => store.eventsBefore(p.id, start, 1, p.mine).length > 0);
  const own = parts[0];
  const firstOwn = events.find((e) => e.ticket_id === own?.id)?.id;
  const plan: PagePlan = own && !own.mine && firstOwn != null && store.eventsBefore(own.id, firstOwn, 1).length ? planBefore(store, own.id, firstOwn) : { tasks: [] };
  return { events: events.map(cutEvent), more, ...plan };
}

/** Every session's events after `after`, as one list in order (the merged chat's catch-up). */
export function mergedAfter(store: Store, parts: Part[], after: number) {
  return parts.flatMap((p) => store.eventsBetween(p.id, after + 1, Number.MAX_SAFE_INTEGER, p.mine)).sort((a, b) => a.id - b.id);
}
