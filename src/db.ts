import { DatabaseSync } from 'node:sqlite';
import { Registry } from './properties.ts';

export type TicketStatus = 'new' | 'running' | 'idle' | 'error' | 'closed';
/** Each project has one long-lived coordinator ticket that manages the others. */
export type TicketKind = 'ticket' | 'coordinator';

export interface Project {
  id: number;
  name: string;
  repo_url: string | null;
  repo_dir: string | null;
  /** Standing rules every turn in the project gets, coordinator included; '' for none. */
  instructions: string;
  instructions_updated_by: string | null;
  instructions_updated_at: number | null;
  /** Claude Code permission rules, one per line, that make a thread ask people first; '' for none. */
  approval_rules: string;
  /** Folders in the repo, one per line, that each thread loads as Claude Code plugins; '' for none. */
  plugin_dirs: string;
  /** Effort for turns of minions (and a Taskmaster) with none of their own; '' leaves it to Claude Code. */
  default_effort: string;
  created_at: number;
}

/** Longest project instructions the app accepts, the same cap as Claude Code's own projects. */
export const MAX_INSTRUCTIONS = 16_000;

/** Models a thread can be set to (null = Claude Code's default), and effort levels for `claude --effort`. */
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const TICKET_TAGS = ['feature', 'bug', 'design', 'process', 'idea'] as const;
export type TicketTag = (typeof TICKET_TAGS)[number];
/** ready: done, ready to merge or pick up · try: ready for people to try · parked: on hold on purpose ·
 * blocked: stuck on something outside the thread · outside: work still running elsewhere (CI, someone's machine) ·
 * pending-deploy: deployed, not live yet; outlasts a new turn, and a successful deploy dismisses the thread ·
 * limited: the last turn hit the account's usage limit (set by the server, not the thread). */
export const TICKET_STATES = ['ready', 'try', 'parked', 'blocked', 'outside', 'pending-deploy', 'limited'] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export interface Ticket {
  id: number;
  project_id: number;
  number: number | null; // shown as #n; counts up per project, null for the coordinator
  tag: TicketTag | null; // what kind of work, for grouping the threads list
  state: TicketState | null; // set by the thread at the end of a turn; cleared when the next turn starts
  note: string | null; // the thread's own one-line status, ≤ 60 chars
  build: number | null; // the major build it is assigned to; the threads list groups by it
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

/** Someone's own computer, which connects out to the app and lends threads its MCP tools. */
export interface Machine {
  id: number;
  /** Also the MCP server name threads see, so its tools are mcp__<name>__*. */
  name: string;
  token_hash: string;
  created_by: string;
  created_at: number;
  /** When its agent last connected or disconnected; null if it never has. */
  last_seen_at: number | null;
  /** What threads should know when using it ("never restart it", where the clone is); '' for none. */
  notes: string;
  /** 1 when minions get the workspace tools its agent offers (git sync, its owner's tasks); off until a person turns it on. */
  workspace_tools: number;
}

/** One browser of one signed-in person that wants Web Push notifications (src/push.ts). */
export interface PushSubscriptionRow {
  id: number;
  name: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** JSON list of project ids this device doesn't want notifications from. */
  muted: string;
  created_at: number;
}

/**
 * One finished Claude turn's cost at API prices (what Claude Code reports, not a bill on a subscription).
 * Claude Code's `total_cost_usd` is the session's running total, carried over on --resume, so a turn's
 * own cost is the rise since the session's previous turn. Tokens are the turn's own (`usage`), and
 * null for turns from before they were kept.
 */
export interface Turn {
  id: number;
  ticket_id: number;
  /** The turn's stored result event, if any. */
  event_id: number | null;
  session_id: string | null;
  ended_at: number;
  cost_usd: number;
  session_cost_usd: number;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

/** What a turn's result event says, for Store.recordTurn. */
export interface TurnResult {
  event_id?: number | null;
  session_id?: string | null;
  ended_at: number;
  session_cost_usd: number;
  duration_ms?: number | null;
  usage?: any;
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
CREATE TABLE IF NOT EXISTS ticket_seen (
  name TEXT NOT NULL,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (name, ticket_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  workspace_tools INTEGER NOT NULL DEFAULT 0
);
-- Unused since #89: machines serve every scheme. Kept, rows and all, so scoping machines to schemes (#62) is cheap to bring back.
CREATE TABLE IF NOT EXISTS machine_projects (
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (machine_id, project_id)
);
CREATE TABLE IF NOT EXISTS github_seen (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  key TEXT NOT NULL,
  delivered INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, key)
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  event_id INTEGER,
  session_id TEXT,
  ended_at INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  session_cost_usd REAL NOT NULL,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS turns_ticket ON turns(ticket_id, id);
CREATE INDEX IF NOT EXISTS turns_ended ON turns(ended_at);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  muted TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
`;

/** Columns added after the first release, for databases created before them. */
const MIGRATIONS: [table: string, column: string, ddl: string][] = [
  ['tickets', 'kind', "ALTER TABLE tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'ticket'"],
  ['tickets', 'number', 'ALTER TABLE tickets ADD COLUMN number INTEGER'],
  ['tickets', 'tag', 'ALTER TABLE tickets ADD COLUMN tag TEXT'],
  ['tickets', 'state', 'ALTER TABLE tickets ADD COLUMN state TEXT'],
  ['tickets', 'note', 'ALTER TABLE tickets ADD COLUMN note TEXT'],
  ['tickets', 'build', 'ALTER TABLE tickets ADD COLUMN build INTEGER'],
  ['tickets', 'model', 'ALTER TABLE tickets ADD COLUMN model TEXT'],
  ['tickets', 'effort', 'ALTER TABLE tickets ADD COLUMN effort TEXT'],
  ['tickets', 'last_model', 'ALTER TABLE tickets ADD COLUMN last_model TEXT'],
  ['tickets', 'last_effort', 'ALTER TABLE tickets ADD COLUMN last_effort TEXT'],
  ['projects', 'instructions', "ALTER TABLE projects ADD COLUMN instructions TEXT NOT NULL DEFAULT ''"],
  ['projects', 'instructions_updated_by', 'ALTER TABLE projects ADD COLUMN instructions_updated_by TEXT'],
  ['projects', 'instructions_updated_at', 'ALTER TABLE projects ADD COLUMN instructions_updated_at INTEGER'],
  ['projects', 'approval_rules', "ALTER TABLE projects ADD COLUMN approval_rules TEXT NOT NULL DEFAULT ''"],
  ['projects', 'plugin_dirs', "ALTER TABLE projects ADD COLUMN plugin_dirs TEXT NOT NULL DEFAULT ''"],
  ['projects', 'default_effort', "ALTER TABLE projects ADD COLUMN default_effort TEXT NOT NULL DEFAULT 'high'"],
  ['machines', 'notes', "ALTER TABLE machines ADD COLUMN notes TEXT NOT NULL DEFAULT ''"],
  ['machines', 'workspace_tools', 'ALTER TABLE machines ADD COLUMN workspace_tools INTEGER NOT NULL DEFAULT 0'],
];

export class Store {
  db: DatabaseSync;
  /** The property registry and the properties minions and artifacts carry. */
  props: Registry;
  /** The database file; the runner keeps its turn folders beside it. */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
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
    this.props = new Registry(this.db);
    this.props.seed();
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
        this.addEvent(id, 'note', { text: `Minions are now numbered per scheme. This minion is now #${number} (it was #${id}).` });
        changed.set(project_id, [...(changed.get(project_id) ?? []), `#${id} → #${number}`]);
      }
      for (const [projectId, moves] of changed) {
        const coordinator = this.getCoordinator(projectId);
        if (coordinator) this.addEvent(coordinator.id, 'note', { text: `Threads are now numbered per scheme: ${moves.join(', ')}.` });
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

  setProjectInstructions(id: number, instructions: string, by: string) {
    this.db
      .prepare('UPDATE projects SET instructions = ?, instructions_updated_by = ?, instructions_updated_at = ? WHERE id = ?')
      .run(instructions, by, Date.now(), id);
  }

  setProjectSettings(id: number, fields: Partial<Pick<Project, 'approval_rules' | 'plugin_dirs' | 'default_effort'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? ''), id);
  }

  /** Change a project's display name; its repo, folders and links go by id and stay put. */
  renameProject(id: number, name: string): Project {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('The scheme name cannot be empty');
    try {
      this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(trimmed, id);
    } catch (err: any) {
      if (/UNIQUE/.test(err.message)) throw new Error(`There is already a scheme called "${trimmed}"`);
      throw err;
    }
    return this.getProject(id)!;
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
    this.db.prepare('DELETE FROM ticket_seen WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM github_seen WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM turns WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  }

  /** Record what a ticket last ran with, without counting as activity (updated_at stays). */
  updateTicketQuietly(id: number, fields: Partial<Pick<Ticket, 'last_model' | 'last_effort'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  }

  updateTicket(id: number, fields: Partial<Pick<Ticket, 'status' | 'session_id' | 'last_activity' | 'title' | 'tag' | 'state' | 'note' | 'build' | 'model' | 'effort' | 'last_model' | 'last_effort'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => fields[k] ?? null);
    const before = fields.status ? this.getTicket(id)?.status : undefined;
    this.db.prepare(`UPDATE tickets SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
    // Dismissing moves the stage to done, reopening back to in-progress.
    if (before && fields.status) this.props.statusChanged(id, before, fields.status);
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

  /** Replace an event's data, for cards whose status lives in the card (plans). */
  setEventData(id: number, data: unknown) {
    this.db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
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

  pinnedArtifactPaths(ticketId: number): string[] {
    return (this.db.prepare('SELECT path FROM artifacts WHERE ticket_id = ? AND pinned_at IS NOT NULL').all(ticketId) as { path: string }[]).map((r) => r.path);
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

  /** When `name` last looked at each of a project's threads: ticket id -> time. */
  seenTimes(name: string, projectId: number): Record<number, number> {
    const rows = this.db
      .prepare('SELECT s.ticket_id, s.seen_at FROM ticket_seen s JOIN tickets t ON t.id = s.ticket_id WHERE s.name = ? AND t.project_id = ?')
      .all(name, projectId) as { ticket_id: number; seen_at: number }[];
    return Object.fromEntries(rows.map((r) => [r.ticket_id, r.seen_at]));
  }

  markSeen(name: string, ticketId: number): number {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO ticket_seen (name, ticket_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(name, ticket_id) DO UPDATE SET seen_at = excluded.seen_at')
      .run(name, ticketId, now);
    return now;
  }

  /**
   * For the scheme recap: when `name` last acted anywhere in the scheme (a message, a card answer or
   * plan verdict, which are messages too, or an approval click), and how many turns each thread
   * has finished since. `since` is null if they never have.
   */
  recap(name: string, projectId: number): { since: number | null; turns: Record<number, number> } {
    const { since } = this.db.prepare(`
      SELECT MAX(e.created_at) AS since FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.project_id = ? AND (
        (e.kind = 'user_message' AND json_extract(e.data, '$.author') = ?)
        OR (e.kind = 'approval_result' AND json_extract(e.data, '$.by') = ?))`).get(projectId, name, name) as { since: number | null };
    if (since == null) return { since: null, turns: {} };
    const rows = this.db.prepare(`
      SELECT e.ticket_id, COUNT(*) AS n FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.project_id = ? AND e.created_at > ? AND e.kind = 'claude' AND json_extract(e.data, '$.type') = 'result'
      GROUP BY e.ticket_id`).all(projectId, since) as { ticket_id: number; n: number }[];
    return { since, turns: Object.fromEntries(rows.map((r) => [r.ticket_id, r.n])) };
  }

  listEvents(ticketId: number, afterId = 0): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE ticket_id = ? AND id > ? ORDER BY id')
      .all(ticketId, afterId) as unknown as EventRow[];
  }

  /**
   * A project's stored cards still waiting on a person, in threads that aren't dismissed: questions
   * nobody has answered (nor the minion settled), and plans still pending. Approval cards live in memory (Approvals.pending).
   */
  openCards(projectId: number): EventRow[] {
    return this.db.prepare(`
      SELECT e.* FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.project_id = ? AND t.status != 'closed' AND (
        (e.kind = 'plan' AND json_extract(e.data, '$.status') = 'pending')
        OR (e.kind = 'question' AND json_extract(e.data, '$.settled') IS NULL AND NOT EXISTS (
          SELECT 1 FROM events a WHERE a.ticket_id = e.ticket_id AND a.kind = 'user_message'
            AND json_extract(a.data, '$.answer.questionId') = json_extract(e.data, '$.id'))))
      ORDER BY e.id`).all(projectId) as unknown as EventRow[];
  }

  /** The text of a ticket's replies that may link files (subagents' included). */
  replyTexts(ticketId: number): string[] {
    const rows = this.db
      .prepare("SELECT data FROM events WHERE ticket_id = ? AND kind = 'claude' AND data LIKE '%\"type\":\"assistant\"%' AND data LIKE '%](%'")
      .all(ticketId) as { data: string }[];
    const texts: string[] = [];
    for (const { data } of rows) {
      const content = JSON.parse(data).message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
    return texts;
  }

  /** Pass every stored Claude event through `fn` and save what it returns (null deletes the event). */
  rewriteClaudeEvents(fn: (data: any) => any): { changed: number; deleted: number } {
    const changes: { id: number; data: string | null }[] = [];
    for (const row of this.db.prepare("SELECT id, data FROM events WHERE kind = 'claude'").iterate() as Iterable<any>) {
      const next = fn(JSON.parse(row.data));
      const data = next == null ? null : JSON.stringify(next);
      if (data !== row.data) changes.push({ id: row.id, data });
    }
    const update = this.db.prepare('UPDATE events SET data = ? WHERE id = ?');
    const remove = this.db.prepare('DELETE FROM events WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const c of changes) c.data == null ? remove.run(c.id) : update.run(c.data, c.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const deleted = changes.filter((c) => c.data == null).length;
    return { changed: changes.length - deleted, deleted };
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

  /** PR events already handled for a ticket (keys starting with `prefix`, which is stripped). */
  githubSeen(ticketId: number, prefix: string): string[] {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return (this.db.prepare("SELECT key FROM github_seen WHERE ticket_id = ? AND key LIKE ? ESCAPE '\\'").all(ticketId, like) as { key: string }[])
      .map((r) => r.key.slice(prefix.length));
  }

  /** Record PR events as handled; `delivered` says whether any were sent to the ticket. */
  addGithubSeen(ticketId: number, keys: string[], delivered: boolean) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO github_seen (ticket_id, key, delivered, created_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const k of keys) insert.run(ticketId, k, delivered ? 1 : 0, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * When a ticket's turns since `since` started and ended: a turn starts with Claude's init event
   * and ends with its result, an error, or a stop or restart note.
   */
  turnMarks(ticketId: number, since: number): { at: number; start: boolean }[] {
    const rows = this.db
      .prepare(`SELECT created_at, kind, data FROM events WHERE ticket_id = ? AND created_at >= ? AND (
          (kind = 'claude' AND (data LIKE '{"type":"system","subtype":"init"%' OR data LIKE '{"type":"result"%'))
          OR kind = 'error'
          OR (kind = 'note' AND (data LIKE '{"text":"Stopped by user.%' OR data LIKE '{"text":"The server restarted during this turn%')))
        ORDER BY id`)
      .all(ticketId, since) as { created_at: number; kind: string; data: string }[];
    return rows.map((r) => ({ at: r.created_at, start: r.kind === 'claude' && r.data.startsWith('{"type":"system"') }));
  }

  /**
   * Store a finished turn. Its cost is the session's running total minus the total at the session's
   * previous turn; a total that went down means Claude Code started counting afresh (it restores the
   * running total on --resume only when the session was the last one run in that folder), so the
   * whole total is this turn's.
   */
  recordTurn(ticketId: number, r: TurnResult): Turn {
    const prev = this.db
      .prepare('SELECT session_id, session_cost_usd FROM turns WHERE ticket_id = ? ORDER BY id DESC LIMIT 1')
      .get(ticketId) as { session_id: string | null; session_cost_usd: number } | undefined;
    const sameSession = prev && (prev.session_id ?? null) === (r.session_id ?? null);
    const base = sameSession && prev.session_cost_usd <= r.session_cost_usd ? prev.session_cost_usd : 0;
    const u = r.usage ?? null;
    const n = (v: unknown) => (typeof v === 'number' ? v : null);
    const row = this.db
      .prepare(`INSERT INTO turns (ticket_id, event_id, session_id, ended_at, cost_usd, session_cost_usd, duration_ms,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(ticketId, r.event_id ?? null, r.session_id ?? null, r.ended_at, r.session_cost_usd - base, r.session_cost_usd,
        n(r.duration_ms), n(u?.input_tokens), n(u?.output_tokens), n(u?.cache_read_input_tokens), n(u?.cache_creation_input_tokens));
    return row as unknown as Turn;
  }

  /**
   * Fill the turns table from stored result events, for turns from before it existed. Session ids
   * come from each turn's init event. Only runs on an empty table; returns how many turns it added.
   */
  backfillTurns(): number {
    if ((this.db.prepare('SELECT 1 FROM turns LIMIT 1').get())) return 0;
    const rows = this.db
      .prepare(`SELECT id, ticket_id, data, created_at FROM events WHERE kind = 'claude'
          AND (data LIKE '{"type":"system","subtype":"init"%' OR data LIKE '{"type":"result"%') ORDER BY id`)
      .iterate() as Iterable<{ id: number; ticket_id: number; data: string; created_at: number }>;
    const session = new Map<number, string | null>();
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const ev = JSON.parse(row.data);
        if (ev.type === 'system') {
          session.set(row.ticket_id, ev.session_id ?? null);
        } else if (typeof ev.total_cost_usd === 'number') {
          this.recordTurn(row.ticket_id, {
            event_id: row.id, session_id: session.get(row.ticket_id) ?? null, ended_at: row.created_at,
            session_cost_usd: ev.total_cost_usd, duration_ms: ev.duration_ms,
          });
          added++;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  /** A ticket's turns, oldest first. */
  listTurns(ticketId: number): Turn[] {
    return this.db.prepare('SELECT * FROM turns WHERE ticket_id = ? ORDER BY id').all(ticketId) as unknown as Turn[];
  }

  /** What a ticket's turns have cost so far. */
  ticketCost(ticketId: number): number {
    return (this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM turns WHERE ticket_id = ?').get(ticketId) as { c: number }).c;
  }

  /** Cost per local day ('2026-10-28') and project, for turns ended at or after `since`. */
  dailyCosts(since: number): { day: string; project_id: number; cost: number; turns: number }[] {
    return this.db
      .prepare(`SELECT date(u.ended_at / 1000, 'unixepoch', 'localtime') AS day, t.project_id, SUM(u.cost_usd) AS cost, COUNT(*) AS turns
          FROM turns u JOIN tickets t ON t.id = u.ticket_id WHERE u.ended_at >= ? GROUP BY day, t.project_id ORDER BY day`)
      .all(since) as unknown as { day: string; project_id: number; cost: number; turns: number }[];
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

  deleteSetting(key: string) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  listMachines(): Machine[] {
    return this.db.prepare('SELECT * FROM machines ORDER BY name').all() as unknown as Machine[];
  }

  getMachine(id: number): Machine | undefined {
    return this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as unknown as Machine | undefined;
  }

  createMachine(name: string, tokenHash: string, by: string): Machine {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO machines (name, token_hash, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(name, tokenHash, by, Date.now());
    return this.getMachine(Number(lastInsertRowid))!;
  }

  updateMachine(id: number, fields: Partial<Pick<Machine, 'name' | 'token_hash' | 'last_seen_at' | 'notes' | 'workspace_tools'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE machines SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  }

  deleteMachine(id: number) {
    this.db.prepare('DELETE FROM machines WHERE id = ?').run(id);
  }

  listPushSubscriptions(): PushSubscriptionRow[] {
    return this.db.prepare('SELECT * FROM push_subscriptions ORDER BY id').all() as unknown as PushSubscriptionRow[];
  }

  getPushSubscription(endpoint: string): PushSubscriptionRow | undefined {
    return this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as unknown as PushSubscriptionRow | undefined;
  }

  /** Save a browser's subscription for `name`; a browser someone else signed in on before becomes theirs. */
  savePushSubscription(name: string, endpoint: string, p256dh: string, auth: string): PushSubscriptionRow {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (name, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
           muted = CASE WHEN name = excluded.name THEN muted ELSE '[]' END, name = excluded.name`,
      )
      .run(name, endpoint, p256dh, auth, Date.now());
    return this.getPushSubscription(endpoint)!;
  }

  setPushMuted(endpoint: string, muted: number[]) {
    this.db.prepare('UPDATE push_subscriptions SET muted = ? WHERE endpoint = ?').run(JSON.stringify(muted), endpoint);
  }

  deletePushSubscription(endpoint: string) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }
}
