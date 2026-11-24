// A person's saved views of a scheme's minions list (#1313: src/db.ts by area).
import type { SavedView, Store } from '../db.ts';

export const viewQueries = {
  listViews(this: Store, projectId: number, owner: string): SavedView[] {
    const rows = this.db.prepare('SELECT * FROM person_views WHERE project_id = ? AND owner = ? ORDER BY name COLLATE NOCASE').all(projectId, owner) as any[];
    return rows.map((r) => ({ ...r, picks: JSON.parse(r.picks) }));
  },

  /** Save the picks under a name; saving under a name this person already has replaces that view. */
  saveView(this: Store, projectId: number, owner: string, name: string, picks: SavedView['picks']) {
    this.db.prepare('INSERT INTO person_views (project_id, owner, name, picks, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, owner, name) DO UPDATE SET picks = excluded.picks, created_at = excluded.created_at').run(projectId, owner, name, JSON.stringify(picks), Date.now());
  },

  deleteView(this: Store, projectId: number, owner: string, id: number): boolean {
    return this.db.prepare('DELETE FROM person_views WHERE project_id = ? AND owner = ? AND id = ?').run(projectId, owner, id).changes > 0;
  },
};
