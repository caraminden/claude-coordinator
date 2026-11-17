// What Claude turns cost per day, at API prices (src/db.ts Turn). Days are the server's local days.
import { APP_NAME } from './appname.ts';
import type { SpendRowRaw, Store } from './db.ts';

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

/** "Opus 5.5" for claude-opus-5-5 (a dated or "+advisor" id too), "Opus" for the bare alias, anything else as it is. */
export function modelName(id: string): string {
  const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
  const m = /^claude-([a-z]+)-(\d+)-(\d{1,2})(?!\d)/.exec(id);
  if (m) return `${cap(m[1])} ${m[2]}.${m[3]}`;
  return /^(opus|sonnet|haiku|fable)$/.test(id) ? cap(id) : id;
}

/** One slice of a week's spend: this week's dollars, the week before's, and how much of this week's is estimated. */
export interface Slice {
  name: string;
  usd: number;
  lastWeek: number;
  /** Dollars of `usd` from turns before the split was kept, counted under the minion's own model (#905). */
  estimated: number;
}

export interface WhereItWent {
  since: number;
  until: number;
  total: number;
  lastWeek: number;
  /** One account's weekly limit at API prices, for shares; null until a meter can price it. */
  weekUsd: number | null;
  models: Slice[];
  schemes: (Slice & { id: number })[];
  kinds: Slice[];
  /** The 10 minions that cost the most this week. */
  top: { id: number; project_id: number; number: number | null; title: string; usd: number }[];
}

/** The kind of work a turn was: keepalive pings, Taskmasters, scheduled runs, else the minion's `type`. */
function kindOf(r: SpendRowRaw): string {
  if (r.keepalive) return 'Keepalive pings';
  if (r.kind === 'coordinator') return 'Taskmasters';
  if (r.created_by === APP_NAME) return 'Scheduled runs';
  return r.type ? r.type[0].toUpperCase() + r.type.slice(1) : 'No type';
}

/**
 * Where one payer's spend went (#905): the last 7 days against the 7 before, by model (Grunts' models apart), scheme,
 * kind of work, and the top 10 minions. Turns from before the split count under their minion's model, marked estimated.
 */
export function whereItWent(store: Store, payer: number | null, weekUsd: number | null, now = Date.now()): WhereItWent {
  const week = 7 * 86400_000;
  const projects = new Map(store.listProjects().map((p) => [p.id, p.name]));
  const group = <K>(rows: [SpendRowRaw, number, boolean][], key: (r: SpendRowRaw) => K, name: (k: K) => string, cur: boolean) => {
    const out = new Map<K, Slice>();
    for (const [r, usd, est] of rows) {
      const k = key(r);
      const s = out.get(k) ?? out.set(k, { name: name(k), usd: 0, lastWeek: 0, estimated: 0 }).get(k)!;
      if (cur) { s.usd += usd; if (est) s.estimated += usd; } else s.lastWeek += usd;
    }
    return out;
  };
  const rows = (since: number, until: number) => store.spendRows(payer, since, until).map((r): [SpendRowRaw, number, boolean] =>
    [{ ...r, model: modelName(r.model ?? r.minion_model ?? 'claude-opus-5-5') }, r.cost, r.model === null]);
  const cur = rows(now - week, now), prev = rows(now - 2 * week, now - week);
  const merge = <K>(key: (r: SpendRowRaw) => K, name: (k: K) => string) => {
    const m = group(cur, key, name, true);
    for (const [k, s] of group(prev, key, name, false)) (m.get(k) ?? m.set(k, { ...s, lastWeek: 0 }).get(k)!).lastWeek = s.lastWeek;
    return [...m.entries()].sort(([, a], [, b]) => b.usd - a.usd || b.lastWeek - a.lastWeek);
  };
  const minions = new Map<number, WhereItWent['top'][number]>();
  for (const [r, usd] of cur) {
    const m = minions.get(r.ticket_id) ?? minions.set(r.ticket_id, { id: r.ticket_id, project_id: r.project_id, number: r.number, title: r.title, usd: 0 }).get(r.ticket_id)!;
    m.usd += usd;
  }
  const sum = (rs: [SpendRowRaw, number, boolean][]) => rs.reduce((a, [, usd]) => a + usd, 0);
  return {
    since: now - week, until: now, total: sum(cur), lastWeek: sum(prev), weekUsd,
    models: merge((r) => r.model!, (k) => k).map(([, s]) => s),
    schemes: merge((r) => r.project_id, (id) => projects.get(id) ?? `Scheme ${id}`).map(([id, s]) => ({ ...s, id })),
    kinds: merge(kindOf, (k) => k).map(([, s]) => s),
    top: [...minions.values()].sort((a, b) => b.usd - a.usd).slice(0, 10),
  };
}
