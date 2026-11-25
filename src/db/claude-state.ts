// Claude state saved for people's containers (#1313: src/db.ts by area).
import { type ClaudeStateRow, PUT_CLAUDE_STATE } from '../db-rows.ts';
import type { Store } from '../db.ts';

export const claudeStateQueries = {
  /** Session state rows without their data: a ticket's own, or the project's shared ones (ticketId null). */
  listClaudeState(this: Store, projectId: number, ticketId: number | null): ClaudeStateRow[] {
    return (ticketId === null
      ? this.db.prepare('SELECT path, project_id, ticket_id, size, mtime FROM claude_state WHERE project_id = ? AND ticket_id IS NULL').all(projectId)
      : this.db.prepare('SELECT path, project_id, ticket_id, size, mtime FROM claude_state WHERE project_id = ? AND ticket_id = ?').all(projectId, ticketId)) as unknown as ClaudeStateRow[];
  },

  getClaudeState(this: Store, path: string, withData = false): ClaudeStateRow | undefined {
    const cols = withData ? '*' : 'path, project_id, ticket_id, size, mtime';
    return this.db.prepare(`SELECT ${cols} FROM claude_state WHERE path = ?`).get(path) as unknown as ClaudeStateRow | undefined;
  },

  putClaudeState(this: Store, row: Required<ClaudeStateRow>) {
    this.db.prepare(PUT_CLAUDE_STATE).run(row.path, row.project_id, row.ticket_id, row.size, row.mtime, row.data);
  },

  deleteClaudeState(this: Store, path: string) {
    this.db.prepare('DELETE FROM claude_state WHERE path = ?').run(path);
  },
};
