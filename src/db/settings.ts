// Settings writes that must land together (#1364: crash-only write order).
import type { Store } from '../db.ts';

export const settingQueries = {
  /** Settings set and deleted in one commit, so a crash between them can't leave half (#1364): `set`'s values, then `del`'s keys. */
  setSettings(this: Store, set: Record<string, unknown>, del: string[] = []) {
    const nested = this.db.isTransaction;
    if (!nested) this.db.exec('BEGIN');
    try {
      // Its own statements, not setSetting's: those may be wrapped (the write worker, a test's cuts) as writes of their own.
      const put = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value');
      const drop = this.db.prepare('DELETE FROM settings WHERE key = ?');
      for (const [k, v] of Object.entries(set)) put.run(k, JSON.stringify(v));
      for (const k of del) drop.run(k);
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
};
