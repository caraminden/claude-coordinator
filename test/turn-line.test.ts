import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { lines, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// #1868: one pool of workers for all of Citadel's minion turns (Josh, 2026-11-24: "we have a pool of claude sessions that
// are capped across the whole citadel"). A turn past the pool waits in a line and starts as workers free.
//
// Fake `claude -p`: logs its minion and prompt, then runs until a file named for its minion is there.
const root = mkdtempSync(join(tmpdir(), 'turn-line-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
const prompts = join(root, 'prompts.log');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync } = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  appendFileSync(${JSON.stringify(prompts)}, process.env.TEST_MINION + ' ' + input + '\\n');
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }));
  setInterval(() => {
    if (!existsSync(${JSON.stringify(root)} + '/end-' + process.env.TEST_MINION)) return;
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
    process.exit(0);
  }, 10);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const cara = store.createUser({ name: 'Cara', login: 'cara' });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
store.addMember(project.id, cara.id);
store.addMember(project.id, josh.id);

const inside = (r: Runner) => r as unknown as { turns: Map<number, { dir: string }>; launchTurn: () => Promise<unknown> };

function makeRunner() {
  const r = new Runner(
    store,
    () => {},
    (t: { id: number }) => ({ TEST_MINION: String(t.id) }),
    fake,
  );
  r.pollMs = 10;
  r.resumeGapMs = 0;
  r.personOf = (author) => (author === 'Josh' ? josh.id : author === 'Cara' ? cara.id : null);
  r.placeFor = () => ({ host: true });
  return r;
}
let runner = makeRunner();

const made: number[] = [];
function minion(coordinator = false, by = 'Cara') {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: by, ...(coordinator ? { kind: 'coordinator' as const } : {}) });
  store.setTicketDir(t.id, root, null);
  made.push(t.id);
  return t.id;
}
/** The scheme's one Taskmaster, its turns before forgotten. */
let tm = 0;
function taskmaster() {
  tm ||= minion(true);
  if (!made.includes(tm)) made.push(tm);
  unend(tm);
  return tm;
}
const end = (id: number) => writeFileSync(join(root, `end-${id}`), '');
const unend = (id: number) => rmSync(join(root, `end-${id}`), { force: true });
const turnsOf = (id: number) => lines(prompts).filter((l) => l.startsWith(`${id} `));
const started = (id: number) => until(`minion ${id} to start`, () => turnsOf(id).length > 0);
const idle = (id: number) => until(`minion ${id} to finish`, () => !runner.isRunning(id) && store.getTicket(id)!.status !== 'running');
/** A moment in which nothing more should start. */
const settle = () => new Promise((r) => setTimeout(r, 150));
const say = (id: number, text = 'hello', by = 'Cara') => runner.send(id, by, text, [], { typed: true });

/** Everything from the test before ends, and the pool is fixed at `n` and empty. */
beforeEach(async () => {
  runner.turnLine.setPause(false, 'Cara');
  runner.turnLine.setSize(50, 'Cara');
  for (const id of made) end(id);
  await until('the minions before to finish', () => made.every((id) => !runner.isRunning(id)) && runner.turnLine.waiting().length === 0);
  made.length = 0;
});

test('turns past the pool wait, and start in order as workers free', async () => {
  runner.turnLine.setSize(2, 'Cara');
  const ids = [minion(), minion(), minion(), minion()];
  for (const id of ids) say(id, `hello ${id}`);
  await started(ids[0]);
  await started(ids[1]);
  await settle();
  assert.deepEqual([turnsOf(ids[2]).length, turnsOf(ids[3]).length], [0, 0], 'the pool is full');
  assert.deepEqual(runner.turnLine.waiting(), [ids[2], ids[3]]);
  assert.equal(runner.isRunning(ids[2]), false, 'a waiting minion has no process');
  end(ids[0]);
  await started(ids[2]);
  await settle();
  assert.equal(turnsOf(ids[3]).length, 0);
  end(ids[1]);
  await started(ids[3]);
  assert.match(turnsOf(ids[3])[0], new RegExp(`hello ${ids[3]}`));
  assert.equal(runner.turnLine.used(), 2);
});

test('messages sent while it waits are saved and all go into its one turn', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, b] = [minion(), minion()];
  say(a);
  await started(a);
  say(b, 'first words');
  say(b, 'second words');
  assert.equal(store.listEvents(b).filter((e) => e.kind === 'user_message').length, 2, 'both show at once');
  end(a);
  await started(b);
  assert.match(turnsOf(b)[0], /first words[\s\S]*second words/);
  end(b);
  await idle(b);
  assert.equal(turnsOf(b).length, 1);
});

test('a Taskmaster starts at once with the pool full, and takes no worker', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const a = minion();
  say(a);
  await started(a);
  const tm = taskmaster();
  say(tm);
  await started(tm);
  assert.equal(runner.turnLine.used(), 1);
});

test("a person's own message goes ahead of automatic work in their share", async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, auto, own] = [minion(), minion(), minion()];
  say(a);
  await started(a);
  store.updateTicket(auto, { person_id: cara.id });
  runner.send(auto, 'Citadel', 'CI passed');
  say(own);
  end(a);
  await started(own);
  await settle();
  assert.equal(turnsOf(auto).length, 0);
  end(own);
  await started(auto);
});

test("a freed worker goes to whoever is furthest below their share, which grows with what they have waiting", async () => {
  runner.turnLine.setSize(5, 'Cara');
  const caras = [minion(), minion(), minion(), minion(), minion()];
  for (const id of caras) say(id);
  for (const id of caras) await started(id);
  const joshs = [minion(false, 'Josh'), minion(false, 'Josh'), minion(false, 'Josh'), minion(false, 'Josh'), minion(false, 'Josh'), minion(false, 'Josh')];
  const more = minion();
  say(more); // Cara's was first in line, but Josh has no worker yet.
  for (const id of joshs) say(id, 'hello', 'Josh');
  for (const n of [1, 2, 3]) {
    end(caras[n - 1]);
    await until(`Josh's share ${n}`, () => joshs.filter((id) => turnsOf(id).length).length === n);
  }
  assert.equal(turnsOf(more).length, 0, 'Josh wants 6 and Cara 3 of 5 by now: his share is 3 of them');
  end(caras[3]);
  await started(more); // Cara is down to 1, under the first 2 everyone gets.
});

test('the line survives a restart: order kept, nothing lost, nothing started twice', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, b, c] = [minion(), minion(), minion()];
  say(a);
  await started(a);
  say(b, 'bee');
  say(c, 'sea');
  runner.detachAll();
  runner = makeRunner();
  runner.recover();
  await settle();
  assert.equal(runner.isRunning(a), true, 're-attached');
  assert.equal(runner.turnLine.used(), 1, 'the turn re-attached to holds its worker');
  assert.deepEqual(runner.turnLine.waiting(), [b, c]);
  end(a);
  await started(b);
  await settle();
  assert.equal(turnsOf(c).length, 0);
  end(b);
  await started(c);
  end(c);
  await idle(c);
  assert.deepEqual([turnsOf(a).length, turnsOf(b).length, turnsOf(c).length], [1, 1, 1]);
});

test('turns running when the size drops keep running, and the next waits until it fits', async () => {
  const [a, b, c] = [minion(), minion(), minion()];
  say(a);
  say(b);
  await started(a);
  await started(b);
  runner.turnLine.setSize(1, 'Cara');
  say(c);
  end(a);
  await idle(a);
  await settle();
  assert.equal(runner.isRunning(b), true);
  assert.equal(turnsOf(c).length, 0);
  runner.turnLine.setSize(2, 'Cara');
  await started(c);
});

test('a kill resume waits for a worker, with its queued message', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, b] = [minion(), minion()];
  say(a);
  await started(a);
  say(b);
  const live = inside(runner).turns.get(a)!;
  await until('its pid', () => existsSync(join(live.dir, 'pid.json')));
  const pids = JSON.parse(readFileSync(join(live.dir, 'pid.json'), 'utf8'));
  process.kill(pids.wrapper, 'SIGKILL');
  process.kill(-pids.claude, 'SIGKILL');
  await until('the kill to be seen', () => !runner.isRunning(a));
  await started(b); // b waited already: the killed turn gave its worker up
  await until('the kill resume to join the line', () => runner.turnLine.waiting().includes(a));
  await settle();
  assert.equal(turnsOf(a).length, 1);
  assert.deepEqual(store.listEvents(a).filter((e) => e.kind === 'error').length, 0, 'waiting is not a failed start');
  say(a, 'and this');
  end(b);
  await until('the resume', () => turnsOf(a).length === 2);
  assert.match(turnsOf(a)[1], /was killed/);
  assert.match(turnsOf(a)[1], /and this/);
});

test('a stop or a dismissal takes it out of the line, and so does taking its only message back', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, stopped, closed, unsent] = [minion(), minion(), minion(), minion()];
  say(a);
  await started(a);
  say(stopped);
  say(closed);
  const sent = say(unsent);
  assert.equal(runner.stop(stopped), true);
  await runner.close(closed, 'Dismissed.');
  runner.unqueue(unsent, sent.event.id, 'Cara');
  assert.deepEqual(runner.turnLine.waiting(), []);
  end(a);
  await idle(a);
  await settle();
  assert.deepEqual([turnsOf(stopped).length, turnsOf(closed).length, turnsOf(unsent).length], [0, 0, 0]);
  assert.equal(runner.turnLine.used(), 0);
});

test('a failed launch leaks no worker', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, b, c] = [minion(), minion(), minion()];
  const launch = inside(runner).launchTurn;
  inside(runner).launchTurn = async () => {
    throw new Error('no folder');
  };
  say(a);
  await until('the failed launch to be over', () => runner.turnLine.used() === 0);
  inside(runner).launchTurn = launch;
  runner.placeFor = () => ({ refused: 'Link Claude first' });
  say(b);
  await until('the refused start to be over', () => runner.turnLine.used() === 0);
  assert.deepEqual([turnsOf(a).length, turnsOf(b).length], [0, 0]);
  runner.placeFor = () => ({ host: true });
  say(c);
  await started(c);
});

test('paused, no minion turn starts, resumes included; carrying on starts them in order', async () => {
  const [a, b, tm] = [minion(), minion(), taskmaster()];
  const before = turnsOf(tm).length;
  runner.turnLine.setPause(true, 'Cara');
  say(a);
  say(b);
  say(tm);
  await until('the Taskmaster to start', () => turnsOf(tm).length > before);
  await settle();
  assert.deepEqual([turnsOf(a).length, turnsOf(b).length], [0, 0]);
  runner.turnLine.setPause(false, 'Cara');
  await started(a);
  await started(b);
});

test('paused, a turn that is cut off by a restart waits for the pause to end', async () => {
  const a = minion();
  say(a);
  await started(a);
  const live = inside(runner).turns.get(a)!;
  await until('its pid', () => existsSync(join(live.dir, 'pid.json')));
  runner.turnLine.setPause(true, 'Cara');
  runner.detachAll();
  const pids = JSON.parse(readFileSync(join(live.dir, 'pid.json'), 'utf8'));
  process.kill(pids.wrapper, 'SIGKILL');
  process.kill(-pids.claude, 'SIGKILL');
  await settle();
  runner = makeRunner();
  runner.recover();
  await settle();
  assert.equal(turnsOf(a).length, 1);
  assert.deepEqual(runner.turnLine.waiting(), [a]);
  runner.turnLine.setPause(false, 'Cara');
  await until('the resume', () => turnsOf(a).length === 2);
});

test('a second turn of a running minion joins the line when the first ends', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, b] = [minion(), minion()];
  say(a);
  await started(a);
  say(b);
  runner.send(a, 'Citadel', 'queued behind it');
  end(a);
  await started(b);
  await settle();
  assert.equal(turnsOf(a).length, 1);
  unend(a);
  end(b);
  await until('its second turn', () => turnsOf(a).length === 2);
});

test("Auto moves the size and lets turns through as it grows; a person's number holds until it is put back on Auto", async () => {
  runner.turnLine.setSize(null, 'Cara');
  store.setSetting('turn-pool', { size: 1, at: 0 });
  const [a, b] = [minion(), minion()];
  say(a);
  say(b);
  await started(a);
  const calm = { cpu: 5, mem: 0, io: 0, starved: false, why: '' };
  runner.turnLine.setSize(1, 'Cara');
  runner.turnLine.tick(calm);
  await settle();
  assert.equal(runner.turnLine.size(), 1);
  assert.equal(turnsOf(b).length, 0);
  runner.turnLine.setSize(null, 'Cara');
  runner.turnLine.tick(calm);
  await started(b);
  assert.equal(makeRunner().turnLine.size(), 2, 'a restart keeps it');
});
