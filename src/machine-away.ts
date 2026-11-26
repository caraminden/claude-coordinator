// What a machine holds of each minion, and what becomes of it when the minion goes on without that machine (Build 7 T6,
// shared/project/specs/worker-machines.md section 6). A turn placed on a machine leaves a copy of its minion there (its
// worktree, session and folders, public/machine-sync.mjs). The record of those copies is here, one settings row a
// machine, so it outlives a restart and a machine that is away for days:
//   - a turn that ended here while its machine was away (the 10 minute clock in src/machine-turn.ts, or a person's stop)
//     marks its copy `away`; when the machine is back, its agent is told to stop that turn and send home what never came
//     (`rescue`): beside the minion's work, never over it (refs/citadel/away/, the files folder's away/);
//   - a closed minion's copy is cleared once it is GRACE_MS old (as its worktree here is), after the same rescue, unless
//     something only there can't come home (a repo of its own, a key): then it stays, and the chat says why.
import { dirname } from 'node:path';
import type { Store } from './db.ts';
import { syncDir, type TurnState } from './machine-sync.ts';
import { type AwayEnd, endAway, machineAway, MachineTurn, type Placed, placedAt } from './machine-turn.ts';
import { pacificStamp } from './pacific.ts';
import type { RunningTurn } from './running-turn.ts';
import type { RunsOn } from './runs-on.ts';
import { GRACE_MS } from './worktree-sweep.ts';

export interface Copy {
  ticket: number;
  /** The machine's name when it was placed. */
  name: string;
  wrapper: string[];
  cwd: string | null;
  home: string;
  roots: string[];
  state: TurnState;
  /** Its turn ended here while the machine was away, at this time: what it did there since its last checkpoint is to come home. */
  away?: number;
  /** Why the machine keeps it: something there only can't come home. */
  stays?: string;
}

/** A copy the agent is to clear, with what its sync program needs. */
export interface Clear {
  dir: string;
  ticket: number;
  launch: { wrapper: string[]; home: string; roots: string[]; sync: { at: string; key: string } };
  /** The machine is being removed: what its other minions share goes too. */
  all: boolean;
  /** Only bring home what it has (a copy away whose turn the agent no longer holds); then it stays as the minion's copy. */
  mode?: 'rescue';
}

const key = (machineId: number) => `machine-copies:${machineId}`;
/** The machines being removed: they keep their row until their agent has deleted every copy there. */
const REMOVING = 'machines-removing';

export interface CopiesDeps {
  store: Pick<Store, 'getSetting' | 'setSetting' | 'deleteSetting' | 'getTicket'>;
  /** A line in the minion's chat. */
  note: (ticketId: number, text: string) => unknown;
  now: () => number;
}

export class MachineCopies {
  private d: CopiesDeps;
  constructor(d: CopiesDeps) {
    this.d = d;
  }

  all(machineId: number): Record<string, Copy> {
    return this.d.store.getSetting<Record<string, Copy>>(key(machineId)) ?? {};
  }

  private save(machineId: number, copies: Record<string, Copy>) {
    if (Object.keys(copies).length) this.d.store.setSetting(key(machineId), copies);
    else this.d.store.deleteSetting(key(machineId));
  }

  /** A turn was placed there: its minion's copy is that turn's now. One still to come home stays until it has. */
  placed(machineId: number, dir: string, at: Placed) {
    const copies = this.all(machineId);
    const ticket = at.state?.ticket;
    if (!ticket || !at.state) return;
    for (const [d, c] of Object.entries(copies)) if (c.ticket === ticket && !c.away) delete copies[d];
    copies[dir] = { ticket, name: at.name, wrapper: at.wrapper, cwd: at.cwd, home: at.home, roots: at.roots, state: at.state };
    this.save(machineId, copies);
  }

  /** The turn in `dir` ended here while its machine was away: by a person's stop (`signal`), the clock, or a restart there. */
  left(machineId: number, dir: string, a?: AwayEnd, signal?: string | null) {
    const copies = this.all(machineId);
    const ticket = copies[dir]?.ticket ?? placedAt(dir)?.state?.ticket;
    if (ticket && a && !signal) this.d.note(ticket, awayNote(a));
    if (!copies[dir] || copies[dir].away) return;
    copies[dir].away = this.d.now();
    this.save(machineId, copies);
  }

  /** What the agent is told of a turn folder it holds that this server no longer follows: a copy with work to bring home is rescued. */
  held(machineId: number, dir: string): { rescue: true } | null {
    return this.all(machineId)[dir]?.away ? { rescue: true } : null;
  }

  /** A copy's calls to the state route (src/routes/machines.ts) go by this, as a running turn's go by its folder. */
  copyAt(machineId: number, dir: string): Placed | null {
    const c = this.all(machineId)[dir];
    return c ? { id: machineId, name: c.name, wrapper: c.wrapper, cwd: c.cwd, home: c.home, roots: c.roots, state: c.state } : null;
  }

  /** The agent brought what the copy had home, or says why it couldn't. A copy a newer turn has replaced goes. */
  rescued(machineId: number, dir: string, failed: string | null) {
    const copies = this.all(machineId);
    const c = copies[dir];
    if (!c?.away) return;
    if (failed) {
      // Kept as it is: the agent tries again when it is next told (at the next turn there, or when the minion's copy is cleared).
      this.d.note(c.ticket, `${c.name} could not send home the work its stopped turn left there: ${failed.slice(0, 300)}. It stays on ${c.name}; Citadel tries again before that copy is ever deleted.`);
    }
    delete c.away;
    if (Object.entries(copies).some(([d, o]) => d !== dir && o.ticket === c.ticket)) delete copies[dir];
    this.save(machineId, copies);
  }

  /** The copies the agent is to clear now: a closed minion's once GRACE_MS old, or every one of a machine being removed. */
  clears(machineId: number, held: Set<string>): Clear[] {
    const all = this.removing(machineId);
    const now = this.d.now();
    return Object.entries(this.all(machineId)).flatMap(([dir, c]): Clear[] => {
      // A turn the agent still runs there is cleared after it (a removal waits for it, a stop ends it).
      if (held.has(dir)) return [];
      if (c.away) return [{ ...this.clear(dir, c, all), mode: 'rescue' }];
      if (c.stays && !all) return [];
      const t = this.d.store.getTicket(c.ticket);
      if (!all && !(t?.status === 'closed' && now - (t.closed_at ?? now) >= GRACE_MS)) return [];
      return [this.clear(dir, c, all)];
    });
  }

  private clear(dir: string, c: Copy, all: boolean): Clear {
    return { dir, ticket: c.ticket, all, launch: { wrapper: c.wrapper, home: c.home, roots: c.roots, sync: { at: syncDir(dir), key: c.cwd ? dirname(c.cwd) : dir } } };
  }

  /** The agent cleared a copy, or keeps it for `stays`; or brought home what an away copy had. */
  cleared(machineId: number, dir: string, stays: string | null) {
    const copies = this.all(machineId);
    const c = copies[dir];
    if (!c) return;
    if (c.away) return this.rescued(machineId, dir, null);
    if (!stays) delete copies[dir];
    else if (c.stays !== stays) {
      c.stays = stays;
      this.d.note(c.ticket, `${c.name} keeps its copy of this minion: ${stays.slice(0, 300)} can't come home (a git repo of its own, or a key), so deleting it would lose them. Delete them there, or move them, and it goes.`);
    }
    this.save(machineId, copies);
  }

  removing(machineId: number): boolean {
    return (this.d.store.getSetting<number[]>(REMOVING) ?? []).includes(machineId);
  }

  /** Its removal began: from its agent's next sync on, every copy there is cleared (after what it holds comes home). */
  remove(machineId: number) {
    if (!this.removing(machineId)) this.d.store.setSetting(REMOVING, [...(this.d.store.getSetting<number[]>(REMOVING) ?? []), machineId]);
  }

  /** The machines whose removal waits on their copies there. */
  removals(): number[] {
    return this.d.store.getSetting<number[]>(REMOVING) ?? [];
  }

  /** The machine's row is gone: so is the record of what it held. */
  forget(machineId: number) {
    this.d.store.deleteSetting(key(machineId));
    const left = this.removals().filter((id) => id !== machineId);
    if (left.length) this.d.store.setSetting(REMOVING, left);
    else this.d.store.deleteSetting(REMOVING);
  }

  /** Copies that keep a machine from being removed cleanly, with why. */
  staying(machineId: number): { ticket: number; why: string }[] {
    return Object.values(this.all(machineId)).flatMap((c) => (c.stays ? [{ ticket: c.ticket, why: c.stays }] : c.away ? [{ ticket: c.ticket, why: 'work a stopped turn left there has not come home yet' }] : []));
  }
}

/** What takes the worker off its computer, by where it runs (tools/worker/): its owner runs it there by hand. */
export const UNINSTALL = {
  powershell: "wsl --unregister citadel-workers; Unregister-ScheduledTask -TaskName 'Citadel minion workers' -Confirm:$false",
  bash: 'sudo citadel-worker remove',
};

/** The chat's line when a turn ends because its machine was away. */
export function awayNote(a: AwayEnd): string {
  const from = a.checkpoint ? `its last checkpoint, ${pacificStamp(a.checkpoint)}` : 'what it had when this turn started';
  return a.home
    ? `${a.name} has been away since ${pacificStamp(a.since)}, so this turn carries on at perigee from ${from}. Anything newer ${a.name} holds comes home beside the minion's work when it is back (refs/citadel/away/); nothing merges by itself.`
    : `${a.name} restarted, which ended this turn there; it carries on from ${from}.`;
}

/** A resume owed for a turn that ended away: its chat line and its prompt. */
export const awayResume = (a: AwayEnd | undefined, otherwise: { note: string; prompt: string }) => (a ? { note: `Carried on from ${a.name}'s last checkpoint`, prompt: awayPrompt(a) } : otherwise);

/** A running turn's working line while its machine is away. */
export function awayLine(turn: RunningTurn): string | null {
  const a = turn instanceof MachineTurn ? turn.away() : null;
  return a && `Machine away: ${a.name}${a.since ? `, since ${pacificStamp(a.since)}` : ''}`;
}

/**
 * Where a minion's next turn is to run: `need` is its mark (null: anywhere, 0: here, else a machine). A fresh step runs
 * here; so does, once, an unmarked minion carrying on from a machine that was away. A marked one keeps its machine.
 */
export const nextMark = (need: number | null, away: AwayEnd | undefined, fresh: () => unknown): number | null => (need === null ? (away?.home ? 0 : null) : need && fresh() ? 0 : need);

/** The resume's prompt. */
export function awayPrompt(a: AwayEnd): string {
  const from = a.checkpoint ? `its last checkpoint (${pacificStamp(a.checkpoint)})` : 'what this minion had when that turn started';
  return `Your last turn ran on ${a.name}, which ${a.home ? 'went away (asleep, off or offline)' : 'restarted'} before it finished, so it ended there. You carry on${a.home ? ' at perigee' : ''} from ${from}: work done there after that is not in your worktree or folders. If ${a.name} comes back with newer work, it arrives beside yours as refs/citadel/away/<this minion>/... and files under your files folder's away/, and you are told; nothing merges by itself. Check the state of your work (git first, then files) and continue where it stands. Don't redo finished steps.`;
}

/** Hand the copies and the minions' marks to the machine turns (src/machine-turn.ts), at start. */
export function wireCopies(copies: MachineCopies, runsOn: Pick<RunsOn, 'needs' | 'stuck'>) {
  Object.assign(machineAway, {
    placed: (m, dir, at) => copies.placed(m, dir, at),
    left: (m, dir, a, signal) => copies.left(m, dir, a, signal),
    held: (m, dir) => copies.held(m, dir),
    rescued: (m, dir, failed) => copies.rescued(m, dir, failed),
    clears: (m, held) => copies.clears(m, held),
    cleared: (m, dir, stays) => copies.cleared(m, dir, stays),
    overdue: (m, dir, since) => {
      const at = placedAt(dir);
      const ticket = at?.state?.ticket;
      // One marked for that machine waits for it (T4's card after a day): it never comes home by itself.
      if (ticket && runsOn.needs(ticket) === m) runsOn.stuck(ticket, since, { why: `${at.name} is away`, since });
      else void endAway(dir, since, true);
    },
  } satisfies typeof machineAway);
}
