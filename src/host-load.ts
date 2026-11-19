// Host load (#1060): what tools/citadel-heavy already keeps in its folder, read for the CI page: the slots and who
// holds them, the line behind them, the CPU-pressure gate, and a week of waits per scheme from its history file.
// Read-only: the slot count stays a file (X2 was left unpicked: raising it put the load near 100 on Nov 10).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { median, readHeavy, type HeavyJob } from './waits.ts';

/** citadel-heavy's defaults (its header): pressure at or above 50% holds a free slot, for at most 5 minutes. */
export const MAX_PRESSURE = 50;
export const LOAD_WAIT_S = 300;
const WEEK_MS = 7 * 24 * 3600_000;

export interface SchemeWaits { scheme: string; jobs: number; medianS: number; longestS: number }

/** "Citadel #544 (cara)" is Citadel's; "peek-auras deploy" (a contraption's deploy build) is peek-auras'. */
export function schemeOfWho(who: string): string {
  return (who.match(/^(.*?)(?: #\d| deploy$)/)?.[1] || who).trim();
}

/** The history file's lines since `since`: one entry per scheme with its median and longest wait. Bad lines are skipped. */
export function parseHistory(text: string, since: number): SchemeWaits[] {
  const by = new Map<string, number[]>();
  for (const line of text.split('\n')) {
    const [started, who, , , wait] = line.split('\t');
    const at = Date.parse(started ?? ''), w = Number(wait);
    if (!who || !(at >= since) || !Number.isFinite(w) || wait === '') continue;
    const k = schemeOfWho(who);
    by.set(k, [...(by.get(k) ?? []), w]);
  }
  return [...by].map(([scheme, w]) => ({ scheme, jobs: w.length, medianS: median(w) ?? 0, longestS: Math.max(...w) })).sort((a, b) => b.longestS - a.longestS);
}

const slotCount = (dir: string): number => {
  try {
    const n = Number(readFileSync(join(dir, 'slots'), 'utf8').replace(/#.*/g, '').match(/\d+/)?.[0]);
    return n >= 1 ? Math.min(n, 64) : 2;
  } catch { return 2; }
};

/** The gate's reading: /proc/pressure/cpu "some avg60" as a whole percent, or null without PSI. */
export function readPressure(file = '/proc/pressure/cpu'): number | null {
  try { return Math.floor(Number(readFileSync(file, 'utf8').match(/^some .*avg60=([\d.]+)/m)?.[1])) } catch { return null; }
}

export interface HostLoad {
  slots: number;
  holders: (HeavyJob & { scheme: string })[];
  waiters: (HeavyJob & { scheme: string })[];
  pressure: number | null;
  maxPressure: number;
  loadWaitS: number;
  week: SchemeWaits[];
  now: number;
}

export function hostLoad(dir: string, now = Date.now(), pressureFile?: string): HostLoad {
  const { holders, waiters } = readHeavy(dir, now);
  const tag = (j: HeavyJob) => ({ ...j, scheme: schemeOfWho(j.who) });
  let history = '';
  try { history = readFileSync(join(dir, 'history'), 'utf8'); } catch { /* none yet */ }
  return { slots: slotCount(dir), holders: holders.map(tag), waiters: waiters.map(tag), pressure: readPressure(pressureFile), maxPressure: MAX_PRESSURE, loadWaitS: LOAD_WAIT_S, week: parseHistory(history, now - WEEK_MS), now };
}
