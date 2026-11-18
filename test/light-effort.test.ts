import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { lines, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// #951: a minion's turn whose whole batch is machine notices of success (`light`) launches with --effort low;
// a person's message, a failure notice or a mixed batch keeps the minion's own effort. The fake claude logs
// each launch's --effort and every message it reads, and answers once `release` is in its folder.
const root = mkdtempSync(join(tmpdir(), 'light-effort-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, rmSync } = require('node:fs');
const i = process.argv.indexOf('--effort');
appendFileSync('effort.txt', (i < 0 ? 'none' : process.argv[i + 1]) + '\\n');
let replied = false;
let closed = false;
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  for (const b of JSON.parse(l).message.content) if (!b.text.startsWith('[System]: You are a minion working on #')) appendFileSync('seen.txt', b.text + '\\n');
});
rl.on('close', () => (closed = true));
setInterval(() => {
  if (!replied && existsSync('release')) {
    replied = true;
    rmSync('release');
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  }
  if (replied && closed) process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);

function minion() {
  const t = store.createTicket({ project_id: project.id, kind: 'thread', title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(t.id, { effort: 'high' });
  const dir = join(root, `t${t.id}`);
  mkdirSync(dir);
  store.setTicketDir(t.id, dir, null);
  const r = new Runner(store, () => {}, () => ({}), fake);
  r.pollMs = 10;
  return { id: t.id, dir, r, efforts: () => lines(join(dir, 'effort.txt')), seen: () => lines(join(dir, 'seen.txt')) };
}

/** Let the running turn answer; with `done`, also wait for it to end (nothing else queued). */
const release = async (m: ReturnType<typeof minion>, done = true) => {
  writeFileSync(join(m.dir, 'release'), '');
  await until("!existsSync(join(m.dir, 'release')) && (!done || !m.r.isRunning(m.id))", () => !existsSync(join(m.dir, 'release')) && (!done || !m.r.isRunning(m.id)));
};
const LANDED = 'Your handed-off land went through (abc1234, live now).';

test('a batch of only success notices launches at low effort, and its steps and launch record low', async () => {
  const m = minion();
  m.r.send(m.id, 'Citadel', LANDED, [], { light: true });
  await until('m.efforts().length === 1', () => m.efforts().length === 1);
  assert.deepEqual(m.efforts(), ['low']);
  const turn = store.getSetting<any>(`turn:${m.id}`);
  assert.equal(turn.light, true);
  assert.equal(turn.hashes.effort, 'low', 'the turn row records the effort it ran at');
  await release(m);
});

test("a failure notice, or a person's message, keeps the minion's own effort", async () => {
  const m = minion();
  m.r.send(m.id, 'Citadel', "Your handed-off land didn't go through: tools/land.sh exited 1.");
  await until('m.efforts().length === 1', () => m.efforts().length === 1);
  await release(m);
  m.r.send(m.id, 'Cara', 'how is it going?', [], { typed: true });
  await until('m.efforts().length === 2', () => m.efforts().length === 2);
  await release(m);
  assert.deepEqual(m.efforts(), ['high', 'high']);
});

test("a success notice batched with a person's message keeps the minion's own effort", async () => {
  const m = minion();
  m.r.send(m.id, 'Cara', 'build it', [], { typed: true });
  await until('m.efforts().length === 1', () => m.efforts().length === 1);
  // Both queue behind the running turn and go to the next one together.
  m.r.send(m.id, 'Citadel', LANDED, [], { light: true });
  m.r.send(m.id, 'Cara', 'and then the docs', [], { typed: true });
  await release(m, false);
  await until('m.efforts().length === 2', () => m.efforts().length === 2);
  assert.deepEqual(m.efforts(), ['high', 'high']);
  await until("m.seen().includes('[Cara]: and then the docs')", () => m.seen().includes('[Cara]: and then the docs'));
  await release(m);
});

test("a person's message doesn't steer into a low-effort turn: it waits for a turn at the minion's own effort", async () => {
  const m = minion();
  m.r.send(m.id, 'Citadel', LANDED, [], { light: true });
  await until('m.seen().length === 1', () => m.seen().length === 1);
  m.r.send(m.id, 'Cara', 'one more thing', [], { typed: true }, true);
  await until('the message queued behind the turn', () => m.r.queued(m.id) === 1);
  assert.equal(m.seen().length, 1, 'not steered in');
  await release(m, false);
  await until('m.efforts().length === 2', () => m.efforts().length === 2);
  assert.deepEqual(m.efforts(), ['low', 'high']);
  await until("m.seen().includes('[Cara]: one more thing')", () => m.seen().includes('[Cara]: one more thing'));
  await release(m);
});
