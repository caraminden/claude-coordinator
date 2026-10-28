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

/** A day's use of the plan's weekly limit, followed from the weekly meter's readings (runner.updateUsage). */
export interface UsageDay {
  day: string;
  /** The meter (0..1) when the day started, in the current weekly window. */
  start: number;
  /** What the day used in weekly windows that reset during it. */
  carried: number;
  /** The latest reading and its window's reset time. */
  last: number;
  resetsAt: number | null;
  /** The share of a week's limit the day has used so far: carried + last - start. */
  share: number;
}

/**
 * Fold a new weekly reading into the day's tally. A day starts from the last reading before it;
 * when the window resets (its reset time moves), what the day used before goes into `carried`.
 */
export function trackDay(prev: UsageDay | null, weekly: { utilization: number; resetsAt: number | null }, day: string): UsageDay {
  const now = weekly.utilization;
  // The reset time is a fixed moment per window; allow for rounding between readings.
  const reset = !!prev && prev.resetsAt !== null && weekly.resetsAt !== null && Math.abs(weekly.resetsAt - prev.resetsAt) > 3600_000;
  let start: number;
  let carried = 0;
  if (!prev) start = now;
  else if (prev.day !== day) start = reset ? 0 : prev.last;
  else if (reset) {
    carried = prev.carried + Math.max(0, prev.last - prev.start);
    start = 0;
  } else {
    carried = prev.carried;
    start = prev.start;
  }
  return { day, start, carried, last: now, resetsAt: weekly.resetsAt, share: Math.max(0, carried + now - start) };
}
