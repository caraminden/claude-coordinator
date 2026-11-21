// Handoffs tidy themselves (#1371): once the minion started from a handoff has closed, the file moves from
// handoffs/ to handoffs/shipped/, so the folder holds only briefs that could still be started. Files only move,
// never get deleted. Every scheme's shared folder gets this; the one-time sweep of a backlog is tools/handoffs-sweep.ts.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findBriefs } from '../public/briefs.js';
import type { Store } from './db.ts';
import { handoffIn } from './ideas.ts';
import { projectSharedDir } from './workspace.ts';

export const SHIPPED = 'handoffs/shipped';
export const NOT_PICKED = 'handoffs/not-picked';

/** A handoff directly in handoffs/ (not already filed in a subfolder). */
export const isLoose = (rel: string) => /^handoffs\/[^/]+\.md$/.test(rel);

/** A file that says up top it was not picked ("**Not picked (2026-11-12): …**"): it goes to not-picked/, not shipped/. */
export const markedNotPicked = (text: string) => text.split('\n').filter((l) => l.trim()).slice(0, 6).some((l) => /^[\s>*_#-]*not picked\b/i.test(l));

export interface Keep { rel: string; why: string }

/**
 * Why `rel` must stay put, or null when it may move: pinned, named by an open minion's brief or by any of
 * `extraText` (the Taskmaster's memory), or a file with several briefs of which some are still unstarted.
 */
export function whyKeep(store: Store, projectId: number, shared: string, rel: string, extraText: string[] = []): string | null {
  if (store.sharedPins(projectId).some((p) => p.path === rel || p.path === join(shared, rel))) return 'pinned';
  const open = store.db.prepare(`SELECT t.number, (SELECT data FROM events e WHERE e.ticket_id = t.id AND e.kind = 'user_message' ORDER BY e.id LIMIT 1) AS first
    FROM tickets t WHERE t.project_id = ? AND t.kind = 'ticket' AND t.status != 'closed'`).all(projectId) as { number: number; first: string | null }[];
  for (const o of open) if (o.first?.includes(rel)) return `named by open #${o.number}'s brief`;
  if (extraText.some((t) => t.includes(rel) || t.includes(basename(rel)))) return 'named in memory';
  let src = '';
  try { src = readFileSync(join(shared, rel), 'utf8'); } catch { return 'unreadable'; }
  const headed = findBriefs(src, basename(rel)).filter((b: { heading: string }) => b.heading);
  if (headed.length > 1) {
    return `${headed.length} of ${headed.length} briefs unstarted`;
  }
  return null;
}

/** Move one file under `dest` (handoffs/shipped or handoffs/not-picked), keeping its name; a clash gets the mtime day. */
export function moveFile(shared: string, rel: string, dest: string): string {
  mkdirSync(join(shared, dest), { recursive: true });
  let to = `${dest}/${basename(rel)}`;
  // A clash never overwrites: the mtime day, then a counter, in front of the name.
  const day = new Date(statSync(join(shared, rel)).mtimeMs).toISOString().slice(0, 10);
  for (let n = 0; existsSync(join(shared, to)); n++) to = `${dest}/${day}${n ? `-${n}` : ''}-${basename(rel)}`;
  renameSync(join(shared, rel), join(shared, to));
  return to;
}

/** A closed minion's brief named a handoff: file it as shipped unless something says it stays. Returns where it went. */
export function tidyForClosed(store: Store, dataDir: string, projectId: number, briefText: string, extraText: string[] = []): string | null {
  const shared = projectSharedDir(dataDir, projectId);
  const rel = handoffIn(briefText, shared);
  if (!rel || !isLoose(rel) || !existsSync(join(shared, rel))) return null;
  if (whyKeep(store, projectId, shared, rel, extraText)) return null;
  let text = '';
  try { text = readFileSync(join(shared, rel), 'utf8'); } catch { return null; }
  const to = moveFile(shared, rel, markedNotPicked(text) ? NOT_PICKED : SHIPPED);
  relocate(store, projectId, shared, rel, to);
  return to;
}

/** Point the rows that name a moved file (started briefs, the ideas ledger) at its new place. */
export function relocate(store: Store, projectId: number, shared: string, from: string, to: string) {
  store.db.prepare('UPDATE OR IGNORE brief_starts SET path = ? WHERE project_id = ? AND path = ?').run(join(shared, to), projectId, join(shared, from));
  store.db.prepare('UPDATE ideas SET handoff = ? WHERE project_id = ? AND handoff = ?').run(to, projectId, from);
  const loose = store.db.prepare("SELECT id FROM ideas WHERE project_id = ? AND page = '' AND card = ?").get(projectId, from) as { id: number } | undefined;
  const twin = store.db.prepare("SELECT id FROM ideas WHERE project_id = ? AND page = '' AND card = ?").get(projectId, to) as { id: number } | undefined;
  if (loose && !twin) store.db.prepare('UPDATE ideas SET card = ? WHERE id = ?').run(to, loose.id);
  // A second row already made for the moved file (#1432): the twin keeps what it has, takes what only the loose row has, and the loose row goes.
  else if (loose && twin) {
    const get = (id: number) => store.db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as Record<string, unknown>;
    const [l, t] = [get(loose.id), get(twin.id)];
    // Each group comes whole from one row, so a pick never mixes two people's decisions or a link two minions'.
    const groups = [['pick', 'pick_label', 'decided_by', 'words', 'decided_at'], ['status_manual', 'manual_by', 'manual_at'], ['ticket_id', 'number', 'link_manual']];
    const takeLoose = [t.pick == null && l.pick != null, t.status_manual == null && l.status_manual != null, l.link_manual === 1 || (t.ticket_id == null && l.ticket_id != null)];
    groups.forEach((cols, i) => { if (takeLoose[i]) store.db.prepare(`UPDATE ideas SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => l[c] as string | number | null), twin.id); });
    if (!t.title && l.title) store.db.prepare('UPDATE ideas SET title = ? WHERE id = ?').run(l.title as string, twin.id);
    store.db.prepare('DELETE FROM ideas WHERE id = ?').run(loose.id);
  }
}

/**
 * Rows still naming a handoff that is gone from handoffs/ but sits in shipped/ or not-picked/ (the sweep moves files only):
 * follow it. `has` answers whether a handoff is at a path relative to the shared folder; the minute's pass hands it the
 * listing syncHandoffs just made, so the check costs no file call on the server's thread (#1463).
 */
export function reconcileMoved(store: Store, dataDir: string, projectId: number, has?: (rel: string) => boolean) {
  const shared = projectSharedDir(dataDir, projectId);
  const exists = has ?? ((rel: string) => existsSync(join(shared, rel)));
  const where = (rel: string) => [SHIPPED, NOT_PICKED].map((d) => `${d}/${basename(rel)}`).find(exists);
  const gone = (rel: string) => isLoose(rel) && !exists(rel);
  const rels = new Set<string>();
  for (const r of store.db.prepare('SELECT DISTINCT path FROM brief_starts WHERE project_id = ?').all(projectId) as { path: string }[]) {
    if (r.path.startsWith(`${shared}/`)) rels.add(r.path.slice(shared.length + 1));
  }
  for (const r of store.db.prepare("SELECT handoff FROM ideas WHERE project_id = ? AND handoff LIKE 'handoffs/%'").all(projectId) as { handoff: string }[]) rels.add(r.handoff);
  for (const rel of rels) {
    if (!gone(rel)) continue;
    const to = where(rel);
    if (!to) continue;
    // One file's failure must not skip the scheme's other files.
    try { relocate(store, projectId, shared, rel, to); } catch (e) { console.error(`handoff tidy: ${rel}: ${(e as Error).message}`); }
  }
}
