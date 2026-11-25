import { thrown } from './thrown.ts';
// Every server-wide periodic job, started through one helper so one list says what runs, how often, when it last
// ran, how long it took and how it last failed (#1311; docs/adr/0002-background-jobs-out-of-server.md).

export type JobRow = {
  name: string;
  /** The period, ms. */
  ms: number;
  /** When it was started, and when its first run is due. */
  since: number;
  firstAt: number;
  runs: number;
  fails: number;
  /** Runs started and not yet finished: a slow async job can overlap its next tick. */
  running: number;
  /** The last run's start and its wall time, ms (an async job's awaits count). */
  last: number | null;
  took: number | null;
  error: string | null;
  errorAt: number | null;
};

export type Job = { run(): Promise<void>; stop(): void };

const jobs = new Map<string, JobRow>();
const stops = new Set<() => void>();

/** Stop every job: a warm handover's old server (src/handover.ts), whose new server runs them from now on. */
export function stopAll() {
  for (const stop of [...stops]) stop();
}

/**
 * Run `fn` every `ms` ms under `name`: a throw or rejection is logged and recorded and the next tick runs again, the
 * timer is unref'd, and each run's start and wall time are recorded. `first` adds one run that many ms after start (0:
 * now). `run` is the same recorded run, for a caller's own extra pass; `stop` clears the timers and drops the row.
 */
export function every(name: string, ms: number, fn: () => unknown, first?: number): Job {
  const now = Date.now();
  const row: JobRow = { name, ms, since: now, firstAt: now + (first ?? ms), runs: 0, fails: 0, running: 0, last: null, took: null, error: null, errorAt: null };
  jobs.set(name, row);
  // The start of the run `took` describes: a slow run finishing after a newer fast one doesn't overwrite it.
  let tookFrom = 0;
  const run = async () => {
    const t0 = Date.now();
    row.last = t0;
    row.runs++;
    row.running++;
    try {
      await fn();
    } catch (err) {
      row.fails++;
      row.error = String(thrown(err).message ?? err).slice(0, 500);
      row.errorAt = Date.now();
      console.error(`Background job "${name}" failed:`, err);
    } finally {
      row.running--;
      if (t0 >= tookFrom) [tookFrom, row.took] = [t0, Date.now() - t0];
    }
  };
  const timer = setInterval(() => void run(), ms).unref();
  const once = first === undefined ? null : first === 0 ? (void run(), null) : setTimeout(() => void run(), first).unref();
  const stop = () => {
    clearInterval(timer);
    if (once) clearTimeout(once);
    if (jobs.get(name) === row) jobs.delete(name);
    stops.delete(stop);
  };
  stops.add(stop);
  return { run, stop };
}

/** Over this, a run is marked slow. */
export const SLOW_MS = 1000;

/** Every job, with `overdue` (no run started for 3 periods past when one was due) and `slow` (the last run took over SLOW_MS). */
export function jobList(now = Date.now(), rows = [...jobs.values()]): (JobRow & { overdue: boolean; slow: boolean })[] {
  return rows.map((j) => ({ ...j, overdue: now > (j.last === null ? j.firstAt : j.last + j.ms) + 2 * j.ms, slow: (j.took ?? 0) > SLOW_MS })).sort((a, b) => a.name.localeCompare(b.name));
}
