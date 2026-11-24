import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { lines, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// A turn that never starts gives its batch back (#1378): nothing a person sent is lost to a start that bailed.
// The fake writes each message it reads to seen.txt in its folder, replies, and exits at the end of its input.
const root = mkdtempSync(join(tmpdir(), 'give-back-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  for (const b of JSON.parse(l).message.content) if (!b.text.startsWith('[System]: You are a minion working on #')) appendFileSync('seen.txt', b.text + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
});
rl.on('close', () => process.exit(0));
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

function minion(withDir: boolean) {
  const t = store.createTicket({ project_id: project.id, kind: 'ticket', title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const dir = join(root, `t${t.id}`);
  mkdirSync(dir);
  if (withDir) store.setTicketDir(t.id, dir, null);
  return { id: t.id, dir };
}
const seen = (dir: string) => lines(join(dir, 'seen.txt'));
const idle = (id: number) => until('the turn and its save to end', () => !runner.isRunning(id) && !(runner as any).lanes.busy(id));

test('a minion with no folder runs no turn, and keeps the message for the turn once it has one', async () => {
  const t = minion(false);
  // As when Citadel can't make its worktree again (a repo that's gone, git failing).
  const restore = (runner as any).restoreDir;
  (runner as any).restoreDir = () => {};
  try {
    runner.send(t.id, 'Cara', 'first');
    await idle(t.id);
  } finally {
    (runner as any).restoreDir = restore;
  }
  assert.equal(runner.isRunning(t.id), false);
  assert.deepEqual(
    runner.queue.heldMail(t.id).map((m) => m.text),
    ['first'],
    'held, so the freed lane asks for no turn again',
  );
  store.setTicketDir(t.id, t.dir, null);
  runner.send(t.id, 'Cara', 'second');
  await until('the turn', () => seen(t.dir).length === 2);
  assert.deepEqual(seen(t.dir), ['[Cara]: second', '[Cara]: first']);
  await idle(t.id);
  assert.equal(store.getSetting(`minion-queue:${t.id}`), null, 'nothing left in the queue once the turn is saved');
});

test("a launch that can't be built fails the turn, and its message rides along with the next one", async () => {
  const t = minion(true);
  const build = runner.buildLaunch;
  runner.buildLaunch = () => {
    throw new Error('settings file too big');
  };
  try {
    runner.send(t.id, 'Cara', 'first');
    await idle(t.id);
  } finally {
    runner.buildLaunch = build;
  }
  assert.equal(store.getTicket(t.id)!.status, 'error');
  assert.deepEqual(
    runner.queue.heldMail(t.id).map((m) => m.text),
    ['first'],
  );
  runner.send(t.id, 'Cara', 'second');
  await until('the turn', () => seen(t.dir).length === 2);
  assert.deepEqual(seen(t.dir), ['[Cara]: second', '[Cara]: first']);
  await idle(t.id);
});

// Review of #1378: a restart never gives back a batch its turn already answered, nor one a stop dropped.
test('a crash after a turn ended, before its save, redoes the save and never reruns the answered batch', async () => {
  for (const status of ['idle', 'running'] as const) {
    const t = minion(true);
    store.updateTicket(t.id, { status });
    // As wrapUp leaves it between its first writes: the save owed, the turn's record gone, its batch still taken.
    store.setSetting(`minion-queue:${t.id}`, { taken: [{ author: 'Cara', text: 'merge it', images: [] }] });
    store.setSetting(`saving:${t.id}`, { configDir: join(root, 'no-such-config') });
    runner.recover();
    await until('the save to be redone', () => store.getSetting(`saving:${t.id}`) === null);
    // A running one is owed its resume, as before #1378: a bare resume, without the batch.
    await until('a resume to run, if owed', () => store.getSetting(`minion-queue:${t.id}`) === null);
    await idle(t.id);
    assert.ok(!seen(t.dir).includes('[Cara]: merge it'), `${status}: ${seen(t.dir).join(' | ')}`);
    assert.equal(store.getSetting(`minion-queue:${t.id}`), null, status);
  }
});

test("a turn stopped before its process ran, then a restart: the stop's batch stays dropped", async () => {
  const t = minion(true);
  const dir = join(root, `turn${t.id}`);
  mkdirSync(dir);
  store.updateTicket(t.id, { status: 'running' });
  store.setSetting(`turn:${t.id}`, { resumes: 0, dir, stopped: true, container: true });
  store.setSetting(`minion-queue:${t.id}`, { taken: [{ author: 'Cara', text: 'never mind', images: [] }] });
  runner.recover();
  await idle(t.id);
  assert.ok(!seen(t.dir).includes('[Cara]: never mind'));
  assert.equal(store.getSetting(`minion-queue:${t.id}`), null);
});

// #1364's rule on #1378's queue: a turn cut off before claude wrote a line may never have had its prompt, so its batch
// runs again as a plain turn, not a resume. That covers a turn saved but not yet shown as running when the server died.
test('a turn cut off before its first line reruns its batch as a plain turn, running or not yet shown so', async () => {
  for (const status of ['running', 'idle'] as const) {
    const t = minion(true);
    const dir = join(root, `turn${t.id}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'pid.json'), JSON.stringify({ wrapper: 2147483646, claude: 2147483646 }));
    writeFileSync(join(dir, 'stream.jsonl'), '');
    store.updateTicket(t.id, { status });
    store.setSetting(`turn:${t.id}`, { resumes: 0, dir, offset: 0, startedAt: Date.now() });
    store.setSetting(`minion-queue:${t.id}`, { taken: [{ author: 'Cara', text: 'build it', images: [] }] });
    runner.recover();
    await until('the rerun', () => seen(t.dir).includes('[Cara]: build it'));
    await idle(t.id);
    const notes = store
      .listEvents(t.id)
      .filter((e) => e.kind === 'note')
      .map((e) => JSON.parse(e.data).text as string);
    assert.ok(!notes.some((n) => n.startsWith('Resumed')), `${status}: ${notes.join(' | ')}`);
    assert.equal(store.getSetting(`turn:${t.id}`), null, status);
    assert.equal(store.getSetting(`minion-queue:${t.id}`), null, status);
  }
});
