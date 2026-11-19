import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { flakeBrief, parseFlakes } from '../src/flakes.ts';

// Flake events (#1063): land output to rows, the count query behind the Test health tab, and the fix-it brief.
const root = mkdtempSync(join(tmpdir(), 'flakes-'));
after(() => rmSync(root, { recursive: true, force: true }));
const store = new Store(join(root, 'coordinator.db'));
const DAY = 86_400_000;

test('land output names each flake once, from land.sh lines and run-tests lines, with the failing lines as detail', () => {
  const out = [
    '✖ test/apps.test.ts › lists apps (31ms)',
    'land: flake: test/apps.test.ts · in CI',
    'run-tests: test/apps.test.ts: failed in the full run, passed alone: likely load (1-minute load 9.1)',
    'run-tests: test/machines.test.ts: failed in the full run, passed alone: likely load (1-minute load 9.1)',
    'run-tests: test/x.test.ts: failed again alone: a real failure',
    'land: flake: ../etc/passwd · in CI',
  ].join('\n');
  const found = parseFlakes(out);
  assert.deepEqual(found.map((f) => f.file), ['test/apps.test.ts', 'test/machines.test.ts']);
  assert.equal(found[0].source, 'in CI');
  assert.match(found[0].detail, /lists apps/);
  assert.equal(found[1].source, 'run-tests');
});

test('counts are per scheme, within the window, flakiest first, with the last land that saw each', () => {
  const now = Date.now();
  store.addFlakeEvents(1, 7, 'abc', now - 20 * DAY, [{ file: 'test/old.test.ts', source: 'smoke', detail: '' }]);
  store.addFlakeEvents(1, 7, 'abc', now - 3 * DAY, [{ file: 'test/a.test.ts', source: 'in CI', detail: 'one' }]);
  store.addFlakeEvents(1, 8, 'def', now - 2 * DAY, [{ file: 'test/a.test.ts', source: 'in CI', detail: 'two' }, { file: 'test/b.test.ts', source: 'smoke', detail: '' }]);
  store.addFlakeEvents(1, null, 'fed', now - DAY, [{ file: 'test/a.test.ts', source: 'run-tests', detail: 'three' }]);
  store.addFlakeEvents(2, 9, 'zzz', now - DAY, [{ file: 'test/other.test.ts', source: 'smoke', detail: '' }]);
  const rows = store.flakeCounts(1, now - 14 * DAY);
  assert.deepEqual(rows.map((r) => [r.file, r.count]), [['test/a.test.ts', 3], ['test/b.test.ts', 1]]);
  assert.equal(rows[0].ticketId, null, 'the newest sighting was a fast-mode run, which has no minion');
  assert.equal(rows[1].ticketId, 8);
  assert.deepEqual(store.flakeDetails(1, 'test/a.test.ts', 2).map((d) => d.detail), ['three', 'two']);
});

test('the brief names the file, the count, the skill and the failing outputs', () => {
  const b = flakeBrief('test/a.test.ts', 3, [{ at: Date.now(), detail: '✖ test/a.test.ts › boom' }]);
  assert.equal(b.title, 'Flaky test: test/a.test.ts');
  assert.match(b.message, /3 times/);
  assert.match(b.message, /citadel:diagnosing-bugs/);
  assert.match(b.message, /boom/);
});
