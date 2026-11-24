// Pauses over 2 s a person's page noticed (#1752, public/slow-moments.js): a request, opening Citadel, or a frozen
// tab, and where the time went. Small rows, the newest SLOW_KEEP kept, shown on the Status page.
import type { Store } from '../db.ts';

export const SLOW_KEEP = 500;

export type SlowMoment = {
  id: number; at: number; person: string; device: string; tab: string;
  /** 'request', 'open' (opening a page inside Citadel), 'load' (opening Citadel) or 'freeze' (the tab blocked with nothing asked). */
  kind: string;
  /** The request (`GET /api/projects/2`; for an opening, its slowest), or '' for a load, a freeze or an opening with none. */
  what: string;
  /** The page's address then (`#/p/2/t/394`), and its scheme when it names one. */
  page: string; project_id: number | null;
  total_ms: number; server_ms: number | null; network_ms: number; tab_ms: number;
};

export const slowMomentQueries = {
  /** One page's report, then everything older than the newest SLOW_KEEP dropped. */
  addSlowMoments(this: Store, rows: Omit<SlowMoment, 'id'>[]) {
    const add = this.db.prepare('INSERT INTO slow_moments (at, person, device, tab, kind, what, page, project_id, total_ms, server_ms, network_ms, tab_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const nested = this.db.isTransaction;
    if (!nested) this.db.exec('BEGIN');
    try {
      for (const r of rows) add.run(r.at, r.person, r.device, r.tab, r.kind, r.what, r.page, r.project_id, r.total_ms, r.server_ms, r.network_ms, r.tab_ms);
      this.db.prepare('DELETE FROM slow_moments WHERE id <= (SELECT MAX(id) FROM slow_moments) - ?').run(SLOW_KEEP);
      if (!nested) this.db.exec('COMMIT');
    } catch (err) {
      if (!nested) try { this.db.exec('ROLLBACK'); } catch { /* no transaction was open */ }
      throw err;
    }
  },
  /** The newest since `since`, newest first. */
  slowMoments(this: Store, since: number, limit = 30): SlowMoment[] {
    return this.db.prepare('SELECT * FROM slow_moments WHERE at >= ? ORDER BY at DESC LIMIT ?').all(since, limit) as unknown as SlowMoment[];
  },
};
