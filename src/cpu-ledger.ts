// Where perigee's CPU goes (#1332, performance P6): one reading of every Citadel cgroup's cpu.stat plus the host's
// /proc/stat counters, stored as one JSON text in host_samples.cpu_ledger every 5 minutes, and the table and chart
// the Status page builds from the stored readings.
//
// Why cgroup counters: they are exact and nearly free, and a parent's cpu.stat keeps what its ended children used, so
// a short-lived unit under a slice is never lost. The readings are cumulative (microseconds since the cgroup began);
// a table is the difference between two readings. A counter that went down (the unit restarted) counts from zero.
// Other users' CPU is one total, never their process names.
//
// Reads are async (fs/promises, run in parallel), a few dozen small files, well under 50 ms of CPU a sample
// (test/cpu-ledger.test.ts times it on the real tree).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Stored readings: `s` is source key → [usage_usec, system_usec] (cumulative); `h` is the host's [busy_ms, kernel_ms, iowait_ms, processes started]. */
export interface CpuLedger { v: 1; s: Record<string, [number, number]>; h: [number, number, number, number] | null }

/** The sources, in table order: key, label and the chart group's key. Containers are `container:<n>` and labelled on the fly. */
export const CPU_SOURCES: { key: string; label: string; group: string }[] = [
  { key: 'server', label: 'Citadel server', group: 'server' },
  { key: 'turns', label: 'Host turns (minions)', group: 'turns' },
  { key: 'taskmasters', label: 'Taskmaster turns and MCP pool', group: 'turns' },
  { key: 'containers', label: 'Containers', group: 'containers' },
  { key: 'builds', label: 'Ships, kit-sync, fast-verify', group: 'builds' },
  { key: 'heavy', label: 'citadel-heavy builds and tests', group: 'builds' },
  { key: 'godot', label: 'perigee-godot', group: 'godot' },
  { key: 'embed', label: 'citadel-embed (search index)', group: 'apps' },
  { key: 'contraptions', label: 'Contraptions', group: 'apps' },
  { key: 'apps', label: 'Other app units', group: 'apps' },
  { key: 'mine', label: 'Everything else in this account', group: 'mine' },
  { key: 'others', label: 'Other users (total only)', group: 'others' },
  { key: 'system', label: 'System and kernel threads', group: 'others' },
];
/** The chart's seven series: the sources grouped so each stays tellable apart. */
export const CPU_GROUPS: { key: string; label: string }[] = [
  { key: 'server', label: 'Server' }, { key: 'turns', label: 'Turns' }, { key: 'containers', label: 'Containers' },
  { key: 'builds', label: 'Ships and builds' }, { key: 'godot', label: 'Godot' }, { key: 'apps', label: 'Apps and search' },
  { key: 'mine', label: 'Rest of this account' }, { key: 'others', label: 'Other users and system' },
];
export const labelOf = (key: string) => CPU_SOURCES.find((s) => s.key === key)?.label ?? (key.startsWith('container:') ? `Container ${key.slice(10)}` : key);
export const groupOf = (key: string) => CPU_SOURCES.find((s) => s.key === key)?.group ?? (key.startsWith('container:') ? 'containers' : 'mine');

/** "usage_usec 123\nsystem_usec 45 ..." as [usage, system]; null when the file isn't there (a unit that ended). */
async function readStat(file: string): Promise<[number, number] | null> {
  try {
    const t = await readFile(file, 'utf8');
    const num = (k: string) => Number(new RegExp(`^${k} (\\d+)`, 'm').exec(t)?.[1] ?? NaN);
    const u = num('usage_usec'), s = num('system_usec');
    return Number.isFinite(u) && Number.isFinite(s) ? [u, s] : null;
  } catch { return null; }
}

/** The first line of /proc/stat (jiffies, 100 a second) and `processes` (started since boot): busy, kernel and iowait in ms. */
export async function readHost(file = '/proc/stat'): Promise<CpuLedger['h']> {
  try {
    const t = await readFile(file, 'utf8');
    const f = (t.split('\n')[0] ?? '').trim().split(/\s+/).slice(1).map(Number);
    const forks = Number(/^processes (\d+)/m.exec(t)?.[1] ?? NaN);
    if (f.length < 7 || f.some((n) => !Number.isFinite(n)) || !Number.isFinite(forks)) return null;
    const [user, nice, sys, idle, iowait, irq, soft, steal = 0] = f;
    return [(user + nice + sys + irq + soft + steal) * 10, (sys + irq + soft) * 10, iowait * 10, forks];
  } catch { return null; }
}

export interface ReadOptions { root?: string; uid?: number; procStat?: string }

/**
 * One reading. `root` is the cgroup mount (tests point it at fake files). Sources whose unit isn't there are left
 * out; remainders (the rest of a slice) are the slice's total less its named children, never below zero.
 */
export async function readLedger(o: ReadOptions = {}): Promise<CpuLedger> {
  const root = o.root ?? '/sys/fs/cgroup';
  const uid = o.uid ?? process.getuid?.() ?? 0;
  const userSlice = join(root, 'user.slice');
  const mineSlice = join(userSlice, `user-${uid}.slice`);
  const mgr = join(mineSlice, `user@${uid}.service`);
  const citadel = join(mgr, 'citadel.slice');
  const app = join(mgr, 'app.slice');
  const named: [string, string][] = [
    ['server', join(citadel, 'claude-coordinator.service')], ['turns', join(citadel, 'citadel-turns.slice')],
    ['taskmasters', join(citadel, 'citadel-taskmasters.slice')], ['builds', join(citadel, 'citadel-builds.slice')],
    ['heavy', join(citadel, 'citadel-heavy.slice')], ['contraptions', join(mgr, 'contraptions.slice')],
    ['embed', join(app, 'citadel-embed.service')], ['godot', join(app, 'perigee-godot.service')],
  ];
  const [dirs, hostUsers, mine, mgrTotal, citadelTotal, appTotal, godotAgent, host, ...reads] = await Promise.all([
    readdir(citadel).catch(() => [] as string[]),
    readStat(join(userSlice, 'cpu.stat')), readStat(join(mineSlice, 'cpu.stat')), readStat(join(mgr, 'cpu.stat')),
    readStat(join(citadel, 'cpu.stat')), readStat(join(app, 'cpu.stat')), readStat(join(app, 'perigee-godot-agent.service', 'cpu.stat')),
    readHost(o.procStat ?? '/proc/stat'),
    ...named.map(([, dir]) => readStat(join(dir, 'cpu.stat'))),
  ]);
  const s: Record<string, [number, number]> = {};
  named.forEach(([k], i) => { if (reads[i]) s[k] = reads[i]!; });
  if (godotAgent) s.godot = s.godot ? [s.godot[0] + godotAgent[0], s.godot[1] + godotAgent[1]] : godotAgent;
  // Each person's container is its own unit: citadel-claude-<n>.service.
  const boxes = dirs.filter((d) => /^citadel-claude-\d+\.service$/.test(d));
  const boxReads = await Promise.all(boxes.map((d) => readStat(join(citadel, d, 'cpu.stat'))));
  boxes.forEach((d, i) => { if (boxReads[i]) s[`container:${/\d+/.exec(d)![0]}`] = boxReads[i]!; });
  const sum = (keys: (string | null)[], extra: ([number, number] | null)[] = []) => {
    const out: [number, number] = [0, 0];
    for (const k of keys) { const v = k ? s[k] : null; if (v) { out[0] += v[0]; out[1] += v[1]; } }
    for (const v of extra) if (v) { out[0] += v[0]; out[1] += v[1]; }
    return out;
  };
  const rest = (total: [number, number] | null, taken: [number, number]): [number, number] | null =>
    total ? [Math.max(0, total[0] - taken[0]), Math.max(0, total[1] - taken[1])] : null;
  const boxKeys = Object.keys(s).filter((k) => k.startsWith('container:'));
  const citadelNamed = sum(['server', 'turns', 'taskmasters', 'builds', 'heavy', ...boxKeys]);
  const citadelRest = rest(citadelTotal, citadelNamed);
  const appRest = rest(appTotal, sum(['embed', 'godot']));
  if (appRest) s.apps = appRest;
  // The rest of this account: the manager's total less citadel.slice, app.slice and contraptions.slice (and the bit of citadel.slice nothing named).
  const mgrRest = rest(mgrTotal, [(citadelTotal?.[0] ?? 0) + (appTotal?.[0] ?? 0) + (s.contraptions?.[0] ?? 0), (citadelTotal?.[1] ?? 0) + (appTotal?.[1] ?? 0) + (s.contraptions?.[1] ?? 0)]);
  const mineRest = mgrRest && mine ? ([mgrRest[0] + (citadelRest?.[0] ?? 0) + Math.max(0, mine[0] - (mgrTotal?.[0] ?? 0)), mgrRest[1] + (citadelRest?.[1] ?? 0) + Math.max(0, mine[1] - (mgrTotal?.[1] ?? 0))] as [number, number]) : citadelRest;
  if (mineRest) s.mine = mineRest;
  if (hostUsers && mine) s.others = [Math.max(0, hostUsers[0] - mine[0]), Math.max(0, hostUsers[1] - mine[1])];
  return { v: 1, s, h: host };
}

/** A stored ledger, or null for a row from before this column or an odd value. */
export function parseLedger(text: string | null | undefined): CpuLedger | null {
  if (!text) return null;
  try {
    const l = JSON.parse(text);
    return l && l.v === 1 && l.s && typeof l.s === 'object' ? (l as CpuLedger) : null;
  } catch { return null; }
}

/** One source's row for a window: average cores, the kernel share (0 to 1) and core-seconds. */
export interface CpuRow { key: string; label: string; group: string; cores: number; kernel: number; coreSeconds: number }
export interface CpuWindow {
  /** Seconds of readings the window covers. */
  seconds: number;
  rows: CpuRow[];
  /** The host: busy, kernel and iowait cores, processes started a second; null without a /proc/stat reading. */
  host: { busy: number; kernel: number; iowait: number; started: number } | null;
}
/** One hour of the stacked chart: its time and core-seconds per chart group. */
export interface CpuHour { at: number; seconds: number; groups: Record<string, number> }

const delta = (a: number, b: number) => (b >= a ? b - a : b);

/** Differences between each consecutive pair of readings (a, b): b's time, the seconds between them, per-source [usage, system] µs and host ms. */
function steps(rows: { at: number; cpu_ledger?: string | null }[]) {
  const out: { at: number; sec: number; s: Record<string, [number, number]>; h: [number, number, number, number] | null }[] = [];
  let prev: { at: number; l: CpuLedger } | null = null;
  for (const r of rows) {
    const l = parseLedger(r.cpu_ledger);
    if (!l) { prev = null; continue; }
    if (prev && r.at > prev.at) {
      const s: Record<string, [number, number]> = {};
      for (const [k, v] of Object.entries(l.s)) {
        const p = prev.l.s[k];
        // A source new since the last reading (a container just started) counts from zero.
        s[k] = p ? [delta(p[0], v[0]), delta(p[1], v[1])] : [v[0], v[1]];
      }
      const h = l.h && prev.l.h ? ([0, 1, 2, 3].map((i) => delta(prev!.l.h![i], l.h![i])) as [number, number, number, number]) : null;
      out.push({ at: r.at, sec: (r.at - prev.at) / 1000, s, h });
    }
    prev = { at: r.at, l };
  }
  return out;
}

/** The table for the last `windowMs` ending at `now`, from host_samples rows in time order. */
export function cpuTable(rows: { at: number; cpu_ledger?: string | null }[], now: number, windowMs: number): CpuWindow {
  const from = now - windowMs;
  const inWin = steps(rows).filter((st) => st.at > from && st.at <= now);
  const seconds = inWin.reduce((t, st) => t + st.sec, 0);
  const use = new Map<string, [number, number]>();
  let host = [0, 0, 0, 0];
  let hostSec = 0;
  for (const st of inWin) {
    for (const [k, v] of Object.entries(st.s)) { const c = use.get(k) ?? [0, 0]; use.set(k, [c[0] + v[0], c[1] + v[1]]); }
    if (st.h) { host = host.map((x, i) => x + st.h![i]); hostSec += st.sec; }
  }
  const total = (key: string) => use.get(key) ?? [0, 0];
  const rowsOut: CpuRow[] = [];
  const keys = [...CPU_SOURCES.map((s) => s.key).filter((k) => k !== 'containers' && k !== 'system'), ...[...use.keys()].filter((k) => k.startsWith('container:')).sort()];
  let accounted = 0;
  for (const key of keys) {
    const [u, sys] = total(key);
    if (!use.has(key)) continue;
    accounted += u;
    rowsOut.push({ key, label: labelOf(key), group: groupOf(key), cores: seconds ? u / 1e6 / seconds : 0, kernel: u ? sys / u : 0, coreSeconds: u / 1e6 });
  }
  if (hostSec && host[0] > 0) {
    // Whatever the host was busy with that no user's cgroup holds (kernel threads, interrupts, root's own).
    const busyUs = host[0] * 1000;
    const sysRest = Math.max(0, busyUs - accounted);
    rowsOut.push({ key: 'system', label: labelOf('system'), group: 'others', cores: seconds ? sysRest / 1e6 / seconds : 0, kernel: 1, coreSeconds: sysRest / 1e6 });
  }
  rowsOut.sort((a, b) => b.cores - a.cores);
  return {
    seconds, rows: rowsOut,
    host: hostSec ? { busy: host[0] / 1000 / hostSec, kernel: host[1] / 1000 / hostSec, iowait: host[2] / 1000 / hostSec, started: host[3] / hostSec } : null,
  };
}

/** Hourly core-seconds per chart group for the stacked chart, oldest first. */
export function cpuHours(rows: { at: number; cpu_ledger?: string | null }[]): CpuHour[] {
  const hours = new Map<number, CpuHour>();
  for (const st of steps(rows)) {
    const at = Math.floor(st.at / 3_600_000) * 3_600_000;
    const hr = hours.get(at) ?? { at, seconds: 0, groups: {} };
    hr.seconds += st.sec;
    for (const [k, v] of Object.entries(st.s)) hr.groups[groupOf(k)] = (hr.groups[groupOf(k)] ?? 0) + v[0] / 1e6;
    hours.set(at, hr);
  }
  return [...hours.values()].sort((a, b) => a.at - b.at);
}
