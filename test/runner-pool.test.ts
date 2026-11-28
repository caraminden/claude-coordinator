import assert from 'node:assert/strict';
import { test } from 'node:test';
import { line, needsOf, place, POOL, type PoolJob, type PoolMachine, settle, stepOf } from '../src/runner-pool.ts';

// The pool's line and placing rule (Build 11 P1, specs/one-runner-pool.md sections 3 and 4). Cara, 2026-11-27, #2264's
// card Q2: "Citadel's ships first", "But dont make other schemes or even non-ships wait too long, let them take turns,
// just prio ships and citadel"; and "if a machine doesnt have room, we can wait and load balance, not run the job starved".
const NOW = Date.UTC(2026, 10, 28, 6, 0);
const MIN = 60_000;
const CITADEL = 2;
const PEEK = 5;
const MANDATE = 7;

let nextId = 100;
function job(o: Partial<PoolJob> & { scheme: number }): PoolJob {
  const id = o.id ?? nextId++;
  return { repo: `r/${o.scheme}`, id, run: id, name: `job ${id}`, ship: false, first: false, since: NOW, needs: { os: 'linux', session: false, size: 4 }, ...o };
}
function pc(o: Partial<PoolMachine> & { id: number }): PoolMachine {
  return { name: `pc${o.id}`, priority: null, os: ['windows', 'linux'], session: true, schemes: [CITADEL, PEEK, MANDATE], free: 16, off: null, ...o };
}
const ids = (xs: { job: PoolJob }[]) => xs.map((x) => x.job.id);

test("the line: Citadel's ships, other ships oldest first, then the rest", () => {
  const check = job({ id: 1, scheme: CITADEL, since: NOW - 3 * MIN });
  const peekShipNew = job({ id: 2, scheme: PEEK, ship: true, since: NOW - 1 * MIN });
  const peekShipOld = job({ id: 3, scheme: MANDATE, ship: true, since: NOW - 4 * MIN });
  const citadelShip = job({ id: 4, scheme: CITADEL, ship: true, first: true, since: NOW });
  assert.deepEqual(ids(line([check, peekShipNew, peekShipOld, citadelShip], NOW, new Map())), [4, 3, 2, 1]);
});

test('waiting 10 minutes moves a job up one step, each 10 minutes again', () => {
  assert.equal(stepOf({ ship: false, first: false, since: NOW - (POOL.moveUpMs - 1) }, NOW), 2);
  assert.equal(stepOf({ ship: false, first: false, since: NOW - POOL.moveUpMs }, NOW), 1);
  assert.equal(stepOf({ ship: false, first: false, since: NOW - 2 * POOL.moveUpMs }, NOW), 0);
  assert.equal(stepOf({ ship: true, first: true, since: NOW - 5 * POOL.moveUpMs }, NOW), 0);
  // A check held 10 minutes by a stream of ships goes before the newer ones.
  const check = job({ id: 1, scheme: PEEK, since: NOW - 10 * MIN });
  const ships = [2, 3].map((id) => job({ id, scheme: MANDATE, ship: true, since: NOW - MIN }));
  assert.deepEqual(ids(line([...ships, check], NOW, new Map())), [1, 2, 3]);
  // Another scheme's ship stuck 10 minutes behind Citadel's moves level with it: oldest first.
  const citadel = job({ id: 4, scheme: CITADEL, ship: true, first: true, since: NOW - MIN });
  const peek = job({ id: 5, scheme: PEEK, ship: true, since: NOW - 11 * MIN });
  assert.deepEqual(ids(line([citadel, peek], NOW, new Map())), [5, 4]);
});

test('the rest take turns: the scheme that has waited longest since its last start goes next', () => {
  const peek = [1, 2, 3].map((id) => job({ id, scheme: PEEK, since: NOW - (5 - id) * MIN }));
  const mandate = [4, 5].map((id) => job({ id, scheme: MANDATE, since: NOW - MIN }));
  // Mandate never started, Peek did a minute ago: Mandate first, then they alternate, Peek's last ones at the end.
  assert.deepEqual(ids(line([...peek, ...mandate], NOW, new Map([[PEEK, NOW - MIN]]))), [4, 1, 5, 2, 3]);
  // Neither started: Peek's oldest job is older, so Peek goes first.
  assert.deepEqual(ids(line([...peek, ...mandate], NOW, new Map())), [1, 4, 2, 5, 3]);
});

test('a job starts only where its size is free, and room is taken as jobs are placed', () => {
  const jobs = [1, 2, 3].map((id) => job({ id, scheme: PEEK, since: NOW - id }));
  const out = place({ jobs, machines: [pc({ id: 1, free: 9 })], now: NOW, lastStart: new Map(), warm: new Map() });
  assert.deepEqual(
    out.map((p) => p.machine),
    [1, 1, null],
  );
  assert.equal(out[2].why, 'room on pc1: needs 4 threads, 1 free');
  const short = place({ jobs: [job({ scheme: PEEK, needs: { os: 'linux', session: false, size: 8 } })], machines: [pc({ id: 1, free: 7 })], now: NOW, lastStart: new Map(), warm: new Map() });
  assert.equal(short[0].machine, null);
});

test('a big job gets its room: after 2 minutes, nothing smaller starts on the machine it waits for', () => {
  const big = (since: number) => job({ id: 1, scheme: MANDATE, since, needs: { os: 'linux', session: false, size: 8 } });
  const small = job({ id: 2, scheme: PEEK, since: NOW });
  const machines = [pc({ id: 1, free: 6 })];
  const early = place({ jobs: [big(NOW - POOL.bigHoldMs + 1), small], machines, now: NOW, lastStart: new Map(), warm: new Map() });
  assert.deepEqual(
    early.map((p) => p.machine),
    [null, 1],
    'before 2 minutes the smaller job behind it still starts',
  );
  const late = place({ jobs: [big(NOW - POOL.bigHoldMs), small], machines, now: NOW, lastStart: new Map(), warm: new Map() });
  assert.deepEqual(
    late.map((p) => p.machine),
    [null, null],
  );
  assert.match(late[0].why!, /nothing smaller starts there meanwhile/);
  assert.match(late[1].why!, /held for a bigger job ahead of it: job 1 on pc1/);
  // Another machine with room still takes the small one.
  const two = place({ jobs: [big(NOW - POOL.bigHoldMs), small], machines: [pc({ id: 1, free: 6, priority: 1 }), pc({ id: 2, free: 4, priority: 2 })], now: NOW, lastStart: new Map(), warm: new Map() });
  assert.deepEqual(
    two.map((p) => p.machine),
    [null, 2],
  );
});

test("the owner's order first, then the warm machine, then the most room", () => {
  const j = () => job({ scheme: PEEK });
  const at = (machines: PoolMachine[], warm?: number) => place({ jobs: [j()], machines, now: NOW, lastStart: new Map(), warm: new Map(warm ? [[PEEK, warm]] : []) })[0].machine;
  assert.equal(at([pc({ id: 1, priority: 2, free: 20 }), pc({ id: 2, priority: 1, free: 4 })]), 2);
  assert.equal(at([pc({ id: 1, free: 20 }), pc({ id: 2, free: 4 })], 2), 2);
  assert.equal(at([pc({ id: 1, free: 8 }), pc({ id: 2, free: 12 })]), 2);
});

test('why a job waits when no machine can take it', () => {
  const why = (j: PoolJob, machines: PoolMachine[]) => place({ jobs: [j], machines, now: NOW, lastStart: new Map(), warm: new Map() })[0].why;
  assert.equal(why(job({ scheme: 99 }), [pc({ id: 1 })]), 'no machine lends CI to its scheme');
  assert.equal(why(job({ scheme: PEEK, needs: { os: 'windows', session: false, size: 4 } }), [pc({ id: 1, os: ['linux'] })]), 'no machine lending its scheme CI runs Windows');
  assert.equal(why(job({ scheme: PEEK, needs: { os: 'windows', session: true, size: 4 } }), [pc({ id: 1, session: false })]), 'no machine lending its scheme CI has a person signed in on Windows');
  assert.equal(why(job({ scheme: PEEK }), [pc({ id: 1, name: 'cara-desktop', off: 'is offline' })]), 'cara-desktop is offline');
  assert.match(why(job({ scheme: PEEK, needs: { os: null, session: false, size: 4 } }), [pc({ id: 1 })])!, /name no Windows or Linux runner/);
  // A machine that is off never takes it, even with room.
  assert.equal(place({ jobs: [job({ scheme: PEEK })], machines: [pc({ id: 1, off: 'is paused' })], now: NOW, lastStart: new Map(), warm: new Map() })[0].machine, null);
});

test("a job's needs come from its labels", () => {
  assert.deepEqual(needsOf(['self-hosted', 'peek-auras-ci'], 'Peek Auras'), { os: 'windows', session: false, size: POOL.sizes.ci });
  assert.deepEqual(needsOf(['self-hosted', 'citadel-ci-linux', 'citadel-ci-linux-side'], 'Citadel'), { os: 'linux', session: false, size: 4 });
  assert.deepEqual(needsOf(['self-hosted', 'citadel-ci-linux-check'], 'Citadel'), { os: 'linux', session: false, size: 4 });
  assert.deepEqual(needsOf(['self-hosted', 'Peek-Auras-Desktop'], 'Peek Auras'), { os: 'windows', session: true, size: 4 });
  assert.deepEqual(needsOf(['self-hosted', 'citadel-ci-linux', 'citadel-ci-linux-long', 'citadel-heavy-suite'], 'Citadel'), { os: 'linux', session: false, size: 6 });
  assert.deepEqual(needsOf(['self-hosted', 'citadel-ci-linux', 'citadel-heavy-desktop'], 'Citadel'), { os: 'linux', session: false, size: 8 });
  assert.deepEqual(needsOf(['self-hosted', 'mandate-ci-linux', 'citadel-heavy-what'], 'Mandate'), { os: 'linux', session: false, size: POOL.sizes.heavyUnknown });
  assert.deepEqual(needsOf(['self-hosted', 'linux', 'x64'], 'Mandate'), { os: 'linux', session: false, size: 4 });
  assert.deepEqual(needsOf(['self-hosted'], 'Mandate'), { os: null, session: false, size: 4 });
});

test('the books follow the job each runner really took: a same-repo swap books neither job twice', () => {
  const r = (name: string, job: number, at = NOW) => ({ name, repo: 'o/peek', machine: 1, job, at });
  // s2 was made for job 20 but took job 10 (s1's); s1 hasn't taken one yet: s1 now stands for job 20.
  const a = settle([r('s1', 10), r('s2', 20)], [{ repo: 'O/Peek', id: 10, runner: 's2' }], NOW);
  assert.deepEqual(Object.fromEntries(a.holds), { s1: { machine: 1, job: 20 }, s2: { machine: 1, job: 10 } });
  assert.deepEqual(a.free, []);
  assert.deepEqual(a.reap, []);
  // Both swapped: each holds the other's.
  const b = settle(
    [r('s1', 10), r('s2', 20)],
    [
      { repo: 'o/peek', id: 20, runner: 's1' },
      { repo: 'o/peek', id: 10, runner: 's2' },
    ],
    NOW,
  );
  assert.deepEqual(Object.fromEntries(b.holds), { s1: { machine: 1, job: 20 }, s2: { machine: 1, job: 10 } });
  // s2 took s1's job and s1 is past the 2 minutes: s1 is reaped, and job 20 waits again.
  const c = settle([r('s1', 10, NOW - POOL.reapMs), r('s2', 20)], [{ repo: 'o/peek', id: 10, runner: 's2' }], NOW);
  assert.deepEqual(c.reap, ['s1']);
  assert.deepEqual(c.free, [20]);
  assert.deepEqual(Object.fromEntries(c.holds), { s2: { machine: 1, job: 10 } });
  // Another repo's runner of the same name takes nothing of this one's.
  const d = settle([r('s1', 10)], [{ repo: 'o/mandate', id: 10, runner: 's1' }], NOW);
  assert.deepEqual(Object.fromEntries(d.holds), { s1: { machine: 1, job: 10 } });
});
