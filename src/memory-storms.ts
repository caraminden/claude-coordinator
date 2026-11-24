// Memory-limit storms (#1280). When a cgroup in Citadel sits at its MemoryHigh, the kernel throttles and reclaims inside it:
// on 2026-11-20 citadel-turns.slice did that from 11:44 to 11:46 PST (2.3 to 12.7 million pages scanned a second, about
// 5.8 cores of kernel time) and again for most of 12:50 to 13:20 PST, with systemd-oomd killing turns and a ship, while the
// host had 12 to 15 GB free. Only the journal saw it. This reads citadel.slice and its slices and containers every 15 s and,
// when one gains `high` events in its own memory.events.local while its tasks stall on memory for at least LINE of the
// time (memory.pressure's `some` total), records a 'memory-high' health event once the storm ends: the group, how long,
// the seconds stalled and its largest unit. The Status page shows them. Read-only, and quiet where there is no such cgroup.
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { every, type Job } from './every.ts';
import { CGROUP_ROOT, hostText, SELF_CGROUP } from './host-signals.ts';

export const STORM_EVERY_MS = 15_000;
/**
 * The share of a reading's time with tasks stalled on memory that counts as a storm, with `high` events gained. Picked
 * from 2026-11-20's readings: the storm sat at 32 to 120% (a reading can pass 100% when the server's own timer runs
 * late), quiet groups at 0 to 0.3%.
 */
export const LINE = 0.1;
/** A storm whose stalls add up to less than this isn't recorded: a blip, not a storm. */
export const MIN_STALL_S = 5;
/** Readings this far apart (a suspended server, a long freeze) aren't compared: the storm, if any, is cut there. */
const MAX_GAP_MS = 5 * 60_000;

/** One group's counters at one reading. */
export interface GroupReading {
  /** Its cgroup's name, e.g. `citadel-turns.slice` or `citadel-claude-2.service`. */
  name: string;
  /** `high` in memory.events.local: times it went over its own MemoryHigh (its children's don't count). */
  high: number;
  /** memory.pressure's `some` total, in microseconds. */
  someUs: number;
  /** memory.current, bytes. */
  current: number;
  /** memory.high in bytes; null for `max`. */
  limit: number | null;
}

/** What a 'memory-high' health event's detail holds (JSON). */
export interface Storm {
  group: string;
  /** Seconds from the first stormy reading's start to the last one's end. */
  seconds: number;
  /** Seconds some task in it was stalled on memory meanwhile. */
  stalled: number;
  /** `high` events gained. */
  highs: number;
  /** The worst reading's stalled share, 0 to 1 (capped). */
  peak: number;
  /** Its MemoryHigh in bytes, null for none. */
  limit: number | null;
  /** The largest unit inside it at the worst reading, and its memory. */
  unit: string | null;
  unitBytes: number | null;
}

/** The cgroup dir named citadel.slice above (or at) this process's own, from /proc/self/cgroup; null when there is none. */
export async function citadelSliceDir(cgroupFile = SELF_CGROUP, root = CGROUP_ROOT): Promise<string | null> {
  try {
    const path = (await hostText(cgroupFile)).match(/^0::(\/.*)$/m)?.[1];
    if (!path) return null;
    const parts = path.split('/');
    const at = parts.indexOf('citadel.slice');
    return at < 0 ? null : join(root, ...parts.slice(0, at + 1));
  } catch {
    return null;
  }
}

const num = (s: string) => (s.trim() === 'max' ? null : Number(s.trim()));

async function readGroup(dir: string): Promise<GroupReading | null> {
  try {
    const [events, pressure, current, high] = await Promise.all(['memory.events.local', 'memory.pressure', 'memory.current', 'memory.high'].map((f) => readFile(join(dir, f), 'utf8')));
    const h = Number(events.match(/^high (\d+)/m)?.[1]);
    const some = Number(pressure.match(/^some .*total=(\d+)/m)?.[1]);
    if (!Number.isFinite(h) || !Number.isFinite(some)) return null;
    return { name: basename(dir), high: h, someUs: some, current: Number(current.trim()), limit: num(high) };
  } catch {
    return null;
  }
}

/** The groups that carry limits: citadel.slice itself, its slices and each person's container. */
const watched = (name: string) => name.endsWith('.slice') || /^citadel-claude-\d+\.service$/.test(name);

/** Reads `dir` (citadel.slice) and its watched children, by path. */
export async function readGroups(dir: string): Promise<Map<string, GroupReading>> {
  const out = new Map<string, GroupReading>();
  let names: string[] = [];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && watched(e.name)).map((e) => e.name);
  } catch {
    return out;
  }
  const dirs = [dir, ...names.map((n) => join(dir, n))];
  const read = await Promise.all(dirs.map(readGroup));
  dirs.forEach((d, i) => read[i] && out.set(d, read[i]!));
  return out;
}

/**
 * The largest unit inside `dir` by memory.current: every service or scope (a turn, a ship, a container) in it and its
 * slices, not the unit inside the biggest slice, which can be smaller than one elsewhere. A unit names itself.
 */
export async function largestUnit(dir: string): Promise<{ unit: string; bytes: number } | null> {
  const size = async (d: string) => Number((await readFile(join(d, 'memory.current'), 'utf8').catch(() => '0')).trim()) || 0;
  if (!dir.endsWith('.slice')) return { unit: basename(dir), bytes: await size(dir) };
  let best: { unit: string; bytes: number } | null = null;
  const walk = async (at: string, depth: number): Promise<void> => {
    const kids = await readdir(at, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      kids
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const k = join(at, e.name);
          if (e.name.endsWith('.slice')) return depth < 4 ? walk(k, depth + 1) : undefined;
          if (!/\.(service|scope)$/.test(e.name)) return;
          const bytes = await size(k);
          if (!best || bytes > best.bytes) best = { unit: e.name, bytes };
        }),
    );
  };
  await walk(dir, 0);
  return best;
}

interface Open {
  start: number;
  end: number;
  stalledUs: number;
  highs: number;
  peak: number;
  limit: number | null;
  unit: string | null;
  unitBytes: number | null;
}

export interface StormDeps {
  /** citadel.slice's cgroup dir, or null to look it up from this process's cgroup. */
  dir?: string | null;
  record: (at: number, storm: Storm) => void;
  now?: () => number;
  read?: (dir: string) => Promise<Map<string, GroupReading>>;
  largest?: (dir: string) => Promise<{ unit: string; bytes: number } | null>;
}

export class MemoryStorms {
  private last = new Map<string, GroupReading>();
  private lastAt = 0;
  private open = new Map<string, Open>();
  private timer: Job | null = null;
  private dir: string | null | undefined;
  private busy = false;
  private stopped = false;
  private readonly d: StormDeps;
  constructor(d: StormDeps) {
    this.d = d;
    this.dir = d.dir;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** One reading: compares each group with the last, opens, grows and closes storms. Never throws. */
  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (this.dir === undefined) this.dir = await citadelSliceDir();
      if (!this.dir) return;
      const now = this.now();
      const groups = await (this.d.read ?? readGroups)(this.dir);
      const gap = now - this.lastAt;
      for (const [path, g] of groups) {
        const prev = this.last.get(path);
        const open = this.open.get(path);
        const comparable = prev && gap > 0 && gap <= MAX_GAP_MS && g.high >= prev.high && g.someUs >= prev.someUs;
        const stalledUs = comparable ? g.someUs - prev.someUs : 0;
        const share = comparable ? stalledUs / (gap * 1000) : 0;
        const stormy = comparable && g.high > prev.high && share >= LINE;
        if (!stormy) {
          if (open) this.close(path, open);
          continue;
        }
        const o = open ?? { start: this.lastAt, end: now, stalledUs: 0, highs: 0, peak: 0, limit: g.limit, unit: null, unitBytes: null };
        o.end = now;
        o.stalledUs += stalledUs;
        o.highs += g.high - prev.high;
        o.limit = g.limit;
        if (share >= o.peak || !o.unit) {
          o.peak = Math.max(o.peak, share);
          const top = await (this.d.largest ?? largestUnit)(path);
          if (top) [o.unit, o.unitBytes] = [top.unit, top.bytes];
        }
        this.open.set(path, o);
      }
      // A group that went away (a container stopped) ends its storm.
      for (const [path, o] of this.open) if (!groups.has(path)) this.close(path, o);
      // stop() came while this reading awaited: record what it opened too.
      if (this.stopped) for (const [path, o] of [...this.open]) this.close(path, o);
      this.last = groups;
      this.lastAt = now;
    } catch (err: any) {
      console.error(`Memory storm reading failed: ${err?.message ?? err}`);
    } finally {
      this.busy = false;
    }
  }

  private close(path: string, o: Open) {
    this.open.delete(path);
    const stalled = o.stalledUs / 1e6;
    if (stalled < MIN_STALL_S) return;
    const storm: Storm = { group: basename(path), seconds: Math.round((o.end - o.start) / 1000), stalled: Math.round(stalled), highs: o.highs, peak: Math.min(1, Math.round(o.peak * 100) / 100), limit: o.limit, unit: o.unit, unitBytes: o.unitBytes };
    try {
      this.d.record(o.start, storm);
    } catch (err: any) {
      console.error(`Recording a memory storm failed: ${err?.message ?? err}`);
    }
  }

  /** Storms still going, as they stand (for the Status page's "now"). */
  current(): Storm[] {
    return [...this.open].map(([path, o]) => ({ group: basename(path), seconds: Math.round((o.end - o.start) / 1000), stalled: Math.round(o.stalledUs / 1e6), highs: o.highs, peak: Math.min(1, Math.round(o.peak * 100) / 100), limit: o.limit, unit: o.unit, unitBytes: o.unitBytes }));
  }

  start() {
    this.timer = every('memory storms', STORM_EVERY_MS, () => this.tick(), 0);
  }

  /** Stops reading and records the storms still open, so a restart mid-storm doesn't lose them. */
  stop() {
    this.stopped = true;
    this.timer?.stop();
    this.timer = null;
    for (const [path, o] of [...this.open]) this.close(path, o);
  }
}

/** A stored storm's detail, or null for one that doesn't parse. */
export function parseStorm(detail: string): Storm | null {
  try {
    const s = JSON.parse(detail);
    return s && typeof s.group === 'string' && typeof s.stalled === 'number' ? s : null;
  } catch {
    return null;
  }
}
