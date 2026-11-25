// Releases, app deploys and what shipped (#1313: src/db.ts by area).
import type { ContraptionDeployRow, ReleaseRow, TicketKind } from '../db-rows.ts';
import type { Store } from '../db.ts';

export const releaseQueries = {
  /** A scheme's releases of one target started or live since `since`, oldest first (#1123). */
  releasesSince(this: Store, projectId: number, target: string, since: number): ReleaseRow[] {
    return this.db.prepare('SELECT * FROM releases WHERE project_id = ? AND target = ? AND coalesce(live_at, started_at) >= ? ORDER BY id').all(projectId, target, since) as unknown as ReleaseRow[];
  },

  /** Every scheme's releases that went live since `since`, with a start (#1132). */
  liveReleasesSince(this: Store, since: number): ReleaseRow[] {
    return this.db.prepare("SELECT * FROM releases WHERE outcome = 'live' AND live_at >= ? AND started_at IS NOT NULL ORDER BY id").all(since) as unknown as ReleaseRow[];
  },

  /** Every app's deploys that went live since `since`, with their stages (#1132). */
  deployedSince(this: Store, since: number): ContraptionDeployRow[] {
    return this.db.prepare("SELECT * FROM contraption_deploys WHERE outcome = 'deployed' AND finished_at >= ? ORDER BY id").all(since) as unknown as ContraptionDeployRow[];
  },

  /** An app's deploys started since `since`, oldest first (#1123). */
  appDeploysSince(this: Store, name: string, since: number): { started_at: number; finished_at: number | null; outcome: string; to_sha: string | null; by: string }[] {
    return this.db.prepare('SELECT started_at, finished_at, outcome, to_sha, by FROM contraption_deploys WHERE name = ? AND started_at >= ? ORDER BY started_at, id').all(name, since) as unknown as { started_at: number; finished_at: number | null; outcome: string; to_sha: string | null; by: string }[];
  },

  /** Bug minions of every scheme created since `since`, with their brief's first 4,000 characters: the third-fix flag's pool (#1157). */
  bugBriefs(this: Store, since: number): { project_id: number; number: number; title: string; at: number; brief: string }[] {
    return this.db
      .prepare(`SELECT k.project_id, k.number, k.title, k.created_at AS at,
          coalesce((SELECT substr(json_extract(e.data, '$.text'), 1, 4000) FROM events e WHERE e.ticket_id = k.id AND e.kind = 'user_message' ORDER BY e.id LIMIT 1), '') AS brief
        FROM tickets k JOIN properties p ON p.target_type = 'minion' AND p.target_id = k.id JOIN property_keys pk ON pk.id = p.key_id AND pk.key = 'type'
        WHERE k.created_at >= ? AND k.kind != 'coordinator' AND k.number IS NOT NULL AND p.value = 'bug'`)
      .all(since) as unknown as { project_id: number; number: number; title: string; at: number; brief: string }[];
  },

  /** The "Shipped …" notes posted at or after `since`, newest first, each with its minion's scheme, number and title: Home's "Shipped since your last visit" (#1140). A push that failed isn't one; one waiting for the restart is (main has it).
   * `ids`, [from, to): only the notes of those event ids, `since` aside: Home's paced first read, a range at a time (#1414). */
  shippedNotes(this: Store, since: number, ids?: [number, number]): { ticket_id: number; project_id: number; number: number | null; kind: TicketKind; title: string; text: string; at: number }[] {
    return this.db
      .prepare(`SELECT e.ticket_id, t.project_id, t.number, t.kind, t.title, json_extract(e.data, '$.text') AS text, e.created_at AS at
      FROM events e JOIN tickets t ON t.id = e.ticket_id WHERE e.id >= ? AND e.id < ? AND e.kind = 'note' AND e.data LIKE '{"text":"Shipped %'
      AND e.data NOT LIKE '%not pushed to origin: the push failed.%' ORDER BY e.id DESC`)
      .all(...(ids ?? [this.eventIdAt(since), Number.MAX_SAFE_INTEGER])) as ReturnType<Store['shippedNotes']>;
  },

  /** Every ship note ("Shipped …", "Merged …") posted at or after `since`, with its scheme (#1196): ship-risk's input. */
  shipNotesSince(this: Store, since: number): { project_id: number; created_at: number; text: string }[] {
    const rows = this.db
      .prepare(`SELECT t.project_id, e.created_at, e.data FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE e.id >= ? AND e.created_at >= ? AND e.kind = 'note' AND (e.data LIKE '{"text":"Shipped %' OR e.data LIKE '{"text":"Merged %') ORDER BY e.id`)
      .all(this.eventIdAt(since), since) as { project_id: number; created_at: number; data: string }[];
    return rows.map((r) => ({ project_id: Number(r.project_id), created_at: Number(r.created_at), text: String(JSON.parse(r.data).text ?? '') }));
  },

  /** Record a release of a scheme's target (src/releases.ts). */
  addRelease(this: Store, r: Omit<ReleaseRow, 'id'>): number {
    return Number(this.db.prepare('INSERT INTO releases (project_id, target, version, changes, started_at, live_at, outcome, stages) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(r.project_id, r.target, r.version, r.changes, r.started_at, r.live_at, r.outcome, r.stages).lastInsertRowid);
  },

  /** Record a finished contraption deploy (src/release-readers.ts). */
  addContraptionDeploy(this: Store, r: Omit<ContraptionDeployRow, 'id'>): number {
    return Number(this.db.prepare('INSERT INTO contraption_deploys (name, from_sha, to_sha, by, started_at, finished_at, outcome, stages, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(r.name, r.from_sha, r.to_sha, r.by, r.started_at, r.finished_at, r.outcome, r.stages, r.changes).lastInsertRowid);
  },

  /** A contraption's newest deploys (only those that ended as `outcome`, when given), newest first. */
  listContraptionDeploys(this: Store, name: string, limit: number, outcome?: string): ContraptionDeployRow[] {
    return (outcome ? this.db.prepare('SELECT * FROM contraption_deploys WHERE name = ? AND outcome = ? ORDER BY id DESC LIMIT ?').all(name, outcome, limit) : this.db.prepare('SELECT * FROM contraption_deploys WHERE name = ? ORDER BY id DESC LIMIT ?').all(name, limit)) as unknown as ContraptionDeployRow[];
  },

  /**
   * How many releases a contraption has had, its newest deploy's number: its deploys that went live, plus the one it
   * served before its first recorded deploy (that deploy started from a commit), so numbers don't move once recording began.
   */
  contraptionReleases(this: Store, name: string): number {
    return (
      this.db
        .prepare(`SELECT (SELECT COUNT(*) FROM contraption_deploys WHERE name = ? AND outcome = 'deployed')
      + COALESCE((SELECT from_sha IS NOT NULL FROM contraption_deploys WHERE name = ? ORDER BY id LIMIT 1), 0) AS n`)
        .get(name, name) as { n: number }
    ).n;
  },

  /** How many releases a target has recorded: its newest one's release number. */
  countReleases(this: Store, projectId: number, target: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM releases WHERE project_id = ? AND target = ?').get(projectId, target) as { n: number }).n;
  },

  /** A target's newest releases, newest first. */
  listReleases(this: Store, projectId: number, target: string, limit: number): ReleaseRow[] {
    return this.db.prepare('SELECT * FROM releases WHERE project_id = ? AND target = ? ORDER BY id DESC LIMIT ?').all(projectId, target, limit) as unknown as ReleaseRow[];
  },
};
