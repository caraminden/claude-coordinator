// "Runs on" (Build 7 T4; Cara, 2026-11-25: "Add it to Build 7 now"): where a minion's turns may run. Nothing saved is
// anywhere: perigee, and a machine when perigee is full. `home` is perigee only; a machine is that one only, whatever
// perigee holds, and it waits while that computer can't take it (src/turn-line.ts). Saved in the settings table, so a
// restart keeps it. When it can't ever run there, or has waited a day, a card asks the minion's owner.
import type { Store } from './db.ts';
import type { Block } from './machine-pools.ts';

const PREFIX = 'runs-on:';
export const ANYWHERE = 'anywhere';
export const HOME = 'perigee';
/** Away, or waiting for it, this long: the card, so a wait is never unseen. */
export const UNSEEN_MS = 24 * 3600_000;

/** A minion's saved mark. The machine's name stays with it, for a card about one that was removed. */
export interface Mark {
  machine: number | null;
  name: string;
  by: string;
  at: number;
  /** A person's pick on its card: the next turn runs at perigee. */
  once?: true;
  /** Its card and when it was posted or answered Keep waiting. */
  card?: { id: string; at: number; why: string };
}

export const RUN_HERE = 'Run this turn at perigee';
export const KEEP = 'Keep waiting';
export const CLEAR = 'Clear the mark';

/** The card for a turn that waits for a machine it can't start on. */
export const runsOnCard = (name: string, why: string) => ({
  header: 'Runs on',
  question: `This minion is marked to run only on ${name}, and its next turn can't start there: ${why}. What should it do?`,
  options: [
    { label: RUN_HERE, description: `Only this turn: the mark stays, and the one after waits for ${name} again.` },
    { label: KEEP, description: 'It starts there by itself once it can; asked again after a day.' },
    { label: CLEAR, description: `It runs anywhere from now on, and no longer waits for ${name}.` },
  ],
});

export interface RunsOnDeps {
  store: Pick<Store, 'setSetting' | 'deleteSetting' | 'settingsWithPrefix'>;
  /** Post its card to the minion's owner and return its id. */
  ask: (ticketId: number, card: ReturnType<typeof runsOnCard>) => string | null;
  /** Take back a card that no longer asks anything. */
  settle: (ticketId: number, cardId: string) => void;
  /** Its place in the line may have changed, and pages show its mark. */
  changed: (ticketId: number) => void;
  now: () => number;
}

export class RunsOn {
  private d: RunsOnDeps;
  private marks: Map<number, Mark>;

  constructor(d: RunsOnDeps) {
    this.d = d;
    this.marks = new Map(d.store.settingsWithPrefix<Mark>(PREFIX).map(({ key, value }) => [Number(key.slice(PREFIX.length)), value]));
  }

  get(ticketId: number): Mark | null {
    return this.marks.get(ticketId) ?? null;
  }

  /** As views show it: its name and who set it, or null for anywhere. */
  view(ticketId: number): { on: string; machine: number | null; by: string; at: number } | null {
    const m = this.get(ticketId);
    return m && { on: m.name, machine: m.machine, by: m.by, at: m.at };
  }

  /** What its turns need now: null anywhere, 0 perigee, else that machine. */
  needs(ticketId: number): number | null {
    const m = this.marks.get(ticketId);
    return !m ? null : m.machine === null || m.once ? 0 : m.machine;
  }

  /** `machine` null is perigee only; no `on` at all is anywhere. */
  set(ticketId: number, on: { machine: number | null; name: string } | null, by: string) {
    this.settle(ticketId);
    this.save(ticketId, on && { ...on, by, at: this.d.now() });
    this.d.changed(ticketId);
  }

  /** Its machine was renamed. */
  renamed(machine: number, was: string, name: string) {
    for (const [id, m] of this.marks) {
      if (m.machine !== machine || m.name !== was) continue;
      this.save(id, { ...m, name });
      this.d.changed(id);
    }
  }

  /** Its waiting turn can't start there: the card, once, and again a day after Keep waiting. */
  stuck(ticketId: number, since: number, block: Block) {
    const m = this.marks.get(ticketId);
    const now = this.d.now();
    if (!m || m.machine === null || m.once) return;
    if (!block.never && now - Math.min(block.since ?? now, since) < UNSEEN_MS) return;
    if (m.card && now - m.card.at < UNSEEN_MS) return;
    this.settle(ticketId);
    const id = this.d.ask(ticketId, runsOnCard(m.name, block.why));
    if (id) this.save(ticketId, { ...m, card: { id, at: now, why: block.why } });
  }

  /** A person's pick on its card, or false when the words are their own. */
  answer(ticketId: number, pick: string | undefined): boolean {
    const m = this.marks.get(ticketId);
    if (pick !== RUN_HERE && pick !== KEEP && pick !== CLEAR) return false;
    if (m) {
      const { card, ...rest } = m;
      if (pick === CLEAR) this.save(ticketId, null);
      else this.save(ticketId, pick === KEEP ? { ...rest, card: { id: '', at: this.d.now(), why: card?.why ?? '' } } : { ...rest, once: true });
    }
    this.d.changed(ticketId);
    return true;
  }

  /** Its wait is over, started or stopped: the once is used, and a card still open asks nothing now. */
  over(ticketId: number) {
    const m = this.marks.get(ticketId);
    if (!m?.once && !m?.card) return;
    this.settle(ticketId);
    const { once: _, card: __, ...rest } = m;
    this.save(ticketId, rest);
  }

  private settle(ticketId: number) {
    const id = this.marks.get(ticketId)?.card?.id;
    if (id) this.d.settle(ticketId, id);
  }

  private save(ticketId: number, mark: Mark | null) {
    if (mark) {
      this.marks.set(ticketId, mark);
      this.d.store.setSetting(`${PREFIX}${ticketId}`, mark);
    } else {
      this.marks.delete(ticketId);
      this.d.store.deleteSetting(`${PREFIX}${ticketId}`);
    }
  }
}
