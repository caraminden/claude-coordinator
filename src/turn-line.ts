// The worker pool (#1868). Josh, 2026-11-24: "we have a pool of claude sessions that are capped across the whole citadel,
// they can be reallocated between users as the users are asking for different amounts of work". A worker is one claude
// process running one minion's turn. Past the pool's size a turn waits in a line, saved in the settings table so a
// restart keeps it, and starts as workers free. Taskmasters, the Overlord and hidden keepalives take no worker.
//
// The line holds no messages: those stay in each minion's queue (src/minion-queue.ts), and a resume's wait or debt stays
// where it was (src/resumes.ts, the queue's `owed`). An entry says only "this minion has a turn to start", so one whose
// turn needs no starting any more is simply dropped when it comes up.
import type { Store } from './db.ts';
import type { PressureReading } from './pressure.ts';
import { limitsOf, refuse, LIMIT_INFO, type LimitKey, type PoolBox, type PoolLimits, type SavedLimits } from './turn-limits.ts';
import type { RetryKind } from './turn-outcome.ts';
import type { WorkerWait } from './worker-wait.ts';

/** The pool's fixed numbers. What Auto steers by (fewest and most, the pressure lines, the time per step) is src/turn-limits.ts, tunable (#1892). */
export const POOL = {
  start: 10,
  everyMs: 10_000,
  /** Workers each person with work gets before anyone gets more. */
  first: 2,
  /** Waited this long, it goes with the front group, so automatic work can't wait for ever. */
  agedMs: 20 * 60_000,
};

const LINE = 'turn-line';
const SIZE = 'turn-pool';
const PAUSE = 'turns-paused';
const LIMITS = 'turn-pool-limits';

/** `via`: the auto-resume it waits to start, else its queue's turn. */
export interface LineEntry {
  ticket: number;
  since: number;
  via?: RetryKind;
}

/** A pool's saved size: Auto's current one and when it moved, and the number a person set instead, if one did. */
export interface PoolSize {
  size: number;
  at: number;
  why?: string;
  fixed?: { size: number; by: string };
}

/** No minion turn starts until it is lifted; those running finish, or with `stop` stop and carry on after it. */
export interface Pause {
  by: string;
  stop?: true;
  at: number;
}

/** Whether a minion waits for a worker, for a reader with only the database. */
export const inLine = (store: Pick<Store, 'getSetting'>, ticketId: number) => (store.getSetting<LineEntry[]>(LINE) ?? []).some((e) => e.ticket === ticketId);

/** A waiting turn as `pick` sees it. `rank`: 0 a person's own message or answer, 1 work started for them, 2 automatic. */
export interface Waiting {
  ticket: number;
  since: number;
  person: number;
  rank: number;
}

/** Which line made Auto shrink, for the tile. */
function starveWhy(r: Pick<PressureReading, 'cpu' | 'mem'>, box: PoolBox, L: PoolLimits): string {
  if (box.level === 'tight') return 'memory is tight';
  if (r.cpu !== null && r.cpu >= L.shrinkCpu) return `CPU pressure ${r.cpu}%`;
  if (r.mem !== null && r.mem >= L.shrinkMem) return `memory pressure ${r.mem}%`;
  return `${box.freeGb?.toFixed(1)} GB free`;
}

/** Whether the box is over a shrink line. Memory level `tight` shrinks whatever the lines are set to. */
export function starvedBy(r: Pick<PressureReading, 'cpu' | 'mem'>, box: PoolBox, L: PoolLimits): boolean {
  return box.level === 'tight' || (r.cpu !== null && r.cpu >= L.shrinkCpu) || (r.mem !== null && r.mem >= L.shrinkMem) || (box.freeGb !== null && box.freeGb < L.shrinkFreeGb);
}

/** Auto's next size. A shrink counts from what runs: a size above that would let a burst (a Resume) start on a starved box. */
export function nextSize(s: { size: number; at: number; used: number; waiting: number }, r: Pick<PressureReading, 'cpu' | 'mem'>, box: PoolBox, L: PoolLimits, now: number): number {
  // A fewest or most set past the size takes effect on the next tick, whatever the box is doing.
  if (s.size > L.max || s.size < L.min) return Math.min(L.max, Math.max(L.min, s.size));
  if (starvedBy(r, box, L)) return now - s.at < L.shrinkSec * 1000 ? s.size : Math.max(L.min, Math.min(s.size, s.used) - 1);
  const calm = r.cpu !== null && r.cpu < L.growCpu && (r.mem ?? 0) < L.growMem && box.level === 'ok';
  if (!calm || !s.waiting || s.used < s.size || now - s.at < L.growSec * 1000) return s.size;
  return Math.max(s.size, Math.min(L.max, s.size + 1));
}

/**
 * Whose turn a free worker takes: the person furthest below their share, then the first in their order. Everyone's first
 * two workers come before anyone's third; past that a share is in proportion to what a person has running and waiting.
 */
export function pick(waiting: Waiting[], running: Map<number, number>, now: number): Waiting | null {
  const wants = new Map<number, number>();
  for (const w of waiting) wants.set(w.person, (wants.get(w.person) ?? running.get(w.person) ?? 0) + 1);
  const share = (person: number) => {
    const n = running.get(person) ?? 0;
    return n < POOL.first ? n - POOL.first : n / wants.get(person)!;
  };
  const oldest = new Map<number, number>();
  for (const w of waiting) oldest.set(w.person, Math.min(oldest.get(w.person) ?? Infinity, w.since));
  const rank = (w: Waiting) => (now - w.since >= POOL.agedMs ? 0 : w.rank);
  let best: Waiting | null = null;
  for (const w of waiting) {
    const by = best && (share(w.person) - share(best.person) || oldest.get(w.person)! - oldest.get(best.person)! || w.person - best.person || rank(w) - rank(best) || w.since - best.since || w.ticket - best.ticket);
    if (by === null || by < 0) best = w;
  }
  return best;
}

/** What the line needs of the Runner. */
export interface LineHost {
  store: Pick<Store, 'getSetting' | 'setSetting' | 'deleteSetting' | 'addHealthEvent'>;
  /** Takes no worker: a Taskmaster or the Overlord, or a minion that is gone. */
  exempt(ticketId: number): boolean;
  /** A step runs on its lane, so nothing of it can start now. */
  busy(ticketId: number): boolean;
  /** Whose share its turn counts in, and its place there. */
  asks(ticketId: number, via?: RetryKind): { person: number; rank: number };
  /** Start its turn, now that a worker is free: it calls enter() again, which grants it. */
  start(entry: LineEntry): void;
  /** Stop its running turn to carry on later; one already ending or not yet launched is left. */
  pauseTurn(ticketId: number): void;
  /** Who waits, or why they all do, changed. */
  changed(ids: number[]): void;
  readonly gapMs: number;
  readonly detached: boolean;
}

export class TurnLine {
  private host: LineHost;
  private entries: LineEntry[];
  /** Workers in use: the minion, how many of its lane's steps count on it (an account switch queues its resume in its turn's end), and whose share. */
  private granted = new Map<number, { steps: number; person: number }>();
  private admitting: number | null = null;
  private timer?: NodeJS.Timeout;
  /** Until a boot's resumes are in (open): the line takes turns in but starts none. */
  private closed = false;
  /** People whose container stalls at its own memory limit, which the box's readings barely show (#1874). */
  private stalled = new Set<number>();
  private ordered: { at: number; ids: number[] } | null = null;

  constructor(host: LineHost) {
    this.host = host;
    this.entries = host.store.getSetting<LineEntry[]>(LINE) ?? [];
  }

  used(): number {
    return this.granted.size;
  }

  /** The waiting minions, first in first. */
  waiting(): number[] {
    return this.entries.map((e) => e.ticket);
  }

  has(ticketId: number): boolean {
    return this.entries.some((e) => e.ticket === ticketId);
  }

  /** The waiting minions in the order they would start in if nothing else came. */
  order(): number[] {
    if (this.ordered && Date.now() - this.ordered.at < 1000) return this.ordered.ids;
    const running = this.byPerson();
    let rest = this.asked(this.entries);
    const ids: number[] = [];
    for (let w = pick(rest, running, Date.now()); w; w = pick(rest, running, Date.now())) {
      ids.push(w.ticket);
      running.set(w.person, (running.get(w.person) ?? 0) + 1);
      rest = rest.filter((r) => r !== w);
    }
    this.ordered = { at: Date.now(), ids };
    return ids;
  }

  wait(ticketId: number): WorkerWait | null {
    const entry = this.entries.find((e) => e.ticket === ticketId);
    if (!entry) return null;
    return { since: entry.since, place: this.order().indexOf(ticketId) + 1, of: this.entries.length, paused: this.paused()?.by ?? null };
  }

  /** Each person's workers and waiting turns, the most first. */
  people(): { person: number; used: number; waiting: number; stalled?: true }[] {
    const out = new Map([...this.byPerson()].map(([person, used]) => [person, { person, used, waiting: 0 }]));
    for (const w of this.asked(this.entries)) out.set(w.person, { person: w.person, used: 0, ...out.get(w.person), waiting: (out.get(w.person)?.waiting ?? 0) + 1 });
    return [...out.values()].map((p) => (this.full(p.person) ? { ...p, stalled: true as const } : p)).sort((a, b) => b.used + b.waiting - a.used - a.waiting || a.person - b.person);
  }

  pool(): PoolSize {
    return this.host.store.getSetting<PoolSize>(SIZE) ?? { size: POOL.start, at: 0 };
  }

  size(): number {
    const p = this.pool();
    return p.fixed?.size ?? p.size;
  }

  /** The limits Auto steers by: the saved changes over the defaults. */
  limits(): PoolLimits {
    return limitsOf(this.host.store.getSetting<SavedLimits>(LIMITS));
  }

  savedLimits(): SavedLimits {
    return this.host.store.getSetting<SavedLimits>(LIMITS) ?? { values: {}, by: {} };
  }

  /**
   * People's changes: a number sets that limit, null puts back its default. All or none: a set that can't be used throws the reason.
   * Each one is a health event, so the Status graphs can be read against it.
   */
  setLimits(changes: Partial<Record<LimitKey, number | null>>, by: string, now = Date.now()) {
    const saved = this.savedLimits();
    const next: SavedLimits = { values: { ...saved.values }, by: { ...saved.by } };
    const before = this.limits();
    const lines: string[] = [];
    for (const i of LIMIT_INFO) {
      const v = changes[i.key];
      if (v === undefined) continue;
      if (v === null) delete next.values[i.key];
      else next.values[i.key] = v;
      next.by[i.key] = { by, at: now };
    }
    const after = limitsOf(next);
    const why = refuse(after);
    if (why) throw new Error(why);
    for (const i of LIMIT_INFO) if (changes[i.key] !== undefined && before[i.key] !== after[i.key]) lines.push(`${i.label}: ${before[i.key]} to ${after[i.key]} ${i.unit}`);
    if (!lines.length) return;
    this.host.store.setSetting(LIMITS, next);
    this.host.store.addHealthEvent('pool-limits', now, null, `${by} changed the worker pool's limits. ${lines.join('; ')}`);
    this.pump();
  }

  /** What the Workers tile shows (src/routes/workers.ts). */
  summary() {
    return { used: this.used(), size: this.size(), pool: this.pool(), paused: this.paused(), waiting: this.entries.length, people: this.people() };
  }

  /** A person's number, or null for Auto. */
  setSize(size: number | null, by: string) {
    const { fixed: _, ...p } = this.pool();
    this.host.store.setSetting(SIZE, size === null ? p : { ...p, fixed: { size, by } });
    this.pump();
  }

  /** Auto's step, every POOL.everyMs. `box`: free memory and the memory level. `stalled`: the people whose container is at its memory limit: no more of their turns start until it recovers. */
  tick(reading: PressureReading, stalled: Iterable<number> = [], now = Date.now(), box: PoolBox = { freeGb: null, level: 'ok' }) {
    // A turn still launching when the pause came, or re-attached since.
    if (this.paused()?.stop) this.stopRunning();
    const p = this.pool();
    this.stalled = new Set(p.fixed ? [] : stalled);
    this.pumpIn(0);
    if (p.fixed) return;
    const size = nextSize({ ...p, used: this.used(), waiting: this.entries.length }, reading, box, this.limits(), now);
    if (size === p.size) return;
    this.host.store.setSetting(SIZE, { size, at: now, why: size < p.size ? starveWhy(reading, box, this.limits()) : 'perigee is calm and turns wait' });
    this.pump();
  }

  paused(): Pause | null {
    return this.host.store.getSetting<Pause>(PAUSE) ?? null;
  }

  setPause(on: boolean | 'stop', by: string) {
    if (on) this.host.store.setSetting(PAUSE, { by, at: Date.now(), ...(on === 'stop' ? { stop: true } : {}) } satisfies Pause);
    else this.host.store.deleteSetting(PAUSE);
    if (on === 'stop') this.stopRunning();
    this.host.changed(this.waiting());
    this.pump();
  }

  private stopRunning() {
    for (const id of this.granted.keys()) this.host.pauseTurn(id);
  }

  /** Take a worker for a turn that starts now, or join the line (keeping a place it has) and return false: start() comes later. */
  enter(ticketId: number, via?: RetryKind): boolean {
    if (this.host.exempt(ticketId)) return true;
    const held = this.granted.get(ticketId);
    const paused = !!this.paused();
    // Only the turn that holds it goes on (an account switch queues its resume in its turn's end); a resume its save holds up takes its turn in the line.
    if (held && !paused && (via === 'switch' || !via)) {
      held.steps++;
      return true;
    }
    if (this.admitting === ticketId) return this.grant(ticketId, via);
    const own = this.entries.find((e) => e.ticket === ticketId);
    // Its queue's turn never goes before the resume it waits for: the resume takes the queue along.
    const first = !paused && !this.closed && !this.host.busy(ticketId) && this.granted.size < this.size() && !(own?.via && !via) && !this.full(this.host.asks(ticketId, via).person);
    if (first) {
      const me = own ?? { ticket: ticketId, since: Date.now(), via };
      const rest = this.ready().filter((e) => e.ticket !== ticketId);
      if (!rest.length || this.best([me, ...rest])?.ticket === ticketId) return this.grant(ticketId, via);
    }
    this.join(ticketId, via);
    return false;
  }

  /** Into the line (keeping a place it has), taking no worker even when one is free. */
  join(ticketId: number, via?: RetryKind) {
    if (this.host.exempt(ticketId)) return;
    const own = this.entries.find((e) => e.ticket === ticketId);
    if (!own) this.save([...this.entries, { ticket: ticketId, since: Date.now(), ...(via ? { via } : {}) }]);
    else if (via && own.via !== via) this.save(this.entries.map((e) => (e === own ? { ...own, via } : e)));
    if (this.granted.size < this.size()) this.pumpIn(0);
  }

  /** Forget the line, the pause and the pool's size: a boot check's or a preview's copied database mustn't start the live minions' turns, or wait on their pause. */
  clear() {
    this.entries = [];
    this.ordered = null;
    for (const key of [LINE, SIZE, PAUSE]) this.host.store.deleteSetting(key);
  }

  /** Run a lane step whose turn entered, giving its worker back when the step is over, however it ends. */
  hold(ticketId: number, step: () => unknown): unknown {
    let out: unknown;
    try {
      out = step();
    } catch (err) {
      this.release(ticketId);
      throw err;
    }
    return Promise.resolve(out).finally(() => this.release(ticketId));
  }

  /** A turn the last server left running holds its worker, over the size if need be. */
  reattach(ticketId: number, step: () => unknown): unknown {
    if (this.host.exempt(ticketId)) return step();
    this.grant(ticketId);
    return this.hold(ticketId, step);
  }

  /** Out of the line (a stop, a dismissal; its last message taken back, `plainOnly`: a resume still starts): whether it was in it. */
  leave(ticketId: number, plainOnly = false): boolean {
    if (!this.entries.some((e) => e.ticket === ticketId && !(plainOnly && e.via))) return false;
    this.save(this.entries.filter((e) => e.ticket !== ticketId));
    return true;
  }

  /** A boot: nothing starts until open(), so turns re-attached to count first and cut-off ones take their places. */
  close() {
    this.closed = true;
  }

  open(wait: number) {
    this.closed = false;
    this.pumpIn(wait);
  }

  /** Start who is next, while workers are free; a burst goes gapMs apart. */
  pump() {
    if (this.timer || this.closed || this.host.detached || this.admitting !== null) return;
    if (!this.entries.length || this.granted.size >= this.size() || this.paused()) return;
    const entry = this.best(this.ready());
    if (!entry) return;
    this.save(this.entries.filter((e) => e.ticket !== entry.ticket));
    this.admitting = entry.ticket;
    try {
      this.host.start(entry);
    } catch (err) {
      console.error(`Minion ${entry.ticket}: its turn could not start from the line:`, err);
    } finally {
      this.admitting = null;
    }
    this.pumpIn(this.host.gapMs);
  }

  stop() {
    clearTimeout(this.timer);
  }

  private pumpIn(wait: number) {
    if (this.timer || !this.entries.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, wait);
    this.timer.unref();
  }

  private grant(ticketId: number, via?: RetryKind): true {
    const held = this.granted.get(ticketId);
    if (held) held.steps++;
    else this.granted.set(ticketId, { steps: 1, person: this.host.asks(ticketId, via).person });
    this.leave(ticketId);
    return true;
  }

  private release(ticketId: number) {
    const held = this.granted.get(ticketId);
    if (!held || --held.steps > 0) return;
    this.granted.delete(ticketId);
    // Once its lane is idle too, so what it has queued stands in the line with the rest.
    this.pumpIn(0);
  }

  private ready(): LineEntry[] {
    return this.entries.filter((e) => !this.host.busy(e.ticket) && !(this.stalled.size && this.full(this.host.asks(e.ticket, e.via).person)));
  }

  /** Their container is out of memory with a turn of theirs in it, so another would only stall it more; with none running, one may start. */
  private full(person: number): boolean {
    return this.stalled.has(person) && [...this.granted.values()].some((g) => g.person === person);
  }

  private best(entries: LineEntry[]): LineEntry | null {
    const w = pick(this.asked(entries), this.byPerson(), Date.now());
    return w && entries.find((e) => e.ticket === w.ticket)!;
  }

  private asked(entries: LineEntry[]): Waiting[] {
    return entries.map((e) => ({ ...e, ...this.host.asks(e.ticket, e.via) }));
  }

  private byPerson(): Map<number, number> {
    const running = new Map<number, number>();
    for (const g of this.granted.values()) running.set(g.person, (running.get(g.person) ?? 0) + 1);
    return running;
  }

  private save(entries: LineEntry[]) {
    const was = this.waiting();
    this.entries = entries;
    this.ordered = null;
    this.host.store.setSetting(LINE, entries);
    const now = this.waiting();
    this.host.changed([...was.filter((id) => !now.includes(id)), ...now.filter((id) => !was.includes(id))]);
  }
}
