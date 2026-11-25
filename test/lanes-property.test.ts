// Property test for the minion lane (#1657, #259, #1464): the real Lanes through random promise orderings,
// with nested steps. fc.scheduler() decides the order every `await s.schedule(...)` resumes in; a failure prints
// the seed and the shrunk counterexample, and re-runs with FC_SEED=<seed>.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { Lanes } from '../src/lanes.ts';

/** The lanes under test: the real `src/lanes.ts`, or another copy of it (LANES_UNDER_TEST), to prove the test fails on a known bug. */
const { Lanes: Under } = process.env.LANES_UNDER_TEST ? ((await import(process.env.LANES_UNDER_TEST)) as { Lanes: typeof Lanes }) : { Lanes };

const seed = Number(process.env.FC_SEED ?? 20261122);
const params = { seed, numRuns: 200, endOnFailure: false };

type Step = { key: number; nest: number[]; hops: number };

/** One step of a minion's lane: awaits `hops` scheduled promises, and runs its nested steps on the same lane at once (the outbox's send, #1464). */
const stepArb = fc.record({ key: fc.integer({ min: 0, max: 1 }), nest: fc.array(fc.integer({ min: 0, max: 1 }), { maxLength: 2 }), hops: fc.integer({ min: 0, max: 3 }) });

test('lane steps never overlap, the lane is never idle under a running step, every step runs, a dismissal awaits its own step (#259, #1464)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.array(stepArb, { minLength: 1, maxLength: 5 }), async (s, steps: Step[]) => {
      const lanes = new Under();
      const running = new Map<number, number>(); // key -> steps running now
      const ran: string[] = [];
      const expected: string[] = [];
      const idle: number[] = [];
      let violation = '';
      lanes.onIdle = (key: number) => {
        idle.push(key);
        if ((running.get(key) ?? 0) > 0) violation ||= `lane ${key} went idle under a running step`;
        if (lanes.busy(key)) violation ||= `lane ${key} idle but busy() is true`;
      };
      let sync = false; // inside the synchronous start of a step that began at once: the only time a step may start beside a running one
      const mk = (id: string, key: number, nest: number[], hops: number, depth: number) => async () => {
        const n = (running.get(key) ?? 0) + 1;
        running.set(key, n);
        if (n > 1 && !sync) violation ||= `two steps ran at once on lane ${key} (${id})`;
        ran.push(id);
        // A step started at once may run steps on its lane at once, as the outbox's send starts a turn (#1464): the outer step
        // then ends without waiting, and the lane must stay busy until the nested one ends.
        if (depth === 0 && nest.length) {
          const was = sync;
          sync = true;
          nest.forEach((k, i) => void lanes.run(k, `${id}.${i}`, mk(`${id}.${i}`, k, [], 1, 1)));
          sync = was;
        } else for (let i = 0; i < hops; i++) await s.schedule(Promise.resolve());
        running.set(key, (running.get(key) ?? 1) - 1);
      };
      const finished: Promise<void>[] = [];
      for (const [i, st] of steps.entries()) {
        expected.push(`s${i}`);
        for (let j = 0; j < st.nest.length; j++) expected.push(`s${i}.${j}`);
        // A dismissal's await (#1464): the caller awaits the step and then asks whether the lane is idle.
        // Each caller starts at a random point of the schedule, so callers interleave with running steps.
        finished.push(s.schedule(Promise.resolve()).then(() => lanes.run(st.key, `s${i}`, mk(`s${i}`, st.key, st.nest, st.hops, 0))));
      }
      await s.waitFor(Promise.all(finished));
      // Nested steps outlive their callers' awaits, and schedule more as they start: drain until both lanes are free (bounded).
      for (let i = 0; i < 50 && (lanes.busy(0) || lanes.busy(1)); i++) {
        await s.waitAll();
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(violation, '');
      assert.deepEqual([...ran].sort(), [...expected].sort(), 'every step ran, once');
      for (const k of [0, 1]) assert.equal(lanes.busy(k), false, `lane ${k} is free at the end`);
    }),
    params,
  );
});

test('a step awaited by its caller sees its lane free, or idle soon, never busy forever (the dismissal await, 1fc77f93f)', async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.integer({ min: 0, max: 3 }), async (s, hops) => {
      const lanes = new Under();
      let idled = 0;
      lanes.onIdle = () => idled++;
      const done = lanes.run(7, 'dismiss', async () => {
        for (let i = 0; i < hops; i++) await s.schedule(Promise.resolve());
      });
      let busyAfterAwait: boolean | undefined;
      void done.then(() => {
        busyAfterAwait = lanes.busy(7);
      });
      await s.waitFor(done);
      await s.waitAll();
      // The lane of a step with nothing nested is free by the time its caller's await resumes (the dismissal's cleanup relies on it).
      assert.equal(busyAfterAwait, false, 'busy right after the awaited step ended');
      assert.equal(idled, 1);
    }),
    params,
  );
});

test('a step that throws at once throws to its caller, and the lane goes idle and runs the next step', async () => {
  const lanes = new Under();
  let idled = 0;
  lanes.onIdle = () => idled++;
  assert.throws(
    () =>
      lanes.run(7, 'turn', () => {
        throw new Error('no place to run');
      }),
    /no place to run/,
  );
  assert.equal(lanes.busy(7), true, 'until its tail has run');
  let ran = 0;
  await lanes.run(7, 'turn', () => ran++);
  assert.deepEqual([ran, idled, lanes.busy(7)], [1, 1, false]);
});
