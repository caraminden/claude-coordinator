// One-time sweep of a scheme's handoffs/ backlog (#1371). Files only move, never get deleted.
//   node tools/handoffs-sweep.ts --db <coordinator.db> --shared <shared/project dir> --project <id> [--memory <dir>]... [--apply]
// Without --apply it prints the plan: counts, what moves where, what stays and why, and what is listed for a person
// (unmatched files older than 14 days). With --apply it moves the files; the server's next minute tick points its
// started-brief and ideas rows at the new places (reconcileMoved). It reads the database read-only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findBriefs } from '../public/briefs.js';
import { handoffIn } from '../src/ideas.ts';
import { spokenText } from '../src/memory.ts';
import { isLoose, markedNotPicked, moveFile, NOT_PICKED, SHIPPED } from '../src/handoff-tidy.ts';
import { attachEventsIfThere } from '../src/events-db.ts';

const DAY = 86_400_000;

export interface Plan { shipped: string[]; notPicked: string[]; keep: { rel: string; why: string }[]; listed: string[]; total: number }

/** The plan for one scheme's handoffs/, from its closed and open minions' first messages. */
export function planSweep(db: DatabaseSync, projectId: number, shared: string, memoryText: string[], now = Date.now()): Plan {
  const first = (status: string) => (db.prepare(`SELECT t.number, (SELECT data FROM events e WHERE e.ticket_id = t.id AND e.kind = 'user_message' ORDER BY e.id LIMIT 1) AS first
    FROM tickets t WHERE t.project_id = ? AND t.kind = 'ticket' AND t.status ${status}`).all(projectId) as { number: number; first: string | null }[]);
  const open = first("!= 'closed'");
  const closed = first("= 'closed'");
  const pins = (db.prepare('SELECT path FROM shared_pins WHERE project_id = ?').all(projectId) as { path: string }[]).map((p) => p.path);
  const started = (rel: string) => new Set((db.prepare('SELECT heading FROM brief_starts WHERE project_id = ? AND path = ? AND ticket_id IS NOT NULL').all(projectId, join(shared, rel)) as { heading: string }[]).map((r) => r.heading));
  const plan: Plan = { shipped: [], notPicked: [], keep: [], listed: [], total: 0 };
  let names: string[] = [];
  try { names = readdirSync(join(shared, 'handoffs')).filter((n) => n.endsWith('.md')); } catch { /* none */ }
  for (const n of names.sort()) {
    const rel = `handoffs/${n}`;
    if (!isLoose(rel)) continue;
    plan.total++;
    const text = readFileSync(join(shared, rel), 'utf8');
    const named = (m: { first: string | null }) => !!m.first?.includes(rel);
    const o = open.find(named);
    if (pins.includes(rel) || pins.includes(join(shared, rel))) { plan.keep.push({ rel, why: 'pinned' }); continue; }
    if (o) { plan.keep.push({ rel, why: `named by open #${o.number}'s brief` }); continue; }
    if (memoryText.some((t) => t.includes(rel) || t.includes(n))) { plan.keep.push({ rel, why: 'named in memory' }); continue; }
    const headed = findBriefs(text, n).filter((b: { heading: string }) => b.heading);
    const done = started(rel);
    if (headed.length > 1 && headed.some((b: { heading: string }) => !done.has(b.heading))) { plan.keep.push({ rel, why: 'briefs still unstarted' }); continue; }
    if (markedNotPicked(text)) { plan.notPicked.push(rel); continue; }
    // A closed minion started from it: the handoff its brief names first (as the live hook reads it), not one it merely mentions.
    const c = closed.find((m) => { try { return handoffIn(spokenText('user_message', JSON.parse(m.first ?? 'null')), shared) === rel; } catch { return false; } });
    if (c) { plan.shipped.push(rel); continue; }
    if (now - statSync(join(shared, rel)).mtimeMs > 14 * DAY) plan.listed.push(rel);
  }
  return plan;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const dbPath = get('--db'), shared = get('--shared'), project = Number(get('--project'));
  if (!dbPath || !shared || !project) { console.error('usage: handoffs-sweep.ts --db <db> --shared <dir> --project <id> [--memory <dir>]... [--apply]'); process.exit(2); }
  const memory: string[] = [];
  args.forEach((a, i) => {
    if (a !== '--memory') return;
    for (const n of readdirSync(args[i + 1])) if (n.endsWith('.md')) memory.push(readFileSync(join(args[i + 1], n), 'utf8'));
  });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  attachEventsIfThere(db, dbPath);
  const plan = planSweep(db, project, shared, memory);
  const sample = (l: string[]) => l.slice(0, 8).map((x) => `    ${x}`).join('\n');
  console.log(`handoffs/ holds ${plan.total} loose files.\n  move to shipped/: ${plan.shipped.length}\n${sample(plan.shipped)}\n  move to not-picked/: ${plan.notPicked.length}\n${sample(plan.notPicked)}\n  stay (pinned, named by an open brief or memory, briefs unstarted): ${plan.keep.length}\n${sample(plan.keep.map((k) => `${k.rel} (${k.why})`))}\n  unmatched and older than 14 days, listed for a person: ${plan.listed.length}\n${sample(plan.listed)}\n  left alone (unmatched, newer): ${plan.total - plan.shipped.length - plan.notPicked.length - plan.keep.length - plan.listed.length}`);
  if (process.argv.includes('--apply')) {
    for (const r of plan.shipped) moveFile(shared, r, SHIPPED);
    for (const r of plan.notPicked) moveFile(shared, r, NOT_PICKED);
    const left = readdirSync(join(shared, 'handoffs')).filter((n) => n.endsWith('.md')).length;
    console.log(`\nMoved ${plan.shipped.length + plan.notPicked.length}. handoffs/ now holds ${left} loose files.`);
  } else console.log('\n(dry run: nothing moved)');
}
