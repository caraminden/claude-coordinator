// Saving the Settings text from a minion's edit_instructions (#961), and holding an edit that repeats what is already
// written elsewhere on a card first (#1162; Josh, 2026-11-20: "Matcher, then a Grunt", "All three", "Hold it on a card").
// The matcher is src/rule-overlap.ts; the turn's own Sonnet Grunt adds what it found as `overlaps`.
import { join } from 'node:path';
import { APP_NAME } from './appname.ts';
import { recheckDecisions } from './decisions-load.ts';
import { GLOBAL_OWNER } from './properties.ts';
import { RULE_HOMES } from './rule-homes.ts';
import { added, homeText, inSettingsHome, overlapsFor, readIn, schemeRules, section, settingsSources, type Overlap } from './rule-overlap.ts';
import { ownWrites, type App } from './http.ts';
import type { Project } from './db.ts';

const ROOT = join(import.meta.dirname, '..');

export type Scope = 'citadel' | 'scheme';
export interface FindReplace { find: string; replace: string }

/** What a held edit's card carries, so Save anyway can save exactly what was shown. */
export interface HeldEdit { scope: Scope; project: number; old: string; text: string; edits: FindReplace[]; by: string; count: number }

/** Save through Settings' own setters and history, then tell the chat, the Taskmasters and open pages. */
export async function saveInstructions(app: App, ticketId: number, held: Omit<HeldEdit, 'count'>, by = held.by): Promise<void> {
  const { store, runner } = app;
  const citadel = held.scope === 'citadel';
  if (citadel) store.setAppInstructions(held.text, by);
  else store.setProjectInstructions(held.project, held.text, by);
  await ownWrites(); // the decisions log and the broadcast read them back (#1244)
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
 * What already speaks to an edit's new words: a registered rule (Citadel's or the scheme's own) outside its home, or a paragraph elsewhere sharing a
 * run of words. The sections of the edited text that the edit touches are left out, so a new
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
  // The shared rules, and on a save of a scheme's own text its own (#1211), read fresh each time.
  return overlapsFor(news, sources, inSettingsHome(scope, text), scope === 'scheme' ? [...RULE_HOMES, ...schemeRules(project.repo_dir)] : RULE_HOMES);
}

/** Sonnet's word on one matcher hit (#1211): whether the new words really repeat it, contradict it, or only share wording. */
export interface Verdict { verdict: 'repeats' | 'conflicts' | 'fine'; why: string }

/** A registered rule's home as it reads now: Citadel's own rules from this repo, a scheme's from its repo or its Settings text. */
export function ruleHome(app: Pick<App, 'store'>, project: Project, id: string): string | null {
  const citadel = app.store.appInstructions().text;
  const ours = RULE_HOMES.find((r) => r.id === id);
  if (ours) return homeText(ours, (f) => readIn(ROOT, f), citadel);
  const theirs = schemeRules(project.repo_dir).find((r) => r.id === id);
  if (!theirs) return null;
  if (theirs.home.kind === 'scheme') return section(project.instructions ?? '', theirs.home.section);
  return homeText(theirs, (f) => (project.repo_dir ? readIn(project.repo_dir, f) : null), citadel);
}

/**
 * What the Sonnet check reads: the edit's new paragraphs, then each place the matcher found, numbered. A registered
 * rule's hit quotes the new words themselves, so its home's text goes with it (`home`), for Sonnet to compare against.
 */
export function verdictPrompt(scope: Scope, before: string, text: string, found: Overlap[], home: (id: string) => string | null = () => null): string {
  const cut = (t: string) => (t.length > 3000 ? `${t.slice(0, 3000)}…` : t);
  const place = (o: Overlap, i: number) => {
    const h = o.rule ? home(o.rule) : null;
    const said = h ? `\n   The rule's home says:\n   <home>\n${cut(h.trim())}\n   </home>` : '';
    return `${i + 1}. ${o.label}${o.line ? `, line ${o.line}` : ''}: "${o.excerpt}" (matcher: it ${o.why})${said}`;
  };
  const where = scope === 'citadel' ? `the ${APP_NAME}-wide instructions` : "a scheme's instructions";
  return [
    `A person is saving an edit to ${where}, the standing rules every agent in it reads. A word matcher flagged places that already say something like the new words. Judge each place against the new words: "repeats" when it states the same rule, so the rule would be written twice; "conflicts" when it says something different about the same thing, so agents get two answers; "fine" when they only share wording and speak to different things.`,
    `The new words:\n<new>\n${added(before, text).map((p) => p.text).join('\n\n')}\n</new>`,
    `The places (a registered rule's place quotes the new words; judge them against the rule's home):\n<places>\n${found.map(place).join('\n')}\n</places>`,
    'Reply with JSON only, no fences: {"verdicts": [{"n": <the place\'s number>, "verdict": "repeats" | "conflicts" | "fine", "why": "<one plain line for the person>"}]}, one for each place.',
  ].join('\n\n');
}

/** Sonnet's reply as one verdict per place, in order (null where it gave none); throws when the reply isn't JSON. */
export function readVerdicts(reply: string, count: number): (Verdict | null)[] {
  const t = reply.trim();
  let data: any;
  try { data = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { throw new Error("Sonnet's answer wasn't the verdicts it should be"); }
  const out: (Verdict | null)[] = Array(count).fill(null);
  for (const v of Array.isArray(data?.verdicts) ? data.verdicts : []) {
    if (Number.isInteger(v?.n) && v.n >= 1 && v.n <= count && ['repeats', 'conflicts', 'fine'].includes(v.verdict)) out[v.n - 1] = { verdict: v.verdict, why: typeof v.why === 'string' ? v.why.trim().slice(0, 300) : '' };
  }
  return out;
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
