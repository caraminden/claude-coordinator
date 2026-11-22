// The event-loop lag log (#526): the server is one thread, so while synchronous work runs (a git or gh
// call, a big delete, a gunzip, a big query) it answers nobody. This names each such stall in the journal.
// With `profile` on (the live server, #609), a CPU sampler runs all along at one sample per 10 ms, and each
// stall's line names the code that ran during it, as its commonest stacks:
//   The event loop was held for 1.2 s: ... Running: 70% listTickets (src/db.ts:1201) < handler (src/routes/projects.ts:411); 20% (garbage collector)
import { readdir, readFile, readlink } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { basename } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ZONE } from './pacific.ts';
import { CGROUP_ROOT, hostTextSync, PSI_FILES, SELF_CGROUP } from './host-signals.ts';

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
export function namedStacks(profiles: Profile[], from: number, to: number, top = 3, outer = false): string {
  const counts = new Map<string, number>();
  let total = 0;
  for (const profile of profiles) {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    let t = profile.startTime;
    for (let i = 0; i < profile.samples.length; i++) {
      const delta = profile.timeDeltas[i];
      t += delta;
      if (t < from) continue;
      if (t > to) break;
      const leaf = byId.get(profile.samples[i]);
      if (!leaf || leaf.callFrame.functionName === '(idle)') continue;
      // Weighted by the time since the last sample: a thread stuck in the kernel (disk wait) takes no samples, and the
      // first one after it names the frame that waited, so the gap counts for that frame instead of vanishing.
      const weight = Math.max(1, delta);
      let key: string;
      if (outer) {
        // The outermost frame of this repo that is a named function: the job, route or timer that was running.
        let name = frameName(leaf.callFrame);
        for (let id = parent.get(leaf.id); id !== undefined; id = parent.get(id)) {
          const f = byId.get(id)!.callFrame;
          if (!f.url.startsWith(ROOT) || /\/node_modules\//.test(f.url) || (f.functionName === '' && f.lineNumber === 0)) continue;
          name = frameName(f);
        }
        key = name;
      } else {
        const names = [frameName(leaf.callFrame)];
        for (let id = parent.get(leaf.id); id !== undefined && names.length < 4; id = parent.get(id)) {
          const f = byId.get(id)!.callFrame;
          if (!f.url.startsWith(ROOT) || /\/node_modules\//.test(f.url)) continue;
          const name = frameName(f);
          if (names.at(-1) !== name) names.push(name);
        }
        key = names.join(' < ');
      }
      counts.set(key, (counts.get(key) ?? 0) + weight);
      total += weight;
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, n]) => `${Math.round((100 * n) / total)}% ${key}`).join('; ');
}

/** Microseconds the box has spent with every task stalled on disk I/O since boot (Linux PSI), or null where it can't say. */
export function ioStalledUs(file: string = PSI_FILES.io): number | null {
  try {
    const us = Number(/^full .*total=(\d+)/m.exec(hostTextSync(file))?.[1]);
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
    const rel = /^0::(.*)$/m.exec(hostTextSync(SELF_CGROUP))?.[1];
    cgroupDir = rel ? `${CGROUP_ROOT}${rel}` : null;
  } catch {
    cgroupDir = null;
  }
  return cgroupDir;
}

/** Microseconds of "some" pressure in `kind` (cpu, io or memory) for the server's cgroup, else the box; null if unreadable. */
export function pressureUs(kind: 'cpu' | 'io' | 'memory', dir = cgroupOf()): number | null {
  for (const file of [dir && `${dir}/${kind}.pressure`, PSI_FILES[kind]]) {
    if (!file) continue;
    try {
      const us = Number(/^some .*total=(\d+)/m.exec(hostTextSync(file))?.[1]);
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

/** A wall-clock instant as the line's reader (Pacific) sees it: "02:23:05" and "PST". */
function clockParts(ms: number): { time: string; zone: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return { time: `${p.hour}:${p.minute}:${p.second}`, zone: p.timeZoneName };
}
/** "02:23:05 to 02:23:18 PST", the stall's own start and end, measured when it was detected (not when the line was written). */
export function stallSpan(startMs: number, endMs: number): string {
  const a = clockParts(startMs), b = clockParts(endMs);
  return a.zone === b.zone ? `${a.time} to ${b.time} ${b.zone}` : `${a.time} ${a.zone} to ${b.time} ${b.zone}`;
}

/** One look at the held thread: its kernel state letter (R, S, D...) and what it waits on in the kernel ("" or "0" when nothing). */
export interface WaitSample { state: string; wchan: string }
/** "D folio_wait_bit_common ×7, S futex_wait_queue ×2", commonest first; empty with no samples. */
export function summarizeWaits(samples: WaitSample[]): string {
  const count = new Map<string, number>();
  for (const s of samples) {
    const w = s.wchan && s.wchan !== '0' ? ` ${s.wchan}` : '';
    count.set(`${s.state}${w}`, (count.get(`${s.state}${w}`) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ×${n}`).join(', ');
}

const SLOTS = 64, SLOT_BYTES = 40;
/** The worker's code: while the main thread's heartbeat is older than `over` ms it samples that thread's state and wchan from /proc into the shared slots. */
const WAIT_WORKER = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { over, pid, hb, slots, count, slotBytes, max } = workerData;
const beat = new Float64Array(hb), bytes = new Uint8Array(slots), n = new Int32Array(count);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
setInterval(() => {
  const at = beat[0];
  if (!(at > 0) || Number(process.hrtime.bigint() / 1000000n) - at <= over) return;
  const i = Atomics.load(n, 0);
  if (i >= max) return;
  const stat = read('/proc/' + pid + '/task/' + pid + '/stat');
  const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) || '?';
  const wchan = read('/proc/' + pid + '/task/' + pid + '/wchan').trim();
  const buf = Buffer.from(state + wchan).subarray(0, slotBytes - 1);
  bytes.fill(0, i * slotBytes, (i + 1) * slotBytes);
  bytes.set(buf, i * slotBytes);
  Atomics.store(n, 0, i + 1);
}, 50);
`;

/**
 * Samples the main thread's kernel state and wchan during a hold (#1460). The main thread can't look at itself while
 * held, so a worker thread does, from /proc/<pid>/task/<pid> (the main thread's tid is the pid): no root needed.
 * `drain` reads what it saw since the last drain, at the tick that ends the hold. Null where it can't start.
 */
export function startWaitSampler(over: number): { drain(): WaitSample[]; beat(): void; stop(): void } | null {
  if (process.platform !== 'linux') return null;
  try {
    const hb = new SharedArrayBuffer(8), slots = new SharedArrayBuffer(SLOTS * SLOT_BYTES), count = new SharedArrayBuffer(4);
    const beatAt = new Float64Array(hb), n = new Int32Array(count), bytes = new Uint8Array(slots);
    const worker = new Worker(WAIT_WORKER, { eval: true, workerData: { over, pid: process.pid, hb, slots, count, slotBytes: SLOT_BYTES, max: SLOTS } });
    worker.on('error', () => {});
    worker.unref();
    const beat = () => { beatAt[0] = Number(process.hrtime.bigint() / 1000000n); };
    beat();
    return {
      beat,
      drain() {
        const k = Math.min(Atomics.load(n, 0), SLOTS);
        const out: WaitSample[] = [];
        for (let i = 0; i < k; i++) {
          const raw = Buffer.from(bytes.subarray(i * SLOT_BYTES, (i + 1) * SLOT_BYTES));
          const text = raw.subarray(0, raw.indexOf(0) < 0 ? raw.length : raw.indexOf(0)).toString('utf8');
          out.push({ state: text.slice(0, 1), wchan: text.slice(1) });
        }
        Atomics.store(n, 0, 0);
        return out;
      },
      stop() { void worker.terminate(); },
    };
  } catch {
    return null;
  }
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
 * Whether the recorder's own work (its roll spans, hrtime microseconds) covers most of a stall's window, so the stall
 * is the recorder's own and must not set off another take.
 */
export function mostlyRecorder(spans: Array<[number, number]>, from: number, to: number): boolean {
  let own = 0;
  for (const [a, b] of spans) own += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return own * 2 >= to - from;
}

/**
 * The always-on sampler: `take` hands over the profile so far and starts the next, one take at a time. The roll's
 * profile is kept until the next take, so a stall that spans a roll is still found in it.
 * A roll starts the next console profile BEFORE it ends the last one (#1572): V8 builds its profiler (a walk over every
 * compiled function, ~0.4 s at 100k of them, however little was sampled) only when the first profile starts, so an
 * overlapping hand-over costs about nothing where Profiler.stop then Profiler.start froze the loop for ~0.5 s each time.
 */
class Sampler {
  private session: Session | null = new Session();
  private chain: Promise<unknown>;
  private rolled: Profile | null = null;
  private fresh?: NodeJS.Timeout;
  private log: (text: string) => void;
  private title = 'loop-lag-0';
  private count = 0;
  private finished = new Map<string, Profile>();
  /** When the recorder itself held the loop (its start, its rolls), hrtime microseconds: the last few. */
  spans: Array<[number, number]> = [];

  constructor(log: (text: string) => void) {
    this.log = log;
    this.chain = (async () => {
      const s = this.session!;
      s.connect();
      s.on('Profiler.consoleProfileFinished', (m: any) => this.finished.set(m.params.title, m.params.profile));
      await s.post('Profiler.enable');
      await s.post('Profiler.setSamplingInterval', { interval: SAMPLE_US });
      this.timed(() => console.profile(this.title));
      this.fresh = setInterval(() => void this.next().then((p) => (this.rolled = p)), FRESH_MS).unref();
    })().catch((err) => {
      this.log(`The event-loop sampler did not start (${err?.message ?? err}): stall lines won't say what ran.`);
      this.stop();
    });
  }

  private timed(fn: () => void) {
    const t = process.hrtime.bigint();
    fn();
    this.spans.push([Number(t / 1000n), Number(process.hrtime.bigint() / 1000n)]);
    if (this.spans.length > 8) this.spans.shift();
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
        const old = this.title;
        this.title = `loop-lag-${++this.count}`;
        this.timed(() => { console.profile(this.title); console.profileEnd(old); });
        const profile = this.finished.get(old) ?? null;
        this.finished.delete(old);
        if (!profile) throw new Error('V8 gave no profile');
        return profile;
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
  const waits = startWaitSampler(over);
  let last = process.hrtime.bigint();
  let io = ioStalledUs();
  let reading = readNow();
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const endedAt = Date.now();
    const seen = waits?.drain() ?? [];
    waits?.beat();
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
    // Its own start and end, read now: the Running part below is written after the profile step, seconds later.
    const kernel = summarizeWaits(seen);
    const line = `The event loop was held for ${(held / 1000).toFixed(1)} s (${stallSpan(endedAt - held, endedAt)}): the server answered nobody meanwhile. Cause: ${why.cause} (${why.text}; ${queued} writes queued on the write worker).${kernel ? ` Main thread waited on: ${kernel}.` : ''}`;
    // A blocked write is the disk (this) or another process's lock (the openers): only the second waits on a busy timeout.
    const disk = io != null && ioFrom != null ? ` Disk: the box was fully stalled on I/O for ${((io - ioFrom) / 1e6).toFixed(1)} s of it.` : '';
    const to = Number(now / 1000n);
    // A stall that is the recorder's own work (its start or a roll) gets its line but no take of its own.
    const own = !!sampler && mostlyRecorder(sampler.spans, from, to);
    void Promise.all([own ? [] : sampler?.take() ?? [], held >= 2000 && files.length ? openersOf(files) : []]).then(([ps, who]) => {
      const ran = namedStacks(ps, from, to);
      const inWork = own ? `100% the freeze recorder's own roll (src/loop-lag.ts)` : namedStacks(ps, from, to, 3, true);
      log(`${line}${inWork ? ` In: ${inWork}.` : ''}${ran ? ` Running: ${ran}` : ''}${disk}${who.length ? ` Also open on the database: ${who.join('; ')}.` : ''}`);
    });
  }, every).unref();
  return {
    stop() {
      clearInterval(timer);
      sampler?.stop();
      waits?.stop();
    },
  };
}
