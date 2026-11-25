// Contraptions: their rows, who uses them, sessions, turns, turn audits and errors (#1313: src/db.ts by area).
import type { ContraptionErrorRow, ContraptionRow, ContraptionSession, ContraptionTurnRow, TurnAuditRow } from '../db-rows.ts';
import type { Store } from '../db.ts';

export const contraptionQueries = {
  listContraptions(this: Store): ContraptionRow[] {
    return this.db.prepare('SELECT * FROM contraptions ORDER BY title COLLATE NOCASE').all() as unknown as ContraptionRow[];
  },

  getContraption(this: Store, name: string): ContraptionRow | undefined {
    return this.db.prepare('SELECT * FROM contraptions WHERE name = ?').get(name) as unknown as ContraptionRow | undefined;
  },

  /** The contraption a bearer key's hash belongs to. */
  contraptionByKeyHash(this: Store, hash: string): ContraptionRow | undefined {
    return this.db.prepare('SELECT * FROM contraptions WHERE key_hash = ?').get(hash) as unknown as ContraptionRow | undefined;
  },

  createContraption(this: Store, c: Omit<ContraptionRow, 'id' | 'created_at'>): ContraptionRow {
    const keys = Object.keys(c) as (keyof typeof c)[];
    this.db.prepare(`INSERT INTO contraptions (${keys.join(', ')}, created_at) VALUES (${keys.map(() => '?').join(', ')}, ?)`).run(...keys.map((k) => c[k] ?? null), Date.now());
    return this.getContraption(c.name)!;
  },

  updateContraption(this: Store, name: string, fields: Partial<Omit<ContraptionRow, 'id' | 'name' | 'created_at'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE contraptions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE name = ?`).run(...keys.map((k) => fields[k] ?? null), name);
  },

  /** The ids of the people a contraption is enabled for. */
  contraptionUsers(this: Store, contraptionId: number): number[] {
    return (this.db.prepare('SELECT user_id FROM contraption_users WHERE contraption_id = ? ORDER BY added_at').all(contraptionId) as { user_id: number }[]).map((r) => r.user_id);
  },

  setContraptionUser(this: Store, contraptionId: number, userId: number, enabled: boolean, by: number | null) {
    if (enabled) this.db.prepare('INSERT OR IGNORE INTO contraption_users (contraption_id, user_id, added_at, added_by) VALUES (?, ?, ?, ?)').run(contraptionId, userId, Date.now(), by);
    else this.db.prepare('DELETE FROM contraption_users WHERE contraption_id = ? AND user_id = ?').run(contraptionId, userId);
  },

  /** Whether a contraption is enabled for a person who can still sign in. Read fresh each call, so a change takes at once. */
  contraptionEnabled(this: Store, name: string, userId: number): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM contraption_users cu JOIN contraptions c ON c.id = cu.contraption_id
      JOIN users u ON u.id = cu.user_id WHERE c.name = ? AND cu.user_id = ? AND u.disabled_at IS NULL`)
      .get(name, userId);
  },

  /** The contraptions enabled for a person, for their app rail. */
  contraptionsFor(this: Store, userId: number): Pick<ContraptionRow, 'name' | 'title' | 'icon' | 'port' | 'identity_private' | 'folder'>[] {
    return this.db
      .prepare(`SELECT c.name, c.title, c.icon, c.port, c.identity_private, c.folder FROM contraptions c JOIN contraption_users cu ON cu.contraption_id = c.id
      JOIN users u ON u.id = cu.user_id WHERE cu.user_id = ? AND u.disabled_at IS NULL ORDER BY c.title COLLATE NOCASE`)
      .all(userId) as unknown as Pick<ContraptionRow, 'name' | 'title' | 'icon' | 'port' | 'identity_private' | 'folder'>[];
  },

  /** A person's named session in a contraption. */
  contraptionSession(this: Store, contraptionId: number, userId: number, name: string): ContraptionSession | undefined {
    return this.db.prepare('SELECT * FROM contraption_sessions WHERE contraption_id = ? AND user_id = ? AND name = ?').get(contraptionId, userId, name) as unknown as ContraptionSession | undefined;
  },

  contraptionSessions(this: Store, contraptionId: number, userId: number): ContraptionSession[] {
    return this.db.prepare('SELECT * FROM contraption_sessions WHERE contraption_id = ? AND user_id = ? ORDER BY used_at DESC').all(contraptionId, userId) as unknown as ContraptionSession[];
  },

  /** Point a session name at a Claude session (a new one, or the id a resume reported), and mark it used now. */
  putContraptionSession(this: Store, contraptionId: number, userId: number, name: string, claudeSession: string) {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO contraption_sessions (contraption_id, user_id, name, claude_session, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (contraption_id, user_id, name) DO UPDATE SET claude_session = excluded.claude_session, used_at = excluded.used_at`)
      .run(contraptionId, userId, name, claudeSession, now, now);
  },

  deleteContraptionSession(this: Store, contraptionId: number, userId: number, name: string): boolean {
    return this.db.prepare('DELETE FROM contraption_sessions WHERE contraption_id = ? AND user_id = ? AND name = ?').run(contraptionId, userId, name).changes > 0;
  },

  /** A finished turn's audit row (#844). */
  putTurnAudit(this: Store, turnId: number, row: { model: string | null; blind: boolean; images: number; system: string; prompt: string; output: string }) {
    this.db.prepare('INSERT OR REPLACE INTO contraption_turn_audit (turn_id, at, model, blind, images, system, prompt, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(turnId, Date.now(), row.model, row.blind ? 1 : 0, row.images, row.system, row.prompt, row.output);
  },

  turnAudit(this: Store, turnId: number): TurnAuditRow | undefined {
    return this.db.prepare('SELECT * FROM contraption_turn_audit WHERE turn_id = ?').get(turnId) as unknown as TurnAuditRow | undefined;
  },

  /** The app's verdict on its turn's reply (#844): it passed the app's output check, or the app fell back to its own text. */
  setTurnVerdict(this: Store, turnId: number, verdict: 'pass' | 'fallback', reason: string | null) {
    this.db.prepare('UPDATE contraption_turn_audit SET verdict = ?, verdict_reason = ?, verdict_at = ? WHERE turn_id = ?').run(verdict, reason, Date.now(), turnId);
  },

  /** secure_delete zeroes the rows' pages in the database file (#844). Their text can stay in the WAL until later
   * writes reuse it, and in backups for as long as those are kept (deploy/backup.sh). */
  dropAudit(this: Store, where: string, ...args: (number | string)[]) {
    this.db.exec('PRAGMA main.secure_delete = ON');
    try {
      this.db.prepare(`DELETE FROM contraption_turn_audit WHERE ${where}`).run(...args);
    } finally {
      this.db.exec('PRAGMA main.secure_delete = FAST');
    }
  },

  sweepTurnAudit(this: Store, before: number) {
    this.dropAudit('at < ?', before);
  },

  /** A session's audit rows, when the app deletes the session. */
  deleteTurnAudit(this: Store, contraptionId: number, userId: number, session: string) {
    this.dropAudit('turn_id IN (SELECT id FROM contraption_turns WHERE contraption_id = ? AND user_id = ? AND session = ?)', contraptionId, userId, session);
  },

  /** A scheme's audit page (#844): its home apps' turns, newest first, `limit` of them before turn `before`, one app's if named. */
  schemeTurnAudit(this: Store, projectId: number, opts: { before?: number; contraption?: string; limit: number }) {
    return this.db
      .prepare(`SELECT a.*, t.session, t.outcome, t.started_at, c.name AS contraption, c.title AS contraption_title, u.name AS person
      FROM contraption_turn_audit a JOIN contraption_turns t ON t.id = a.turn_id JOIN contraptions c ON c.id = t.contraption_id JOIN users u ON u.id = t.user_id
      WHERE c.home_scheme = ? AND a.turn_id < ? AND (? IS NULL OR c.name = ?) ORDER BY a.turn_id DESC LIMIT ?`)
      .all(projectId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.contraption ?? null, opts.contraption ?? null, opts.limit) as unknown as (TurnAuditRow & { session: string; outcome: string | null; started_at: number; contraption: string; contraption_title: string; person: string })[];
  },

  /** One more of a contraption's errors on a day (#835); the first one's sample stays. */
  addContraptionError(this: Store, contraptionId: number, day: string, kind: string, key: string, sample: string, at: number) {
    this.db
      .prepare(`INSERT INTO contraption_errors (contraption_id, day, kind, key, count, sample, first_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT (contraption_id, day, kind, key) DO UPDATE SET count = count + 1, last_at = excluded.last_at`)
      .run(contraptionId, day, kind, key, sample, at, at);
  },

  /** A day's contraption errors with their app's name, title and home scheme, biggest first. */
  contraptionErrors(this: Store, day: string): ContraptionErrorRow[] {
    return this.db
      .prepare(`SELECT e.*, c.name, c.title, c.home_scheme FROM contraption_errors e JOIN contraptions c ON c.id = e.contraption_id
      WHERE e.day = ? ORDER BY e.count DESC, e.first_at`)
      .all(day) as unknown as ContraptionErrorRow[];
  },

  /** A contraption turn's meter row, at its start (so it counts towards the day's cap at once). */
  startContraptionTurn(this: Store, contraptionId: number, userId: number, session: string): number {
    return Number(this.db.prepare('INSERT INTO contraption_turns (contraption_id, user_id, session, started_at) VALUES (?, ?, ?, ?)').run(contraptionId, userId, session, Date.now()).lastInsertRowid);
  },

  endContraptionTurn(this: Store, id: number, outcome: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null) {
    this.db.prepare(`UPDATE contraption_turns SET ended_at = ?, outcome = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ? WHERE id = ?`).run(Date.now(), outcome, usage?.input ?? null, usage?.output ?? null, usage?.cacheRead ?? null, usage?.cacheWrite ?? null, id);
  },

  getContraptionTurn(this: Store, id: number): ContraptionTurnRow | undefined {
    return this.db.prepare('SELECT * FROM contraption_turns WHERE id = ?').get(id) as unknown as ContraptionTurnRow | undefined;
  },

  /** A person's turns in a contraption since `since` (the start of the server's day, for its turn_cap). */
  contraptionTurnsSince(this: Store, contraptionId: number, userId: number, since: number): number {
    return (this.db.prepare('SELECT count(*) AS n FROM contraption_turns WHERE contraption_id = ? AND user_id = ? AND started_at >= ?').get(contraptionId, userId, since) as { n: number }).n;
  },

  /** An app's error counts per Pacific day, kind and key from `fromDay` on (#1123). */
  appErrorsSince(this: Store, contraptionId: number, fromDay: string): { day: string; kind: string; key: string; count: number; sample: string; last_at: number }[] {
    return this.db.prepare("SELECT day, kind, key, count, sample, last_at FROM contraption_errors WHERE contraption_id = ? AND day >= ? AND kind != 'deploy' ORDER BY day, count DESC").all(contraptionId, fromDay) as unknown as { day: string; kind: string; key: string; count: number; sample: string; last_at: number }[];
  },

  /** An app's agent turns started since `since`: when, whose, and its tokens (#1123). */
  appTurnsSince(this: Store, contraptionId: number, since: number): { started_at: number; person: string; outcome: string | null; tokens: number }[] {
    return this.db
      .prepare(`SELECT t.started_at, u.name AS person, t.outcome, coalesce(t.input_tokens, 0) + coalesce(t.output_tokens, 0) + coalesce(t.cache_read_tokens, 0) + coalesce(t.cache_write_tokens, 0) AS tokens
      FROM contraption_turns t JOIN users u ON u.id = t.user_id WHERE t.contraption_id = ? AND t.started_at >= ? ORDER BY t.started_at`)
      .all(contraptionId, since) as unknown as { started_at: number; person: string; outcome: string | null; tokens: number }[];
  },
};
