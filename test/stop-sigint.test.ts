import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
testPins();

// AG-04: SIGTERM leaves claude's turn unfinished with no result, so a stopped turn recorded no cost.
// A stop sends SIGINT first, gives claude a grace period to write its result, then SIGTERM, then SIGKILL.
const root = mkdtempSync(join(tmpdir(), 'stop-sigint-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }));
  if (input.includes('result-on-sigint')) process.on('SIGINT', () => {
    console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's1', total_cost_usd: 0.42, duration_ms: 5, usage: { input_tokens: 10, output_tokens: 20 } }));
    process.exit(130);
  });
  else process.on('SIGINT', () => {});
  if (input.includes('ignore-sigterm')) process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const runner = new Runner(store, () => {}, () => ({}), fake);
runner.pollMs = 10;
(runner as any).stopGraceMs = 300;
(runner as any).stopKillMs = 900;

async function stopped(text: string) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  runner.send(t.id, 'Cara', text);
  for (let i = 0; i < 500 && !store.listEvents(t.id).some((e) => e.kind === 'claude'); i++) await new Promise((r) => setTimeout(r, 20));
  const at = Date.now();
  runner.stop(t.id);
  for (let i = 0; i < 500 && runner.isRunning(t.id); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(!runner.isRunning(t.id), 'the turn ended');
  return { id: t.id, took: Date.now() - at, ticket: store.getTicket(t.id)! };
}

test('a stopped turn records its result: cost and usage', async () => {
  const { id, ticket } = await stopped('result-on-sigint');
  assert.equal(ticket.status, 'idle');
  const turns = store.listTurns(id);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].session_cost_usd, 0.42);
});

test('a claude that ignores SIGINT still dies by SIGTERM after the grace period', async () => {
  const { took, ticket } = await stopped('plain');
  assert.equal(ticket.status, 'idle');
  assert.ok(took >= 250, `waited out the grace period (${took} ms)`);
  assert.ok(took < 880, `SIGTERM ended it before the SIGKILL retry (${took} ms)`);
});

test('a claude that ignores SIGINT and SIGTERM is SIGKILLed', async () => {
  const { took, ticket } = await stopped('ignore-sigterm');
  assert.equal(ticket.status, 'idle');
  assert.ok(took >= 850, `killed by the SIGKILL retry (${took} ms)`);
});
