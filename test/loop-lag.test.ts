import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchLoopLag } from '../src/loop-lag.ts';

test('a stall of the event loop is logged with its length, and a free loop logs nothing', async () => {
  const logged: string[] = [];
  const timer = watchLoopLag((text) => logged.push(text), 10, 150);
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(logged, [], 'nothing held it');
    const until = performance.now() + 400;
    while (performance.now() < until); // synchronous work, as a git call on the event loop is
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(logged.length, 1);
    const held = Number(logged[0].match(/held for (\d+\.\d) s/)?.[1]);
    assert.ok(held >= 0.3, `it logs the stall's length: ${logged[0]}`); // longer on a busy box, never shorter
  } finally {
    clearInterval(timer);
  }
});
