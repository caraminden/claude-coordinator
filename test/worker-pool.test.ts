import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { until } from './wait.ts';
import { nextSize as size, pick, POOL, TurnLine, type LinePlace, type Waiting } from '../src/turn-line.ts';
import { DEFAULT_LIMITS as L, refuse } from '../src/turn-limits.ts';
import { Store } from '../src/db.ts';
import type { Block, MachineHost, MachinePlace } from '../src/machine-pools.ts';
import type { PoolBox } from '../src/turn-limits.ts';

const ok: PoolBox = { freeGb: 16, level: 'ok' };
const nextSize = (s: Parameters<typeof size>[0], r: Parameters<typeof size>[1], now: number, box = ok, l = L) => size(s, r, box, l, now);

// #1868, the pool's two rules. Josh, 2026-11-24: "Lets make the pool dynamic and performance of perigee based, not a static
// number", and "you should scale based on how many minions the user has waiting as well".
const calm = { cpu: 10, mem: 0, io: 0, starved: false, why: '' };
const busy = { cpu: 40, mem: 0, io: 0, starved: false, why: '' };
const starved = { cpu: 60, mem: 0, io: 0, starved: true, why: 'CPU pressure 60%' };
const full = { size: 10, at: 0, used: 10, waiting: 3 };
const LATER = 60_000;

test('the size grows by one while the pool is full, something waits and the box is calm', () => {
  assert.equal(nextSize(full, calm, LATER), 11);
  assert.equal(nextSize({ ...full, waiting: 0 }, calm, LATER), 10, 'nothing waits');
  assert.equal(nextSize({ ...full, used: 9 }, calm, LATER), 10, 'a worker is free');
  assert.equal(nextSize(full, calm, L.growSec * 1000 - 1), 10, 'it moved a moment ago');
  assert.equal(nextSize({ ...full, size: L.max, used: L.max }, calm, LATER), L.max);
});

test('it holds between calm and starved, and with no reading', () => {
  assert.equal(nextSize(full, busy, LATER), 10);
  assert.equal(nextSize(full, { ...calm, mem: 12 }, LATER), 10);
  assert.equal(nextSize(full, { ...calm, cpu: null }, LATER), 10, 'an unreadable box never grows it');
});

test('starved, it shrinks by one, from what runs if fewer run, to the floor and no lower', () => {
  assert.equal(nextSize(full, starved, LATER), 9);
  assert.equal(nextSize({ ...full, used: 6 }, starved, LATER), 5);
  assert.equal(nextSize({ ...full, used: 14 }, starved, LATER), 9, 'turns over the size do not raise it');
  assert.equal(nextSize({ ...full, size: L.min }, starved, LATER), L.min);
  assert.equal(nextSize(full, starved, L.shrinkSec * 1000 - 1), 10);
});

const w = (ticket: number, person: number, rank = 1, since = ticket): Waiting => ({ ticket, person, rank, since });

test('within a share: own messages, then started work, then automatic; then who waited longest', () => {
  assert.equal(pick([w(1, 7, 2), w(2, 7, 1), w(3, 7, 0), w(4, 7, 0)], new Map(), 0)?.ticket, 3);
});

// #1888. Josh, 2026-11-24: "Who goes first inside one person's share?: About to go cold first", and Urgent, with "No limit",
// goes ahead of every share.
const MIN = 60_000;
const order = (waiting: Waiting[], running = new Map<number, number>(), now = 0) => {
  const left = [...waiting];
  const ids: number[] = [];
  for (let x = pick(left, running, now); x; x = pick(left, running, now)) {
    ids.push(x.ticket);
    running.set(x.person, (running.get(x.person) ?? 0) + 1);
    left.splice(left.indexOf(x), 1);
  }
  return ids;
};
const cold = { heat: 2 } as const;
const begun = { heat: 1 } as const;
const warm = { heat: 0 } as const;
for (const [name, waiting, want, now = 0] of [
  [
    'about to go cold, then under way, then brand new, whatever their ranks',
    [
      { ...w(1, 7, 0), ...cold },
      { ...w(2, 7, 1), ...begun },
      { ...w(3, 7, 2), ...warm },
    ],
    [3, 2, 1],
  ],
  [
    'a refused ship or one others wait on before a warm one',
    [
      { ...w(1, 7), ...warm },
      { ...w(2, 7), ...begun, first: true },
    ],
    [2, 1],
  ],
  [
    'among equals, their own message first, then the longest wait',
    [
      { ...w(1, 7, 2, 1), ...begun },
      { ...w(2, 7, 0, 3), ...begun },
      { ...w(3, 7, 0, 2), ...begun },
    ],
    [3, 2, 1],
  ],
  [
    '90 minutes in line before a refused ship',
    [
      { ...w(1, 7, 1, 90 * MIN), ...warm, first: true },
      { ...w(2, 7, 2, 0), ...cold },
    ],
    [2, 1],
    90 * MIN,
  ],
  [
    'a minute less is not',
    [
      { ...w(1, 7, 1, 89 * MIN), ...warm, first: true },
      { ...w(2, 7, 2, 0), ...cold },
    ],
    [1, 2],
    89 * MIN,
  ],
  [
    'Urgent in its saved order, before anything',
    [
      { ...w(1, 7, 0, 0), ...warm, first: true },
      { ...w(2, 7), urgent: 1 },
      { ...w(3, 7), urgent: 0 },
    ],
    [3, 2, 1],
    95 * MIN,
  ],
] as [string, Waiting[], number[], number?][])
  test(`inside one share: ${name}`, () => assert.deepEqual(order(waiting, new Map(), now), want));

test('Urgent goes ahead of every share, however much its person has running', () => {
  const waiting = [w(1, 8), { ...w(2, 7), urgent: 0 }, { ...w(3, 7), urgent: 1 }];
  assert.deepEqual(order(waiting, new Map([[7, 9]])), [2, 3, 1]);
});

test('the order inside a share never moves the shares: 90 minutes or a refused ship is first only among their own', () => {
  const waiting = [
    { ...w(1, 7, 0, 0), first: true, ...warm },
    { ...w(2, 8, 2, 95 * MIN), ...cold },
  ];
  assert.equal(
    order(
      waiting,
      new Map([
        [7, 2],
        [8, 1],
      ]),
      95 * MIN,
    )[0],
    2,
  );
});

test('one that waited 20 minutes goes with the front group', () => {
  assert.equal(pick([w(1, 7, 2, 0), w(2, 7, 0, POOL.agedMs)], new Map(), POOL.agedMs)?.ticket, 1);
});

test('everyone gets their first two workers before anyone gets more', () => {
  const waiting = [w(1, 7), w(2, 7), w(3, 7), w(4, 7), w(5, 8)];
  assert.equal(
    pick(
      waiting,
      new Map([
        [7, 2],
        [8, 1],
      ]),
      0,
    )?.ticket,
    5,
  );
});

test('past that, a share is in proportion to what a person has running and waiting', () => {
  const joshs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => w(n, 7, 1, n + 100));
  const caras = [w(20, 8), w(21, 8)];
  // Josh runs 3 of 13, Cara 2 of 4: he is further below his share.
  assert.equal(
    pick(
      [...caras, ...joshs],
      new Map([
        [7, 3],
        [8, 2],
      ]),
      0,
    )?.ticket,
    1,
  );
  // Josh runs 8 of 18, Cara 2 of 8: she is.
  assert.equal(
    pick(
      [...joshs, ...[20, 21, 22, 23, 24, 25].map((n) => w(n, 8))],
      new Map([
        [7, 8],
        [8, 2],
      ]),
      0,
    )?.ticket,
    20,
  );
});

test('an empty line picks nothing', () => assert.equal(pick([], new Map(), 0), null));

/** A line with no Runner: `started` is who it started, `saved` its settings. */
function line(saved: Record<string, unknown> = {}, pools?: MachineHost, asks: (id: number) => LinePlace = () => ({ person: 1, rank: 1 })) {
  const busy = new Set<number>();
  const started: number[] = [];
  const stopped: number[] = [];
  const turns: TurnLine = new TurnLine({
    store: { getSetting: <T>(k: string) => saved[k] as T, setSetting: (k: string, v: unknown) => void (saved[k] = v), deleteSetting: (k: string) => void delete saved[k], addHealthEvent: () => {} },
    exempt: () => false,
    busy: (id) => busy.has(id),
    asks,
    forced: () => null,
    start: (e) => {
      started.push(e.ticket);
      turns.enter(e.ticket, e.via);
    },
    pauseTurn: (id) => void stopped.push(id),
    changed: () => {},
    carded: () => [],
    gapMs: 0,
    detached: false,
    pools,
  });
  return { turns, busy, started, stopped, saved };
}

test('a paused turn resumed before it ended joins the line and leaks no worker', async () => {
  const { turns, busy, started } = line();
  let ended = () => {};
  assert.equal(turns.enter(7), true);
  busy.add(7);
  const held = turns.hold(7, () => new Promise<void>((done) => (ended = done)));
  turns.setPause('stop', 'Josh');
  turns.setPause(false, 'Josh');
  turns.join(7);
  assert.deepEqual([turns.used(), turns.waiting()], [1, [7]]);
  busy.delete(7);
  ended();
  await held;
  assert.equal(turns.used(), 0, 'its worker is free');
  await until('it to start', () => started.length > 0);
  assert.deepEqual(started, [7]);
  turns.stop();
});

// #1916. Josh, 2026-11-24: "shouldnt a minion waiting on a card just release to the pool until the card is answered?"
test('a turn waiting on a card gives its worker back, and takes it again without waiting for one', async () => {
  const { turns, started } = line({ 'turn-pool': { size: 1, at: 1 } });
  turns.enter(7);
  turns.hold(7, () => new Promise(() => {}));
  assert.equal(turns.enter(8), false, 'the pool is full');
  turns.setLent(7, true);
  assert.deepEqual([turns.used(), turns.lent()], [0, 1]);
  await until('the next to start', () => started.includes(8));
  assert.deepEqual(turns.people(), [{ person: 1, used: 1, waiting: 0, lent: 1 }]);
  turns.setLent(7, true); // a second card of the same turn
  turns.setLent(7, false);
  assert.deepEqual([turns.used(), turns.lent()], [2, 0], 'over the size until one ends');
  assert.equal(turns.enter(9), false, 'and nothing new starts until then');
  turns.stop();
});

test('a turn that ends while its worker is lent leaks nothing', async () => {
  const { turns } = line({ 'turn-pool': { size: 1, at: 1 } });
  turns.enter(7);
  let end = () => {};
  const held = turns.hold(7, () => new Promise<void>((done) => (end = done)));
  turns.setLent(7, true);
  end();
  await held;
  turns.setLent(7, false);
  assert.deepEqual([turns.used(), turns.lent(), turns.people()], [0, 0, []]);
});

test('pausing and stopping stops a turn that waits on a card too', () => {
  const { turns, stopped } = line();
  turns.enter(7);
  turns.setLent(7, true);
  turns.setPause('stop', 'Josh');
  assert.deepEqual(stopped, [7]);
});

test("a boot check's copy forgets the line and the pause", () => {
  const { turns, saved } = line({ 'turn-line': [{ ticket: 7, since: 1 }], 'turns-paused': { by: 'Josh', at: 1 }, 'turn-pool': { size: 4, at: 1 } });
  turns.clear();
  assert.deepEqual([turns.waiting(), turns.paused(), turns.size(), saved], [[], null, POOL.start, {}]);
  assert.equal(turns.enter(8), true, 'its own turn starts');
});

// #1892: the limits are settings.
const mem = (extra = {}) => ({ ...full, ...extra });
test("a changed CPU line moves where Auto shrinks, and defaults are today's numbers", () => {
  assert.deepEqual(L, { min: 4, max: 30, growCpu: 35, growMem: 8, shrinkCpu: 50, shrinkMem: 20, shrinkFreeGb: 6, growSec: 20, shrinkSec: 30, waitHold: 120 });
  const r = { cpu: 55, mem: 0 };
  assert.equal(nextSize(full, r, LATER), 9);
  assert.equal(nextSize(full, r, LATER, ok, { ...L, shrinkCpu: 60 }), 10, 'a higher line leaves it');
  assert.equal(nextSize(full, { cpu: 30, mem: 0 }, LATER, ok, { ...L, shrinkCpu: 30, growCpu: 20 }), 9);
});
test('each line and time is read: free memory, memory pressure, fewest, most, seconds', () => {
  assert.equal(nextSize(full, { cpu: 5, mem: 0 }, LATER, { freeGb: 5.9, level: 'ok' }), 9);
  assert.equal(nextSize(full, { cpu: 5, mem: 0 }, LATER, { freeGb: 5.9, level: 'ok' }, { ...L, shrinkFreeGb: 4 }), 11, 'under the old 6 GB line, over the new 4');
  assert.equal(nextSize(full, { cpu: 5, mem: 25 }, LATER), 9);
  assert.equal(nextSize(mem({ size: 7 }), { cpu: 60, mem: 0 }, LATER, ok, { ...L, min: 7 }), 7, 'fewest');
  assert.equal(nextSize(mem({ size: 12, used: 12 }), { cpu: 5, mem: 0 }, LATER, ok, { ...L, max: 12 }), 12, 'most');
  assert.equal(nextSize(full, { cpu: 60, mem: 0 }, 10_000, ok, { ...L, shrinkSec: 5 }), 9, 'seconds per step down');
  assert.equal(nextSize(full, { cpu: 5, mem: 0 }, 10_000, ok, { ...L, growSec: 10 }), 11, 'seconds per step up');
});
test('memory level tight shrinks whatever the lines say; easing never grows', () => {
  const loose = { ...L, shrinkCpu: 100, shrinkMem: 100, shrinkFreeGb: 0.5 };
  assert.equal(nextSize(full, { cpu: 1, mem: 0 }, LATER, { freeGb: 2, level: 'tight' }, loose), 9);
  assert.equal(nextSize(full, { cpu: 1, mem: 0 }, LATER, { freeGb: 5, level: 'easing' }, loose), 10);
});
test('sets that can not work are refused with the reason', () => {
  assert.equal(refuse(L), null);
  assert.match(refuse({ ...L, min: 12, max: 8 })!, /Fewest workers \(12\) can't be over most workers \(8\)/);
  assert.match(refuse({ ...L, growCpu: 48 })!, /at least 5 points above/);
  assert.match(refuse({ ...L, shrinkMem: 10 })!, /memory pressure/);
  assert.match(refuse({ ...L, growSec: 3 })!, /10 to 3600/);
});

const dir = mkdtempSync(join(tmpdir(), 'pool-limits-'));
after(() => rmSync(dir, { recursive: true, force: true }));
test('saved limits steer at once, record who and when, a health event each, and reset puts the default back', () => {
  const store = new Store(join(dir, 'x.db'));
  const turns = new TurnLine({ store, exempt: () => false, busy: () => false, asks: () => null, forced: () => null, start: () => {}, pauseTurn: () => {}, changed: () => {}, carded: () => [], gapMs: 0, detached: false } as never);
  assert.deepEqual(turns.limits(), L);
  turns.setLimits({ shrinkCpu: 60 }, 'Josh', 5_000);
  assert.equal(turns.limits().shrinkCpu, 60);
  assert.deepEqual(turns.savedLimits().by.shrinkCpu, { by: 'Josh', at: 5_000 });
  const events = store.healthEventsSince(['pool-limits'], 0);
  assert.equal(events.length, 1);
  assert.match(events[0].detail, /Josh changed .*Shrink at CPU pressure: 50 to 60 %/);
  assert.throws(() => turns.setLimits({ min: 40, max: 3 }, 'Josh'), /can't be over/);
  assert.equal(turns.limits().max, 30, 'nothing of a refused set is kept');
  assert.equal(store.healthEventsSince(['pool-limits'], 0).length, 1);
  turns.setLimits({ shrinkCpu: null }, 'Josh', 6_000);
  assert.equal(turns.limits().shrinkCpu, 50);
  assert.equal(store.healthEventsSince(['pool-limits'], 0).length, 2);
});

test('a most under the size, or a fewest over it, pulls the size in on the next tick', () => {
  assert.equal(nextSize({ ...full, size: 20, used: 3 }, { cpu: 5, mem: 0 }, 1_000, ok, { ...L, max: 12 }), 12);
  assert.equal(nextSize({ ...full, size: 5, used: 5 }, { cpu: 5, mem: 0 }, 1_000, ok, { ...L, min: 8 }), 8);
});

// Build 7 T4: a pool per place. Josh, 2026-11-25: "I just want to be able to increase the worker pool by connecting more
// machines"; Cara the same day: a minion marked as needing one machine.
const DESK = 7;
function places(saved: Record<string, unknown> = {}, asks?: (id: number) => LinePlace, not: number[] = []) {
  const desk: MachinePlace = { id: DESK, name: 'desk', owner: 1, cap: 3, block: null, away: null, load: { reading: { cpu: 10, mem: 0 }, box: ok, at: Date.now() }, priority: null, room: null };
  const marks = new Map<number, number>();
  const never = new Set(not);
  const stuck: { ticket: number; block: Block }[] = [];
  const l = line(
    saved,
    {
      machines: () => [desk],
      mark: (id) => marks.get(id) ?? null,
      nameOf: () => 'desk',
      takes: (_m, id) => (never.has(id) ? { why: 'not lent', never: true } : null),
      stuck: (ticket, _since, block) => void stuck.push({ ticket, block }),
    },
    asks,
  );
  l.turns.setSize(1, 'Cara');
  return { ...l, desk, marks, never, stuck, at: (id: number) => l.turns.placeOf(id) };
}

test('with nobody else waiting, perigee first, then the machine up to its own size, then wait', () => {
  const p = places();
  assert.deepEqual([p.turns.enter(1), p.at(1)], [true, 0], 'perigee first');
  assert.deepEqual([p.turns.enter(2), p.at(2)], [true, DESK], 'perigee is full: the machine');
  assert.deepEqual([p.turns.enter(3), p.at(3)], [true, DESK]);
  assert.deepEqual([p.turns.enter(4), p.turns.has(4)], [false, true], 'both are full (Auto starts a machine at 2)');
  assert.deepEqual([p.turns.used(), p.turns.used(DESK), p.turns.size(DESK)], [1, 2, 2], 'each place counts its own');
  p.turns.stop();
});

test('a machine never runs one the turn may not, nor one while something holds the machine', () => {
  const p = places();
  p.turns.enter(1);
  p.never.add(2);
  assert.equal(p.turns.enter(2), false, "not its owner's, not lent, home only");
  p.marks.set(3, 0);
  assert.equal(p.turns.enter(3), false, 'perigee only');
  p.desk.block = { why: "a ship's tests are running there" };
  assert.equal(p.turns.enter(4), false);
  p.turns.stop();
});

test('a waiting turn goes to a machine as its worker frees, and home when perigee frees first', async () => {
  const p = places();
  p.desk.cap = 1;
  for (const id of [1, 2, 3, 4]) p.turns.enter(id);
  assert.deepEqual([p.at(1), p.at(2)], [0, DESK]);
  await p.turns.hold(2, () => {});
  await until('the third turn to start there', () => p.started.includes(3));
  assert.equal(p.at(3), DESK);
  await p.turns.hold(1, () => {});
  await until('the fourth to start at perigee', () => p.started.includes(4));
  assert.equal(p.at(4), 0);
});

test("a size over the owner's cap starts nothing more, and no word of its load holds Auto at its fewest", () => {
  const p = places();
  p.turns.setSize(9, 'Cara', DESK);
  assert.equal(p.turns.size(DESK), 3);
  p.turns.setSize(null, 'Cara', DESK);
  assert.equal(p.turns.size(DESK), 2);
  p.desk.load = null;
  assert.equal(p.turns.size(DESK), 1, 'unknown is never zero load');
  p.desk.load = { reading: { cpu: 0, mem: 0 }, box: ok, at: Date.now() - POOL.loadStaleMs - 1 };
  assert.equal(p.turns.size(DESK), 1, 'nor is an old reading');
  p.desk.cap = 0;
  assert.equal(p.turns.size(DESK), 0, 'no cap said yet');
});

// The quick lane (#1986) meets the places (Build 7): perigee's free worker or a forced start, then the person's machine, then the lane.
function quickPlaces(...quick: number[]) {
  return places({}, (id) => ({ person: 1, rank: 1, ...(quick.includes(id) ? { quick: true as const } : {}) }));
}
const inLane = (p: ReturnType<typeof places>) => p.turns.laneTurns().map((t) => t.ticket);

test('perigee full, a quick turn whose machine has room starts there, not in the quick lane', () => {
  const p = quickPlaces(2);
  p.turns.enter(1);
  assert.deepEqual([p.turns.enter(2), p.at(2), inLane(p)], [true, DESK, []]);
  p.turns.stop();
});

test('perigee full, a waiting quick turn takes a machine worker that frees with a lane worker, not the lane', async () => {
  const p = quickPlaces(4, 5, 6);
  for (const id of [1, 2, 3, 4, 5]) p.turns.enter(id);
  assert.deepEqual([p.at(1), p.at(2), p.at(3), inLane(p)], [0, DESK, DESK, [4, 5]], 'perigee, the machine and the lane all full');
  assert.equal(p.turns.enter(6), false);
  // Both free before the next pump: the machine's goes first.
  await Promise.all([p.turns.hold(4, () => {}), p.turns.hold(2, () => {})]);
  await until('the quick turn to start', () => p.started.includes(6));
  assert.deepEqual([p.at(6), inLane(p)], [DESK, [5]]);
  p.turns.stop();
});

test('perigee and the machine full, a quick turn takes the quick lane', () => {
  const p = quickPlaces(4);
  for (const id of [1, 2, 3]) p.turns.enter(id);
  assert.deepEqual([p.turns.enter(4), p.at(4), inLane(p)], [true, 0, [4]]);
  p.turns.stop();
});

test('a quick turn marked for a machine never takes the quick lane: it waits for that machine', async () => {
  const p = quickPlaces(4);
  for (const id of [1, 2, 3]) p.turns.enter(id);
  p.marks.set(4, DESK);
  assert.deepEqual([p.turns.enter(4), p.turns.has(4), inLane(p)], [false, true, []]);
  p.turns.pump();
  assert.deepEqual([p.turns.has(4), inLane(p)], [true, []], 'nor when the line moves');
  await p.turns.hold(2, () => {});
  await until('it to start on its machine', () => p.started.includes(4));
  assert.deepEqual([p.at(4), inLane(p)], [DESK, []]);
  p.turns.stop();
});

test("Auto sizes a machine on its own pressure, leaves perigee's alone, and says what it can't give way to", () => {
  const p = places({ 'turn-pool': { size: 10, at: 0 } });
  const now = Date.now();
  p.turns.setSize(1, 'Cara');
  const tick = (cpu: number, at: number) => {
    p.desk.load = { reading: { cpu, mem: 0 }, box: ok, at };
    p.turns.tick(calm, [], at, ok);
  };
  const why = () => p.turns.summary().machines[0].pool.why;
  for (const id of [1, 2, 3, 4]) p.turns.enter(id);
  tick(10, now + 60_000);
  assert.deepEqual([p.turns.size(DESK), why()], [3, 'desk is calm and turns wait']);
  tick(60, now + 120_000);
  tick(60, now + 180_000);
  tick(60, now + 240_000);
  assert.deepEqual([p.turns.pool(DESK).size, why()], [1, 'CPU pressure 60% there'], 'down to its fewest');
  tick(60, Date.now());
  assert.equal(p.turns.summary().machines[0].pressed, 'CPU pressure 60%', 'the row says so at the floor, CI counting too');
  assert.deepEqual([p.turns.pool().size, p.turns.size()], [10, 1], "perigee's saved size is as it was");
  p.turns.stop();
});

test('limits are each place’s own', () => {
  const p = places();
  p.turns.setLimits({ max: 2 }, 'Josh', Date.now(), DESK);
  assert.deepEqual([p.turns.limits(DESK).max, p.turns.limits().max], [2, L.max]);
  p.turns.forget(DESK);
  assert.equal(p.turns.limits(DESK).max, L.max);
});

test('a marked minion starts on its machine with perigee empty, and waits for it while perigee stays free', async () => {
  const p = places();
  p.marks.set(1, DESK);
  p.marks.set(2, DESK);
  assert.deepEqual([p.turns.enter(1), p.at(1), p.turns.used()], [true, DESK, 0]);
  p.desk.block = { why: 'away since Nov 25, 2:14 PM PST', since: 1 };
  assert.equal(p.turns.enter(2), false);
  assert.equal(p.turns.waitsForMachine(2), true);
  assert.deepEqual(p.turns.wait(2)!.machine, { name: 'desk', why: 'away since Nov 25, 2:14 PM PST' });
  assert.equal(p.turns.enter(3), true, 'it holds up nobody at perigee');
  p.turns.tick(calm, [], Date.now(), ok);
  assert.deepEqual(p.stuck, [{ ticket: 2, block: p.desk.block }], 'and its card is asked about');
  p.desk.block = null;
  p.desk.cap = 1;
  assert.equal(p.turns.wait(2)!.machine!.why, 'busy: 1 of 1 worker');
  p.turns.tick(calm, [], Date.now(), ok);
  assert.equal(p.stuck.length, 2);
  await p.turns.hold(1, () => {});
  await until('the second to start there', () => p.started.includes(2));
  assert.equal(p.at(2), DESK);
});

test('Start now on a marked minion passes neither its machine nor its cap', () => {
  const p = places();
  p.marks.set(1, DESK);
  p.desk.block = { why: 'away' };
  p.turns.enter(1);
  p.turns.force(1);
  assert.deepEqual([p.started, p.turns.has(1)], [[], true]);
  p.turns.stop();
});

test("a machine's worker stays with a turn that waits on a card: the agent there counts it", () => {
  const p = places();
  void p.turns.reattach(1, () => new Promise(() => {}), DESK);
  p.turns.setLent(1, true);
  assert.deepEqual([p.turns.used(DESK), p.turns.lent()], [1, 0]);
  p.turns.stop();
});

test("a turn re-attached on a machine holds that machine's worker, and one that comes home holds perigee's", () => {
  const p = places();
  void p.turns.reattach(1, () => new Promise(() => {}), DESK);
  assert.deepEqual([p.turns.used(), p.turns.used(DESK)], [0, 1]);
  p.turns.comeHome(1);
  assert.deepEqual([p.turns.used(), p.turns.used(DESK)], [1, 0]);
});

test("a machine's turns are not in its person's share at perigee", () => {
  const p = places();
  p.turns.reattach(1, () => new Promise(() => {}), DESK);
  p.turns.reattach(2, () => new Promise(() => {}), DESK);
  assert.deepEqual(
    [...p.turns.people()].map((x) => x.used),
    [2],
    'the tile still counts them as working',
  );
  assert.equal(p.turns.enter(3), true);
  assert.equal(p.at(3), 0);
});

// Josh, 2026-11-25: "1. Perigee if it has room and no one else needs it 2. Your machine if it has room and perigee either is
// full or someone without their own worker pool has jobs to run 3. Perigee if you have no machine and there are slots on
// perigee 4. Wait". Cara (1 to 99) owns the desk; Josh (100 and up) has no machine.
const josh = (id: number) => id >= 100;
const people =
  (urgent: number[] = []) =>
  (id: number): LinePlace => ({ person: josh(id) ? 2 : 1, rank: 1, ...(urgent.includes(id) ? { urgent: 0 } : {}) });
const list = (urgent?: number[]) => places({}, people(urgent), [100]);

test('step 2: while someone with no machine waits, an owner goes to the machine and perigee stays theirs', () => {
  const p = list();
  p.turns.join(100);
  assert.deepEqual([p.turns.enter(1), p.at(1)], [true, DESK], 'perigee has room, and Josh needs it');
  assert.deepEqual([p.turns.enter(100), p.at(100)], [true, 0], 'step 3');
  p.turns.stop();
});

test('step 3: a machineless turn is first at perigee, though an owner has waited longer', async () => {
  const p = list();
  p.desk.cap = 1;
  p.turns.enter(90);
  p.turns.enter(91);
  assert.deepEqual([p.at(90), p.at(91)], [0, DESK]);
  for (const id of [1, 2, 100]) p.turns.join(id);
  assert.deepEqual(p.turns.order(), [100, 1, 2], 'and the line shows it');
  await p.turns.hold(90, () => {});
  await until('Josh to start', () => p.started.length);
  assert.deepEqual([p.started, p.at(100)], [[100], 0]);
  assert.deepEqual([p.turns.has(1), p.turns.has(2)], [true, true], 'step 4: the full machine is still a machine');
  await p.turns.hold(100, () => {});
  await until('then perigee is the owner’s, with nobody else in need', () => p.started.includes(1));
  assert.equal(p.at(1), 0);
  p.turns.stop();
});

test('a newcomer owner with a full machine waits while a machineless turn waits, perigee free', () => {
  const p = list();
  p.turns.setSize(1, 'Cara', DESK);
  void p.turns.reattach(91, () => new Promise(() => {}), DESK);
  p.turns.join(100);
  assert.equal(p.turns.enter(1), false);
  assert.deepEqual([p.turns.enter(100), p.at(100)], [true, 0]);
  p.turns.stop();
});

test('a machine that cannot take a turn at all is no machine: it stands with the machineless', () => {
  for (const no of [(p: ReturnType<typeof list>) => void (p.desk.block = { why: 'away' }), (p: ReturnType<typeof list>) => void p.never.add(1), (p: ReturnType<typeof list>) => void p.marks.set(1, 0), (p: ReturnType<typeof list>) => void (p.desk.cap = 0)]) {
    const p = list();
    no(p);
    p.turns.join(1);
    p.turns.join(100);
    assert.deepEqual(p.turns.order(), [1, 100]);
    assert.deepEqual([p.turns.enter(1), p.at(1)], [true, 0]);
    p.turns.stop();
  }
});

test('one that waits but cannot start at perigee does not need it', () => {
  for (const [id, not] of [
    [100, (p: ReturnType<typeof list>) => void p.busy.add(100)],
    [2, (p: ReturnType<typeof list>) => void p.marks.set(2, DESK)],
  ] as const) {
    const p = list();
    not(p);
    p.turns.join(id);
    assert.deepEqual([p.turns.enter(1), p.at(1)], [true, 0]);
    p.turns.stop();
  }
});

test('an Urgent owner’s turn starts before a machineless one: on the machine, or at perigee when that is full', async () => {
  for (const full of [false, true]) {
    const p = list([1]);
    let over = () => {};
    p.turns.enter(90);
    void p.turns.hold(90, () => new Promise<void>((r) => (over = r)));
    void p.turns.reattach(91, () => new Promise(() => {}), DESK);
    void p.turns.reattach(92, () => new Promise(() => {}), DESK);
    p.turns.join(100);
    p.turns.join(1);
    assert.deepEqual(p.turns.order(), [1, 100]);
    if (!full) p.turns.setSize(3, 'Cara', DESK);
    else over();
    await until('the urgent one to start', () => p.started.length);
    assert.deepEqual([p.started[0], p.at(1)], [1, full ? 0 : DESK]);
    p.turns.stop();
  }
});

test('an Urgent owner’s turn uses its machine while perigee is needed, so both start', async () => {
  const p = list([1]);
  p.turns.join(100);
  p.turns.join(1);
  await until('both to start', () => p.started.length === 2);
  assert.deepEqual([p.started, p.at(1), p.at(100)], [[1, 100], DESK, 0]);
});

test('after 90 minutes an owner’s turn stands at perigee as if there were no machine', () => {
  const first = (since: number) =>
    places(
      {
        'turn-line': [
          { ticket: 1, since },
          { ticket: 100, since: Date.now() },
        ],
      },
      people(),
      [100],
    ).started[0];
  assert.deepEqual([first(Date.now() - POOL.longMs), first(Date.now() - POOL.longMs + 60_000)], [1, 100]);
});

test('a long wait alone does not send an owner’s turn to its machine: nobody else needs perigee', async () => {
  const p = places({}, people(), [100]);
  const since = Date.now() - POOL.longMs;
  for (const id of [1, 2]) p.turns.join(id);
  const q = places(
    {
      'turn-line': [
        { ticket: 1, since },
        { ticket: 2, since },
      ],
    },
    people(),
  );
  await until('both lines to start', () => p.started.length + q.started.length === 4);
  for (const l of [p, q]) assert.deepEqual([l.at(1), l.at(2)], [0, DESK]);
});

test('pick: with no machine first, after Urgent and Start now, the shares unchanged within each', () => {
  const own = (x: Waiting): Waiting => ({ ...x, own: true });
  assert.deepEqual(order([own(w(1, 7)), w(2, 8), own(w(3, 9)), w(4, 8)]), [2, 4, 1, 3]);
  assert.deepEqual(order([w(2, 8), own({ ...w(1, 7), urgent: 0 })]), [1, 2]);
  assert.deepEqual(order([w(2, 8), own({ ...w(1, 7), forced: true })]), [1, 2]);
});

// Build 7 M6: one balancer per machine, and the owner's order across their machines. Josh, 2026-11-25: "if there is CI to
// run, we use less workers", and "users with multiple machines should be able to prio them, like say put work on machine 1
// before using machine 2"; the Taskmaster's pick the same day: the order beats the warm cache.
function fleet(priority: [number | null, number | null]) {
  const at = Date.now();
  const mk = (id: number, name: string, prio: number | null): MachinePlace => ({ id, name, owner: 1, cap: 3, block: null, away: null, load: { reading: { cpu: 10, mem: 0 }, box: ok, at }, priority: prio, room: null });
  const [one, two] = [mk(7, 'one', priority[0]), mk(8, 'two', priority[1])];
  const l = line({}, { machines: () => [one, two], mark: () => null, nameOf: (id) => (id === 7 ? 'one' : 'two'), takes: () => null, stuck: () => {} });
  l.turns.setSize(0, 'Cara');
  l.turns.setSize(3, 'Cara', 8);
  return { ...l, one, two, at: (id: number) => l.turns.placeOf(id) };
}

test('machine 1 is filled to its budget before machine 2, though 2 has more room', () => {
  const f = fleet([1, 2]);
  for (const id of [1, 2, 3, 4, 5]) f.turns.enter(id);
  assert.deepEqual([1, 2, 3, 4, 5].map(f.at), [7, 7, 8, 8, 8]);
  f.turns.stop();
});

test('with no order, the most room goes first, as before', () => {
  const f = fleet([null, null]);
  f.turns.enter(1);
  assert.equal(f.at(1), 8, 'three free beats two');
  f.turns.stop();
});

test('equal order: a minion goes back to the machine it last ran on while it has room', async () => {
  const f = fleet([1, 1]);
  f.turns.setSize(2, 'Cara', 8);
  f.turns.enter(1);
  f.turns.enter(2);
  assert.deepEqual([f.at(1), f.at(2)], [7, 8], 'equal room: the lower number, then the most room');
  await f.turns.hold(2, () => {});
  f.turns.enter(3);
  assert.equal(f.at(3), 8);
  await f.turns.hold(1, () => {});
  f.turns.enter(9);
  assert.equal(f.at(9), 7);
  await f.turns.hold(3, () => {});
  f.turns.enter(2);
  assert.equal(f.at(2), 8, 'machine two is where it ran, and it has room again');
  f.turns.stop();
});

test("the balancer's target holds a machine under its cap, and the tile's row says why", () => {
  const f = fleet([1, 2]);
  f.one.room = { workers: 0, why: '2 CI jobs waiting' };
  f.turns.enter(1);
  assert.equal(f.at(1), 8, 'CI waits on one: the turn goes to two');
  assert.equal(f.turns.size(7), 0);
  const row = f.turns.summary().machines.find((m) => m.id === 7)!;
  assert.equal(row.balanced, '2 CI jobs waiting');
  f.one.room = { workers: 2, why: null };
  assert.equal(f.turns.summary().machines.find((m) => m.id === 7)!.balanced, null);
  f.turns.stop();
});

test("Auto's size follows the balancer's target down, then grows back on Auto's own clock", () => {
  const f = fleet([1, 2]);
  const now = Date.now();
  f.one.room = { workers: 0, why: '2 CI jobs waiting' };
  f.turns.tick(calm, [], now, ok);
  assert.deepEqual([f.turns.pool(7).size, f.turns.pool(7).why], [0, '2 CI jobs waiting']);
  f.one.room = { workers: 3, why: null };
  for (const id of [1, 2, 3, 4, 5, 6]) f.turns.join(id);
  f.turns.tick(calm, [], now + POOL.everyMs, ok);
  assert.ok(f.turns.pool(7).size < 3, `not back at once: ${f.turns.pool(7).size}`);
  f.turns.stop();
});
