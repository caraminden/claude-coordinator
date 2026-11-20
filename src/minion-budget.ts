/**
 * A budget for every minion (#1114): what its type of work on its model has usually cost, a line each turn saying so,
 * one ask past twice that, and one Taskmaster wake past four times. Never a hard stop.
 *
 * Josh's picks, 2026-11-19 (grilling cards on #1114): "2x and past $3" for the minion's ask, "4x and past $10" for the
 * Taskmaster, "Yes, each turn" for the line up front, "Say why, or split" for the ask, "Chat line + minion page" for people.
 * Replayed on the 1,072 minions of the week to Nov 19 (each against the three weeks before): the ask fires on 18% of them,
 * which held 48% of that week's spend (plain 2x: 33%); the wake on 3%, about 33 a week. Medians per scheme or per effort
 * fired on as many, so the usual cost is one per type and model family, every scheme pooled.
 */
import type { Store } from './db.ts';

/** How far back the usual cost looks. */
export const WINDOW_MS = 28 * 86_400_000;
/** Fewer minions than this and a median says little: the type falls back to its model family's, then to none. */
export const MIN_MINIONS = 5;
/** The ask: twice the usual, and never under $3 (cheap minions doubling to $1 are noise). */
export const ASK = { times: 2, floor: 3 };
/** The Taskmaster's wake: four times the usual, and never under $10. */
export const WAKE = { times: 4, floor: 10 };

/** The usual cost of a minion's kind of work, and what it rests on. */
export interface Budget {
  usd: number;
  /** "a feature on Opus", or "a minion on Opus" for the family-wide fallback. */
  basis: string;
  /** How many minions the median is of. */
  n: number;
}

/** Which of the two marks a minion has passed and been told about (a setting, so a restart keeps it). */
export interface BudgetState { asked?: number; woke?: number }
export const budgetKey = (ticketId: number) => `minion_budget:${ticketId}`;

const FAMILIES = ['fable', 'sonnet', 'haiku', 'opus'] as const;
/** The Claude model family a model id belongs to; Opus for none (the default model); null for a Codex or other non-Claude model, which gets no budget (its turns aren't priced). */
export function family(model: string | null | undefined): string | null {
  const m = (model ?? '').toLowerCase();
  return FAMILIES.find((f) => m.includes(f)) ?? (!m || m.includes('claude') ? 'opus' : null);
}
const familyName = (f: string) => f[0].toUpperCase() + f.slice(1);

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Medians by "type family" and by family alone, from the rows Store.minionCosts gives. */
export function medians(rows: { type: string | null; model: string | null; cost: number }[]): Map<string, { usd: number; n: number }> {
  const groups = new Map<string, number[]>();
  const add = (key: string, cost: number) => (groups.get(key) ?? groups.set(key, []).get(key)!).push(cost);
  for (const r of rows) {
    const f = family(r.model);
    if (!f) continue;
    add(f, r.cost);
    if (r.type) add(`${r.type} ${f}`, r.cost);
  }
  const out = new Map<string, { usd: number; n: number }>();
  for (const [key, costs] of groups) if (costs.length >= MIN_MINIONS) out.set(key, { usd: median(costs), n: costs.length });
  return out;
}

/** The usual cost for a type of work on a model, or null with too little history. */
export function budgetFrom(table: Map<string, { usd: number; n: number }>, type: string | null, model: string | null | undefined): Budget | null {
  const f = family(model);
  if (!f) return null;
  const own = type ? table.get(`${type} ${f}`) : undefined;
  if (own) return { ...own, basis: `${/^[aeiou]/.test(type!) ? 'an' : 'a'} ${type} on ${familyName(f)}` };
  const all = table.get(f);
  return all ? { ...all, basis: `a minion on ${familyName(f)}` } : null;
}

// The medians move slowly: an hour's cache keeps the minions list from re-reading four weeks of turns on every broadcast.
const cache = new WeakMap<Store, { at: number; table: Map<string, { usd: number; n: number }> }>();
const CACHE_MS = 3_600_000;

/** A minion's budget now: its `type` property and the model it is set to or last ran on. `props`: its properties, when the caller has read them. */
export function budgetFor(store: Store, ticket: { id: number; model: string | null; last_model?: string | null }, now = Date.now(), props?: Record<string, unknown>): Budget | null {
  let c = cache.get(store);
  if (!c || now - c.at > CACHE_MS) cache.set(store, c = { at: now, table: medians(store.minionCosts(now - WINDOW_MS)) });
  const type = (props ?? store.props.forTarget('minion', ticket.id)).type;
  return budgetFrom(c.table, typeof type === 'string' ? type : null, ticket.model ?? ticket.last_model);
}

/** The dollar amount of a mark for a budget. */
export const markOf = (b: Budget, mark: { times: number; floor: number }) => Math.max(b.usd * mark.times, mark.floor);

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n)}`;

/** The line at the top of each turn (Josh, "Yes, each turn"): the usual cost, spend so far, and that it isn't a cap. */
export function turnLine(b: Budget, spent: number): string {
  const head = `Budget: ${b.basis} has usually cost about ${usd(b.usd)} (the median of ${b.n} minions in the last 4 weeks, every scheme); this minion has used ${usd(spent)} so far. It is not a cap and quality comes first.`;
  // Past the mark, the line carries the ask too: a turn that ended before it could read the ask still gets it.
  return spent >= markOf(b, ASK)
    ? `${head} It is past ${ASK.times}x: if you haven't yet, say in one line why it is costing more, and split off what's left for a fresh minion (citadel:briefing, sent to your Taskmaster) if it splits cleanly.`
    : `${head} Past ${usd(markOf(b, ASK))} you'll be asked to say why or split the work; past ${usd(markOf(b, WAKE))} your Taskmaster hears of it.`;
}

/** The one ask past the first mark (Josh, "Say why, or split"), passed into the running turn or opening the next. */
export function askText(b: Budget, spent: number): string {
  return `Budget: this minion has now used about ${usd(spent)}, over ${ASK.times}x the usual ${usd(b.usd)} for ${b.basis}. In your next reply, say in one line why it is costing more. If the rest of the work splits off cleanly, write a handoff for a fresh minion (citadel:briefing) and send it to your Taskmaster instead of carrying on here. Nothing stops you: finish what needs finishing, and quality still comes first.`;
}

/** What people read in the chat past the first mark (the second's is tellTaskmaster's "Sent the Taskmaster" line). */
export function chatNote(b: Budget, spent: number): string {
  return `Budget: about ${usd(spent)} used, over ${ASK.times}x the usual ${usd(b.usd)} for ${b.basis}. Asked the minion to say why or split the work.`;
}

/** The Taskmaster's wake past the second mark. */
export function wakeText(b: Budget, spent: number): string {
  return `Budget: this minion has used about ${usd(spent)}, over ${WAKE.times}x the usual ${usd(b.usd)} for ${b.basis} (it was asked at ${usd(markOf(b, ASK))} to say why or split the work). Read its last reply and decide: let it carry on, split the rest into a new minion, or stop it. No action is taken by itself.`;
}

/** The marks spend has newly passed, each once ever per minion; a jump past both gives both. Saves nothing: the caller records it. */
export function passed(b: Budget, spent: number, state: BudgetState): ('ask' | 'wake')[] {
  return [
    ...(!state.asked && spent >= markOf(b, ASK) ? ['ask' as const] : []),
    ...(!state.woke && spent >= markOf(b, WAKE) ? ['wake' as const] : []),
  ];
}
