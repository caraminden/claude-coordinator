import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { greenShas, LastGreen, type Contains, type GreenRun } from '../src/last-green.ts';

// src/last-green.ts (#1016): a scheme's last green is its newest commit on main whose newest run of every workflow
// passed; it only moves forward, and a rolled-back target's pin lets go once main has a newer green commit.
const root = mkdtempSync(join(tmpdir(), 'last-green-'));
after(() => rmSync(root, { recursive: true, force: true }));
let dbs = 0;

let minute = 0;
const run = (sha: string, conclusion: string | null, workflow = 1, file = 'tests.yml', status = conclusion ? 'completed' : 'in_progress'): GreenRun => ({
  head_sha: sha,
  workflow_id: workflow,
  file,
  status,
  conclusion,
  created_at: new Date(Date.UTC(2026, 10, 18, 0, ++minute)).toISOString(),
});

test("a commit is green when every workflow's newest run on it passed, and a rerun replaces the first verdict", () => {
  const runs = [
    run('a', 'success'),
    run('b', 'success'),
    run('b', 'failure', 2, 'lint.yml'),
    run('c', 'failure'),
    run('c', 'success'), // rerun passed
    run('d', 'success'),
    run('d', null, 2, 'lint.yml'), // one still running
    run('e', 'skipped'), // nothing actually passed
  ];
  assert.deepEqual(greenShas(runs), ['c', 'a']);
  // A quiet workflow doesn't count: b's red lint run is left out.
  assert.deepEqual(greenShas(runs, new Set(['lint.yml'])), ['d', 'c', 'b', 'a']);
});

/** A straight history: each commit holds every one before it; 'x' is a commit main doesn't hold. */
function history(order: string[]): Contains {
  return async (_dir, ancestor, commit) => {
    const c = commit === 'main' ? order.length - 1 : order.indexOf(commit);
    const a = order.indexOf(ancestor);
    return c < 0 || a < 0 ? ancestor === commit : a <= c;
  };
}

test('last green moves forward only, and never to a commit main lacks', async () => {
  const store = new Store(join(root, `t-${++dbs}.db`));
  const order = ['a', 'b', 'c', 'd'];
  const g = new LastGreen(store, history(order), () => 5);
  assert.equal(g.get(2), null);
  assert.equal((await g.note(2, '/repo', 'main', [run('b', 'success')]))?.sha, 'b');
  // A late run on an older commit doesn't move it back.
  assert.equal((await g.note(2, '/repo', 'main', [run('a', 'success')]))?.sha, 'b');
  // A green commit main doesn't hold (a PR head) is passed over for the newest one it does.
  assert.equal((await g.note(2, '/repo', 'main', [run('c', 'success'), run('x', 'success')]))?.sha, 'c');
  // Red on the newest: last green stays.
  assert.equal((await g.note(2, '/repo', 'main', [run('d', 'failure')]))?.sha, 'c');
  assert.equal(g.get(3), null, 'per scheme');
});

test('a pin holds until main has a green commit newer than the one rolled back from', async () => {
  const store = new Store(join(root, `t-${++dbs}.db`));
  const order = ['a', 'b', 'c', 'd'];
  const g = new LastGreen(store, history(order));
  await g.note(2, '/repo', 'main', [run('a', 'success')]);
  g.pin(2, 'app:peek', { sha: 'a', from: 'b', by: 'Cara' });
  g.pin(7, 'app:other', { sha: 'a', from: 'b', by: 'Cara' });
  // The broken commit itself passing (a break no test notices) doesn't let go.
  await g.note(2, '/repo', 'main', [run('b', 'success')]);
  assert.equal(g.pinned(2, 'app:peek')?.sha, 'a');
  await g.note(2, '/repo', 'main', [run('c', 'success')]);
  assert.equal(g.pinned(2, 'app:peek'), null);
  assert.equal(g.pinned(7, 'app:other')?.from, 'b', "another scheme's pin stays");
  assert.equal(g.unpin(7, 'app:other'), true);
  assert.equal(g.unpin(7, 'app:other'), false);
});
