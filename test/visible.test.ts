// pollWhileVisible (#1394): polling rests while the tab is hidden, and one refresh runs at once when it is shown again.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { pollWhileVisible } from '../public/ui/visible.js';

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// Mocked clocks (no real sleeps, so a loaded box can't starve a tick): step 5 ms at a time and let promises settle between.
function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  return async (ms: number) => {
    for (let i = 0; i < ms; i += 5) {
      t.mock.timers.tick(5);
      await new Promise((r) => setImmediate(r));
    }
  };
}
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

test('polls while visible, rests while hidden, refreshes once at once when shown', async (t) => {
  const wait = clock(t);
  const doc = fakeDoc();
  let n = 0;
  const stop = pollWhileVisible(() => void n++, 20, { document: doc as never });
  await wait(70);
  assert.ok(n >= 2, `polled while visible (${n})`);
  doc.set(true);
  const hiddenAt = n;
  await wait(100);
  assert.equal(n, hiddenAt, 'nothing runs while hidden');
  doc.set(false);
  assert.equal(n, hiddenAt + 1, 'one refresh the moment it is shown');
  await wait(50);
  assert.ok(n >= hiddenAt + 2, 'and the interval carries on');
  stop();
  const after = n;
  await wait(60);
  assert.equal(n, after, 'stopped for good');
  assert.equal(doc.count(), 0, 'listener removed');
});

test('starting hidden waits for the first show; a slow run is not stacked; a throw does not stop it', async (t) => {
  const wait = clock(t);
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
  await wait(40);
  assert.equal(started, 0);
  doc.set(false);
  await wait(40);
  assert.equal(started, 1, 'the slow run is still going, so no second one starts');
  await wait(80);
  assert.ok(started >= 2, 'after the throw it polls again');
  stop();
});
