// File-cache health (#1501): how much of coordinator.db sits in the box's memory, and how hard the kernel is discarding and
// re-reading file cache. A cold database (the #1492 deep dive) took two days to find because nothing recorded it. Every source
// is read asynchronously (a file read or a child process), never on the server's thread. Rates are per second since the last
// reading, so the first reading after a start has none.
import { hostText, SELF_CGROUP, CGROUP_ROOT } from './host-signals.ts';
import { execFile } from 'node:child_process';

/** Counters that only go up, from /proc/vmstat and the server's own cgroup, in pages (thp in faults, pgpgin in KiB). */
export interface CacheCounters {
  kswapd: number; refault: number; serverRefault: number | null; pgpgin: number; thpFallback: number;
}

/** What one sample stores: the database's bytes in memory and its size, then each counter's rate per second. */
export interface CacheReading {
  db_cached: number | null; db_size: number | null;
  kswapd_rate: number | null; refault_rate: number | null; server_refault_rate: number | null; pgpgin_rate: number | null; thp_fallback_rate: number | null;
}

const num = (text: string, key: string): number | null => {
  const m = new RegExp(`^${key} (\\d+)`, 'm').exec(text);
  return m ? Number(m[1]) : null;
};

/** /proc/vmstat's counters (and the server group's memory.stat refaults, when given); null when vmstat lacks one. */
export function parseCounters(vmstat: string, serverStat?: string | null): CacheCounters | null {
  const kswapd = num(vmstat, 'pgsteal_kswapd');
  const refault = num(vmstat, 'workingset_refault_file');
  const pgpgin = num(vmstat, 'pgpgin');
  const thpFallback = num(vmstat, 'thp_fault_fallback');
  if (kswapd === null || refault === null || pgpgin === null || thpFallback === null) return null;
  return { kswapd, refault, serverRefault: serverStat ? num(serverStat, 'workingset_refault_file') : null, pgpgin, thpFallback };
}

/** `fincore -b -n -o RES,SIZE <file>`: the file's bytes in memory and its size. Null for anything else. */
export function parseFincore(out: string): { cached: number; size: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/m.exec(out);
  return m ? { cached: Number(m[1]), size: Number(m[2]) } : null;
}

/** Rates per second between two counter readings `ms` apart; null for a counter that went backwards (a reboot) or one side missing. */
export function rates(prev: CacheCounters | null, now: CacheCounters | null, ms: number): Omit<CacheReading, 'db_cached' | 'db_size'> {
  const per = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || b < a || ms <= 0 ? null : Math.round(((b - a) / (ms / 1000)) * 100) / 100);
  return {
    kswapd_rate: per(prev?.kswapd, now?.kswapd), refault_rate: per(prev?.refault, now?.refault), server_refault_rate: per(prev?.serverRefault, now?.serverRefault),
    pgpgin_rate: per(prev?.pgpgin, now?.pgpgin), thp_fallback_rate: per(prev?.thpFallback, now?.thpFallback),
  };
}

/** The alert's starting numbers (tune from a day of rows): under a quarter of the database in memory, three samples in a row, with over 4 GB available. */
export const COLD_SHARE = 0.25;
export const COLD_SAMPLES = 3;
export const COLD_AVAIL_BYTES = 4 * 1024 ** 3;

/** True when the newest COLD_SAMPLES rows (oldest first) all have the database under COLD_SHARE in memory while the box had COLD_AVAIL_BYTES free. */
export function dbCold(rows: { db_cached?: number | null; db_size?: number | null; mem_avail: number }[]): boolean {
  const last = rows.slice(-COLD_SAMPLES);
  return last.length === COLD_SAMPLES && last.every((r) => r.db_cached != null && r.db_size != null && r.db_size > 0 && r.db_cached < r.db_size * COLD_SHARE && r.mem_avail > COLD_AVAIL_BYTES);
}

const run = (file: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** Reads the counters and the database's cache, keeping the last counters for the next rates. */
export class CacheSampler {
  private prev: { at: number; c: CacheCounters } | null = null;
  private deps: { dbPath: string; vmstat?: () => Promise<string>; serverStat?: () => Promise<string | null>; fincore?: (path: string) => Promise<string> };
  constructor(deps: CacheSampler['deps']) { this.deps = deps; }

  async read(now: number): Promise<CacheReading> {
    const d = this.deps;
    const [vm, srv, fin] = await Promise.all([
      (d.vmstat ?? (() => hostText('/proc/vmstat')))().catch(() => null),
      (d.serverStat ?? serverMemoryStat)().catch(() => null),
      (d.fincore ?? ((p) => run('fincore', ['-b', '-n', '-o', 'RES,SIZE', p])))(d.dbPath).catch(() => null),
    ]);
    const c = vm ? parseCounters(vm, srv) : null;
    const db = fin ? parseFincore(fin) : null;
    const r = rates(this.prev?.c ?? null, c, this.prev ? now - this.prev.at : 0);
    this.prev = c ? { at: now, c } : null;
    return { db_cached: db?.cached ?? null, db_size: db?.size ?? null, ...r };
  }
}

/** The server's own cgroup's memory.stat (its refaults), or null where cgroup 2 can't be read. */
async function serverMemoryStat(): Promise<string | null> {
  const own = /^0::(.*)$/m.exec(await hostText(SELF_CGROUP))?.[1];
  return own ? hostText(`${CGROUP_ROOT}${own}/memory.stat`) : null;
}
