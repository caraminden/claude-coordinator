// One Peek build while Citadel ships (#1902; Josh, 2026-11-24, picked "One Citadel job, one Peek build", and 2026-11-25 "Yes, use
// labels"): while a ship is in Citadel's line, Peek's spare build runners on the CI desktop lose the label its jobs ask for, so one
// build runs there at a time. A job already running finishes; the rest wait in GitHub's queue, and start once the label is back.
//  - What is taken off is written down before GitHub is asked, so a restart puts it back. With Citadel down it stays off.
//  - RUNNER_CAP_MS at most in one stretch of ships: then the labels go back until the line is clear.
//  - Fails open: GitHub unreadable changes nothing, and only labels written down here are ever put back.
//  - Off switch: the hold's own, <deploy state>/hold-off (src/ci-hold.ts).
// It asks with the login of the scheme's owner, as Citadel's other runner work does (src/ci-runner.ts).
import type { Listed, RunnerTokens } from './ci-runner.ts';
import { pcOf, type Pcs } from './ci-ships.ts';
import type { Project, Store } from './db.ts';
import { every, type Job } from './every.ts';
import { thrown } from './thrown.ts';

/** The longest the labels stay off in one stretch of ships (Josh's card: 4 hours). */
export const RUNNER_CAP_MS = 4 * 3600_000;
export const RUNNER_CAP_POLL_MS = 15_000;
/** While nothing changed, GitHub is asked this often: a runner that came back may carry the label again. */
const LOOK_MS = 60_000;
/** Labels that could not be put back this long are told to the scheme's Taskmaster, once. */
const REPORT_MS = 10 * 60_000;

interface Off {
  id: number;
  name: string;
  label: string;
}
interface CapState {
  /** When this stretch of ships began; null between stretches. */
  since: number | null;
  off: Off[];
  /** Since when labels that should be back are not. */
  late: number | null;
  told: boolean;
}

export interface CapDeps {
  /** The scheme whose builds are capped; null when there is none here. */
  project: () => Project | null;
  /** The label its build jobs ask for. */
  label: (project: Project) => string;
  /** Why a ship holds the desktop, or null: no ship, or the off switch. */
  why: () => string | null;
  /** Whether a runner of that name is on the PC Citadel's ships test on; null while that PC isn't known (a server that just started). */
  here: () => ((runner: string) => boolean) | null;
  tokens: Pick<RunnerTokens, 'listed' | 'dropLabel' | 'addLabel'>;
  store: Pick<Store, 'getSetting' | 'setSetting'>;
  report: (project: Project, text: string) => void;
  log?: (line: string) => void;
}

const KEY = 'runner-cap';
const NONE: CapState = { since: null, off: [], late: null, told: false };

export class RunnerCap {
  private d: CapDeps;
  private looked = 0;
  private was: boolean | null = null;
  private busy = false;
  private job: Job | null = null;

  constructor(d: CapDeps) {
    this.d = d;
  }

  start() {
    this.job ??= every('runner cap', RUNNER_CAP_POLL_MS, () => this.tick(), 30_000);
  }

  stop() {
    this.job?.stop();
    this.job = null;
  }

  /** Whether this took `label` off that runner and owes it back. */
  owes(id: number, label: string): boolean {
    return this.s.off.some((o) => o.id === id && o.label === label);
  }

  /** For the CI page: what is capped now, or null; only to who sees the scheme. */
  text(canSee: (project: number) => boolean): string | null {
    const p = this.d.project();
    const n = this.s.off.length;
    if (!p || !n || !canSee(p.id)) return null;
    const are = `${n} runner${n === 1 ? '' : 's'}`;
    return this.s.late !== null ? `${p.name}'s build label is still off ${are}: putting it back failed, trying again` : `${p.name} builds one at a time (${are} resting) while ships go first`;
  }

  /** Read each time: across a handover two servers may each be in a tick. */
  private get s(): CapState {
    return { ...NONE, ...this.d.store.getSetting<CapState>(KEY) };
  }

  private save(change: Partial<CapState>) {
    this.d.store.setSetting(KEY, { ...this.s, ...change });
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const p = this.d.project();
      if (!p) return;
      const ship = !!this.d.why();
      this.clear(ship);
      if (ship && this.s.since === null) this.save({ since: now });
      const cap = ship && now - this.s.since! < RUNNER_CAP_MS;
      const changed = cap !== this.was;
      this.was = cap;
      if ((!cap && !this.s.off.length) || (!changed && now - this.looked < LOOK_MS)) return;
      this.looked = now;
      await (cap ? this.take(p) : this.putBack(p, now));
      this.clear(ship);
    } catch (err) {
      (this.d.log ?? console.error)(`Runner cap: ${thrown(err).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** A stretch ends once the line is clear and every label is back: one that can't go back yet keeps its 4 hours. */
  private clear(ship: boolean) {
    if (!ship && this.s.since !== null && !this.s.off.length) this.save({ since: null });
  }

  private async take(p: Project) {
    const label = this.d.label(p);
    const on = this.d.here();
    if (!label || !on) return;
    const here = (await this.d.tokens.listed(p)).filter((x) => on(x.name) && (x.labels.includes(label) || this.s.off.some((o) => o.id === x.id)));
    const online = here.filter((x) => x.status === 'online');
    const keep = online.find((x) => x.labels.includes(label) && x.busy) ?? online.find((x) => x.labels.includes(label)) ?? online[0];
    // No runner of it is there to build on: nothing to cap, and the labels go back for whichever comes first.
    if (!keep) return this.back(p, here);
    if (!keep.labels.includes(label)) await this.back(p, [keep], [keep.id]);
    for (const x of here) {
      if (x.id === keep.id || !x.labels.includes(label)) continue;
      // Written down first: a label gone and not written down would never come back.
      this.owe({ id: x.id, name: x.name, label });
      await this.d.tokens.dropLabel(p, x.id, label);
      // Another server (a handover) may have seen it still there, and forgotten it.
      this.owe({ id: x.id, name: x.name, label });
    }
  }

  private owe(o: Off) {
    if (!this.owes(o.id, o.label)) this.save({ off: [...this.s.off, o] });
  }

  private async putBack(p: Project, now: number) {
    let failed: string | undefined;
    try {
      await this.back(p, await this.d.tokens.listed(p));
    } catch (err) {
      failed = thrown(err).message;
    }
    if (!this.s.off.length) return;
    if (this.s.late === null) this.save({ late: now });
    (this.d.log ?? console.error)(`Runner cap: ${failed}`);
    if (this.s.told || now - this.s.late! < REPORT_MS) return;
    this.save({ told: true });
    const names = this.s.off.map((o) => o.name).join(', ');
    this.d.report(p, `Citadel took the label ${this.s.off[0].label} off ${names} while its ships went first and can't put it back (${failed}). It keeps trying. By hand: give each that label in the repo's Settings → Actions → Runners.`);
  }

  /** Put the label back on the runners written down (or only those with these ids), forgetting one GitHub neither lists nor finds. */
  private async back(p: Project, listed: Listed[], only?: number[]) {
    let failed: string | undefined;
    for (const o of this.s.off.filter((x) => !only || only.includes(x.id))) {
      const at = listed.find((x) => x.id === o.id);
      try {
        if (at?.labels.includes(o.label) || (await this.d.tokens.addLabel(p, o.id, o.label)) || !at) this.save({ off: this.s.off.filter((x) => x.id !== o.id) });
        else failed = `GitHub lists ${o.name} but couldn't find it`;
      } catch (err) {
        failed = thrown(err).message;
      }
    }
    if (failed) throw new Error(failed);
    if (!this.s.off.length) this.save({ late: null, told: false });
  }
}

/** Tells `repo`'s runners on the PCs that host `slug`'s own, by name; null while no such PC is known. */
export function runnersBeside(pcs: Pcs, slug: string | null, repo: string): ((runner: string) => boolean) | null {
  const own = `${slug?.toLowerCase()}/`;
  const hosts = [...pcs].filter(([, runners]) => [...runners].some((r) => r.startsWith(own))).map(([host]) => host);
  return hosts.length ? (runner) => hosts.includes(pcOf({ repo, runner }, pcs) ?? '') : null;
}
