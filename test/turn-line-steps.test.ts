// The worker line's own steps (src/turn-line.ts) on a fake host and a mocked clock: no process, no sleep (#1778).
// test/turn-line.test.ts runs it under a Runner, test/worker-pool.test.ts its sums.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { pick, TurnLine, type LineEntry, type LineHost } from '../src/turn-line.ts';
import type { RetryKind } from '../src/turn-outcome.ts';

const CALM = { cpu: 30, mem: 0, io: 0, starved: false, why: '' };

/** A line over `size` workers, what it asked of its host, and turns that go on until `end`. */
function line(t: TestContext, size = 1) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const saved = new Map<string, string>([['turn-pool', JSON.stringify({ size, at: 0, fixed: { size, by: 'cara' } })]]);
  const started: string[] = [];
  const stopped: number[] = [];
  const changes: number[][] = [];
  const busy = new Set<number>();
  const forced = new Set<number>();
  const pressers = new Map<number, number>();
  const persons = new Map<number, number>();
  const quick = new Set<number>();
  const urgent = new Map<number, number>();
  const steps = new Map<number, (() => void)[]>();
  let fails = 0;
  const store = {
    getSetting: (k: string) => (saved.has(k) ? JSON.parse(saved.get(k)!) : null),
    setSetting: (k: string, v: unknown) => void saved.set(k, JSON.stringify(v)),
    deleteSetting: (k: string) => void saved.delete(k),
    addHealthEvent: () => {},
  } as unknown as LineHost['store'];
  const host: LineHost = {
    store,
    exempt: () => false,
    busy: (id) => busy.has(id),
    asks: (id) => ({ person: persons.get(id) ?? 1, rank: 0, ...(quick.has(id) ? { quick: true as const } : {}), ...(urgent.has(id) ? { urgent: urgent.get(id)! } : {}) }),
    forced: (id) => (forced.has(id) ? { user: pressers.get(id) ?? 7, by: 'Josh' } : null),
    start: (e) => {
      started.push(e.via ? `${e.ticket} ${e.via}` : String(e.ticket));
      if (fails-- > 0) throw new Error('no place to run');
      run(e.ticket, e.via);
    },
    pauseTurn: (id) => void stopped.push(id),
    changed: (ids) => void changes.push(ids),
    carded: () => [],
    gapMs: 0,
    detached: false,
  };
  let l = new TurnLine(host);
  /** Enter and, with a worker, hold it until `end`. */
  function run(id: number, via?: RetryKind) {
    if (!l.enter(id, via)) return false;
    void l.hold(id, () => new Promise<void>((r) => steps.set(id, [...(steps.get(id) ?? []), r])));
    return true;
  }
  return {
    get l() {
      return l;
    },
    run,
    started,
    stopped,
    busy,
    forced,
    pressers,
    persons,
    quick,
    urgent,
    changes,
    /** A person presses Start now on it. */
    press(id: number) {
      forced.add(id);
      l.force(id);
    },
    failNext: () => void (fails = 1),
    /** Its oldest step ends; the microtasks and due timers that follow have run. */
    async end(id: number) {
      steps.get(id)!.shift()!();
      await this.turn();
    },
    async turn() {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      t.mock.timers.tick(1);
    },
    restart: () => void (l = new TurnLine(host)),
    waits: () => l.line().map((e) => e.ticket),
    entry: (id: number) => (store.getSetting<LineEntry[]>('turn-line') ?? []).find((e) => e.ticket === id),
  };
}

test('a worker freed by one turn starts the next by itself', async (t) => {
  const x = line(t);
  assert.equal(x.run(1), true);
  assert.equal(x.run(2), false);
  await x.end(1);
  assert.deepEqual(x.started, ['2']);
});

test('the step a turn adds on its own worker keeps it until both are over', async (t) => {
  const x = line(t);
  x.run(1);
  x.run(1, 'switch');
  x.run(2);
  await x.end(1);
  assert.deepEqual([x.l.used(), x.started], [1, []], 'one step still runs');
  await x.end(1);
  assert.deepEqual(x.started, ['2']);
});

test('a turn re-attached on a worker its minion already holds counts as a step of it', async (t) => {
  const x = line(t);
  x.run(1);
  x.l.reattach(1, () => new Promise(() => {}));
  await x.end(1);
  assert.equal(x.l.used(), 1, 'the re-attached one still runs');
});

test("a running minion's resume held up by its save waits its turn in the line", (t) => {
  const x = line(t);
  x.run(1);
  assert.equal(x.l.enter(1, 'restart'), false);
  assert.deepEqual(x.waits(), [1]);
});

test("paused, a running minion's next turn waits too", (t) => {
  const x = line(t);
  x.run(1);
  x.l.setPause(true, 'cara');
  assert.equal(x.l.enter(1), false);
  assert.deepEqual(x.waits(), [1]);
});

test("a boot starts nothing until it opens, and then the saved line's first", async (t) => {
  const x = line(t);
  x.run(1);
  x.run(2);
  x.restart();
  assert.deepEqual(x.waits(), [2], 'the line is saved');
  x.l.close();
  assert.equal(x.l.enter(2), false, 'a free worker is for a turn still to be re-attached');
  await x.turn();
  assert.deepEqual(x.started, []);
  x.l.open(0);
  await x.turn();
  assert.deepEqual(x.started, ['2']);
});

test('a minion whose lane is busy takes no second worker, and the line passes it by', async (t) => {
  const x = line(t, 2);
  x.busy.add(1);
  assert.equal(x.run(1), false);
  assert.equal(x.run(2), true);
  x.run(3);
  x.run(4);
  await x.turn();
  assert.deepEqual([x.started.includes('1'), x.l.waiting().includes(1)], [false, true]);
  x.busy.delete(1);
  x.l.pump();
  await x.end(2);
  assert.equal(x.started.includes('1'), true, 'it starts once its lane is idle');
});

test("a resume's place: the queue's turn never goes before it, it is remembered, and taking back the last message keeps it", async (t) => {
  const x = line(t);
  x.run(1);
  x.run(2);
  x.l.join(2, 'restart');
  assert.equal(x.entry(2)?.via, 'restart', 'it came while the plain turn waited');
  assert.equal(x.l.leave(2, true), false);
  assert.deepEqual(x.waits(), [2]);
  x.l.close();
  await x.end(1);
  x.l.open(1_000_000);
  assert.equal(x.l.enter(2), false, 'a worker is free, and it is the resume that takes it');
  x.l.pump();
  t.mock.timers.tick(1_000_000);
  assert.deepEqual(x.started, ['2 restart']);
});

test('a step that throws as it starts gives its worker back', (t) => {
  const x = line(t);
  assert.equal(x.l.enter(1), true);
  assert.throws(
    () =>
      x.l.hold(1, () => {
        throw new Error('no place to run');
      }),
    /no place/,
  );
  assert.equal(x.l.used(), 0);
});

test('a start that throws leaves the line going', async (t) => {
  const x = line(t);
  x.run(1);
  x.run(2);
  x.run(3);
  x.failNext();
  t.mock.method(console, 'error', () => {});
  await x.end(1);
  await x.turn();
  assert.deepEqual(x.started, ['2', '3']);
});

test('a turn that was still launching when the stop came is stopped at the next tick', (t) => {
  const x = line(t);
  x.l.setPause('stop', 'cara');
  x.l.reattach(1, () => new Promise(() => {}));
  assert.deepEqual(x.stopped, []);
  x.l.tick(CALM);
  assert.deepEqual(x.stopped, [1]);
});

test('between people with equal shares, whoever waited longest goes first', () => {
  const w = (ticket: number, person: number, since: number) => ({ ticket, person, since, rank: 0 });
  assert.equal(pick([w(1, 1, 500), w(2, 2, 400)], new Map(), 1000)?.ticket, 2);
});

// Start now (#1957; Josh, 2026-11-25: "I can force create a new worker if there is a minion I want to actively work on").

test('started now, a waiting turn starts past a full pool at once; nobody else starts for it, and the line waits for a worker under the size', async (t) => {
  const x = line(t);
  x.run(1);
  x.run(2);
  x.run(3);
  x.press(3);
  assert.deepEqual([x.started, x.l.used(), x.waits(), x.stopped], [['3'], 2, [2], []]);
  await x.turn();
  assert.deepEqual(x.started, ['3']);
  await x.end(1);
  assert.deepEqual(x.started, ['3'], 'the forced turn counts as used');
  await x.end(3);
  assert.deepEqual(x.started, ['3', '2']);
});

test('started now, it does not wait out the gap between two starts', async (t) => {
  const x = line(t, 0);
  x.run(1);
  x.run(2);
  x.l.open(1_000_000);
  x.press(2);
  assert.deepEqual(x.started, ['2']);
});

test('while it is held, each later turn of it goes past the size; let go, the next waits and the running one goes on', async (t) => {
  const x = line(t);
  x.run(1);
  x.forced.add(2);
  assert.equal(x.run(2), true, 'a new message');
  await x.end(2);
  assert.equal(x.run(2, 'restart'), true, 'a resume');
  assert.equal(x.l.summary().forced, 1);
  x.forced.delete(2);
  assert.deepEqual([x.l.used(), x.stopped], [2, []]);
  await x.end(2);
  assert.equal(x.run(2), false);
  assert.deepEqual(x.waits(), [2]);
});

test('a pool shrunk below what runs still lets a forced turn start', (t) => {
  const x = line(t, 3);
  x.run(1);
  x.run(2);
  x.run(3);
  x.l.setSize(1, 'cara');
  x.run(4);
  x.press(4);
  assert.deepEqual([x.started, x.l.used()], [['4'], 4]);
});

test('paused, a forced turn waits with the reason, and starts by itself after', async (t) => {
  const x = line(t);
  x.run(1);
  x.run(2);
  x.run(3);
  x.l.setPause(true, 'Cara');
  x.press(3);
  assert.deepEqual([x.started, x.l.wait(3)?.held, x.waits()[0]], [[], 'Cara paused all minions', 3]);
  x.l.setPause(false, 'Cara');
  await x.turn();
  assert.deepEqual([x.started, x.waits()], [['3'], [2]]);
});

test('a boot holds a forced turn until the line opens, and starts it past the size then', async (t) => {
  const x = line(t);
  x.run(1);
  x.run(2);
  x.restart();
  x.l.close();
  x.l.reattach(1, () => new Promise(() => {}));
  x.press(2);
  assert.deepEqual([x.started, x.l.wait(2)?.held], [[], 'Citadel is restarting']);
  x.l.open(0);
  await x.turn();
  assert.deepEqual(x.started, ['2']);
});

test("at its container's memory limit a forced turn waits with the reason told to pages, others' don't, and it starts once there is room; alone, one may start", async (t) => {
  const x = line(t);
  // Auto's size: a person's number takes the containers' limits out of it.
  x.l.setSize(null, 'cara');
  for (const [id, person] of [
    [1, 5],
    [2, 5],
    [3, 6],
  ])
    x.persons.set(id, person);
  x.l.setLimits({ max: 4, min: 1 }, 'cara');
  x.run(1);
  x.forced.add(9);
  x.l.tick(CALM, [5]);
  x.l.join(2);
  x.changes.length = 0;
  x.l.tick(CALM, [5]);
  assert.ok(
    x.changes.some((ids) => ids.includes(2)),
    'its page hears why',
  );
  x.press(2);
  assert.deepEqual([x.started.includes('2'), x.l.wait(2)?.held], [false, 'the container it runs in is at its memory limit']);
  x.l.join(3);
  x.press(3);
  assert.ok(x.started.includes('3'), "another person's has room");
  x.l.tick(CALM, []);
  await x.turn();
  assert.ok(x.started.includes('2'));
});

test("with none of a full container's turns running, a forced one may start", (t) => {
  const x = line(t);
  x.l.setSize(null, 'cara');
  x.persons.set(4, 5);
  x.l.tick(CALM, [5]);
  x.l.setPause(true, 'cara');
  x.l.join(4);
  x.l.setPause(false, 'cara');
  x.press(4);
  assert.deepEqual(x.started, ['4'], 'none of theirs runs');
});

test("a forced minion's waiting resume goes before its queue's turn, and a busy lane's turn starts once it is idle", async (t) => {
  const x = line(t);
  x.run(1);
  x.run(2);
  x.l.join(2, 'restart');
  x.forced.add(2);
  assert.equal(x.l.enter(2), false, 'the resume takes the queue along');
  await x.turn();
  assert.deepEqual(x.started, ['2 restart']);
  x.busy.add(3);
  x.run(3);
  x.press(3);
  assert.deepEqual(x.started, ['2 restart']);
  x.busy.delete(3);
  x.l.pump();
  assert.deepEqual(x.started, ['2 restart', '3']);
});

test('two forced turns that waited out a pause both start, and nobody else', async (t) => {
  const x = line(t);
  x.run(1);
  for (const id of [2, 3, 4]) x.run(id);
  x.l.setPause(true, 'Cara');
  x.press(3);
  x.press(4);
  x.l.setPause(false, 'Cara');
  await x.turn();
  await x.turn();
  assert.deepEqual([x.started, x.waits()], [['3', '4'], [2]]);
});

test("let go mid-turn, a worker is its person's until that turn ends: presses in a row never make three of theirs", async (t) => {
  const x = line(t);
  x.run(1);
  for (const id of [2, 3, 4, 5]) x.run(id);
  x.press(2);
  x.press(3);
  assert.deepEqual(x.started, ['2', '3']);
  x.forced.delete(2);
  x.press(4);
  assert.deepEqual([x.started, x.l.wait(4)?.held], [['2', '3'], '2 turns Josh started now are still running']);
  x.pressers.set(5, 8);
  x.press(5);
  assert.deepEqual(x.started, ['2', '3', '5'], "another person's two are their own");
  await x.end(2);
  assert.deepEqual([x.started, x.waits()], [['2', '3', '5', '4'], []], 'it starts by itself');
});

// The quick lane (#1986; Josh, 2026-11-25: "ok, build the quick lane"): short turns of some kinds start beside a full pool.
const box = (level: 'ok' | 'easing' | 'tight') => ({ freeGb: null, level });
const MIN = 60_000;
/** A pool of one, taken by minion 1, and minions 2 and up whose turns may use the lane. */
function quickLine(t: TestContext, ids = [2, 3, 4, 5]) {
  const x = line(t);
  x.run(1);
  for (const id of ids) x.quick.add(id);
  return x;
}
const lane = (x: ReturnType<typeof line>) => [x.l.used(), x.l.summary().lane.used, x.l.summary().lane.size];

test('with the pool full, two quick turns start at once and the third waits; any other kind waits for the pool', async (t) => {
  const x = quickLine(t);
  assert.equal(x.run(9), false, 'not of its kinds');
  t.mock.timers.tick(1);
  assert.deepEqual([x.run(2), x.run(3), x.run(4)], [true, true, false]);
  assert.deepEqual([...lane(x), x.waits()], [1, 2, 2, [9, 4]]);
  await x.end(2);
  assert.deepEqual([x.started, x.waits()], [['4'], [9]], "the lane's freed worker goes to the next quick turn");
  await x.end(1);
  assert.deepEqual(x.started, ['4', '9'], "the pool's goes to the line");
});

test('a quick turn takes a free pool worker, and the lane stays empty', async (t) => {
  const x = quickLine(t);
  await x.end(1);
  assert.equal(x.run(2), true);
  assert.deepEqual(lane(x), [1, 0, 2]);
});

test('a turn waiting for the pool starts in the lane once it becomes of its kinds, its own place kept otherwise', async (t) => {
  const x = quickLine(t, []);
  x.run(2);
  assert.deepEqual(x.waits(), [2]);
  x.quick.add(2);
  assert.equal(x.run(2), true, 'a person wrote to it');
  x.run(3, 'restart');
  x.quick.add(3);
  x.run(3);
  await x.turn();
  assert.deepEqual([x.started, x.waits()], [['3 restart'], []], 'the resume goes, and takes its messages along');
});

test('two minutes on, a lane turn counts in the pool past its size, nothing is stopped, and the pool waits for room', async (t) => {
  const x = quickLine(t);
  x.run(9);
  x.run(2);
  const start = Date.now();
  x.l.tick(CALM, [], start + 2 * MIN - 1, box('ok'));
  assert.deepEqual(lane(x), [1, 1, 2]);
  x.l.tick(CALM, [], start + 2 * MIN, box('ok'));
  assert.deepEqual([...lane(x), x.l.summary().lane.moved, x.stopped], [2, 0, 2, 1, []]);
  assert.deepEqual([x.run(3), x.run(4)], [true, true], 'the lane has its worker back');
  await x.end(1);
  assert.deepEqual([x.started, x.l.used()], [[], 1], 'the moved turn fills the pool of one');
  await x.end(2);
  assert.deepEqual([x.started, x.l.summary().lane.moved], [['9'], 0]);
});

test('moved turns sit at most 2 over the pool, however many come: the next keeps its lane worker until there is room', async (t) => {
  const x = quickLine(t, [2, 3, 4, 5, 6]);
  const start = Date.now();
  const tick = (min: number) => x.l.tick(CALM, [], start + min * MIN, box('ok'));
  x.run(2);
  x.run(3);
  tick(2);
  assert.deepEqual([...lane(x), x.l.summary().lane.moved], [3, 0, 2, 2], 'a pool of 1 with 2 on top');
  assert.deepEqual([x.run(4), x.run(5), x.run(6)], [true, true, false]);
  tick(9);
  assert.deepEqual([...lane(x), x.l.summary().lane.moved], [3, 2, 2, 2], 'no room on top: they keep their lane workers');
  await x.end(1);
  tick(9);
  assert.deepEqual([...lane(x), x.l.summary().lane.moved], [3, 1, 2, 3], 'room for one');
  assert.deepEqual(x.stopped, []);
});

test('the lane has 2 workers in calm, 1 while memory eases and none while it is tight; its running turns go on', async (t) => {
  const x = quickLine(t);
  x.run(2);
  x.run(3);
  x.l.tick(CALM, [], Date.now(), box('tight'));
  assert.deepEqual([...lane(x), x.stopped], [1, 2, 0, []]);
  await x.end(2);
  assert.equal(x.run(4), false, 'tight: none starts');
  x.l.tick(CALM, [], Date.now(), box('easing'));
  await x.turn();
  assert.deepEqual([...lane(x), x.started], [1, 1, 1, []], 'one still runs, so the one worker is out');
  await x.end(3);
  assert.deepEqual([...lane(x), x.started], [1, 1, 1, ['4']]);
  assert.equal(x.run(5), false);
  x.l.tick(CALM, [], Date.now(), box('ok'));
  await x.turn();
  assert.deepEqual([...lane(x), x.started], [1, 2, 2, ['4', '5']]);
});

test("Urgent goes first in the lane and in the pool, and a lane turn counts in its person's share", async (t) => {
  const x = quickLine(t, [2, 3, 4, 5, 6]);
  x.run(2);
  x.run(3);
  x.run(4);
  x.run(5);
  x.run(9);
  x.run(8);
  x.urgent.set(5, 0);
  x.urgent.set(8, 1);
  x.quick.delete(8);
  await x.end(2);
  assert.deepEqual(x.started, ['5'], 'ahead of 4 in the lane');
  await x.end(1);
  assert.deepEqual(x.started, ['5', '8'], 'and 8 ahead of 4 and 9 in the pool');
  // Person 1 runs 8 in the pool and 3 and 5 in the lane; person 2 has none and goes first.
  x.persons.set(6, 2);
  x.run(6);
  assert.deepEqual(
    x.l.people().map((p) => [p.person, p.used, p.lane ?? 0, p.waiting]),
    [
      [1, 1, 2, 2],
      [2, 0, 0, 1],
    ],
  );
  await x.end(3);
  assert.deepEqual(x.started, ['5', '8', '6']);
});

test('a Pause, a boot still closed and a full container hold a lane start as any turn', async (t) => {
  const x = quickLine(t);
  x.l.setPause(true, 'cara');
  assert.equal(x.run(2), false);
  await x.turn();
  assert.deepEqual(x.started, []);
  x.l.setPause(false, 'cara');
  assert.deepEqual(x.started, ['2']);
  x.l.close();
  assert.equal(x.run(3), false);
  await x.turn();
  assert.deepEqual(x.started, ['2']);
  x.l.open(0);
  await x.turn();
  assert.deepEqual(x.started, ['2', '3']);
});

test("a person whose container is at its memory limit starts nothing in the lane, others' do", async (t) => {
  const x = quickLine(t);
  x.l.setSize(null, 'cara');
  x.l.setLimits({ min: 1, max: 1 }, 'cara');
  x.l.tick(CALM, [1]);
  x.persons.set(3, 6);
  assert.deepEqual([x.run(2), x.run(3)], [false, true]);
  await x.turn();
  assert.deepEqual(x.started, []);
  x.l.tick(CALM, []);
  await x.turn();
  assert.deepEqual(x.started, ['2']);
});

test('a lane turn that waits on an approval card comes back to the pool, and its lane worker is free meanwhile', async (t) => {
  const x = quickLine(t);
  x.run(2);
  x.l.setLent(2, true);
  assert.deepEqual([...lane(x), x.l.lent()], [1, 0, 2, 1]);
  x.l.setLent(2, false);
  assert.deepEqual(lane(x), [2, 0, 2]);
});

test("after a restart a lane turn comes back as the pool's, and an entry saved before the lane loads", async (t) => {
  const x = quickLine(t);
  x.run(2);
  x.run(9);
  x.restart();
  x.l.close();
  for (const id of [1, 2]) void x.l.reattach(id, () => new Promise(() => {}));
  x.quick.add(9);
  x.l.open(0);
  await x.turn();
  assert.deepEqual([...lane(x), x.started], [2, 1, 2, ['9']]);
});

test('a forced turn and a lane turn each have their own worker', async (t) => {
  const x = quickLine(t);
  x.run(2);
  x.run(9);
  x.press(9);
  assert.deepEqual([...lane(x), x.started, x.run(3), x.run(4)], [2, 1, 2, ['9'], true, false]);
});

test('a lane turn that could not start leaves its worker and the line going', async (t) => {
  const x = quickLine(t);
  x.run(2);
  x.run(3);
  x.run(4);
  x.run(5);
  x.failNext();
  await x.end(2);
  await x.turn();
  assert.deepEqual([x.started, x.l.summary().lane.used], [['4', '5'], 2]);
});

test('each start takes one lane worker, however many are waiting, and never past its size', async (t) => {
  const ids = Array.from({ length: 12 }, (_, i) => i + 2);
  const x = quickLine(t, ids);
  for (const id of ids) x.run(id);
  let most = 0;
  for (let i = 0; i < 12; i++) {
    x.l.tick(CALM, [], Date.now(), box('ok'));
    await x.turn();
    most = Math.max(most, x.l.summary().running);
    const on = x.l.laneTurns()[0];
    if (on) await x.end(on.ticket);
  }
  assert.equal(most, 3, 'one in the pool, two in the lane');
});
