import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { agentToken, bootServer, until } from './helpers.ts';

// The scheme spinner counts only turns doing work, not one held open on an approval card (#373;
// Cara, 2026-11-07: "it should only count actually working minions"). isWorking's own cases: schemecounts.test.ts.
const root = mkdtempSync(join(tmpdir(), 'scheme-spinner-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { existsSync } = require('node:fs');
process.stdin.resume();
const t = setInterval(() => {
  if (!existsSync(${JSON.stringify(join(root, 'release'))})) return;
  clearInterval(t);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

test('api/projects: a turn waiting on an approval card is not working until someone answers it', async () => {
  const srv = await bootServer({ env: { CLAUDE_BIN: fake, NODE_NO_WARNINGS: '1' } });
  try {
    const project = (await srv.call('/api/projects', { name: 'Delve' })).data;
    assert.equal((await srv.call(`/api/projects/${project.id}`, { approval_rules: 'Bash(echo:*)' }, 'PATCH')).status, 200);
    const t = (await srv.call(`/api/projects/${project.id}/tickets`, { message: 'build it', title: 'Build it' })).data;
    const pill = async () => (await srv.call('/api/projects')).data.find((p: any) => p.id === project.id);
    const minion = () => ({ Authorization: `Bearer ${agentToken(srv.data, t.id)}`, 'Content-Type': 'application/json' });
    await until('the turn', async () => (await fetch(`${srv.base}/api/tickets/${t.id}/approvals?id=x`, { headers: minion() })).ok);
    assert.deepEqual(await pill().then(({ running, working }) => ({ running, working })), { running: true, working: 1 }, 'mid-turn');

    const card = await (await fetch(`${srv.base}/api/tickets/${t.id}/approvals`, { method: 'POST', headers: minion(), body: JSON.stringify({ tool_name: 'Bash', input: { command: 'echo hi', description: 'Say hi' } }) })).json();
    assert.ok(card.id, JSON.stringify(card));
    assert.deepEqual(await pill().then(({ running, working }) => ({ running, working })), { running: false, working: 0 }, 'held on the card: waiting on a person');

    assert.equal((await srv.call(`/api/tickets/${t.id}/approve`, { approvalId: card.id, allow: true })).status, 200);
    assert.deepEqual(await pill().then(({ running, working }) => ({ running, working })), { running: true, working: 1 }, 'answered: back at work');
    writeFileSync(join(root, 'release'), '');
  } finally {
    await srv.stop();
  }
});
