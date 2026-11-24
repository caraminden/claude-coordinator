// What the runner tells the artifact scan and branch check (#1542): tool results ask for a throttled look,
// a reply that links a file asks for one at once, so the file shows as the reply lands.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'files-may-change-'));
after(() => rmSync(root, { recursive: true, force: true }));
const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const runner = new Runner(
  store,
  () => {},
  () => ({}),
  '/bin/false',
);

test('a tool result asks for a throttled look, a linking reply for one at once, a plain reply for none', () => {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const calls: [number, boolean][] = [];
  runner.onFilesMayChange = (id, soon) => void calls.push([id, soon]);
  const feed = (l: object) => (runner as any).handleLine(t.id, JSON.stringify(l), () => {});
  feed({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Working on it.' },
        { type: 'tool_use', id: 'u1', name: 'Bash', input: {} },
      ],
    },
  });
  feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] } });
  feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here: [the report](/w/report.md)' }] } });
  assert.deepEqual(calls, [
    [t.id, false],
    [t.id, true],
  ]);
});
