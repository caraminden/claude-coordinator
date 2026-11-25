import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, beforeEach, test } from 'node:test';
import { Store } from '../src/db.ts';
import { workerRoutes } from '../src/routes/workers.ts';
import { stormPeople } from '../src/memory-storms.ts';
import { Runner } from '../src/runner.ts';
import { lines, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
import { workerWaitText } from '../src/worker-wait.ts';
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

const sent: { type: string; line?: unknown }[] = [];
function makeRunner() {
  const r = new Runner(
    store,
    (m) => sent.push(m as { type: string; line?: unknown }),
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
/** The line has nothing left to start: no pump due, no turn launching, and each worker's turn has its prompt. */
const settle = () =>
  until('the line to settle', () => {
    const r = runner as unknown as { launching: Map<number, unknown>; turnLine: { timer?: unknown } };
    const running = made.filter((id) => runner.isRunning(id));
    return !r.turnLine.timer && !r.launching.size && running.every((id) => turnsOf(id).length > 0) && runner.turnLine.used() === running.filter((id) => id !== tm).length;
  });
const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
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

test('a freed worker goes to whoever is furthest below their share, which grows with what they have waiting', async () => {
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

test('killed while paused, it waits for the pause to end', async () => {
  const a = minion();
  say(a);
  await started(a);
  runner.turnLine.setPause(true, 'Josh');
  const live = inside(runner).turns.get(a)!;
  await until('its pid', () => existsSync(join(live.dir, 'pid.json')));
  const pids = JSON.parse(readFileSync(join(live.dir, 'pid.json'), 'utf8'));
  process.kill(pids.wrapper, 'SIGKILL');
  process.kill(-pids.claude, 'SIGKILL');
  await until('the kill resume to join the line', () => runner.turnLine.waiting().includes(a));
  await until('its worker to be free', () => runner.turnLine.used() === 0);
  assert.equal(turnsOf(a).length, 1);
  runner.turnLine.setPause(false, 'Josh');
  await until('the resume', () => turnsOf(a).length === 2);
});

test("a card's answer to a waiting minion goes ahead of what others were told; a schedule's run goes last", async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, scheduled, asked, answered] = [minion(), minion(), minion(), minion()];
  say(a);
  await started(a);
  for (const id of [scheduled, asked, answered]) store.updateTicket(id, { person_id: cara.id });
  runner.send(scheduled, 'Citadel', 'the brief', []);
  runner.send(asked, 'Taskmaster', 'the brief', [], { asker: cara.id });
  runner.send(answered, 'Cara', 'Pick A', [], { answer: {} });
  assert.deepEqual(runner.turnLine.order(), [answered, asked, scheduled]);
  assert.equal(runner.shownStatus(store.getTicket(answered)!), 'running');
  assert.match(runner.keptOpen(answered, true)!, /waits for a worker/, 'a ship that lands meanwhile leaves it open');
  end(a);
  await started(answered);
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
  await until('it to die', () => gone(pids.claude));
  runner = makeRunner();
  runner.recover();
  await settle();
  assert.equal(turnsOf(a).length, 1);
  assert.deepEqual(runner.turnLine.waiting(), [a]);
  runner.turnLine.setPause(false, 'Cara');
  await until('the resume', () => turnsOf(a).length === 2);
});

test('paused and stopped, running turns stop and carry on after it, with what was queued; a Taskmaster runs on', async () => {
  const [a, b, tm] = [minion(), minion(), taskmaster()];
  const before = turnsOf(tm).length;
  for (const id of [a, b, tm]) say(id);
  await started(a);
  await started(b);
  await until('the Taskmaster to start', () => turnsOf(tm).length > before);
  runner.send(a, 'Citadel', 'queued behind it');
  runner.turnLine.setPause('stop', 'Josh');
  await until('both to stop', () => !runner.isRunning(a) && !runner.isRunning(b));
  await until('both to stand in the line', () => runner.turnLine.waiting().length === 2);
  assert.ok(runner.isRunning(tm));
  await until('their workers to be free', () => runner.turnLine.used() === 0);
  assert.equal(store.listEvents(a).filter((e) => e.kind === 'error').length, 0, 'a pause is no failure');
  assert.equal(store.getTicket(a)!.status, 'idle', 'stored: no process runs');
  assert.equal(runner.view(store.getTicket(a)!).status, 'running', 'shown: working');
  assert.equal(runner.view(store.getTicket(a)!).worker_wait?.paused, 'Josh');
  await settle();
  assert.deepEqual([turnsOf(a).length, turnsOf(b).length], [1, 1]);
  say(b, 'and this, while paused');
  runner.turnLine.setPause(false, 'Josh');
  await until('both to carry on', () => turnsOf(a).length === 2 && turnsOf(b).length === 2);
  assert.match(turnsOf(a)[1], /paused all minions/);
  assert.match(turnsOf(a)[1], /queued behind it/);
  assert.match(turnsOf(b)[1], /and this, while paused/);
  end(a);
  await idle(a);
  await settle();
  assert.equal(turnsOf(a).length, 2, 'carried on once');
});

test('a minion a pause stopped is still stopped for good by a person, and stays so over a restart', async () => {
  const [a, b] = [minion(), minion()];
  say(a);
  say(b);
  await started(a);
  await started(b);
  runner.turnLine.setPause('stop', 'Josh');
  await until('both to stand in the line', () => runner.turnLine.waiting().length === 2);
  assert.equal(runner.stop(a), true);
  runner.detachAll();
  runner = makeRunner();
  runner.recover();
  assert.deepEqual(runner.turnLine.waiting(), [b]);
  await settle();
  assert.deepEqual([turnsOf(a).length, turnsOf(b).length], [1, 1], 'the pause holds over a restart');
  runner.turnLine.setPause(false, 'Josh');
  await until('b to carry on', () => turnsOf(b).length === 2);
  await settle();
  assert.equal(turnsOf(a).length, 1);
});

test('a waiting minion shows as working with its place in the line', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, b, c] = [minion(), minion(), minion()];
  for (const id of [a, b, c]) say(id);
  await started(a);
  const view = (id: number) => runner.view(store.getTicket(id)!);
  assert.equal(view(a).worker_wait, null);
  assert.deepEqual([view(b).status, view(b).worker_wait?.place, view(b).worker_wait?.of], ['running', 1, 2]);
  assert.equal(view(c).worker_wait?.place, 2);
  assert.equal(workerWaitText(view(c).worker_wait!), 'waiting for a worker, 2nd of 2 in line');
  assert.deepEqual(runner.turnLine.people(), [{ person: cara.id, used: 1, waiting: 2 }]);
  end(a);
  await started(b);
  assert.equal(view(b).worker_wait, null);
  assert.equal(view(c).worker_wait?.place, 1);
  assert.ok(
    sent.some((m) => m.type === 'workers' && Array.isArray(m.line)),
    'pages hear the line move',
  );
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
  // The test's pool starts under Auto's fewest (4): lower it, or the first tick would pull the size up to it (#1892).
  runner.turnLine.setLimits({ min: 1 }, 'Cara');
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
  runner.turnLine.setLimits({ min: null }, 'Cara');
});

// #1888. Josh, 2026-11-24: 'mark it as "urgent" which would just push it to the top of the queue when it wants a worker'.
test('an Urgent minion gets the next worker, ahead of every share and of an own message, and its tag goes when it closes', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, own, mine, urgent] = [minion(), minion(), minion(false, 'Josh'), minion()];
  say(a);
  await started(a);
  say(own);
  say(mine, 'hello', 'Josh');
  store.updateTicket(urgent, { person_id: cara.id });
  runner.send(urgent, 'Citadel', 'CI passed');
  assert.deepEqual(runner.turnLine.order(), [mine, own, urgent], 'automatic work, in the share with a worker already');
  runner.urgent.set(urgent, { kind: 'person', by: 'Josh' });
  assert.deepEqual(runner.turnLine.order(), [urgent, mine, own], 'the press shows at once');
  assert.equal(runner.live(store.getTicket(urgent)!).urgent?.by, 'Josh');
  end(a);
  await started(urgent);
  await settle();
  assert.deepEqual([turnsOf(own).length, turnsOf(mine).length], [0, 0]);
  end(urgent);
  await idle(urgent);
  assert.ok(runner.urgent.get(urgent), 'it stays Urgent between its turns');
  await runner.close(urgent, 'Dismissed.');
  assert.equal(runner.urgent.get(urgent), null);
});

/** A call to the Workers tile's route, as Josh. */
async function workers(method: 'GET' | 'PUT', body?: unknown) {
  const route = workerRoutes.find((r) => r.method === method)!;
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? null))]), { headers: { 'content-type': 'application/json' } });
  let out = '';
  const res = { writeHead: () => res, setHeader: () => {}, end: (text: string) => void (out = text) };
  await route.handler({ req, res, app: { runner, store }, session: { name: 'Josh', uid: josh.id, exp: 0 } } as unknown as Parameters<typeof route.handler>[0]);
  return JSON.parse(out);
}

test('the Workers tile reads the pool, and a person sets its size and the pause', async () => {
  const [a, b] = [minion(), minion(false, 'Josh')];
  await workers('PUT', { size: 1 });
  say(a);
  await started(a);
  say(b, 'hello', 'Josh');
  const tile = await workers('GET');
  assert.deepEqual([tile.used, tile.size, tile.waiting, tile.pool.fixed], [1, 1, 1, { size: 1, by: 'Josh' }]);
  assert.deepEqual(tile.people.map((p: { name: string; used: number; waiting: number }) => [p.name, p.used, p.waiting]).sort(), [
    ['Cara', 1, 0],
    ['Josh', 0, 1],
  ]);
  const paused = await workers('PUT', { pause: true });
  assert.equal(paused.paused.by, 'Josh');
  assert.equal((await workers('PUT', { size: null })).pool.fixed, undefined);
  end(a);
  await idle(a);
  await settle();
  assert.equal(turnsOf(b).length, 0, 'paused');
  assert.equal((await workers('PUT', { pause: false })).paused, null);
  await started(b);
  const before = runner.turnLine.pool();
  for (const bad of [{}, null, { size: 3, pause: true }, { size: 0 }, { size: 51 }, { size: 2.5 }, { size: '4' }, { pause: 'now' }]) await assert.rejects(workers('PUT', bad), { status: 400 }, JSON.stringify(bad));
  assert.deepEqual(runner.turnLine.pool(), before, 'a refused change changes nothing');
});

test("no more of a person's turns start while their container is at its memory limit, others' do; one runs if none does (#1874)", async () => {
  runner.turnLine.setSize(null, 'Cara');
  const [a, b, c] = [minion(), minion(), minion(false, 'Josh')];
  store.setSetting('turn-pool', { size: 8, at: 0 });
  const level = { cpu: 50, mem: 10, io: 0, starved: false, why: '' };
  const person = stormPeople([{ group: 'citadel-turns.slice' }, { group: `citadel-claude-${cara.id}.service` }]);
  assert.deepEqual(person, [cara.id]);
  runner.turnLine.tick(level, person);
  say(a);
  await started(a);
  say(b);
  say(c, 'hello', 'Josh');
  await started(c);
  await settle();
  assert.equal(turnsOf(b).length, 0, 'held');
  assert.equal(runner.turnLine.people().find((p) => p.person === cara.id)!.stalled, true);
  runner.turnLine.tick(level, []);
  await started(b);
  for (const id of [a, b, c]) end(id);
  for (const id of [a, b, c]) await idle(id);
  const d = minion();
  runner.turnLine.tick(level, person);
  say(d);
  await started(d);
  runner.turnLine.setSize(50, 'Cara');
  runner.turnLine.tick(level, person);
  const e = minion();
  say(e);
  await started(e);
});

// #1892: the limits on the tile.
test('the Workers tile reads the limits with the last 7 days beside each line, and a person changes and resets them', async () => {
  const GB = 1024 ** 3;
  const now = Date.now();
  // 10 samples: CPU 0, 10, ... 90; memory pressure 0 except one at 25; free memory 16 GB except two at 5 GB.
  for (let i = 0; i < 10; i++) store.addHostSample({ at: now - (i + 1) * 60_000, mem_total: 32 * GB, mem_avail: (i < 2 ? 5 : 16) * GB, disk_total: 1, disk_free: 1, load1: 0, rss: 0, cpu_psi: i * 10, mem_psi: i === 0 ? 25 : 0 } as Parameters<typeof store.addHostSample>[0]);
  const tile = await workers('GET');
  const row = (key: string) => tile.limits.find((l: { key: string }) => l.key === key);
  assert.deepEqual([row('shrinkCpu').value, row('shrinkCpu').default, row('shrinkCpu').share], [50, 50, 50], '5 of 10 at 50% or more');
  assert.equal(row('shrinkMem').share, 10);
  assert.equal(row('shrinkFreeGb').share, 20);
  assert.equal(row('shrinkCpu').by, undefined);
  const set = await workers('PUT', { limits: { shrinkCpu: 80 } });
  assert.deepEqual([set.min, set.limits.find((l: { key: string }) => l.key === 'shrinkCpu').share], [4, 20]);
  const mine = set.limits.find((l: { key: string }) => l.key === 'shrinkCpu');
  assert.equal(mine.by, 'Josh');
  assert.ok(mine.at > 0);
  await assert.rejects(workers('PUT', { limits: { min: 20, max: 10 } }), /can't be over/);
  await assert.rejects(workers('PUT', { limits: { growCpu: 78 } }), /at least 5 points/);
  await assert.rejects(workers('PUT', { limits: { nope: 1 } }), /not a limit/);
  await assert.rejects(workers('PUT', { limits: { min: 3 }, size: 4 }), /one of them/);
  const reset = await workers('PUT', { limits: { shrinkCpu: null } });
  const back = reset.limits.find((l: { key: string }) => l.key === 'shrinkCpu');
  assert.deepEqual([back.value, back.by], [50, undefined]);
});
