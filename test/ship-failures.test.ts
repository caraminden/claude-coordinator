import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import type { Release, TargetView } from '../src/releases.ts';
import { attachFailures, failureDetail, recordFailure } from '../src/ship-failures.ts';

// src/ship-failures.ts (#1375): a failed ship try's detail, kept per scheme and shown on its Releases card.
const root = mkdtempSync(join(tmpdir(), 'ship-failures-'));
after(() => rmSync(root, { recursive: true, force: true }));

const RUN = 'https://github.com/o/r/actions/runs/44860467586';
const TESTS_RED = [
  'land: CI passed on 789e8a32 in 270s (https://github.com/o/r/actions/runs/111)',
  'test\tthe full suite\t2026-11-21T03:24:46.36Z ✖ failing tests:',
  ...['one', 'two', 'three', 'four', 'five'].flatMap((n) => [
    `test\tthe full suite\t2026-11-21T03:24:46.36Z ✖ ${n} breaks (11850.822909ms)`,
    `test\tthe full suite\t2026-11-21T03:24:47.36Z ✖ ${n} breaks (11850.822909ms)`, // node lists each again in its summary
  ]),
  'test\tthe full suite\t2026-11-21T03:24:46.36Z run-tests: test/memory.test.ts: not rerun: CI\'s answer is due',
  `land: tests failed on the rebased branch in CI (${RUN}), so main is untouched`,
].join('\n');

test('a failed ship sums up as its kind, the first three names and "+N more", and the CI run it failed in', () => {
  assert.deepEqual(failureDetail(TESTS_RED, 1), { kind: 'tests failed', names: ['one breaks', 'two breaks', 'three breaks'], more: 2, ci: RUN });
  const conflict = 'land: rebasing onto main\nCONFLICT (content): Merge conflict in src/a.ts\nCONFLICT (content): Merge conflict in public/b.js\nland: the rebase onto main failed (see git\'s output above)';
  assert.deepEqual(failureDetail(conflict, 1), { kind: 'merge conflict', names: ['src/a.ts', 'public/b.js'], more: 0, ci: null });
  assert.equal(failureDetail('land: smoke: src/x.ts fails its test, before the line (12 s), so nothing landed', 1).kind, 'smoke check');
  assert.equal(failureDetail('land: waiting for CI on abc', 75).kind, 'CI timeout');
  assert.equal(failureDetail('land: main is now at abc "x"\ndeploy: boot check failed: /api/health never answered', 1).kind, 'deploy or boot');
  assert.deepEqual(failureDetail('land: broken test, not a flake: test/x.test.ts red in 4 of 10 runs in the last 6 h\nland: failed in the full run but passed alone (test/x.test.ts)\n✖ x breaks (3ms)', 1),
    { kind: 'broken test, not a flake', names: ['test/x.test.ts'], more: 0, ci: null }, '#1487');
  assert.deepEqual(failureDetail('something odd', 1), { kind: 'failed', names: [], more: 0, ci: null });
  // The smoke check names its test with no time; a green CI run before a failed deploy isn't the try's CI run.
  assert.deepEqual(failureDetail('land: smoke: ✖ test/prompt-budget.test.ts › budget\nland: smoke: tests failed (exit 1), before the line (21 s), so nothing landed', 1),
    { kind: 'smoke check', names: ['budget'], more: 0, ci: null });
  assert.equal(failureDetail('land: CI passed on abc in 90s (https://github.com/o/r/actions/runs/7)\ndeploy: boot check failed: unhealthy', 1).ci, null);
});

function world() {
  const store = new Store(join(root, `test-${Math.random().toString(36).slice(2)}.db`));
  const peek = store.createProject('Peek', null);
  const minion = (title: string) => store.createTicket({ project_id: peek.id, title, permission_mode: 'default', created_by: 'Cara' });
  const release = (o: Partial<Release>): Release => ({ version: 'abc1234', number: null, link: null, changes: [], started: null, live: null, outcome: 'live', stages: {}, ...o });
  const view = (o: Partial<Omit<TargetView, 'testCopies'>> = {}): Omit<TargetView, 'testCopies'> => ({
    target: { id: 'main', projectId: peek.id, name: 'Main', kind: 'main', link: null }, current: null, next: null, line: [], recent: [], ...o,
  });
  return { store, peek, minion, release, view };
}

test('a scheme\'s failed tries go in its main card\'s Previous releases, newest first among the rest, each saying what happened next', () => {
  const w = world();
  const fixing = w.minion('Fixing'), back = w.minion('Back in line'), idle = w.minion('Idle'), shippedOne = w.minion('Shipped'), twice = w.minion('Twice');
  w.store.updateTicket(fixing.id, { note: 'fixing the red test' });
  recordFailure(w.store, shippedOne.id, TESTS_RED, 1, 1_000);
  recordFailure(w.store, twice.id, 'something odd', 1, 1_500);
  recordFailure(w.store, fixing.id, TESTS_RED, 1, 2_000);
  recordFailure(w.store, back.id, 'CONFLICT (content): Merge conflict in a.ts', 1, 3_000);
  recordFailure(w.store, idle.id, 'something odd', 1, 4_000);
  recordFailure(w.store, twice.id, 'something odd', 1, 5_000);
  const live = w.release({ number: 7, live: 2_500, changes: [{ ticketId: shippedOne.id, number: shippedOne.number, title: 'Shipped' }] });
  const old = w.release({ number: 6, live: 500 });
  const tv = w.view({
    current: live, recent: [old],
    line: [{ name: `#${back.number}`, ticketId: back.id, holds: false, place: '2nd', seq: 1, movable: true, stage: 'line', since: 0 }],
  });
  const other = w.view({ target: { id: 'apk', projectId: w.peek.id, name: 'Android', kind: 'apk', link: null } });
  attachFailures([other, tv], { store: w.store, landing: (id) => id === back.id, running: (id) => id === fixing.id });

  assert.equal(other.recent.length, 0, 'only the scheme\'s main card lists them');
  // The newest five of six, merged by time with the live row; the sixth (the shipped one's) is past the five.
  assert.deepEqual(tv.recent.map((r) => r.outcome === 'failed' ? `failed #${r.changes[0].number}` : `live ${r.number}`),
    [`failed #${twice.number}`, `failed #${idle.number}`, `failed #${back.number}`, `failed #${fixing.number}`, `failed #${twice.number}`, `live 6`]);
  const next = tv.recent.map((r) => r.failure?.next);
  assert.deepEqual(next[0], { kind: 'idle', note: null });
  assert.deepEqual(next[1], { kind: 'idle', note: null }, 'nothing yet');
  assert.deepEqual(next[2], { kind: 'line', place: '2nd', holds: false });
  assert.deepEqual(next[3], { kind: 'fixing', note: 'fixing the red test' });
  assert.deepEqual(next[4], { kind: 'again', at: 5_000 });
  assert.equal(tv.recent[2].failure?.kind, 'merge conflict');
  assert.deepEqual(tv.recent[2].failure?.names, ['a.ts']);
  // Only the one back in line gets its last try on its line row.
  assert.deepEqual(tv.line[0].lastTry, { at: 3_000, kind: 'merge conflict', names: ['a.ts'], more: 0, ci: null });
});

test('a try that later went live says so, and a ship back in line after going live shows no old failure', () => {
  const w = world();
  const t = w.minion('Went live');
  recordFailure(w.store, t.id, TESTS_RED, 1, 1_000);
  const tv = w.view({
    current: w.release({ number: 3, live: 2_000, changes: [{ ticketId: t.id, number: t.number, title: 'Went live' }] }),
    line: [{ name: `#${t.number}`, ticketId: t.id, holds: true, place: '1st', seq: 1, movable: false, stage: 'land', since: 0 }],
  });
  attachFailures([tv], { store: w.store, landing: () => true, running: () => false });
  assert.deepEqual(tv.recent[0].failure?.next, { kind: 'shipped', release: 'Release 3' });
  assert.equal(tv.line[0].lastTry, undefined);
});

test('a scheme with no saved failures is left as it was', () => {
  const w = world();
  const tv = w.view({ recent: [w.release({ outcome: 'failed', number: null })] });
  const before = JSON.stringify(tv);
  attachFailures([tv], { store: w.store, landing: () => false, running: () => false });
  assert.equal(JSON.stringify(tv), before);
});

test('old rows keep their order, and on a full history a try older than all of it is left off', () => {
  const w = world();
  const t = w.minion('Old'), u = w.minion('New');
  recordFailure(w.store, t.id, 'something odd', 1, 1_000);
  recordFailure(w.store, u.id, 'something odd', 1, 9_000);
  const untimed = [w.release({ number: 2, outcome: 'failed' }), w.release({ number: 1 })];
  const tv = w.view({ recent: [...untimed] });
  attachFailures([tv], { store: w.store, landing: () => false, running: () => false });
  assert.deepEqual(tv.recent.map((r) => r.number ?? `#${r.changes[0].number}`), [`#${u.number}`, `#${t.number}`, 2, 1], 'no times: tries first, old rows as they were');

  const full = Array.from({ length: 10 }, (_, i) => w.release({ number: 20 - i, live: 8_000 - i * 100 }));
  const tv2 = w.view({ recent: full, line: [{ name: `#${t.number}`, ticketId: t.id, holds: false, place: '2nd', seq: 1, movable: true, stage: 'line', since: 0 }] });
  attachFailures([tv2], { store: w.store, landing: () => true, running: () => false });
  assert.deepEqual(tv2.recent.filter((r) => r.failure).map((r) => r.changes[0].number), [u.number], 'the try at 1000 is older than the oldest of ten');
  assert.equal(tv2.recent[0].changes[0]?.number, u.number);
  assert.equal(tv2.line[0].lastTry, undefined);
});
