// Flake sightings' errors (#1438, src/flake-evidence.ts).
import type { Store } from '../db.ts';

export const flakeQueries = {
  /** A file's most common error messages since `since` with their test, class and count, then how many sightings kept none (rows from before #1438, and runs whose log was gone: "no message kept"). */
  flakeMessages(this: Store, projectId: number, file: string, since: number, n = 3): { messages: { message: string; test: string; cls: string; count: number }[]; none: number } {
    const messages = this.db.prepare(`SELECT message, MAX(test_name) AS test, MAX(class) AS cls, COUNT(*) AS count FROM flake_events
      WHERE project_id = ? AND file = ? AND at >= ? AND message != '' GROUP BY message ORDER BY count DESC, MAX(at) DESC LIMIT ?`).all(projectId, file, since, n) as any;
    const none = (this.db.prepare("SELECT COUNT(*) AS c FROM flake_events WHERE project_id = ? AND file = ? AND at >= ? AND message = ''").get(projectId, file, since) as any).c;
    return { messages, none };
  },
};
