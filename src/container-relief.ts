// A person's container stuck at its memory limit (#1876). Past its MemoryHigh the kernel only throttles and reclaims, and
// never gives up: on 2026-11-24 citadel-claude-2 thrashed at its 10G from 16:45 to 17:02 PST, took the box to load 247,
// and was then killed whole with all 25 of its turns. Josh, 2026-11-24, picked "Kill its biggest process": after a minute
// stuck, SIGKILL the process in it with the most anon memory (RSS plus swap, not page cache), and again each minute while
// it lasts. That is usually a build or a test, so one command fails (exit 137) and its turn carries on; killing a claude
// ends its turn, which resumes by itself (src/runner.ts waitForKillResume).
//
// It runs in a worker with sync reads: during that storm the server's own readings took up to 4 minutes (one 15 s storm
// reading held 244 s of stalls), so a timer on the main thread is late just when it matters. Picking and killing need only
// cgroup.procs and /proc/<pid>/status and stat, which don't wait on the process's memory lock. A command line does, and a
// worker's async read of it waits in the thread pool the whole server shares, so one such read (the victim's) is waited for
// CMD_WAIT_MS before the kill and left out past that; whose turn it was is looked up after the kill, one read at a time.
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parentPort, Worker, workerData } from 'node:worker_threads';
import { shownCommand } from './reaper.ts';

/** turn-launch.ts's, repeated so this worker doesn't load all of it (test/container-relief.test.ts holds them equal). */
export const TASKMASTER_SLICE = 'citadel-taskmasters.slice';

export const RELIEF = {
  everyMs: 5000,
  /**
   * memory.pressure's `some` avg10 (percent) from which a container counts as stuck, with `high` events gained since the
   * last reading, and the one under which it no longer is. Nov 24's storms averaged 50 to 63% stalled, quiet groups 0 to 0.3%.
   */
  line: 30,
  calm: 10,
  /** Stuck this long before the first kill, and this long between kills. */
  stuckMs: 60_000,
  /** Readings in a row that don't count as stuck, after which the minute starts over. */
  quiet: 3,
  /** A gap between readings longer than this (a suspended box) starts the minute over. */
  maxGapMs: 5 * 60_000,
};
const CMD_WAIT_MS = 1000;
/** How long, after the kill, the search for the victim's minion may take. */
const TICKET_WAIT_MS = 30_000;
const CMD_CHARS = 120;
/** What holds the container up: killing one ends every turn in it. By /proc/<pid>/status Name. */
const KEEP = new Set(['conmon', 'podman', 'podman-init', 'catatonit']);

export interface Victim {
  /** The container's unit, e.g. `citadel-claude-2.service`. */
  group: string;
  pid: number;
  name: string;
  /** Its command line with secrets masked, '' when it couldn't be read in time. */
  cmd: string;
  /** Its RSS anon plus swap, bytes. */
  bytes: number;
  /** How long the container had been stuck, ms. */
  stuckMs: number;
  /** The container's MemoryHigh, bytes; null for none. */
  limit: number | null;
  /** The minion whose turn ran it, when its ancestors name one. */
  ticket: number | null;
}

interface Proc {
  pid: number;
  ppid: number;
  name: string;
  bytes: number;
  start: string;
  /** The cgroup.procs that listed it. */
  listed: string;
}

/** One container's reading: `high` from memory.events.local, memory.pressure's `some` avg10 in percent. */
export interface Reading {
  high: number;
  avg10: number;
}

/** What is kept of a container between readings. */
export interface Watched {
  high: number;
  at: number;
  /** When it became stuck, null while it isn't. */
  since: number | null;
  /** Readings in a row that weren't stuck. */
  quiet: number;
  killedAt: number;
  killed: Set<string>;
}

/** The next state, and whether a process in the container should die now. Pure but for `s`, which it updates; the replay runs it too. */
export function step(s: Watched | undefined, r: Reading, now: number, stuckMs = RELIEF.stuckMs): { s: Watched; kill: boolean } {
  if (!s || now - s.at > RELIEF.maxGapMs || r.high < s.high) return { s: { high: r.high, at: now, since: null, quiet: 0, killedAt: -Infinity, killed: new Set() }, kill: false };
  const gained = r.high > s.high;
  s.high = r.high;
  s.at = now;
  if (r.avg10 < RELIEF.calm) {
    s.since = null;
    s.killed.clear();
    return { s, kill: false };
  }
  if (!gained || r.avg10 < RELIEF.line) {
    if (++s.quiet >= RELIEF.quiet) s.since = null;
    return { s, kill: false };
  }
  s.quiet = 0;
  s.since ??= now;
  return { s, kill: now - s.since >= stuckMs && now - s.killedAt >= stuckMs };
}

export interface ReliefDeps {
  /** citadel.slice's cgroup dir. */
  dir: string;
  /** The container's unit names start with this and end in the person's id, then -tm for their Taskmasters' (src/claude-link.ts's prefix). */
  prefix: string;
  report: (v: Victim) => void;
  proc?: string;
  now?: () => number;
  kill?: (pid: number) => void;
  stuckMs?: number;
}

const text = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

/** A process's start time (clock ticks), which tells a reused pid from the same process. */
const startOf = (proc: string, pid: number): string => {
  const stat = text(join(proc, String(pid), 'stat'));
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
};

/** Every process in cgroup `dir` and below. */
function processes(dir: string, proc: string): Proc[] {
  const out: Proc[] = [];
  const walk = (at: string, depth: number) => {
    const listed = join(at, 'cgroup.procs');
    for (const line of text(listed).split('\n')) {
      if (!/^\d+$/.test(line)) continue;
      const pid = Number(line);
      const status = text(join(proc, line, 'status'));
      const field = (key: string) => status.match(new RegExp(`^${key}:\\s+(\\S+)`, 'm'))?.[1];
      const start = startOf(proc, pid);
      // No RssAnon: it exited meanwhile, or is a zombie.
      if (!start || field('RssAnon') === undefined) continue;
      out.push({ pid, ppid: Number(field('PPid')), name: field('Name') ?? '', bytes: 1024 * (Number(field('RssAnon')) + Number(field('VmSwap') ?? 0)), start, listed });
    }
    if (depth >= 8) return;
    let kids: string[] = [];
    try {
      kids = readdirSync(at, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      /* it went away */
    }
    for (const k of kids) walk(join(at, k), depth + 1);
  };
  walk(dir, 0);
  return out;
}

/** A command line, [] when it isn't read within `ms`. */
async function argvOf(proc: string, pid: number, ms: number): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<string>((r) => {
    timer = setTimeout(() => r(''), ms);
  });
  const raw = await Promise.race([readFile(join(proc, String(pid), 'cmdline'), 'utf8').catch(() => ''), late]);
  clearTimeout(timer);
  return raw.split('\0').filter(Boolean);
}

/** The minion whose turn wrapper (`<node> <pin>/turn-wrapper.mjs <dir>`, the dir named <ticket>-<started>) is above `p`. */
async function ticketOf(p: Proc, byPid: Map<number, Proc>, proc: string): Promise<number | null> {
  const by = Date.now() + TICKET_WAIT_MS;
  for (let at: Proc | undefined = byPid.get(p.ppid), hops = 0; at && hops < 32 && Date.now() < by; at = byPid.get(at.ppid), hops++) {
    const argv = await argvOf(proc, at.pid, by - Date.now());
    if (!/\/turn-wrapper\.(mjs|ts)$/.test(argv.at(-2) ?? '')) continue;
    const m = basename(argv.at(-1) ?? '').match(/^(\d+)-\d+$/);
    return m ? Number(m[1]) : null;
  }
  return null;
}

export class ContainerRelief {
  private seen = new Map<string, Watched>();
  private busy = false;
  private readonly d: ReliefDeps;
  constructor(d: ReliefDeps) {
    this.d = d;
  }

  /** One reading of every container; kills at most one process in each. Never throws. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const ours = (names: string[], end: RegExp) => names.filter((n) => n.startsWith(this.d.prefix) && end.test(n.slice(this.d.prefix.length)));
      const here = readdirSync(this.d.dir);
      // The Taskmasters' containers (#1882; Josh, 2026-11-25, "Yes, cover them too"); no such slice until a Taskmaster runs.
      const tm = here.includes(TASKMASTER_SLICE) ? ours(readdirSync(join(this.d.dir, TASKMASTER_SLICE)), /^\d+-tm\.service$/).map((n) => join(TASKMASTER_SLICE, n)) : [];
      const names = [...tm, ...ours(here, /^\d+\.service$/)];
      for (const name of [...this.seen.keys()]) if (!names.includes(name)) this.seen.delete(name);
      for (const name of names) await this.look(name);
    } catch (err) {
      console.error(`Container relief reading failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  }

  private async look(name: string): Promise<void> {
    const dir = join(this.d.dir, name);
    const high = Number(text(join(dir, 'memory.events.local')).match(/^high (\d+)/m)?.[1]);
    const avg10 = Number(text(join(dir, 'memory.pressure')).match(/^some avg10=([\d.]+)/m)?.[1]);
    if (!Number.isFinite(high) || !Number.isFinite(avg10)) return;
    const now = this.d.now?.() ?? Date.now();
    const { s, kill } = step(this.seen.get(name), { high, avg10 }, now, this.d.stuckMs);
    this.seen.set(name, s);
    if (kill) await this.relieve(name, dir, s, now);
  }

  private async relieve(name: string, dir: string, s: Watched, now: number): Promise<void> {
    const proc = this.d.proc ?? '/proc';
    const all = processes(dir, proc);
    const byPid = new Map(all.map((p) => [p.pid, p]));
    // One already killed that is still going away (it can take a while to free 10 GB) isn't the one to kill next.
    const picks = all.filter((p) => !KEEP.has(p.name) && !s.killed.has(`${p.pid}:${p.start}`)).sort((a, b) => b.bytes - a.bytes);
    for (const p of picks) {
      const argv = await argvOf(proc, p.pid, CMD_WAIT_MS);
      // Its pid may have ended, and been reused elsewhere, since it was listed.
      if (startOf(proc, p.pid) !== p.start || !text(p.listed).split('\n').includes(String(p.pid))) continue;
      try {
        (this.d.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL')))(p.pid);
      } catch {
        continue; // ended, or not ours to signal: the next biggest
      }
      s.killedAt = now;
      s.killed.add(`${p.pid}:${p.start}`);
      const limit = Number(text(join(dir, 'memory.high')).trim());
      const v = { group: name, pid: p.pid, name: p.name, cmd: shownCommand(argv).slice(0, CMD_CHARS), bytes: p.bytes, stuckMs: now - (s.since ?? now), limit: Number.isFinite(limit) && limit > 0 ? limit : null };
      // Not awaited: the next container's reading doesn't wait for it.
      void ticketOf(p, byPid, proc).then((ticket) => this.d.report({ ...v, ticket }));
      return;
    }
  }
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** The line the turn's chat and the server's log get. */
export function victimText(v: Victim): string {
  return `Out of memory: Citadel killed \`${(v.cmd || v.name).replaceAll('`', "'")}\` (${gb(v.bytes)}), the biggest process in its container, which had been stuck at its ${v.limit ? `${gb(v.limit)} ` : ''}memory limit for ${Math.round(v.stuckMs / 1000)} s. Its command ends with exit 137; run it again smaller or once there is room.`;
}

/** Starts the worker; `stop` ends it. */
export function startContainerRelief(o: { dir: string; prefix: string; report: (v: Victim) => void; everyMs?: number; stuckMs?: number }): { stop: () => void } {
  const worker = new Worker(new URL(import.meta.url), { workerData: { containerRelief: { dir: o.dir, prefix: o.prefix, everyMs: o.everyMs, stuckMs: o.stuckMs } } });
  worker.on('message', (v: Victim) => o.report(v));
  worker.on('error', (err) => console.error(`Container relief stopped: ${err instanceof Error ? err.message : err}`));
  worker.unref();
  return { stop: () => void worker.terminate() };
}

const job: { dir: string; prefix: string; everyMs?: number; stuckMs?: number } | undefined = workerData?.containerRelief;
if (job && parentPort) {
  const port = parentPort;
  const relief = new ContainerRelief({ dir: job.dir, prefix: job.prefix, stuckMs: job.stuckMs, report: (v) => port.postMessage(v) });
  setInterval(() => void relief.tick(), job.everyMs ?? RELIEF.everyMs);
}
