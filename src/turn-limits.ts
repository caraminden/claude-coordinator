// The numbers Auto uses to size the worker pool (#1892), changeable on the Status page's Workers tile. Josh, 2026-11-24:
// "Lets make those limit thresholds configurable by the user ... that way we can fine tune them as long as things stay
// performant". They are the pool's own: src/pressure.ts's starved lines and src/memory-ease.ts's LINES also gate heavy
// jobs, deploys and background passes, and stay as they are. Saved in settings as only what someone changed; nothing
// saved means these defaults. Starting values (#1868): perigee averaged 15% CPU pressure at 7-9 turns, 34% at 10-12, 41% at 13-15, 59% at 26 and more.

export interface PoolLimits {
  min: number;
  max: number;
  growCpu: number;
  growMem: number;
  shrinkCpu: number;
  shrinkMem: number;
  /** GB of free memory under which Auto shrinks. */
  shrinkFreeGb: number;
  growSec: number;
  shrinkSec: number;
  /** Seconds a wait stays in its turn before the server takes it over (#1890); none while the box is starved. */
  waitHold: number;
}
export type LimitKey = keyof PoolLimits;

export const DEFAULT_LIMITS: PoolLimits = { min: 4, max: 30, growCpu: 35, growMem: 8, shrinkCpu: 50, shrinkMem: 20, shrinkFreeGb: 6, growSec: 20, shrinkSec: 30, waitHold: 120 };

/** Each number's words and range, in the order the tile shows them. `share`: which host_samples column says how often a box crossed it. */
export const LIMIT_INFO: { key: LimitKey; label: string; unit: string; lo: number; hi: number; share?: 'cpu' | 'mem' | 'free' }[] = [
  { key: 'min', label: 'Fewest workers', unit: 'workers', lo: 1, hi: 50 },
  { key: 'max', label: 'Most workers', unit: 'workers', lo: 1, hi: 50 },
  { key: 'growCpu', label: 'Grow only under CPU pressure', unit: '%', lo: 1, hi: 100, share: 'cpu' },
  { key: 'growMem', label: 'Grow only under memory pressure', unit: '%', lo: 1, hi: 100, share: 'mem' },
  { key: 'shrinkCpu', label: 'Shrink at CPU pressure', unit: '%', lo: 1, hi: 100, share: 'cpu' },
  { key: 'shrinkMem', label: 'Shrink at memory pressure', unit: '%', lo: 1, hi: 100, share: 'mem' },
  { key: 'shrinkFreeGb', label: 'Shrink under free memory', unit: 'GB', lo: 0.5, hi: 64, share: 'free' },
  { key: 'growSec', label: 'Seconds between steps up', unit: 's', lo: 10, hi: 3600 },
  { key: 'shrinkSec', label: 'Seconds between steps down', unit: 's', lo: 10, hi: 3600 },
  { key: 'waitHold', label: 'Seconds a wait keeps its worker', unit: 's', lo: 0, hi: 600 },
];

/** A shrink line must sit this many points above its grow line, or the pool would grow and shrink on the same reading. */
export const GAP = 5;

/** The saved part: what was changed, and who changed each and when. */
export interface SavedLimits {
  values: Partial<PoolLimits>;
  by: Partial<Record<LimitKey, { by: string; at: number }>>;
}

export const limitsOf = (saved: SavedLimits | null | undefined): PoolLimits => ({ ...DEFAULT_LIMITS, ...saved?.values });

/** Why this set can't be used, or null. */
export function refuse(l: PoolLimits): string | null {
  for (const i of LIMIT_INFO) {
    const v = l[i.key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < i.lo || v > i.hi) return `${i.label} is a number from ${i.lo} to ${i.hi}`;
    if (i.unit !== 'GB' && !Number.isInteger(v)) return `${i.label} is a whole number`;
  }
  if (l.min > l.max) return `Fewest workers (${l.min}) can't be over most workers (${l.max})`;
  if (l.shrinkCpu < l.growCpu + GAP) return `Shrink at CPU pressure (${l.shrinkCpu}%) must be at least ${GAP} points above the grow line (${l.growCpu}%)`;
  if (l.shrinkMem < l.growMem + GAP) return `Shrink at memory pressure (${l.shrinkMem}%) must be at least ${GAP} points above the grow line (${l.growMem}%)`;
  return null;
}

/** What Auto reads besides the pressure: free memory in GB (null if unknown) and the memory level. */
export interface PoolBox {
  freeGb: number | null;
  level: 'ok' | 'easing' | 'tight';
}
