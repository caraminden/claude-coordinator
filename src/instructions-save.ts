// Saving the Settings text from a minion's edit_instructions (#961), and holding an edit that repeats what is already
// written elsewhere on a card first (#1162; Josh, 2026-11-20: "Matcher, then a Grunt", "All three", "Hold it on a card").
// The matcher is src/rule-overlap.ts; the turn's own Sonnet Grunt adds what it found as `overlaps`.
import { join } from 'node:path';
import { APP_NAME } from './appname.ts';
import { recheckDecisions } from './decisions-load.ts';
import { GLOBAL_OWNER } from './properties.ts';
import { added, inSettingsHome, overlapsFor, settingsSources, type Overlap } from './rule-overlap.ts';
import type { App } from './http.ts';
import type { Project } from './db.ts';

const ROOT = join(import.meta.dirname, '..');

export type Scope = 'citadel' | 'scheme';
export interface FindReplace { find: string; replace: string }

/** What a held edit's card carries, so Save anyway can save exactly what was shown. */
export interface HeldEdit { scope: Scope; project: number; old: string; text: string; edits: FindReplace[]; by: string; count: number }

/** Save through Settings' own setters and history, then tell the chat, the Taskmasters and open pages. */
export function saveInstructions(app: App, ticketId: number, held: Omit<HeldEdit, 'count'>, by = held.by): void {
  const { store, runner } = app;
  const citadel = held.scope === 'citadel';
  if (citadel) store.setAppInstructions(held.text, by);
  else store.setProjectInstructions(held.project, held.text, by);
  recheckDecisions(app, citadel ? store.listProjects() : [store.getProject(held.project)!]);
  const where = citadel ? `${APP_NAME}-wide` : 'scheme';
  const cut = (t: string) => (t.length > 2000 ? `${t.slice(0, 2000)}… (${t.length - 2000} more characters)` : t);
  const shown = held.edits.map((e, i) => `${i + 1}. Before: ${cut(e.find)}\n   After: ${cut(e.replace)}`).join('\n');
  runner.emit(ticketId, 'note', { text: `Saved the ${where} Settings text as ${by}; it applies from each minion's next turn.\n${shown}` });
  const note = `${by} ${held.text ? 'updated' : 'cleared'} the ${where} instructions; they apply from each minion's next turn.`;
  const tell = (pid: number) => { const c = store.getOverlord(pid); if (c) runner.emit(c.id, 'note', { everyone: true, text: note }); };
  if (citadel) {
    for (const p of store.listProjects()) tell(p.id);
    app.broadcast({ type: 'app-instructions', instructions: store.appInstructions() });
  } else {
    tell(held.project);
    app.broadcast({ type: 'project', project: store.getProject(held.project)! });
  }
}

/**
 * What already speaks to an edit's new words: a registered rule outside its home, or a paragraph elsewhere sharing a
 * run of words or most of its words. The sections of the edited text that the edit touches are left out, so a new
 * bullet isn't flagged against its own neighbours.
 */
export function settingsOverlaps(app: Pick<App, 'store'>, project: Project, scope: Scope, before: string, text: string): Overlap[] {
  const { store } = app;
  const news = added(before, text);
  if (!news.length) return [];
  const lines = text.split('\n');
  const touched = new Set(news.map((p) => sectionStart(lines, p.line)));
  const rest = lines.map((l, i) => (touched.has(sectionStart(lines, i + 1)) ? '' : l)).join('\n');
  const other = scope === 'citadel' ? project.instructions ?? '' : store.appInstructions().text;
  const sources = settingsSources({ root: ROOT, citadelUrl: store.getProject(GLOBAL_OWNER)?.repo_url ?? null, pid: project.id, repo: project.repo_dir, repoUrl: project.repo_url, scope, text: rest, other });
  return overlapsFor(news, sources, inSettingsHome(scope, text));
}

/** The line of the heading a 1-based line sits under (0 above the first heading). */
function sectionStart(lines: string[], line: number): number {
  for (let i = line - 1; i >= 0; i--) if (/^#{1,6}\s/.test(lines[i])) return i + 1;
  return 0;
}

/** The held card's body: what already says it, then the edit. */
export function heldPlan(scope: Scope, found: Overlap[], fromGrunt: string[], edits: FindReplace[]): string {
  const where = scope === 'citadel' ? `the ${APP_NAME}-wide instructions` : "this scheme's instructions";
  const q = (s: string) => s.replace(/\s+/g, ' ').trim();
  const place = (o: Overlap) => (o.href ? `[${o.label}${o.line ? `, line ${o.line}` : ''}](${o.href})` : `**${o.label}**`);
  const cut = (t: string) => (t.length > 1200 ? `${t.slice(0, 1200)}…` : t);
  return [
    `This edit to ${where} says something that is already written elsewhere, so nothing is saved yet. **Save anyway** keeps both, **Work it in** sends it back to put the change where it is already said (or point there), and **Cancel edit** drops it.`,
    '',
    '**Already said elsewhere**',
    ...found.map((o) => `- ${place(o)}: “${q(o.excerpt)}” It ${o.why}.`),
    ...fromGrunt.map((g) => `- From the minion's own check: ${q(g)}`),
    '',
    '**The edit**',
    ...edits.flatMap((e, i) => [`${edits.length > 1 ? `Change ${i + 1}, before` : 'Before'}:`, '', ...quote(cut(e.find)), '', 'After:', '', ...quote(cut(e.replace) || '(deleted)'), '']),
  ].join('\n');
}

const quote = (t: string) => t.split('\n').map((l) => `> ${l}`);
