// How many minions fit (#1987): what load the box saw at each number of turns running, from the readings host_samples
// keeps. Only a reading that counted the turns (answer_time, #1559) can be used. It informs; a person sets the pool's size.
import { cores as hostCores } from './host-signals.ts';
import { median, percentile } from './stats.ts';

/** One reading as the panel draws it: when, turns running, load, memory used (%), memory stall (%, null if not read). */
export interface BoxReading {
  at: number;
  turns: number;
  load: number;
  used: number;
  stall: number | null;
}

/** A memory stall this high (PSI, %) counts as a stall. */
export const STALL_PCT = 10;
/** Fewer readings than this near a number say nothing about it. */
export const ENOUGH = 20;
/** Readings within this many turns of a number are near it. */
const NEAR = 1;
/** A number is comfortable while at most this share of the readings near it stalled (and typical load is within the cores). */
const STALL_SHARE = 0.05;
/** When #1890 went live (#1916 a few hours before it): a turn waiting on a card or a job stopped counting as running. Nov 25, 6:41 AM PST. */
export const WAITS_FREED_AT = 1_795_617_685_411;

const tenth = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
/** The numbers of some readings; `typical` and `high` (1 in 10 is above it) are null without any. */
const summary = (rs: BoxReading[]) => {
  const loads = rs.map((r) => r.load);
  const read = rs.filter((r) => r.stall !== null);
  return { count: rs.length, typical: tenth(median(loads)), high: percentile(loads, 0.9), stalls: read.filter((r) => r.stall! >= STALL_PCT).length, stallOf: read.length };
};
export type BoxRow = ReturnType<typeof summary>;

const BANDS: [number, number][] = [
  [0, 1],
  [2, 4],
  [5, 7],
  [8, 10],
  [11, 14],
  [15, 19],
  [20, Infinity],
];

/**
 * The most turns the readings call comfortable: typical load within the cores and at most STALL_SHARE of readings stalled, at it and at
 * every lower number with enough readings. `past` is the first number that isn't, or null when the readings run out first.
 */
function comfortable(near: BoxRow[], cores: number): { turns: number | null; past: number | null } {
  let turns: number | null = null;
  for (const [n, r] of near.entries()) {
    if (r.count < ENOUGH) continue;
    if (r.typical! > cores || r.stalls > STALL_SHARE * r.stallOf) return { turns, past: n };
    turns = n;
  }
  return { turns, past: null };
}

export function boxCapacity(readings: BoxReading[], cores = hostCores()) {
  const most = readings.reduce((m, r) => Math.max(m, r.turns), -1);
  const near = Array.from({ length: most + 1 }, (_, n) => summary(readings.filter((r) => Math.abs(r.turns - n) <= NEAR)));
  return {
    cores,
    enough: ENOUGH,
    stallPct: STALL_PCT,
    stallShare: STALL_SHARE,
    readings: readings.map((r) => [r.at, r.turns, r.load, r.used, r.stall]),
    /** By number of turns, from 0: the readings near it. */
    near,
    bands: BANDS.map(([from, to]) => ({ from, to: to === Infinity ? null : to, ...summary(readings.filter((r) => r.turns >= from && r.turns <= to)) })),
    comfortable: comfortable(near, cores),
    /** Readings that still counted waiting turns, and when that stopped. */
    waiting: { until: WAITS_FREED_AT, count: readings.filter((r) => r.at < WAITS_FREED_AT).length },
  };
}
