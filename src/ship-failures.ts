/**
 * Failed ship tries on the Releases page (#1375): when a handed-off ship doesn't go through, what failed is kept per
 * scheme (the kind, the first few failing tests or conflicted files, the CI run), and each read puts it under its
 * scheme's Previous releases with what happened next, and on the ship-line row of a ship that is back in line. Every
 * scheme that ships with hand_off_land gets it; old rows (no saved detail) are untouched.
 */
import type { Store } from './db.ts';
import { classifyLandFailure } from './land.ts';
import { CITADEL_TARGET, PREVIOUS, type Release, type TargetView } from './releases.ts';

/** What a failed try's row says about it. */
export interface FailureDetail {
  /** Words for the kind: "tests failed", "merge conflict", "smoke check", "CI timeout", "deploy or boot"… */
  kind: string;
  /** The failing tests, or the conflicted files: the first few. */
  names: string[];
  /** How many more there were than `names` shows. */
  more: number;
  /** The CI run it failed in, when its output names one. */
  ci: string | null;
}

export interface ShipFailure extends FailureDetail {
  ticketId: number;
  at: number;
}

/** What happened after a failed try, worked out at each read. */
export type FailureNext =
  | { kind: 'again'; at: number } // a newer try of the same minion failed too: its own row says why
  | { kind: 'shipped'; release: string | null }
  | { kind: 'line'; place: string | null; holds: boolean } // handed off again
  | { kind: 'closed' }
  | { kind: 'fixing' | 'idle'; note: string | null }; // its turn is running, or not; note: its latest status line

export interface LastTry extends FailureDetail {
  at: number;
}

/** How many names a row lists before "+N more". */
const NAMES = 3;
/** Failed tries kept per scheme, and shown per card. */
const KEEP = 40;
const SHOWN = 5;
const key = (projectId: number) => `ship-failures:${projectId}`;

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** A failed ship's output summed up, with classifyLandFailure's kind (the one the minion's wake leads with). */
export function failureDetail(output: string, code: number | null): FailureDetail {
  const cls = classifyLandFailure(output)?.kind ?? null;
  const conflicts = uniq([...output.matchAll(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/gm)].map((m) => m[1]));
  // node's reporter: "✖ <name> (12.3ms)", each failure twice (inline and in its summary); citadel-test's "✖ file:1 › name".
  const tests = uniq([
    ...[...output.matchAll(/✖ (.+?) \(\d+(?:\.\d+)?ms\)\s*$/gm)].map((m) => m[1].replace(/^\S+\.test\.ts(?::\d+)? › /, '')),
    ...[...output.matchAll(/✖ \S+\.test\.ts(?::\d+)? › (.+?)(?: \(\d+(?:\.\d+)?ms\))?\s*$/gm)].map((m) => m[1]), // the smoke check's, no time
  ]);
  const files = uniq([...output.matchAll(/^(?:.*\t)?run-tests: (\S+\.test\.ts): /gm)].map((m) => m[1]));
  const kind = cls === 'conflict' || conflicts.length ? 'merge conflict'
    : code === 75 || /^land: .*(gave no verdict|timed out waiting for CI)/m.test(output) ? 'CI timeout'
    : cls === 'parse' ? 'parse error'
    : cls === 'ci' ? 'CI or runner problem'
    : cls === 'boot-copy' ? 'boot check'
    : /^land: smoke: .*, before the line/m.test(output) ? 'smoke check'
    : cls === 'flake' ? 'flaky tests'
    : cls === 'own-test' || cls === 'always-test' || tests.length || /tests failed/.test(output) ? 'tests failed'
    : /^(deploy|boot-check): .*(fail|refus|error|unhealthy)/im.test(output) ? 'deploy or boot'
    : 'failed';
  const all = kind === 'merge conflict' ? conflicts : tests.length ? tests : files;
  const runs = output.split('\n').filter((l) => /\/actions\/runs\/\d+/.test(l));
  // The run named where it failed, else any run not named as a pass (a green CI before a failed deploy isn't the cause).
  const line = runs.filter((l) => /fail|\bred\b|refus|cancel|timed out|no verdict/i.test(l)).pop() ?? runs.filter((l) => !/pass|green/i.test(l)).pop();
  const ci = line?.match(/https:\/\/\S+?\/actions\/runs\/\d+/)?.[0] ?? null;
  return { kind, names: all.slice(0, NAMES), more: Math.max(0, all.length - NAMES), ci };
}

/** Keep a failed try's detail for its scheme's Releases card (newest last, the oldest dropped past KEEP). */
export function recordFailure(store: Store, ticketId: number, output: string, code: number | null, at = Date.now()) {
  const t = store.getTicket(ticketId);
  if (!t) return;
  const list = store.getSetting<ShipFailure[]>(key(t.project_id)) ?? [];
  list.push({ ticketId, at, ...failureDetail(output, code) });
  store.setSetting(key(t.project_id), list.slice(-KEEP));
}

export interface AttachDeps {
  store: Store;
  /** Whether the minion's ship is handed off and not reported yet (Landings.hasHandoff). */
  landing: (ticketId: number) => boolean;
  /** Whether the minion's turn is running. */
  running: (ticketId: number) => boolean;
}

/** The release a scheme's failed tries go under: its own server or main, else its first target. */
const homeOf = (views: Omit<TargetView, 'testCopies'>[]) => views.find((v) => v.target.kind === CITADEL_TARGET || v.target.kind === 'main') ?? views[0];

const releaseName = (tv: Omit<TargetView, 'testCopies'>, r: Release) => r.name ?? (r.number == null ? null : tv.target.numbering?.name?.replace(/\{n\}/g, String(r.number)) ?? `Release ${r.number}`);

/**
 * Put each scheme's failed tries in its home card's Previous releases, newest first among the rest, each with what
 * happened next; and give a ship that is back in line its last failure, on its change and line rows.
 */
export function attachFailures(views: Omit<TargetView, 'testCopies'>[], d: AttachDeps) {
  for (const projectId of new Set(views.map((v) => v.target.projectId))) {
    const list = d.store.getSetting<ShipFailure[]>(key(projectId));
    if (!list?.length) continue;
    const mine = views.filter((v) => v.target.projectId === projectId);
    // When each minion last went live, and in which release.
    const shipped = new Map<number, { at: number; release: string | null }>();
    for (const tv of mine) for (const r of [tv.current, ...tv.recent]) {
      if (!r?.live) continue;
      for (const c of r.changes) if ((shipped.get(c.ticketId)?.at ?? 0) < r.live) shipped.set(c.ticketId, { at: r.live, release: releaseName(tv, r) });
    }
    const places = new Map(mine.flatMap((tv) => tv.line.flatMap((e) => (e.ticketId != null ? [[e.ticketId, e] as const] : []))));
    const newest = new Map<number, ShipFailure>();
    for (const f of list) if ((newest.get(f.ticketId)?.at ?? 0) <= f.at) newest.set(f.ticketId, f);

    const next = (f: ShipFailure): FailureNext => {
      const t = d.store.getTicket(f.ticketId);
      const later = newest.get(f.ticketId)!;
      const live = shipped.get(f.ticketId);
      if (later !== f) return { kind: 'again', at: later.at };
      if (live && live.at > f.at) return { kind: 'shipped', release: live.release };
      if (d.landing(f.ticketId)) {
        const e = places.get(f.ticketId);
        return { kind: 'line', place: e?.holds ? null : e?.place ?? null, holds: !!e?.holds };
      }
      if (!t || t.status === 'closed') return { kind: 'closed' };
      return { kind: d.running(f.ticketId) ? 'fixing' : 'idle', note: t.note };
    };

    const home = homeOf(mine);
    const when = (r: Release) => r.live ?? r.started ?? 0;
    // On a full history, tries older than its oldest release are past it (and past knowing whether they shipped since).
    const times = home.recent.map(when).filter(Boolean);
    const oldest = home.recent.length >= PREVIOUS && times.length ? Math.min(...times) : 0;
    const tries: Release[] = list.filter((f) => f.at >= oldest).slice(-SHOWN).reverse().map((f) => {
      const t = d.store.getTicket(f.ticketId);
      const { ticketId, at, ...detail } = f;
      return {
        version: '', number: null, link: null, started: at, live: null, outcome: 'failed', stages: {},
        changes: [{ ticketId, number: t?.number ?? null, title: t?.title ?? '' }], failure: { ...detail, next: next(f) },
      };
    });
    // Each try goes in before the first timed row older than it; the rows already there keep their order.
    const merged: Release[] = [];
    for (const r of home.recent) {
      while (tries.length && when(r) && tries[0].started! > when(r)) merged.push(tries.shift()!);
      merged.push(r);
    }
    home.recent = times.length ? [...merged, ...tries] : [...tries, ...merged]; // no times to go by: the tries are the newest

    // A ship back in line shows its last failure, unless it went live since.
    for (const tv of mine) {
      const last = (id: number | null) => {
        const f = id == null || !d.landing(id) ? null : newest.get(id);
        if (!f || f.at < oldest || (shipped.get(f.ticketId)?.at ?? 0) > f.at) return null;
        const { ticketId: _, ...lastTry } = f;
        return lastTry;
      };
      for (const c of tv.next?.changes ?? []) { const l = last(c.ticketId); if (l) c.lastTry = l; }
      for (const e of tv.line) { const l = last(e.ticketId); if (l) e.lastTry = l; }
    }
  }
}
