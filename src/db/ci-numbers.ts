// Numbers a scheme's CI sends per run, and the steps up found in them (#1369, src/ci-numbers.ts).
import type { CiNumber, CiNumberStep, Store } from '../db.ts';

export const ciNumberQueries = {
  /** Record a run's numbers, in one commit; the same series and run again (a re-run attempt) replaces its value, keeping its place in time. */
  putCiNumbers(this: Store, rows: Omit<CiNumber, 'id'>[]) {
    const put = this.db.prepare(
      `INSERT INTO ci_numbers (project_id, name, value, unit, workflow, run_id, run_attempt, sha, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, name, run_id) DO UPDATE SET value = excluded.value, unit = excluded.unit, workflow = excluded.workflow,
         run_attempt = excluded.run_attempt, sha = excluded.sha, ref = excluded.ref`,
    );
    this.db.exec('BEGIN');
    try {
      for (const n of rows) put.run(n.project_id, n.name, n.value, n.unit, n.workflow, n.run_id, n.run_attempt, n.sha, n.ref, n.created_at);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  /** A scheme's numbers, oldest first: every series, or one's. */
  ciNumbers(this: Store, projectId: number, name?: string): CiNumber[] {
    const sql = `SELECT * FROM ci_numbers WHERE project_id = ? ${name === undefined ? '' : 'AND name = ?'} ORDER BY created_at, id`;
    return this.db.prepare(sql).all(...(name === undefined ? [projectId] : [projectId, name])) as unknown as CiNumber[];
  },

  /** One series' last `limit` runs on one ref, oldest first: what the step-up rule reads. */
  ciNumberRuns(this: Store, projectId: number, name: string, ref: string, limit: number): CiNumber[] {
    const rows = this.db.prepare('SELECT * FROM ci_numbers WHERE project_id = ? AND name = ? AND ref = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(projectId, name, ref, limit) as unknown as CiNumber[];
    return rows.reverse();
  },

  /** The ref most of a series' runs are on: the one its chart shows and its rule watches. */
  ciNumberMainRef(this: Store, projectId: number, name: string): string | null {
    const row = this.db.prepare('SELECT ref FROM ci_numbers WHERE project_id = ? AND name = ? GROUP BY ref ORDER BY COUNT(*) DESC, MAX(created_at) DESC LIMIT 1').get(projectId, name) as { ref: string } | undefined;
    return row?.ref ?? null;
  },

  /** The series names a scheme has. */
  ciNumberNames(this: Store, projectId: number): string[] {
    return (this.db.prepare('SELECT DISTINCT name FROM ci_numbers WHERE project_id = ?').all(projectId) as { name: string }[]).map((r) => r.name);
  },

  addCiNumberStep(this: Store, s: Omit<CiNumberStep, 'id'>) {
    this.db
      .prepare('INSERT INTO ci_number_steps (project_id, name, ref, run_id, sha, created_at, baseline, level, flagged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.project_id, s.name, s.ref, s.run_id, s.sha, s.created_at, s.baseline, s.level, s.flagged_at);
  },

  /** One series' steps on one ref since `since`, oldest first. */
  ciNumberStepsSince(this: Store, projectId: number, name: string, ref: string, since: number): CiNumberStep[] {
    return this.db.prepare('SELECT * FROM ci_number_steps WHERE project_id = ? AND name = ? AND ref = ? AND created_at >= ? ORDER BY created_at, id').all(projectId, name, ref, since) as unknown as CiNumberStep[];
  },

  /** A scheme's steps, oldest first: every series, or one's. */
  ciNumberSteps(this: Store, projectId: number, name?: string): CiNumberStep[] {
    const sql = `SELECT * FROM ci_number_steps WHERE project_id = ? ${name === undefined ? '' : 'AND name = ?'} ORDER BY created_at, id`;
    return this.db.prepare(sql).all(...(name === undefined ? [projectId] : [projectId, name])) as unknown as CiNumberStep[];
  },

  /** Drop numbers and steps older than `before`; the count of numbers dropped. */
  pruneCiNumbers(this: Store, before: number): number {
    this.db.prepare('DELETE FROM ci_number_steps WHERE created_at < ?').run(before);
    return Number(this.db.prepare('DELETE FROM ci_numbers WHERE created_at < ?').run(before).changes);
  },
};
