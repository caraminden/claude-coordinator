import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { FlakeFixes } from '../src/flake-fixes.ts';

// The same-flake alarm (#1245): one test passing alone on three different branches inside 30 minutes wakes the Taskmaster, once.
// The sightings are Nov 19's review-set-api burst, from the retro log (UTC: 04:16Z is 20:16 PST).
const root = mkdtempSync(join(tmpdir(), 'flake-alarm-'));
after(() => rmSync(root, { recursive: true, force: true }));
const F = 'test/review-set-api.test.ts';
const line = (t: string, branch: string) => `- ${t}Z · flake · ${F} · load 17.0 · ticket/${branch} · in CI`;
const BURST = [
  line('04:16:14', '1102-revised-plan'), line('04:18:31', '1102-revised-plan'),
  line('05:08:44', '1107-scorecard'), line('05:11:32', '1107-scorecard'),
  line('05:16:02', '1104-build-5'), line('05:18:21', '1104-build-5'),
  line('05:21:10', '1105-build-6'), line('05:25:56', '1107-scorecard'),
  line('05:30:50', '1061-models'), line('05:35:42', '1108-briefing'),
  line('05:46:06', '1113-claim-check'), line('05:55:58', '1174-unknown-tool'),
];

function setup(lines: string[]) {
  const changed = { at: null as number | null };
  const dir = mkdtempSync(join(root, 's-'));
  const store = new Store(join(dir, 'c.db'));
  const project = store.createProject('P', null);
  mkdirSync(join(dir, 'shared', 'retro-log', '2026-11-20'), { recursive: true });
  writeFileSync(join(dir, 'shared', 'retro-log', '2026-11-20', 'land.md'), `# Retro log\n\n${lines.join('\n')}\n`);
  const woke: string[] = [];
  const fixes = new FlakeFixes({
    store, sharedDir: () => join(dir, 'shared'), start: async () => ({ id: 1 }), runs: async () => [], jobs: async () => [],
    changedAt: async () => changed.at,
    suspect: async () => 'abc1234 #1094: the page at a glance',
    wake: (_p, text) => { woke.push(text); return true; },
  });
  return { fixes, project, woke, changed };
}
const at = (t: string) => Date.parse(`2026-11-20T${t}Z`);

test('replaying Nov 19: the alarm fires once, at the third branch, not on every red', async () => {
  const { fixes, project, woke } = setup(BURST);
  // The server's pass runs every 5 minutes, from the first sighting to 2 hours on.
  for (let t = at('04:20:00'); t <= at('07:00:00'); t += 5 * 60_000) await fixes.alarm(project, t);
  assert.equal(woke.length, 1);
  assert.match(woke[0], /review-set-api\.test\.ts/);
  assert.match(woke[0], /1107-scorecard/);
  assert.match(woke[0], /1104-build-5/);
  assert.match(woke[0], /1105-build-6/);
  assert.match(woke[0], /abc1234 #1094/, 'names the commit most likely to have brought it');
});

test('it fires at the pass after the third branch, and not before', async () => {
  const { fixes, project, woke } = setup(BURST);
  await fixes.alarm(project, at('05:20:00'));
  assert.equal(woke.length, 0, 'two branches in 30 minutes (1107, 1104) are not enough');
  await fixes.alarm(project, at('05:21:30'));
  assert.equal(woke.length, 1, '1105 is the third branch');
});

test('three reds on one branch, or three branches over more than 30 minutes, ring nothing', async () => {
  const one = setup([line('05:00:00', '1-a'), line('05:05:00', '1-a'), line('05:10:00', '1-a')]);
  await one.fixes.alarm(one.project, at('06:00:00'));
  const slow = setup([line('04:00:00', '1-a'), line('04:40:00', '2-b'), line('05:20:00', '3-c')]);
  await slow.fixes.alarm(slow.project, at('06:00:00'));
  assert.equal(one.woke.length + slow.woke.length, 0);
});

test('one alarm per test until a day passes or the file changes on main', async () => {
  const quiet = setup([...BURST, line('09:00:00', '2001-a'), line('09:05:00', '2002-b'), line('09:10:00', '2003-c')]);
  await quiet.fixes.alarm(quiet.project, at('05:30:00'));
  await quiet.fixes.alarm(quiet.project, at('09:11:00'));
  assert.equal(quiet.woke.length, 1, 'a second burst the same day, no fix shipped: still quiet');
  quiet.changed.at = at('08:00:00'); // a fix shipped
  await quiet.fixes.alarm(quiet.project, at('09:11:00'));
  assert.equal(quiet.woke.length, 2, 'the fix shipped and it went red on 3 new branches: rings again');
  const day = setup(BURST);
  await day.fixes.alarm(day.project, at('06:00:00'));
  await day.fixes.alarm(day.project, at('06:00:00') + 25 * 3_600_000);
  assert.equal(day.woke.length, 1, 'a day later, with no new sightings, nothing new to say');
});

test("#1487: a broken-test line moves its open fix minion's ship to the front for 6 h; no fix, no move", async () => {
  const dir = mkdtempSync(join(root, 'b-'));
  const store = new Store(join(dir, 'c.db'));
  const project = store.createProject('P', null);
  const fix = store.createTicket({ project_id: project.id, title: 'Fix the flaky test/review-set-api.test.ts', permission_mode: 'default', created_by: 'x' });
  store.addFlakeFix(project.id, F, fix.id, at('04:00:00'));
  mkdirSync(join(dir, 'shared', 'retro-log', '2026-11-20'), { recursive: true });
  writeFileSync(join(dir, 'shared', 'retro-log', '2026-11-20', 'land.md'), [
    `- 05:48:23Z · broken test · ${F} · red in 15 of 43 runs in the last 6 h · ticket/1061-models`,
    '- 05:50:00Z · broken test · test/nobody.test.ts · red in 3 of 9 runs in the last 6 h · ticket/1061-models',
  ].join('\n') + '\n');
  const moved: [number, string][] = [];
  const fixes = new FlakeFixes({ store, sharedDir: () => join(dir, 'shared'), start: async () => ({ id: 1 }), runs: async () => [], jobs: async () => [], front: (_p, id, why) => (moved.push([id, why]), true) });
  assert.equal(await fixes.broken(project, at('06:00:00')), 1);
  assert.deepEqual(moved, [[fix.id, `it fixes ${F}, a broken test, not a flake: red in 15 of 43 runs in the last 6 h`]]);
  assert.equal(await fixes.broken(project, at('11:49:00')), 0, 'past 6 h the line no longer moves it');
});
