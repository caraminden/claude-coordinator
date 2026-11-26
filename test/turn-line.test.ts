import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, beforeEach, test } from 'node:test';
import { Store } from '../src/db.ts';
import { workerRoutes } from '../src/routes/workers.ts';
import { stormPeople } from '../src/memory-storms.ts';
import type { WaitEnded } from '../src/minion-jobs.ts';
import { codexSwitchKey } from '../src/codex.ts';
import { MachinePools } from '../src/machine-pools.ts';
import { Runner } from '../src/runner.ts';
import { lines, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
import { tooCold, waitsLine } from '../public/threadstate.js';
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
const { appendFileSync, existsSync, readFileSync, unlinkSync } = require('node:fs');
// As claude ends on an interrupt: its open call reads as rejected, and the turn as failed.
process.on('SIGINT', () => {
  console.log(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'use-' + process.env.TEST_MINION, is_error: true, content: 'rejected' }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted' }));
  process.exit(0);
});
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  appendFileSync(${JSON.stringify(prompts)}, process.env.TEST_MINION + ' ' + input + '\\n');
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }));
  setInterval(() => {
    const print = ${JSON.stringify(root)} + '/print-' + process.env.TEST_MINION;
    if (existsSync(print)) {
      console.log(readFileSync(print, 'utf8'));
      unlinkSync(print);
    }
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

const inside = (r: Runner) => r as unknown as { turns: Map<number, { dir: string }>; lanes: { busy(id: number): boolean }; launchTurn: () => Promise<unknown> };

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
/** No turn of its runs and its lane is free: the session save after a turn is over too, which is when its worker goes back (#1967). */
const over = (id: number) => !runner.isRunning(id) && !(runner as unknown as { lanes: { busy(id: number): boolean } }).lanes.busy(id);
const idle = (id: number) => until(`minion ${id} to finish`, () => over(id) && store.getTicket(id)!.status !== 'running');
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
  for (const id of made) {
    end(id);
    if (runner.approvals.waiting(id)) runner.stop(id);
  }
  await until('the minions before to finish', () => made.every(over) && runner.turnLine.waiting().length === 0);
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

/** The minion's turn makes this call, and a card asks about it: the card's id. */
async function carded(id: number, use = `use-${id}`) {
  await print(id, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: use, name: 'Bash', input: { command: 'gh pr merge 1' } }] } });
  return runner.approvals.request(id, 'Bash', { command: 'gh pr merge 1' }, undefined, undefined, use);
}
/** Its turn prints a line, which the Runner has read. */
async function print(id: number, ev: object) {
  const file = join(root, `print-${id}`);
  writeFileSync(`${file}.tmp`, JSON.stringify(ev));
  renameSync(`${file}.tmp`, file);
  // Printed (the fake deletes it after) and then read to the end: its first line can still be unread here.
  await until('its line to be read', () => {
    const { dir, offset } = runner['turns'].get(id)!;
    return !existsSync(file) && offset >= statSync(join(dir, 'stream.jsonl')).size;
  });
}

// #1916. Josh, 2026-11-24: "shouldnt a minion waiting on a card just release to the pool until the card is answered?"
test('a minion waiting on an approval card frees its worker until the answer', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, b, c] = [minion(), minion(), minion()];
  say(a);
  await started(a);
  for (const id of [b, c]) say(id);
  await settle();
  const card = await carded(a);
  await started(b);
  assert.deepEqual([runner.turnLine.used(), runner.turnLine.lent()], [1, 1]);
  const tile = await workers('GET');
  assert.deepEqual([tile.used, tile.lent, tile.waiting], [1, 1, 1]);
  runner.approvals.decide(a, card, true, 'Josh');
  assert.deepEqual([runner.turnLine.used(), runner.turnLine.lent()], [2, 0], 'answered, it goes on at once, over the size');
  end(a);
  await idle(a);
  await settle();
  assert.equal(turnsOf(c).length, 0, 'back under the size first');
  end(b);
  await started(c);
});

test('a turn that does something besides its card keeps its worker', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, b] = [minion(), minion()];
  say(a);
  await started(a);
  say(b);
  await print(a, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }] } });
  await carded(a);
  await settle();
  assert.equal(turnsOf(b).length, 0, 'its Read still runs');
  await print(a, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'x' }] } });
  await started(b);
});

test('after a restart, a turn still waiting on its card has no worker', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, b] = [minion(), minion()];
  say(a);
  await started(a);
  await carded(a);
  runner.detachAll();
  runner = makeRunner();
  runner.recover();
  assert.deepEqual([runner.turnLine.used(), runner.turnLine.lent()], [0, 1]);
  say(b);
  await started(b);
});

const CALL = { command: 'gh pr merge 1' };
/** The call as a prompt gives it, inside the JSON line it is sent in. */
const TOLD = JSON.stringify(JSON.stringify(CALL)).slice(1, -1);
const steer = (id: number) => runner.send(id, 'Cara', 'one more thing', [], { typed: true }, true);
const ask = (id: number, input: object = CALL) => {
  // `home` is the test's own folder: anything beside the home it names counts as another person's, as CI's temp folder is.
  const cfg = { home: root, data: '/home/u/data', checkout: '/home/u/app', project: project.id, claudeConfig: '/home/u/.claude', deployScript: true };
  const asked = runner.approvals.ask(id, 'Bash', input, root, cfg, true);
  assert.ok('id' in asked, 'refused' in asked ? asked.refused : '');
  return asked;
};
const pass = (id: number) => store.getSetting<{ pass?: object }>(`turn:${id}`)?.pass;
const texts = (id: number, kind: string) => store.eventsOfKinds(id, [kind]).map((e) => e.data);
/** A minion on its card past the hold: its process has ended, and the card's id. */
async function parked(id = minion()) {
  say(id);
  await started(id);
  const card = await carded(id);
  runner.endCardWaits(false, Date.now() + 3 * 60_000);
  await idle(id);
  return { id, card };
}
const resumed = (id: number) => until(`minion ${id} to carry on`, () => turnsOf(id).length > 1);

// #1916. Josh, 2026-11-24: "why cant we fully free a minion waiting on a card and then just resume it when the card is answered?"
test('past its hold a minion waiting on a card ends its process; approved, it goes ahead of the line and runs that call once', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const a = minion();
  say(a);
  await started(a);
  const card = await carded(a);
  runner.endCardWaits(false, Date.now() + 60_000);
  assert.ok(runner.isRunning(a), 'not before its hold is over');
  runner.endCardWaits(true);
  await idle(a);
  assert.equal(store.getTicket(a)!.status, 'idle');
  assert.equal(runner.approvals.waiting(a), 1, 'the card waits on');
  assert.deepEqual([texts(a, 'approval_result').length, texts(a, 'error').length], [0, 0]);
  assert.ok(!texts(a, 'result').some((d) => d.includes('interrupted')), 'no failed turn in the chat');
  const tile = await workers('GET');
  assert.deepEqual([tile.used, tile.lent, tile.people.find((p: { lent?: number }) => p.lent)?.lent], [0, 1, 1]);
  const [b, c] = [minion(), minion()];
  say(b);
  await started(b);
  say(c);
  runner.approvals.decide(a, card, true, 'Josh');
  end(b);
  await resumed(a);
  assert.equal(turnsOf(c).length, 0, 'ahead of the minion that waited already');
  assert.ok(turnsOf(a)[1].includes(TOLD), 'it is told the call');
  assert.deepEqual(ask(a), { id: card });
  assert.equal((await runner.approvals.wait(a, card, 1)).state, 'allowed');
  assert.notEqual(ask(a).id, card, 'once');
});

test('anything but the approved call asks again, and loses the pass', async () => {
  for (const other of ['input', 'tool'] as const) {
    const { id, card } = await parked();
    runner.approvals.decide(id, card, true, 'Josh');
    await resumed(id);
    assert.ok(pass(id));
    if (other === 'input') assert.notEqual(ask(id, { command: 'gh pr merge 2' }).id, card);
    else await print(id, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: {} }] } });
    assert.equal(pass(id), undefined);
    assert.notEqual(ask(id).id, card);
  }
});

test('denied, it carries on with the answer and no pass', async () => {
  const { id, card } = await parked();
  runner.approvals.decide(id, card, false, 'Josh');
  await resumed(id);
  assert.equal(pass(id), undefined);
  assert.notEqual(ask(id).id, card, 'the same call asks again');
});

test("a person's words stand in for the answer; automatic mail waits for it", async () => {
  const { id, card } = await parked();
  runner.send(id, 'Taskmaster', 'when you can', [], { from: taskmaster() });
  await settle();
  assert.equal(turnsOf(id).length, 1, 'mail starts nothing');
  say(id, 'do it another way');
  await resumed(id);
  assert.match(turnsOf(id)[1], /do it another way/);
  assert.equal(runner.approvals.get(id, card).state, 'expired');
});

test("a kept card outlives a restart, and an answer the last server didn't act on counts", async () => {
  const [a, b] = [await parked(), await parked()];
  runner.approvals.keptAnswered = () => {};
  runner.approvals.decide(b.id, b.card, true, 'Josh');
  runner.detachAll();
  runner = makeRunner();
  runner.recover();
  await resumed(b.id);
  assert.ok(pass(b.id));
  assert.equal(runner.approvals.waiting(a.id), 1);
  assert.equal(turnsOf(a.id).length, 1);
  runner.approvals.decide(a.id, a.card, true, 'Josh');
  await resumed(a.id);
  assert.equal(ask(a.id).id, a.card);
});

test('a restart as its process ends keeps the card too', async () => {
  const a = minion();
  say(a);
  await started(a);
  const card = await carded(a);
  runner.endCardWaits(true);
  runner.detachAll();
  runner = makeRunner();
  runner.recover();
  await idle(a);
  await settle();
  assert.deepEqual([runner.approvals.waiting(a), runner.turnLine.lent(), turnsOf(a).length], [1, 1, 1]);
  runner.approvals.decide(a, card, false, 'Josh');
  await resumed(a);
});

test('an answer as its process ends resumes it, and the ending process is not told', async () => {
  const a = minion();
  say(a);
  await started(a);
  const card = await carded(a);
  const asker = runner.approvals.wait(a, card, 50);
  runner.endCardWaits(true);
  runner.approvals.decide(a, card, true, 'Josh');
  assert.equal((await asker).state, 'pending');
  await resumed(a);
  assert.equal(ask(a).id, card);
});

test('a stop or a dismissal expires the card', async () => {
  for (const how of ['stop', 'close'] as const) {
    const { id, card } = await parked();
    if (how === 'stop') assert.ok(runner.stop(id));
    else await runner.close(id, 'Dismissed.');
    assert.equal(runner.approvals.get(id, card).state, 'expired');
    assert.deepEqual([runner.approvals.waiting(id), runner.turnLine.lent()], [0, 0]);
  }
});

test('an answered card is dropped with the line when it is stopped there', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const { id, card } = await parked();
  const b = minion();
  say(b);
  await started(b);
  runner.approvals.decide(id, card, true, 'Josh');
  assert.ok(runner.stop(id));
  end(b);
  await settle();
  unend(id);
  say(id, 'afresh');
  await resumed(id);
  assert.equal(pass(id), undefined);
  assert.ok(!turnsOf(id)[1].includes(TOLD));
});

test('a job it left running, or a message it has not read, keeps its process', async () => {
  for (const why of ['job', 'steer', 'queued'] as const) {
    const a = minion();
    say(a);
    await started(a);
    if (why === 'job') await print(a, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_type: 'local_bash' }] });
    await carded(a);
    if (why === 'steer') steer(a);
    if (why === 'queued') say(a, 'one more thing');
    for (const restarted of [false, true]) {
      if (restarted) {
        runner.detachAll();
        runner = makeRunner();
        runner.recover();
      }
      runner.endCardWaits(true);
      assert.ok(runner.isRunning(a) && !store.getSetting<{ card?: boolean }>(`turn:${a}`)!.card, `${why}${restarted ? ', after a restart' : ''}`);
    }
  }
});

test('a message it has read no longer keeps its process', async () => {
  const a = minion();
  say(a);
  await started(a);
  await print(a, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: {} }] } });
  steer(a);
  runner.now = () => Date.now() + 10_000;
  await print(a, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'x' }] } });
  await carded(a);
  runner.endCardWaits(true);
  await idle(a);
  assert.equal(runner.approvals.waiting(a), 1);
  runner.now = Date.now;
});

test('a server that died between keeping the card and ending its turn leaves one of them, not both', async () => {
  const a = minion();
  say(a);
  await started(a);
  const card = await carded(a);
  const saveTurn = runner['saveTurn'].bind(runner);
  runner['saveTurn'] = (id, patch) => {
    if (patch.card) throw new Error('died');
    saveTurn(id, patch);
  };
  assert.throws(() => runner.endCardWaits(true), /died/);
  runner.detachAll();
  runner = makeRunner();
  runner.recover();
  runner.approvals.decide(a, card, true, 'Josh');
  await resumed(a);
  assert.equal(ask(a).id, card);
});

test("an approval whose turn could not start is no later turn's", async () => {
  const { id, card } = await parked();
  runner.turnLine.setPause(true, 'Cara');
  runner.approvals.decide(id, card, true, 'Josh');
  runner['queue'].refuse(id);
  runner.turnLine.setPause(false, 'Cara');
  say(id, 'something else');
  await resumed(id);
  assert.equal(pass(id), undefined);
  assert.notEqual(ask(id).id, card);
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
  assert.deepEqual(runner.turnLine.people(), [{ person: cara.id, used: 1, waiting: 2, lent: 0 }]);
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
  // A fixed size leaves the pool alone, and what it knows of the pressure still decides how long a wait is held (#1890).
  runner.turnLine.tick({ ...calm, cpu: 100, mem: 100 });
  assert.equal(runner.turnLine.starved, true);
  runner.turnLine.tick(calm);
  assert.equal(runner.turnLine.starved, false);
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

test('a person starts a waiting minion now: past the full pool, nobody else with it, and its later turns too until it is sealed (#1957)', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, other, own] = [minion(), minion(), minion()];
  say(a);
  await started(a);
  say(other);
  say(own, 'hello', 'Josh');
  runner.startNow.press(own, josh.id, 'Josh');
  runner.turnLine.force(own);
  assert.equal(runner.live(store.getTicket(own)!).start_now?.by, 'Josh');
  await started(own);
  await settle();
  assert.deepEqual([turnsOf(other).length, runner.isRunning(a), runner.turnLine.used()], [0, true, 2]);
  // Over a restart: the running turn re-attaches, and the hold with it.
  runner.detachAll();
  runner = makeRunner();
  runner.recover();
  await settle();
  assert.deepEqual([runner.isRunning(own), runner.startNow.get(own)?.by, runner.turnLine.summary().forced], [true, 'Josh', 1]);
  end(own);
  await idle(own);
  unend(own);
  say(own, 'and then', 'Josh');
  await until('its second turn', () => turnsOf(own).length === 2);
  await settle();
  assert.equal(turnsOf(other).length, 0);
  // Sealed mid-turn: the turn goes on, and the hold ends with it.
  store.updateTicket(own, { state: 'parked' });
  assert.ok(runner.startNow.get(own));
  end(own);
  await idle(own);
  await until('the hold to end', () => !runner.startNow.get(own));
  runner.startNow.sweep();
  store.updateTicket(own, { state: null });
  unend(own);
  say(own, 'once more', 'Josh');
  assert.ok(runner.turnLine.has(own), 'in the ordinary line');
  runner.startNow.press(own, josh.id, 'Josh');
  await runner.close(own, 'Dismissed.');
  assert.equal(runner.startNow.list().length, 0);
  assert.equal(runner.isRunning(a), true);
});

// #1890. Josh, 2026-11-24: "End and wake".
test("a minion woken by the end of what it waited for goes ahead of its person's new turns", async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, older, woken] = [minion(), minion(), minion()];
  say(a);
  await started(a);
  for (const id of [older, woken]) store.updateTicket(id, { person_id: cara.id });
  runner.send(older, 'Citadel', 'CI passed');
  // As MinionJobs.wake does: the mark, then the message.
  store.setSetting(`minion-job-woken:${woken}`, true);
  runner.send(woken, 'Citadel', 'the job ended');
  assert.deepEqual(runner.turnLine.order(), [woken, older]);
  store.deleteSetting(`minion-job-woken:${woken}`);
});

test('a Stop stops the job a minion waits for, says so, and a turn meanwhile hears of it; only a running minion turn starts one', async () => {
  const id = minion();
  let ran = true;
  runner.jobs = { running: () => [], turnLine: () => 'The server still works on `npm test`', stop: (t) => t === id && ran && !(ran = false) };
  try {
    assert.deepEqual(runner.jobTurn(id), { refuse: 'No turn of this minion is running' });
    say(id);
    await started(id);
    assert.match(turnsOf(id)[0], /The server still works on `npm test`/);
    assert.deepEqual(runner.jobTurn(id), { container: null, person: cara.id });
    end(id);
    await idle(id);
    assert.equal(runner.stop(id), true, 'the job alone');
    assert.match(store.listEvents(id).at(-1)!.data, /Stopped by user, with the job it waited for/);
    assert.equal(runner.stop(id), false, 'nothing left to stop');
    const t = taskmaster();
    const n = turnsOf(t).length;
    say(t);
    await until('the Taskmaster to start', () => turnsOf(t).length > n && runner.isRunning(t));
    assert.deepEqual(runner.jobTurn(t), { refuse: "This turn's jobs end with it" });
  } finally {
    runner.jobs = null;
  }
});

let waits: WaitEnded[] = [];
/** A call to the Workers tile's route, as Josh. */
async function workers(method: 'GET' | 'PUT', body?: unknown) {
  const route = workerRoutes.find((r) => r.method === method)!;
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? null))]), { headers: { 'content-type': 'application/json' } });
  let out = '';
  const res = { writeHead: () => res, setHeader: () => {}, end: (text: string) => void (out = text) };
  await route.handler({ req, res, app: { runner, store, minionJobs: { stats: () => waits } }, session: { name: 'Josh', uid: josh.id, exp: 0 } } as unknown as Parameters<typeof route.handler>[0]);
  return JSON.parse(out);
}

/** A minion that has had a turn: not a new one. */
async function veteran() {
  const id = minion();
  await store.recordTurn(id, { session_id: 's', ended_at: Date.now(), session_cost_usd: 0 });
  return id;
}

test("the quick lane takes people's own words and answers and the server's wake-ups; new minions, refused ships and other minions wait", async () => {
  const id = await veteran();
  const mate = minion();
  runner.turnLine.setPause(true, 'Cara');
  const kinds: [string, boolean, () => unknown][] = [
    ["a person's message", true, () => say(id)],
    ["a card's answer, or a Ship It handed back", true, () => runner.send(id, 'Cara', 'Ship It', [], { answer: {} })],
    ['a comment on a file', true, () => runner.send(id, 'Cara', 'this one', [], { comment: { about: 'a file' } })],
    ["an approval's answer", true, () => runner.queue.put(id, { author: 'System', text: 'approved', images: [], card: 'c1' }) ?? runner.turnLine.enter(id)],
    ['a job or a wait that ended', true, () => runner.send(id, 'Citadel', 'your job ended')],
    ['your ship went through', true, () => runner.send(id, 'Citadel', 'it went through', [], { light: true })],
    ["a plan's answer", true, () => runner.send(id, 'Cara', 'Plan approved', [], Object.assign({ plan: {} }, { quick: true }))],
    ['CI passed', true, () => runner.send(id, 'GitHub', 'CI passed', [], { fyi: true, light: true })],
    ['red CI, or a remark on its PR', false, () => runner.send(id, 'GitHub', 'CI failed')],
    ["a refused ship, or an agent's Unseal", false, () => runner.send(id, 'Citadel', "didn't go through", [], { quick: false })],
    ["another minion's message", false, () => runner.send(id, 'a mate', 'fyi', [], { from: mate })],
    ["a minion's message under a server name", false, () => runner.send(id, 'Citadel', 'fyi', [], { from: mate })],
    ['a script', false, () => runner.send(id, 'Cara', 'from a script')],
  ];
  const quick = () => !!runner.turnLine.line().find((w) => w.ticket === id)?.quick;
  for (const [what, yes, send] of kinds) {
    send();
    assert.equal(runner.turnLine.has(id), true, `${what} waits`);
    assert.equal(quick(), yes, what);
    runner.stop(id);
  }
  runner.send(id, 'Citadel', "didn't go through", [], { quick: false });
  say(id, 'try this');
  assert.equal(quick(), true, 'mail of another kind beside it holds nothing up');
  runner.stop(id);
  const fresh = minion();
  say(fresh);
  assert.equal(!!runner.turnLine.line()[0].quick, false, 'a new minion');
  runner.stop(fresh);
});

test("the pool full, a person's message starts its minion in the quick lane at once, and the tile shows it apart", async () => {
  const id = await veteran();
  const [a, waits] = [minion(), minion(false, 'Josh')];
  runner.turnLine.setSize(1, 'Cara');
  say(a);
  await started(a);
  say(waits, 'hello', 'Josh');
  say(id);
  await started(id);
  const tile = await workers('GET');
  assert.deepEqual([tile.used, tile.size, tile.lane, tile.waiting], [1, 1, { used: 1, size: 2, moved: 0 }, 1]);
  assert.equal(tile.people.find((p: { name: string }) => p.name === 'Cara').lane, 1);
  assert.deepEqual(
    runner.turnLine.laneTurns().map((t) => [t.ticket, t.person, t.moved]),
    [[id, cara.id, false]],
  );
  end(id);
  await idle(id);
  assert.equal((await workers('GET')).lane.used, 0);
  assert.equal(turnsOf(waits).length, 0, 'a new minion waits for the pool');
});

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

// #1890: the waits that gave their worker back.
test('the Workers tile counts the waits that ended, how long the middle one ran and the cold wakes, and warns past 10%', async () => {
  assert.deepEqual((await workers('GET')).waits, { count: 0, median: null, woken: 0, cold: 0 });
  const wait = (ms: number, cold: boolean | null): WaitEnded => ({ at: Date.now(), kind: 'wait', ms, cold, ticket: 1 });
  waits = [wait(9 * 60_000, false), wait(60_000, true), wait(5 * 60_000, null)];
  const got = (await workers('GET')).waits;
  waits = [];
  assert.deepEqual(got, { count: 3, median: 5 * 60_000, woken: 2, cold: 1 }, 'a wake whose turn has not started is neither');
  assert.equal(waitsLine(got), '3 waits gave their worker back in 7 days, the middle one 5m · 1 of 2 wakes cold (50%)');
  assert.equal(tooCold(got), true);
  assert.equal(tooCold({ count: 10, median: 1, woken: 10, cold: 1 }), false);
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

test('a stop while waiting for a worker tells the outbox which queued messages it dropped', async () => {
  runner.turnLine.setSize(1, 'Cara');
  const [a, b] = [minion(), minion()];
  say(a);
  await started(a);
  const brief = runner.send(b, 'Citadel', 'the original brief', [], { brief: true });
  const dropped: number[][] = [];
  runner.onStop = (_id, ids) => (dropped.push(ids), ids);
  assert.equal(runner.stop(b), true);
  assert.deepEqual(dropped, [[brief.event.id]]);
  say(b, 'go on');
  end(a);
  await started(b);
  assert.match(turnsOf(b)[0], /the original brief/, 'the stopped minion still starts with its brief');
  end(b);
  await idle(b);
  await idle(a);
  runner.onStop = () => [];
});

/** Cara's machine, lent to the scheme, with a ship starting on it between the line giving a turn a worker there and the turn's launch. */
async function shipsAsItStarts() {
  const m = store.listMachines()[0] ?? store.createMachine('desk', 'h', 'Cara', cara.id);
  store.setMachineProjects(m.id, [project.id]);
  const s = { ships: false };
  const pools = new MachinePools({ store, online: () => true, lends: () => true, info: () => ({ claude: '1', max: 1, at: Date.now(), load: { cpu: 0, mem: 0, freeGb: 9 } }), ships: () => s.ships, claude: () => Promise.resolve('1'), changed: () => {}, now: Date.now });
  pools.launch = (...a) => {
    s.ships = true;
    return MachinePools.prototype.launch.apply(pools, a);
  };
  runner.pools = pools;
  await until('its claude', () => pools.machines()[0].block === null);
  return { desk: { machine: m.id, name: m.name }, m, s };
}

test('a turn whose machine went as it started runs at perigee; one marked for it waits with its messages (Build 7 T4)', async (t) => {
  t.after(() => (runner.pools = null));
  const { desk, s } = await shipsAsItStarts();
  runner.turnLine.setSize(1, 'Cara');
  const [a, b, c, j] = [minion(), minion(), minion(), minion()];
  say(a);
  await started(a);
  say(j, 'hello', 'Josh');
  assert.equal(runner.turnLine.has(j), true, "not Josh's machine");
  runner.stop(j);
  say(b);
  await started(b);
  assert.deepEqual([runner.turnLine.placeOf(b), runner.turnLine.used()], [0, 2], 'home, over the size');
  s.ships = false;
  runner.runsOn.set(c, desk, 'Cara');
  say(c, 'kept words');
  await until('it to be back in line', () => s.ships && runner.turnLine.has(c) && !inside(runner).lanes.busy(c));
  assert.equal(turnsOf(c).length, 0);
  const view = runner.view(store.getTicket(c)!);
  assert.deepEqual([view.state, view.note, view.status === 'running'], ['blocked', "Waiting for desk: a ship's tests are running there", false]);
  runner.runsOn.set(c, null, 'Cara');
  end(a);
  end(b);
  await started(c);
  assert.match(turnsOf(c)[0], /kept words/);
});

test('a killed turn marked for a machine that went keeps its resume in the line', async (t) => {
  t.after(() => (runner.pools = null));
  const { desk, s } = await shipsAsItStarts();
  const a = minion();
  say(a);
  await started(a);
  runner.runsOn.set(a, desk, 'Cara');
  const live = inside(runner).turns.get(a)!;
  await until('its pid', () => existsSync(join(live.dir, 'pid.json')));
  const pids = JSON.parse(readFileSync(join(live.dir, 'pid.json'), 'utf8'));
  process.kill(pids.wrapper, 'SIGKILL');
  process.kill(-pids.claude, 'SIGKILL');
  await until('the resume to be back in line', () => s.ships && runner.turnLine.has(a) && !inside(runner).lanes.busy(a));
  assert.equal(turnsOf(a).length, 1);
  runner.runsOn.set(a, null, 'Cara');
  await until('the resume', () => turnsOf(a).length === 2);
  assert.match(turnsOf(a)[1], /was killed/);
});

test('a turn on Codex marked for a machine waits, and says it runs at perigee only', async (t) => {
  t.after(() => (runner.pools = null));
  const { desk } = await shipsAsItStarts();
  const a = minion();
  runner.runsOn.set(a, desk, 'Cara');
  store.setSetting(codexSwitchKey(cara.id), true);
  t.after(() => store.deleteSetting(codexSwitchKey(cara.id)));
  t.mock.method(runner as unknown as { codexWhy: () => string | null }, 'codexWhy', () => null);
  say(a);
  await until('it to wait', () => runner.view(store.getTicket(a)!).worker_wait);
  assert.deepEqual(runner.view(store.getTicket(a)!).worker_wait!.machine, { name: 'desk', why: 'its next turn is on Codex, which runs at perigee only', never: true });
  runner.stop(a);
});
