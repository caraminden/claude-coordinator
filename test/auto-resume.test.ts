import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { MAX_RESUMES, Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
testPins();

// A stand-in for `claude -p` that logs each prompt it gets and runs until a release file appears. It ignores
// SIGTERM, as a claude still writing its reply may for a while: otherwise a stop could end the turn, and
// delete its folder, before the test's crash finds pid.json (#470; crash's SIGKILLs still end it).
const root = mkdtempSync(join(tmpdir(), 'auto-resume-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
const prompts = join(root, 'prompts.log');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync } = require('node:fs');
process.on('SIGTERM', () => {});
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => appendFileSync(${JSON.stringify(prompts)}, input + '\\n'));
const wait = setInterval(() => {
  if (!existsSync(${JSON.stringify(join(root, 'release'))})) return;
  clearInterval(wait);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);

/** A runner as a freshly started server would make it. */
function server() {
  const r = new Runner(store, () => {}, () => ({}), fake);
  r.resumeGapMs = 10;
  r.pollMs = 10;
  return r;
}

function newTicket() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  return t.id;
}

/** The server dies mid-turn and its turn goes with it (no unit, or the unit died too): nothing records the turn's end. */
async function crash(r: Runner, id: number) {
  const dir: string = (r as any).turns.get(id).dir;
  await until(() => existsSync(join(dir, 'pid.json')));
  r.detachAll();
  const { wrapper, claude } = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8'));
  for (const pid of [wrapper, -claude]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  // A killed process lingers for a moment; the next server must find it dead, as it would after a real crash.
  await until(() => !existsSync(`/proc/${wrapper}`) || !readFileSync(`/proc/${wrapper}/cmdline`, 'utf8').includes(dir));
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), 'timed out');
}

async function finish(r: Runner, id: number) {
  writeFileSync(join(root, 'release'), '');
  await until(() => !r.isRunning(id));
  rmSync(join(root, 'release'), { force: true });
}

const notes = (id: number) => store.listEvents(id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string);
const settle = () => new Promise((r) => setTimeout(r, 200));

test('an interrupted turn resumes after a restart, with the messages queued behind it', async () => {
  const id = newTicket();
  const before = server();
  before.send(id, 'Cara', 'build it');
  before.send(id, 'Josh', 'also add a test');
  assert.equal(before.queued(id), 1);
  await crash(before, id);
  writeFileSync(prompts, '');

  const after = server();
  after.recover();
  assert.equal(store.getTicket(id)!.status, 'idle');
  await until(() => after.isRunning(id));
  assert.ok(notes(id).includes('Resumed after a server restart'));
  await until(() => existsSync(prompts) && readFileSync(prompts, 'utf8').includes('also add a test'));
  const prompt = readFileSync(prompts, 'utf8');
  assert.match(prompt, /\[System\]: The \S+ server restarted while you were working/);
  assert.match(prompt, /\[Josh\]: also add a test/);
  await finish(after, id);
  assert.equal(store.getSetting(`turn:${id}`), null);
});

test('a stopped turn is not resumed, even if the server restarts before it ends', async () => {
  const id = newTicket();
  writeFileSync(prompts, '');
  const before = server();
  before.send(id, 'Cara', 'build it');
  before.send(id, 'Cara', 'never mind');
  // Stopped once its claude has its prompt, and so its SIGTERM handler: a stop while it still starts lands as it starts (#470).
  await until(() => readFileSync(prompts, 'utf8').includes('build it'));
  before.stop(id);
  await crash(before, id);

  const after = server();
  after.recover();
  await settle();
  assert.equal(after.isRunning(id), false);
  assert.equal(store.getTicket(id)!.status, 'idle');
  assert.ok(!notes(id).some((n) => n.startsWith('Resumed')));
});

test(`a thread is resumed at most ${MAX_RESUMES} times in a row`, async () => {
  const id = newTicket();
  let r = server();
  r.send(id, 'Cara', 'build it');
  for (let i = 0; i < MAX_RESUMES; i++) {
    await crash(r, id);
    r = server();
    r.recover();
    await until(() => r.isRunning(id));
  }
  await crash(r, id);
  r = server();
  r.recover();
  await settle();
  assert.equal(r.isRunning(id), false);
  assert.equal(notes(id).filter((n) => n === 'Resumed after a server restart').length, MAX_RESUMES);
  assert.match(notes(id).at(-1)!, /already been resumed 2 times in a row/);

  // A turn that ends on its own resets the count.
  r.send(id, 'Cara', 'try again');
  await crash(r, id);
  r = server();
  r.recover();
  await until(() => r.isRunning(id));
  await finish(r, id);
});

test('a resume still owed when the server restarts again is resumed by the next server, queue and all (#468 S03-8)', async () => {
  const id = newTicket();
  const first = server();
  first.send(id, 'Cara', 'build it');
  first.send(id, 'Josh', 'and the docs');
  await crash(first, id);
  writeFileSync(prompts, '');

  // The second server dies before this minion's slot in its staggered resumes comes up.
  const second = server();
  (second as any).resume = () => {};
  second.recover();
  await settle();
  assert.equal(store.getTicket(id)!.status, 'idle');
  second.detachAll();

  const third = server();
  third.recover();
  await until(() => third.isRunning(id));
  await until(() => existsSync(prompts) && readFileSync(prompts, 'utf8').includes('and the docs'));
  assert.match(readFileSync(prompts, 'utf8'), /\[System\]: The \S+ server restarted while you were working/);
  await finish(third, id);
  assert.equal(store.getSetting(`resume-owed:${id}`), null, 'the debt is paid once the resume starts');
});

test("messages queued behind a cut-off turn that isn't resumed outlive a second restart (#468 S03-8)", async () => {
  const id = newTicket();
  let r = server();
  r.send(id, 'Cara', 'build it');
  r.send(id, 'Josh', 'queued behind it');
  // Set to be dismissed: the restart doesn't resume it, but what was queued gets a turn of its own.
  (r as any).saveTurn(id, { closing: null });
  await crash(r, id);
  writeFileSync(prompts, '');
  r = server();
  (r as any).next = () => {};
  r.recover();
  await settle();
  r.detachAll();
  r = server();
  r.recover();
  await until(() => existsSync(prompts) && readFileSync(prompts, 'utf8').includes('queued behind it'));
  await finish(r, id);
});
