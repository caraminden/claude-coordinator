// ui/tip.js's pure parts: where a tip goes, and the per-revision cache. Ported from Theory of Crafting's
// app/web/tip.test.ts (ToC #55). The browser behaviour (hover, focus, tap, long press) is
// test/tip-browser.test.ts, in headless Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeTip, TipCache } from '../public/ui/tip.js';

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const vw = 1000;
const vh = 800;
function check(t, w, h) {
  const p = placeTip(t, w, h, vw, vh);
  const box = { left: p.left, top: p.top, right: p.left + w, bottom: p.top + Math.min(h, p.maxHeight) };
  assert.equal(overlaps(box, t), false, 'never covers the thing');
  assert.ok(box.left >= 8 && box.right <= vw - 8 && box.top >= 8 && box.bottom <= vh - 8, `inside the window: ${JSON.stringify(box)}`);
  return p;
}

test('placeTip: below the thing when it fits', () => {
  assert.deepEqual(check({ left: 100, top: 100, right: 200, bottom: 120 }, 300, 200), { left: 100, top: 126, maxHeight: 666 });
});

test('placeTip: flips above when there is no room below', () => {
  assert.equal(check({ left: 100, top: 700, right: 200, bottom: 720 }, 300, 200).top, 700 - 6 - 200);
});

test('placeTip: takes the roomier side and caps its height when it fits neither', () => {
  assert.deepEqual(check({ left: 100, top: 500, right: 200, bottom: 520 }, 300, 900), { left: 100, top: 8, maxHeight: 486 });
  assert.deepEqual(check({ left: 100, top: 200, right: 200, bottom: 220 }, 300, 900), { left: 100, top: 226, maxHeight: 566 });
});

test('placeTip: slides left to stay inside the window, and never past its left edge', () => {
  assert.equal(check({ left: 900, top: 100, right: 990, bottom: 120 }, 300, 100).left, 1000 - 300 - 8);
  assert.equal(check({ left: 0, top: 100, right: 20, bottom: 120 }, 300, 100).left, 8);
});

const counted = (value = 'a') => {
  const load = async () => (load.calls++, value);
  load.calls = 0;
  return load;
};

test('TipCache: loads once per key and revision, and again on a new revision', async () => {
  const cache = new TipCache();
  const load = counted();
  assert.equal(await cache.get('stat:Life', 3, load), 'a');
  assert.equal(await cache.get('stat:Life', 3, load), 'a');
  assert.equal(load.calls, 1);
  await cache.get('stat:Life', 4, load);
  await cache.get('stat:Mana', 4, load);
  assert.equal(load.calls, 3);
});

test('TipCache: forgets a failed load (thrown or rejected) so the next hover asks again', async () => {
  const cache = new TipCache();
  await assert.rejects(
    cache.get('k', 1, () => Promise.reject(new Error('busy'))),
    /busy/,
  );
  await assert.rejects(
    cache.get('j', 1, () => {
      throw new Error('broke');
    }),
    /broke/,
  );
  assert.equal(cache.size, 0);
  assert.equal(await cache.get('k', 1, async () => 'ok'), 'ok');
  // A plain value works as well as a promise.
  assert.equal(await cache.get('s', 1, () => 'sync'), 'sync');
});

test('TipCache: drops the least recently used past its size', async () => {
  const cache = new TipCache(2);
  const load = counted('x');
  await cache.get('a', 1, load);
  await cache.get('b', 1, load);
  await cache.get('a', 1, load); // a is now the newest
  await cache.get('c', 1, load); // b goes
  assert.equal(cache.size, 2);
  await cache.get('a', 1, load);
  assert.equal(load.calls, 3);
  await cache.get('b', 1, load);
  assert.equal(load.calls, 4);
});
