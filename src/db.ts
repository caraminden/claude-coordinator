import { DatabaseSync } from 'node:sqlite';

export type TicketStatus = 'new' | 'running' | 'idle' | 'error' | 'closed';

export interface Project {
  id: number;
  name: string;
  repo_url: string | null;
  repo_dir: string | null;
  created_at: number;
}

export interface Ticket {
  id: number;
  project_id: number;
  title: string;
  status: TicketStatus;
  session_id: string | null;
  cwd: string;
  branch: string | null;
  permission_mode: string;
  last_activity: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
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
`;

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
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

  listTickets(projectId: number): Ticket[] {
    return this.db
      .prepare('SELECT * FROM tickets WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as unknown as Ticket[];
  }

  getTicket(id: number): Ticket | undefined {
    return this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as unknown as Ticket | undefined;
  }

  /** Insert a ticket with no working directory yet; call setTicketDir once it exists. */
  createTicket(t: Pick<Ticket, 'project_id' | 'title' | 'permission_mode' | 'created_by'>): Ticket {
    const now = Date.now();
    const r = this.db
      .prepare(
        `INSERT INTO tickets (project_id, title, status, cwd, permission_mode, created_by, created_at, updated_at)
         VALUES (?, ?, 'new', '', ?, ?, ?, ?)`,
      )
      .run(t.project_id, t.title, t.permission_mode, t.created_by, now, now);
    return this.getTicket(Number(r.lastInsertRowid))!;
  }

  setTicketDir(id: number, cwd: string, branch: string | null) {
    this.db.prepare('UPDATE tickets SET cwd = ?, branch = ? WHERE id = ?').run(cwd, branch, id);
  }

  deleteTicket(id: number) {
    this.db.prepare('DELETE FROM events WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  }

  updateTicket(id: number, fields: Partial<Pick<Ticket, 'status' | 'session_id' | 'last_activity' | 'title'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => fields[k] ?? null);
    this.db.prepare(`UPDATE tickets SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
  }

  addEvent(ticketId: number, kind: string, data: unknown): EventRow {
    const now = Date.now();
    const json = JSON.stringify(data);
    const r = this.db
      .prepare('INSERT INTO events (ticket_id, kind, data, created_at) VALUES (?, ?, ?, ?)')
      .run(ticketId, kind, json, now);
    return { id: Number(r.lastInsertRowid), ticket_id: ticketId, kind, data: json, created_at: now };
  }

  listEvents(ticketId: number, afterId = 0): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE ticket_id = ? AND id > ? ORDER BY id')
      .all(ticketId, afterId) as unknown as EventRow[];
  }
}
