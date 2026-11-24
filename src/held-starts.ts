// Citadel's own minions wait while the box is starved (#1302, performance P8 shape B; specs/automatic-work-yields.md).
// A scheduled run or a flaky-test fixer that comes due while src/pressure.ts says starved is made at once, but its brief
// is held: the minion is sealed, with a note saying when it starts. The schedules' 30 s tick sends it once the box is
// not starved, or after HOLD_MAX_MS, whichever is first; Unseal ("Start now") sends it at once. Only these two callers
// ask. A person's or a Taskmaster's start, a follow-on and every wake never read the pressure (Cara, 2026-11-20 14:44 PST:
// "Only Citadel's own", "Yes, wake at once"), and no gate sits in the runner.
// The list is in the settings table like the chains in src/wake.ts, so a restart keeps it; an entry is removed before its
// brief is sent, so it goes once only.
import type { Store } from './db.ts';
import type { Runner } from './runner.ts';
import type { PressureReading } from './pressure.ts';
import { clockTime } from './pacific.ts';

const KEY = 'held-starts';
/** A held brief is sent after this long even when the box is still starved (a starting number). */
export const HOLD_MAX_MS = 10 * 60_000;

export interface HeldStart {
  ticket: number;
  from: string;
  message: string;
  since: number;
  /** The brief's send options (a schedule's name, `brief: true`). */
  opts: Record<string, unknown>;
  /** The schedule that made it, so its run log can say how long it was held. */
  schedule?: number;
}

export interface HeldStartsDeps {
  store: Store;
  runner: Pick<Runner, 'emit' | 'send'>;
  read: () => Promise<PressureReading>;
  broadcastTicket?: (id: number) => void;
  broadcast?: (msg: object) => void;
  now?: () => number;
}

export class HeldStarts {
  private d: HeldStartsDeps;
  private ticking = false;

  constructor(d: HeldStartsDeps) {
    this.d = d;
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }
  list(): HeldStart[] {
    return this.d.store.getSetting<HeldStart[]>(KEY) ?? [];
  }
  has(ticket: number): boolean {
    return this.list().some((h) => h.ticket === ticket);
  }

  /**
   * Send a freshly made minion's brief now, or hold it when the box is starved. `send` is what the caller would have
   * done at once. Returns whether it was held.
   */
  async start(h: Omit<HeldStart, 'since'>, send: () => void): Promise<boolean> {
    let r: PressureReading | null = null;
    try {
      r = await this.d.read();
    } catch {
      /* an unreadable box is not starved */
    }
    if (!r?.starved) {
      send();
      return false;
    }
    const since = this.now();
    this.d.store.setSetting(KEY, [...this.list().filter((o) => o.ticket !== h.ticket), { ...h, since }]);
    this.d.store.updateTicket(h.ticket, { state: 'parked', note: `Waiting for the box (${r.why.replace(' pressure', '')}), starts by ${clockTime(since + HOLD_MAX_MS)}` });
    this.d.runner.emit(h.ticket, 'note', { text: `The box is starved (${r.why}): this brief waits up to ${HOLD_MAX_MS / 60_000} minutes. Unseal starts it now.` });
    this.d.broadcastTicket?.(h.ticket);
    return true;
  }

  /** What wakes a held minion by itself (runner.wakesOn: the Waiting look and the Taskmaster's sheet), or null. */
  wakesOn(ticket: number): string | null {
    const h = this.list().find((o) => o.ticket === ticket);
    return h ? `the box has room, or by ${clockTime(h.since + HOLD_MAX_MS)}` : null;
  }

  /** Take one entry out of the list, once. Null when it is gone already (sent, or never held). */
  private claim(ticket: number): HeldStart | null {
    const all = this.list();
    const h = all.find((o) => o.ticket === ticket);
    if (!h) return null;
    this.d.store.setSetting(
      KEY,
      all.filter((o) => o !== h),
    );
    return h;
  }

  /** Send a held brief now, with no pressure check. False when nothing was held for it. */
  release(ticket: number, why: string): boolean {
    const h = this.claim(ticket);
    if (!h) return false;
    const t = this.d.store.getTicket(ticket);
    // Dismissed meanwhile, or someone took it out of sealed another way: it is theirs now, so no second brief.
    if (!t || t.status === 'closed' || t.state !== 'parked') return true;
    const mins = Math.max(0, Math.round((this.now() - h.since) / 60_000));
    this.d.store.updateTicket(ticket, { state: null, note: null });
    if (h.schedule !== undefined) this.d.store.schedules.heldNote(h.schedule, `Held ${mins} min for the box, then started (${why})`);
    this.d.runner.emit(ticket, 'note', { text: `Held ${mins} min for the box; ${why}, so this minion started.` });
    this.d.runner.send(ticket, h.from, h.message, [], h.opts);
    this.d.broadcastTicket?.(ticket);
    if (h.schedule !== undefined) this.d.broadcast?.({ type: 'schedules', projectId: t.project_id });
    return true;
  }

  /** The 30 s check: send what the box has room for, and what has waited long enough. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const held = this.list();
      if (!held.length) return;
      let starved = true;
      try {
        starved = (await this.d.read()).starved;
      } catch {
        starved = false;
      }
      const now = this.now();
      for (const h of held) {
        if (!starved) this.release(h.ticket, 'the box has room');
        else if (now - h.since >= HOLD_MAX_MS) this.release(h.ticket, `it waited ${HOLD_MAX_MS / 60_000} minutes`);
      }
    } finally {
      this.ticking = false;
    }
  }
}
