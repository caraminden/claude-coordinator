import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changesLine, collapseRuns, planChanges } from '../public/plan-diff.js';

// A revised plan card shows what changed against the plan it replaces (#907).
const v1 = ['## What', '- one', '- two', '- three', '', '## Not doing', '- x'].join('\n');
const v2 = ['## What', '- one', '- TWO', '- three', '- four', '', '## Not doing', '- x'].join('\n');

test('counts changed, added and removed lines', () => {
  const c = planChanges(v1, v2, 'a', 'a');
  assert.deepEqual([c.changed, c.added, c.removed, c.summaryChanged], [1, 1, 0, false]);
  assert.equal(changesLine(c), '1 line changed, 1 added');
  const r = planChanges(v2, v1, 'a', 'b');
  assert.equal(changesLine(r), '1 line changed, 1 removed, summary changed');
});

test('identical plans report no changes', () => {
  assert.equal(changesLine(planChanges(v1, v1)), 'No changes to the text');
});

test('long unchanged stretches collapse, keeping a line beside each change', () => {
  const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');
  const runs = collapseRuns(planChanges(old, old.replace('a', 'A')).ops);
  assert.deepEqual(
    runs.map((r: any) => (r.gap ? `gap${r.gap.length}` : r.op + r.text)),
    ['-a', '+A', ' b', 'gap5'],
  );
});
