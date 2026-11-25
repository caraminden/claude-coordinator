// What a person has seen and pinned, and the recap of what they missed (#1313: src/db.ts by area).
import { RECAP_AWAY_MS } from '../db-rows.ts';
import { inScope, scoped } from '../read-scope.ts';
import type { Store } from '../db.ts';

export const seenQueries = {
  /** When `name` last looked at each of a project's threads: ticket id -> time. */
  seenTimes(this: Store, name: string, projectId: number): Record<number, number> {
    // In a read scope (#1527) one read for every scheme: the scheme list asked twice a scheme, each walking all their marks.
    if (inScope(this.db)) {
      const all = scoped(this.db, `seen:${name}`, () => this.db.prepare('SELECT s.ticket_id, s.seen_at, t.project_id FROM ticket_seen s JOIN tickets t ON t.id = s.ticket_id WHERE s.name = ?').all(name) as { ticket_id: number; seen_at: number; project_id: number }[]);
      return Object.fromEntries(all.filter((r) => r.project_id === projectId).map((r) => [r.ticket_id, r.seen_at]));
    }
    const rows = this.db.prepare('SELECT s.ticket_id, s.seen_at FROM ticket_seen s JOIN tickets t ON t.id = s.ticket_id WHERE s.name = ? AND t.project_id = ?').all(name, projectId) as { ticket_id: number; seen_at: number }[];
    return Object.fromEntries(rows.map((r) => [r.ticket_id, r.seen_at]));
  },

  /** When `name` last had this minion open, or 0. */
  seenAt(this: Store, name: string, ticketId: number): number {
    const row = this.db.prepare('SELECT seen_at FROM ticket_seen WHERE name = ? AND ticket_id = ?').get(name, ticketId) as { seen_at: number } | undefined;
    return row?.seen_at ?? 0;
  },

  async markSeen(this: Store, name: string, ticketId: number): Promise<number> {
    const now = Date.now();
    this.db.prepare('INSERT INTO ticket_seen (name, ticket_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(name, ticket_id) DO UPDATE SET seen_at = excluded.seen_at').run(name, ticketId, now);
    return now;
  },

  /** The minions `name` pinned in a project, oldest pin first (#179). */
  pinnedTickets(this: Store, name: string, projectId: number): number[] {
    // A pin older than its minion belongs to a deleted one whose id was reused: a rolled-back release's deleteTicket leaves it behind.
    const rows = this.db.prepare('SELECT p.ticket_id FROM ticket_pins p JOIN tickets t ON t.id = p.ticket_id WHERE p.name = ? AND t.project_id = ? AND p.pinned_at >= t.created_at ORDER BY p.pinned_at, p.ticket_id').all(name, projectId) as { ticket_id: number }[];
    return rows.map((r) => r.ticket_id);
  },

  /** Whether `name` pinned this minion, by the same rule as pinnedTickets. */
  isTicketPinned(this: Store, name: string, ticketId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM ticket_pins p JOIN tickets t ON t.id = p.ticket_id WHERE p.name = ? AND p.ticket_id = ? AND p.pinned_at >= t.created_at').get(name, ticketId);
  },

  setTicketPinned(this: Store, name: string, ticketId: number, pinned: boolean) {
    if (pinned) this.db.prepare('INSERT INTO ticket_pins (name, ticket_id, pinned_at) VALUES (?, ?, ?) ON CONFLICT(name, ticket_id) DO NOTHING').run(name, ticketId, Date.now());
    else this.db.prepare('DELETE FROM ticket_pins WHERE name = ? AND ticket_id = ?').run(name, ticketId);
  },

  /** Whether `name` has ever written or acted anywhere (#1151's welcome): recap leaves 0 for "never", so that doesn't count. */
  hasActed(this: Store, name: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM last_actions WHERE name = ? AND at > 0 LIMIT 1').get(name);
  },

  /**
   * For the scheme recap: when `name` last acted anywhere in the scheme (a message, a card answer or
   * plan verdict, which are messages too, or an approval click), and how many turns each thread
   * has finished since. `since` is null if they never have.
   */
  recap(this: Store, name: string, projectId: number): { since: number | null; turns: Record<number, number> } {
    let row = this.db.prepare('SELECT at FROM last_actions WHERE name = ? AND project_id = ?').get(name, projectId) as { at: number } | undefined;
    if (!row) {
      // Once per person and scheme: from before last_actions, read from the events (1.5 s cold for Citadel, #538). 0: never acted.
      const { since } = this.db
        .prepare(`
        SELECT MAX(e.created_at) AS since FROM events e INDEXED BY events_ticket_kind JOIN tickets t ON t.id = e.ticket_id
        WHERE t.project_id = ? AND e.kind IN ('user_message', 'approval_result') AND (
          (e.kind = 'user_message' AND json_extract(e.data, '$.author') = ?)
          OR (e.kind = 'approval_result' AND json_extract(e.data, '$.by') = ?))`)
        .get(projectId, name, name) as { since: number | null };
      row = { at: since ?? 0 };
      this.db.prepare('INSERT INTO last_actions (name, project_id, at) VALUES (?, ?, ?) ON CONFLICT (name, project_id) DO UPDATE SET at = MAX(at, excluded.at)').run(name, projectId, row.at);
    }
    const since = row.at || null;
    // The page shows the recap only after RECAP_AWAY_MS without an action, so the count isn't read before then:
    // it reads every Claude event in the scheme since (0.3 s warm for Citadel, #538).
    if (since == null || Date.now() - since < RECAP_AWAY_MS) return { since, turns: {} };
    // Event ids grow with time, so start after the last turn that ended by `since` (turns_ended finds it): the index skips everything older.
    const before = this.db.prepare('SELECT event_id FROM turns WHERE ended_at <= ? AND event_id IS NOT NULL ORDER BY ended_at DESC LIMIT 1').get(since) as { event_id: number } | undefined;
    const rows = this.db
      .prepare(`
      SELECT e.ticket_id, COUNT(*) AS n FROM events e INDEXED BY events_ticket_kind JOIN tickets t ON t.id = e.ticket_id
      WHERE t.project_id = ? AND e.kind = 'claude' AND e.id > ? AND e.created_at > ? AND json_extract(e.data, '$.type') = 'result'
      GROUP BY e.ticket_id`)
      .all(projectId, before?.event_id ?? 0, since) as { ticket_id: number; n: number }[];
    return { since, turns: Object.fromEntries(rows.map((r) => [r.ticket_id, r.n])) };
  },
};
