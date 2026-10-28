import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { MAX_RESUMES, Runner } from '../src/runner.ts';

// A stand-in for `claude -p` that logs each prompt it gets and runs until a release file appears.
const root = mkdtempSync(join(tmpdir(), 'auto-resume-'));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
const prompts = join(root, 'prompts.log');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync } = require('node:fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => appendFileSync(${JSON.stringify(prompts)}, input));
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
  return r;
}

function newTicket() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  return t.id;
}

/** The server dies mid-turn: its claude process goes with it, and nothing records the turn's end. */
function crash(r: Runner, id: number) {
  const proc = (r as any).procs.get(id);
  proc.removeAllListeners('close');
  process.kill(-proc.pid, 'SIGKILL');
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
  crash(before, id);
  writeFileSync(prompts, '');

  const after = server();
  after.recover();
  assert.equal(store.getTicket(id)!.status, 'idle');
  await until(() => after.isRunning(id));
  assert.ok(notes(id).includes('Resumed after a server restart'));
  await until(() => existsSync(prompts) && readFileSync(prompts, 'utf8').includes('also add a test'));
  const prompt = readFileSync(prompts, 'utf8');
  assert.match(prompt, /\[System\]: The Overlord server restarted while you were working/);
  assert.match(prompt, /\[Josh\]: also add a test/);
  await finish(after, id);
  assert.equal(store.getSetting(`turn:${id}`), null);
});

test('a stopped turn is not resumed, even if the server restarts before it ends', async () => {
  const id = newTicket();
  const before = server();
  before.send(id, 'Cara', 'build it');
  before.send(id, 'Cara', 'never mind');
  const proc = (before as any).procs.get(id);
  proc.removeAllListeners('close');
  before.stop(id);
  process.kill(-proc.pid, 'SIGKILL');

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
    crash(r, id);
    r = server();
    r.recover();
    await until(() => r.isRunning(id));
  }
  crash(r, id);
  r = server();
  r.recover();
  await settle();
  assert.equal(r.isRunning(id), false);
  assert.equal(notes(id).filter((n) => n === 'Resumed after a server restart').length, MAX_RESUMES);
  assert.match(notes(id).at(-1)!, /already been resumed 2 times in a row/);

  // A turn that ends on its own resets the count.
  r.send(id, 'Cara', 'try again');
  crash(r, id);
  r = server();
  r.recover();
  await until(() => r.isRunning(id));
  await finish(r, id);
});
