// pollWhileVisible (#1394): polling rests while the tab is hidden, and one refresh runs at once when it is shown again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollWhileVisible } from '../public/ui/visible.js';

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
function fakeDoc(hidden = false) {
  const fns = new Set<() => void>();
  return {
    hidden,
    addEventListener: (_: string, f: () => void) => fns.add(f),
    removeEventListener: (_: string, f: () => void) => fns.delete(f),
    set(h: boolean) {
      this.hidden = h;
      for (const f of [...fns]) f();
    },
    count: () => fns.size,
  };
}

test('polls while visible, rests while hidden, refreshes once at once when shown', async () => {
  const doc = fakeDoc();
  let n = 0;
  const stop = pollWhileVisible(() => void n++, 20, { document: doc as never });
  await sleep(70);
  assert.ok(n >= 2, `polled while visible (${n})`);
  doc.set(true);
  const hiddenAt = n;
  await sleep(100);
  assert.equal(n, hiddenAt, 'nothing runs while hidden');
  doc.set(false);
  assert.equal(n, hiddenAt + 1, 'one refresh the moment it is shown');
  await sleep(50);
  assert.ok(n >= hiddenAt + 2, 'and the interval carries on');
  stop();
  const after = n;
  await sleep(60);
  assert.equal(n, after, 'stopped for good');
  assert.equal(doc.count(), 0, 'listener removed');
});

test('starting hidden waits for the first show; a slow run is not stacked; a throw does not stop it', async () => {
  const doc = fakeDoc(true);
  let started = 0;
  const stop = pollWhileVisible(
    async () => {
      started++;
      await sleep(60);
      throw new Error('boom');
    },
    10,
    { document: doc as never },
  );
  await sleep(40);
  assert.equal(started, 0);
  doc.set(false);
  await sleep(40);
  assert.equal(started, 1, 'the slow run is still going, so no second one starts');
  await sleep(80);
  assert.ok(started >= 2, 'after the throw it polls again');
  stop();
});
