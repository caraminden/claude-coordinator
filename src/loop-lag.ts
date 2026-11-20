// The event-loop lag log (#526): the server is one thread, so while synchronous work runs (a git or gh
// call, a big delete, a gunzip, a big query) it answers nobody. This names each such stall in the journal.
// With `profile` on (the live server, #609), a CPU sampler runs all along at one sample per 10 ms, and each
// stall's line names the code that ran during it, as its commonest stacks:
//   The event loop was held for 1.2 s: ... Running: 70% listTickets (src/db.ts:1201) < handler (src/routes/projects.ts:411); 20% (garbage collector)
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { basename } from 'node:path';

const SAMPLE_US = 10_000;
/** A fresh profile this often keeps its samples bounded (about 60,000) when nothing stalls. */
const FRESH_MS = 10 * 60_000;
/** Frames from this repo (server.ts, src/, tools/) are the ones a stall's line names. */
const ROOT = new URL('..', import.meta.url).href;

interface CallFrame { functionName: string; url: string; lineNumber: number }
interface ProfileNode { id: number; callFrame: CallFrame; children?: number[] }
/** The part of a V8 CPU profile read here; its times are microseconds on process.hrtime's clock. */
export interface Profile { nodes: ProfileNode[]; startTime: number; samples: number[]; timeDeltas: number[] }

function frameName(f: CallFrame): string {
  const where = f.url.startsWith(ROOT) ? `${f.url.slice(ROOT.length)}:${f.lineNumber + 1}` : f.url.startsWith('node:') ? f.url : '';
  return `${f.functionName || '(anonymous)'}${where ? ` (${where})` : ''}`;
}

/**
 * What ran between `from` and `to` (hrtime microseconds) by the profiles' samples: its commonest stacks, each as
 * the innermost frame and then up to three of this repo's own frames outward, as "70% leaf < caller < handler".
 * Empty when no sample falls in the window.
 */
export function namedStacks(profiles: Profile[], from: number, to: number, top = 3): string {
  const counts = new Map<string, number>();
  let total = 0;
  for (const profile of profiles) {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    let t = profile.startTime;
    for (let i = 0; i < profile.samples.length; i++) {
      t += profile.timeDeltas[i];
      if (t < from) continue;
      if (t > to) break;
      const leaf = byId.get(profile.samples[i]);
      if (!leaf || leaf.callFrame.functionName === '(idle)') continue;
      const names = [frameName(leaf.callFrame)];
      for (let id = parent.get(leaf.id); id !== undefined && names.length < 4; id = parent.get(id)) {
        const f = byId.get(id)!.callFrame;
        if (!f.url.startsWith(ROOT) || /\/node_modules\//.test(f.url)) continue;
        const name = frameName(f);
        if (names.at(-1) !== name) names.push(name);
      }
      const key = names.join(' < ');
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, n]) => `${Math.round((100 * n) / total)}% ${key}`).join('; ');
}

/** Microseconds the box has spent with every task stalled on disk I/O since boot (Linux PSI), or null where it can't say. */
export function ioStalledUs(file = '/proc/pressure/io'): number | null {
  try {
    const us = Number(/^full .*total=(\d+)/m.exec(readFileSync(file, 'utf8'))?.[1]);
    return Number.isFinite(us) ? us : null;
  } catch {
    return null;
  }
}

/** What the server's own process and its cgroup's pressure counters read at one moment, for a stall's before and after. */
export interface Reading {
  /** User plus system CPU time of the process, microseconds. */
  cpuUs: number;
  majorFaults: number;
  voluntarySwitches: number;
  involuntarySwitches: number;
  /** Microseconds anyone (PSI "some") in the server's cgroup waited for CPU, disk and memory since it began. Null where the kernel can't say. */
  cpuWaitUs: number | null;
  ioWaitUs: number | null;
  memWaitUs: number | null;
}

let cgroupDir: string | null | undefined;
/** The server's cgroup v2 directory, or null (then the box-wide /proc/pressure files stand in). */
function cgroupOf(): string | null {
  if (cgroupDir !== undefined) return cgroupDir;
  try {
    const rel = /^0::(.*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
    cgroupDir = rel ? `/sys/fs/cgroup${rel}` : null;
  } catch {
    cgroupDir = null;
  }
  return cgroupDir;
}

/** Microseconds of "some" pressure in `kind` (cpu, io or memory) for the server's cgroup, else the box; null if unreadable. */
export function pressureUs(kind: 'cpu' | 'io' | 'memory', dir = cgroupOf()): number | null {
  for (const file of [dir && `${dir}/${kind}.pressure`, `/proc/pressure/${kind}`]) {
    if (!file) continue;
    try {
      const us = Number(/^some .*total=(\d+)/m.exec(readFileSync(file, 'utf8'))?.[1]);
      if (Number.isFinite(us)) return us;
    } catch {}
  }
  return null;
}

export function readNow(): Reading {
  const r = process.resourceUsage();
  return {
    cpuUs: r.userCPUTime + r.systemCPUTime,
    majorFaults: r.majorPageFault,
    voluntarySwitches: r.voluntaryContextSwitches,
    involuntarySwitches: r.involuntaryContextSwitches,
    cpuWaitUs: pressureUs('cpu'),
    ioWaitUs: pressureUs('io'),
    memWaitUs: pressureUs('memory'),
  };
}

export type Cause = 'own work' | 'waited for CPU' | 'waited for disk' | 'waited for memory' | 'unclear';

/** A share of the stall's wall time that one kind of waiting must reach to be named the cause. */
const WAIT_SHARE = 0.25;
/** A share of wall time on the CPU that makes a stall the server's own work. */
const OWN_SHARE = 0.7;

/**
 * Why the loop was held, from the counters' change over its `wallMs`: memory then disk when the cgroup waited on them
 * for a quarter of it (they starve the CPU share too, so they win); then own work when the process was on CPU for
 * 70% of it; then waited for CPU when CPU pressure reached a quarter of it; else unclear (the line still has the numbers).
 * The CPU time is the whole process's: the write worker's threads count in it.
 */
export function stallCause(a: Reading, b: Reading, wallMs: number): { cause: Cause; text: string } {
  const wallUs = wallMs * 1000;
  const cpuUs = b.cpuUs - a.cpuUs;
  const wait = (x: number | null, y: number | null) => (x != null && y != null ? y - x : null);
  const mem = wait(a.memWaitUs, b.memWaitUs), io = wait(a.ioWaitUs, b.ioWaitUs), cpuWait = wait(a.cpuWaitUs, b.cpuWaitUs);
  const s = (us: number | null) => (us == null ? '?' : (us / 1e6).toFixed(1));
  let cause: Cause = 'unclear';
  if (mem != null && mem >= WAIT_SHARE * wallUs) cause = 'waited for memory';
  else if (io != null && io >= WAIT_SHARE * wallUs) cause = 'waited for disk';
  else if (cpuUs >= OWN_SHARE * wallUs) cause = 'own work';
  else if (cpuWait != null && cpuWait >= WAIT_SHARE * wallUs) cause = 'waited for CPU';
  const text = `${s(cpuUs)} s on CPU of ${(wallMs / 1000).toFixed(1)} s; waited ${s(cpuWait)} s for CPU, ${s(io)} s for disk, ${s(mem)} s for memory; ` +
    `${b.majorFaults - a.majorFaults} major faults, ${b.voluntarySwitches - a.voluntarySwitches} voluntary and ${b.involuntarySwitches - a.involuntarySwitches} involuntary switches`;
  return { cause, text };
}

/**
 * The other processes holding any of `files` open (a path prefix, so a database's -wal and -shm count), as
 * "pid program script": who may hold the write lock while the server waits on it (#622). Async, so the scan
 * of /proc doesn't hold the loop itself.
 */
export async function openersOf(files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const pid of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    for (const fd of await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
      const to = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      if (!files.some((f) => to.startsWith(f))) continue;
      const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
      out.push([pid, ...args.slice(0, 2).filter(Boolean).map((a) => basename(a))].join(' '));
      break;
    }
  }
  return out;
}

/**
 * The always-on sampler: `take` hands over the profile so far and starts the next, one take at a time. The roll's
 * profile is kept until the next take, so a stall that spans a roll is still found in it.
 */
class Sampler {
  private session: Session | null = new Session();
  private chain: Promise<unknown>;
  private rolled: Profile | null = null;
  private fresh?: NodeJS.Timeout;
  private log: (text: string) => void;

  constructor(log: (text: string) => void) {
    this.log = log;
    this.chain = (async () => {
      const s = this.session!;
      s.connect();
      await s.post('Profiler.enable');
      await s.post('Profiler.setSamplingInterval', { interval: SAMPLE_US });
      await s.post('Profiler.start');
      this.fresh = setInterval(() => void this.next().then((p) => (this.rolled = p)), FRESH_MS).unref();
    })().catch((err) => {
      this.log(`The event-loop sampler did not start (${err?.message ?? err}): stall lines won't say what ran.`);
      this.stop();
    });
  }

  /** The profiles covering the time since the take before the last roll: none while the sampler is down. */
  async take(): Promise<Profile[]> {
    const p = await this.next();
    const out = [this.rolled, p].filter((x): x is Profile => !!x);
    this.rolled = null;
    return out;
  }

  private next(): Promise<Profile | null> {
    const run = this.chain.then(async () => {
      const s = this.session;
      if (!s) return null;
      try {
        const { profile } = await s.post('Profiler.stop');
        await s.post('Profiler.start');
        return profile as unknown as Profile;
      } catch (err: any) {
        this.log(`The event-loop sampler stopped (${err?.message ?? err}): stall lines won't say what ran.`);
        this.stop();
        return null;
      }
    });
    this.chain = run;
    return run;
  }

  stop() {
    clearInterval(this.fresh);
    this.session?.disconnect();
    this.session = null;
  }
}

/**
 * Log each time the event loop was held more than `over` ms, measured by a timer every `every` ms; with `profile`,
 * each line also names what ran (namedStacks). Each line leads with its cause in words (stallCause: own work, waited for
 * CPU, disk or memory) and the numbers behind it, and `backlog` says how many writes the write worker had queued. Each line says how long the disk stalled the whole box meanwhile, and
 * a stall over 2 s names the other processes that have any of `files` (the databases) open (#622). `stop`
 * ends the watch and the sampler.
 */
export function watchLoopLag(log: (text: string) => void = console.warn, every = 100, over = 500, { profile = false, files = [] as string[], backlog = () => 0 } = {}): { stop(): void } {
  const sampler = profile ? new Sampler(log) : null;
  let last = process.hrtime.bigint();
  let io = ioStalledUs();
  let reading = readNow();
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const held = Number(now - last) / 1e6 - every;
    const from = Number(last / 1000n);
    const ioFrom = io;
    const before = reading;
    last = now;
    io = ioStalledUs();
    reading = readNow();
    if (held <= over) return;
    // The window is the whole gap since the last tick: wall time `held + every`.
    const why = stallCause(before, reading, held + every);
    const queued = backlog();
    const line = `The event loop was held for ${(held / 1000).toFixed(1)} s: the server answered nobody meanwhile. Cause: ${why.cause} (${why.text}; ${queued} writes queued on the write worker).`;
    // A blocked write is the disk (this) or another process's lock (the openers): only the second waits on a busy timeout.
    const disk = io != null && ioFrom != null ? ` Disk: the box was fully stalled on I/O for ${((io - ioFrom) / 1e6).toFixed(1)} s of it.` : '';
    const to = Number(now / 1000n);
    void Promise.all([sampler?.take() ?? [], held >= 2000 && files.length ? openersOf(files) : []]).then(([ps, who]) => {
      const ran = namedStacks(ps, from, to);
      log(`${line}${ran ? ` Running: ${ran}` : ''}${disk}${who.length ? ` Also open on the database: ${who.join('; ')}.` : ''}`);
    });
  }, every).unref();
  return {
    stop() {
      clearInterval(timer);
      sampler?.stop();
    },
  };
}
