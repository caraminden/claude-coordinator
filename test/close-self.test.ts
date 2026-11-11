import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
testPins();

// A stand-in for `claude -p`: waits until a release file appears, then ends the turn the way
// FAKE_OUTCOME says (ok, error), so the test can act while the turn is running.
const root = mkdtempSync(join(tmpdir(), 'close-self-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { existsSync, readFileSync } = require('node:fs');
process.stdin.resume();
const wait = setInterval(() => {
  const release = ${JSON.stringify(join(root, 'release'))};
  if (!existsSync(release)) return;
  clearInterval(wait);
  const outcome = readFileSync(release, 'utf8');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: outcome === 'error', result: 'done' }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const broadcasts: any[] = [];
const runner = new Runner(store, (m) => broadcasts.push(m), () => ({}), fake);

function newTicket() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  return t.id;
}

async function endTurn(id: number, outcome: 'ok' | 'error') {
  rmSync(join(root, 'release'), { force: true });
  // Made under another name and renamed: the fake polling for the file would otherwise read it between create and write, empty.
  writeFileSync(join(root, 'release.tmp'), outcome);
  renameSync(join(root, 'release.tmp'), join(root, 'release'));
  while (runner.isRunning(id)) await new Promise((r) => setTimeout(r, 20));
  rmSync(join(root, 'release'), { force: true });
}

const notes = (id: number) => store.listEvents(id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text);

test('refuses when the ticket is not mid-turn', () => {
  assert.equal(runner.closeAfterTurn(newTicket(), null), false);
});

test('closes after a clean turn, with the reason as a close note', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  assert.equal(runner.closeAfterTurn(id, 'Merged abc1234'), true);
  assert.equal(runner.view(store.getTicket(id)!).closing, true);
  assert.equal(store.getTicket(id)!.status, 'running');
  await endTurn(id, 'ok');
  assert.equal(store.getTicket(id)!.status, 'closed');
  assert.deepEqual(notes(id), ['Claude dismissed this minion: Merged abc1234']);
  assert.equal(runner.view(store.getTicket(id)!).closing, false);
  assert.ok(broadcasts.some((m) => m.type === 'ticket' && m.ticket.id === id && m.ticket.status === 'closed'));
});

test('a failed turn stays open', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  runner.closeAfterTurn(id, null);
  await endTurn(id, 'error');
  assert.equal(store.getTicket(id)!.status, 'error');
  assert.equal(runner.view(store.getTicket(id)!).closing, false);
});

test('a stopped turn stays open', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  runner.closeAfterTurn(id, null);
  runner.stop(id);
  while (runner.isRunning(id)) await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getTicket(id)!.status, 'idle');
});

test('a message queued during the turn keeps it open and runs next', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  runner.closeAfterTurn(id, null);
  runner.send(id, 'Josh', 'one more thing');
  rmSync(join(root, 'release'), { force: true });
  writeFileSync(join(root, 'release'), 'ok');
  // The first turn ends and the queued message starts a second one straight away.
  while (!notes(id).length) await new Promise((r) => setTimeout(r, 20));
  assert.match(notes(id)[0], /new message arrived/);
  await endTurn(id, 'ok');
  assert.equal(store.getTicket(id)!.status, 'idle');
});

test('refuses while a question or plan card waits on people, or the state is try', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  const q = store.addEvent(id, 'question', { id: 'q1', questions: [{ header: 'Layout', question: 'Tabs or list?' }] });
  assert.match(runner.keptOpen(id)!, /card is still waiting/);
  // close_self's own refusal carries the card's link (#480).
  assert.match(runner.keptOpen(id, true)!, new RegExp(`question card "Layout": \\[open it\\]\\(#/p/${project.id}/t/${store.getTicket(id)!.number}\\?e=${q.id}\\) is still waiting`));
  assert.equal(runner.closeAfterTurn(id, null), false);
  // A card keeps it open even in state ready, and the refusal leaves the state alone.
  store.updateTicket(id, { state: 'ready' });
  assert.equal(runner.closeAfterTurn(id, null), false);
  assert.equal(store.getTicket(id)!.state, 'ready');
  const plan = newTicket();
  store.addEvent(plan, 'plan', { id: 'p1', status: 'pending' });
  assert.match(runner.keptOpen(plan)!, /card is still waiting/);
  const t = newTicket();
  for (const state of ['try', 'ready']) {
    store.updateTicket(t, { state });
    assert.match(runner.keptOpen(t)!, new RegExp(`state is ${state}`));
  }
  store.updateTicket(t, { state: 'try' });
  assert.match(runner.keptOpen(t, true)!, /state is try/);
  for (const state of [null, 'parked', 'pending-deploy']) {
    store.updateTicket(t, { state });
    assert.equal(runner.keptOpen(t), null);
  }
  await endTurn(id, 'ok');
});

test('a pending approval card refuses close_self, even in state ready, with its link', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  store.updateTicket(id, { state: 'ready' });
  runner.approvals.request(id, 'Bash', { command: 'ls', description: 'List' });
  assert.match(runner.keptOpen(id, true)!, /^an approval card "Bash: List": \[open it\]\(#\/p\/\d+\/t\/\d+\?e=\d+\) is still waiting/);
  assert.equal(runner.closeAfterTurn(id, null), false);
  assert.equal(store.getTicket(id)!.state, 'ready');
  await endTurn(id, 'ok');
});

test('state try refuses close_self mid-turn', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  store.updateTicket(id, { state: 'try' });
  assert.equal(runner.closeAfterTurn(id, null), false);
  assert.equal(store.getTicket(id)!.state, 'try');
  await endTurn(id, 'ok');
  assert.equal(store.getTicket(id)!.status, 'idle');
});

test('state ready with no card clears and dismisses (#480)', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  store.updateTicket(id, { state: 'ready', note: 'merged' });
  assert.equal(runner.keptOpen(id, true), null);
  assert.equal(runner.closeAfterTurn(id, 'Merged abc1234'), true);
  assert.equal(store.getTicket(id)!.state, null);
  await endTurn(id, 'ok');
  assert.equal(store.getTicket(id)!.status, 'closed');
  assert.deepEqual(notes(id), ['Claude dismissed this minion: Merged abc1234']);
});

test('a card posted or try/ready set after close_self keeps it open at the turn end', async () => {
  for (const after of ['ready', 'try', 'card']) {
    const id = newTicket();
    runner.send(id, 'Cara', 'ship it');
    assert.equal(runner.closeAfterTurn(id, null), true);
    if (after === 'card') store.addEvent(id, 'question', { id: 'q1', questions: [] });
    else store.updateTicket(id, { state: after });
    await endTurn(id, 'ok');
    assert.equal(store.getTicket(id)!.status, 'idle', after);
    const why = after === 'card' ? 'a question, plan or approval card is still waiting on people' : `its state is ${after}, which tells people something is waiting for them`;
    assert.deepEqual(notes(id), [`Claude asked to dismiss this minion, but ${why}, so it stays open.`]);
  }
});

test('close() marks a ticket closed, as the coordinator does', () => {
  const id = newTicket();
  runner.close(id, 'Coordinator closed this ticket.');
  assert.equal(store.getTicket(id)!.status, 'closed');
  assert.deepEqual(notes(id), ['Coordinator closed this ticket.']);
});
