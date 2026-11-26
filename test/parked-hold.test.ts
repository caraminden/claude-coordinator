// Parked minions hold messages (#718, Cara, 2026-11-14: "Parked minions should not wake on being sent a message,
// there should be an "unpark" button ... The taskmaster should still be able to choose to unpark them"). A message
// to a parked minion (state parked, or chained on start_after) starts no turn: it waits as held mail, read in order
// on the next turn. Unpark, the Taskmaster's unpark option, and the minion's own wait (wake_when_live, the
// start_after start) all start that turn. A stand-in `claude -p` writes each turn's prompt to prompts.jsonl.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { APP_NAME } from '../src/appname.ts';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import type { TicketState } from '../src/db.ts';
import { READ_WAIT_MS } from '../src/db-writer.ts';
import { COLD_HOLD_MAX_MS, LOOP_LIMIT, Runner } from '../src/runner.ts';
import { LiveWaiters, startChained } from '../src/wake.ts';
import { bootServer, fakeClaude, jsonLines, withoutTurnNote, lines, PASSWORD, SECRET, stopTurns, testPins, until } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'parked-hold-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

const prompts = join(root, 'prompts.jsonl');
const fake = fakeClaude(root, { log: { path: prompts } });

const NOW = Date.UTC(2026, 10, 14, 18, 2);
const SENT = '2026-11-14 18:02';
const store = new Store(join(root, 'test.db'));
const runner = new Runner(
  store,
  () => {},
  () => ({}),
  fake,
);
runner.now = () => NOW;
const project = store.createProject('P', null);
const tm = store.createTicket({ project_id: project.id, title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara', kind: 'coordinator' });

/** An idle minion, parked unless `state` says otherwise. */
function minion(state: TicketState | null = 'parked') {
  const t = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, `t${t.id}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  store.updateTicket(t.id, { status: 'idle', state });
  return store.getTicket(t.id)!;
}
const messages = (id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'user_message')
    .map((e) => JSON.parse(e.data));
const held = (id: number) => store.getSetting<any>(`minion-queue:${id}`)?.held ?? null ?? [];
const promptCount = () => lines(prompts).length;
const lastPrompt = () => withoutTurnNote(jsonLines(prompts).at(-1).message.content).map((c: any) => c.text);
async function turn(start: () => unknown): Promise<string[]> {
  const before = promptCount();
  start();
  await until('the turn', async () => promptCount() > before);
  return lastPrompt();
}
async function idle(id: number) {
  await until('the turn to end', async () => !runner.isRunning(id));
}
function assertHeld(id: number, count: number) {
  assert.equal(runner.isRunning(id), false, 'no turn starts for a parked minion');
  assert.equal(runner.queued(id), 0);
  assert.equal(held(id).length, count);
  const shown = messages(id).at(-1);
  assert.equal(shown.mail, true);
  assert.equal(shown.parked, true, 'the chat shows it as held for a parked minion');
}

test("a person's message to a parked minion is held; Unpark wakes it with the held messages in order", async () => {
  const m = minion();
  assert.equal(runner.send(m.id, 'Cara', 'when you wake, check the logs', [], { hold: true }).parked, true);
  assertHeld(m.id, 1);
  assert.equal(runner.send(m.id, 'Josh', 'and the tripwire test', [], { hold: true }).parked, true);
  assertHeld(m.id, 2);
  assert.equal(store.getTicket(m.id)!.state, 'parked', 'still parked');

  const prompt = await turn(() => assert.equal(runner.unpark(m.id, 'Cara', 'Cara'), true));
  assert.deepEqual(prompt, ['[Cara]: Unsealed you. The 2 messages left for you while you were sealed follow. Pick up where you left off.', `[Cara, left while you were sealed, ${SENT} UTC]: when you wake, check the logs`, `[Josh, left while you were sealed, ${SENT} UTC]: and the tripwire test`]);
  assert.notEqual(store.getTicket(m.id)!.state, 'parked');
  assert.ok(store.listEvents(m.id).some((e) => e.kind === 'note' && JSON.parse(e.data).text === 'Cara unsealed this minion.'));
  await idle(m.id);
  assert.deepEqual(held(m.id), [], 'delivered once');
  assert.equal(runner.unpark(m.id, 'Cara', 'Cara'), false, 'no longer parked');
});

test('a message without hold (a card answer) still wakes a parked minion', async () => {
  const m = minion();
  assert.deepEqual(await turn(() => runner.send(m.id, 'Cara', 'Answers: tabs')), ['[Cara]: Answers: tabs']);
  await idle(m.id);
});

test("the Taskmaster's message to a parked minion is held, urgent too", async () => {
  const m = minion();
  assert.equal(runner.relay(m.id, m.id, 'Taskmaster', '#12 shipped, FYI'), 'parked');
  assertHeld(m.id, 1);
  assert.equal(runner.relay(m.id, m.id, 'Taskmaster', 'now please', true), 'parked', 'urgent does not wake a parked minion: only unpark does');
  assertHeld(m.id, 2);
});

test('notes left for a parked minion never pause the loop guard', () => {
  const m = minion();
  for (let i = 0; i < LOOP_LIMIT + 2; i++) assert.equal(runner.relay(m.id, m.id, 'Taskmaster', `note ${i}`), 'parked');
  assertHeld(m.id, LOOP_LIMIT + 2);
  assert.ok(!store.listEvents(m.id).some((e) => e.kind === 'loop_paused'));
});

test("another minion's message to a parked minion is held", () => {
  const m = minion();
  const other = minion(null);
  assert.equal(runner.relay(other.id, m.id, `#${other.number} M`, 'your API is ready'), 'parked');
  assertHeld(m.id, 1);
  assert.equal(messages(m.id).at(-1).from, other.id);
});

test('a minion that is not parked still wakes on a message', async () => {
  const m = minion(null);
  assert.deepEqual(await turn(() => assert.equal(runner.send(m.id, 'Cara', 'hi', [], { hold: true }).parked, undefined)), ['[Cara]: hi']);
  await idle(m.id);
});

test("wake_when_live's wake starts a parked minion's turn, its held messages after the wake note", async () => {
  const m = minion();
  runner.send(m.id, 'Cara', 'also bump the version', [], { hold: true });
  // The server's LiveWaiters callback: runner.send(ticketId, APP_NAME, text), no hold.
  const prompt = await turn(() => runner.send(m.id, APP_NAME, '`abc1234` is live now: retry the tripwire test'));
  assert.deepEqual(prompt, [`[${APP_NAME}]: \`abc1234\` is live now: retry the tripwire test`, `[Cara, left while you were sealed, ${SENT} UTC]: also bump the version`]);
  await idle(m.id);
});

test("the cold sweep never wakes a parked minion's held messages", () => {
  const m = minion();
  runner.relay(m.id, m.id, 'Taskmaster', 'note for later');
  store.setSetting(`minion-queue:${m.id}`, { ...store.getSetting<any>(`minion-queue:${m.id}`), coldAt: NOW - COLD_HOLD_MAX_MS - 60_000 }); // as if cold mail were also waiting
  runner.coldSweep();
  assert.equal(runner.isRunning(m.id), false);
  assert.equal(held(m.id).length, 1);
});

test('a start_after minion holds messages, and its start delivers them after its brief, unblocked', async () => {
  const w = new LiveWaiters(store, root, null, () => {});
  runner.heldFor = (id) => w.heldFor(id);
  const m = minion(null);
  w.chain({ ticket: m.id, after: tm.id, when: 'live', message: 'brief: build part two', from: 'Taskmaster', base: null, since: null });
  assert.ok(runner.heldFor(m.id));
  assert.equal(runner.send(m.id, 'Cara', 'use the new schema', [], { hold: true }).parked, true);
  assertHeld(m.id, 1);
  assert.equal(runner.relay(m.id, m.id, 'Taskmaster', 'part one is merged'), 'parked');

  // What the server's waiters.start does once the leader's work is live.
  const prompt = await turn(() => startChained(w.claim(m.id)!, `#${tm.number}'s work is live`, { store, runner, waiters: w }));
  assert.deepEqual(prompt, ['[Taskmaster]: brief: build part two', `[Cara, left while you were sealed, ${SENT} UTC]: use the new schema`, `[Taskmaster, left while you were sealed, ${SENT} UTC]: part one is merged`]);
  assert.equal(runner.heldFor(m.id), null);
  await idle(m.id);
  assert.deepEqual(held(m.id), []);
  runner.heldFor = () => null;
});

test("through the server: Unpark, the Taskmaster's unpark option, and update_ticket state null", async () => {
  const { call: asMe, as, stop } = await bootServer({ root: join(root, 'server') });
  try {
    const auth = new Auth(PASSWORD, SECRET);
    // bootServer's client, which asks a read again on the front's "try again" 503 as the page does (#2012): this
    // test's own fetch didn't, and failed on it in a crowd (#2013).
    const call = (path: string, body?: unknown, method?: string, agent?: number) => (agent ? as({ token: auth.agentToken(agent) }) : asMe)(path, body, method);
    const said = async (id: number) => (await call(`/api/tickets/${id}/events?after=0`)).data.filter((e: any) => e.kind === 'user_message').map((e: any) => JSON.parse(e.data));
    const view = async (id: number) => (await call(`/api/tickets/${id}`)).data.ticket;
    const settled = async (id: number) => {
      await until('the turn to end', async () => (await view(id)).status !== 'running');
      return view(id);
    };

    const { data: p } = await call('/api/projects', { name: 'Scheme' });
    const taskmaster = (await call(`/api/projects/${p.id}`)).data.coordinator.id;
    const parkedMinion = async (title: string) => {
      const { data: t } = await call(`/api/projects/${p.id}/tickets`, { title, message: `brief for ${title}` });
      await settled(t.id);
      // 'sealed' is the same state; it is stored as 'parked'
      assert.equal((await call(`/api/tickets/${t.id}`, { state: 'sealed' }, 'PATCH')).status, 200);
      assert.equal((await view(t.id)).state, 'parked');
      return t.id as number;
    };

    // A person's message: held, 202, no turn. Unpark: a turn in their name that reads it.
    const a = await parkedMinion('A');
    const sent = await call(`/api/tickets/${a}/messages`, { text: 'note for later' });
    assert.equal(sent.status, 202);
    assert.equal(sent.data.held, 'parked');
    assert.equal((await said(a)).at(-1).parked, true);
    assert.notEqual((await view(a)).status, 'running');
    assert.equal((await view(a)).state, 'parked');
    const unparked = await call(`/api/tickets/${a}/unpark`, {});
    assert.equal(unparked.status, 200);
    assert.equal(unparked.data.state, null);
    const wake = (await said(a)).at(-1);
    assert.equal(wake.author, 'Cara');
    assert.match(wake.text, /^Unsealed you\. The message left for you while you were sealed follows\./);
    assert.equal((await call(`/api/tickets/${a}/unpark`, {})).status, 409, 'unparked once');
    await settled(a);

    // The Taskmaster's message: held without the option; with unpark: true it wakes the minion.
    const b = await parkedMinion('B');
    const tmHeld = await call(`/api/tickets/${b}/messages`, { text: 'FYI #9 shipped' }, undefined, taskmaster);
    assert.equal(tmHeld.data.held, 'parked');
    assert.equal((await view(b)).state, 'parked');
    const tmWake = await call(`/api/tickets/${b}/messages`, { text: 'go now', unpark: true }, undefined, taskmaster);
    assert.equal(tmWake.status, 202);
    assert.notEqual(tmWake.data.held, 'parked');
    assert.notEqual((await view(b)).state, 'parked');
    const last = (await said(b)).at(-1);
    assert.equal(last.text, 'go now');
    assert.ok(!last.parked, 'this one woke it');
    await settled(b);

    // A person's message is held and listed in held_ids (the bubble's "Not sent yet"); with unpark: true it wakes the minion (#910).
    const pe = await parkedMinion('E');
    const personHeld = await call(`/api/tickets/${pe}/messages`, { text: 'later please' });
    assert.equal(personHeld.data.held, 'parked');
    const heldRow = (await said(pe)).at(-1);
    assert.equal(heldRow.parked, true);
    const rows = (await call(`/api/tickets/${pe}/events?after=0`)).data.filter((r: any) => r.kind === 'user_message');
    assert.deepEqual((await view(pe)).held_ids, [rows.at(-1).id]);
    const personWake = await call(`/api/tickets/${pe}/messages`, { text: 'now please', unpark: true });
    assert.equal(personWake.status, 202);
    assert.notEqual((await view(pe)).state, 'parked');
    assert.ok(!(await said(pe)).at(-1).parked, 'this one woke it');
    await settled(pe);
    assert.deepEqual((await view(pe)).held_ids, [], 'the turn took the held message');

    // The loop guard holding the message meant to unpark it leaves it parked, Unpark still there.
    const d = (await call(`/api/projects/${p.id}/tickets`, { title: 'D', message: 'brief for D' })).data.id as number;
    await settled(d);
    for (let i = 0; i < 6; i++) {
      await call(`/api/tickets/${d}/messages`, { text: `do ${i}` }, undefined, taskmaster);
      await settled(d);
    }
    assert.equal((await call(`/api/tickets/${d}`, { state: 'parked' }, 'PATCH')).status, 200);
    const guarded = await call(`/api/tickets/${d}/messages`, { text: 'go now', unpark: true }, undefined, taskmaster);
    assert.equal(guarded.data.held, true, 'the loop guard held it');
    assert.equal((await view(d)).state, 'parked');
    assert.notEqual((await view(d)).status, 'running');

    // update_ticket clearing the state unparks too: a turn starts.
    const c = await parkedMinion('C');
    await call(`/api/tickets/${c}/messages`, { text: 'held one' }, undefined, taskmaster);
    const before = (await said(c)).length;
    assert.equal((await call(`/api/tickets/${c}`, { state: null }, 'PATCH', taskmaster)).status, 200);
    await until('the unpark turn', async () => (await said(c)).length > before);
    assert.equal((await said(c)).at(-1).author, APP_NAME);
    assert.match((await said(c)).at(-1).text, /^Taskmaster unsealed you|unsealed you/);
    assert.notEqual((await view(c)).state, 'parked');
    await settled(c);

    // A minion that waits on wake_when_live says so in its view (wakes_on), so the list shows it under Waiting.
    const e = await parkedMinion('E');
    assert.equal((await view(e)).wakes_on, null, 'parked by hand: nothing wakes it');
    assert.equal((await call(`/api/tickets/${e}/wake`, { reason: 'the fix in #9 goes live' })).status, 201);
    assert.equal((await view(e)).wakes_on, 'the fix in #9 goes live');
  } finally {
    await stop();
  }
});

// #1585: an unpark clears the state with a write the worker may run later than the READ_WAIT_MS a read waits for it
// (src/db-writer.ts), so on a busy box the waking message re-read the minion as parked and was held, and the reply
// still said parked. This server holds every write longer than that, so a re-read that doesn't wait goes red every run.
test('through a server whose writes lag: the waking message and the reply see the unpark', async () => {
  const { call, as, stop } = await bootServer({ root: join(root, 'slow'), env: { CITADEL_DB_WRITE_DELAY_MS: String(READ_WAIT_MS * 2) } });
  try {
    const auth = new Auth(PASSWORD, SECRET);
    const { data: p } = await call('/api/projects', { name: 'Scheme' });
    const tm = as({ token: auth.agentToken((await call(`/api/projects/${p.id}`)).data.coordinator.id) });
    const view = async (id: number) => (await call(`/api/tickets/${id}`)).data.ticket;
    const last = async (id: number) =>
      (await call(`/api/tickets/${id}/events?after=0`)).data
        .filter((e: any) => e.kind === 'user_message')
        .map((e: any) => JSON.parse(e.data))
        .at(-1);
    const { data: m } = await call(`/api/projects/${p.id}/tickets`, { title: 'M', message: 'brief' });
    const park = async () => {
      await until('the turn to end', async () => (await view(m.id)).status !== 'running');
      assert.equal((await call(`/api/tickets/${m.id}`, { state: 'parked' }, 'PATCH')).status, 200);
    };

    await park();
    assert.equal((await call(`/api/tickets/${m.id}/unpark`, {})).data.state, null, "Unpark's reply shows it unparked");

    await park();
    const tmWake = await tm(`/api/tickets/${m.id}/messages`, { text: 'go now', unpark: true });
    assert.notEqual(tmWake.data.held, 'parked', "the Taskmaster's waking message isn't held");
    assert.ok(!(await last(m.id)).parked);

    await park();
    assert.notEqual((await call(`/api/tickets/${m.id}/messages`, { text: 'now please', unpark: true })).data.held, 'parked', "a person's Send and unpark isn't held");
    assert.ok(!(await last(m.id)).parked);
  } finally {
    await stop();
  }
});
