import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { until } from './wait.ts';
import { nextSize as size, pick, POOL, TurnLine, type Waiting } from '../src/turn-line.ts';
import { DEFAULT_LIMITS as L, refuse } from '../src/turn-limits.ts';
import { Store } from '../src/db.ts';
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
function line(saved: Record<string, unknown> = {}) {
  const busy = new Set<number>();
  const started: number[] = [];
  const turns: TurnLine = new TurnLine({
    store: { getSetting: <T>(k: string) => saved[k] as T, setSetting: (k: string, v: unknown) => void (saved[k] = v), deleteSetting: (k: string) => void delete saved[k], addHealthEvent: () => {} },
    exempt: () => false,
    busy: (id) => busy.has(id),
    asks: () => ({ person: 1, rank: 1 }),
    start: (e) => {
      started.push(e.ticket);
      turns.enter(e.ticket, e.via);
    },
    pauseTurn: () => {},
    changed: () => {},
    gapMs: 0,
    detached: false,
  });
  return { turns, busy, started, saved };
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

test("a boot check's copy forgets the line and the pause", () => {
  const { turns, saved } = line({ 'turn-line': [{ ticket: 7, since: 1 }], 'turns-paused': { by: 'Josh', at: 1 }, 'turn-pool': { size: 4, at: 1 } });
  turns.clear();
  assert.deepEqual([turns.waiting(), turns.paused(), turns.size(), saved], [[], null, POOL.start, {}]);
  assert.equal(turns.enter(8), true, 'its own turn starts');
});

// #1892: the limits are settings.
const mem = (extra = {}) => ({ ...full, ...extra });
test("a changed CPU line moves where Auto shrinks, and defaults are today's numbers", () => {
  assert.deepEqual(L, { min: 4, max: 30, growCpu: 35, growMem: 8, shrinkCpu: 50, shrinkMem: 20, shrinkFreeGb: 6, growSec: 20, shrinkSec: 30 });
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
  const turns = new TurnLine({ store, exempt: () => false, busy: () => false, asks: () => null, start: () => {}, pauseTurn: () => {}, changed: () => {}, gapMs: 0, detached: false } as never);
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
