// Which of a person's Claude accounts a turn runs on (#793). Two aims pull against each other:
// spend each account's weekly allowance before its weekly reset, and never move a session whose
// prompt cache is warm (the cache is the account's: a move rereads the whole context at full
// price, and again on every move back). So a warm session stays where it is, and only cheap
// moments (a new session, a fresh start, a cold wake, a limit) go to the account picked here:
// the one whose week resets soonest that still has room. Pure: claude-link.ts feeds it.

/** One window of an account's meter as a turn last reported it (runner.ts, Usage). */
export interface MeterWindow {
  utilization: number;
  resetsAt: number | null;
}
export interface Meter {
  weekly: MeterWindow | null;
  session: MeterWindow | null;
}

export interface PickAccount {
  n: number;
  expired?: number;
  limitedUntil?: number;
}

export interface PickInput {
  /** The person's accounts, in order. */
  accounts: PickAccount[];
  /** Each account's last meter, or null before any turn ran on it. */
  meter: (n: number) => Meter | null;
  /** The account new work went to last time (AccountSet.inUse): it keeps new work until another is clearly better. */
  nextUp: number;
  /** Pinned in Settings: new and cold turns run on it while it's ready. */
  pinned?: number;
  /** The account this session's cache is warm on, if it is. */
  warm?: number | null;
  now: number;
}

export type PickWhy = 'warm' | 'pinned' | 'soonest' | 'full';

export interface Pick {
  /** The account this turn runs on. */
  n: number;
  /** Where new work goes now, pin aside: written back as AccountSet.inUse. */
  nextUp: number;
  why: PickWhy;
}

/** A cold session: its last turn ended this long ago or more. Claude Code's prompt cache lives an hour; this leaves a margin. */
export const WARM_MS = 55 * 60_000;
/** Weekly use from which an account has no room for new work (a turn on it would likely hit the limit mid-way). */
export const WEEK_FULL = 0.97;
/** The 5-hour window: the account new work goes to keeps it below FULL; another takes it only below BACK, so the two don't trade back and forth. */
export const SESSION_FULL = 0.9;
export const SESSION_BACK = 0.7;
/** New work moves to an account with room only when its week resets at least this much sooner than next-up's. */
export const RESET_MARGIN_MS = 6 * 3600_000;
const WEEK_MS = 7 * 24 * 3600_000;

/** Where a person's own plan usage is kept (their container turns'), apart from the server login's `usage`. */
export const usageKey = (person: number) => `usage:user:${person}`;
/** Where one Claude account's usage is kept (#779): account 1 keeps the key it had before there were several. */
export const accountUsageKey = (payer: number | null, account = 1) => `${payer === null ? 'usage' : usageKey(payer)}${account > 1 ? `:account:${account}` : ''}`;

/** Linked, its sign-in good, and no limit still running. */
export const accountReady = (a: PickAccount, now = Date.now()) => !a.expired && !(a.limitedUntil && a.limitedUntil > now);

/**
 * A window as it stands at `now`: one past its reset counts as empty, with its next reset a week (or weeks) on,
 * so a meter left stale by an idle account still says something true. Null when no turn has reported it.
 */
export function windowNow(w: MeterWindow | null | undefined, now: number, period: number): MeterWindow | null {
  if (!w) return null;
  if (w.resetsAt === null || w.resetsAt > now) return w;
  return { utilization: 0, resetsAt: w.resetsAt + Math.ceil((now - w.resetsAt + 1) / period) * period };
}

/** Whether new work fits on account `a`: ready, its week under WEEK_FULL and its 5-hour window under the bar for its role. */
function hasRoom(a: PickAccount, input: PickInput): boolean {
  if (!accountReady(a, input.now)) return false;
  const m = input.meter(a.n);
  const week = windowNow(m?.weekly, input.now, WEEK_MS);
  const five = windowNow(m?.session, input.now, 5 * 3600_000);
  return (week?.utilization ?? 0) < WEEK_FULL && (five?.utilization ?? 0) < (a.n === input.nextUp ? SESSION_FULL : SESSION_BACK);
}

/** When `n`'s week resets; an account with no meter yet comes first (a cold turn there reads its meter for free). */
function resetOf(n: number, input: PickInput): number {
  return windowNow(input.meter(n)?.weekly, input.now, WEEK_MS)?.resetsAt ?? -Infinity;
}

/**
 * Where new work goes, pin aside: next-up while it has room and no account with room resets RESET_MARGIN_MS sooner,
 * else the account with room whose week resets soonest. With none that has room, today's order: next-up while
 * ready, then the next ready one after it, then any whose sign-in holds (a turn may still try). Null when every sign-in failed.
 */
function nextUp(input: PickInput): { n: number; full: boolean } | null {
  const list = input.accounts;
  const roomy = list.filter((a) => hasRoom(a, input));
  const cur = roomy.find((a) => a.n === input.nextUp);
  const best = roomy.reduce<PickAccount | null>((b, a) => (!b || resetOf(a.n, input) < resetOf(b.n, input) ? a : b), null);
  if (best) return { n: cur && !(resetOf(best.n, input) < resetOf(cur.n, input) - RESET_MARGIN_MS) ? cur.n : best.n, full: false };
  const at = Math.max(0, list.findIndex((a) => a.n === input.nextUp));
  const order = [...list.slice(at), ...list.slice(0, at)];
  const any = order.find((a) => accountReady(a, input.now)) ?? order.find((a) => !a.expired);
  return any ? { n: any.n, full: true } : null;
}

/** The account a turn runs on: its warm one while ready, else a pinned one while ready, else next-up. */
export function pickAccount(input: PickInput): Pick | null {
  const up = nextUp(input);
  if (!up) return null;
  const ready = (n: number | null | undefined) => n != null && input.accounts.some((a) => a.n === n && accountReady(a, input.now));
  if (ready(input.warm)) return { n: input.warm!, nextUp: up.n, why: 'warm' };
  if (ready(input.pinned)) return { n: input.pinned!, nextUp: up.n, why: 'pinned' };
  return { n: up.n, nextUp: up.n, why: up.full ? 'full' : 'soonest' };
}
