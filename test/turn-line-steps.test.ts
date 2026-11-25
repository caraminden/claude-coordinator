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
  const persons = new Map<number, number>();
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
    asks: (id) => ({ person: persons.get(id) ?? 1, rank: 0 }),
    forced: (id) => forced.has(id),
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
    persons,
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
