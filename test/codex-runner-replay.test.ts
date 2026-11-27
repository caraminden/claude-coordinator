import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { codexThreadKey, HANDOVER_MAX, type CodexThread } from '../src/codex.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { testPins } from './helpers.ts';
testPins();

// #337 (dc12abc6): a minion's stored Codex log keeps only its newest 2 * HANDOVER_MAX characters, cut at a
// line, so the setting doesn't grow without end across many Codex turns. No turn is run: the keeper is called as the runner calls it.
const root = mkdtempSync(join(resolve(tmpdir()), 'codex-log-cap-'));
after(() => rmSync(root, { recursive: true, force: true }));
const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const runner = new Runner(
  store,
  () => {},
  () => ({}),
  '/bin/true',
);

test('appending a Codex turn past the log cap keeps only its newest lines, at most 2 * HANDOVER_MAX characters', () => {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Josh' });
  const line = (n: number) => `${JSON.stringify({ n, pad: 'x'.repeat(990) })}\n`;
  const old = Array.from({ length: Math.ceil((2 * HANDOVER_MAX) / 1000) }, (_, i) => line(i)).join('');
  store.setSetting(codexThreadKey(t.id), { thread: 'th1', log: old } as CodexThread);
  const dir = join(root, 'turn');
  mkdirSync(dir);
  writeFileSync(join(dir, 'codex-log.jsonl'), line(999999));
  (runner as any).keepCodexLog(t.id, readFileSync(join(dir, 'codex-log.jsonl'), 'utf8'));
  const kept = store.getSetting<CodexThread>(codexThreadKey(t.id))!;
  assert.ok(kept.log.length <= 2 * HANDOVER_MAX, `the log is ${kept.log.length} characters, over ${2 * HANDOVER_MAX}`);
  assert.ok(kept.log.endsWith(line(999999)), 'the newest turn is kept');
  assert.ok(!kept.log.startsWith(line(0)), 'the oldest lines went');
  assert.equal(
    kept.log
      .split('\n')
      .filter(Boolean)
      .every((l) => JSON.parse(l).pad),
    true,
    'cut at a line, no half line left',
  );
  assert.equal(kept.thread, 'th1');
});
