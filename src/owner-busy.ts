// The owner's own use of a machine lending CI (Build 11 P4, specs/one-runner-pool.md section 6; Cara, 2026-11-27, #2264's
// card: "Also step back when you're busy", and "if a machine doesnt have room, we can wait and load balance, not run the job
// starved"). The only lever is whether a new job may start there: a running job is never slowed or stopped.
//   - Pause: its owner presses Pause on the machine's card, for an hour, until tomorrow morning, or until resumed. Kept as a
//     setting, so a restart keeps it.
//   - Stepping back: the machine is busy while a full-screen game or app is in front (the PC's machine agent, which runs in
//     its owner's signed-in session, asks Windows: public/machine-agent.mjs frontNow; the runner agent runs as SYSTEM in
//     session 0, which can't see the person's screen), or its owner's own programs (the PC's CPU less its CI runners') used
//     over half the CPU for 2 minutes, or its free memory is under what the next job there needs. It clears after 5 quiet
//     minutes, so it doesn't flicker. "Run CI anyway" sets that spell aside until it clears.
// Every number here is #2264's starting value, not Cara's: tune them here and nowhere else.
import { pacificClock, pacificDay, pacificDayStart, pacificStamp } from './pacific.ts';
import type { Sample } from './ci-load.ts';

const MIN = 60_000;

export const BUSY = {
  /** The owner's own programs over this share of the whole PC's CPU... */
  ownerCpu: 50,
  /** ...for this long is busy. */
  cpuForMs: 2 * MIN,
  /** Busy clears once nothing has made it busy for this long. */
  quietMs: 5 * MIN,
  /** What a CI job needs in memory, per thread of its size (a plain 4-thread job: 4 GB). */
  memPerThreadGb: 1,
  /** A machine agent's word on what is in front holds this long (it says every 30 seconds). */
  frontStaleMs: 2 * MIN,
  /** A runner agent's load sample older than this says nothing about now (it sends one every 30 seconds). */
  sampleStaleMs: 3 * MIN,
  /** "Until tomorrow" ends at this hour, Pacific, the next morning. */
  tomorrowHour: 8,
} as const;

/** What a machine agent says is in front of its person: a game (Direct3D full screen), another full-screen app, a presentation, or nothing. */
export type Front = 'game' | 'fullscreen' | 'presenting' | null;
export const FRONTS: readonly Front[] = ['game', 'fullscreen', 'presenting', null];

/** One look at a machine: what is in front, its owner's own CPU % (null: no fresh sample), its free memory in bytes and the next job's need. */
export interface BusyLook {
  now: number;
  front: Front;
  ownerCpu: number | null;
  memFree: number | null;
  memNeed: number;
}

export interface BusyState {
  /** Why, in plain words ("Cara is in a game"): the latest thing that made it busy, kept through the quiet minutes. */
  why: string;
  /** When this busy spell began (ms). */
  since: number;
  /** Its owner pressed "Run CI anyway" in this spell: jobs start there as if it weren't busy. */
  anyway: boolean;
}

const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

/** Why a look makes the machine busy right now (before the 2-minute CPU rule and the quiet minutes), or null. */
function trigger(look: BusyLook, owner: string, cpuHighSince: number | null): string | null {
  if (look.front === 'game') return `${owner} is in a game`;
  if (look.front === 'presenting') return `${owner} is presenting`;
  if (look.front === 'fullscreen') return 'a full-screen app is running';
  if (cpuHighSince !== null && look.now - cpuHighSince >= BUSY.cpuForMs) return `${owner}'s own programs are using ${Math.round(look.ownerCpu ?? 0)}% of the CPU`;
  if (look.memFree !== null && look.memFree < look.memNeed) return `only ${gb(look.memFree)} GB of memory free, and the next job needs ${gb(look.memNeed)} GB`;
  return null;
}

/** One machine's busy spell, fed a look at every pool pass; its clock is the looks' `now`, so a test drives it with a fake one. */
export class BusyWatch {
  private cpuHighSince: number | null = null;
  private quietSince: number | null = null;
  private spell: BusyState | null = null;

  see(look: BusyLook, owner: string): BusyState | null {
    const high = look.ownerCpu !== null && look.ownerCpu > BUSY.ownerCpu;
    this.cpuHighSince = high ? (this.cpuHighSince ?? look.now) : null;
    const why = trigger(look, owner, this.cpuHighSince);
    if (why) {
      this.quietSince = null;
      this.spell = this.spell ? { ...this.spell, why } : { why, since: look.now, anyway: false };
    } else if (this.spell) {
      this.quietSince ??= look.now;
      if (look.now - this.quietSince >= BUSY.quietMs) this.spell = this.quietSince = null;
    }
    return this.state();
  }

  state(): BusyState | null {
    return this.spell ? { ...this.spell } : null;
  }

  /** "Run CI anyway": this spell no longer holds jobs back; a new spell after it clears does. False when it isn't busy. */
  anyway(): boolean {
    if (!this.spell) return false;
    this.spell.anyway = true;
    return true;
  }
}

/** The owner's own programs' share of the CPU in one sample: the PC's (the host's counters, which leave Hyper-V guests out) less its CI runners'. */
export function ownerCpu(s: Pick<Sample, 'cpu' | 'runners'>): number {
  return Math.max(0, s.cpu - s.runners.reduce((a, r) => a + r.cpu, 0));
}

export interface Pause {
  /** When it ends (ms); null: until its owner resumes it. */
  until: number | null;
  /** Who pressed it, and when. */
  by: string;
  at: number;
}
export type PauseFor = 'hour' | 'tomorrow' | 'resumed';
export const PAUSE_FOR: readonly PauseFor[] = ['hour', 'tomorrow', 'resumed'];
export const pauseKey = (machine: number) => `ci_pause:${machine}`;

const HOUR = 60 * MIN;

/** The first ms of the Pacific day after the one `ms` is in. */
const nextDayStart = (ms: number) => pacificDayStart(pacificDay(pacificDayStart(pacificDay(ms))! + 36 * HOUR))!;

/** When a pause pressed at `now` ends: an hour on, BUSY.tomorrowHour Pacific the next morning, or null (until resumed). */
export function pauseEnd(kind: PauseFor, now: number): number | null {
  if (kind === 'hour') return now + HOUR;
  if (kind === 'resumed') return null;
  const start = nextDayStart(now);
  // A DST day is 23 or 25 hours, changed at 2 AM, before the hour: the hour lost or gained comes before it.
  return start + BUSY.tomorrowHour * HOUR + (nextDayStart(start) - start - 24 * HOUR);
}

/** A pause that still holds at `now`, or null (none, or it ended). */
export function pauseNow(p: Pause | null | undefined, now: number): Pause | null {
  return p && (p.until === null || p.until > now) ? p : null;
}

/** "until 9:42 PM PST", "until tomorrow, 8:00 AM PST", "until Nov 30, 8:00 AM PST", or "until resumed". */
export function pauseWords(p: Pick<Pause, 'until'>, now: number): string {
  if (p.until === null) return 'until resumed';
  if (pacificDay(p.until) === pacificDay(now)) return `until ${pacificClock(p.until)}`;
  return pacificDay(p.until) === pacificDay(nextDayStart(now)) ? `until tomorrow, ${pacificClock(p.until)}` : `until ${pacificStamp(p.until)}`;
}

/** What the card and the pool read about one machine's owner's use. */
export interface OwnerUse {
  pause: (Pause & { words: string }) | null;
  busy: BusyState | null;
}

/** Why the pool starts nothing new on a machine now, after `${name} `, or null: paused first, then stepping back unless "Run CI anyway". */
export function offWords(use: OwnerUse): string | null {
  if (use.pause) return `is paused ${use.pause.words}`;
  if (use.busy && !use.busy.anyway) return `is stepping back: ${use.busy.why}`;
  return null;
}

interface Settings {
  getSetting<T>(key: string): T | null;
  setSetting(key: string, value: unknown): void;
  deleteSetting(key: string): void;
}

export interface OwnerBusyDeps {
  store: Settings;
  now(): number;
  /** The newest load sample of the machine's runner agent for its own OS (Windows first, where the person is), or null. */
  sample(machine: number): Sample | null;
  /** Its owner's name, for "Cara is in a game". */
  owner(machine: number): string;
}

/** Every machine's pause and busy spell. The pool calls look() at each pass; the routes call front(), pause() and anyway(). */
export class OwnerBusy {
  private watches = new Map<number, BusyWatch>();
  private fronts = new Map<number, { front: Front; at: number }>();
  private d: OwnerBusyDeps;
  constructor(d: OwnerBusyDeps) {
    this.d = d;
  }

  /** A machine agent's word on what is in front of its person (every 30 seconds, on Windows). */
  front(machine: number, front: Front): void {
    this.fronts.set(machine, { front, at: this.d.now() });
  }

  private watch(machine: number): BusyWatch {
    let w = this.watches.get(machine);
    if (!w) this.watches.set(machine, (w = new BusyWatch()));
    return w;
  }

  /** Feed the machine's watch what it shows now, and say its pause and busy spell. `memNeedGb`: what the next job there needs. */
  look(machine: number, memNeedGb: number): OwnerUse {
    const now = this.d.now();
    const f = this.fronts.get(machine);
    const s = this.d.sample(machine);
    const fresh = s && now - s.at < BUSY.sampleStaleMs ? s : null;
    const busy = this.watch(machine).see(
      { now, front: f && now - f.at < BUSY.frontStaleMs ? f.front : null, ownerCpu: fresh ? ownerCpu(fresh) : null, memFree: fresh ? fresh.mem_free : null, memNeed: memNeedGb * 1024 ** 3 },
      this.d.owner(machine),
    );
    return { pause: this.pauseOf(machine, now), busy };
  }

  /** Its pause and busy spell as the last look left them, without feeding the watch. */
  use(machine: number): OwnerUse {
    return { pause: this.pauseOf(machine, this.d.now()), busy: this.watches.get(machine)?.state() ?? null };
  }

  private pauseOf(machine: number, now: number): OwnerUse['pause'] {
    const p = pauseNow(this.d.store.getSetting<Pause>(pauseKey(machine)), now);
    return p ? { ...p, words: pauseWords(p, now) } : null;
  }

  pause(machine: number, kind: PauseFor, by: string): OwnerUse {
    const now = this.d.now();
    this.d.store.setSetting(pauseKey(machine), { until: pauseEnd(kind, now), by, at: now } satisfies Pause);
    return this.use(machine);
  }

  resume(machine: number): OwnerUse {
    this.d.store.deleteSetting(pauseKey(machine));
    return this.use(machine);
  }

  /** "Run CI anyway" for this busy spell; false when it isn't busy. */
  anyway(machine: number): boolean {
    return this.watches.get(machine)?.anyway() ?? false;
  }
}
