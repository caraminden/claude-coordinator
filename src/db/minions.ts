// Minions and Taskmasters: the tickets table, who owns and touches a minion, Taskmaster splits and digests, and model picks
// (#1313: src/db.ts by area).
import type { Store, Ticket, TicketKind, User } from '../db.ts';
import { askerKey, buildOwnerKey, ownMemoryKey, pagePlanKey, planKey } from '../db-keys.ts';
import { GLOBAL_OWNER } from '../properties.ts';
import type { ChangeBy } from './wait-records.ts';
import { copyRow, inScope, scoped, warm } from '../read-scope.ts';

export const minionQueries = {
  /**
   * The id the next event in a chat gets, handed out before its row is written: a message goes into its minion's queue
   * first, then its chat line (#1378), so a crash between the two never loses it. Pass it to addEvent before any other
   * event is added.
   */
  reserveEventId(this: Store): number {
    if (!this.eventIds) return (this.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM events').get() as { id: number }).id;
    const id = Math.max(this.eventIds.next, this.eventIds.floor());
    this.eventIds.next = id + 1;
    return id;
  },

  nextNumber(this: Store, projectId: number): number {
    const row = this.db.prepare('SELECT MAX(number) AS n FROM tickets WHERE project_id = ?').get(projectId) as { n: number | null };
    return (row.n ?? 0) + 1;
  },

  getTicketByNumber(this: Store, projectId: number, number: number): Ticket | undefined {
    return this.db.prepare('SELECT * FROM tickets WHERE project_id = ? AND number = ?').get(projectId, number) as unknown as Ticket | undefined;
  },

  /** The minion on a branch (the land line names its waiters by branch, src/waits.ts): an open one first, then the newest; a branch name is per scheme. */
  ticketByBranch(this: Store, branch: string, projectId: number | null = null): Ticket | undefined {
    return this.db.prepare("SELECT * FROM tickets WHERE branch = ? AND project_id = coalesce(?, project_id) ORDER BY status = 'closed', id DESC LIMIT 1").get(branch, projectId) as unknown as Ticket | undefined;
  },

  /** A scheme's minions open now or closed since `since` (ms), each with its first message's data (its brief, if posted), for the duplicate-start check (#1488). */
  briefsSince(this: Store, projectId: number, since: number): { id: number; number: number; title: string; status: string; data: string | null }[] {
    return this.db
      .prepare(`SELECT t.id, t.number, t.title, t.status,
      (SELECT data FROM events e WHERE e.ticket_id = t.id AND e.kind = 'user_message' ORDER BY e.id LIMIT 1) AS data
      FROM tickets t WHERE t.project_id = ? AND t.kind = 'ticket' AND (t.status != 'closed' OR t.closed_at >= ?) ORDER BY t.number`)
      .all(projectId, since) as { id: number; number: number; title: string; status: string; data: string | null }[];
  },

  /** A scheme's minions dismissed in [from, to), each with the text of its last note: why it was dismissed (#1996, the day strips). */
  dismissedIn(this: Store, projectId: number, from: number, to: number): (Ticket & { last_note: string | null })[] {
    return this.db
      .prepare(`SELECT t.*, (SELECT json_extract(e.data, '$.text') FROM events e WHERE e.ticket_id = t.id AND e.kind = 'note' ORDER BY e.id DESC LIMIT 1) AS last_note
      FROM tickets t WHERE t.project_id = ? AND t.kind = 'ticket' AND t.status = 'closed' AND t.closed_at >= ? AND t.closed_at < ?`)
      .all(projectId, from, to) as unknown as (Ticket & { last_note: string | null })[];
  },

  /** All tickets in a project, including the coordinator. */
  listTickets(this: Store, projectId: number): Ticket[] {
    // In a read scope (#1527) the rows are shared, not copied: copying Citadel's 1,500 rows per call cost more than the
    // read saved. Only read-only code runs in a scope; each caller still gets its own array to filter or sort.
    return [...scoped(this.db, `tickets:${projectId}`, () => this.db.prepare('SELECT * FROM tickets WHERE project_id = ? ORDER BY updated_at DESC').all(projectId) as unknown as Ticket[])];
  },

  /** A scheme's bug minions' numbers, open and closed: what the Code tab counts as bug fixes (#1988). */
  bugNumbers(this: Store, projectId: number): number[] {
    const sql = `SELECT k.number FROM tickets k JOIN properties p ON p.target_type = 'minion' AND p.target_id = k.id JOIN property_keys pk ON pk.id = p.key_id AND pk.key = 'type'
      WHERE k.project_id = ? AND k.number IS NOT NULL AND p.value = 'bug'`;
    return (this.db.prepare(sql).all(projectId) as { number: number }[]).map((r) => r.number);
  },

  /** A scheme's open minions, by number and title. */
  openTitles(this: Store, projectId: number): { number: number; title: string }[] {
    return this.db.prepare("SELECT number, title FROM tickets WHERE project_id = ? AND status != 'closed' AND kind != 'coordinator' AND number IS NOT NULL ORDER BY number").all(projectId) as { number: number; title: string }[];
  },

  /** Open tickets whose last turn hit the usage limit, in every project. */
  limitedTickets(this: Store): Ticket[] {
    return this.db.prepare("SELECT * FROM tickets WHERE state = 'limited' AND status != 'closed'").all() as unknown as Ticket[];
  },

  /** The scheme owner's Taskmaster: its only one until a split (#919), the owner's own after. */
  getCoordinator(this: Store, projectId: number): Ticket | undefined {
    return this.db
      .prepare(`SELECT t.* FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.project_id = ? AND t.kind = 'coordinator'
        ORDER BY t.coordinator_of IS p.owner_id DESC, t.coordinator_of IS NULL DESC, t.id LIMIT 1`)
      .get(projectId) as unknown as Ticket | undefined;
  },

  /** The scheme's Overlord (#919): the Taskmaster that is no one's own; before a split, its only one. */
  getOverlord(this: Store, projectId: number): Ticket | undefined {
    return this.db.prepare("SELECT * FROM tickets WHERE project_id = ? AND kind = 'coordinator' AND coordinator_of IS NULL").get(projectId) as unknown as Ticket | undefined;
  },

  /** A person's own Taskmaster in a scheme, else the Overlord (#919). */
  coordinatorFor(this: Store, projectId: number, userId: number | null): Ticket | undefined {
    return this.db.prepare("SELECT * FROM tickets WHERE project_id = ? AND kind = 'coordinator' AND (coordinator_of = ? OR coordinator_of IS NULL) ORDER BY coordinator_of IS NULL LIMIT 1").get(projectId, userId) as unknown as Ticket | undefined;
  },

  /** Every Taskmaster of a scheme: the owner's, the Overlord, then the others by age. */
  listCoordinators(this: Store, projectId: number): Ticket[] {
    return this.db
      .prepare(`SELECT t.* FROM tickets t JOIN projects p ON p.id = t.project_id WHERE t.project_id = ? AND t.kind = 'coordinator'
      ORDER BY t.coordinator_of IS p.owner_id DESC, t.coordinator_of IS NULL DESC, t.id`)
      .all(projectId) as unknown as Ticket[];
  },

  /** Whether a second person has written to the scheme's Taskmaster (#919, R3): it has one per person since. */
  isSplit(this: Store, projectId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM tickets WHERE project_id = ? AND kind = 'coordinator' AND coordinator_of IS NOT NULL").get(projectId);
  },

  /**
   * A person's own Taskmaster in a scheme, made if missing (#919). The first one splits the scheme: today's
   * Taskmaster becomes the owner's, keeping its session (R2), and a fresh Overlord takes its place. All share the
   * scheme's Taskmaster folder. The caller decides who may have one (routes/projects.ts ensureCoordinatorFor).
   */
  splitScheme(this: Store, projectId: number, userId: number): Ticket {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const own = this.db.prepare("SELECT * FROM tickets WHERE project_id = ? AND kind = 'coordinator' AND coordinator_of = ?").get(projectId, userId) as unknown as Ticket | undefined;
      if (own) {
        this.db.exec('COMMIT');
        return own;
      }
      const first = this.getOverlord(projectId);
      if (!first) throw new Error(`scheme ${projectId} has no Taskmaster to split`);
      const insert = (title: string, of: number | null) => {
        const now = Date.now();
        const r = this.db
          .prepare(`INSERT INTO tickets (project_id, kind, number, title, status, cwd, permission_mode, created_by, created_at, updated_at, coordinator_of, person_id)
          VALUES (?, 'coordinator', NULL, ?, 'new', ?, ?, ?, ?, ?, ?, ?)`)
          .run(projectId, title, first.cwd, first.permission_mode, first.created_by, now, now, of, of);
        return Number(r.lastInsertRowid);
      };
      if (!this.isSplit(projectId)) {
        const owner = this.getProject(projectId)!.owner_id;
        if (owner == null || owner === userId) throw new Error(`scheme ${projectId} splits only for a second person`);
        this.db.prepare('UPDATE tickets SET coordinator_of = ? WHERE id = ?').run(owner, first.id);
        insert('Overlord', null);
      }
      // After the first split `first` is the Overlord: a later member's Taskmaster takes the title of an owner's own, never "Overlord".
      const named = this.db.prepare("SELECT title FROM tickets WHERE project_id = ? AND kind = 'coordinator' AND coordinator_of IS NOT NULL ORDER BY id LIMIT 1").get(projectId) as { title: string } | undefined;
      const id = insert(named?.title ?? 'Coordinator', userId);
      this.db.exec('COMMIT');
      return this.getTicket(id)!;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  },

  /**
   * The person a minion reports to (#919): `assigned`, else `requestedBy`, else nobody (the Overlord). One who no longer
   * hears from the scheme (minionPerson) hands it to the scheme's owner, so it never reports to a gone person's Taskmaster (#1449).
   */
  minionOwner(this: Store, ticket: Pick<Ticket, 'id'>): number | null {
    const props = this.props.forTarget('minion', ticket.id);
    const key = ['assigned', 'requestedBy'].find((k) => String(props[k] ?? '').trim());
    return key ? this.minionPerson(ticket, key) : null;
  },

  /**
   * Who a minion's cards and pings are for (#1449): its `assigned` person (or `key`'s) while they still hear from the
   * scheme; when it names someone who doesn't (taken out of it, disabled, or nobody), the scheme's owner if they
   * do; else null, as for a minion assigned to no one: everyone's. Push, the Needs-you list and minionOwner all ask this.
   */
  minionPerson(this: Store, ticket: Pick<Ticket, 'id'> & Partial<Pick<Ticket, 'project_id'>>, key = 'assigned', props: Record<string, string | number | string[]> = this.props.forTarget('minion', ticket.id), hears = (id: number, pid: number) => this.hearsScheme(id, pid)): number | null {
    const raw = props[key];
    if (!String(raw ?? '').trim()) return null;
    const projectId = ticket.project_id ?? this.getTicket(ticket.id)?.project_id;
    if (projectId == null) return null;
    const id = this.personId(raw);
    if (id != null && hears(id, projectId)) return id;
    const owner = this.getProject(projectId)?.owner_id ?? null;
    return owner != null && hears(owner, projectId) ? owner : null;
  },

  /** Whether a person is still in a scheme: here, enabled, its owner or a member. Admin reach doesn't count; hiding it doesn't take them out (push drops a hidden one itself). */
  hearsScheme(this: Store, userId: number, projectId: number, user: User | undefined = this.getUser(userId)): boolean {
    return !!user && !user.disabled_at && this.memberSchemes(user.id).has(projectId);
  },

  /** The Taskmaster a minion reports to: its owner's own, else the Overlord; a build's own minion, the Overlord (builds are shared, #921). */
  ownerCoordinator(this: Store, ticket: Pick<Ticket, 'id' | 'project_id'>): Ticket | undefined {
    const build = this.getTicket(ticket.id)?.build;
    if (build != null && this.getSetting<number>(buildOwnerKey(ticket.project_id, build)) === ticket.id) return this.getOverlord(ticket.project_id);
    return this.coordinatorFor(ticket.project_id, this.minionOwner(ticket));
  },

  personId(this: Store, value: unknown): number | null {
    const raw = String(value ?? '').trim();
    const name = raw && this.props.personName(raw);
    return (name && this.findUser('name', name)?.id) || null;
  },

  /** A person touched a minion (#919): wrote in it, answered its card, asked for it or took it. Rejoins one they left. */
  touch(this: Store, ticketId: number, userId: number) {
    this.db.prepare('INSERT INTO ticket_touches (ticket_id, user_id, at) VALUES (?, ?, ?) ON CONFLICT (ticket_id, user_id) DO UPDATE SET left_at = NULL').run(ticketId, userId, Date.now());
  },

  /** A person leaves a minion: its updates stop reaching their Taskmaster until they touch it again. */
  leaveTouched(this: Store, ticketId: number, userId: number) {
    this.db.prepare('INSERT INTO ticket_touches (ticket_id, user_id, at, left_at) VALUES (?, ?, ?, ?) ON CONFLICT (ticket_id, user_id) DO UPDATE SET left_at = excluded.left_at').run(ticketId, userId, Date.now(), Date.now());
  },

  /** Everyone touching a minion: the recorded ones plus its requester and assignee, less those who left it or the scheme (#1449). */
  touchedBy(this: Store, ticket: Pick<Ticket, 'id'> & Partial<Pick<Ticket, 'project_id'>>, props: Record<string, string | number | string[]> = this.props.forTarget('minion', ticket.id), hears = (id: number, pid: number) => this.hearsScheme(id, pid)): number[] {
    const rows = scoped(this.db, `touches:${ticket.id}`, () => this.db.prepare('SELECT user_id, left_at FROM ticket_touches WHERE ticket_id = ?').all(ticket.id) as { user_id: number; left_at: number | null }[]);
    const left = new Set(rows.filter((r) => r.left_at != null).map((r) => r.user_id));
    const ids = [...rows.map((r) => r.user_id), this.personId(props.requestedBy), this.personId(props.assigned)];
    const projectId = ticket.project_id ?? this.getTicket(ticket.id)?.project_id;
    return [...new Set(ids)].filter((id): id is number => id != null && !left.has(id) && projectId != null && hears(id, projectId));
  },

  /** Inside a read scope (src/read-scope.ts): touchedBy's rows for every one of `tickets`, in one read. */
  warmTouches(this: Store, tickets: Ticket[]) {
    if (!inScope(this.db) || !tickets.length) return;
    const ids = tickets.map((t) => t.id);
    const rows = this.db.prepare('SELECT ticket_id, user_id, left_at FROM ticket_touches WHERE ticket_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as { ticket_id: number; user_id: number; left_at: number | null }[];
    const by = new Map<number, { user_id: number; left_at: number | null }[]>(ids.map((id) => [id, []]));
    for (const r of rows) by.get(r.ticket_id)!.push({ user_id: r.user_id, left_at: r.left_at });
    warm(
      this.db,
      [...by].map(([id, rs]) => [`touches:${id}`, rs]),
    );
  },

  /** A line for the scheme's other Taskmasters' digests (#919). Lines older than a week go. */
  noteDigest(this: Store, projectId: number, byTicket: number, text: string) {
    const now = Date.now();
    this.db.prepare('DELETE FROM taskmaster_digest WHERE at < ?').run(now - 7 * 86_400_000);
    this.db.prepare('INSERT INTO taskmaster_digest (project_id, by_ticket, at, text) VALUES (?, ?, ?, ?)').run(projectId, byTicket, now, text);
  },

  /** The newest ten lines other Taskmasters of its scheme logged since this one last read, oldest first; marks them read. */
  digestFor(this: Store, coordinatorId: number): string[] {
    const t = this.getTicket(coordinatorId);
    if (!t) return [];
    const key = `digest_read:${coordinatorId}`;
    const since = this.getSetting<number>(key) ?? 0;
    // The bound first, so the mark can't pass a line the query below didn't see (one committed between the two reads).
    const last = (this.db.prepare('SELECT max(id) AS id FROM taskmaster_digest WHERE project_id = ?').get(t.project_id) as { id: number | null }).id;
    if (last == null || last <= since) return [];
    const rows = this.db.prepare('SELECT id, text FROM taskmaster_digest WHERE project_id = ? AND id > ? AND id <= ? AND by_ticket != ? ORDER BY id DESC LIMIT 10').all(t.project_id, since, last, coordinatorId) as { id: number; text: string }[];
    this.setSetting(key, last);
    return rows.reverse().map((r) => r.text);
  },

  /** Inside a read scope (src/read-scope.ts): every one of `ids` in one read, for getTicket. */
  warmTickets(this: Store, ids: number[]) {
    if (!inScope(this.db) || !ids.length) return;
    const rows = this.db.prepare('SELECT * FROM tickets WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as unknown as Ticket[];
    const got = new Map(rows.map((t) => [t.id, t]));
    warm(
      this.db,
      ids.map((id) => [`ticket:${id}`, got.get(id)]),
    );
  },

  getTicket(this: Store, id: number): Ticket | undefined {
    const t = scoped(this.db, `ticket:${id}`, () => this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as unknown as Ticket | undefined);
    return copyRow(t);
  },

  /** Insert a ticket with no working directory yet; call setTicketDir once it exists. */
  createTicket(this: Store, t: Pick<Ticket, 'project_id' | 'title' | 'permission_mode' | 'created_by'> & { kind?: TicketKind }): Ticket {
    const now = Date.now();
    const kind = t.kind ?? 'ticket';
    const r = this.db
      .prepare(
        `INSERT INTO tickets (project_id, kind, number, title, status, cwd, permission_mode, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'new', '', ?, ?, ?, ?)`,
      )
      .run(t.project_id, kind, kind === 'coordinator' ? null : this.nextNumber(t.project_id), t.title, t.permission_mode, t.created_by, now, now);
    if (t.title.includes('status:')) this.noteLooks(Number(r.lastInsertRowid), t.title, now);
    return this.getTicket(Number(r.lastInsertRowid))!;
  },

  setTicketDir(this: Store, id: number, cwd: string, branch: string | null) {
    this.db.prepare('UPDATE tickets SET cwd = ?, branch = ? WHERE id = ?').run(cwd, branch, id);
  },

  /**
   * Who asked for a ticket's current (or last) turn (#255): the person whose ask it carries on, set at
   * each turn's start (src/runner.ts startTurn). Usually whom it runs as; not for a non-member's relay,
   * which runs as the scheme's owner (#211) but is still the non-member's ask.
   */
  turnAsker(this: Store, ticketId: number): number | null {
    return this.getSetting<number>(askerKey(ticketId)) ?? this.getTicket(ticketId)?.person_id ?? null;
  },

  /** Whether a Taskmaster's turn may read every scheme (#656): the Citadel scheme's, on a Citadel member's or admin's ask. */
  readsEveryScheme(this: Store, caller: Pick<Ticket, 'id' | 'kind' | 'project_id'>): boolean {
    return caller.kind === 'coordinator' && caller.project_id === GLOBAL_OWNER && this.isAdmin(this.getUser(this.turnAsker(caller.id) ?? -1));
  },

  /** Record a model and effort pick with its reason (#1061): at a minion's start, and at every change after. */
  addPick(this: Store, ticketId: number, model: string | null, effort: string | null, by: string, reason: string, at = Date.now()) {
    this.db.prepare('INSERT INTO ticket_picks (ticket_id, at, model, effort, by, reason) VALUES (?, ?, ?, ?, ?, ?)').run(ticketId, at, model, effort, by, reason);
  },
  /** A minion's picks, oldest first. */
  picksOf(this: Store, ticketId: number) {
    return this.db.prepare('SELECT at, model, effort, by, reason FROM ticket_picks WHERE ticket_id = ? ORDER BY id').all(ticketId) as { at: number; model: string | null; effort: string | null; by: string; reason: string }[];
  },
  deleteTicket(this: Store, id: number) {
    this.deleteSetting(askerKey(id));
    this.deleteSetting(planKey(id));
    this.deleteSetting(pagePlanKey(id));
    this.deleteSetting(ownMemoryKey(id));
    this.deleteSetting(`runs-on:${id}`);
    this.db.prepare('DELETE FROM events WHERE ticket_id = ?').run(id);
    // The main file's copy from before the move (#1169) still links to tickets, so its rows go too, or the delete below fails.
    if (this.db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'events_old'").get()) this.db.prepare('DELETE FROM main.events_old WHERE ticket_id = ?').run(id);
    this.forgetCards(); // events.id has no AUTOINCREMENT: a deleted newest card's id can come back as a new card
    this.db.prepare('DELETE FROM card_fates').run();
    this.db.prepare('DELETE FROM artifacts WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM claude_state WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM ticket_seen WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM github_seen WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM turn_models WHERE turn_id IN (SELECT id FROM turns WHERE ticket_id = ?)').run(id);
    this.db.prepare('DELETE FROM turn_grunts WHERE turn_id IN (SELECT id FROM turns WHERE ticket_id = ?)').run(id);
    this.db.prepare('DELETE FROM turns WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM ticket_picks WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM brief_starts WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM person_notes WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM ticket_pins WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM step_times WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM wait_records WHERE ticket_id = ?').run(id);
    this.memory.deleteTicket(id);
    this.minionIndex.deleteTicket(id);
    this.claims.releaseHeldBy(id);
    this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  },

  /** Record what a ticket last ran with, without counting as activity (updated_at stays). */
  updateTicketQuietly(this: Store, id: number, fields: Partial<Pick<Ticket, 'last_model' | 'last_effort'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  },

  updateTicket(
    this: Store,
    id: number,
    fields: Partial<Pick<Ticket, 'status' | 'session_id' | 'last_activity' | 'title' | 'state' | 'note' | 'replies' | 'build' | 'parent' | 'model' | 'effort' | 'workflow' | 'plugin_dirs' | 'last_model' | 'last_effort' | 'person_id' | 'picked_because'>>,
    by: ChangeBy = { kind: 'server' },
  ) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => fields[k] ?? null);
    const before = fields.status ? this.getTicket(id)?.status : undefined;
    const was = 'state' in fields ? (this.db.prepare('SELECT state FROM tickets WHERE id = ?').get(id) as Pick<Ticket, 'state'> | undefined) : undefined;
    const now = Date.now();
    // Strictly after every earlier close, so a quick reopen and re-close never lands on the minion index's cursor mark.
    const closedAt = fields.status === 'closed' ? (this.lastClosedAt = Math.max(now, this.lastClosedAt + 1)) : now;
    // The dismissal's time (#1072): stamped when it goes closed, cleared when it opens again.
    const closing = fields.status === 'closed' ? (before === 'closed' ? '' : ', closed_at = ?') : fields.status ? ', closed_at = NULL' : '';
    this.db.prepare(`UPDATE tickets SET ${sets}${closing}, updated_at = ? WHERE id = ?`).run(...values, ...(closing === ', closed_at = ?' ? [closedAt] : []), now, id);
    if (was && was.state !== (fields.state ?? null)) this.addWaitRecord(id, 'state', { at: now, old: was.state, new: fields.state ?? null, by });
    // Dismissing moves the stage to done, reopening back to in-progress.
    if (before && fields.status) this.props.statusChanged(id, before, fields.status);
    if (fields.title?.includes('status:')) this.noteLooks(id, fields.title, now);
  },

  /** A minion's newest "Shipped …" note (LandHandoffs' shipped line), or null: Releases reads a fix shipped without a go from it (#1398). */
  lastShippedNote(this: Store, id: number): string | null {
    // The shipped line names its commit; the dismissal after it ("Shipped and live, so…") starts with Shipped too.
    const rows = this.db.prepare(`SELECT json_extract(data, '$.text') AS text FROM events WHERE ticket_id = ? AND kind = 'note' AND data LIKE '{"text":"Shipped %' ORDER BY id DESC LIMIT 5`).all(id) as { text: string | null }[];
    return rows.find((r) => /^Shipped [0-9a-f]{7,40} /.test(r.text ?? ''))?.text ?? null;
  },

  /** A minion's newest ship onto main (LandHandoffs' shipped line): the commit main moved to (null for "Shipped the branch") and when, or null (#1454). */
  lastShip(this: Store, id: number): { commit: string | null; at: number } | null {
    const rows = this.db.prepare(`SELECT json_extract(data, '$.text') AS text, created_at FROM events WHERE ticket_id = ? AND kind = 'note' AND data LIKE '{"text":"Shipped %' ORDER BY id DESC LIMIT 5`).all(id) as { text: string | null; created_at: number }[];
    for (const r of rows) {
      const m = /^Shipped (?:([0-9a-f]{7,40}) |the branch:)/.exec(r.text ?? '');
      if (m) return { commit: m[1] ?? null, at: r.created_at };
    }
    return null;
  },

  /**
   * #1491: the scheme's minions (not its Taskmasters, which hear of every red) whose chat (people's messages and Claude's own
   * words, not tool output) names any of `needles`, among events after `afterId`; and the newest event id read, for the next
   * call to start from. It reads 500 ids back from `afterId`: an id is handed out before its row is written (reserveEventId).
   * `atMost` caps the newest id read, for a step of a long read or a replay of the past (#1503, tools/judge-replays/ci-red.ts).
   * CROSS JOIN keeps the events' id range in the lead: led by tickets it seeked into every minion of the scheme (1,974 of
   * them for a few hundred new rows), cold off disk, holding the server up to 2 s a poll (#1974).
   */
  minionsNaming(this: Store, projectId: number, needles: string[], afterId: number, atMost = Infinity): { ids: number[]; upTo: number } {
    const upTo = Math.min(atMost, (this.db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined)?.id ?? 0);
    if (!needles.length || upTo <= afterId) return { ids: [], upTo: Math.max(upTo, afterId) };
    const like = needles.map((n) => `%${n.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const rows = this.db
      .prepare(`SELECT DISTINCT e.ticket_id AS id FROM events e CROSS JOIN tickets t ON t.id = e.ticket_id
      WHERE e.id > ? AND e.id <= ? AND t.project_id = ? AND t.kind = 'ticket'
        AND (e.kind = 'user_message' OR (e.kind = 'claude' AND e.data LIKE '{"type":"assistant"%'))
        AND (${like.map(() => `e.data LIKE ? ESCAPE '\\'`).join(' OR ')})`)
      .all(Math.max(0, afterId - 500), upTo, projectId, ...like) as { id: number }[];
    return { ids: rows.map((r) => r.id), upTo };
  },

  /** When a minion's last finished turn ended and whose plan and account it ran on (null: the server login; its first account), as lastTurnEnd; its cache is there. */
  lastTurnOn(this: Store, id: number): { ended_at: number; payer: number | null; account: number | null } | null {
    return scoped(this.db, `last-turn-on:${id}`, () => (this.db.prepare('SELECT ended_at, payer, account FROM turns WHERE ticket_id = ? AND side IS NULL ORDER BY id DESC LIMIT 1').get(id) as { ended_at: number; payer: number | null; account: number | null } | undefined) ?? null);
  },

  /** Change a ticket's activity line without counting it as new activity. */
  setLastActivity(this: Store, id: number, text: string) {
    this.db.prepare('UPDATE tickets SET last_activity = ? WHERE id = ?').run(text, id);
  },
};
