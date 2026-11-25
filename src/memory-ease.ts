// Citadel eases off on its own as the box's memory runs low (#1748). Cara, 2026-11-23, on the Taskmaster's card about
// one turn swapping the box: "Instead of doing these hard caps can we have it dynamically adjust as it approaches the
// memory cap so it doesnt cause problems?"
//
// Memory *pressure* (PSI) can't see it: through the Nov 23 22:38-22:50 PST swap it read 0%, because swap here is zram
// and nothing stalls long, while the kernel's background reclaim ran at 40,000-130,000 pages/s (about 200 normally)
// and disk reads at 400 MB/s. So this reads what did move, every 5 s: MemAvailable, and the rates of kswapd's
// reclaim (pgsteal_kswapd) and of swap-out (pswpout) from /proc/vmstat. It picks one level:
//
//   ok      nothing waits for memory.
//   easing  under 6 GB available, or reclaim over 20,000 pages/s or swap-out over 20 MB/s for 30 s. Citadel's own
//           starts and background passes wait (src/pressure.ts counts it as starved), heavy jobs wait for room
//           (tools/citadel-heavy reads the level file), and nested `claude` sessions a turn starts are spaced to one a
//           minute per turn (tools/claude-pace).
//   tight   under 3 GB available, or reclaim over 80,000 pages/s for 30 s. On top: new nested sessions hold (one goes
//           after 10 min), and src/growth-stop.ts holds the fastest-growing big host turn at its size.
//
// Going back down takes 60 s of calm: back over 8 GB with reclaim under 5,000 pages/s and swap-out under 5 MB/s for
// easing to end, over 4 GB with reclaim under the tight line for tight to end, one step at a time, so it doesn't flap.
// The numbers are starting values (the 5-minute host samples missed Nov 23's low point).
//
// The level goes to <CITADEL_HEAVY_DIR>/memory-level (first line the level, second why), rewritten every reading, so
// host turns and people's containers read one answer; a reader treats a file over 60 s old as ok, so a stopped server
// never holds anyone. Each stretch away from ok is recorded as a 'memory-easing' health event when it ends; the Status
// page shows the stretch going on now (current()) and the past ones. Nothing here stops or kills anything.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { every, type Job } from './every.ts';
import { hostText, MEMINFO } from './host-signals.ts';

export type EaseLevel = 'ok' | 'easing' | 'tight';

const GB = 1024 ** 3;
const RANK: Record<EaseLevel, number> = { ok: 0, easing: 1, tight: 2 };

/** The lines (bytes, pages/s, bytes/s, ms). Starting values: see the header. */
export const LINES = {
  easeFree: 6 * GB,
  backFree: 8 * GB,
  tightFree: 3 * GB,
  untightFree: 4 * GB,
  reclaimEase: 20_000,
  reclaimTight: 80_000,
  reclaimQuiet: 5_000,
  swapEase: 20e6,
  swapQuiet: 5e6,
  sustainMs: 30_000,
  calmMs: 60_000,
};
export type Lines = typeof LINES;
export const EASE_EVERY_MS = 5_000;
/** The level file's name in citadel-heavy's folder. */
export const LEVEL_FILE = 'memory-level';
/** Two readings further apart than this give no rates (a suspended server): the stretch's "for 30 s" starts over. */
const MAX_GAP_MS = 60_000;
const PAGE = 4096;

/** One look at the box: MemAvailable in bytes, and the running counters (null where the file lacks them). */
export interface RawMemory {
  at: number;
  avail: number | null;
  kswapd: number | null;
  pswpout: number | null;
}
/** A reading with rates: reclaim in pages/s, swap-out in bytes/s; null without two comparable readings. */
export interface MemorySample {
  at: number;
  avail: number | null;
  reclaim: number | null;
  swapOut: number | null;
}

/** What is waiting on memory right now, for the Status page. */
export interface EaseWaiting {
  starts: number;
  heavy: number;
  nested: number;
}
/** A turn held at its size by the growth stop. */
export interface Slowed {
  unit: string;
  ticket: number | null;
  bytes: number;
  at: number;
}

/** One stretch away from ok: going on (until null) or recorded. */
export interface Episode {
  since: number;
  until: number | null;
  peak: EaseLevel;
  why: string;
  lowestFree: number | null;
  peakReclaim: number | null;
  peakSwapOut: number | null;
  waited: EaseWaiting;
  slowed: { unit: string; ticket: number | null; bytes: number }[];
}

/** What the Status page shows. */
export interface EaseNow {
  level: EaseLevel;
  since: number;
  why: string;
  free: number | null;
  reclaim: number | null;
  swapOut: number | null;
  lines: { easeFree: number; backFree: number; tightFree: number };
  waiting: EaseWaiting;
  slowed: Slowed[];
  episodeSince: number | null;
}

/** MemAvailable, bytes, from /proc/meminfo's text; null when it isn't there. */
export function parseAvail(meminfo: string): number | null {
  const m = meminfo.match(/^MemAvailable:\s+(\d+) kB/m);
  return m ? Number(m[1]) * 1024 : null;
}
function counter(vmstat: string, name: string): number | null {
  const m = vmstat.match(new RegExp(`^${name} (\\d+)$`, 'm'));
  return m ? Number(m[1]) : null;
}

/** The real box: /proc/meminfo and /proc/vmstat (through host-signals, so a test's server reads fixed text). */
export async function readBoxMemory(now = Date.now()): Promise<RawMemory> {
  const [meminfo, vmstat] = await Promise.all([hostText(MEMINFO).catch(() => ''), hostText('/proc/vmstat').catch(() => '')]);
  return { at: now, avail: parseAvail(meminfo), kswapd: counter(vmstat, 'pgsteal_kswapd'), pswpout: counter(vmstat, 'pswpout') };
}

const gb = (b: number) => `${(b / GB).toFixed(1)} GB`;
const mbs = (b: number) => `${Math.round(b / 1e6)} MB/s`;
const pages = (n: number) => `${Math.round(n).toLocaleString('en-US')} pages/s`;

/** A stored episode's detail, or null for one that doesn't parse. */
export function parseEpisode(detail: string): Episode | null {
  try {
    const e = JSON.parse(detail);
    return e && typeof e.since === 'number' && typeof e.why === 'string' ? e : null;
  } catch {
    return null;
  }
}

export interface EaseDeps {
  /** One look at the box; readBoxMemory unless a test fakes it. */
  read?: (now: number) => Promise<RawMemory>;
  /** citadel-heavy's folder, where the level file goes; null writes none. */
  heavyDir: string | null;
  /** Records a finished stretch (a 'memory-easing' health event). */
  record?: (at: number, e: Episode) => void;
  /** What waits on memory now: held starts, heavy jobs, nested sessions. */
  waiting?: () => EaseWaiting;
  /** Turns the growth stop holds now. */
  slowed?: () => Slowed[];
  /** Called after each reading with the level, for the growth stop. */
  after?: (level: EaseLevel) => Promise<void> | void;
  now?: () => number;
  log?: (line: string) => void;
  lines?: Partial<Lines>;
}

const NONE: EaseWaiting = { starts: 0, heavy: 0, nested: 0 };

/** The box's memory level, read every 5 s. */
export class MemoryEase {
  private d: EaseDeps;
  private L: Lines;
  private level: EaseLevel = 'ok';
  private since: number;
  private why = '';
  private last: RawMemory | null = null;
  private sample: MemorySample | null = null;
  /** When each rate went over its line, in an unbroken run of readings; null while under. */
  private over = { reclaimEase: null as number | null, reclaimTight: null as number | null, swapEase: null as number | null };
  private calmSince: number | null = null;
  private episode: Episode | null = null;
  private timer: Job | null = null;
  private busy = false;

  constructor(d: EaseDeps) {
    this.d = d;
    this.L = { ...LINES, ...d.lines };
    this.since = this.now();
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** The level now, and why (empty at ok). */
  get(): { level: EaseLevel; why: string } {
    return { level: this.level, why: this.why };
  }

  /** Folds one reading in: rates from the last one, the level, the episode. Returns the level. */
  step(raw: RawMemory): EaseLevel {
    const prev = this.last;
    this.last = raw;
    const dt = prev ? raw.at - prev.at : 0;
    const ok = prev && dt > 0 && dt <= MAX_GAP_MS;
    const rate = (a: number | null, b: number | null) => (ok && a !== null && b !== null && a >= b ? ((a - b) * 1000) / dt : null);
    const s: MemorySample = {
      at: raw.at,
      avail: raw.avail,
      reclaim: rate(raw.kswapd, prev?.kswapd ?? null),
      swapOut: (() => {
        const r = rate(raw.pswpout, prev?.pswpout ?? null);
        return r === null ? null : r * PAGE;
      })(),
    };
    this.sample = s;
    const L = this.L;
    // A run of readings over a rate line; a gap (no rate) breaks it.
    const run = (key: keyof MemoryEase['over'], isOver: boolean) => {
      this.over[key] = isOver ? (this.over[key] ?? s.at) : null;
      return isOver && s.at - this.over[key]! >= L.sustainMs;
    };
    const reclaimTight = run('reclaimTight', s.reclaim !== null && s.reclaim > L.reclaimTight);
    const reclaimEase = run('reclaimEase', s.reclaim !== null && s.reclaim > L.reclaimEase);
    const swapEase = run('swapEase', s.swapOut !== null && s.swapOut > L.swapEase);
    const free = s.avail;
    let target: EaseLevel = 'ok';
    let why = '';
    if (free !== null && free < L.tightFree) {
      target = 'tight';
      why = `${gb(free)} free (tight under ${gb(L.tightFree)})`;
    } else if (reclaimTight) {
      target = 'tight';
      why = `the kernel reclaiming ${pages(s.reclaim!)} for ${L.sustainMs / 1000} s`;
    } else if (free !== null && free < L.easeFree) {
      target = 'easing';
      why = `${gb(free)} free (eases under ${gb(L.easeFree)}, back over ${gb(L.backFree)})`;
    } else if (reclaimEase) {
      target = 'easing';
      why = `the kernel reclaiming ${pages(s.reclaim!)} for ${L.sustainMs / 1000} s`;
    } else if (swapEase) {
      target = 'easing';
      why = `swapping out ${mbs(s.swapOut!)} for ${L.sustainMs / 1000} s`;
    }

    if (RANK[target] > RANK[this.level]) {
      this.set(target, why, s.at);
      this.calmSince = null;
    } else if (RANK[this.level] > 0) {
      // Calm for the level we're at: over its "back" line, and the rates that raised it quiet.
      const calm = this.level === 'tight' ? (free === null || free >= L.untightFree) && !(s.reclaim !== null && s.reclaim > L.reclaimTight) : (free === null || free >= L.backFree) && !(s.reclaim !== null && s.reclaim > L.reclaimQuiet) && !(s.swapOut !== null && s.swapOut > L.swapQuiet);
      if (!calm) {
        this.calmSince = null;
        if (target === this.level && why) this.why = why; // the newest reason, same level
      } else if (this.calmSince === null) this.calmSince = s.at;
      else if (s.at - this.calmSince >= L.calmMs) {
        const down: EaseLevel = this.level === 'tight' ? 'easing' : 'ok';
        this.set(down, down === 'ok' ? '' : why || `coming back from tight: ${free === null ? '' : `${gb(free)} free`}`.trim(), s.at);
        this.calmSince = null;
      }
    }
    this.track(s);
    return this.level;
  }

  private set(level: EaseLevel, why: string, at: number) {
    const from = this.level;
    this.level = level;
    this.since = at;
    this.why = why;
    (this.d.log ?? ((l: string) => console.log(`[memory-ease] ${l}`)))(level === 'ok' ? `back to ok (was ${from})` : `${level}: ${why}`);
    if (level !== 'ok' && !this.episode) this.episode = { since: at, until: null, peak: level, why, lowestFree: null, peakReclaim: null, peakSwapOut: null, waited: { ...NONE }, slowed: [] };
    if (this.episode && RANK[level] > RANK[this.episode.peak]) this.episode.peak = level;
  }

  /** Keeps the episode's worst numbers and what waited; records it once back to ok. */
  private track(s: MemorySample) {
    const e = this.episode;
    if (!e) return;
    const lo = (a: number | null, b: number | null) => (b === null ? a : a === null ? b : Math.min(a, b));
    const hi = (a: number | null, b: number | null) => (b === null ? a : a === null ? b : Math.max(a, b));
    e.lowestFree = lo(e.lowestFree, s.avail);
    e.peakReclaim = hi(e.peakReclaim, s.reclaim === null ? null : Math.round(s.reclaim));
    e.peakSwapOut = hi(e.peakSwapOut, s.swapOut === null ? null : Math.round(s.swapOut));
    const w = this.waitingNow();
    e.waited = { starts: Math.max(e.waited.starts, w.starts), heavy: Math.max(e.waited.heavy, w.heavy), nested: Math.max(e.waited.nested, w.nested) };
    for (const t of this.d.slowed?.() ?? []) if (!e.slowed.some((x) => x.unit === t.unit)) e.slowed.push({ unit: t.unit, ticket: t.ticket, bytes: t.bytes });
    if (this.level === 'ok') this.close(s.at);
  }

  private close(at: number) {
    const e = this.episode;
    if (!e) return;
    this.episode = null;
    e.until = at;
    try {
      this.d.record?.(e.since, e);
    } catch (err: any) {
      console.error(`Recording a memory-easing stretch failed: ${err?.message ?? err}`);
    }
  }

  private waitingNow(): EaseWaiting {
    try {
      return this.d.waiting?.() ?? NONE;
    } catch {
      return NONE;
    }
  }

  /** The level file: the level, then why. Written by a rename so no reader sees half of it. */
  private async writeFile() {
    if (!this.d.heavyDir) return;
    const file = join(this.d.heavyDir, LEVEL_FILE);
    await mkdir(this.d.heavyDir, { recursive: true });
    await writeFile(`${file}.tmp`, `${this.level}\n${this.why}\n`);
    await rename(`${file}.tmp`, file);
  }

  /** One reading: the level, the file, then the growth stop. Never throws. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const raw = await (this.d.read ?? readBoxMemory)(this.now());
      const level = this.step(raw);
      await this.writeFile().catch((err) => console.error(`Writing the memory level failed: ${err?.message ?? err}`));
      await this.d.after?.(level);
    } catch (err: any) {
      console.error(`Memory easing reading failed: ${err?.message ?? err}`);
    } finally {
      this.busy = false;
    }
  }

  /** For the Status page: null at ok. */
  /** MemAvailable at the last reading, bytes (also at ok, where current() is null). */
  free(): number | null {
    return this.sample?.avail ?? null;
  }

  current(): EaseNow | null {
    if (this.level === 'ok') return null;
    const s = this.sample;
    return {
      level: this.level,
      since: this.since,
      why: this.why,
      free: s?.avail ?? null,
      reclaim: s?.reclaim == null ? null : Math.round(s.reclaim),
      swapOut: s?.swapOut == null ? null : Math.round(s.swapOut),
      lines: { easeFree: this.L.easeFree, backFree: this.L.backFree, tightFree: this.L.tightFree },
      waiting: this.waitingNow(),
      slowed: this.d.slowed?.() ?? [],
      episodeSince: this.episode?.since ?? null,
    };
  }

  start() {
    this.timer = every('memory easing', EASE_EVERY_MS, () => this.tick(), 0);
  }

  /** Stops reading and records a stretch still open. The level file is left to go stale (readers ignore it after 60 s). */
  stop() {
    this.timer?.stop();
    this.timer = null;
    if (this.episode) this.close(this.now());
  }
}
