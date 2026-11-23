// The log of a contraption's Stop and Restart runs (#1682): who ran it, the risk it carried, the result.
import type { Store } from '../db.ts';

export type ContraptionRun = { id: number; contraption_id: number; at: number; action: string; risk: string; by: string; ok: number; said: string };

export const contraptionRunQueries = {
  addContraptionRun(this: Store, r: Omit<ContraptionRun, 'id'>) {
    this.db.prepare('INSERT INTO contraption_runs (contraption_id, at, action, risk, by, ok, said) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.contraption_id, r.at, r.action, r.risk, r.by, r.ok, r.said);
  },
  /** Its newest runs, newest first. */
  contraptionRuns(this: Store, contraptionId: number, limit = 10): ContraptionRun[] {
    return this.db.prepare('SELECT * FROM contraption_runs WHERE contraption_id = ? ORDER BY id DESC LIMIT ?').all(contraptionId, limit) as unknown as ContraptionRun[];
  },
};
