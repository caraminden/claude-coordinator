// Health events and host samples (#1313: src/db.ts by area).
import { HEALTH_KEEP_MS, HEALTH_MAX_ROWS, HOST_SAMPLE_KEEP_MS, type HostSample } from '../db-rows.ts';
import type { BoxReading } from '../box-capacity.ts';
import type { Store } from '../db.ts';

export const healthQueries = {
  /** Health readings of these kinds since `since`, oldest first (#1123, the Status page). */
  healthEventsSince(this: Store, kinds: string[], since: number): { kind: string; at: number; commit_sha: string | null; detail: string }[] {
    return this.db.prepare(`SELECT kind, at, commit_sha, detail FROM health_events WHERE kind IN (${kinds.map(() => '?').join(', ')}) AND at >= ? ORDER BY at`).all(...kinds, since) as unknown as { kind: string; at: number; commit_sha: string | null; detail: string }[];
  },

  /** One reading of perigee's memory, disk and load (#1123); drops readings past HOST_SAMPLE_KEEP_MS. */
  addHostSample(this: Store, s: HostSample) {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO host_samples (at, mem_total, mem_avail, disk_total, disk_free, load1, rss, cpu_psi, mem_psi, io_psi, swap_used, cpu_ledger, answer_time, db_cached, db_size, kswapd_rate, refault_rate, server_refault_rate, pgpgin_rate, thp_fallback_rate, warm_ms, warm_mb, warm_backoffs, open_fds, supervisors, tmp_used, app_mem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        s.at,
        s.mem_total,
        s.mem_avail,
        s.disk_total,
        s.disk_free,
        s.load1,
        s.rss,
        s.cpu_psi ?? null,
        s.mem_psi ?? null,
        s.io_psi ?? null,
        s.swap_used ?? null,
        s.cpu_ledger ?? null,
        s.answer_time ?? null,
        s.db_cached ?? null,
        s.db_size ?? null,
        s.kswapd_rate ?? null,
        s.refault_rate ?? null,
        s.server_refault_rate ?? null,
        s.pgpgin_rate ?? null,
        s.thp_fallback_rate ?? null,
        s.warm_ms ?? null,
        s.warm_mb ?? null,
        s.warm_backoffs ?? null,
        s.open_fds ?? null,
        s.supervisors ?? null,
        s.tmp_used ?? null,
        s.app_mem ?? null,
      );
    this.db.prepare('DELETE FROM host_samples WHERE at < ?').run(s.at - HOST_SAMPLE_KEEP_MS);
  },

  hostSamples(this: Store, since: number): HostSample[] {
    return this.db.prepare('SELECT * FROM host_samples WHERE at >= ? ORDER BY at').all(since) as unknown as HostSample[];
  },

  /** The readings since `since` that counted the turns running, oldest first (src/box-capacity.ts). */
  boxReadings(this: Store, since: number): BoxReading[] {
    return this.db
      .prepare(
        `SELECT at, json_extract(answer_time, '$.turns') AS turns, round(load1, 1) AS load, round(100 * (1 - mem_avail / CAST(mem_total AS REAL)), 1) AS used, round(mem_psi, 1) AS stall
         FROM host_samples WHERE at >= ? AND json_valid(answer_time) AND json_type(answer_time, '$.turns') = 'integer' ORDER BY at`,
      )
      .all(since) as unknown as BoxReading[];
  },

  /** Record a health reading (#724); every 100th insert also drops rows past HEALTH_KEEP_MS and HEALTH_MAX_ROWS. */
  addHealthEvent(this: Store, kind: string, at: number, commit: string | null, detail: string) {
    const { id } = this.db.prepare('INSERT INTO health_events (kind, at, commit_sha, detail) VALUES (?, ?, ?, ?) RETURNING id').get(kind, at, commit, detail.slice(0, 1000)) as { id: number };
    if (Number(id) % 100 === 0) {
      this.db.prepare('DELETE FROM health_events WHERE at < ?').run(at - HEALTH_KEEP_MS);
      // Boots, slow-ship nudges, Investigate clicks and looks (#1273) are few and the Status page and the once-a-day rule need them: only the time keep drops them.
      this.db.prepare("DELETE FROM health_events WHERE id <= ? AND kind NOT IN ('boot', 'live', 'stop', 'ship-slow', 'investigate', 'look')").run(Number(id) - HEALTH_MAX_ROWS);
    }
  },

  /** The readings in [from, to), oldest first, at most `limit`, of `kinds` only if given: an incident's timeline (#1145). */
  healthBetween(this: Store, from: number, to: number, limit: number, kinds?: string[]): { at: number; kind: string; commit_sha: string | null; detail: string }[] {
    const only = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : '';
    return this.db.prepare(`SELECT at, kind, commit_sha, detail FROM health_events WHERE at >= ? AND at < ?${only} ORDER BY at, id LIMIT ?`).all(from, to, ...(kinds ?? []), limit) as { at: number; kind: string; commit_sha: string | null; detail: string }[];
  },

  /** The newest `kind` reading before `before` (#1135: the last stall before a watchdog restart), or null. */
  lastHealthEvent(this: Store, kind: string, before: number): { at: number; detail: string } | null {
    return (this.db.prepare('SELECT at, detail FROM health_events WHERE kind = ? AND at < ? ORDER BY at DESC LIMIT 1').get(kind, before) as { at: number; detail: string } | undefined) ?? null;
  },
};
