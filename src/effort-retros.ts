// A retro when a multi-minion effort ends, in every scheme (#1751; Cara, 2026-11-23, on #1744's card: "Yes, add it",
// "Why not other schemes too if they do a big project?"; her picks: "Both" named efforts and unnamed chains, "Starts by itself").
// An effort is the minions sharing the global `effortName` property: named by the Taskmaster at its first minion, carried
// by start_after followers and parent starts (effortFor), and `chain from #N` for a start_after chain nobody named.
// docs/adr/0031-effort-retros.md has the picks.
import { buildOwnerKey, type Project, type Store, type Ticket } from './db.ts';
import type { Runner } from './runner.ts';
import { pickFor } from '../public/model-table.js';
import { pacific } from './schedules.ts';
import { judge, judged, type JudgeMode } from './judges.ts';
import { budgetKey, family, type BudgetState } from './minion-budget.ts';

export const EFFORT_KEY = 'effortName';
/** A named effort needs this many minions; an unnamed chain one more (a 3-minion chain is often only ordering). */
export const NAMED_FLOOR = 3;
export const CHAIN_FLOOR = 4;
/** How long an effort stays closed before its retro starts, so a follow-up the Taskmaster starts joins it instead. */
export const QUIET_MS = 6 * 3_600_000;
const AUTO = /^chain from #\d+$/;

export const doneKey = (projectId: number, name: string) => `effort-retro:${projectId}:${name}`;

/**
 * A new minion's effort: its own (given), else its start_after leader's, else its parent's; a start_after chain with
 * none is named after its leader, and `stampLeader` says the leader takes that name too.
 */
export function effortFor(given: string | null, leader: { number: number; effort: string | null } | null, parentEffort: string | null): { name: string | null; stampLeader: boolean } {
  if (given) return { name: given, stampLeader: false };
  if (leader?.effort) return { name: leader.effort, stampLeader: false };
  if (parentEffort) return { name: parentEffort, stampLeader: false };
  if (leader) return { name: `chain from #${leader.number}`, stampLeader: true };
  return { name: null, stampLeader: false };
}

export interface EffortVerdict {
  name: string;
  members: Ticket[];
  /** start: its retro starts now; skip: a build retro covers it (recorded, never checked again). */
  act: 'start' | 'skip';
  why: string;
}

/** A failed start is tried again on later ticks, this many times in all. */
export const TRIES = 3;

/**
 * The efforts of one scheme that are ready for a verdict: big enough, all closed and quiet for QUIET_MS, not yet done.
 * `since(name)` is when that name last got a verdict (undefined: never); only minions made after it count, so a name the
 * Taskmaster reuses for a later goal gets its own retro. `majorBuild(n)` says Build n has its own build minion, whose
 * retro covers its feeders: a bare build number (Delve's "found in" build on a bug) doesn't.
 */
export function effortsDue(tickets: Ticket[], effortOf: Map<number, string>, since: (name: string) => number | undefined, now: number, majorBuild: (n: number) => boolean): EffortVerdict[] {
  const groups = new Map<string, Ticket[]>();
  for (const t of tickets) {
    const name = effortOf.get(t.id);
    if (!name || t.kind === 'coordinator') continue;
    groups.set(name, [...(groups.get(name) ?? []), t]);
  }
  const out: EffortVerdict[] = [];
  for (const [name, all] of groups) {
    const cut = since(name);
    const members = cut === undefined ? all : all.filter((t) => t.created_at > cut);
    const floor = AUTO.test(name) ? CHAIN_FLOOR : NAMED_FLOOR;
    if (members.length < floor) continue;
    if (members.some((t) => t.status !== 'closed')) continue;
    const last = Math.max(...members.map((t) => t.closed_at ?? t.updated_at));
    if (now - last < QUIET_MS) continue;
    members.sort((a, b) => a.number - b.number);
    // A major build's retro (citadel:retro, the build minion's step 5) already covers an effort that is mostly that build.
    const builds = new Map<number, number>();
    for (const t of members) if (t.build != null && majorBuild(t.build)) builds.set(t.build, (builds.get(t.build) ?? 0) + 1);
    const [top, n] = [...builds].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    if (top != null && n * 2 > members.length) out.push({ name, members, act: 'skip', why: `${n} of its ${members.length} minions are Build ${top}, whose retro covers them` });
    else out.push({ name, members, act: 'start', why: `${members.length} minions, the last closed ${pacific(last)}` });
  }
  return out;
}

/** The retro minion's first message. */
export function effortBrief(project: Pick<Project, 'name'>, v: EffortVerdict): string {
  const first = v.members[0];
  const last = v.members[v.members.length - 1];
  const span = `${pacific(first.created_at)} to ${pacific(Math.max(...v.members.map((t) => t.closed_at ?? t.updated_at)))}`;
  return [
    `Effort retro for "${v.name}" in ${project.name}. The server started this minion, not a person (#1751): every minion of this effort has closed. Nobody is watching it live.`,
    '',
    `The effort: ${v.members.length} minions, ${span}.`,
    ...v.members.map((t) => `- #${t.number} ${t.title}`),
    '',
    'Follow citadel:retro, for an effort. Read the minions with read_minion, a few per Sonnet Grunt, each returning counts and minion numbers, never transcripts: what was asked, corrected or redone, refused ships and land conflicts, hand-offs between the minions, and the steps that took longest. Also read this scheme\'s retro log for the window (retro-log/<date>/*.md in its shared folder), and the last retro and the ledger in the retro folder its CLAUDE.md names (docs/retros/ if none). The question this retro answers that a per-minion digest can\'t: what went wrong across the effort (the split into minions, the order, a brief that left the next one guessing, work done twice).',
    `Then: write effort-<slug>.md in that retro folder (slug from "${v.name}", plus the date), update the ledger, and make the few edits the retro calls for in this scheme's own skills, rules and docs, after citadel:self-review, by its usual landing route. A fix for the Citadel kit, the tripwire or Citadel's prompts goes in a handoff in this scheme's handoffs/ (handoff-citadel-<slug>.md); message your Taskmaster its path.`,
    `Reply with the top three findings and what shipped, linking the retro. Stay open in state complete, the retro named in the note. #${first.number} to #${last.number} are closed: don't reopen them.`,
  ].join('\n');
}

/** The `effort-retro:<scheme>:<name>` setting: the verdict a name last got. */
interface Marker { act: 'start' | 'skip' | 'would' | 'failed'; why: string; at?: number; tries?: number; ticket?: number }

export interface EffortRetroDeps {
  store: Store;
  newMinion: (project: Project, m: { title: string; model: string; effort: string; props: Record<string, string> }, by: string) => Promise<{ id: number; number: number }>;
  runner: Pick<Runner, 'emit' | 'send'>;
  by: string;
  now?: () => number;
  /** Where a log-only run notes the retro it would have started (server.ts's judgeNote: the scheme's retro log). */
  note: (line: string, project: Project) => void;
  /** The judge's mode (src/judges.ts `effort-retros`) unless a test sets it. */
  mode?: JudgeMode;
}

/** Checks every scheme's efforts and starts each finished one's retro once. server.ts runs tick every 10 minutes. */
export class EffortRetros {
  private d: EffortRetroDeps;

  constructor(d: EffortRetroDeps) {
    this.d = d;
  }

  async tick(): Promise<string[]> {
    const { store } = this.d;
    const now = this.d.now?.() ?? Date.now();
    const said: string[] = [];
    const mode = this.d.mode ?? judge('effort-retros')?.mode;
    // A judge (#1503): log-only notes the retro it would start and marks the effort `would`; once it acts, those start too.
    const start = judged('effort-retros', 'start a retro', (project: Project, v: EffortVerdict) => this.start(project, v),
      (p: Project, v: EffortVerdict) => { this.d.store.setSetting(doneKey(p.id, v.name), { act: 'would', why: v.why, at: now }); return Promise.resolve(`would start a retro (${v.why})`); },
      (line, project) => this.d.note(line, project), mode);
    // When a name last got a verdict. A `would` counts as none once the judge acts, and so does a failed start with tries left.
    const since = (projectId: number, name: string) => {
      const r = store.getSetting<Marker>(doneKey(projectId, name));
      if (r == null || (r.act === 'would' && mode !== 'log-only') || (r.act === 'failed' && (r.tries ?? 1) < TRIES)) return undefined;
      return r.at ?? Number.POSITIVE_INFINITY;
    };
    for (const project of store.listProjects()) {
      const rows = store.props.minionsWith(project.id, EFFORT_KEY);
      if (!rows.length) continue;
      const effortOf = new Map(rows.map((r) => [r.id, r.value]));
      const tickets = rows.map((r) => store.getTicket(r.id)).filter((t): t is Ticket => !!t);
      const majorBuild = (n: number) => store.getSetting(buildOwnerKey(project.id, n)) != null;
      for (const v of effortsDue(tickets, effortOf, (name) => since(project.id, name), now, majorBuild)) {
        const before = store.getSetting<Marker>(doneKey(project.id, v.name));
        // Marked before the start: a crash between the two loses one retro rather than starting it twice.
        store.setSetting(doneKey(project.id, v.name), { act: v.act, why: v.why, at: now });
        if (v.act === 'skip') { said.push(`${project.name} "${v.name}": no retro, ${v.why}`); continue; }
        try {
          said.push(`${project.name} "${v.name}": ${await start(project, v)}`);
        } catch (err: any) {
          console.error(`Effort retro for ${project.name} "${v.name}" didn't start:`, err);
          // Its minion was made (the marker has its number): leave it. Else try again next tick, TRIES in all.
          if (store.getSetting<Marker>(doneKey(project.id, v.name))?.ticket == null) {
            const tries = (before?.act === 'failed' ? (before.tries ?? 1) : 0) + 1;
            store.setSetting(doneKey(project.id, v.name), { act: 'failed', why: String(err?.message ?? err).slice(0, 300), at: now, tries });
          }
        }
      }
    }
    for (const line of said) console.log(`Effort retros (#1751): ${line}`);
    return said;
  }

  private async start(project: Project, v: EffortVerdict): Promise<string> {
    const { store, runner, by } = this.d;
    // Its turns run for the person whose effort it was: the first minion's, as a schedule's run for its maker.
    const first = v.members[0];
    const assigned = store.props.forTarget('minion', first.id).assigned;
    const tier = pickFor('research');
    const made = await this.d.newMinion(project, { title: `Retro: ${v.name}`.slice(0, 120), model: tier.model, effort: tier.effort, props: { type: 'research', ...(typeof assigned === 'string' ? { assigned } : {}) } }, by);
    store.updateTicket(made.id, { person_id: first.person_id ?? null });
    store.setSetting(doneKey(project.id, v.name), { act: 'start', why: v.why, at: this.d.now?.() ?? Date.now(), ticket: made.number });
    runner.emit(made.id, 'note', { text: `Started by the effort trigger: every minion of "${v.name}" has closed (${v.why}).` });
    runner.send(made.id, by, effortBrief(project, v), [], { brief: true });
    return `started #${made.number} (${v.why})`;
  }
}

// A post-mortem for a minion in trouble (#1796; Cara, 2026-11-24, "Retro on trouble"), in every scheme, on the effort trigger's launcher.
// Trouble is either of two marks the server already keeps, no new data: its budget's `asked` time (past twice its expected cost,
// src/minion-budget.ts) or a Taskmaster's model step-up (a `ticket_picks` row by 'Taskmaster', which is how a stall or a person's
// "that fix didn't hold" reaches update_ticket). It waits until the minion has closed, so the troubled minion is never interrupted.
// docs/adr/0032-trouble-post-mortems.md has the picks.

/** When the trigger started watching: trouble from before it is not chased (a first deploy would otherwise post-mortem every old minion). */
export const SINCE_KEY = 'trouble-retros:since';
export type Trouble = 'budget' | 'stepup';
/** One marker per minion per trigger: the verdict, written before the start. */
export const troubleKey = (ticketId: number, kind: Trouble) => `trouble-retro:${ticketId}:${kind}`;
/** Set on a post-mortem minion the moment it is made, so it never gets one of its own. */
export const postMortemOfKey = (ticketId: number) => `post-mortem-of:${ticketId}`;
const WHAT: Record<Trouble, string> = { budget: 'went past twice its budget', stepup: "had its model stepped up by the Taskmaster, so a fix didn't hold" };

export interface TroubleVerdict { name: string; ticket: Ticket; kinds: Trouble[]; why: string }

export function troubleBrief(project: Pick<Project, 'name'>, v: TroubleVerdict, owner: string | null): string {
  const t = v.ticket;
  return [
    `Post-mortem of #${t.number} "${t.title}" in ${project.name}. The server started this minion, not a person (#1796): #${t.number} has closed and ${v.kinds.map((k) => WHAT[k]).join('; it also ')}. Nobody is watching it live.`,
    '',
    'Follow citadel:post-mortem for that one minion: read it through the citadel:investigator Grunt (a Sonnet Grunt returning a timeline of at most 15 lines), never its raw transcript yourself. Give the timeline with its turn point, the cause class, and one fix.',
    `The fix goes on one ask_question card \`to\` ${owner ?? 'its owner (read_minion shows who)'}, worded for someone who did not follow the work. You change no code, rules or skills yourself. Your only write is one line in the scheme's retro folder ledger (the folder CLAUDE.md's Project facts name, docs/retros/ if none): the minion, the cause class, the proposed fix. Ship that line as a docs-only change by this scheme's usual route.`,
    'Expected cost: ~$3. It is Sonnet medium and reads only through the investigator; past twice that its budget alarm asks you to say why, so stop and report instead of widening.',
    `Reply with the cause class and the card's link. Stay open in state complete. #${t.number} is closed: don't reopen it.`,
  ].join('\n');
}

/** Checks every scheme's closed minions for trouble and starts one post-mortem per minion; server.ts ticks it with EffortRetros. */
export class TroubleRetros {
  private d: EffortRetroDeps;

  constructor(d: EffortRetroDeps) {
    this.d = d;
  }

  /** The troubles of a minion since `since` that have no marker yet. */
  private due(t: Ticket, since: number, mode: JudgeMode | undefined): Trouble[] {
    const { store } = this.d;
    const out: Trouble[] = [];
    const asked = store.getSetting<BudgetState>(budgetKey(t.id))?.asked;
    if (asked != null && asked >= since) out.push('budget');
    // The first pick is the start's own; a later one by the Taskmaster is a step-up.
    if (store.picksOf(t.id).slice(1).some((p) => p.by === 'Taskmaster' && p.at >= since)) out.push('stepup');
    // Marked already is done, except a `would` once the judge acts and a failed start with tries left.
    return out.filter((k) => {
      const m = store.getSetting<Marker>(troubleKey(t.id, k));
      return m == null || (m.act === 'would' && mode !== 'log-only') || (m.act === 'failed' && (m.tries ?? 1) < TRIES);
    });
  }

  async tick(): Promise<string[]> {
    const { store } = this.d;
    const now = this.d.now?.() ?? Date.now();
    const said: string[] = [];
    const since = store.getSetting<number>(SINCE_KEY);
    if (since == null) { store.setSetting(SINCE_KEY, now); return said; }
    const mode = this.d.mode ?? judge('trouble-retros')?.mode;
    const start = judged('trouble-retros', 'start a post-mortem', (project: Project, v: TroubleVerdict) => this.start(project, v),
      (p: Project, v: TroubleVerdict) => { for (const k of v.kinds) store.setSetting(troubleKey(v.ticket.id, k), { act: 'would', why: v.why, at: now }); return Promise.resolve(`would start a post-mortem (${v.why})`); },
      (line, project) => this.d.note(line, project), mode);
    for (const project of store.listProjects()) {
      for (const t of store.listTickets(project.id)) {
        // Trouble comes before closing, so a minion closed before the trigger began has none to chase (and the scan stays small).
        if (t.kind === 'coordinator' || t.status !== 'closed' || (t.closed_at ?? 0) < since || family(t.model ?? t.last_model) == null) continue;
        if (store.getSetting(postMortemOfKey(t.id)) != null) continue;
        const kinds = this.due(t, since, mode);
        if (!kinds.length) continue;
        const v: TroubleVerdict = { name: `#${t.number} ${t.title}`, ticket: t, kinds, why: kinds.map((k) => WHAT[k]).join(', ') };
        const before = store.getSetting<Marker>(troubleKey(t.id, kinds[0]));
        try {
          // Marked before the start: a crash between the two loses one post-mortem rather than starting it twice.
          for (const k of kinds) store.setSetting(troubleKey(t.id, k), { act: 'start', why: v.why, at: now });
          said.push(`${project.name} #${t.number}: ${await start(project, v)}`);
        } catch (err: any) {
          console.error(`Post-mortem of #${t.number} in ${project.name} didn't start:`, err);
          // Its minion was made: leave it. Else mark the failure and try again next tick, TRIES in all.
          if (store.getSetting<Marker>(troubleKey(t.id, kinds[0]))?.ticket == null) {
            const tries = (before?.act === 'failed' ? (before.tries ?? 1) : 0) + 1;
            for (const k of kinds) store.setSetting(troubleKey(t.id, k), { act: 'failed', why: String(err?.message ?? err).slice(0, 300), at: now, tries });
          }
        }
      }
    }
    for (const line of said) console.log(`Trouble post-mortems (#1796): ${line}`);
    return said;
  }

  private async start(project: Project, v: TroubleVerdict): Promise<string> {
    const { store, runner, by } = this.d;
    const t = v.ticket;
    const assigned = store.props.forTarget('minion', t.id).assigned;
    const owner = typeof assigned === 'string' ? assigned : null;
    const made = await this.d.newMinion(project, { title: `Post-mortem: #${t.number} ${t.title}`.slice(0, 120), model: 'claude-sonnet-5-5', effort: 'medium', props: { type: 'research', ...(owner ? { assigned: owner } : {}) } }, by);
    store.setSetting(postMortemOfKey(made.id), t.number);
    // Its cap: the create route sets the estimate, and this path doesn't go through it, so its alarms would count from the usual cost.
    store.setSetting(budgetKey(made.id), { estimate: 3 } satisfies BudgetState);
    store.updateTicket(made.id, { person_id: t.person_id ?? null });
    for (const k of v.kinds) store.setSetting(troubleKey(t.id, k), { act: 'start', why: v.why, at: this.d.now?.() ?? Date.now(), ticket: made.number });
    runner.emit(made.id, 'note', { text: `Started by the trouble trigger: #${t.number} ${v.why}.` });
    runner.send(made.id, by, troubleBrief(project, v, owner), [], { brief: true });
    return `started #${made.number} (${v.why})`;
  }
}
