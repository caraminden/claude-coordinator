import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
import { FakeClock } from './fake-clock.ts';
import { until } from './wait.ts';
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
// The grace and kill timers run on a clock the test moves (#1444): what's checked is which signal goes when, in order,
// not how many real milliseconds a stop took.
const clock = new FakeClock();
runner.clock = clock;
const { stopGraceMs, stopKillMs } = runner;
let sent: string[] = [];
const signal = runner.signal.bind(runner);
runner.signal = (live, sig) => {
  sent.push(sig);
  signal(live, sig);
};

async function started(text: string) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  runner.send(t.id, 'Cara', text);
  await until('the first claude event', async () => store.listEvents(t.id).some((e) => e.kind === 'claude'), 10000);
  sent = [];
  return t.id;
}

async function ended(id: number) {
  await until('the turn to stop', async () => !runner.isRunning(id), 10000);
  return store.getTicket(id)!;
}

test('a stopped turn records its result: cost and usage', async () => {
  const id = await started('result-on-sigint');
  runner.stop(id);
  const ticket = await ended(id);
  assert.deepEqual(sent, ['SIGINT'], 'SIGINT alone ended it: no time passed, so no SIGTERM');
  assert.equal(ticket.status, 'idle');
  const turns = store.listTurns(id);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].session_cost_usd, 0.42);
});

test('a claude that ignores SIGINT still dies by SIGTERM after the grace period', async () => {
  const id = await started('plain');
  runner.stop(id);
  assert.deepEqual(sent, ['SIGINT']);
  assert.deepEqual(clock.pending().map((p) => p.ms), [stopGraceMs, stopKillMs], 'SIGTERM after the grace, SIGKILL after the kill wait');
  clock.advance(stopGraceMs - 1);
  assert.deepEqual(sent, ['SIGINT'], 'nothing more before the grace period is up');
  clock.advance(1);
  assert.deepEqual(sent, ['SIGINT', 'SIGTERM']);
  const ticket = await ended(id);
  assert.equal(ticket.status, 'idle');
  assert.deepEqual(clock.pending(), [], 'SIGTERM ended it, and the SIGKILL retry was called off');
  assert.deepEqual(sent, ['SIGINT', 'SIGTERM']);
});

test('a claude that ignores SIGINT and SIGTERM is SIGKILLed', async () => {
  const id = await started('ignore-sigterm');
  runner.stop(id);
  clock.advance(stopGraceMs);
  assert.deepEqual(sent, ['SIGINT', 'SIGTERM']);
  clock.advance(stopKillMs - stopGraceMs);
  assert.deepEqual(sent, ['SIGINT', 'SIGTERM', 'SIGKILL'], 'killed by the SIGKILL retry');
  const ticket = await ended(id);
  assert.equal(ticket.status, 'idle');
});

test('a second Stop does not push the SIGKILL out', async () => {
  const id = await started('ignore-sigterm');
  runner.stop(id);
  clock.advance(stopGraceMs + 700);
  assert.deepEqual(sent, ['SIGINT', 'SIGTERM']);
  runner.stop(id);
  assert.deepEqual(sent, ['SIGINT', 'SIGTERM'], 'the second Stop sends nothing new');
  assert.deepEqual(clock.pending(), [{ ms: stopKillMs, in: stopKillMs - stopGraceMs - 700 }], 'the SIGKILL still comes on the first Stop\'s schedule');
  clock.advance(stopKillMs - stopGraceMs - 700);
  assert.deepEqual(sent, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  await ended(id);
});
