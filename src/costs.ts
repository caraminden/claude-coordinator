// What Claude turns cost per day, at API prices (src/db.ts Turn). Days are the server's local days.
import type { Store } from './db.ts';

/** How many days the summary covers, today included. */
export const COST_DAYS = 7;

export interface CostDay {
  /** Local date, '2026-10-28'. */
  day: string;
  /** Every scheme's turns that day. */
  total: number;
  /** By project id. */
  byProject: Record<number, number>;
}

/** '2026-10-28' for a moment, in the server's time zone (what SQLite's 'localtime' uses too). */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The last COST_DAYS days, today first, with days that had no turns as zero. */
export function costDays(store: Store, now = Date.now()): CostDay[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (COST_DAYS - 1));
  const days: CostDay[] = [];
  for (let i = 0; i < COST_DAYS; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.unshift({ day: localDay(d.getTime()), total: 0, byProject: {} });
  }
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (const r of store.dailyCosts(start.getTime())) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.total += r.cost;
    d.byProject[r.project_id] = (d.byProject[r.project_id] ?? 0) + r.cost;
  }
  return days;
}

/** Below this the weekly meter, read to two decimals, is too coarse to price a week by. */
const MIN_UTILIZATION = 0.03;

/** The last estimate a meter could price, kept for the start of the next window. */
const LAST_BUDGET = 'day_budget';

/**
 * An even day's share of the plan's weekly limit (a seventh of it) at API prices: what turns cost since the
 * weekly window opened, scaled up by how full the meter is. Early in a window, while the meter is too coarse,
 * the last window's estimate stands in, so shares don't drop back to dollars every reset; null before any.
 */
export function dayBudget(store: Store, weekly: { utilization: number; resetsAt: number | null } | null | undefined): number | null {
  const last = store.getSetting<number>(LAST_BUDGET);
  if (!weekly?.resetsAt || weekly.utilization < MIN_UTILIZATION) return last;
  const spent = store.dailyCosts(weekly.resetsAt - 7 * 86400_000).reduce((sum, r) => sum + r.cost, 0);
  if (!(spent > 0)) return last;
  const budget = spent / weekly.utilization / 7;
  if (budget !== last) store.setSetting(LAST_BUDGET, budget);
  return budget;
}
