// The board's asks as lines (#2289, public/cabal.js): an ask is stored as one line, so its forks and recommendations
// are read from its "1) … 2) …" and "Recommended:" words, and anything else stays as it was written.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askParts } from '../public/cabal.js';

test("an ask's numbered forks come apart, each with its recommendation (Plot 11's ask 17)", () => {
  const p = askParts("P5 #2284 has two forks its handoff leaves open. 1) Perigee route: no runner. Recommended: a podman container. 2) 80% guard: needs the `user` scope. Recommended: fail closed now. I'm building the rest meanwhile.");
  assert.deepEqual(p.intro, { text: 'P5 #2284 has two forks its handoff leaves open.', rec: '' });
  assert.deepEqual(p.forks, [
    { text: 'Perigee route: no runner.', rec: 'a podman container.' },
    { text: '80% guard: needs the `user` scope.', rec: "fail closed now. I'm building the rest meanwhile." },
  ]);
});

test('an ask with no numbered forks stays whole, a lone recommendation still called out', () => {
  assert.deepEqual(askParts('Please move src/a.ts to me (1) a claim). Recommended: move it.'), { intro: { text: 'Please move src/a.ts to me (1) a claim).', rec: 'move it.' }, forks: [] });
  assert.deepEqual(askParts('P3 2) wants src/b.ts 1) now'), { intro: { text: 'P3 2) wants src/b.ts 1) now', rec: '' }, forks: [] }, 'one fork, or numbers out of order, is not a list');
  assert.deepEqual(askParts('Which helper?'), { intro: { text: 'Which helper?', rec: '' }, forks: [] });
});
