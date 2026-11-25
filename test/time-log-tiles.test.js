// The ribbon's arithmetic (public/time-log.js, #1991).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grow, rowKey, tiles } from '../public/time-log.js';

const MIN = 60_000;
/** Stretches end to end from [kind, minutes, extra] triples. */
const run = (...of) => {
  let at = 0;
  return of.map(([kind, min, extra]) => ({ kind, start: at, end: (at += min * MIN), row: 0, ...extra }));
};

test('short stretches join their neighbours, in order, with no time lost', () => {
  const segs = run(...Array.from({ length: 500 }, (_, i) => [i % 5 ? 'work' : 'wait', 1]));
  const out = tiles(segs, 40);
  assert.ok(out.length <= 41 && out.length > 20, `${out.length} tiles`);
  assert.equal(out[0].start, 0);
  assert.equal(out.at(-1).end, 500 * MIN);
  out.slice(1).forEach((t, i) => assert.equal(t.start, out[i].end));
  assert.equal(out[0].kind, 'work', 'the kind most of it is');
});

test('lost time keeps a tile of its own, however short', () => {
  const out = tiles(run(['work', 300], ['lost', 0.2], ['work', 300]), 3);
  assert.deepEqual(
    out.map((t) => t.kind),
    ['work', 'lost', 'work'],
  );
});

test('a wait longer than everything else together is squeezed; work never is', () => {
  const [work, wait] = tiles(run(['work', 45], ['wait', 1750, { guess: true }]), 60);
  assert.ok(wait.squeezed && wait.flex < work.flex && wait.guess);
  const [only] = tiles(run(['work', 1750], ['wait', 45]), 60);
  assert.ok(!only.squeezed);
  assert.deepEqual(tiles([], 60), []);
});

test('a log grows in its last stretch: its row, its kind and its guess, and a dismissed one stays', () => {
  const log = {
    end: 10 * MIN,
    segs: run(['work', 6], ['wait', 4, { row: 1, guess: true }]),
    rows: [
      { type: 'line', start: 0, end: 6 * MIN, work: 6 * MIN, wait: 0, lost: 0 },
      { type: 'wait', start: 6 * MIN, end: 10 * MIN, work: 0, wait: 4 * MIN, lost: 0 },
    ],
    totals: { work: 6 * MIN, wait: 4 * MIN, lost: 0, guess: 4 * MIN },
  };
  const g = grow(log, MIN);
  assert.equal(g.end, 11 * MIN);
  assert.equal(g.segs[1].end, 11 * MIN);
  assert.deepEqual([g.rows[0].work, g.rows[1].wait, g.rows[1].end], [6 * MIN, 5 * MIN, 11 * MIN]);
  assert.deepEqual(g.totals, { work: 6 * MIN, wait: 5 * MIN, lost: 0, guess: 5 * MIN });
  assert.equal(grow({ ...log, closed: true }, MIN).end, 10 * MIN);
  assert.equal(log.segs[1].end, 10 * MIN, 'the log it grew from is left as it was');
  assert.equal(rowKey(g.rows[1]), `wait:${6 * MIN}`);
  assert.equal(rowKey({ type: 'step' }), null);
});
