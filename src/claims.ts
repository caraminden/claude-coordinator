// Claims (#921): a single-holder duty kept as a row, not a note in a Taskmaster's memory. The pipeline lane
// ("one minion at a time changes the land and deploy pipeline") is the first; any duty a scheme invents later
// uses the same three tools (claim, release, list_claims). Live state any Taskmaster in the scheme reads and
// takes, the Overlord's job once a scheme has one (specs/per-person-taskmasters-overlord.md).
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './http.ts';

export const CLAIMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  holder INTEGER NOT NULL,
  taken_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  since INTEGER NOT NULL,
  PRIMARY KEY (project_id, name)
);
CREATE INDEX IF NOT EXISTS claims_holder ON claims(holder);
`;

export interface Claim {
  project_id: number;
  /** A short slug, e.g. "pipeline-lane". */
  name: string;
  /** The ticket that holds it: a minion, or the Taskmaster that took it for itself. */
  holder: number;
  /** Who took it: the Taskmaster's turn person, or the person on the page. */
  taken_by: string;
  note: string;
  since: number;
}

/** "pipeline-lane", "release-train": lowercase words joined by hyphens, so two Taskmasters can't spell one duty two ways. */
export function claimName(raw: unknown): string {
  const name = String(raw ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 40) throw new HttpError(400, 'A claim name is lowercase words joined by hyphens, at most 40 characters, e.g. pipeline-lane');
  return name;
}

export class Claims {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(CLAIMS_SCHEMA);
  }

  list(projectId: number): Claim[] {
    return this.db.prepare('SELECT * FROM claims WHERE project_id = ? ORDER BY since, name').all(projectId) as unknown as Claim[];
  }

  get(projectId: number, name: string): Claim | undefined {
    return this.db.prepare('SELECT * FROM claims WHERE project_id = ? AND name = ?').get(projectId, name) as unknown as Claim | undefined;
  }

  /**
   * Take `name` for `holder`. Refused while another ticket holds it (the caller sees who); taking one
   * the same holder already has only updates its note. Returns the row.
   */
  take(projectId: number, name: string, holder: number, takenBy: string, note = '', now = Date.now()): { claim: Claim; held?: Claim } {
    const held = this.get(projectId, name);
    if (held && held.holder !== holder) return { claim: held, held };
    if (held) this.db.prepare('UPDATE claims SET note = ? WHERE project_id = ? AND name = ?').run(note, projectId, name);
    else this.db.prepare('INSERT INTO claims (project_id, name, holder, taken_by, note, since) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, name, holder, takenBy, note, now);
    return { claim: this.get(projectId, name)! };
  }

  /** Free `name`, whoever holds it (every member decides alike). The row it was, or undefined if nobody held it. */
  release(projectId: number, name: string): Claim | undefined {
    const held = this.get(projectId, name);
    if (held) this.db.prepare('DELETE FROM claims WHERE project_id = ? AND name = ?').run(projectId, name);
    return held;
  }

  /** Free everything `holder` holds (it was dismissed or deleted): the rows it held. */
  releaseHeldBy(holder: number): Claim[] {
    const rows = this.db.prepare('SELECT * FROM claims WHERE holder = ? ORDER BY name').all(holder) as unknown as Claim[];
    if (rows.length) this.db.prepare('DELETE FROM claims WHERE holder = ?').run(holder);
    return rows;
  }
}
