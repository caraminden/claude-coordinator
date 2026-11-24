// Seals under an old rule (#1488). On Nov 21 Cara changed the pipeline lane to "Build in parallel", but minions sealed
// "waiting for pipeline lane", and the chains behind them, stayed sealed until she asked why. After every Settings
// instructions save, the sealed minions whose note shares a two-word phrase with the changed paragraphs (old or new
// wording), and the start_after chains behind them, go to their Taskmaster as held mail for its next turn.
import type { Project, Ticket } from './db.ts';
import type { App } from './http.ts';
import { added } from './rule-overlap.ts';

const STOP = new Set(
  (
    'the and for are but not you your with that this its from they them their was were has have had into out than ' +
    'also can will just own until after before while every each when then only once who what which all any one new old see says said ' +
    'should would could must may might there here how why yes too very more most less does did done get gets'
  ).split(' '),
);
const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ');
const keep = (w: string) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w);

/** The word pairs (both kept words, side by side) of the paragraphs a save added, changed or took out. */
export function rulePhrases(before: string, after: string): Set<string> {
  const out = new Set<string>();
  for (const p of [...added(before, after), ...added(after, before)]) {
    const w = words(p.text);
    for (let i = 1; i < w.length; i++) if (keep(w[i - 1]) && keep(w[i])) out.add(`${w[i - 1]} ${w[i]}`);
  }
  return out;
}

/** Sealed minions of `projects` whose note names a changed phrase, and the chains behind them: id → why. */
export function parksUnder(app: Pick<App, 'store' | 'runner' | 'waiters'>, project: Project, phrases: Set<string>): Map<number, string> {
  const parked = new Map(
    app.store
      .listTickets(project.id)
      .filter((t) => app.runner.parked(t))
      .map((t) => [t.id, t]),
  );
  const named = new Map<number, string>();
  for (const t of parked.values()) {
    const note = ` ${words(t.note ?? '').join(' ')} `;
    const hit = [...phrases].find((ph) => note.includes(` ${ph} `));
    if (hit) named.set(t.id, `its note names "${hit}"`);
  }
  const chains = app.waiters.chains();
  for (let grew = named.size > 0; grew; ) {
    grew = false;
    for (const c of chains) {
      if (named.has(c.ticket) || !named.has(c.after) || !parked.has(c.ticket)) continue;
      named.set(c.ticket, `chained behind #${parked.get(c.after)!.number}`);
      grew = true;
    }
  }
  return named;
}

/** After an instructions save: tell each affected Taskmaster which of its sealed minions may be waiting under the old wording. */
export function mailParksUnderOldRule(app: Pick<App, 'store' | 'runner' | 'waiters'>, projects: Project[], before: string, after: string, where: string) {
  const phrases = rulePhrases(before, after);
  if (!phrases.size) return;
  for (const p of projects) {
    const named = parksUnder(app, p, phrases);
    const byTm = new Map<number, Ticket[]>();
    for (const id of named.keys()) {
      const t = app.store.getTicket(id)!;
      const tm = app.store.ownerCoordinator(t) ?? app.store.getOverlord(p.id);
      if (tm) byTm.set(tm.id, [...(byTm.get(tm.id) ?? []), t]);
    }
    for (const [tm, list] of byTm) {
      const lines = list.slice(0, 15).map((t) => `- #${t.number} ${t.title}: "${t.note ?? ''}" (${named.get(t.id)})`);
      if (list.length > 15) lines.push(`- and ${list.length - 15} more`);
      app.runner.leaveMail(
        tm,
        'Settings',
        `(check these) The ${where} instructions just changed, and these sealed minions may be waiting under the old wording:\n${lines.join('\n')}\n` + 'Unpark each one sealed only because of the old rule (message_ticket with unpark: true), and keep real code chains (start_after on work it needs).',
      );
    }
  }
}
