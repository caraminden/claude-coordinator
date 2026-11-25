// Each ship's place in line and stages, with their times (#1992): looked at every few seconds from the server's side, in
// Citadel's own line and in every scheme that ships with the kit's land.sh, and kept however the ship ended.
import { classifyLandFailure, landPhase as outputPhase, landResult, NO_CODE, type Landing } from './land.ts';
import { heldOf, landPhase, pulledOf, ridingOf, type LandTicket } from './waits.ts';
import type { ShipStep } from './db/wait-records.ts';

type Step = Pick<ShipStep, 'stage' | 'label' | 'place' | 'behind'>;

/** What a step's phase reads as, its clock and commit left out so a new minute isn't a new step. */
const words = (phase: string) =>
  phase
    .replace(/ since \d\d:\d\d$/, '')
    .replace(/, \d+ min so far$/, '')
    .replace(/ \([^)]*\bmin\b[^)]*\)$/, '')
    .replace(/ [0-9a-f]{12}\b/, '');

/** Where line ticket `t` stands; `kit`: the line of the kit's land.sh, whose waiters build and test while they wait. */
export function lineStep(line: LandTicket[], t: LandTicket, name: (label: string) => string, kit: boolean): Step {
  const front = line.find((x) => x.got > 0);
  const ph = landPhase(t.phase);
  const label = ph.label === 'Starting' ? words(t.phase) || 'Starting' : ph.label;
  if (t.got > 0) return { stage: ph.stage, label: label === 'starting' || label === 'waiting' ? 'Starting' : label };
  if (front && ridingOf(t.phase) === front.label) return { stage: landPhase(front.phase).stage, label: `Riding in ${name(front.label)}'s train` };
  const skip = (x: LandTicket) => !!heldOf(x.phase) || !!pulledOf(x.phase) || (!!front && ridingOf(x.phase) === front.label);
  if (heldOf(t.phase)) return { stage: 'line', label: 'Held: main is broken' };
  if (pulledOf(t.phase)) return { stage: 'line', label: 'Pulled off its train' };
  const ahead = line.slice(0, line.indexOf(t)).filter((x) => !skip(x));
  const working = kit && t.phase && t.phase !== 'waiting';
  return { stage: working ? ph.stage : 'line', label: working ? label : 'In line', place: ahead.length + 1, ...(ahead[0] && { behind: name(ahead[0].label) }) };
}

/** Where a handed-off ship outside the line stands, by land.sh's own lines. */
export function outputStep(output: string): Step {
  const p = outputPhase(output).replace(/^landing(: )?/, '');
  const stage = /^(smoke check|own check)/.test(p) ? 'check' : /^(in line|pulled)/.test(p) ? 'line' : /CI|tests|^riding/.test(p) ? 'test' : /^rebasing/.test(p) ? 'rebase' : /^deploying/.test(p) ? 'deploy' : 'start';
  return { stage, label: p ? p[0].toUpperCase() + p.slice(1) : 'Starting' };
}

/** How a ship that ended went. */
export function shipEnd(run: Landing, stopped: { by: string } | null): Pick<ShipStep, 'outcome' | 'why'> {
  const r = landResult(run.output, run.code!);
  if (r.kind === 'no-ci') return { outcome: 'no-ci' };
  if (r.kind === 'unpushed') return { outcome: 'unpushed' };
  if (r.kind !== 'failed') return { outcome: 'shipped' };
  if (stopped) return { outcome: 'stopped', why: stopped.by };
  if (run.output.endsWith(NO_CODE)) return { outcome: 'cut off' };
  const why = classifyLandFailure(run.output)?.kind ?? (r.smoke ? 'smoke' : undefined);
  return { outcome: 'refused', ...(why && { why }) };
}

/** A ship being followed; saved, so a restart mid-ship carries on with it. */
interface Open {
  ship: number;
  /** Its last step, as compared. */
  key: string;
  /** Its land.sh is the server's (a hand-off), so its output and exit code say how it ended. */
  ours?: boolean;
  /** Its end is recorded, its report still to come. */
  ended?: boolean;
  /** Out of the line at the last look: a ticket can be unread for a moment. */
  missed?: boolean;
}

export interface ShipLine {
  line: LandTicket[];
  /** A line of the kit's land.sh. */
  kit: boolean;
  minion(label: string): number | null;
  name(label: string): string;
}

export interface TrailDeps {
  store: {
    getSetting<T>(key: string): T | undefined | null;
    setSetting(key: string, value: unknown): void;
    addWaitRecord(ticketId: number, kind: 'ship', step: ShipStep): void;
  };
  landings: { pending(): Promise<number[]>; look(id: number): Promise<Landing | null>; stopped(id: number): { by: string } | null };
  /** Every ship line there is. */
  lines(): Promise<ShipLine[]>;
  now?: () => number;
}

const KEY = 'ship-trail';

export class ShipTrail {
  private d: TrailDeps;
  private open: Map<number, Open>;
  private polling: Promise<void> | null = null;
  constructor(d: TrailDeps) {
    this.d = d;
    this.open = new Map(Object.entries(d.store.getSetting<Record<string, Open>>(KEY) ?? {}).map(([k, v]) => [Number(k), v]));
  }

  /** Run it before LandHandoffs.poll, so a ship that ended is seen here before it is reported and gone. */
  poll(): Promise<void> {
    return (this.polling ??= this.look().finally(() => {
      this.polling = null;
    }));
  }

  private async look() {
    const [handed, lines] = await Promise.all([this.d.landings.pending(), this.d.lines()]);
    const at = (this.d.now ?? Date.now)();
    const steps = new Map<number, Step>();
    for (const { line, kit, minion, name } of lines) {
      for (const t of line) {
        const id = minion(t.label);
        if (id != null) steps.set(id, lineStep(line, t, name, kit));
      }
    }
    const ours = new Set(handed);
    const before = JSON.stringify([...this.open]);
    for (const id of new Set([...ours, ...steps.keys(), ...this.open.keys()])) {
      let o = this.open.get(id);
      const run = ours.has(id) || o?.ours ? await this.d.landings.look(id) : null;
      // Its exit code is newer than the line, which may still show it.
      const ended = !!run && run.code !== null && ours.has(id);
      const step = ended ? null : (steps.get(id) ?? (run && run.code === null ? outputStep(run.output) : null));
      if (o?.ended) {
        if (!step) {
          if (!ours.has(id)) this.open.delete(id);
          continue;
        }
        o = undefined; // ended, and shipping again
      }
      if (!o) {
        if (!step && !run) continue;
        this.open.set(id, (o = { ship: at, key: '' }));
      }
      if (ours.has(id)) o.ours = true;
      if (step) {
        delete o.missed;
        this.step(id, o, at, step);
      } else if (run && run.code !== null) {
        // Never seen running: its last line still says where it got to.
        if (!o.key) this.step(id, o, at, outputStep(run.output));
        this.end(id, o, at, shipEnd(run, this.d.landings.stopped(id)));
      } else if (o.missed) this.end(id, o, at, { outcome: 'left' });
      else o.missed = true;
    }
    const now = JSON.stringify([...this.open]);
    if (now !== before) this.d.store.setSetting(KEY, Object.fromEntries(this.open));
  }

  private step(id: number, o: Open, at: number, step: Step) {
    const key = JSON.stringify(step);
    if (o.key === key) return;
    o.key = key;
    this.d.store.addWaitRecord(id, 'ship', { at, ship: o.ship, ...step });
  }

  private end(id: number, o: Open, at: number, end: Pick<ShipStep, 'outcome' | 'why'>) {
    this.d.store.addWaitRecord(id, 'ship', { at, ship: o.ship, stage: 'ended', label: 'Ended', ...end });
    o.ended = true;
  }
}
