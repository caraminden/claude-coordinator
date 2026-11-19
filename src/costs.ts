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

/** The server login's last priced estimate from before accounts were split (now each account keeps week_usd:host…). */
const LAST_BUDGET = 'day_budget';

type Meter = { weekly: { utilization: number; resetsAt: number | null } | null };
export interface WeekPart { n: number; label: string; limit: number | null; /** no estimate of its own yet: counted like the priced accounts' average */ assumed: boolean }

/**
 * The server login's weekly limit at API prices, every Claude account together (Cara, 2026-11-17: the Day chip ignored the
 * second account): the sum of each account's weekLimit. An account with no estimate yet counts as the average of the priced
 * ones, `assumed`; null before any is priced. `usage` is runner.usageOf's (an `accounts` list when there are several).
 */
export function hostWeek(store: Store, usage: (Meter & { accounts?: { n: number; label: string; usage: Meter | null }[] }) | null | undefined, now = Date.now()): { limit: number | null; parts: WeekPart[] } {
  const list = usage?.accounts ?? [{ n: 1, label: '', usage }];
  const parts = list.map((a): WeekPart => ({ n: a.n, label: a.label, limit: weekLimit(store, null, { weekly: a.usage?.weekly ?? null, account: a.n }, now), assumed: false }));
  const priced = parts.filter((p) => p.limit !== null);
  if (!priced.length) return { limit: null, parts };
  const avg = priced.reduce((x, p) => x + p.limit!, 0) / priced.length;
  for (const p of parts) if (p.limit === null) { p.limit = avg; p.assumed = true; }
  return { limit: parts.reduce((x, p) => x + p.limit!, 0), parts };
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
  range: 'week' | 'all';
  since: number;
  until: number;
  total: number;
  lastWeek: number;
  /** The weekly limit at API prices that 100% stands for, for shares; null until a meter can price it. */
  weekUsd: number | null;
  models: Slice[];
  schemes: (Slice & { id: number })[];
  kinds: Slice[];
  /** The 10 minions that cost the most this week. */
  top: { id: number; project_id: number; kind: string; scheme: string; number: number | null; title: string; usd: number }[];
}

/** The kind of work a turn was: keepalive pings, side questions (#932), Taskmasters, scheduled runs, else the minion's `type`. */
function kindOf(r: SpendRowRaw): string {
  if (r.keepalive) return 'Keepalive pings';
  if (r.side) return 'Side questions';
  if (r.kind === 'coordinator') return 'Taskmasters';
  if (r.created_by === APP_NAME) return 'Scheduled runs';
  return r.type ? r.type[0].toUpperCase() + r.type.slice(1) : 'No type';
}

/**
 * Where one payer's spend went (#905): the last 7 days against the 7 before, by model (Grunts' models apart), scheme,
 * kind of work, and the top 10 minions. Turns from before the split count under their minion's model, marked estimated.
 */
export function whereItWent(store: Store, payer: number | null, weekUsd: number | null, now = Date.now(), range: 'week' | 'all' = 'week'): WhereItWent {
  const week = 7 * 86400_000, all = range === 'all';
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
  // All time (#956): everything recorded, no week before to set it against.
  const cur = rows(all ? 0 : now - week, now + 1), prev = all ? [] : rows(now - 2 * week, now - week);
  const merge = <K>(key: (r: SpendRowRaw) => K, name: (k: K) => string) => {
    const m = group(cur, key, name, true);
    for (const [k, s] of group(prev, key, name, false)) (m.get(k) ?? m.set(k, { ...s, lastWeek: 0 }).get(k)!).lastWeek = s.lastWeek;
    return [...m.entries()].sort(([, a], [, b]) => b.usd - a.usd || b.lastWeek - a.lastWeek);
  };
  const minions = new Map<number, WhereItWent['top'][number]>();
  for (const [r, usd] of cur) {
    const m = minions.get(r.ticket_id) ?? minions.set(r.ticket_id, { id: r.ticket_id, project_id: r.project_id, kind: r.kind, scheme: projects.get(r.project_id) ?? `Scheme ${r.project_id}`, number: r.number, title: r.title, usd: 0 }).get(r.ticket_id)!;
    m.usd += usd;
  }
  const sum = (rs: [SpendRowRaw, number, boolean][]) => rs.reduce((a, [, usd]) => a + usd, 0);
  return {
    range, since: all ? 0 : now - week, until: now, total: sum(cur), lastWeek: sum(prev), weekUsd,
    models: merge((r) => r.model!, (k) => k).map(([, s]) => s),
    schemes: merge((r) => r.project_id, (id) => projects.get(id) ?? `Scheme ${id}`).map(([id, s]) => ({ ...s, id })),
    kinds: merge(kindOf, (k) => k).map(([, s]) => s),
    top: [...minions.values()].sort((a, b) => b.usd - a.usd).slice(0, 10),
  };
}

/**
 * One account's weekly limit at API prices for a payer (#905): what their turns on the account in use cost since its week
 * opened, scaled up by how full its meter is. While the meter is too coarse, the payer's last estimate stands in (the
 * server login's falls back to the pre-split estimate); null before any.
 */
export function weekLimit(store: Store, payer: number | null, usage: { weekly: { utilization: number; resetsAt: number | null } | null; account?: number } | null | undefined, now = Date.now()): number | null {
  // Each account keeps its own estimate (account 1's key is the one from before accounts were split).
  const account = usage?.account ?? 1;
  const key = `week_usd:${payer ?? 'host'}${account > 1 ? `:account:${account}` : ''}`;
  const last = store.getSetting<number>(key) ?? (payer === null && account === 1 ? (store.getSetting<number>(LAST_BUDGET) ?? 0) * 7 || null : null);
  const w = usage?.weekly;
  if (!w?.resetsAt || w.resetsAt <= now || w.utilization < MIN_UTILIZATION) return last;
  const spent = store.accountSpend(payer, account, w.resetsAt - 7 * 86400_000);
  if (!spent) return last; // null: the window reaches back before turns kept their account
  const usd = spent / w.utilization;
  if (usd !== last) store.setSetting(key, usd);
  return usd;
}

/** Settings key of the weekly Fable cap: a share of the weekly plan, in percent (#1061). */
export const FABLE_CAP_KEY = 'fable_cap_pct';
/** Josh, 2026-11-19: "the starting cap would be like 20%". */
export const FABLE_CAP_DEFAULT = 20;

export interface FableMeter {
  /** The cap, as a percent of the weekly plan: each person's own, and the sum of everyone's for the whole Citadel. */
  capPct: number;
  /** Fable dollars at API prices over the last 7 days, every payer together. */
  usd: number;
  /** The weekly plan limits of every account on the server, at API prices; null before any is priced. */
  weekUsd: number | null;
  /** capPct of weekUsd, the Citadel-wide cap in dollars. */
  capUsd: number | null;
  /** Fable spend has reached the cap: the Taskmaster starts Fable tiers on Opus high until it drops below. */
  over: boolean;
}

export function fableCapPct(store: Store): number {
  const v = store.getSetting<number>(FABLE_CAP_KEY);
  return typeof v === 'number' && v >= 0 && v <= 100 ? v : FABLE_CAP_DEFAULT;
}

/** The Fable meter for the whole Citadel (#1061; Josh, 2026-11-19: overall in API dollars, past the cap Fable tiers start on Opus high). */
export function fableMeter(store: Store, now = Date.now()): FableMeter {
  const capPct = fableCapPct(store);
  const usd = store.fableSpend(now - COST_DAYS * 86400_000);
  // Each account's estimated weekly limit is kept as week_usd:<payer or host>[:account:N] (weekLimit).
  // Only the server login's and the signed-up people's own: a removed person's old estimate stays in settings and must not inflate the cap.
  const live = new Set(['host', ...store.listUsers().map((u) => String(u.id))]);
  const limits = store.settingsWithPrefix<number>('week_usd:').filter((r) => live.has(r.key.split(':')[1])).map((r) => r.value).filter((v) => typeof v === 'number' && v > 0);
  const weekUsd = limits.length ? limits.reduce((a, b) => a + b, 0) : null;
  const capUsd = weekUsd === null ? null : (weekUsd * capPct) / 100;
  return { capPct, usd, weekUsd, capUsd, over: capUsd !== null && usd >= capUsd };
}
