// Time to ship (#1132, Josh's pick of S3 on #1093's choices page, 2026-11-19): how long "asked" to "live" takes for each
// ship target (Citadel's main, each release target, each app's deploys), per Pacific day as a median and a p90, and each
// ship's stages for a click-through waterfall. Read from `releases` and `contraption_deploys`; shown on the Status page.
// The nudge: the day a target's p90 passes SLOW_P90_S its scheme's Taskmaster hears, once per day per target.
import type { Store } from './db.ts';
import { pacificDay } from './pacific.ts';

export const SLOW_P90_S = 10 * 60;
/** Kept per target and day, slowest first: the waterfall's rows. */
const SHIPS_PER_DAY = 8;

export interface ShipRow { at: number; took: number; stages: Record<string, number>; label: string }
export interface ShipTarget {
  key: string;
  title: string;
  scheme: number | null;
  /** Per day of StatusData.days: how many ships went live, the median and p90 of their asked-to-live seconds. */
  counts: number[];
  median: (number | null)[];
  p90: (number | null)[];
  ships: ShipRow[];
}
/** A finished ship before grouping: which target, when it went live and how long it took. */
interface Ship extends ShipRow { key: string; title: string; scheme: number | null }

/** Nearest-rank percentile: the smallest value at least `p` of the list is at or below. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
}
const med = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const parseStages = (json: string): Record<string, number> => {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'number' && v > 0)) as Record<string, number>;
  } catch {
    return {};
  }
};

/** Every ship that went live since `since`, across every scheme's release targets and every app's deploys. */
function ships(store: Store, since: number, ownScheme: number | null): Ship[] {
  const out: Ship[] = [];
  for (const r of store.liveReleasesSince(since)) {
    const citadel = r.target === 'citadel-server';
    out.push({
      key: `release:${r.project_id}:${r.target}`, title: citadel ? 'Citadel main' : `${store.getProject(r.project_id)?.name ?? 'Scheme'}: ${r.target}`, scheme: r.project_id,
      at: r.live_at!, took: (r.live_at! - r.started_at!) / 1000, stages: parseStages(r.stages), label: r.version.slice(0, 8),
    });
  }
  const home = new Map(store.listContraptions().map((a) => [a.name, a]));
  for (const d of store.deployedSince(since)) {
    const a = home.get(d.name);
    if (!a) continue; // a deleted app: nobody can see it or act on it
    out.push({
      key: `app:${d.name}`, title: a.title, scheme: a.home_scheme ?? ownScheme,
      at: d.finished_at!, took: (d.finished_at! - d.started_at) / 1000, stages: parseStages(d.stages), label: d.to_sha?.slice(0, 8) ?? '',
    });
  }
  return out.filter((s) => s.took >= 0);
}

/** Every target's days, in `days` order (StatusData.days). `visible` leaves out the schemes a viewer can't see. */
export function shipTargets(store: Store, days: string[], ownScheme: number | null, visible: (scheme: number | null, key: string) => boolean = () => true): ShipTarget[] {
  const since = Date.parse(`${days[0]}T00:00:00Z`) - 86_400_000;
  const by = new Map<string, Ship[]>();
  for (const s of ships(store, since, ownScheme)) if (visible(s.scheme, s.key)) (by.get(s.key) ?? by.set(s.key, []).get(s.key)!).push(s);
  return [...by.values()].map((list) => {
    const per = days.map((d) => list.filter((s) => pacificDay(s.at) === d).map((s) => s.took));
    const kept = days.flatMap((d) => list.filter((s) => pacificDay(s.at) === d).sort((a, b) => b.took - a.took).slice(0, SHIPS_PER_DAY));
    return {
      key: list[0].key, title: list[0].title, scheme: list[0].scheme,
      counts: per.map((p) => p.length), median: per.map(med), p90: per.map((p) => percentile(p, 0.9)),
      ships: kept.map(({ at, took, stages, label }) => ({ at, took, stages, label })),
    };
  }).filter((t) => t.ships.length).sort((a, b) => (a.key.startsWith('release:') ? 0 : 1) - (b.key.startsWith('release:') ? 0 : 1) || a.title.localeCompare(b.title));
}
