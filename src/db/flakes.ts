// Flake sightings, their errors (#1438, src/flake-evidence.ts) and fixes (#1313: src/db.ts by area).
import type { SQLInputValue } from 'node:sqlite';
import { FLAKE_KEEP_MS, type FlakeFix } from '../db-rows.ts';
import type { Store } from '../db.ts';

export const flakeQueries = {
  /** A file's most common error messages since `since` with their test, class and count, then how many sightings kept none (rows from before #1438, and runs whose log was gone: "no message kept"). */
  flakeMessages(this: Store, projectId: number, file: string, since: number, n = 3): { messages: { message: string; test: string; cls: string; count: number }[]; none: number } {
    const messages = this.db
      .prepare(`SELECT message, test_name AS test, class AS cls, COUNT(*) AS count FROM flake_events
      WHERE project_id = ? AND file = ? AND at >= ? AND message != '' GROUP BY message, test_name, class ORDER BY count DESC, MAX(at) DESC LIMIT ?`)
      .all(projectId, file, since, n) as { message: string; test: string; cls: string; count: number }[];
    const none = (this.db.prepare("SELECT COUNT(*) AS c FROM flake_events WHERE project_id = ? AND file = ? AND at >= ? AND message = ''").get(projectId, file, since) as { c: number }).c;
    return { messages, none };
  },

  /** Record the flakes of one run (#1063); rows older than FLAKE_KEEP_MS go with each write. */
  addFlakeEvents(this: Store, projectId: number, ticketId: number | null, commit: string | null, at: number, flakes: { file: string; source: string; detail: string; testName?: string; message?: string; cls?: string }[]) {
    const add = this.db.prepare('INSERT INTO flake_events (project_id, file, at, commit_sha, ticket_id, source, detail, test_name, message, class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const f of flakes) add.run(projectId, f.file.slice(0, 200), at, commit, ticketId, f.source.slice(0, 40), f.detail.slice(0, 1500), (f.testName ?? '').slice(0, 200), (f.message ?? '').slice(0, 600), (f.cls ?? '').slice(0, 40));
    if (flakes.length) this.db.prepare('DELETE FROM flake_events WHERE at < ?').run(at - FLAKE_KEEP_MS);
  },

  /** A scheme's flakiest test files since `since`: how often, when last, and the minion whose land saw the last one. */
  flakeCounts(this: Store, projectId: number, since: number, limit = 10): { file: string; count: number; last: number; ticketId: number | null }[] {
    return this.db
      .prepare(`SELECT file, COUNT(*) AS count, MAX(at) AS last,
        (SELECT e2.ticket_id FROM flake_events e2 WHERE e2.project_id = e.project_id AND e2.file = e.file ORDER BY e2.at DESC, e2.id DESC LIMIT 1) AS ticketId
      FROM flake_events e WHERE project_id = ? AND at >= ? GROUP BY file ORDER BY count DESC, last DESC LIMIT ?`)
      .all(projectId, since, limit) as { file: string; count: number; last: number; ticketId: number | null }[];
  },

  /** Whether `file` already has a sighting within `tolMs` of `at`: a retro-log line the server already counted from the land's own output. */
  hasFlakeNear(this: Store, projectId: number, file: string, at: number, tolMs: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM flake_events WHERE project_id = ? AND file = ? AND at BETWEEN ? AND ? LIMIT 1').get(projectId, file, at - tolMs, at + tolMs);
  },

  /** Sighting times of `file` since `since`, oldest first. */
  flakeSightings(this: Store, projectId: number, file: string, since: number): number[] {
    return (this.db.prepare('SELECT at FROM flake_events WHERE project_id = ? AND file = ? AND at >= ? ORDER BY at').all(projectId, file, since) as { at: number }[]).map((r) => r.at);
  },

  /** Files with a sighting since `since`. */
  flakeFiles(this: Store, projectId: number, since: number): string[] {
    return (this.db.prepare('SELECT DISTINCT file FROM flake_events WHERE project_id = ? AND at >= ?').all(projectId, since) as { file: string }[]).map((r) => r.file);
  },

  /** The newest fix of a file (#1120), or undefined. */
  flakeFix(this: Store, projectId: number, file: string): FlakeFix | undefined {
    return this.db.prepare('SELECT * FROM flake_fixes WHERE project_id = ? AND file = ? ORDER BY id DESC LIMIT 1').get(projectId, file) as FlakeFix | undefined;
  },

  flakeFixes(this: Store, projectId: number): FlakeFix[] {
    return this.db.prepare('SELECT * FROM flake_fixes WHERE project_id = ? ORDER BY id DESC').all(projectId) as unknown as FlakeFix[];
  },

  addFlakeFix(this: Store, projectId: number, file: string, ticketId: number | null, startedAt: number, patch: Partial<FlakeFix> = {}): number {
    const r = this.db.prepare('INSERT INTO flake_fixes (project_id, file, ticket_id, state, started_at, clean_runs, held_at, reopened) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(projectId, file, ticketId, patch.state ?? 'open', startedAt, patch.clean_runs ?? 0, patch.held_at ?? null, patch.reopened ?? 0);
    return Number(r.lastInsertRowid);
  },

  updateFlakeFix(this: Store, id: number, patch: Partial<Omit<FlakeFix, 'id' | 'project_id' | 'file'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE flake_fixes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] as SQLInputValue), id);
  },

  /** The newest `n` failing outputs kept for a file. */
  flakeDetails(this: Store, projectId: number, file: string, n = 3): { at: number; detail: string }[] {
    return this.db.prepare("SELECT at, detail FROM flake_events WHERE project_id = ? AND file = ? AND detail != '' ORDER BY at DESC, id DESC LIMIT ?").all(projectId, file, n) as { at: number; detail: string }[];
  },
};
