// The worker pool (#1868). Josh, 2026-11-24: "we have a pool of claude sessions that are capped across the whole citadel,
// they can be reallocated between users as the users are asking for different amounts of work". A worker is one claude
// process running one minion's turn. Past the pool's size a turn waits in a line, saved in the settings table so a
// restart keeps it, and starts as workers free. Taskmasters, the Overlord and hidden keepalives take no worker.
//
// The line holds no messages: those stay in each minion's queue (src/minion-queue.ts), and a resume's wait or debt stays
// where it was (src/resumes.ts, the queue's `owed`). An entry says only "this minion has a turn to start", so one whose
// turn needs no starting any more is simply dropped when it comes up.
//
// One line, a pool per place (Build 7 T4): place 0 is perigee, any other is a connected machine's id (src/machine-pools.ts),
// each with its own saved size and limits. Where a turn goes (Josh, 2026-11-25): "1. Perigee if it has room and no
// one else needs it 2. Your machine if it has room and perigee either is full or someone without their own worker pool has
// jobs to run 3. Perigee if you have no machine and there are slots on perigee 4. Wait", where the jobs that count are
// waiting turns ("Their turns are waiting"). Judged per turn: a machine that can't take it (away, not lent, a ship's tests)
// is no machine, one that is only full still is. A minion marked for a machine (src/runs-on.ts) is the one exception: it
// starts there whatever perigee holds, and nowhere else.
//
// The quick lane (#1986; Josh, 2026-11-25: "ok, build the quick lane"): with no worker free in the pool, a few turns more may
// run, for a person's own words and answers and the server's wake-ups (`quick`, src/line-place.ts). One that runs on past
// POOL.laneMs counts in the pool from then on, up to POOL.laneOver over its size, and the lane has its worker back.
// The lane is perigee's and comes last: a forced start or perigee's free worker first, then the person's machine, then the lane.
//
// The cloud (#2153, src/cloud-pool.ts) is CLOUD_PLACE, and the first place for a job it may take (Cara, 2026-11-26: "Anything
// that can go to the cloud with no loss of value should prioritize running there"): such a minion's first turn starts there,
// with no cap of ours on how many run at once. One whose session is there runs every later turn there and nowhere else, as
// one marked for a machine does.
import { HOLD } from './start-now.ts';
import type { Store } from './db.ts';
import type { PressureReading } from './pressure.ts';
import { limitsOf, MACHINE_LIMITS, refuse, LIMIT_INFO, type LimitKey, type PoolBox, type PoolLimits, type SavedLimits } from './turn-limits.ts';
import type { Block, MachineHost, MachinePlace } from './machine-pools.ts';
import { rank } from './machine-balancer.ts';
import { CLOUD_PLACE } from './cloud-pool.ts';
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
  /** Waited this long (#1888), it goes first in its person's share, whatever else waits there. */
  longMs: 90 * 60_000,
  /** A machine's size until its Auto moves it (its owner's cap is the ceiling). */
  machineStart: 2,
  /** A machine's load sample older than this is no reading: its size stays as it is. */
  loadStaleMs: 60_000,
  /** The quick lane's workers at each memory level. A turn that runs is never stopped by it. */
  lane: { ok: 2, easing: 1, tight: 0 } satisfies Record<PoolBox['level'], number>,
  /** A quick lane turn still running after this counts in the pool. */
  laneMs: 2 * 60_000,
  /** How far over its size the pool takes such turns; the next keeps its lane worker until there is room. Josh's pick said "up to 2 turns sitting on top of the pool". */
  laneOver: 2,
};

const LINE = 'turn-line';
const SIZE = 'turn-pool';
const PAUSE = 'turns-paused';
const LIMITS = 'turn-pool-limits';
/** A place's own copy of a pool setting; perigee's is the one from before there were places. */
const keyOf = (key: string, place: number) => (place ? `${key}:${place}` : key);

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

/** A waiting turn's place (#1888), as the Runner knows it (src/line-place.ts). */
export interface LinePlace {
  person: number;
  /** 0 a person's own message or answer, 1 work started for them, 2 automatic. */
  rank: number;
  /** A person gave it a worker of its own (src/start-now.ts): ahead of everything, past the size. */
  forced?: true;
  /** It may start in the quick lane while the pool has no free worker. */
  quick?: true;
  /** Its spot in the Urgent group (src/urgent.ts), ahead of every share. */
  urgent?: number;
  /** Its ship was refused, or other minions wait on it. */
  first?: boolean;
  /** 0 its session is about to go cold, 1 under way, 2 brand new. */
  heat?: 0 | 1 | 2;
  /** Its person's own machine could take it, so at perigee it stands behind those that have none. */
  own?: boolean;
}

/** A waiting turn as `pick` sees it. */
export interface Waiting extends LinePlace {
  ticket: number;
  since: number;
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

const less = (a: number[], b: number[]) => a.map((n, i) => n - b[i]).find((d) => d) ?? 0;

/**
 * Whose turn a free worker takes: the ones started now by a person, the Urgent in their order, then those with no machine of their own, then the person furthest below their share, then the first in
 * that person's own order. Everyone's first two workers come before anyone's third; past that a share is in proportion to
 * what a person has running and waiting.
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
  const long = (w: Waiting) => (now - w.since >= POOL.longMs ? 0 : 1);
  // Josh, 2026-11-24: "About to go cold first", after what is refused or holds others up; what came before (#1868) settles the rest.
  const own = (w: Waiting) => [long(w), long(w) && w.first ? 0 : 1, long(w) && (w.heat ?? 1), rank(w), w.since, w.ticket];
  const urgent = (w: Waiting) => (w.forced ? -1 : (w.urgent ?? Number.MAX_SAFE_INTEGER));
  let best: Waiting | null = null;
  for (const w of waiting) {
    const by = best && (urgent(w) - urgent(best) || Number(!!w.own) - Number(!!best.own) || share(w.person) - share(best.person) || oldest.get(w.person)! - oldest.get(best.person)! || w.person - best.person || less(own(w), own(best)));
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
  asks(ticketId: number, via?: RetryKind): LinePlace;
  /** A person holds a worker of its own for it (#1957, src/start-now.ts): its turns start past the size. */
  forced(ticketId: number): { user: number; by: string } | null;
  /** Start its turn, now that a worker is free: it calls enter() again, which grants it. */
  start(entry: LineEntry): void;
  /** Stop its running turn to carry on later; one already ending or not yet launched is left. */
  pauseTurn(ticketId: number): void;
  /** Minions with no turn running that wait on an approval card, and whose share they come back to. */
  carded(): { ticket: number; person: number }[];
  /** Who waits, or why they all do, changed. */
  changed(ids: number[]): void;
  /** The connected machines' pools; left out, perigee is the only place. */
  pools?: MachineHost;
  /** The cloud's pool (#2153); left out, there is none. */
  cloud?: CloudHost;
  readonly gapMs: number;
  readonly detached: boolean;
}

/** What the line needs of the cloud pool (src/cloud-pool.ts, the runner's side of it). */
export interface CloudHost {
  /** Its conversation is a cloud session on the login of the person its next turn is for: that turn runs there and nowhere else. */
  bound(ticketId: number, via?: RetryKind): boolean;
  /** Why its turn can't start as a new cloud session, or null: it may. */
  takes(ticketId: number, via?: RetryKind): string | null;
}

const inLane = (g: { lent?: true; lane?: { moved?: true } }) => !!g.lane && !g.lane.moved && !g.lent;

export class TurnLine {
  private host: LineHost;
  private entries: LineEntry[];
  /**
   * Turns that run: the minion, how many of its lane's steps count on it (an account switch queues its resume in its turn's end), and whose
   * share. A `lent` one only waits on an approval card, so its worker is back in the pool until the answer (#1916); a `forced` one
   * started on a worker of its own (#1957), that person's. `place`: whose pool the worker is of. `lane`: it started in
   * perigee's quick lane, and `moved` once it counts in the pool.
   */
  private granted = new Map<number, { steps: number; person: number; place: number; lent?: true; forced?: number; lane?: { since: number; moved?: true } }>();
  private admitting: { ticket: number; place: number; lane: boolean } | null = null;
  /** The box's memory level at the last tick, which sizes the quick lane. */
  private level: PoolBox['level'] = 'ok';
  /** The reading of Auto's last tick, for the tile. */
  private seen: { cpu: number | null; mem: number | null; at: number; pressed: string | null } | null = null;
  private timer?: NodeJS.Timeout;
  /** Until a boot's resumes are in (open): the line takes turns in but starts none. */
  private closed = false;
  /** People whose container stalls at its own memory limit, which the box's readings barely show (#1874). */
  /** Whether the pool's last reading was starved. */
  starved = false;
  private stalled = new Set<number>();
  private ordered: { at: number; line: Waiting[] } | null = null;
  /** The waiting turns a full container holds, as pages last heard. */
  private heldFull = '';
  /** What each turn marked for a machine waits on there, as pages last heard. */
  private heldThere = '';
  /** The machine each minion's last turn ran on, so its next goes back while there is room (warm caches, Build 7 M6). shortcut: kept in memory, so a restart forgets it; save it if cold starts after a deploy cost. */
  private warm = new Map<number, number>();

  constructor(host: LineHost) {
    this.host = host;
    this.entries = host.store.getSetting<LineEntry[]>(LINE) ?? [];
  }

  /** A place's workers that run a turn; perigee's quick lane's are beside its pool. */
  used(place = 0): number {
    return [...this.granted.values()].filter((g) => g.place === place && !g.lent && !inLane(g)).length;
  }

  /** Where a turn that holds a worker runs: 0 perigee, CLOUD_PLACE the cloud, else a machine. */
  placeOf(ticketId: number): number {
    return this.granted.get(ticketId)?.place ?? 0;
  }

  /** Its machine can't take the turn it was given a worker for there: unless marked for it, it runs at perigee, over the size if need be. */
  comeHome(ticketId: number) {
    const held = this.granted.get(ticketId);
    if (held) held.place = 0;
  }

  private laneUsed(): number {
    return [...this.granted.values()].filter(inLane).length;
  }

  /** The running turns that started in the quick lane, those that count in the pool by now too. */
  laneTurns(): { ticket: number; person: number; since: number; moved: boolean }[] {
    return [...this.granted].flatMap(([ticket, g]) => (g.lane && !g.lent ? [{ ticket, person: g.person, since: g.lane.since, moved: !!g.lane.moved }] : []));
  }

  /** The waiting turns that may start in the quick lane now: none while perigee's pool has a worker for them, nor those marked for a machine. */
  private laneReady(): LineEntry[] {
    if (this.used() < this.size() || this.laneUsed() >= POOL.lane[this.level]) return [];
    return this.ready().filter((e) => this.host.asks(e.ticket, e.via).quick);
  }

  /** The minions that wait on an approval card without a worker. */
  lent(): number {
    return [...this.granted.values()].filter((g) => g.lent).length + this.carded().length;
  }

  /**
   * Give a running turn's worker back while it only waits on an approval card, or take it again. Josh, 2026-11-24: "shouldnt a minion waiting on
   * a card just release to the pool until the card is answered?" Taking it again never waits: the turn already goes on, over the size if need be.
   * A quick lane turn's comes back to it as the pool's.
   */
  setLent(ticketId: number, lent: boolean) {
    const held = this.granted.get(ticketId);
    // A machine's worker stays with its turn: the agent there counts every live turn against its cap.
    if (!held || held.place || !!held.lent === lent) return;
    if (lent) {
      held.lent = true;
      if (held.lane) held.lane.moved = true;
    } else delete held.lent;
    this.ordered = null;
    if (lent) this.pumpIn(0);
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
    return this.line().map((w) => w.ticket);
  }

  /** The same with what put each where it is. */
  line(): Waiting[] {
    if (this.ordered && Date.now() - this.ordered.at < 1000) return this.ordered.line;
    const running = this.byPerson();
    // A turn that waits for its machine takes no place in front of anyone, so those stand last.
    const there = new Set(this.entries.filter((e) => this.away(e.ticket)).map((e) => e.ticket));
    const asked = this.asked(this.entries, true);
    let rest = asked.filter((w) => !there.has(w.ticket));
    const line: Waiting[] = [];
    for (let w = pick(rest, running, Date.now()); w; w = pick(rest, running, Date.now())) {
      line.push(w);
      running.set(w.person, (running.get(w.person) ?? 0) + 1);
      rest = rest.filter((r) => r !== w);
    }
    line.push(...asked.filter((w) => there.has(w.ticket)));
    this.ordered = { at: Date.now(), line };
    return line;
  }

  wait(ticketId: number): WorkerWait | null {
    const entry = this.entries.find((e) => e.ticket === ticketId);
    if (!entry) return null;
    const quick = !this.away(ticketId) && this.line().find((w) => w.ticket === ticketId)?.quick;
    return { since: entry.since, place: this.order().indexOf(ticketId) + 1, of: this.entries.length, paused: this.paused()?.by ?? null, held: this.heldBy(entry), ...(quick ? { quick: true as const } : {}), ...this.machineWait(entry) };
  }

  /** Its waiting turn may only start on the machine it is marked for. */
  waitsForMachine(ticketId: number): boolean {
    return !!this.need(ticketId) && this.has(ticketId);
  }

  /** The machine a minion is marked for, or null. */
  private need(ticketId: number): number | null {
    return this.host.pools?.mark(ticketId) || null;
  }

  private machineWait(entry: LineEntry): Pick<WorkerWait, 'machine'> {
    if (this.bound(entry.ticket, entry.via)) {
      return { machine: { name: 'its cloud session', why: 'next there' } };
    }
    const need = this.need(entry.ticket);
    if (!need) return {};
    const { name, block } = this.held(need, entry);
    return { machine: { name, why: block?.why ?? 'next there', ...(block?.never ? { never: true as const } : {}) } };
  }

  /** What keeps a turn marked for a machine from starting there now: what the machine or the turn can't do, else no free worker. */
  private held(need: number, entry: LineEntry): { name: string; block: Block | null } {
    const pools = this.host.pools!;
    const m = pools.machines().find((x) => x.id === need);
    const block = pools.takes(need, entry.ticket, entry.via) ?? m?.block ?? null;
    const [used, size] = [this.used(need), this.size(need)];
    return { name: pools.nameOf(need, entry.ticket), block: block ?? (used >= size ? { why: `busy: ${used} of ${size} worker${size === 1 ? '' : 's'}` } : null) };
  }

  /** Why a waiting turn wouldn't start even on a worker of its own, in words; it starts by itself once that clears. */
  heldBy(entry: LineEntry): string | null {
    const paused = this.paused();
    if (paused) return `${paused.by} paused all minions`;
    if (this.closed || this.host.detached) return 'Citadel is restarting';
    const need = this.need(entry.ticket);
    if (need) {
      const { name, block } = this.held(need, entry);
      return block && `it runs only on ${name}: ${block.why}`;
    }
    if (this.stalled.size && this.full(this.host.asks(entry.ticket, entry.via).person)) return 'the container it runs in is at its memory limit';
    const hold = this.host.forced(entry.ticket);
    return hold && this.forcedFor(entry.ticket) === null ? `${HOLD.each} turns ${hold.by} started now are still running` : null;
  }

  /** Who gave it a worker of its own, while they have one left: a hold let go mid-turn keeps its worker until that turn ends, or presses in a row would pass "Two per person". */
  // shortcut: a restart forgets who started a let-go turn, so its person may start one more; save it with the turn if that's ever used.
  private forcedFor(ticketId: number): number | null {
    const user = this.host.forced(ticketId)?.user;
    if (user === undefined) return null;
    return [...this.granted].filter(([id, g]) => g.forced === user && id !== ticketId).length < HOLD.each ? user : null;
  }

  /** A person pressed Start now: its waiting turn starts at once, past the size and the gap between starts. A busy lane's starts once idle. */
  force(ticketId: number) {
    this.reordered();
    const entry = this.entries.find((e) => e.ticket === ticketId);
    if (!entry) return;
    // A machine's size and its owner's cap hold for everyone: there it only goes first; a cloud-bound turn goes there.
    if (this.away(ticketId)) return this.pumpIn(0);
    if (this.admitting === null && !this.host.busy(ticketId) && !this.heldBy(entry)) this.admit(entry, 0);
  }

  /** Those whose process has ended too; one still ending counts as its turn. */
  private carded() {
    return this.host.carded().filter((c) => !this.granted.has(c.ticket));
  }

  /** Whether a person's container is at its memory limit. */
  stalledFor(person: number): boolean {
    return this.stalled.has(person);
  }

  /** Each person's workers, those in the quick lane apart, turns waiting on a card (`lent`) and waiting turns, the most first. */
  people(): { person: number; used: number; lane?: number; waiting: number; lent: number; stalled?: true }[] {
    type Person = { person: number; used: number; lane?: number; waiting: number; lent: number };
    const out = new Map<number, Person>();
    const add = (person: number, key: 'used' | 'lane' | 'waiting' | 'lent') => {
      const p: Person = out.get(person) ?? { person, used: 0, waiting: 0, lent: 0 };
      p[key] = (p[key] ?? 0) + 1;
      out.set(person, p);
    };
    for (const g of this.granted.values()) add(g.person, g.lent ? 'lent' : inLane(g) ? 'lane' : 'used');
    for (const c of this.carded()) add(c.person, 'lent');
    for (const w of this.asked(this.entries)) add(w.person, 'waiting');
    const all = (p: Person) => p.used + (p.lane ?? 0) + p.waiting + p.lent;
    return [...out.values()].map((p) => (this.full(p.person) ? { ...p, stalled: true as const } : p)).sort((a, b) => all(b) - all(a) || a.person - b.person);
  }

  pool(place = 0): PoolSize {
    return this.host.store.getSetting<PoolSize>(keyOf(SIZE, place)) ?? { size: place ? POOL.machineStart : POOL.start, at: 0 };
  }

  /** A machine's is never over its owner's cap, which its agent holds too. */
  size(place = 0): number {
    if (!place) return this.pool().fixed?.size ?? this.pool().size;
    const m = this.host.pools?.machines().find((x) => x.id === place);
    return m ? this.sizeOf(m) : 0;
  }

  /** On Auto with no word of its load (an agent from before it said it), it holds at its fewest. */
  private sizeOf(m: MachinePlace): number {
    const p = this.pool(m.id);
    return Math.min(p.fixed?.size ?? (this.loadOf(m) ? p.size : this.limits(m.id).min), m.cap, m.room?.workers ?? Infinity);
  }

  /** The limits Auto steers a place by: the saved changes over the defaults. */
  limits(place = 0): PoolLimits {
    return limitsOf(this.savedLimits(place), place ? MACHINE_LIMITS : undefined);
  }

  savedLimits(place = 0): SavedLimits {
    return this.host.store.getSetting<SavedLimits>(keyOf(LIMITS, place)) ?? { values: {}, by: {} };
  }

  /**
   * People's changes: a number sets that limit, null puts back its default. All or none: a set that can't be used throws the reason.
   * Each one is a health event, so the Status graphs can be read against it.
   */
  setLimits(changes: Partial<Record<LimitKey, number | null>>, by: string, now = Date.now(), place = 0) {
    const saved = this.savedLimits(place);
    const next: SavedLimits = { values: { ...saved.values }, by: { ...saved.by } };
    const before = this.limits(place);
    const lines: string[] = [];
    for (const i of LIMIT_INFO) {
      const v = changes[i.key];
      if (v === undefined) continue;
      if (v === null) delete next.values[i.key];
      else next.values[i.key] = v;
      next.by[i.key] = { by, at: now };
    }
    const after = limitsOf(next, place ? MACHINE_LIMITS : undefined);
    const why = refuse(after);
    if (why) throw new Error(why);
    for (const i of LIMIT_INFO) if (changes[i.key] !== undefined && before[i.key] !== after[i.key]) lines.push(`${i.label}: ${before[i.key]} to ${after[i.key]} ${i.unit}`);
    if (!lines.length) return;
    this.host.store.setSetting(keyOf(LIMITS, place), next);
    const whose = place ? `the limits of ${this.host.pools?.nameOf(place) ?? `machine ${place}`}'s workers` : "the worker pool's limits";
    this.host.store.addHealthEvent('pool-limits', now, null, `${by} changed ${whose}. ${lines.join('; ')}`);
    this.pump();
  }

  /** What the Workers tile shows (src/routes/workers.ts). */
  summary() {
    return {
      used: this.used(),
      lent: this.lent(),
      running: this.granted.size,
      forced: [...this.granted.values()].filter((g) => g.forced !== undefined && !g.lent).length,
      lane: this.lane(),
      size: this.size(),
      pool: this.pool(),
      paused: this.paused(),
      waiting: this.entries.length,
      people: this.people(),
      machines: this.machinePools(),
      // perigee's own reading from Auto's last tick, null before the first or when it has gone stale.
      reading: this.seen && Date.now() - this.seen.at < POOL.loadStaleMs ? { cpu: this.seen.cpu, mem: this.seen.mem } : null,
      pressed: this.seen && Date.now() - this.seen.at < POOL.loadStaleMs ? this.seen.pressed : null,
    };
  }

  /** The quick lane for the tile: `moved` counts the turns that started there and take a pool worker now. */
  private lane() {
    return { used: this.laneUsed(), size: POOL.lane[this.level], moved: this.laneTurns().filter((t) => t.moved).length };
  }

  /** Each machine that lends workers, as the tile's rows have it. */
  private machinePools() {
    return (this.host.pools?.machines() ?? []).map((m) => {
      const L = this.limits(m.id);
      const load = this.loadOf(m);
      // At its fewest, a shrink has nothing to take away: the row says what it can't give way to.
      const pressed = load && starvedBy(load.reading, load.box, L) ? starveWhy(load.reading, load.box, L) : null;
      return {
        id: m.id,
        name: m.name,
        owner: m.owner,
        used: this.used(m.id),
        size: this.sizeOf(m),
        cap: m.cap,
        pool: this.pool(m.id),
        min: Math.min(L.min, m.cap),
        max: Math.min(L.max, m.cap),
        waiting: this.entries.filter((e) => this.need(e.ticket) === m.id).length,
        block: m.block?.why ?? null,
        // Why the balancer holds it under the owner's cap: "2 CI jobs waiting".
        priority: m.priority,
        balanced: m.room && m.room.workers < Math.min(this.pool(m.id).fixed?.size ?? Infinity, m.cap) ? m.room.why : null,
        away: m.away,
        pressed,
        // What the machine reads now (whole percents of CPU and memory pressure), or null with no sample in the last minute: the row shows it live, the last resize's reason only in a tooltip.
        reading: load ? { cpu: load.reading.cpu, mem: load.reading.mem } : null,
      };
    });
  }

  private loadOf(m: MachinePlace, now = Date.now()) {
    return m.load && now - m.load.at < POOL.loadStaleMs ? m.load : null;
  }

  /** A machine was removed: its number may come to another. */
  forget(place: number) {
    for (const key of [SIZE, LIMITS]) this.host.store.deleteSetting(keyOf(key, place));
    for (const [ticket, at] of this.warm) if (at === place) this.warm.delete(ticket);
  }

  /** A person's number, or null for Auto. */
  setSize(size: number | null, by: string, place = 0) {
    const { fixed: _, ...p } = this.pool(place);
    this.host.store.setSetting(keyOf(SIZE, place), size === null ? p : { ...p, fixed: { size, by } });
    this.pump();
  }

  /** Auto's step, every POOL.everyMs. `box`: free memory and the memory level. `stalled`: the people whose container is at its memory limit: no more of their turns start until it recovers. */
  tick(reading: PressureReading, stalled: Iterable<number> = [], now = Date.now(), box: PoolBox = { freeGb: null, level: 'ok' }) {
    // A turn still launching when the pause came, or re-attached since.
    if (this.paused()?.stop) this.stopRunning();
    this.level = box.level;
    const own = [...this.granted.values()].filter((g) => g.forced !== undefined && !g.lent).length;
    for (const g of this.granted.values()) if (inLane(g) && now - g.lane!.since >= POOL.laneMs && this.used() - own < this.size() + POOL.laneOver) g.lane!.moved = true;
    const p = this.pool();
    this.starved = starvedBy(reading, box, this.limits());
    this.seen = { cpu: reading.cpu, mem: reading.mem, at: now, pressed: this.starved ? starveWhy(reading, box, this.limits()) : null };
    this.stalled = new Set(p.fixed ? [] : stalled);
    const full = this.stalled.size ? this.entries.filter((e) => this.full(this.host.asks(e.ticket, e.via).person)).map((e) => e.ticket) : [];
    if (full.join() !== this.heldFull) {
      this.heldFull = full.join();
      this.host.changed(this.waiting());
    }
    this.tickMachines(now);
    this.pumpIn(0);
    if (p.fixed) return;
    const size = nextSize({ ...p, used: this.used(), waiting: this.entries.filter((e) => !this.away(e.ticket)).length }, reading, box, this.limits(), now);
    if (size === p.size) return;
    this.host.store.setSetting(SIZE, { size, at: now, why: size < p.size ? starveWhy(reading, box, this.limits()) : 'perigee is calm and turns wait' });
    this.pump();
  }

  /** Auto's step in each machine's pool, by that machine's own samples, and a look at the turns that wait for one. */
  private tickMachines(now: number) {
    const pools = this.host.pools;
    if (!pools) return;
    for (const m of pools.machines()) {
      const p = this.pool(m.id);
      const load = this.loadOf(m, now);
      if (p.fixed || m.block || !m.cap || !load) continue;
      const L = this.limits(m.id);
      const capped = { ...L, min: Math.min(L.min, m.cap), max: Math.min(L.max, m.cap) };
      // Turns its owner's later machines run count as waiting for it, so machine 1 grows to its limit before 2 is used (Josh, 2026-11-25).
      const later =
        m.priority === null
          ? 0
          : pools
              .machines()
              .filter((x) => x.owner === m.owner && (x.priority ?? Infinity) > m.priority!)
              .reduce((n, x) => n + this.used(x.id), 0);
      const auto = nextSize({ ...p, used: this.used(m.id), waiting: this.ready(m).length + later }, load.reading, load.box, capped, now);
      // The balancer's target pulls Auto's size down with it, so the workers grow back on Auto's clock once CI is quiet.
      const size = m.room ? Math.min(auto, m.room.workers) : auto;
      if (size !== p.size)
        this.host.store.setSetting(keyOf(SIZE, m.id), { size, at: now, why: size < auto ? (m.room?.why ?? 'the balancer') : starvedBy(load.reading, load.box, L) ? `${starveWhy(load.reading, load.box, L)} there` : size < p.size ? 'its most was lowered' : `${m.name} is calm and turns wait` } satisfies PoolSize);
    }
    const held = this.entries.flatMap((e) => {
      const need = this.need(e.ticket);
      return need ? [{ e, ...this.held(need, e) }] : [];
    });
    for (const { e, block } of held) if (block) pools.stuck(e.ticket, e.since, block);
    const said = held.map(({ e, block }) => `${e.ticket} ${block?.why}`).join('\n');
    if (said === this.heldThere) return;
    this.heldThere = said;
    this.host.changed(held.map(({ e }) => e.ticket));
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
    if (this.admitting?.ticket === ticketId) return this.grant(ticketId, via, this.admitting.place, this.admitting.lane);
    const own = this.entries.find((e) => e.ticket === ticketId);
    // Its queue's turn never goes before the resume it waits for: the resume takes the queue along.
    if (!paused && !this.closed && !this.host.busy(ticketId) && !(own?.via && !via)) {
      const me = own ?? { ticket: ticketId, since: Date.now(), via };
      // The cloud first, for a job it may take (#2153).
      if (this.cloudFor(me)) {
        return this.grant(ticketId, via, CLOUD_PLACE);
      }
      const place = this.placeFor(me, via);
      if (place !== null) return this.grant(ticketId, via, place);
      // Perigee full and no machine of its own free: the quick lane, last.
      if (this.laneFor(me, via)) return this.grant(ticketId, via, 0, true);
    }
    this.join(ticketId, via);
    return false;
  }

  /** Where a turn can start at this moment, or null: it waits. */
  private placeFor(me: LineEntry, via?: RetryKind): number | null {
    if (this.bound(me.ticket, me.via)) return null;
    const mark = this.host.pools?.mark(me.ticket) ?? null;
    const full = this.full(this.host.asks(me.ticket, via).person);
    if (!mark && !full && this.forcedFor(me.ticket) !== null) return 0;
    if (mark || this.used() >= this.size()) return this.machineFor(me, via);
    const ready = this.ready();
    const there = this.needed(ready.filter((e) => e.ticket !== me.ticket)) ? this.machineFor(me, via) : null;
    return there ?? (!full && this.isFirst(me, ready, true) ? 0 : null);
  }

  /** It may start in perigee's quick lane now: a quick turn not marked for a machine, first among those the lane may take. */
  private laneFor(me: LineEntry, via?: RetryKind): boolean {
    const asks = this.host.asks(me.ticket, via);
    if (!asks.quick || this.away(me.ticket) || this.full(asks.person)) return false;
    if (this.used() < this.size() || this.laneUsed() >= POOL.lane[this.level]) return false;
    return this.isFirst(me, this.laneReady(), true);
  }

  private isFirst(me: LineEntry, ready: LineEntry[], home = false): boolean {
    const rest = ready.filter((e) => e.ticket !== me.ticket);
    return !rest.length || this.best([me, ...rest], home)?.ticket === me.ticket;
  }

  /** The machine a turn can start on now, or null. */
  private machineFor(me: LineEntry, via = me.via): number | null {
    const mark = this.host.pools?.mark(me.ticket) ?? null;
    if (mark === 0) return null;
    return this.ranked(me, via).find((m) => this.isFirst(me, this.ready(m)))?.id ?? null;
  }

  /** It may start in the cloud now: bound there, or a job the cloud may take; first among those. */
  private cloudFor(me: LineEntry): boolean {
    const ready = this.cloudReady([me, ...this.entries.filter((e) => e.ticket !== me.ticket)]);
    return ready.some((e) => e.ticket === me.ticket) && this.isFirst(me, ready);
  }

  /** The waiting turns that could start in the cloud now: it has no cap of ours (Josh, 2026-11-26: "we shouldnt be adding any limits"). */
  private cloudReady(entries = this.entries): LineEntry[] {
    const cloud = this.host.cloud;
    if (!cloud) return [];
    // A minion marked for a machine keeps to it.
    return entries.filter((e) => !this.host.busy(e.ticket) && (cloud.bound(e.ticket, e.via) || (this.host.pools?.mark(e.ticket) == null && cloud.takes(e.ticket, e.via) === null)));
  }

  private bound(ticketId: number, via?: RetryKind): boolean {
    return !!this.host.cloud?.bound(ticketId, via);
  }

  /** It can't start at perigee: marked for a machine, or its session is in the cloud. */
  private away(ticketId: number): boolean {
    return !!this.need(ticketId) || this.bound(ticketId);
  }

  /** The machines a turn may start on now, best first (src/machine-balancer.ts rank): its owner's order, then where it last ran, then the most room. */
  private ranked(me: LineEntry, via = me.via): MachinePlace[] {
    const pools = this.host.pools;
    if (!pools || this.bound(me.ticket, me.via)) return [];
    const open = this.machines().filter((m) => !pools.takes(m.id, me.ticket, via));
    return rank(
      open.map((m) => ({ ...m, free: this.sizeOf(m) - this.used(m.id) })),
      { mark: pools.mark(me.ticket), warm: this.warm.get(me.ticket) ?? null },
    );
  }

  /** Someone with no machine of their own waits for perigee. */
  private needed(ready: LineEntry[]): boolean {
    return ready.some((e) => !this.hasMachine(e));
  }

  /** Its person's own machine could take it, be it full now. */
  private hasMachine(e: LineEntry): boolean {
    const pools = this.host.pools;
    if (!pools || pools.mark(e.ticket) !== null) return false;
    return pools.machines().some((m) => !m.block && this.sizeOf(m) > 0 && !pools.takes(m.id, e.ticket, e.via));
  }

  /** It stands at perigee behind those with no machine. Not for ever (Josh's Taskmaster, 2026-11-25): waiting longMs, it stands with them, though it needs perigee no more than before. */
  private behind(e: LineEntry): boolean {
    return Date.now() - e.since < POOL.longMs && this.hasMachine(e);
  }

  /** The machines a turn can start on now: nothing holds them and a worker there is free. */
  private machines(): MachinePlace[] {
    return (this.host.pools?.machines() ?? []).filter((m) => !m.block && this.used(m.id) < this.sizeOf(m));
  }

  /** The waiting turns' places changed under the line (a drag, an Urgent tag). */
  reordered() {
    this.ordered = null;
    this.host.changed(this.waiting());
  }

  /** Into the line (keeping a place it has), taking no worker even when one is free. */
  join(ticketId: number, via?: RetryKind) {
    if (this.host.exempt(ticketId)) return;
    const own = this.entries.find((e) => e.ticket === ticketId);
    if (!own) this.save([...this.entries, { ticket: ticketId, since: Date.now(), ...(via ? { via } : {}) }]);
    else if (via && own.via !== via) this.save(this.entries.map((e) => (e === own ? { ...own, via } : e)));
    if (this.used() < this.size() || this.forcedFor(ticketId) !== null || this.host.pools?.machines().length || this.laneReady().length || this.cloudReady().length) this.pumpIn(0);
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
  reattach(ticketId: number, step: () => unknown, place = 0): unknown {
    if (this.host.exempt(ticketId)) return step();
    this.grant(ticketId, undefined, place);
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

  /** Start who is next, while workers are free, or past the size one a person starts now or one of the quick lane's; a burst goes gapMs apart. */
  pump() {
    if (this.timer || this.closed || this.host.detached || this.admitting !== null) return;
    if (!this.entries.length || this.paused()) return;
    // The cloud first, for the jobs it may take (#2153).
    const cloud = this.best(this.cloudReady());
    if (cloud) {
      return this.admit(cloud, CLOUD_PLACE);
    }
    const ready = this.ready();
    const forced = (e: LineEntry) => this.forcedFor(e.ticket) !== null;
    const entry = this.best(this.used() < this.size() ? ready : ready.filter(forced), true);
    // Urgent or a long wait puts it first; its own machine is still its place while perigee is needed.
    if (entry) return this.admit(entry, (!forced(entry) && this.needed(ready) && this.machineFor(entry)) || 0);
    // Each machine, its owner's order first, takes the best of the turns that would rather go there than anywhere else.
    for (const m of rank(this.machines().map((x) => ({ ...x, free: this.sizeOf(x) - this.used(x.id) })))) {
      const there = this.best(this.ready(m).filter((e) => this.ranked(e)[0]?.id === m.id));
      if (there) return this.admit(there, m.id);
    }
    // The quick lane last: a quick turn whose machine had room went there above.
    const quick = this.best(this.laneReady(), true);
    if (quick) return this.admit(quick, 0, true);
  }

  private admit(entry: LineEntry, place: number, lane = false) {
    this.save(this.entries.filter((e) => e.ticket !== entry.ticket));
    this.admitting = { ticket: entry.ticket, place, lane };
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

  private grant(ticketId: number, via?: RetryKind, place = 0, lane = false): true {
    const held = this.granted.get(ticketId);
    if (held) {
      held.steps++;
      delete held.lent;
    } else {
      this.granted.set(ticketId, { steps: 1, person: this.host.asks(ticketId, via).person, place, forced: place ? undefined : (this.forcedFor(ticketId) ?? undefined), ...(lane && !place ? { lane: { since: Date.now() } } : {}) });
      if (place > 0) this.warm.set(ticketId, place);
      else this.warm.delete(ticketId);
    }
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

  /** The waiting turns that could start in a place: at perigee all but those marked for a machine, on a machine those marked for it and, while perigee is full or needed, any it may take. */
  private ready(m?: MachinePlace): LineEntry[] {
    const idle = this.entries.filter((e) => !this.host.busy(e.ticket));
    if (!m) return idle.filter((e) => !this.away(e.ticket) && !(this.stalled.size && this.full(this.host.asks(e.ticket, e.via).person)));
    const over = this.used() >= this.size() || this.needed(this.ready());
    return idle.filter((e) => {
      const mark = this.host.pools!.mark(e.ticket);
      return (mark === m.id || (mark === null && over && !this.bound(e.ticket, e.via))) && !this.host.pools!.takes(m.id, e.ticket, e.via);
    });
  }

  /** Their container is out of memory with a turn of theirs in it, so another would only stall it more; with none running, one may start. */
  private full(person: number): boolean {
    return this.stalled.has(person) && [...this.granted.values()].some((g) => g.person === person && !g.place && !g.lent);
  }

  private best(entries: LineEntry[], home = false): LineEntry | null {
    const w = pick(this.asked(entries, home), this.byPerson(), Date.now());
    return w && entries.find((e) => e.ticket === w.ticket)!;
  }

  /** `home`: as they stand for perigee. */
  private asked(entries: LineEntry[], home = false): Waiting[] {
    return entries.map((e) => ({ ...e, ...this.host.asks(e.ticket, e.via), own: home && this.behind(e), ...(this.forcedFor(e.ticket) !== null ? { forced: true } : {}) }));
  }

  private byPerson(): Map<number, number> {
    const running = new Map<number, number>();
    // A machine's workers are its owner's own, so they take nothing from that person's share of perigee's.
    for (const g of this.granted.values()) if (!g.lent && !g.place) running.set(g.person, (running.get(g.person) ?? 0) + 1);
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
