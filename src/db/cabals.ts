// Cabal boards (#2090): what is written on a cabal's board, keyed by its lead (the Overseer). Each member's row, notes,
// asks, the lead's log and its red-run line. What is derived from facts (state, merges, claims, spend, risk) is
// src/cabal-board.ts's, read when the board is read.
import type { Store } from '../db.ts';

export interface CabalRow {
  lead_id: number;
  project_id: number;
  name: string;
  red: string | null;
  red_at: number | null;
  /** How many members may be open at once (#2091); a start past it waits as next up. */
  width: number;
  created_at: number;
}

/** A roster row: a planned member (ticket_id null) or a started one. */
export interface CabalMemberRow {
  id: number;
  lead_id: number;
  ticket_id: number | null;
  label: string;
  title: string;
  lane: string;
  /** What it waits on, as the lead wrote it (a label or #N); a started member's start_after wins over it. */
  after: string;
  /** The files it expects to touch, one per line (a goal cabal's claims). */
  files: string;
  role: string;
  note: string;
  note_at: number | null;
  pos: number;
  /** Its start (#2091): the handoff in the shared folder, its model, effort and expected dollars. */
  handoff: string;
  model: string;
  effort: string;
  cost: number | null;
  /** Who said go on the forming card that approved it, and when; null until then. */
  approved_by: string | null;
  approved_at: number | null;
  /** Started past the cabal's width: it waits as next up from then. */
  next_at: number | null;
  created_at: number;
}

export interface CabalAsk {
  id: number;
  lead_id: number;
  ticket_id: number;
  text: string;
  blocking: number;
  opened_at: number;
  answer: string | null;
  answered_at: number | null;
  answered_by: string | null;
}

export interface CabalLogLine {
  id: number;
  lead_id: number;
  at: number;
  by: string;
  text: string;
}

export type CabalRowFields = Partial<Pick<CabalMemberRow, 'ticket_id' | 'label' | 'title' | 'lane' | 'after' | 'files' | 'role' | 'note' | 'note_at' | 'pos' | 'handoff' | 'model' | 'effort' | 'cost' | 'approved_by' | 'approved_at' | 'next_at'>>;
const ROW_FIELDS = ['ticket_id', 'label', 'title', 'lane', 'after', 'files', 'role', 'note', 'note_at', 'pos', 'handoff', 'model', 'effort', 'cost', 'approved_by', 'approved_at', 'next_at'] as const;

export const cabalQueries = {
  getCabal(this: Store, leadId: number): CabalRow | undefined {
    return this.db.prepare('SELECT * FROM cabals WHERE lead_id = ?').get(leadId) as CabalRow | undefined;
  },

  /** The leads of a scheme's open cabals: a board whose lead isn't dismissed. */
  openCabalLeads(this: Store, projectId: number): number[] {
    return (this.db.prepare("SELECT c.lead_id AS id FROM cabals c JOIN tickets t ON t.id = c.lead_id WHERE c.project_id = ? AND t.status != 'closed' ORDER BY c.lead_id").all(projectId) as { id: number }[]).map((r) => r.id);
  },

  /** The lead's board, made the first time it is needed. */
  ensureCabal(this: Store, leadId: number, projectId: number, at = Date.now()): CabalRow {
    this.db.prepare('INSERT INTO cabals (lead_id, project_id, created_at) VALUES (?, ?, ?) ON CONFLICT (lead_id) DO NOTHING').run(leadId, projectId, at);
    return this.getCabal(leadId)!;
  },

  setCabalName(this: Store, leadId: number, name: string) {
    this.db.prepare('UPDATE cabals SET name = ? WHERE lead_id = ?').run(name, leadId);
  },

  /** The red-run line pinned on top of the board; null clears it. */
  setCabalWidth(this: Store, leadId: number, width: number) {
    this.db.prepare('UPDATE cabals SET width = ? WHERE lead_id = ?').run(width, leadId);
  },

  setCabalRed(this: Store, leadId: number, red: string | null, at = Date.now()) {
    this.db.prepare('UPDATE cabals SET red = ?, red_at = ? WHERE lead_id = ?').run(red, red == null ? null : at, leadId);
  },

  cabalRows(this: Store, leadId: number): CabalMemberRow[] {
    return this.db.prepare('SELECT * FROM cabal_rows WHERE lead_id = ? ORDER BY pos, id').all(leadId) as unknown as CabalMemberRow[];
  },

  cabalRow(this: Store, id: number): CabalMemberRow | undefined {
    return this.db.prepare('SELECT * FROM cabal_rows WHERE id = ?').get(id) as CabalMemberRow | undefined;
  },

  /** A started minion's own row, so its cabal: the minion's membership. */
  cabalRowOf(this: Store, ticketId: number): CabalMemberRow | undefined {
    return this.db.prepare('SELECT * FROM cabal_rows WHERE ticket_id = ?').get(ticketId) as CabalMemberRow | undefined;
  },

  addCabalRow(this: Store, leadId: number, fields: CabalRowFields, at = Date.now()): number {
    const pos = fields.pos ?? (this.db.prepare('SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM cabal_rows WHERE lead_id = ?').get(leadId) as { p: number }).p;
    const r = this.db.prepare('INSERT INTO cabal_rows (lead_id, pos, created_at) VALUES (?, ?, ?)').run(leadId, pos, at);
    const id = Number(r.lastInsertRowid);
    this.updateCabalRow(id, fields);
    return id;
  },

  updateCabalRow(this: Store, id: number, fields: CabalRowFields) {
    const keys = ROW_FIELDS.filter((k) => fields[k] !== undefined);
    if (!keys.length) return;
    this.db.prepare(`UPDATE cabal_rows SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  },

  deleteCabalRow(this: Store, id: number) {
    this.db.prepare('DELETE FROM cabal_rows WHERE id = ?').run(id);
  },

  /**
   * Put a minion on a lead's board (create_ticket or update_ticket with cabal): a roster row with its label or title and no
   * minion yet becomes its row (`rowId`'s first: cabal_start's row, #2091), else it gets a new one. Moving cabals keeps its
   * note. Returns the row's id.
   */
  joinCabal(this: Store, ticketId: number, leadId: number, projectId: number, title: string, at = Date.now(), rowId?: number): number {
    this.ensureCabal(leadId, projectId, at);
    const own = this.cabalRowOf(ticketId);
    if (own?.lead_id === leadId) return own.id;
    if (own) this.db.prepare('DELETE FROM cabal_rows WHERE id = ?').run(own.id);
    const open = this.cabalRows(leadId).filter((r) => r.ticket_id == null);
    const planned = open.find((r) => r.id === rowId) ?? open.find((r) => r.title.trim().toLowerCase() === title.trim().toLowerCase());
    if (planned) {
      this.updateCabalRow(planned.id, { ticket_id: ticketId, ...(own?.note && !planned.note ? { note: own.note, note_at: own.note_at } : {}) });
      return planned.id;
    }
    return this.addCabalRow(leadId, { ticket_id: ticketId, title: '', note: own?.note ?? '', note_at: own?.note_at ?? null }, at);
  },

  /** Take a minion off its cabal: a roster row the lead planned stays, unstarted; one made for it goes. */
  leaveCabal(this: Store, ticketId: number) {
    const own = this.cabalRowOf(ticketId);
    if (!own) return;
    if (own.label || own.title) this.updateCabalRow(own.id, { ticket_id: null });
    else this.deleteCabalRow(own.id);
  },

  /** Whether a minion leads a board or is on one: its turns then list cabal_board. */
  inCabal(this: Store, ticketId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM cabals WHERE lead_id = ? UNION ALL SELECT 1 FROM cabal_rows WHERE ticket_id = ? LIMIT 1').get(ticketId, ticketId);
  },

  cabalAsks(this: Store, leadId: number, openOnly = true): CabalAsk[] {
    return this.db.prepare(`SELECT * FROM cabal_asks WHERE lead_id = ?${openOnly ? ' AND answered_at IS NULL' : ''} ORDER BY id`).all(leadId) as unknown as CabalAsk[];
  },

  cabalAsk(this: Store, id: number): CabalAsk | undefined {
    return this.db.prepare('SELECT * FROM cabal_asks WHERE id = ?').get(id) as CabalAsk | undefined;
  },

  addCabalAsk(this: Store, leadId: number, ticketId: number, text: string, blocking: boolean, at = Date.now()): number {
    return Number(this.db.prepare('INSERT INTO cabal_asks (lead_id, ticket_id, text, blocking, opened_at) VALUES (?, ?, ?, ?, ?)').run(leadId, ticketId, text, blocking ? 1 : 0, at).lastInsertRowid);
  },

  answerCabalAsk(this: Store, id: number, answer: string, by: string, at = Date.now()) {
    this.db.prepare('UPDATE cabal_asks SET answer = ?, answered_at = ?, answered_by = ? WHERE id = ?').run(answer, at, by, id);
  },

  /** The lead's log, oldest first: the newest `last` lines. */
  cabalLog(this: Store, leadId: number, last = 20): CabalLogLine[] {
    return (this.db.prepare('SELECT * FROM cabal_log WHERE lead_id = ? ORDER BY id DESC LIMIT ?').all(leadId, last) as unknown as CabalLogLine[]).reverse();
  },

  addCabalLog(this: Store, leadId: number, by: string, text: string, at = Date.now()): number {
    return Number(this.db.prepare('INSERT INTO cabal_log (lead_id, at, by, text) VALUES (?, ?, ?, ?)').run(leadId, at, by, text).lastInsertRowid);
  },

  /** A deleted minion's board and rows (Store.deleteTicket). */
  deleteCabalOf(this: Store, ticketId: number) {
    for (const t of ['cabal_log', 'cabal_asks', 'cabal_rows']) this.db.prepare(`DELETE FROM ${t} WHERE lead_id = ?`).run(ticketId);
    this.db.prepare('DELETE FROM cabals WHERE lead_id = ?').run(ticketId);
    this.db.prepare('DELETE FROM cabal_asks WHERE ticket_id = ?').run(ticketId);
    this.leaveCabal(ticketId);
  },
};
