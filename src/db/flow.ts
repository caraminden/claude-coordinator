// The Flow tab's rows (#1989, src/work-flow.ts).
import type { Store } from '../db.ts';

export interface FlowRow {
  id: number;
  number: number;
  title: string;
  type: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  /** Why it closed, in one word, when it was saved (`closedAs`). */
  why: string | null;
  /** Every turn's cost, a killed turn's estimate too (#1938). */
  cost: number;
  /** A release or an app's deploy that went live names it. */
  live: number;
  /** The major build it is in. */
  build: number | null;
  /** A pull request of its own merged; which branch into isn't kept. */
  merged_pr: number;
}

export const flowQueries = {
  /** A scheme's minions started in [from, to), newest first. */
  flowRows(this: Store, projectId: number, from: number, to: number): FlowRow[] {
    return this.db
      .prepare(`WITH live AS (
          SELECT DISTINCT json_extract(c.value, '$.number') AS number FROM releases r, json_each(r.changes) c WHERE r.project_id = :p AND r.outcome = 'live' AND r.live_at >= :from
        ), deployed AS (
          SELECT DISTINCT json_extract(c.value, '$.ticketId') AS id FROM contraption_deploys d, json_each(d.changes) c WHERE d.outcome = 'deployed' AND d.finished_at >= :from
        )
        SELECT t.id, t.number, t.title, t.status, t.build, t.created_at, t.updated_at,
          (SELECT p.value FROM properties p JOIN property_keys pk ON pk.id = p.key_id WHERE p.target_type = 'minion' AND p.target_id = t.id AND pk.key = 'type' LIMIT 1) AS type,
          (SELECT p.value FROM properties p JOIN property_keys pk ON pk.id = p.key_id WHERE p.target_type = 'minion' AND p.target_id = t.id AND pk.scope IS NULL AND pk.key = 'closedAs' LIMIT 1) AS why,
          (SELECT COALESCE(SUM(u.cost_usd), 0) FROM turns u WHERE u.ticket_id = t.id) AS cost,
          (t.number IN (SELECT number FROM live) OR t.id IN (SELECT id FROM deployed)) AS live,
          EXISTS (SELECT 1 FROM github_seen g WHERE g.ticket_id = t.id AND g.key GLOB 'pr*:state:MERGED:*') AS merged_pr
        FROM tickets t WHERE t.project_id = :p AND t.kind = 'ticket' AND t.number IS NOT NULL AND t.created_at >= :from AND t.created_at < :to
        ORDER BY t.number DESC`)
      .all({ p: projectId, from, to }) as unknown as FlowRow[];
  },
};
