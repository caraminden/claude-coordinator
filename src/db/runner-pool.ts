// The runner pool's books (Build 11 P1, src/runner-pool.ts): every CI job it has seen, where it ran and when it ended.
import type { Store } from '../db.ts';

export type PoolRow = {
  repo: string;
  job_id: number;
  run_id: number;
  project_id: number | null;
  name: string;
  /** JSON array of the job's labels. */
  labels: string;
  size: number;
  ship: number;
  first_seen: number;
  placed_machine: number | null;
  placed_at: number | null;
  runner: string | null;
  ran_on: number | null;
  started_at: number | null;
  ended_at: number | null;
};

/** One look's changes, written together. */
export type PoolLook = {
  /** Jobs seen for the first time, or again after the pool thought they ended (their row opens again, the rest as it was). */
  seen: Pick<PoolRow, 'repo' | 'job_id' | 'run_id' | 'project_id' | 'name' | 'labels' | 'size' | 'ship' | 'first_seen'>[];
  /** Jobs a runner took: which, on which machine (null: none Citadel knows), since when. */
  ran: { repo: string; job_id: number; runner: string; ran_on: number | null; started_at: number }[];
  /** Jobs the pool would start (P1) or started on a machine at `at`: the newest place each. */
  placed: { repo: string; job_id: number; machine: number }[];
  /** Jobs that ended (or went) at `at`. */
  ended: { repo: string; job_id: number }[];
  at: number;
};

export const poolQueries = {
  poolLook(this: Store, look: PoolLook) {
    const nested = this.db.isTransaction;
    if (!nested) this.db.exec('BEGIN');
    try {
      const seen = this.db.prepare('INSERT INTO pool_jobs (repo, job_id, run_id, project_id, name, labels, size, ship, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (repo, job_id) DO UPDATE SET ended_at = NULL');
      for (const r of look.seen) seen.run(r.repo, r.job_id, r.run_id, r.project_id, r.name, r.labels, r.size, r.ship, r.first_seen);
      const ran = this.db.prepare('UPDATE pool_jobs SET runner = ?, ran_on = ?, started_at = COALESCE(started_at, ?) WHERE repo = ? AND job_id = ?');
      for (const r of look.ran) ran.run(r.runner, r.ran_on, r.started_at, r.repo, r.job_id);
      const placed = this.db.prepare('UPDATE pool_jobs SET placed_machine = ?, placed_at = ? WHERE repo = ? AND job_id = ?');
      for (const r of look.placed) placed.run(r.machine, look.at, r.repo, r.job_id);
      const ended = this.db.prepare('UPDATE pool_jobs SET ended_at = ? WHERE repo = ? AND job_id = ? AND ended_at IS NULL');
      for (const r of look.ended) ended.run(look.at, r.repo, r.job_id);
      if (!nested) this.db.exec('COMMIT');
    } catch (err) {
      if (!nested)
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* no transaction was open */
        }
      throw err;
    }
  },
  /** The jobs not ended yet: what the pool picks up again after a restart. */
  poolOpen(this: Store): PoolRow[] {
    return this.db.prepare('SELECT * FROM pool_jobs WHERE ended_at IS NULL').all() as PoolRow[];
  },
  /** Each scheme's last start, and the machine its newest started job ran on (its warm folder). */
  poolLastStarts(this: Store): { project_id: number; at: number; machine: number | null }[] {
    return this.db
      .prepare(
        `SELECT project_id, started_at AS at, ran_on AS machine FROM (
           SELECT project_id, started_at, ran_on, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY started_at DESC) AS n
           FROM pool_jobs WHERE project_id IS NOT NULL AND started_at IS NOT NULL)
         WHERE n = 1`,
      )
      .all() as { project_id: number; at: number; machine: number | null }[];
  },
};
