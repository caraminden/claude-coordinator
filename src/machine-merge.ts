// One row per PC (Build 7 M2b; specs/machine-connections.md section 8, "Flagged"): two rows one owner has for one PC (the
// same hostname reported, one of them a CI runner host's row) show "These are one computer: merge". Pressing it keeps one
// row and moves the other's runner agents onto it: its owner reinstalls them there with the kept row's token, and once
// each has connected to the kept row, the CI role moves over and the other row goes, its token with it
// (src/routes/machine-merge.ts). Until then both rows keep working, so nothing stops while the owner runs the lines.
import type { Machine, Store } from './db.ts';

export type Os = 'windows' | 'linux';
/** A merge waiting on `from`'s runner agents (`os`) connecting to `into`, kept in the setting below. */
export type Merge = { from: number; into: number; os: Os[]; by: string; at: number };
export const MERGES_KEY = 'machines-merging';

/** The merges waiting, dropping any whose rows are gone. */
export function merges(store: Pick<Store, 'getSetting' | 'getMachine'>): Merge[] {
  return (store.getSetting<Merge[]>(MERGES_KEY) ?? []).filter((m) => store.getMachine(m.from) && store.getMachine(m.into));
}

/** The merge a machine is in, as either row, or null. */
export const mergeOf = (store: Pick<Store, 'getSetting' | 'getMachine'>, machineId: number): Merge | null => merges(store).find((m) => m.from === machineId || m.into === machineId) ?? null;

/**
 * Which row stays: the one that isn't a CI runner host's row (it has the machine agent and its other roles), and of two
 * runner hosts' rows the older. The other's runner agents move.
 */
export function pickKept<T extends Pick<Machine, 'id'>>(a: T, b: T, runnerRow: (m: T) => boolean): { into: T; from: T } {
  const ra = runnerRow(a);
  const rb = runnerRow(b);
  const keepA = ra === rb ? a.id < b.id : !ra;
  return keepA ? { into: a, from: b } : { into: b, from: a };
}

/**
 * The schemes the kept row's CI role is lent to once merged: each row's own where its CI role is on, so every scheme
 * that got runner tokens from either PC row still does.
 */
export function mergedCi(store: Store, from: Machine, into: Machine): number[] {
  const list = (m: Machine) => {
    const ci = store.machineRoles(m.id).find((r) => r.role === 'ci');
    if (!ci?.on) return [];
    return ci.projects;
  };
  return [...new Set([...list(into), ...list(from)])].sort((a, b) => a - b);
}
