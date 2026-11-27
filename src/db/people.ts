// People: users, scheme members, repo collaborators, and which schemes a person can see (#1313: src/db.ts by area).
import type { PersonNote, RepoCollaborator, User } from '../db-rows.ts';
import { GLOBAL_OWNER } from '../properties.ts';
import { copyRow, scoped } from '../read-scope.ts';
import type { Store } from '../db.ts';

export const peopleQueries = {
  /** Whose subscription the server's own Claude login is: the first admin, the one Citadel made at its first start. */
  serverLoginOwner(this: Store): number | null {
    return (this.db.prepare('SELECT min(id) AS id FROM users WHERE admin = 1').get() as { id: number | null }).id;
  },

  listUsers(this: Store): User[] {
    return this.db.prepare('SELECT * FROM users ORDER BY id').all() as unknown as User[];
  },

  getUser(this: Store, id: number): User | undefined {
    const u = scoped(this.db, `user:id:${id}`, () => this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User | undefined);
    return copyRow(u);
  },

  /** By login, name or open invite, either case: cookies from the shared-password days carry only the name. */
  findUser(this: Store, field: 'login' | 'name' | 'invite_hash', value: string): User | undefined {
    const u = scoped(this.db, `user:${field}:${value}`, () => this.db.prepare(`SELECT * FROM users WHERE ${field} = ?`).get(value) as unknown as User | undefined);
    return copyRow(u);
  },

  /** A new person gets an id no one has ever had: a removed person's cookie names their id (#468 S05-1). */
  createUser(this: Store, u: Pick<User, 'name' | 'login'> & { admin?: boolean; server_login?: boolean }): User {
    const { max } = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS max FROM users').get() as { max: number };
    const id = Math.max(this.getSetting<number>('user_id_high') ?? 0, max) + 1;
    this.db.prepare('INSERT INTO users (id, name, login, admin, server_login, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, u.name, u.login, u.admin ? 1 : 0, u.server_login ? 1 : 0, Date.now());
    this.setSetting('user_id_high', id);
    return this.getUser(id)!;
  },

  updateUser(this: Store, id: number, fields: Partial<Omit<User, 'id' | 'login' | 'admin' | 'created_at'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  },

  /** Remove a person: their schemes and machines go to `heir` (every machine has an owner, Build 10 H1), their memberships with them. Their messages keep their name. */
  deleteUser(this: Store, id: number, heir: number) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id = ?').run(heir, id);
      // The heir's, lent to no scheme with every role off, so a gone person's computer reaches no one's turns and serves
      // nothing new until the heir switches it on or removes it.
      this.db.prepare('UPDATE machine_roles SET "on" = 0 WHERE machine_id IN (SELECT id FROM machines WHERE owner_id = ?)').run(id);
      this.db.prepare('DELETE FROM machine_projects WHERE machine_id IN (SELECT id FROM machines WHERE owner_id = ?)').run(id);
      this.db.prepare('DELETE FROM machine_role_projects WHERE machine_id IN (SELECT id FROM machines WHERE owner_id = ?)').run(id);
      this.db.prepare('UPDATE machines SET owner_id = ?, scoped = 1 WHERE owner_id = ?').run(heir, id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
      // People added before user_id_high existed: remember the removed id so it is never reused.
      if (id > (this.getSetting<number>('user_id_high') ?? 0)) this.setSetting('user_id_high', id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  /** Schemes from before owners (and any whose owner is gone) become this admin's. */
  adoptOwnerless(this: Store, adminId: number) {
    this.db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL OR owner_id NOT IN (SELECT id FROM users)').run(adminId);
  },

  /** A scheme's people: the owner first, then members in the order they were added. */
  listMembers(this: Store, projectId: number): (Pick<User, 'id' | 'name' | 'login'> & { owner: boolean })[] {
    return (
      this.db
        .prepare(`SELECT u.id, u.name, u.login, u.id = p.owner_id AS owner FROM users u JOIN projects p ON p.id = ?
      LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = u.id
      WHERE u.id = p.owner_id OR m.user_id IS NOT NULL ORDER BY owner DESC, m.added_at`)
        .all(projectId) as (Pick<User, 'id' | 'name' | 'login'> & { owner: number })[]
    ).map((r) => ({ ...r, owner: !!r.owner }));
  },

  addMember(this: Store, projectId: number, userId: number) {
    if (this.db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, added_at) VALUES (?, ?, ?)').run(projectId, userId, Date.now()).changes) this.lendCiToJoined(projectId, userId);
  },

  removeMember(this: Store, projectId: number, userId: number) {
    this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
  },

  /** What Citadel did on GitHub for scheme members (src/repo-access.ts): one row, or all of them. */
  getRepoCollaborator(this: Store, projectId: number, userId: number): RepoCollaborator | undefined {
    return this.db.prepare('SELECT * FROM repo_collaborators WHERE project_id = ? AND user_id = ?').get(projectId, userId) as unknown as RepoCollaborator | undefined;
  },

  listRepoCollaborators(this: Store): RepoCollaborator[] {
    return this.db.prepare('SELECT * FROM repo_collaborators').all() as unknown as RepoCollaborator[];
  },

  putRepoCollaborator(this: Store, r: Omit<RepoCollaborator, 'updated_at'>) {
    this.db
      .prepare(`INSERT INTO repo_collaborators (project_id, user_id, slug, login, state, invitation_id, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, user_id) DO UPDATE SET slug = excluded.slug, login = excluded.login, state = excluded.state,
        invitation_id = excluded.invitation_id, error = excluded.error, updated_at = excluded.updated_at`)
      .run(r.project_id, r.user_id, r.slug, r.login, r.state, r.invitation_id, r.error, Date.now());
  },

  deleteRepoCollaborator(this: Store, projectId: number, userId: number) {
    this.db.prepare('DELETE FROM repo_collaborators WHERE project_id = ? AND user_id = ?').run(projectId, userId);
  },

  /**
   * Whether a person counts as a Citadel admin: the admin flag, or being in the Citadel scheme (#621, Cara 2026-11-12:
   * "any scheme member should have access to everything they need"). Admin gates, sessions and canSee read this; the
   * bare flag is left for whose GitHub owns new schemes' repos and who gets admins' push alerts.
   */
  isAdmin(this: Store, user: Pick<User, 'id' | 'admin' | 'disabled_at'> | undefined | null): boolean {
    return !!user && !user.disabled_at && (!!user.admin || this.inScheme(user.id, GLOBAL_OWNER));
  },

  /** Whether a person owns or is a member of a scheme (no admin shortcut). */
  inScheme(this: Store, uid: number | undefined, projectId: number): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM projects WHERE id = ?1 AND owner_id = ?2
      UNION SELECT 1 FROM project_members WHERE project_id = ?1 AND user_id = ?2`)
      .get(projectId, uid ?? -1);
  },

  /** The schemes a person is in, as owner or member; null for an admin (isAdmin's sense), who is in all of them. */
  visibleProjects(this: Store, who: { uid?: number; admin?: boolean }): Set<number> | null {
    if (who.admin || this.inScheme(who.uid, GLOBAL_OWNER)) return null;
    const rows = this.db
      .prepare(`SELECT id FROM projects WHERE owner_id = ?1
      UNION SELECT project_id FROM project_members WHERE user_id = ?1`)
      .all(who.uid ?? -1) as { id: number }[];
    return new Set(rows.map((r) => r.id));
  },

  /** The schemes a person owns or is a member of, admin or not: the Releases page's All view (#625). */
  memberSchemes(this: Store, uid: number | undefined): Set<number> {
    const rows = scoped(
      this.db,
      `member-schemes:${uid ?? -1}`,
      () =>
        this.db
          .prepare(`SELECT id FROM projects WHERE owner_id = ?1
      UNION SELECT project_id FROM project_members WHERE user_id = ?1`)
          .all(uid ?? -1) as { id: number }[],
    );
    return new Set(rows.map((r) => r.id));
  },

  /** Whether a person may see a scheme: an admin (a Citadel member too: isAdmin), its owner, or a member. */
  canSee(this: Store, who: { uid?: number; admin?: boolean }, projectId: number): boolean {
    return !!who.admin || this.inScheme(who.uid, projectId) || this.inScheme(who.uid, GLOBAL_OWNER);
  },

  /** The Needs-you items `name` last saw waiting in each scheme (#539): project id -> their keys. */
  seenItems(this: Store, name: string): Map<number, Set<string>> {
    const rows = this.db.prepare('SELECT project_id, keys FROM project_seen_items WHERE name = ?').all(name) as { project_id: number; keys: string }[];
    return new Map(rows.map((r) => [r.project_id, new Set(JSON.parse(r.keys) as string[])]));
  },

  /** Record the items `name` saw waiting in a scheme; with `keep`, only when none are recorded yet. */
  setSeenItems(this: Store, name: string, projectId: number, keys: string[], keep = false) {
    this.db
      .prepare(`INSERT INTO project_seen_items (name, project_id, keys, seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(name, project_id) DO ${keep ? 'NOTHING' : 'UPDATE SET keys = excluded.keys, seen_at = excluded.seen_at'}`)
      .run(name, projectId, JSON.stringify(keys), Date.now());
  },

  /** People's notes on a scheme's minions, by ticket id. Only people's routes may hand these out. */
  personNotes(this: Store, projectId: number): Record<number, PersonNote> {
    // A note older than its minion belongs to a deleted one whose id was reused: a rolled-back release's deleteTicket leaves it behind.
    const rows = this.db.prepare('SELECT n.ticket_id, n.text, n.updated_by, n.updated_at FROM person_notes n JOIN tickets t ON t.id = n.ticket_id WHERE t.project_id = ? AND n.updated_at >= t.created_at').all(projectId) as { ticket_id: number; text: string; updated_by: string; updated_at: number }[];
    return Object.fromEntries(rows.map((r) => [r.ticket_id, { text: r.text, by: r.updated_by, at: r.updated_at }]));
  },

  /** Set a minion's person note, or clear it with an empty text. */
  setPersonNote(this: Store, ticketId: number, text: string, by: string): PersonNote | null {
    if (!text) {
      this.db.prepare('DELETE FROM person_notes WHERE ticket_id = ?').run(ticketId);
      return null;
    }
    const at = Date.now();
    this.db.prepare('INSERT INTO person_notes (ticket_id, text, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by, updated_at = excluded.updated_at').run(ticketId, text, by, at);
    return { text, by, at };
  },
};
