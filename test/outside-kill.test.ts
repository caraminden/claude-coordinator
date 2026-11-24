import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner, wrapperAlive } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
import { realClock } from '../src/clock.ts';
import { FakeClock } from './fake-clock.ts';
import { until } from './wait.ts';
testPins();

// Delve #14's claude was SIGTERMed by its own `pkill`, and the chat showed only a stderr warning and
// "(claude exited with code 143)". A signal Citadel didn't send must be named as such.
// Since #1364 the server resumes a killed turn once by itself, and a second kill in a row stops it: the fake's
// resume dies the same way its turn did, so each kill is named twice, in the first kill's note and in the error.
const root = mkdtempSync(join(tmpdir(), 'outside-kill-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
const lastMode = join(root, 'last-mode');
writeFileSync(
  fake,
  `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).once('line', (line) => {
  // A resume after a kill does what the killed turn did.
  const input = line.includes('was killed') ? readFileSync(${JSON.stringify(lastMode)}, 'utf8') : line;
  writeFileSync(${JSON.stringify(lastMode)}, input);
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
const runner = new Runner(
  store,
  () => {},
  () => ({}),
  fake,
);
runner.pollMs = 10;
runner.resumeGapMs = 0;
runner.killStarved = async () => ({ starved: false, why: '' });
const notes = (id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'note')
    .map((e) => JSON.parse(e.data).text as string);

async function turn(text: string, stop = false) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  runner.send(t.id, 'Cara', text);
  if (stop) {
    // Once claude is up: a stop before it starts has no process to signal yet.
    await until('the first claude event', async () => store.listEvents(t.id).some((e) => e.kind === 'claude'), 10000);
    runner.stop(t.id);
  }
  // Past the one resume a kill gets, if it was killed.
  await until('the turn to stop', async () => !runner.isRunning(t.id) && !runner.killWait(t.id), 10000);
  assert.ok(!runner.isRunning(t.id), 'the turn ended');
  const errors = store
    .listEvents(t.id)
    .filter((e) => e.kind === 'error')
    .map((e) => JSON.parse(e.data).text);
  return { ticket: store.getTicket(t.id)!, errors, notes: notes(t.id) };
}

test('a claude that exits 143 without a stop says it was killed from outside Citadel, ahead of its stderr', async () => {
  const { ticket, errors, notes } = await turn('exit 143');
  assert.equal(ticket.status, 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Killed by SIGTERM \(exit 143\) from outside Citadel\.\nNobody pressed Stop/);
  assert.match(notes.find((n) => n.startsWith('Killed')) ?? '', /^Killed by SIGTERM \(exit 143\) from outside Citadel\.\nNobody pressed Stop[\s\S]*resumes it by itself/);
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
  const { ticket, errors, notes } = await turn('signal');
  assert.equal(ticket.status, 'error');
  assert.match(errors[0] ?? '', /^Killed by SIGTERM from outside Citadel\./);
  assert.match(notes.find((n) => n.startsWith('Killed')) ?? '', /^Killed by SIGTERM from outside Citadel\./);
  // A health row for each of its two kills, which outlives the chat's (#1325).
  assert.deepEqual(
    store
      .healthEventsSince(['turn-killed'], 0)
      .filter((e) => e.detail.startsWith(`minion ${ticket.id}:`))
      .map((e) => e.detail),
    [`minion ${ticket.id}: SIGTERM`, `minion ${ticket.id}: SIGTERM`],
  );
});

test('a turn killed together with its wrapper (no exit record) is resumed, and killed again fails rather than ending idle like a stop (#468 S03-4)', async () => {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  const failed: string[] = [];
  runner.onTurnError = (_id: number, why: string) => failed.push(why);
  try {
    runner.send(t.id, 'Cara', 'wait');
    for (const n of [1, 2]) {
      await until(`claude ${n} to be up`, async () => store.listEvents(t.id).filter((e) => e.kind === 'claude').length >= n && existsSync(join((runner as any).turns.get(t.id)?.dir ?? root, 'pid.json')), 10000);
      const live = (runner as any).turns.get(t.id);
      const pids = JSON.parse(readFileSync(join(live.dir, 'pid.json'), 'utf8'));
      process.kill(pids.wrapper, 'SIGKILL');
      process.kill(-pids.claude, 'SIGKILL');
      await until('the server to see the kill', async () => (runner as any).turns.get(t.id) !== live, 10000);
      if (n === 1) {
        assert.equal(store.listEvents(t.id).filter((e) => e.kind === 'error').length, 0, 'the first kill is resumed, not an error');
        assert.match(notes(t.id).find((x) => x.startsWith("The turn's process")) ?? '', /^The turn's process was killed before it finished/);
        assert.equal(failed.length, 0, 'nobody is pushed for a kill the server resumes');
      }
    }
    await until('the turn to stop', async () => !runner.isRunning(t.id) && !runner.killWait(t.id), 10000);
    assert.ok(!runner.isRunning(t.id), 'the turn ended');
    assert.equal(store.getTicket(t.id)!.status, 'error');
    const errors = store
      .listEvents(t.id)
      .filter((e) => e.kind === 'error')
      .map((e) => JSON.parse(e.data).text);
    assert.match(errors[0] ?? '', /^The turn's process was killed before it finished/);
    assert.match(errors[0] ?? '', /already resumed once after a kill/);
    assert.equal(failed.length, 1, 'people hear of it');
    assert.equal(store.healthEventsSince(['turn-killed'], 0).filter((e) => e.detail === `minion ${t.id}: its unit or process group was killed, no exit noted`).length, 2, 'one row per kill');
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
  // The stop's kill timers run on a clock nobody moves: the turn can only end by the signal sent once claude
  // starts, never by the SIGKILL retry, which would need the clock advanced by stopKillMs.
  const clock = new FakeClock();
  runner.clock = clock;
  try {
    runner.stop(t.id);
    assert.ok(
      clock.pending().some((p) => p.ms === runner.stopKillMs),
      'the SIGKILL retry is armed',
    );
    await until('the turn to stop', async () => !runner.isRunning(t.id));
    assert.ok(!runner.isRunning(t.id), 'the turn ended without the clock moving');
  } finally {
    runner.clock = realClock;
  }
  assert.equal(store.getTicket(t.id)!.status, 'idle');
});

test('a turn a person stops is not reported as killed', async () => {
  const { ticket, errors } = await turn('wait', true);
  assert.equal(ticket.status, 'idle');
  assert.deepEqual(errors, []);
});
