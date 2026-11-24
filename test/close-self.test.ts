import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { closeSelfResult } from '../src/mcp.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, testPins, followed } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// A stand-in for `claude -p`: waits until a release file appears, takes it, then ends the turn the way
// the file says (ok, error), so the test can act while the turn is running.
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
const { appendFileSync, readFileSync, unlinkSync } = require('node:fs');
// Each turn's prompt, kept for the tests that read what a turn was told.
process.stdin.on('data', (d) => appendFileSync(${JSON.stringify(join(root, 'prompts.log'))}, d));
const wait = setInterval(() => {
  const release = ${JSON.stringify(join(root, 'release'))};
  let outcome;
  // One release ends one turn (#771): left in place, it ended the queued next turn too, before that turn
  // had read its prompt, or was deleted by the test between this fake's look and its read (ENOENT, a failed turn).
  try {
    outcome = readFileSync(release, 'utf8');
    unlinkSync(release);
  } catch {
    return;
  }
  clearInterval(wait);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: outcome === 'error', result: 'done' }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const broadcasts: any[] = [];
const runner = new Runner(
  store,
  (m) => broadcasts.push(m),
  () => ({}),
  fake,
);

function newTicket() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  return t.id;
}

// Ends the turn that is running: its fake takes the file, so a turn that starts after it stays running.
// With no turn running the file would end the next one to start, in whatever test that is.
function release(outcome: 'ok' | 'error') {
  // Made under another name and renamed: the fake polling for the file would otherwise read it between create and write, empty.
  writeFileSync(join(root, 'release.tmp'), outcome);
  renameSync(join(root, 'release.tmp'), join(root, 'release'));
}

// The first turn's close note is out: wait for the queued second turn. It starts only after the first one's
// session is saved, and until then nothing runs, so an endTurn there would return at once and leave it running.
async function secondTurn(id: number) {
  await until('the second turn to start', () => notes(id).length && runner.isRunning(id));
}

// Its launch writes the turn's files off the thread (#1808): the turn is followed, and the minion running, once it's done.
const started = (id: number) => until('the turn to start', () => followed(runner, id));

async function endTurn(id: number, outcome: 'ok' | 'error') {
  release(outcome);
  await until('the turn to end', () => !runner.isRunning(id));
}

const notes = (id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'note')
    .map((e) => JSON.parse(e.data).text);

test('refuses when the ticket is not mid-turn', () => {
  assert.equal(runner.closeAfterTurn(newTicket(), null), false);
});

test('closes after a clean turn, with the reason as a close note', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  await started(id);
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
  await started(id);
  runner.closeAfterTurn(id, null);
  await endTurn(id, 'error');
  assert.equal(store.getTicket(id)!.status, 'error');
  assert.equal(runner.view(store.getTicket(id)!).closing, false);
});

test('a stopped turn stays open', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  await started(id);
  runner.closeAfterTurn(id, null);
  runner.stop(id);
  await until('the turn to end', () => !runner.isRunning(id));
  assert.equal(store.getTicket(id)!.status, 'idle');
});

test('a message queued during the turn keeps it open and runs next', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  await started(id);
  runner.closeAfterTurn(id, null);
  runner.send(id, 'Josh', 'one more thing');
  release('ok');
  // The first turn ends and the queued message starts a second one.
  await secondTurn(id);
  assert.match(notes(id)[0], /new message arrived/);
  await endTurn(id, 'ok');
  assert.equal(store.getTicket(id)!.status, 'idle');
});

test('a GitHub notice that needs no action, like its own merge, leaves a pending close armed and starts no turn (#619)', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'land it');
  await started(id);
  runner.closeAfterTurn(id, 'Merged PR #82');
  runner.send(id, 'GitHub', 'PR #82 was merged by josh.', [], { fyi: true });
  await endTurn(id, 'ok');
  assert.equal(store.getTicket(id)!.status, 'closed');
  assert.deepEqual(notes(id), ['Claude dismissed this minion: Merged PR #82']);
  assert.equal(runner.queued(id), 0);
  // The notice stays in the chat.
  assert.ok(store.listEvents(id).some((e) => e.kind === 'user_message' && JSON.parse(e.data).text === 'PR #82 was merged by josh.'));
});

test('a GitHub notice that needs action, or a person beside a no-action one, still cancels the close, and the next turn is told (#619)', async () => {
  for (const extra of [[], [['Josh', 'one more thing', {}]]] as const) {
    const id = newTicket();
    runner.send(id, 'Cara', 'land it');
    await started(id);
    runner.closeAfterTurn(id, null);
    if (extra.length) runner.send(id, 'GitHub', 'PR #82 was merged by josh.', [], { fyi: true });
    else runner.send(id, 'GitHub', 'CI failed on abc1234 in PR #82 — build: https://ci/build');
    for (const [who, text, more] of extra) runner.send(id, who, text, [], more);
    rmSync(join(root, 'prompts.log'), { force: true });
    release('ok');
    await secondTurn(id);
    assert.match(notes(id)[0], /new message arrived/);
    // The second turn's prompt says the close was cancelled, before the message that cancelled it.
    const prompts = () => readFileSync(join(root, 'prompts.log'), { encoding: 'utf8', flag: 'a+' });
    for (const end = Date.now() + 5000; !prompts().includes('land it') || !/one more thing|CI failed/.test(prompts()); ) {
      if (Date.now() > end) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(prompts(), /close_self in your last turn was cancelled: a new message arrived/);
    await endTurn(id, 'ok');
    assert.equal(store.getTicket(id)!.status, 'idle');
  }
});

test('refuses while a question or plan card waits on people, or the state is try', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  await started(id);
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
  for (const state of ['try', 'ready'] as const) {
    store.updateTicket(t, { state });
    assert.match(runner.keptOpen(t)!, new RegExp(`state is ${state}`));
  }
  store.updateTicket(t, { state: 'try' });
  assert.match(runner.keptOpen(t, true)!, /state is try/);
  // Complete is finished work kept open on purpose (#547): unlike ready, close_self's own call refuses it too.
  store.updateTicket(t, { state: 'complete', note: 'read: the report' });
  assert.match(runner.keptOpen(t, true)!, /state is complete: it closes once a member has seen it/);
  assert.match(runner.keptOpen(t)!, /state is complete/);
  for (const state of [null, 'parked', 'pending-deploy'] as const) {
    store.updateTicket(t, { state });
    assert.equal(runner.keptOpen(t), null);
  }
  await endTurn(id, 'ok');
});

test('a pending approval card refuses close_self, even in state ready, with its link', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  await started(id);
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
  await started(id);
  store.updateTicket(id, { state: 'try' });
  assert.equal(runner.closeAfterTurn(id, null), false);
  assert.equal(store.getTicket(id)!.state, 'try');
  await endTurn(id, 'ok');
  assert.equal(store.getTicket(id)!.status, 'idle');
});

test('state ready with no card clears and dismisses (#480)', async () => {
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  await started(id);
  store.updateTicket(id, { state: 'ready', note: 'merged' });
  assert.equal(runner.keptOpen(id, true), null);
  assert.equal(runner.closeAfterTurn(id, 'Merged abc1234'), true);
  assert.equal(store.getTicket(id)!.state, null);
  await endTurn(id, 'ok');
  assert.equal(store.getTicket(id)!.status, 'closed');
  assert.deepEqual(notes(id), ['Claude dismissed this minion: Merged abc1234']);
});

test('a card posted or try/ready set after close_self keeps it open at the turn end', async () => {
  for (const after of ['ready', 'try', 'card'] as const) {
    const id = newTicket();
    runner.send(id, 'Cara', 'ship it');
    await started(id);
    assert.equal(runner.closeAfterTurn(id, null), true);
    if (after === 'card') store.addEvent(id, 'question', { id: 'q1', questions: [] });
    else store.updateTicket(id, { state: after });
    await endTurn(id, 'ok');
    assert.equal(store.getTicket(id)!.status, 'idle', after);
    const why = after === 'card' ? 'a question, plan or approval card is still waiting on people' : `its state is ${after}, which tells people something is waiting for them`;
    assert.deepEqual(notes(id), [`Claude asked to dismiss this minion, but ${why}, so it stays open.`]);
  }
});

test('a keep-open state set after close_self cancels the close at once, so the view stops saying it closes (#604)', async () => {
  for (const state of ['complete', 'try', 'ready'] as const) {
    const id = newTicket();
    runner.send(id, 'Cara', 'ship it');
    await started(id);
    assert.equal(runner.closeAfterTurn(id, null), true);
    store.updateTicket(id, { state, note: 'read: the report' });
    assert.match(runner.closeCancelled(id)!, new RegExp(`state is ${state}`), state);
    assert.equal(runner.view(store.getTicket(id)!).closing, false, state);
    // Nothing left to cancel the second time.
    assert.equal(runner.closeCancelled(id), null);
    await endTurn(id, 'ok');
    assert.equal(store.getTicket(id)!.status, 'idle', state);
    // One note, when it was cancelled; none again at the turn end.
    assert.equal(notes(id).length, 1, state);
    assert.match(notes(id)[0], new RegExp(`^Claude's close_self was cancelled: its state is ${state}[,:] .*so it stays open\\.$`), state);
  }
  // A state that doesn't keep it open leaves the close armed.
  const id = newTicket();
  runner.send(id, 'Cara', 'ship it');
  await started(id);
  runner.closeAfterTurn(id, null);
  store.updateTicket(id, { state: 'parked' });
  assert.equal(runner.closeCancelled(id), null);
  assert.equal(runner.view(store.getTicket(id)!).closing, true);
  await endTurn(id, 'ok');
  assert.equal(store.getTicket(id)!.status, 'closed');
});

test("a person's keep-open state cancels the close and the next turn is told; the minion's own state call isn't repeated (#619)", async () => {
  for (const byOther of [true, false]) {
    const id = newTicket();
    runner.send(id, 'Cara', 'ship it');
    await started(id);
    runner.closeAfterTurn(id, null);
    store.updateTicket(id, { state: 'ready' });
    runner.closeCancelled(id, byOther);
    await endTurn(id, 'ok');
    rmSync(join(root, 'prompts.log'), { force: true });
    runner.send(id, 'Cara', 'next');
    await until('the next prompt', async () => readFileSync(join(root, 'prompts.log'), { encoding: 'utf8', flag: 'a+' }).includes('next'));
    const told = /close_self in your last turn was cancelled: its state is ready/.test(readFileSync(join(root, 'prompts.log'), 'utf8'));
    assert.equal(told, byOther, String(byOther));
    await endTurn(id, 'ok');
  }
});

test('close() marks a ticket closed, as the coordinator does', () => {
  const id = newTicket();
  runner.close(id, 'Coordinator closed this ticket.');
  assert.equal(store.getTicket(id)!.status, 'closed');
  assert.deepEqual(notes(id), ['Coordinator closed this ticket.']);
});

test('a new turn clears complete with its note, since "nothing left" is stale once work starts; ready keeps its note (#547)', async () => {
  for (const [state, note] of [
    ['complete', null],
    ['ready', 'merged'],
  ] as const) {
    const id = newTicket();
    store.updateTicket(id, { state, note: state === 'complete' ? 'nothing left' : 'merged' });
    runner.send(id, 'Cara', 'one more thing');
    await started(id);
    assert.deepEqual([store.getTicket(id)!.state, store.getTicket(id)!.note], [null, note], state);
    await endTurn(id, 'ok');
  }
});

test("close_self's answer warns that the final status line counts, and says what to write if it stays open", () => {
  const said = closeSelfResult(false);
  assert.match(said, /status line/);
  assert.match(said, /complete, try or ready/);
  assert.match(said, /say plainly why/i);
  assert.doesNotMatch(said, /Closing this minion/);
  assert.match(closeSelfResult(true), /state ready cleared/);
});

// Close on seen (#811): a complete minion closes when a member leaves it having had it open since its last update.
const pause = () => new Promise((r) => setTimeout(r, 5));
function complete() {
  const id = newTicket();
  store.updateTicket(id, { state: 'complete', note: 'nothing left' });
  return id;
}

test('a complete, idle minion closes when a member leaves it, having seen its last update', async () => {
  const id = complete();
  await pause();
  store.markSeen('Cara', id);
  assert.equal(runner.closeIfSeen(id, 'Cara'), true);
  assert.equal(store.getTicket(id)!.status, 'closed');
  assert.deepEqual(notes(id), ['Closed: Cara saw its result']);
});

test('close on seen leaves it open with a card, in try or ready, mid-turn, or seen only before its last update', async () => {
  const seenFirst = complete();
  store.markSeen('Cara', seenFirst);
  await pause();
  store.updateTicket(seenFirst, { note: 'newer' });
  assert.equal(runner.closeIfSeen(seenFirst, 'Cara'), false, 'seen before the last update');

  const never = complete();
  assert.equal(runner.closeIfSeen(never, 'Cara'), false, 'never seen');

  const card = complete();
  store.addEvent(card, 'question', { id: 'q9', questions: [] });
  await pause();
  store.markSeen('Cara', card);
  assert.equal(runner.closeIfSeen(card, 'Cara'), false, 'open card');

  for (const state of ['try', 'ready', null] as const) {
    const id = newTicket();
    store.updateTicket(id, { state });
    await pause();
    store.markSeen('Cara', id);
    assert.equal(runner.closeIfSeen(id, 'Cara'), false, String(state));
  }

  const running = complete();
  runner.send(running, 'Cara', 'more'); // a new turn clears complete; set it again mid-turn
  await started(running);
  store.updateTicket(running, { state: 'complete' });
  await pause();
  store.markSeen('Cara', running);
  assert.equal(runner.closeIfSeen(running, 'Cara'), false, 'mid-turn');
  await endTurn(running, 'ok');
});
