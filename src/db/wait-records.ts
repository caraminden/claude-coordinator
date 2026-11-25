// What a minion's time log can't work out from its events (#1992): when its state changed and who changed it, where its
// ship stood, and the commands a time limit cut off. One row each, kept as long as the minion's events are: until it is deleted.
import { WAITS_SINCE_KEY } from '../db-keys.ts';
import type { Store } from '../db.ts';
import type { TicketState } from '../db-rows.ts';

/** Who made a change: the minion itself, another agent (the Taskmaster, another minion), a person, or the server. */
export interface ChangeBy {
  kind: 'minion' | 'agent' | 'person' | 'server';
  name?: string;
}

export interface StateChange {
  at: number;
  old: TicketState | null;
  new: TicketState | null;
  by: ChangeBy;
}

export interface ShipStep {
  at: number;
  /** When this ship was first seen (ms): its steps share it. */
  ship: number;
  /** The track's stage (src/waits.ts TRACK), `check` before the line, `start`, or `ended`. */
  stage: string;
  /** The stage in words: "In line", "CI", "Deploy". */
  label: string;
  /** Its place while it waits in line, the ship at the front being 1. */
  place?: number;
  /** The ship at the front, "#513". */
  behind?: string;
  /** With `ended`. left: it left the line and nothing says how (a ship its own turn ran); cut off: land.sh ended with no exit code. */
  outcome?: 'shipped' | 'unpushed' | 'refused' | 'stopped' | 'no-ci' | 'cut off' | 'left';
  /** Why it was refused (classifyLandFailure's kind), or who stopped it. */
  why?: string;
}

export interface CutOff {
  at: number;
  /** The limit that did it: `background` is Claude Code's own on a background command; null, an exit 124 whose limit isn't on the command's face. */
  limit: 'citadel-test' | 'run-tests' | 'timeout' | 'background' | 'citadel-job' | null;
  /** The limit's length, s, where it is known. */
  seconds?: number;
  command?: string;
  /** The call it ran in; a job has none. */
  tool_use_id?: string;
  /** A Grunt's call: the Agent call it ran under. */
  parent?: string;
}

export interface WaitRecords {
  /**
   * When recording began (ms): a time before it reads "not recorded". After it, the state at any moment is the newest
   * row's `new`, or before the first row that row's `old`, or with no rows the minion's state now.
   */
  since: number | null;
  states: StateChange[];
  ships: ShipStep[];
  cuts: CutOff[];
}

interface Kinds {
  state: StateChange;
  ship: ShipStep;
  cut: CutOff;
}

export const waitRecordQueries = {
  addWaitRecord<K extends keyof Kinds>(this: Store, ticketId: number, kind: K, { at, ...data }: Kinds[K]) {
    // From the ticket, so a minion deleted meanwhile gets none.
    this.db.prepare('INSERT INTO wait_records (ticket_id, kind, at, data) SELECT id, ?, ?, ? FROM tickets WHERE id = ?').run(kind, at, JSON.stringify(data), ticketId);
  },

  /** All three records of one minion, each oldest first. */
  waitRecords(this: Store, ticketId: number): WaitRecords {
    const rows = this.db.prepare('SELECT kind, at, data FROM wait_records WHERE ticket_id = ? ORDER BY id').all(ticketId) as { kind: keyof Kinds; at: number; data: string }[];
    const of = <T>(kind: keyof Kinds) => rows.filter((r) => r.kind === kind).map((r) => ({ at: r.at, ...JSON.parse(r.data) }) as T);
    return { since: this.getSetting<number>(WAITS_SINCE_KEY), states: of('state'), ships: of('ship'), cuts: of('cut') };
  },
};
