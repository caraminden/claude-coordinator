// What the Releases page's Citadel server card says about quick trains (#2245, src/quick-view.ts).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ESCALATE_MS, type FastState } from '../src/fast-mode.ts';
import { quickInfo, readQuick } from '../src/quick-view.ts';
import { tempRoot } from './helpers.ts';

const root = tempRoot('quick-view');
after(() => root.teardown());
const sha = (c: string) => c.repeat(40);

test('off with nothing behind (no files): quick trains read off, nothing live, no red; the flag file turns them on', async () => {
  assert.deepEqual(await readQuick(root.dir, undefined), { on: false, behind: [], pinning: null, reds: [] });
  writeFileSync(join(root.dir, 'quick-train-on'), '');
  assert.equal((await readQuick(root.dir, undefined)).on, true);
});

test('on: each quick train shipped reads live with its ships until the full tests give a verdict, newest first; the one the full run is on says so', () => {
  const text = [`1000 ${sha('a')} ${sha('b')} ${sha('c')}:12 ${sha('b')}:13`, `2000 ${sha('b')} ${sha('d')} ${sha('d')}:-`, `3000 ${sha('d')} ${sha('e')} ${sha('e')}:20`, 'junk line', ''].join('\n');
  const fast: FastState = { reds: [], landed: {}, done: [sha('e')], running: { sha: sha('b'), at: 5 } };
  const v = quickInfo(true, text, fast);
  assert.equal(v.on, true);
  assert.deepEqual(v.behind, [
    { at: 2_000_000, top: sha('d'), ships: [], running: false },
    { at: 1_000_000, top: sha('b'), ships: [12, 13], running: true },
  ]);
});

test('a red: a top marked red or being pinned is no longer "running behind"; the pin names its files and ships, a red its ship and when the Taskmaster hears', () => {
  const text = [`1000 ${sha('a')} ${sha('b')} ${sha('b')}:12 red=test/x.test.ts`, `2000 ${sha('b')} ${sha('c')} ${sha('c')}:14`].join('\n');
  const pinned: FastState = { reds: [], landed: {}, pin: { head: sha('c'), shas: [sha('b'), sha('c')], next: 0, ids: ['test/y.test.ts'], at: 7, quick: { base: sha('b'), owners: { [sha('c')]: 14 } } } };
  const p = quickInfo(true, text, pinned);
  assert.deepEqual(p.behind, []);
  assert.deepEqual(p.pinning, { ids: ['test/y.test.ts'], ships: [14], at: 7 });
  const red: FastState = { reds: [{ ids: ['test/y.test.ts'], sha: sha('c'), ticket: 99, n: 14, at: 100 }], landed: {}, done: [sha('c')] };
  const r = quickInfo(true, text, red);
  assert.deepEqual(r.behind, []);
  assert.equal(r.pinning, null);
  assert.deepEqual(r.reds, [{ ids: ['test/y.test.ts'], n: 14, at: 100, escalateAt: 100 + ESCALATE_MS, escalated: false }]);
});
