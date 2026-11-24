// A person's Codex usage windows (#342), as src/codex.ts CodexUsage keeps them: usedPercent 0–100,
// windowDurationMins, resetsAt in seconds. Pure, so the tests can load it.

/** Under the Claude bar, Codex's own bar shows past this (Josh, 2026-11-05: "if it goes above 75%"). */
export const CODEX_BAR_PCT = 75;

/** A window's name: "5-hour window", "Weekly"… */
export const windowName = (mins) => (mins === 300 ? '5-hour window' : mins === 10080 ? 'Weekly' : mins ? (mins % 1440 ? `${Math.round(mins / 60)}-hour window` : `${mins / 1440}-day window`) : 'Window');

/** Its windows, shortest first, with a window past its reset counted as 0% used. */
export function codexWindows(usage, now = Date.now()) {
  return [usage?.primary, usage?.secondary]
    .filter(Boolean)
    .map((w) => ({ ...w, pct: w.resetsAt && w.resetsAt * 1000 <= now ? 0 : Math.round(Math.min(100, Math.max(0, w.usedPercent))) }))
    .sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity));
}

/** The fullest window's percent, or null with no usage yet. */
export function codexTop(usage, now = Date.now()) {
  const ws = codexWindows(usage, now);
  return ws.length ? Math.max(...ws.map((w) => w.pct)) : null;
}

/** Whether the bar shows under the Claude one: either window above 75%. */
export const codexHigh = (usage, now = Date.now()) => (codexTop(usage, now) ?? 0) > CODEX_BAR_PCT;

/** The bar's colour, matching the Claude bar's: warn from 75%, error from 90%. */
export const codexLevel = (pct) => (pct >= 90 ? 'error' : pct >= 75 ? 'warn' : '');
