import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namedStacks, watchLoopLag } from '../src/loop-lag.ts';

const spin = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until); // synchronous work, as a git call on the event loop is
};
const waitFor = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));
};

test('a stall of the event loop is logged with its length, and a free loop logs nothing', async () => {
  const logged: string[] = [];
  const watch = watchLoopLag((text) => logged.push(text), 10, 150);
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(logged, [], 'nothing held it');
    spin(400);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(logged.length, 1);
    const held = Number(logged[0].match(/held for (\d+\.\d) s/)?.[1]);
    assert.ok(held >= 0.3, `it logs the stall's length: ${logged[0]}`); // longer on a busy box, never shorter
  } finally {
    watch.stop();
  }
});

test('with the sampler on, a stall names the code that held the loop (#609)', async () => {
  const logged: string[] = [];
  const watch = watchLoopLag((text) => logged.push(text), 10, 150, { profile: true });
  try {
    await new Promise((r) => setTimeout(r, 200)); // the sampler starts
    function holdTheLoopForTest() { spin(600); }
    holdTheLoopForTest();
    await waitFor(() => logged.length > 0);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /held for \d+\.\d s: .* Running: \d+% /);
    assert.match(logged[0], /holdTheLoopForTest \(test\/loop-lag\.test\.ts:\d+\)/, logged[0]);
  } finally {
    watch.stop();
  }
});

test('namedStacks counts only the window, leaf first then the repo\'s own callers outward', () => {
  const root = new URL('..', import.meta.url).href;
  const frame = (functionName: string, url = '', lineNumber = 0) => ({ functionName, url, lineNumber });
  const profile = {
    startTime: 1000,
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 5] },
      { id: 2, callFrame: frame('handler', `${root}src/routes/projects.ts`, 410), children: [3] },
      { id: 3, callFrame: frame('listTickets', `${root}src/db.ts`, 1200), children: [4] },
      { id: 4, callFrame: frame('all', 'node:sqlite') },
      { id: 5, callFrame: frame('(garbage collector)') },
    ],
    // at 1010, 1020, 1030, 1040, 1050: the first and last fall outside [1015, 1045]
    samples: [4, 4, 4, 5, 5],
    timeDeltas: [10, 10, 10, 10, 10],
  };
  assert.equal(namedStacks([profile], 1015, 1045), '67% all (node:sqlite) < listTickets (src/db.ts:1201) < handler (src/routes/projects.ts:411); 33% (garbage collector)');
  assert.equal(namedStacks([profile], 2000, 3000), '', 'no sample in the window');
  // A stall across the sampler's roll is read from both profiles, the roll's and the next.
  const next = { ...profile, startTime: 1050, samples: [4], timeDeltas: [5] };
  assert.equal(namedStacks([profile, next], 1015, 1060), '60% all (node:sqlite) < listTickets (src/db.ts:1201) < handler (src/routes/projects.ts:411); 40% (garbage collector)'); // 1020-1050 and 1055
});
