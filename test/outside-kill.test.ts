import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner, wrapperAlive } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// Delve #14's claude was SIGTERMed by its own `pkill`, and the chat showed only a stderr warning and
// "(claude exited with code 143)". A signal Citadel didn't send must be named as such.
const root = mkdtempSync(join(tmpdir(), 'outside-kill-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }));
  console.error('Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace has not been trusted.');
  // As claude does on SIGTERM: exits 143. Or dies of the signal outright.
  if (input.includes('exit 143')) process.exit(143);
  if (input.includes('signal')) process.kill(process.pid, 'SIGTERM');
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => {}, 1000);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const runner = new Runner(store, () => {}, () => ({}), fake);
runner.pollMs = 10;

async function turn(text: string, stop = false) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  runner.send(t.id, 'Cara', text);
  if (stop) {
    // Once claude is up: a stop before it starts has no process to signal yet.
    await until('the first claude event', async () => store.listEvents(t.id).some((e) => e.kind === 'claude'), 10000);
    runner.stop(t.id);
  }
  await until('the turn to stop', async () => !runner.isRunning(t.id), 10000);
  assert.ok(!runner.isRunning(t.id), 'the turn ended');
  const errors = store.listEvents(t.id).filter((e) => e.kind === 'error').map((e) => JSON.parse(e.data).text);
  return { ticket: store.getTicket(t.id)!, errors };
}

test('a claude that exits 143 without a stop says it was killed from outside Citadel, ahead of its stderr', async () => {
  const { ticket, errors } = await turn('exit 143');
  assert.equal(ticket.status, 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Killed by SIGTERM \(exit 143\) from outside Citadel\.\nNobody pressed Stop/);
  assert.match(ticket.note!, /^Killed by SIGTERM \(exit 143\) from outside/);
});

test('a claude that exits while a poll is between its exit and liveness checks still fails the turn', async () => {
  // Under load: the poll finds no exit.json, then the wrapper writes it and exits before the poll's
  // every-20th liveness check, which then took the turn for one killed without a record (idle).
  const r = runner as any;
  const readStream = r.readStream;
  r.readStream = function (this: any, id: number, live: any, toEnd: boolean) {
    if (!toEnd && !existsSync(join(live.dir, 'exit.json'))) {
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      for (let i = 0; i < 250 && wrapperAlive(live.dir) !== false; i++) Atomics.wait(sleeper, 0, 0, 20);
      live.ticks = 19;
    }
    return readStream.call(this, id, live, toEnd);
  };
  try {
    const { ticket, errors } = await turn('exit 143');
    assert.equal(ticket.status, 'error');
    assert.match(errors[0] ?? '', /^Killed by SIGTERM \(exit 143\) from outside Citadel\./);
  } finally {
    r.readStream = readStream;
  }
});

test('a claude killed outright by a signal nobody sent from Citadel fails the turn and names the signal', async () => {
  const { ticket, errors } = await turn('signal');
  assert.equal(ticket.status, 'error');
  assert.match(errors[0] ?? '', /^Killed by SIGTERM from outside Citadel\./);
  // A health row too, which outlives the chat's (#1325).
  assert.deepEqual(store.healthEventsSince(['turn-killed'], 0).filter((e) => e.detail.startsWith(`minion ${ticket.id}:`)).map((e) => e.detail), [`minion ${ticket.id}: SIGTERM`]);
});

test('a turn killed together with its wrapper (no exit record) fails the turn rather than ending idle like a stop (#468 S03-4)', async () => {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  const failed: string[] = [];
  runner.onTurnError = (_id: number, why: string) => failed.push(why);
  try {
    runner.send(t.id, 'Cara', 'wait');
    await until('the first claude event', async () => store.listEvents(t.id).some((e) => e.kind === 'claude'), 10000);
    const pids = JSON.parse(readFileSync(join((runner as any).turns.get(t.id).dir, 'pid.json'), 'utf8'));
    process.kill(pids.wrapper, 'SIGKILL');
    process.kill(-pids.claude, 'SIGKILL');
    await until('the turn to stop', async () => !runner.isRunning(t.id), 10000);
    assert.ok(!runner.isRunning(t.id), 'the turn ended');
    assert.equal(store.getTicket(t.id)!.status, 'error');
    const errors = store.listEvents(t.id).filter((e) => e.kind === 'error').map((e) => JSON.parse(e.data).text);
    assert.match(errors[0] ?? '', /^The turn's process was killed before it finished/);
    assert.equal(failed.length, 1, 'people hear of it');
    assert.equal(store.healthEventsSince(['turn-killed'], 0).filter((e) => e.detail === `minion ${t.id}: its unit or process group was killed, no exit noted`).length, 1);
  } finally {
    runner.onTurnError = () => {};
  }
});

test('a stop before claude has started signals it as soon as it starts, not at the 15 s retry (#468 S03-2)', async () => {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  runner.send(t.id, 'Cara', 'wait');
  const dir = (runner as any).turns.get(t.id).dir;
  assert.ok(!existsSync(join(dir, 'pid.json')), 'stopped before the wrapper started claude');
  const started = Date.now();
  runner.stop(t.id);
  await until('the turn to stop', async () => !runner.isRunning(t.id), 10000);
  assert.ok(!runner.isRunning(t.id), 'the turn ended');
  assert.ok(Date.now() - started < 8000, `ended after ${Date.now() - started} ms`);
  assert.equal(store.getTicket(t.id)!.status, 'idle');
});

test('a turn a person stops is not reported as killed', async () => {
  const { ticket, errors } = await turn('wait', true);
  assert.equal(ticket.status, 'idle');
  assert.deepEqual(errors, []);
});
