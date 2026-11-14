// What Claude turns cost per day, at API prices (src/db.ts Turn). Days are the server's local days.
import type { Store } from './db.ts';

/** How many days the summary covers, today included. */
export const COST_DAYS = 7;

export interface CostDay {
  /** Local date, '2026-10-28'. */
  day: string;
  /** Every scheme's turns that day, the server login's only: what its weekly meter counts (#468 S05-3). */
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
  for (const r of store.dailyCosts(start.getTime(), true)) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.total += r.cost;
    d.byProject[r.project_id] = (d.byProject[r.project_id] ?? 0) + r.cost;
  }
  return days;
}

/** How many days the split's "month" covers, today included. */
export const MONTH_DAYS = 30;

export interface SpendRow {
  name: string;
  /** The last COST_DAYS days, today included. */
  week: number;
  /** The last MONTH_DAYS days, today included. */
  month: number;
}

/**
 * Who paid and where it went (#689): every payer's turns by person (the server login under its owner's name)
 * and by scheme, for the last week and month, most spent this month first.
 */
export function spendSplit(store: Store, now = Date.now()): { people: SpendRow[]; schemes: SpendRow[] } {
  const dayStart = (back: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    return d.getTime();
  };
  const users = new Map(store.listUsers().map((u) => [u.id, u.name]));
  const host = store.listUsers().find((u) => u.server_login)?.name ?? 'Server';
  const projects = new Map(store.listProjects().map((p) => [p.id, p.name]));
  const people = new Map<string, SpendRow>();
  const schemes = new Map<string, SpendRow>();
  const add = (into: Map<string, SpendRow>, name: string, key: 'week' | 'month', cost: number) => {
    const row = into.get(name) ?? into.set(name, { name, week: 0, month: 0 }).get(name)!;
    row[key] += cost;
  };
  for (const [key, since] of [['month', dayStart(MONTH_DAYS - 1)], ['week', dayStart(COST_DAYS - 1)]] as const) {
    for (const r of store.spendByPayer(since)) {
      add(people, r.payer === null ? `${host} (server login)` : users.get(r.payer) ?? `Person ${r.payer}`, key, r.cost);
      add(schemes, projects.get(r.project_id) ?? `Scheme ${r.project_id}`, key, r.cost);
    }
  }
  const order = (m: Map<string, SpendRow>) => [...m.values()].filter((r) => r.month > 0).sort((a, b) => b.month - a.month);
  return { people: order(people), schemes: order(schemes) };
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
export function dayBudget(store: Store, weekly: { utilization: number; resetsAt: number | null } | null | undefined, now = Date.now()): number | null {
  const last = store.getSetting<number>(LAST_BUDGET);
  // A reset time already past: the meter is last week's, and its window's turns are gone from view.
  if (!weekly?.resetsAt || weekly.resetsAt <= now || weekly.utilization < MIN_UTILIZATION) return last;
  // The meter is the server login's plan: only its turns priced it (#468 S05-3).
  const spent = store.dailyCosts(weekly.resetsAt - 7 * 86400_000, true).reduce((sum, r) => sum + r.cost, 0);
  if (!(spent > 0)) return last;
  const budget = spent / weekly.utilization / 7;
  if (budget !== last) store.setSetting(LAST_BUDGET, budget);
  return budget;
}
