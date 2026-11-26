import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { patchMachine } from '../src/routes/machines.ts';
import { type BalanceIn, balance, HEAVY_WAIT_MS, MachineBalancer, rank } from '../src/machine-balancer.ts';

// Build 7 M6: one balancer per machine. Josh, 2026-11-25: "so if there is CI to run, we use less workers, or more workers,
// maybe we hold off on a build until the worker count drops", his pick "A · Waiting CI shrinks the workers" and "Its size
// to be free". The slider board on specs/worker-machines/machine-connections-choices.html is the spec: Josh's PC, 24
// threads, a turn 3, a CI job 4, a ship 6, an APK build 8, at most 6 workers, 4 turns running.
const T = 24;
const NOW = Date.UTC(2026, 10, 25, 23, 0);
const none = { workers: null, runners: null, turnThreads: null, ciThreads: null };

/** The choices page's take A, as its board computes it (plan('A', k)), the settled plan once running turns end. */
function board(k: { ci: number; tw: number; ship: boolean; heavy: boolean }) {
  const [W, C, S, H, MAXW, RUN] = [3, 4, 6, 8, 6, 4];
  let free = T;
  if (k.ship) free -= S;
  const ciN = Math.min(k.ci, Math.floor(free / C));
  free -= ciN * C;
  const target = Math.max(0, Math.min(Math.min(MAXW, RUN + k.tw), Math.floor((free - (k.heavy ? H : 0)) / W)));
  const left = T - (k.ship ? S : 0) - ciN * C - target * W;
  return { ciN, target, heavyNow: k.heavy && left >= H };
}

const input = (k: { ci: number; ship: boolean; heavy: boolean }, running: number): BalanceIn => ({
  threads: T,
  caps: { ...none, workers: 6 },
  ship: k.ship,
  ciWaiting: k.ci,
  running,
  heavy: k.heavy ? [{ key: 'apk', label: 'APK build', size: 8, since: NOW - 60_000 }] : [],
  now: NOW,
});

test("every slider case on the choices page: CI fits first, workers take what's left after a waiting build, the build starts once its size is free", () => {
  for (let ci = 0; ci <= 5; ci++)
    for (let tw = 0; tw <= 4; tw++)
      for (const ship of [false, true])
        for (const heavy of [false, true]) {
          const k = { ci, tw, ship, heavy };
          const want = board(k);
          const at = JSON.stringify(k);
          // The worker target the line holds is the balancer's; waiting turns past it are Auto's and the line's business.
          const now = balance(input(k, 4));
          assert.equal(now.ci, want.ciN, `${at}: CI jobs that fit`);
          assert.equal(Math.min(now.workers, 4 + tw), want.target, `${at}: worker target`);
          // Once running turns have come down to the target (they are never stopped), the build goes if the board says so.
          const settled = balance(input(k, want.target));
          assert.equal(settled.start.includes('apk'), want.heavyNow, `${at}: the build starts once turns end`);
        }
});

test('the board as Josh first saw it: 2 CI jobs waiting, an APK build: target 2, no new turns, the APK waits', () => {
  const p = balance(input({ ci: 2, ship: false, heavy: true }, 4));
  assert.deepEqual([p.workers, p.ci, p.start, p.late], [2, 2, [], []]);
  assert.equal(p.why, '2 CI jobs waiting; APK build waits for 8 threads');
  assert.deepEqual(balance(input({ ci: 2, ship: false, heavy: true }, 2)).start, ['apk'], 'two turns end: its 8 threads are free');
});

test('quiet CI gives the workers back to the cap, and says nothing', () => {
  const p = balance(input({ ci: 0, ship: false, heavy: false }, 4));
  assert.deepEqual([p.workers, p.why], [6, null]);
});

test('a heavy job that waited 30 minutes starts anyway, and stops holding the turns back', () => {
  const k = { ...input({ ci: 5, ship: false, heavy: false }, 4), heavy: [{ key: 'apk', label: 'APK build', size: 8, since: NOW - HEAVY_WAIT_MS }] };
  const p = balance(k);
  assert.deepEqual([p.start, p.late], [[], ['apk']]);
  assert.equal(p.workers, balance({ ...k, heavy: [] }).workers, 'no size kept free for it any more');
});

test('a running heavy job holds its size; heavy jobs go in the order they asked', () => {
  const p = balance({
    ...input({ ci: 0, ship: false, heavy: false }, 0),
    heavy: [
      { key: 'gpu', label: 'GPU job 3', size: 4, since: NOW - 1000, running: true },
      { key: 'big', label: 'APK build', size: 21, since: NOW - 900 },
      { key: 'small', label: 'Windows test run', size: 2, since: NOW - 800 },
    ],
  });
  assert.deepEqual(p.start, [], 'the small one does not jump the big one');
  assert.equal(p.workers, 0, '24 - 4 running leaves 20, short of the 21 kept for the APK: no turn');
});

test("the owner's caps are the ceiling for every role", () => {
  const p = balance({ ...input({ ci: 5, ship: false, heavy: false }, 0), caps: { workers: 2, runners: 1, turnThreads: null, ciThreads: null } });
  assert.deepEqual([p.ci, p.runners, p.workers], [1, 1, 2]);
  const t = balance({ ...input({ ci: 0, ship: false, heavy: false }, 0), caps: { workers: null, runners: null, turnThreads: 7, ciThreads: 8 } });
  assert.deepEqual([t.workers, t.runners, t.why], [2, 2, null], 'a threads cap is not a squeeze to explain');
});

// Josh, 2026-11-25: "users with multiple machines should be able to prio them, like say put work on machine 1 before using
// machine 2". Taskmaster's pick, the same day: the owner's order beats the warm cache.
test('machine 1 is filled to its budget before machine 2', () => {
  const one = { id: 1, priority: 1, free: 2 };
  const two = { id: 2, priority: 2, free: 5 };
  assert.deepEqual(
    rank([two, one]).map((m) => m.id),
    [1, 2],
    'order beats more room',
  );
  assert.deepEqual(
    rank([two, one], { warm: 2 }).map((m) => m.id),
    [1, 2],
    'order beats the warm cache',
  );
  assert.deepEqual(
    rank([two, { ...one, free: 0 }]).map((m) => m.id),
    [2],
    'full: the next one',
  );
  assert.deepEqual(
    rank([two, one], { mark: 2 }).map((m) => m.id),
    [2],
    'marked for one: only there',
  );
  assert.deepEqual(
    rank([{ id: 3, priority: null, free: 9 }, two]).map((m) => m.id),
    [2, 3],
    'no order stands after an order',
  );
});

test('equal priority: where it last ran while it has room, else the most free room', () => {
  const a = { id: 1, priority: 1, free: 1 };
  const b = { id: 2, priority: 1, free: 4 };
  assert.deepEqual(
    rank([a, b]).map((m) => m.id),
    [2, 1],
  );
  assert.deepEqual(
    rank([a, b], { warm: 1 }).map((m) => m.id),
    [1, 2],
  );
  assert.deepEqual(
    rank([{ ...a, free: 0 }, b], { warm: 1 }).map((m) => m.id),
    [2],
  );
  assert.deepEqual(
    rank(
      [
        { ...a, priority: null },
        { ...b, priority: null },
      ],
      { warm: 1 },
    ).map((m) => m.id),
    [1, 2],
    'no order at all is today: warm, then room',
  );
});

test('a heavy job asks, waits while turns hold its size, starts when they end, and frees it when done', () => {
  let running = 4;
  const told: number[][] = [];
  const b = new MachineBalancer({ machines: () => [7], input: () => ({ threads: T, caps: { ...none, workers: 6 }, ship: false, ciWaiting: 2, running }), changed: (ids) => void told.push(ids), now: () => NOW });
  const apk = { key: 'apk', label: 'APK build', size: 8 };
  assert.equal(b.ask(7, apk), 'wait');
  assert.equal(b.plan(7)!.workers, 2, 'no new turn while it waits');
  running = 2;
  assert.equal(b.ask(7, apk), 'start');
  assert.equal(b.ask(7, apk), 'start', 'asking again keeps it');
  b.done('apk');
  assert.deepEqual(told.at(-1), [7]);
  assert.equal(b.plan(7)!.workers, 5, 'its 8 threads are free for turns again');
  assert.equal(b.ask(99, apk), 'start', 'a machine the balancer has no say on (no threads reported) never holds a job');
});

test('the tick tells only the machines whose plan moved', () => {
  let ci = 0;
  const told: number[][] = [];
  const b = new MachineBalancer({ machines: () => [7, 8], input: (id) => ({ threads: T, caps: none, ship: false, ciWaiting: id === 7 ? ci : 0, running: 0 }), changed: (ids) => void told.push(ids), now: () => NOW });
  b.tick();
  assert.deepEqual(told, [[7, 8]], 'first plans');
  b.tick();
  assert.equal(told.length, 1);
  ci = 2;
  b.tick();
  assert.deepEqual(told.at(-1), [7]);
});

test("the order is set on the machine's row by its owner alone, 1 to 99 or none", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-order-'));
  const store = new Store(join(dir, 'c.db'));
  try {
    const josh = store.createUser({ name: 'Josh', login: 'josh' });
    const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
    const m = store.createMachine('desk', 'h', 'Josh', josh.id);
    const pumped: number[] = [];
    const app = {
      store,
      runner: { turnLine: { pump: () => void pumped.push(1) } },
      machines: { list: () => [], view: (x: { priority?: number | null }) => ({ priority: x.priority ?? null }) },
      broadcast: () => {},
    } as unknown as Parameters<typeof patchMachine>[0];
    const as = (u: { id: number; admin?: number | boolean }) => ({ uid: u.id, admin: !!u.admin }) as Parameters<typeof patchMachine>[1];
    assert.deepEqual(await patchMachine(app, as(josh), m, { priority: 1 }), { priority: 1 });
    assert.equal(store.getMachine(m.id)!.priority, 1);
    assert.equal(pumped.length, 1, 'the line looks again');
    await assert.rejects(patchMachine(app, as(cara), m, { priority: 2 }), /Only its owner can set its order/);
    for (const bad of [0, 100, 1.5, '1']) await assert.rejects(patchMachine(app, as(josh), m, { priority: bad }), /whole number from 1 to 99/);
    await patchMachine(app, as(josh), m, { priority: null });
    assert.equal(store.getMachine(m.id)!.priority, null, 'back to no order');
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});
