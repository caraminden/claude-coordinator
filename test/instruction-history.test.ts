import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { lineDiff } from '../src/instructions.ts';

const root = mkdtempSync(join(tmpdir(), 'instruction-history-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('every instructions save keeps a history row of who changed them from what', () => {
  const store = new Store(join(root, 'test.db'));
  const p = store.createProject('P', null);
  const other = store.createProject('Q', null);
  store.setProjectInstructions(p.id, 'one', 'Cara');
  store.setProjectInstructions(other.id, 'elsewhere', 'Josh');
  store.setProjectInstructions(p.id, 'one\ntwo', 'Taskmaster');
  const rows = store.instructionHistory(p.id, 5);
  assert.deepEqual(
    rows.map((r) => [r.by, r.old_text, r.new_text]),
    [
      ['Taskmaster', 'one', 'one\ntwo'],
      ['Cara', '', 'one'],
    ],
  );
  assert.equal(rows[0].at, store.getProject(p.id)!.instructions_updated_at);
  assert.equal(store.instructionHistory(p.id, 1).length, 1);
});

test('lineDiff lists removed and added lines, with … for unchanged runs between them', () => {
  assert.deepEqual(lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne'), [
    { op: '-', text: 'b' },
    { op: '+', text: 'B' },
    { op: '…', text: '' },
    { op: '+', text: 'e' },
  ]);
  assert.deepEqual(lineDiff('', 'x'), [{ op: '+', text: 'x' }]);
  assert.deepEqual(lineDiff('x', ''), [{ op: '-', text: 'x' }]);
  assert.deepEqual(lineDiff('same\ntext', 'same\ntext'), []);
  const big = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(lineDiff(big, big + '\nmore').length, 3001, 'past the size cap it shows a whole replace rather than build a huge table');
});
