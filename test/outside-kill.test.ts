import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner, wrapperAlive } from '../src/runner.ts';

// Delve #14's claude was SIGTERMed by its own `pkill`, and the chat showed only a stderr warning and
// "(claude exited with code 143)". A signal Citadel didn't send must be named as such.
const root = mkdtempSync(join(tmpdir(), 'outside-kill-'));
after(() => rmSync(root, { recursive: true, force: true }));
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
    for (let i = 0; i < 500 && !store.listEvents(t.id).some((e) => e.kind === 'claude'); i++) await new Promise((r) => setTimeout(r, 20));
    runner.stop(t.id);
  }
  for (let i = 0; i < 500 && runner.isRunning(t.id); i++) await new Promise((r) => setTimeout(r, 20));
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
});

test('a turn a person stops is not reported as killed', async () => {
  const { ticket, errors } = await turn('wait', true);
  assert.equal(ticket.status, 'idle');
  assert.deepEqual(errors, []);
});
