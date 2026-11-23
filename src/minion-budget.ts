/**
 * A budget for every minion (#1114): what its type of work on its model has usually cost, a line each turn saying so,
 * one ask past twice that, and a Taskmaster wake past four times. Never a hard stop.
 * Since #1672 the wake repeats at each doubling of its mark (8x, 16x…), and past 10x (at least $50) the minion's owner gets
 * a card: carry on, split or stop (Cara, 2026-11-22, "Build it" on #1668's card). Every mark is a multiple of `Budget.usd`,
 * so a brief's own cost estimate can stand in for the usual cost later without touching the marks.
 *
 * Josh's picks, 2026-11-19 (grilling cards on #1114): "2x and past $3" for the minion's ask, "4x and past $10" for the
 * Taskmaster, "Yes, each turn" for the line up front, "Say why, or split" for the ask, "Chat line + minion page" for people.
 * Replayed on the 1,072 minions of the week to Nov 19 (each against the three weeks before): the ask fires on 18% of them,
 * which held 48% of that week's spend (plain 2x: 33%); the wake on 3%, about 33 a week. Medians per scheme or per effort
 * fired on as many, so the usual cost is one per type and model family, every scheme pooled.
 */
import { median as statsMedian } from './stats.ts';
import type { Store } from './db.ts';

/** How far back the usual cost looks. */
export const WINDOW_MS = 28 * 86_400_000;
/** Fewer minions than this and a median says little: the type falls back to its model family's, then to none. */
export const MIN_MINIONS = 5;
/** The ask: twice the usual, and never under $3 (cheap minions doubling to $1 are noise). */
export const ASK = { times: 2, floor: 3 };
/** The Taskmaster's wake: four times the usual, and never under $10; again at each doubling of that. */
export const WAKE = { times: 4, floor: 10 };
/** The owner's card: ten times the usual, and never under $50; once. */
export const CARD = { times: 10, floor: 50 };

/** The usual cost of a minion's kind of work, and what it rests on. */
export interface Budget {
  usd: number;
  /** "a feature on Opus", or "a minion on Opus" for the family-wide fallback. */
  basis: string;
  /** How many minions the median is of. */
  n: number;
}

/**
 * Which marks a minion has passed and been told about (a setting, so a restart keeps it): when it was asked, first woken
 * and carded, and `wakes`, the doubling level of its last wake (1 at 4x, 2 at 8x…; missing with `woke` set means 1).
 */
export interface BudgetState { asked?: number; woke?: number; wakes?: number; carded?: number }
export const budgetKey = (ticketId: number) => `minion_budget:${ticketId}`;

const FAMILIES = ['fable', 'sonnet', 'haiku', 'opus'] as const;
/** The Claude model family a model id belongs to; Opus for none (the default model); null for a Codex or other non-Claude model, which gets no budget (its turns aren't priced). */
export function family(model: string | null | undefined): string | null {
  const m = (model ?? '').toLowerCase();
  return FAMILIES.find((f) => m.includes(f)) ?? (!m || m.includes('claude') ? 'opus' : null);
}
const familyName = (f: string) => f[0].toUpperCase() + f.slice(1);

export const median = (xs: number[]): number => statsMedian(xs) ?? NaN;

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

/** The doubling level `spent` has reached on the wake's mark: 1 from 4x, 2 from 8x, and so on; 0 below it. */
export function wakeLevel(b: Budget, spent: number): number {
  const r = spent / markOf(b, WAKE);
  return r < 1 ? 0 : Math.floor(Math.log2(r)) + 1;
}
/** The next wake's dollar mark once `level` has been woken. */
const nextWake = (b: Budget, level: number) => markOf(b, WAKE) * 2 ** level;

/** The Taskmaster's wake at `level` (1 at 4x, 2 at 8x…): a carry on lasts to the next mark, and a repeat checks last time's conditions. */
export function wakeText(b: Budget, spent: number, level = 1): string {
  const times = WAKE.times * 2 ** (level - 1);
  const head = `Budget: this minion has used about ${usd(spent)}, over ${times}x the usual ${usd(b.usd)} for ${b.basis}`;
  const lead = level > 1
    ? `${head}. You were woken about it before. Read its replies since then and check whether the conditions you set last time (a cheaper model for its Grunts, cost lines, a split) actually happened.`
    : `${head} (it was asked at ${usd(markOf(b, ASK))} to say why or split the work). Read its last reply.`;
  const card = spent < markOf(b, CARD) ? ` Past ${usd(markOf(b, CARD))} its owner gets a card to carry on, split or stop.` : '';
  return `${lead} Decide: let it carry on, split the rest into a new minion, or stop it. A carry on lasts only until the next mark, ${usd(nextWake(b, level))}: you'll be woken again there.${card} No action is taken by itself.`;
}

/** The owner's card past the 10x mark: the spend, the usual cost, the minion's latest note, and carry on, split or stop. */
export function budgetCard(b: Budget, spent: number, note: string | null) {
  const said = note?.trim() ? ` Its latest note: “${note.trim()}”.` : '';
  return {
    header: 'Budget',
    question: `This minion has used about ${usd(spent)}, over ${CARD.times}x the usual ${usd(b.usd)} for ${b.basis}.${said} Should it carry on, split off what is left (it writes a handoff for a fresh minion and stops), or stop now?`,
    options: [
      { label: 'Carry on', description: `It keeps going; its Taskmaster looks again at ${usd(nextWake(b, wakeLevel(b, spent)))}.` },
      { label: 'Split', description: 'It writes a handoff for a fresh minion with what is left, sends it to its Taskmaster, and stops.' },
      { label: 'Stop', description: 'Its turn stops now, as the stop button does. Nothing is undone.' },
    ],
  };
}
/** The budget card's Stop option, which the server acts on itself. */
export const CARD_STOP = 'Stop';

/** The marks spend has newly passed: the ask and the card once ever per minion, the wake once per doubling; a jump past several gives each kind once. Saves nothing: the caller records it. */
export function passed(b: Budget, spent: number, state: BudgetState): ('ask' | 'wake' | 'card')[] {
  const woken = state.wakes ?? (state.woke ? 1 : 0);
  return [
    ...(!state.asked && spent >= markOf(b, ASK) ? ['ask' as const] : []),
    ...(spent >= nextWake(b, woken) ? ['wake' as const] : []),
    ...(!state.carded && spent >= markOf(b, CARD) ? ['card' as const] : []),
  ];
}
