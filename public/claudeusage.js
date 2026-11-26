// Claude usage windows across accounts, pure so tests can load it. One rule for the bar and the tooltip's lines:
// a window past its reset counts as 0% used (the server's windowNow in src/account-pick.ts does the same).

/** @import { MeterWindow, UsageAccount } from './types/usage.js' */

/** @param {MeterWindow | null | undefined} w @param {number} now */
const live = (w, now) => w && (!w.resetsAt || w.resetsAt > now);
/** @param {MeterWindow | null | undefined} w @param {number} now */
const util = (w, now) => (live(w, now) ? Math.min(1, Math.max(0, /** @type {MeterWindow} */ (w).utilization)) : 0);

/**
 * One window combined across a person's accounts (Cara, 2026-11-16: "just combine all accounts into a single bar"):
 * the average utilization, equal weight. An account with no report, or whose window already reset, counts as 0%.
 * resetsAt is the soonest still-ahead reset. Null when no account has reported that window at all.
 */
/** @param {UsageAccount[]} accounts @param {'weekly' | 'session'} key @param {number} [now] */
export function combineWindows(accounts, key, now = Date.now()) {
  const ws = accounts.map((a) => a.usage?.[key]);
  if (!ws.some(Boolean)) return null;
  const resets = ws.filter((w) => /** @type {number} */ (w?.resetsAt) > now).map((w) => /** @type {number} */ (w?.resetsAt));
  return { utilization: ws.map((w) => util(w, now)).reduce((x, y) => x + y, 0) / accounts.length, resetsAt: resets.length ? Math.min(...resets) : null };
}

/** One account's tooltip line, on the same rule as the bar; ▸ marks where new minions start. */
/** @param {UsageAccount} a @param {boolean} current @param {number} [now] */
export function accountLine(a, current, now = Date.now()) {
  /** @param {MeterWindow | null | undefined} w */
  const pct = (w) => Math.round(util(w, now) * 100);
  const wk = a.usage?.weekly;
  const week = wk ? `week ${pct(wk)}%${live(wk, now) ? '' : ' (week reset, no turns since)'}` : 'no turns yet';
  const sess = a.usage?.session ? `, 5 hours ${pct(a.usage.session)}%` : '';
  // Two links to one Claude organization share one allowance (#1461), whatever their last readings say.
  return `${current ? '▸ ' : ''}${a.label}: ${week}${sess}${a.same ? ` (the same Claude account as ${a.same})` : ''}`;
}
