import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { runnerInsides, stopTurns, testPins, followed } from './helpers.ts';
import { until } from './wait.ts';
testPins();

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
const runner = new Runner(
  store,
  () => {},
  () => ({}),
  fake,
);

function newTicket(state: Parameters<Store['updateTicket']>[1]['state'] = 'pending-deploy', note: string | null = null) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle', state, note });
  return t.id;
}

/** End the running turn: waits for that turn, not for nothing to run, since a queued one may start right after. */
async function endTurn(id: number, outcome: 'ok' | 'error') {
  await until('the turn to start', () => followed(runner, id)); // its launch writes its files first (#1808)
  const live = runnerInsides(runner).turns.get(id);
  rmSync(join(root, 'release'), { force: true });
  writeFileSync(join(root, 'release'), outcome);
  await until('the turn to change', async () => runnerInsides(runner).turns.get(id) !== live);
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
  for (const s of ['ready', 'outside', null] as const) {
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
  await until('the turn to start', async () => runner.isRunning(id));
  assert.notEqual(status(id), 'closed');
  await endTurn(id, 'ok');
  assert.equal(status(id), 'closed');
});

test("a held CI run's line is the minion's note in its view, until it is dismissed", () => {
  const id = newTicket();
  store.updateTicket(id, { state: 'outside', note: '50-run proof running' });
  runner.heldLine = (t) => (t === id ? 'held off CI since 4:20 AM PST, ships first' : null);
  try {
    assert.equal(runner.view(store.getTicket(id)!).note, 'held off CI since 4:20 AM PST, ships first');
    store.updateTicket(id, { status: 'closed' });
    assert.equal(runner.view(store.getTicket(id)!).note, '50-run proof running');
  } finally {
    runner.heldLine = undefined;
  }
});

test("a red's fix minion isn't dismissed by its deploy or close_self until CI health lets it go; green dismisses it (#1074)", () => {
  const id = newTicket();
  let hold: string | null = 'it fixes the red tests run 9201 on main';
  runner.ciHold = (t) => (t === id ? hold : null);
  try {
    assert.equal(runner.deployLive(id), false);
    assert.equal(status(id), 'idle');
    assert.equal(store.getTicket(id)!.state, 'outside');
    assert.match(store.getTicket(id)!.note!, /waiting on the CI re-run/);
    assert.match(store.listEvents(id).at(-1)!.data, /it fixes the red tests run 9201 on main, so this minion stays open/);
    assert.equal(runner.keptOpen(id), 'it fixes the red tests run 9201 on main');
    // Another minion is untouched.
    assert.equal(runner.deployLive(newTicket()), true);
    hold = null;
    runner.ciGreen(id, 'tests.yml is green on main again (run 9203)');
    assert.equal(status(id), 'closed');
    assert.equal(store.getTicket(id)!.state, null);
  } finally {
    runner.ciHold = undefined;
  }
});
