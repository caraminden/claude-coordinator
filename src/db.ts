import { DatabaseSync } from 'node:sqlite';

export type TicketStatus = 'new' | 'running' | 'idle' | 'error' | 'closed';
/** Each project has one long-lived coordinator ticket that manages the others. */
export type TicketKind = 'ticket' | 'coordinator';

export interface Project {
  id: number;
  name: string;
  repo_url: string | null;
  repo_dir: string | null;
  created_at: number;
}

/** Models a thread can be set to (null = Claude Code's default), and effort levels for `claude --effort`. */
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const TICKET_TAGS = ['feature', 'bug', 'design', 'process', 'idea'] as const;
export type TicketTag = (typeof TICKET_TAGS)[number];
/** ready: done, ready to merge or pick up · try: ready for people to try · parked: on hold on purpose ·
 * blocked: stuck on something outside the thread · outside: work still running elsewhere (CI, someone's machine). */
export const TICKET_STATES = ['ready', 'try', 'parked', 'blocked', 'outside'] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export interface Ticket {
  id: number;
  project_id: number;
  number: number | null; // shown as #n; counts up per project, null for the coordinator
  tag: TicketTag | null; // what kind of work, for grouping the threads list
  state: TicketState | null; // set by the thread at the end of a turn; cleared when the next turn starts
  note: string | null; // the thread's own one-line status, ≤ 60 chars
  kind: TicketKind;
  title: string;
  status: TicketStatus;
  session_id: string | null;
  cwd: string;
  branch: string | null;
  permission_mode: string;
  /** Chosen for this thread; null uses Claude Code's default. */
  model: string | null;
  effort: string | null;
  /** What Claude Code's defaults came out as on this thread's latest turn without a choice. */
  last_model: string | null;
  last_effort: string | null;
  last_activity: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface Artifact {
  id: number;
  project_id: number;
  ticket_id: number;
  path: string;
  size: number;
  mtime: number;
  created_at: number;
  pinned_at: number | null;
  pinned_by: string | null;
  /** A pinned file that has since disappeared; kept so the pin isn't silently lost. */
  missing: number;
}

/** A file of Claude Code session state, gzipped; `path` is relative to the Claude config dir. */
export interface ClaudeStateRow {
  path: string;
  project_id: number;
  /** Null for state the whole project shares (auto-memory). */
  ticket_id: number | null;
  size: number;
  mtime: number;
  data?: Uint8Array;
}

export interface EventRow {
  id: number;
  ticket_id: number;
  kind: string;
  data: string;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  repo_url TEXT,
  repo_dir TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'ticket',
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT NOT NULL,
  branch TEXT,
  permission_mode TEXT NOT NULL,
  last_activity TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket_id, id);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  pinned_at INTEGER,
  pinned_by TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ticket_id, path)
);
CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id, mtime);
CREATE TABLE IF NOT EXISTS claude_state (
  path TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  ticket_id INTEGER REFERENCES tickets(id),
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS claude_state_owner ON claude_state(project_id, ticket_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Columns added after the first release, for databases created before them. */
const MIGRATIONS: [table: string, column: string, ddl: string][] = [
  ['tickets', 'kind', "ALTER TABLE tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'ticket'"],
  ['tickets', 'number', 'ALTER TABLE tickets ADD COLUMN number INTEGER'],
  ['tickets', 'tag', 'ALTER TABLE tickets ADD COLUMN tag TEXT'],
  ['tickets', 'state', 'ALTER TABLE tickets ADD COLUMN state TEXT'],
  ['tickets', 'note', 'ALTER TABLE tickets ADD COLUMN note TEXT'],
  ['tickets', 'model', 'ALTER TABLE tickets ADD COLUMN model TEXT'],
  ['tickets', 'effort', 'ALTER TABLE tickets ADD COLUMN effort TEXT'],
  ['tickets', 'last_model', 'ALTER TABLE tickets ADD COLUMN last_model TEXT'],
  ['tickets', 'last_effort', 'ALTER TABLE tickets ADD COLUMN last_effort TEXT'],
];

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    for (const [table, column, ddl] of MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.exec(ddl);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_coordinator ON tickets(project_id) WHERE kind = 'coordinator'");
    this.numberTickets();
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ticket_number ON tickets(project_id, number)');
  }

  /**
   * Tickets used to be numbered by their global id. Give each project its own 1, 2, 3… in
   * creation order, and leave a note in every thread whose number changed.
   */
  private numberTickets() {
    const unnumbered = this.db
      .prepare("SELECT id, project_id FROM tickets WHERE kind = 'ticket' AND number IS NULL ORDER BY id")
      .all() as { id: number; project_id: number }[];
    if (!unnumbered.length) return;
    const changed = new Map<number, string[]>(); // project_id -> "#old is now #new"
    this.db.exec('BEGIN');
    try {
      for (const { id, project_id } of unnumbered) {
        const number = this.nextNumber(project_id);
        this.db.prepare('UPDATE tickets SET number = ? WHERE id = ?').run(number, id);
        if (number === id) continue;
        this.addEvent(id, 'note', { text: `Threads are now numbered per project. This thread is now #${number} (it was #${id}).` });
        changed.set(project_id, [...(changed.get(project_id) ?? []), `#${id} → #${number}`]);
      }
      for (const [projectId, moves] of changed) {
        const coordinator = this.getCoordinator(projectId);
        if (coordinator) this.addEvent(coordinator.id, 'note', { text: `Threads are now numbered per project: ${moves.join(', ')}.` });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private nextNumber(projectId: number): number {
    const row = this.db.prepare('SELECT MAX(number) AS n FROM tickets WHERE project_id = ?').get(projectId) as { n: number | null };
    return (row.n ?? 0) + 1;
  }

  getTicketByNumber(projectId: number, number: number): Ticket | undefined {
    return this.db.prepare('SELECT * FROM tickets WHERE project_id = ? AND number = ?').get(projectId, number) as unknown as Ticket | undefined;
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name').all() as unknown as Project[];
  }

  getProject(id: number): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Project | undefined;
  }

  createProject(name: string, repoUrl: string | null): Project {
    const r = this.db
      .prepare('INSERT INTO projects (name, repo_url, created_at) VALUES (?, ?, ?)')
      .run(name, repoUrl, Date.now());
    return this.getProject(Number(r.lastInsertRowid))!;
  }

  setProjectRepoDir(id: number, dir: string) {
    this.db.prepare('UPDATE projects SET repo_dir = ? WHERE id = ?').run(dir, id);
  }

  deleteProject(id: number) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /** All tickets in a project, including the coordinator. */
  listTickets(projectId: number): Ticket[] {
    return this.db
      .prepare('SELECT * FROM tickets WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as unknown as Ticket[];
  }

  getCoordinator(projectId: number): Ticket | undefined {
    return this.db
      .prepare("SELECT * FROM tickets WHERE project_id = ? AND kind = 'coordinator'")
      .get(projectId) as unknown as Ticket | undefined;
  }

  getTicket(id: number): Ticket | undefined {
    return this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as unknown as Ticket | undefined;
  }

  /** Insert a ticket with no working directory yet; call setTicketDir once it exists. */
  createTicket(t: Pick<Ticket, 'project_id' | 'title' | 'permission_mode' | 'created_by'> & { kind?: TicketKind; tag?: TicketTag | null }): Ticket {
    const now = Date.now();
    const kind = t.kind ?? 'ticket';
    const r = this.db
      .prepare(
        `INSERT INTO tickets (project_id, kind, number, tag, title, status, cwd, permission_mode, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'new', '', ?, ?, ?, ?)`,
      )
      .run(t.project_id, kind, kind === 'coordinator' ? null : this.nextNumber(t.project_id), t.tag ?? null, t.title, t.permission_mode, t.created_by, now, now);
    return this.getTicket(Number(r.lastInsertRowid))!;
  }

  setTicketDir(id: number, cwd: string, branch: string | null) {
    this.db.prepare('UPDATE tickets SET cwd = ?, branch = ? WHERE id = ?').run(cwd, branch, id);
  }

  deleteTicket(id: number) {
    this.db.prepare('DELETE FROM events WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM artifacts WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM claude_state WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  }

  /** Record what a ticket last ran with, without counting as activity (updated_at stays). */
  updateTicketQuietly(id: number, fields: Partial<Pick<Ticket, 'last_model' | 'last_effort'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  }

  updateTicket(id: number, fields: Partial<Pick<Ticket, 'status' | 'session_id' | 'last_activity' | 'title' | 'tag' | 'state' | 'note' | 'model' | 'effort' | 'last_model' | 'last_effort'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => fields[k] ?? null);
    this.db.prepare(`UPDATE tickets SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
  }

  /** Change a ticket's activity line without counting it as new activity. */
  setLastActivity(id: number, text: string) {
    this.db.prepare('UPDATE tickets SET last_activity = ? WHERE id = ?').run(text, id);
  }

  addEvent(ticketId: number, kind: string, data: unknown): EventRow {
    const now = Date.now();
    const json = JSON.stringify(data);
    const r = this.db
      .prepare('INSERT INTO events (ticket_id, kind, data, created_at) VALUES (?, ?, ?, ?)')
      .run(ticketId, kind, json, now);
    return { id: Number(r.lastInsertRowid), ticket_id: ticketId, kind, data: json, created_at: now };
  }

  /** A project's artifacts, newest first, with the title of the ticket that made each. */
  listArtifacts(projectId: number): (Artifact & { ticket_title: string; ticket_kind: TicketKind; ticket_number: number | null })[] {
    return this.db
      .prepare(
        `SELECT a.*, t.title AS ticket_title, t.kind AS ticket_kind, t.number AS ticket_number FROM artifacts a JOIN tickets t ON t.id = a.ticket_id
         WHERE a.project_id = ? ORDER BY a.mtime DESC`,
      )
      .all(projectId) as any;
  }

  /** Drop artifact rows whose path `keep` rejects. */
  pruneArtifacts(keep: (path: string) => boolean) {
    const rows = this.db.prepare('SELECT id, path FROM artifacts').all() as { id: number; path: string }[];
    const del = this.db.prepare('DELETE FROM artifacts WHERE id = ?');
    for (const r of rows) if (!keep(r.path)) del.run(r.id);
  }

  /** A ticket's artifact row for any of the given paths. */
  findArtifact(ticketId: number, paths: string[]): Artifact | undefined {
    const q = this.db.prepare('SELECT * FROM artifacts WHERE ticket_id = ? AND path = ?');
    for (const p of paths) {
      const a = q.get(ticketId, p) as unknown as Artifact | undefined;
      if (a) return a;
    }
    return undefined;
  }

    getArtifact(id: number): Artifact | undefined {
    return this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as unknown as Artifact | undefined;
  }

  setArtifactPinned(id: number, by: string | null) {
    this.db.prepare('UPDATE artifacts SET pinned_at = ?, pinned_by = ? WHERE id = ?').run(by ? Date.now() : null, by, id);
    // Unpinning a file that is already gone leaves nothing worth showing.
    if (!by) this.db.prepare('DELETE FROM artifacts WHERE id = ? AND missing = 1').run(id);
  }

  /** Bring a ticket's artifact rows in line with what is on disk. Returns whether anything changed. */
  syncArtifacts(ticket: Ticket, found: { path: string; size: number; mtime: number }[]): boolean {
    const existing = new Map(
      (this.db.prepare('SELECT * FROM artifacts WHERE ticket_id = ?').all(ticket.id) as unknown as Artifact[]).map((a) => [a.path, a]),
    );
    let changed = false;
    const insert = this.db.prepare(
      'INSERT INTO artifacts (project_id, ticket_id, path, size, mtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
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
  }

  /** Session state rows without their data: a ticket's own, or the project's shared ones (ticketId null). */
  listClaudeState(projectId: number, ticketId: number | null): ClaudeStateRow[] {
    return (ticketId === null
      ? this.db.prepare('SELECT path, project_id, ticket_id, size, mtime FROM claude_state WHERE project_id = ? AND ticket_id IS NULL').all(projectId)
      : this.db.prepare('SELECT path, project_id, ticket_id, size, mtime FROM claude_state WHERE project_id = ? AND ticket_id = ?').all(projectId, ticketId)
    ) as unknown as ClaudeStateRow[];
  }

  getClaudeState(path: string, withData = false): ClaudeStateRow | undefined {
    const cols = withData ? '*' : 'path, project_id, ticket_id, size, mtime';
    return this.db.prepare(`SELECT ${cols} FROM claude_state WHERE path = ?`).get(path) as unknown as ClaudeStateRow | undefined;
  }

  putClaudeState(row: Required<ClaudeStateRow>) {
    this.db
      .prepare(
        `INSERT INTO claude_state (path, project_id, ticket_id, size, mtime, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, ticket_id = excluded.ticket_id,
           size = excluded.size, mtime = excluded.mtime, data = excluded.data`,
      )
      .run(row.path, row.project_id, row.ticket_id, row.size, row.mtime, row.data);
  }

  deleteClaudeState(path: string) {
    this.db.prepare('DELETE FROM claude_state WHERE path = ?').run(path);
  }

  listEvents(ticketId: number, afterId = 0): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE ticket_id = ? AND id > ? ORDER BY id')
      .all(ticketId, afterId) as unknown as EventRow[];
  }

  /** Newest-first messages and Claude output in a project whose raw JSON contains the text (case-insensitive for ASCII). */
  findEvents(projectId: number, text: string, limit = 3000): EventRow[] {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare(`SELECT e.* FROM events e JOIN tickets t ON t.id = e.ticket_id
        WHERE t.project_id = ? AND e.kind IN ('user_message', 'claude') AND e.data LIKE ? ESCAPE '\\'
        ORDER BY e.id DESC LIMIT ?`)
      .all(projectId, like, limit) as unknown as EventRow[];
  }

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  setSetting(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
}
