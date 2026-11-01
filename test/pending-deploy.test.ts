import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns } from './helpers.ts';

// pending-deploy: the state outlasts a new turn, and a deploy that went live dismisses the minion,
// unless something is still open for a person. Same fake `claude -p` as close-self.test.ts.
const root = mkdtempSync(join(tmpdir(), 'pending-deploy-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { readFileSync, renameSync } = require('node:fs');
process.stdin.resume();
const wait = setInterval(() => {
  const release = ${JSON.stringify(join(root, 'release'))};
  // Taken, so one release ends one turn: a queued turn starting right after can't end on the same one.
  const taken = release + '.' + process.pid;
  try {
    renameSync(release, taken);
  } catch {
    return;
  }
  clearInterval(wait);
  const outcome = readFileSync(taken, 'utf8');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: outcome === 'error', result: 'done' }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const runner = new Runner(store, () => {}, () => ({}), fake);

function newTicket(state: any = 'pending-deploy', note: string | null = null) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle', state, note });
  return t.id;
}

/** End the running turn: waits for that turn, not for nothing to run, since a queued one may start right after. */
async function endTurn(id: number, outcome: 'ok' | 'error') {
  const live = (runner as any).turns.get(id);
  rmSync(join(root, 'release'), { force: true });
  writeFileSync(join(root, 'release'), outcome);
  while ((runner as any).turns.get(id) === live) await new Promise((r) => setTimeout(r, 20));
  rmSync(join(root, 'release'), { force: true });
}

const status = (id: number) => store.getTicket(id)!.status;

test('an idle minion in pending-deploy is dismissed when its deploy is live', () => {
  const id = newTicket();
  assert.equal(runner.deployLive(id), true);
  assert.equal(status(id), 'closed');
  assert.equal(store.getTicket(id)!.state, null);
});

test('other states are left alone, but the interim "outside / pending deploy" counts', () => {
  for (const s of ['ready', 'outside', null]) {
    const id = newTicket(s);
    assert.equal(runner.deployLive(id), false);
    assert.equal(status(id), 'idle');
  }
  assert.equal(runner.deployLive(newTicket('outside', 'pending deploy')), true);
});

test('an open question card keeps it open; an answered one does not', () => {
  const id = newTicket();
  store.addEvent(id, 'question', { id: 'q1', questions: [] });
  assert.equal(runner.deployLive(id), false);
  assert.equal(status(id), 'idle');
  store.addEvent(id, 'user_message', { text: 'x', answer: { questionId: 'q1', answers: [] } });
  assert.equal(runner.deployLive(id), true);
});

test('a question card the minion settled (answered in a typed reply) does not keep it open', () => {
  const id = newTicket();
  store.addEvent(id, 'question', { id: 'q1', questions: [], settled: { at: 1 } });
  assert.equal(runner.deployLive(id), true);
});

test('a person who wrote after the deploy keeps it open, and its state is cleared', () => {
  const id = newTicket();
  runner.personWrote(id);
  assert.equal(runner.deployLive(id), false);
  assert.equal(status(id), 'idle');
  assert.equal(store.getTicket(id)!.state, null);
  assert.match(store.listEvents(id).at(-1)!.data, /someone wrote to this minion/);
});

test('only talk while in pending-deploy counts: earlier talk, or talk before a new deploy, does not', () => {
  const before = newTicket('ready');
  runner.personWrote(before);
  store.updateTicket(before, { state: 'pending-deploy' });
  assert.equal(runner.deployLive(before), true);
  const redeployed = newTicket();
  runner.personWrote(redeployed);
  runner.deployPending(redeployed);
  assert.equal(runner.deployLive(redeployed), true);
});

test('a minion whose last turn failed stays open', () => {
  const id = newTicket();
  store.updateTicket(id, { status: 'error' });
  assert.equal(runner.deployLive(id), false);
});

test('pending-deploy outlasts a stray turn, and a deploy that lands mid-turn dismisses at its end', async () => {
  const id = newTicket();
  runner.send(id, 'GitHub', 'CI passed on the PR');
  assert.equal(store.getTicket(id)!.state, 'pending-deploy', 'a new turn keeps it');
  assert.equal(runner.deployLive(id), false, 'not mid-turn');
  assert.equal(status(id), 'running');
  await endTurn(id, 'ok');
  assert.equal(status(id), 'closed');
});

test('a turn that sets another state, or fails, is not dismissed by a deploy that landed mid-turn', async () => {
  const a = newTicket();
  runner.send(a, 'Cara', 'one more feature');
  runner.deployLive(a);
  store.updateTicket(a, { state: 'try' });
  await endTurn(a, 'ok');
  assert.equal(status(a), 'idle');
  const b = newTicket();
  runner.send(b, 'Cara', 'x');
  runner.deployLive(b);
  await endTurn(b, 'error');
  assert.equal(status(b), 'error');
});

test('a message queued behind the turn defers the dismissal to the end of that turn too', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'first');
  runner.deployLive(id);
  runner.send(id, 'Josh', 'second');
  await endTurn(id, 'ok');
  // The first turn has ended; the queued one starts once the first one's session is saved (#250).
  while (!runner.isRunning(id)) await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(status(id), 'closed');
  await endTurn(id, 'ok');
  assert.equal(status(id), 'closed');
});
