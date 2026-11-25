// The shared read behind the Properties page (public/shared-read.js): a change drops it, even with a read in flight (WP2, #1858).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedRead } from '../public/shared-read.js';

const counter = () => {
  let n = 0;
  return { calls: () => n, fetcher: async () => ++n };
};

test('reads in the window share one fetch', async () => {
  const c = counter();
  const r = sharedRead(c.fetcher);
  assert.deepEqual(await Promise.all([r.read(2), r.read(2)]), [1, 1]);
  assert.equal(await r.read(2), 1);
  assert.equal(c.calls(), 1);
});

test('after forget the next read is a new fetch, even with the first still in flight', async () => {
  const c = counter();
  const r = sharedRead(c.fetcher);
  const first = r.read(2);
  r.forget();
  assert.equal(await r.read(2), 2);
  assert.equal(await first, 1);
});

test('another key, or an answer older than the window, reads again', async () => {
  const c = counter();
  const r = sharedRead(c.fetcher, -1);
  await r.read(2);
  await r.read(2);
  assert.equal(c.calls(), 2);
  await sharedRead(c.fetcher).read(3);
  assert.equal(c.calls(), 3);
});
