// The ribbon's arithmetic (#1991): the stretches of a time log (src/time-log.ts) as tiles that fit, and a log grown to now. No DOM.
/** @import { TimeKind, TimeLog, TimeRow, TimeSeg } from './types/time-log.js' */

/**
 * A log `ms` after it was cut: its last stretch is still going on, unless the minion is dismissed.
 * @param {TimeLog} log
 * @param {number} ms
 * @returns {TimeLog}
 */
export function grow(log, ms) {
  const last = log.segs.at(-1);
  if (log.closed || !last || ms <= 0) return log;
  /**
   * @template {{ work: number, wait: number, lost: number }} R
   * @param {R} r
   * @returns {R}
   */
  const plus = (r) => (last.kind === 'gone' ? r : { ...r, [last.kind]: r[last.kind] + ms });
  return {
    ...log,
    end: log.end + ms,
    segs: [...log.segs.slice(0, -1), { ...last, end: last.end + ms }],
    rows: log.rows.map((r, i) => (i === last.row ? { ...plus(r), end: last.end + ms } : r)),
    totals: { ...plus(log.totals), guess: log.totals.guess + (last.guess && last.kind !== 'gone' ? ms : 0) },
  };
}

/**
 * At most about `max` tiles for the stretches, in order. One that isn't work and is longer than everything else together
 * is squeezed, so the work beside it can be read; stretches too short to see join their neighbours, and the tile takes
 * the kind most of it is. Lost time always keeps a tile of its own.
 * @param {TimeSeg[]} segs
 * @param {number} max
 */
export function tiles(segs, max) {
  const long = (/** @type {TimeSeg} */ s) => s.end - s.start;
  const whole = segs.reduce((n, s) => n + long(s), 0);
  const longest = segs.reduce((n, s) => (s.kind === 'work' ? n : Math.max(n, long(s))), 0);
  const rest = whole - longest;
  const cap = longest > rest ? Math.max(rest * 0.6, 120_000) : Infinity;
  const size = (/** @type {TimeSeg} */ s) => (s.kind === 'work' ? long(s) : Math.min(long(s), cap));
  const least = segs.reduce((n, s) => n + size(s), 0) / Math.max(1, max);
  /** @typedef {{ segs: TimeSeg[], size: number, alone: boolean }} Group */
  /** @type {Group[]} */
  const out = [];
  /** @type {Group | null} */
  let group = null;
  for (const s of segs) {
    const alone = s.kind === 'lost' || (s.kind !== 'work' && long(s) > cap);
    if (!group || alone || group.alone || group.size >= least) out.push((group = { segs: [], size: 0, alone }));
    group.segs.push(s);
    group.size += size(s);
  }
  return out.map(({ segs: of, size: flex, alone }) => {
    const ms = /** @type {Record<TimeKind, number>} */ ({ work: 0, wait: 0, lost: 0, gone: 0 });
    for (const s of of) ms[s.kind] += long(s);
    const kind = /** @type {TimeKind[]} */ (Object.keys(ms)).reduce((a, b) => (ms[b] > ms[a] ? b : a));
    const main = of.filter((s) => s.kind === kind).reduce((a, b) => (long(b) > long(a) ? b : a));
    return { start: of[0].start, end: /** @type {TimeSeg} */ (of.at(-1)).end, kind, ms, main, flex, guess: !!main.guess, squeezed: alone && kind !== 'lost' };
  });
}

/** What a row is known by from one cut to the next; null for a step with no time yet. */
export const rowKey = (/** @type {Pick<TimeRow, 'type' | 'start'> | null | undefined} */ r) => (r?.start == null ? null : `${r.type}:${r.start}`);
