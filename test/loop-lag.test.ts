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
    assert.match(logged[0], /held for 0\.[34] s/);
  } finally {
    clearInterval(timer);
  }
});
