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
