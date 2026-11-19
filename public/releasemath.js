// The release monitor's sums (public/releases.js), kept free of the DOM so test/releasemath.test.ts can load them.

/** The stages a bar shows: Live is where it ends, not a segment. */
export const segments = (stages) => stages.filter((s) => s.name !== 'live');

/** "45s", "3m", "1h 5m". */
export function shortSpan(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * When a change should be live (ms): only while the whole release has an estimate (nothing ahead waits) and this
 * change's stage and every one after it have a usual time. Null otherwise.
 */
export function changeEta(next, c) {
  if (next.eta == null || c.waitingOn || c.usual == null) return null;
  const after = next.stages.slice(next.stages.findIndex((s) => s.name === c.stage) + 1);
  if (after.some((s) => s.usual == null)) return null;
  return Math.max(next.eta, c.since + (c.usual + after.reduce((sum, s) => sum + s.usual, 0)) * 1000);
}

/**
 * All's columns (take E): a wait is Waiting (a change with waitingOn, Citadel's land line, a contraption's call), then
 * the first half of the track is Checks and the rest Shipping, so a PR whose checks run sits in Checks (#659). The last
 * is the target's newest live release only (Cara, 2026-11-12: ""Live today" is gonna get too crazy, how about "Last Release"?").
 */
export const COLUMNS = ['Waiting', 'Checks', 'Shipping', 'Last release'];
export function columnOf(stages, c) {
  if (c.waitingOn || c.stage === 'line' || c.stage === 'call') return 0;
  const list = segments(stages);
  const at = list.findIndex((s) => s.name === c.stage);
  return at < 0 ? 0 : at <= Math.floor((list.length - 1) / 2) ? 1 : 2;
}

/**
 * What people call a release (Cara, 2026-11-12: "a numbered build/release system instead of commit hashes"): "Release 14", "#14" where space is short. A target with its own names (#764: Peek's "Build 997")
 * sends `name`. With no number: a try that failed is "a failed try"; a next not numbered yet keeps its name.
 */
export const releaseName = (r, short = false) => (r.number != null ? (short ? `#${r.number}` : r.name ?? `Release ${r.number}`)
  : r.outcome === 'signed' ? 'a signed build' : r.outcome === 'live' ? 'an earlier release' : r.outcome === 'failed' ? 'a failed try' : r.name ?? 'Next release');

/** How long a change may wait on something outside the pipeline (a CI runner, a fix) before it reads as stuck (#1019). */
export const STUCK_MS = 30 * 60_000;
/** How long change or release `p` has been stuck (ms), or 0: a wait past STUCK_MS. A place in a line (the land line, "waits for the next land": a `brief`) is a queue, not stuck. */
export const stuckFor = (p, now = Date.now()) => {
  const ms = p?.waitingOn && !p.brief && !['line', 'land'].includes(p.stage) ? now - p.since : 0;
  return ms > STUCK_MS ? ms : 0;
};
