// Artifacts: files people were shown, their pins and data, CI files and APK publishes (#1313: src/db.ts by area).
import type { Artifact, ArtifactDatum, CiFile, SharedPin, Ticket, TicketKind } from '../db-rows.ts';
import type { Store } from '../db.ts';

export const artifactQueries = {
  /** A project's artifacts, newest first, with the title of the ticket that made each. */
  listArtifacts(this: Store, projectId: number): (Artifact & { ticket_title: string; ticket_kind: TicketKind; ticket_number: number | null })[] {
    return this.db
      .prepare(
        `SELECT a.*, t.title AS ticket_title, t.kind AS ticket_kind, t.number AS ticket_number FROM artifacts a JOIN tickets t ON t.id = a.ticket_id
         WHERE a.project_id = ? ORDER BY a.mtime DESC`,
      )
      .all(projectId) as unknown as (Artifact & { ticket_title: string; ticket_kind: TicketKind; ticket_number: number | null })[];
  },

  /** Drop artifact rows whose path `keep` rejects. */
  pruneArtifacts(this: Store, keep: (path: string) => boolean) {
    const rows = this.db.prepare('SELECT id, path FROM artifacts').all() as { id: number; path: string }[];
    const del = this.db.prepare('DELETE FROM artifacts WHERE id = ?');
    for (const r of rows) if (!keep(r.path)) del.run(r.id);
  },

  /** A ticket's artifact row for any of the given paths. */
  findArtifact(this: Store, ticketId: number, paths: string[]): Artifact | undefined {
    const q = this.db.prepare('SELECT * FROM artifacts WHERE ticket_id = ? AND path = ?');
    for (const p of paths) {
      const a = q.get(ticketId, p) as unknown as Artifact | undefined;
      if (a) return a;
    }
    return undefined;
  },

  /**
   * The newest artifact row of a scheme for any of the given paths: the minion that last started linking that file.
   * shortcut: a minion that links the file again keeps its first created_at, so a later linker wins; track the latest link if that misroutes answers.
   */
  latestArtifact(this: Store, projectId: number, paths: string[]): Artifact | undefined {
    const q = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND path = ? ORDER BY created_at DESC, id DESC LIMIT 1');
    const rows = paths.map((p) => q.get(projectId, p) as unknown as Artifact | undefined).filter((a) => a !== undefined);
    return rows.sort((a, b) => b.created_at - a.created_at || b.id - a.id)[0];
  },

  getArtifact(this: Store, id: number): Artifact | undefined {
    return this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as unknown as Artifact | undefined;
  },

  setArtifactPinned(this: Store, id: number, by: string | null) {
    this.db.prepare('UPDATE artifacts SET pinned_at = ?, pinned_by = ? WHERE id = ?').run(by ? Date.now() : null, by, id);
    // Unpinning a file that is already gone leaves nothing worth showing.
    if (!by) this.db.prepare('DELETE FROM artifacts WHERE id = ? AND missing = 1').run(id);
  },

  pinnedArtifactPaths(this: Store, ticketId: number): string[] {
    return (this.db.prepare('SELECT path FROM artifacts WHERE ticket_id = ? AND pinned_at IS NOT NULL').all(ticketId) as { path: string }[]).map((r) => r.path);
  },

  /** Record an upload; the same run, attempt and name again replaces its row (and is no longer published). */
  putCiFile(this: Store, f: Omit<CiFile, 'id' | 'published_to' | 'published_at'>): CiFile {
    return this.db
      .prepare(
        `INSERT INTO ci_files (project_id, workflow, run_id, run_attempt, sha, ref, name, kind, target, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, workflow, run_id, run_attempt, name) DO UPDATE SET sha = excluded.sha, ref = excluded.ref, kind = excluded.kind, target = excluded.target,
           size = excluded.size, sha256 = excluded.sha256, created_at = excluded.created_at, published_to = NULL, published_at = NULL
         RETURNING *`,
      )
      .get(f.project_id, f.workflow, f.run_id, f.run_attempt, f.sha, f.ref, f.name, f.kind, f.target, f.size, f.sha256, f.created_at) as unknown as CiFile;
  },

  getCiFile(this: Store, id: number): CiFile | undefined {
    return this.db.prepare('SELECT * FROM ci_files WHERE id = ?').get(id) as unknown as CiFile | undefined;
  },

  /** The CI store's files, newest first: every scheme's, or one's. */
  ciFiles(this: Store, projectId?: number): CiFile[] {
    const where = projectId === undefined ? '' : 'WHERE project_id = ?';
    return this.db.prepare(`SELECT * FROM ci_files ${where} ORDER BY created_at DESC, id DESC`).all(...(projectId === undefined ? [] : [projectId])) as unknown as CiFile[];
  },

  deleteCiFile(this: Store, id: number) {
    this.db.prepare('DELETE FROM ci_files WHERE id = ?').run(id);
  },

  /** A file was copied to `to` (a contraption's feed): the newest one published there is never swept. */
  publishCiFile(this: Store, id: number, to: string) {
    this.db.prepare('UPDATE ci_files SET published_to = ?, published_at = ? WHERE id = ?').run(to, Date.now(), id);
  },

  /** A contraption's Android build was published into its feed (#663). */
  recordApkPublish(this: Store, r: { projectId: number; contraption: string; versionCode: number; runId: number; by: string; uid: number | null }) {
    this.db.prepare('INSERT INTO apk_publishes (project_id, contraption, version_code, run_id, published_by, uid, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.projectId, r.contraption, r.versionCode, r.runId, r.by, r.uid, Date.now());
  },

  /** The newest Android build Citadel published into a contraption's feed (#764: what the next release counts from). */
  lastApkPublish(this: Store, projectId: number, contraption: string): { version_code: number; run_id: number } | null {
    return (this.db.prepare('SELECT version_code, run_id FROM apk_publishes WHERE project_id = ? AND contraption = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(projectId, contraption) as { version_code: number; run_id: number } | undefined) ?? null;
  },

  /** Pins on files of a project's shared folder, by path relative to it. Kept while the file is gone, like an artifact's. */
  sharedPins(this: Store, projectId: number): SharedPin[] {
    return this.db.prepare('SELECT path, pinned_at, pinned_by FROM shared_pins WHERE project_id = ?').all(projectId) as unknown as SharedPin[];
  },

  setSharedPin(this: Store, projectId: number, path: string, by: string | null) {
    if (by) this.db.prepare('INSERT INTO shared_pins (project_id, path, pinned_at, pinned_by) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(projectId, path, Date.now(), by);
    else this.db.prepare('DELETE FROM shared_pins WHERE project_id = ? AND path = ?').run(projectId, path);
  },

  /** What an HTML page saved through the artifact bridge, oldest key first; values still JSON text. */
  artifactData(this: Store, projectId: number, file: string): ArtifactDatum[] {
    return this.db.prepare('SELECT key, value, by, at FROM artifact_data WHERE project_id = ? AND file = ? ORDER BY at, key').all(projectId, file) as unknown as ArtifactDatum[];
  },

  /** Set (JSON text) or delete (null) keys of a page's store, all or none. */
  writeArtifactData(this: Store, projectId: number, file: string, entries: { key: string; value: string | null }[], by: string) {
    const set = this.db.prepare('INSERT INTO artifact_data (project_id, file, key, value, by, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value, by = excluded.by, at = excluded.at');
    const del = this.db.prepare('DELETE FROM artifact_data WHERE project_id = ? AND file = ? AND key = ?');
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const e of entries) {
        if (e.value === null) del.run(projectId, file, e.key);
        else set.run(projectId, file, e.key, e.value, by, now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  /** Bring a ticket's artifact rows in line with what is on disk. Returns whether anything changed. */
  async syncArtifacts(this: Store, ticket: Ticket, found: { path: string; size: number; mtime: number }[]): Promise<boolean> {
    const existing = new Map((this.db.prepare('SELECT * FROM artifacts WHERE ticket_id = ?').all(ticket.id) as unknown as Artifact[]).map((a) => [a.path, a]));
    let changed = false;
    const insert = this.db.prepare('INSERT INTO artifacts (project_id, ticket_id, path, size, mtime, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const update = this.db.prepare('UPDATE artifacts SET size = ?, mtime = ?, missing = 0 WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const f of found) {
        const a = existing.get(f.path);
        existing.delete(f.path);
        if (!a) insert.run(ticket.project_id, ticket.id, f.path, f.size, f.mtime, Date.now());
        else if (a.size !== f.size || a.mtime !== f.mtime || a.missing) update.run(f.size, f.mtime, a.id);
        else continue;
        changed = true;
      }
      for (const a of existing.values()) {
        if (a.pinned_at === null) this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(a.id);
        else if (!a.missing) this.db.prepare('UPDATE artifacts SET missing = 1 WHERE id = ?').run(a.id);
        else continue;
        changed = true;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return changed;
  },
};
