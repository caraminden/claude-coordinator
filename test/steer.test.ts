import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner, unsentSteers } from '../src/runner.ts';
import { lines, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// Mid-turn messages steer: the runner appends them to the turn's steer.jsonl and the wrapper
// (src/turn-wrapper.mjs) passes them to claude's stdin until the turn's result is out. The fake reads
// stdin line by line like claude, replies once `release` appears in its folder, and exits at the end
// of its input (or, with `hold` there, only once that is gone).
const root = mkdtempSync(join(tmpdir(), 'steer-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
let replied = false;
let closed = false;
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  // Past the [System] note of the minion's own lines that opens a turn's first message (#878).
  const text = JSON.parse(l).message.content.find((b) => !b.text.startsWith('[System]: You are a minion working on #')).text;
  appendFileSync('seen.txt', text + '\\n');
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'got ' + text }] } }));
});
rl.on('close', () => (closed = true));
setInterval(() => {
  if (!replied && existsSync('release')) {
    replied = true;
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
    writeFileSync('replied', '');
  }
  if (replied && closed && !existsSync('hold')) process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);

function server() {
  const r = new Runner(store, () => {}, () => ({}), fake);
  r.pollMs = 10;
  return r;
}

/** A ticket with a folder of its own, where its fake claude reads and writes. */
function newTicket(kind: 'thread' | 'coordinator' = 'thread') {
  const t = store.createTicket({ project_id: project.id, kind, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const dir = join(root, `t${t.id}`);
  mkdirSync(dir);
  store.setTicketDir(t.id, dir, null);
  return { id: t.id, dir };
}

const seen = (dir: string) => lines(join(dir, 'seen.txt'));
const events = (id: number, kind: string) => store.listEvents(id).filter((e) => e.kind === kind).map((e) => ({ id: e.id, ...JSON.parse(e.data) }));
const turnDir = (r: Runner, id: number): string => (r as any).turns.get(id).dir;

/** Start a turn with Cara's first message, and wait until claude has it. */
async function started(r: Runner, t: { id: number; dir: string }) {
  r.send(t.id, 'Cara', 'build it');
  await until('seen(t.dir).length === 1', () => seen(t.dir).length === 1);
}

test('a steer reaches the running turn, and nothing is left for a next turn', async () => {
  const t = newTicket();
  const r = server();
  await started(r, t);
  r.send(t.id, 'Cara', 'use tabs instead', [], {}, true);
  await until('seen(t.dir).length === 2', () => seen(t.dir).length === 2);
  assert.deepEqual(seen(t.dir), ['[Cara]: build it', '[Cara]: use tabs instead']);
  assert.equal(r.queued(t.id), 0);
  assert.equal(events(t.id, 'user_message')[1].steered, true);
  writeFileSync(join(t.dir, 'release'), '');
  await until('!r.isRunning(t.id)', () => !r.isRunning(t.id));
  assert.equal(store.getTicket(t.id)!.status, 'idle');
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(!r.isRunning(t.id), 'no second turn');
});

test('"Send after this turn" queues, and the queued message starts the next turn', async () => {
  const t = newTicket();
  const r = server();
  await started(r, t);
  r.send(t.id, 'Cara', 'later please');
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(seen(t.dir).length, 1, 'not passed to the running turn');
  assert.equal(r.queued(t.id), 1);
  assert.equal(events(t.id, 'user_message')[1].steered, undefined);
  writeFileSync(join(t.dir, 'release'), '');
  await until('seen(t.dir).length === 2', () => seen(t.dir).length === 2);
  assert.equal(seen(t.dir)[1], '[Cara]: later please');
  await until('!r.isRunning(t.id)', () => !r.isRunning(t.id));
});

test('a steer still lands after a restart re-attached to the turn', async () => {
  const t = newTicket();
  const before = server();
  await started(before, t);
  before.detachAll();
  const next = server();
  next.recover();
  assert.ok(next.isRunning(t.id));
  next.send(t.id, 'Cara', 'after the restart', [], {}, true);
  await until('seen(t.dir).length === 2', () => seen(t.dir).length === 2);
  writeFileSync(join(t.dir, 'release'), '');
  await until('!next.isRunning(t.id)', () => !next.isRunning(t.id));
});

test('a steer that came in as the reply went out starts the next turn', async () => {
  const t = newTicket();
  const r = server();
  await started(r, t);
  // The runner hasn't read the result yet, but the wrapper has, and has closed claude's input.
  r.pollMs = 1e6;
  const dir = turnDir(r, t.id); // taken now: the turn can end in the gap below, and the runner then forgets it
  clearInterval((r as any).turns.get(t.id).timer);
  writeFileSync(join(t.dir, 'hold'), '');
  writeFileSync(join(t.dir, 'release'), '');
  await until("existsSync(join(t.dir, 'replied'))", () => existsSync(join(t.dir, 'replied')));
  await new Promise((res) => setTimeout(res, 600));
  r.send(t.id, 'Cara', 'just too late', [], {}, true);
  rmSync(join(t.dir, 'hold'));
  r.pollMs = 10; // before the first poll: if claude has already exited, that poll starts the next turn, which needs a real timer
  (r as any).poll(t.id);
  // Over when its exit.json is there, or already handled by that poll (the runner then drops the turn and its folder).
  await until("existsSync(join(dir, 'exit.json')) || (r as any).turns.get(t.id)?.dir !== dir", () => existsSync(join(dir, 'exit.json')) || (r as any).turns.get(t.id)?.dir !== dir);
  (r as any).poll(t.id); // ends the turn if the first poll came before claude's exit; otherwise it follows the next turn
  await until('seen(t.dir).length === 2', () => seen(t.dir).length === 2);
  assert.equal(seen(t.dir)[1], '[Cara]: just too late');
  assert.ok(events(t.id, 'note').some((n) => /arrived as the turn ended/.test(n.text)));
  await until('!r.isRunning(t.id)', () => !r.isRunning(t.id));
});

test('a message sent after Stop, before the turn has died, queues for a turn of its own (#468 S03-1)', async () => {
  const t = newTicket();
  const r = server();
  await started(r, t);
  assert.equal(r.stop(t.id), true);
  // The stopped turn is still followed until its process exits: a steer into it would be dropped.
  assert.ok(r.isRunning(t.id));
  r.send(t.id, 'Cara', 'do this instead', [], {}, true);
  assert.equal(events(t.id, 'user_message')[1].steered, undefined, 'not steered into the dying turn');
  await until('seen(t.dir).length === 2', () => seen(t.dir).length === 2);
  assert.equal(seen(t.dir)[1], '[Cara]: do this instead');
  writeFileSync(join(t.dir, 'release'), '');
  await until('!r.isRunning(t.id)', () => !r.isRunning(t.id));
});

test('a message queued after Stop survives a restart that finds the stopped turn gone (#468 S03-1)', async () => {
  const t = newTicket();
  const r = server();
  r.resumeGapMs = 10;
  store.updateTicket(t.id, { status: 'running' });
  store.setSetting(`turn:${t.id}`, { resumes: 0, stopped: true });
  store.setSetting(`minion-queue:${t.id}`, { msgs: [{ author: 'Cara', text: 'after the stop', images: [] }] });
  r.recover();
  await until('seen(t.dir).length === 1', () => seen(t.dir).length === 1);
  assert.equal(seen(t.dir)[0], '[Cara]: after the stop');
  writeFileSync(join(t.dir, 'release'), '');
  await until('!r.isRunning(t.id)', () => !r.isRunning(t.id));
});

test('the Taskmaster steers its minion; a minion\'s message to a busy Taskmaster queues', async () => {
  const coord = newTicket('coordinator');
  const t = newTicket();
  const r = server();
  await started(r, t);
  r.relay(t.id, t.id, 'Taskmaster', 'stop and rebase');
  await until('seen(t.dir).length === 2', () => seen(t.dir).length === 2);
  assert.equal(seen(t.dir)[1], '[Taskmaster]: stop and rebase');

  await started(r, coord);
  r.relay(t.id, coord.id, '#2 T', 'done with it');
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(seen(coord.dir).length, 1);
  assert.equal(r.queued(coord.id), 1);
  for (const x of [t, coord]) writeFileSync(join(x.dir, 'release'), '');
  await until('!r.isRunning(t.id) && seen(coord.dir).length === 2', () => !r.isRunning(t.id) && seen(coord.dir).length === 2);
});

test('✕ takes back a queued message, which then never reaches claude', async () => {
  const t = newTicket();
  const r = server();
  await started(r, t);
  r.send(t.id, 'Cara', 'never mind this');
  const msg = events(t.id, 'user_message')[1];
  assert.deepEqual(r.view(store.getTicket(t.id)!).queued_ids, [msg.id]);
  assert.equal(r.unqueue(t.id, msg.id, 'Cara'), true);
  assert.equal(r.unqueue(t.id, msg.id, 'Cara'), false, 'only once');
  assert.equal(r.queued(t.id), 0);
  assert.deepEqual(events(t.id, 'unqueued').map((e) => [e.id, e.by]), [[msg.id, 'Cara']]);
  assert.equal(store.getSetting<any>(`minion-queue:${t.id}`)?.msgs, undefined, 'a restart would not bring it back');
  writeFileSync(join(t.dir, 'release'), '');
  await until('!r.isRunning(t.id)', () => !r.isRunning(t.id));
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(!r.isRunning(t.id));
  assert.equal(seen(t.dir).length, 1);
});

test('a turn started before steering existed (no steer.jsonl) queues instead', async () => {
  const t = newTicket();
  const r = server();
  await started(r, t);
  rmSync(join(turnDir(r, t.id), 'steer.jsonl'));
  r.send(t.id, 'Cara', 'old turn', [], {}, true);
  assert.equal(r.queued(t.id), 1);
  assert.equal(events(t.id, 'user_message')[1].steered, undefined);
  writeFileSync(join(t.dir, 'release'), '');
  await until('seen(t.dir).length === 2', () => seen(t.dir).length === 2);
  await until('!r.isRunning(t.id)', () => !r.isRunning(t.id));
});

test('a reader never sees steer.sent empty or half-written while steers go in', async () => {
  const t = newTicket();
  const r = server();
  await started(r, t);
  const sentFile = join(turnDir(r, t.id), 'steer.sent');
  // A process of its own reading as fast as it can, as the runner would on a restart mid-write.
  const reader = spawn(process.execPath, ['-e', `
    const { readFileSync } = require('node:fs');
    const bad = new Set();
    let reads = 0;
    const { existsSync } = require('node:fs');
    console.log('ready');
    while (!existsSync(${JSON.stringify(sentFile + '.stop')})) {
      try { const s = readFileSync(${JSON.stringify(sentFile)}, 'utf8'); reads++; if (!/^\\d+$/.test(s)) bad.add(s); } catch {}
    }
    console.log(JSON.stringify({ reads, bad: [...bad] }));
  `]);
  let out = '';
  reader.stdout.on('data', (d) => (out += d));
  const exited = new Promise((res) => reader.on('exit', res));
  await until("out.includes('ready')", () => out.includes('ready')); // the reader is spinning before the first steer goes in
  // Each steer waits until the wrapper has passed it on (it writes steer.sent then), so every write is read against.
  try {
    for (let i = 0; i < 6; i++) {
      r.send(t.id, 'Cara', `steer ${i}`, [], {}, true);
      await until('seen(t.dir).length === i + 2', () => seen(t.dir).length === i + 2);
    }
  } finally {
    writeFileSync(sentFile + '.stop', ''); // the reader spins until this exists, even when a steer never arrives
  }
  await exited;
  const { reads, bad } = JSON.parse(out.replace('ready\n', ''));
  assert.ok(reads > 0, 'the reader saw steer.sent');
  assert.deepEqual(bad, []);
  writeFileSync(join(t.dir, 'release'), '');
  await until('!r.isRunning(t.id)', () => !r.isRunning(t.id));
});

test('an unreadable steer.sent redelivers nothing; a missing one, everything', () => {
  const dir = mkdtempSync(join(root, 'sent-'));
  const msg = (text: string) => ({ author: 'Cara', text }) as any;
  const turn = { dir, steered: [{ end: 10, msg: msg('a') }, { end: 20, msg: msg('b') }] };
  assert.deepEqual(unsentSteers(turn).map((m) => m.text), ['a', 'b'], 'none passed on yet');
  writeFileSync(join(dir, 'steer.sent'), '10');
  assert.deepEqual(unsentSteers(turn).map((m) => m.text), ['b']);
  writeFileSync(join(dir, 'steer.sent'), '20');
  assert.deepEqual(unsentSteers(turn), []);
  for (const junk of ['', '1x', ' ', '-3', '1e3']) {
    writeFileSync(join(dir, 'steer.sent'), junk);
    assert.deepEqual(unsentSteers(turn), [], `"${junk}" is unknown, not 0`);
  }
});
