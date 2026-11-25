import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { unsealedBy } from '../src/held-mail.ts';
import { HeldStarts } from '../src/held-starts.ts';
import type { PressureReading } from '../src/pressure.ts';
import type { Runner } from '../src/runner.ts';
import { agentToken, bootServer, tempRoot, testPins, until } from './helpers.ts';
import { fake } from './typed.ts';
testPins();

// What the time log asks of one minion (#1992; Josh, 2026-11-25): its state changes with who made them, its ship, its cut-offs.

const tmp = tempRoot('wait-records-');
after(() => tmp.teardown());

function setup() {
  const store = new Store(':memory:');
  const p = store.createProject('One', null);
  const mk = (title: string) => store.createTicket({ project_id: p.id, title, permission_mode: 'default', created_by: 'Cara' }).id;
  return { store, mk };
}

test('one query gives all three, oldest first, and only that minion’s; from before the recording there are none', () => {
  const began = Date.now();
  const { store, mk } = setup();
  const [a, b] = [mk('a'), mk('b')];
  store.updateTicket(a, { state: 'ready', note: 'x' }, { kind: 'minion' });
  store.updateTicket(a, { state: 'ready', note: 'y' }, { kind: 'minion' });
  store.updateTicket(a, { note: 'z' });
  store.updateTicket(a, { state: null });
  store.addWaitRecord(a, 'ship', { at: 5, ship: 5, stage: 'line', label: 'In line', place: 2, behind: '#9' });
  store.addWaitRecord(a, 'cut', { at: 6, limit: 'timeout', seconds: 3, command: 'x' });
  store.addWaitRecord(b, 'cut', { at: 7, limit: null });
  const got = store.waitRecords(a);
  assert.deepEqual(
    got.states.map(({ at, ...s }) => s),
    [
      { old: null, new: 'ready', by: { kind: 'minion' } },
      { old: 'ready', new: null, by: { kind: 'server' } },
    ],
  );
  assert.ok(got.states.every((s) => s.at >= began));
  assert.deepEqual(got.ships, [{ at: 5, ship: 5, stage: 'line', label: 'In line', place: 2, behind: '#9' }]);
  assert.deepEqual(got.cuts, [{ at: 6, limit: 'timeout', seconds: 3, command: 'x' }]);
  assert.ok(got.since! >= began && got.since! <= Date.now(), 'what came before reads "not recorded"');
  const none = store.waitRecords(mk('c'));
  assert.deepEqual([none.states, none.ships, none.cuts], [[], [], []]);
});

test('the time recording began stays the first one’s; records go with their minion', () => {
  const path = join(tmp.dir, 'since.db');
  const first = new Store(path);
  const p = first.createProject('One', null);
  const id = first.createTicket({ project_id: p.id, title: 'a', permission_mode: 'default', created_by: 'Cara' }).id;
  first.setSetting('wait_records_since', 123);
  first.db.close();
  const store = new Store(path);
  assert.equal(store.waitRecords(id).since, 123);
  store.updateTicket(id, { state: 'ready' });
  store.deleteTicket(id);
  store.addWaitRecord(id, 'cut', { at: 1, limit: null }); // its last turn's, late
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM wait_records').get() as { n: number }).n, 0);
  store.db.close();
});

test('an unseal is a person’s, the Taskmaster’s, another minion’s or the server’s', () => {
  assert.deepEqual(unsealedBy('Josh', 'Josh'), { kind: 'person', name: 'Josh' });
  assert.deepEqual(unsealedBy('Taskmaster', 'Citadel'), { kind: 'agent', name: 'Taskmaster' });
  assert.deepEqual(unsealedBy('#12', 'Citadel'), { kind: 'agent', name: '#12' });
  assert.deepEqual(unsealedBy('Citadel', 'Citadel'), { kind: 'server' });
});

test('a brief held for the box is put off by the server and started by whoever unsealed it', async () => {
  const { store, mk } = setup();
  const id = mk('a');
  const held = new HeldStarts({ store, runner: fake<Runner>({ emit: () => fake({}), send: () => fake({}) }), read: async () => fake<PressureReading>({ starved: true, why: 'CPU pressure 63%' }) });
  await held.start({ ticket: id, from: 'Citadel', message: 'go', opts: {} }, () => {});
  assert.ok(held.release(id, 'Cara unsealed it', { kind: 'person', name: 'Cara' }));
  assert.deepEqual(
    store.waitRecords(id).states.map((s) => [s.old, s.new, s.by.kind, s.by.name]),
    [
      [null, 'parked', 'server', undefined],
      ['parked', null, 'person', 'Cara'],
    ],
  );
});

test('on a running server: the status line, the tool, the page, an unseal, a turn’s start and a command cut off', async () => {
  const root = join(tmp.dir, 'server');
  const bin = join(tmp.dir, 'claude-fake');
  writeFileSync(
    bin,
    `#!${process.execPath}
process.stdin.once('data', () => {
  const say = (o) => console.log(JSON.stringify(o));
  say({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'timeout 7 slow' } }] } });
  say({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 124' }] } });
  say({ type: 'system', subtype: 'task_notification', tool_use_id: 't1', status: 'stopped', summary: 'Background command "x" was stopped after reaching its background time limit' });
  const text = 'Done.\\n<!-- status: {"state":"ready","note":"look"} -->';
  say({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  say({ type: 'result', subtype: 'success', is_error: false, result: text });
  process.exit(0);
});
`,
  );
  chmodSync(bin, 0o755);
  const srv = await bootServer({ root, env: { CLAUDE_BIN: bin, NODE_NO_WARNINGS: '1' } });
  let id = 0;
  let next = 0;
  try {
    const as = async (who: number, body: unknown) => {
      const res = await fetch(`${srv.base}/api/tickets/${id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${agentToken(join(root, 'data'), who)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 200, await res.text());
    };
    const project = (await srv.call('/api/projects', { name: 'Other Scheme' })).data;
    const taskmaster = (await srv.call(`/api/projects/${project.id}`)).data.coordinator.id;
    const made = (await srv.call(`/api/projects/${project.id}/tickets`, { message: 'start' })).data;
    id = (made.ticket ?? made).id;
    const ticket = async () => (await srv.call(`/api/tickets/${id}`)).data.ticket;
    const settled = (state: string | null) => until(`state ${state}`, async () => (({ status, state: s }) => status === 'idle' && s === state)(await ticket()));
    await settled('ready'); // its status line
    await as(id, { state: 'blocked', note: 'stuck' });
    await as(taskmaster, { state: 'parked', note: 'later' });
    await as(taskmaster, { state: null }); // unseals it: a turn
    await settled('ready');
    await srv.call(`/api/tickets/${id}`, { state: 'try' }, 'PATCH');
    await srv.call(`/api/tickets/${id}/messages`, { text: 'go on' });
    await settled('ready');
    const follow = (await srv.call(`/api/projects/${project.id}/tickets`, { title: 'Next', message: 'go', start_after: (await ticket()).number })).data;
    next = (follow.ticket ?? follow).id;
  } finally {
    await srv.stop();
  }
  const store = new Store(join(root, 'data', 'coordinator.db'));
  const { states, cuts } = store.waitRecords(id);
  const sealed = store.waitRecords(next).states[0];
  store.db.close();
  const me = 'minion';
  const person = states.find((s) => s.by.kind === 'person')?.by.name;
  assert.ok(person);
  assert.deepEqual([sealed.new, sealed.by.name], ['parked', person], 'made behind another: sealed by whoever made it');
  assert.deepEqual(
    states.map((s) => [s.old, s.new, [s.by.kind, s.by.name].filter(Boolean).join(' ')]),
    [
      [null, 'ready', me],
      ['ready', 'blocked', me],
      ['blocked', 'parked', 'agent Taskmaster'],
      ['parked', null, 'agent Taskmaster'],
      [null, 'ready', me],
      ['ready', 'try', `person ${person}`],
      ['try', null, 'server'],
      [null, 'ready', me],
    ],
  );
  assert.deepEqual(
    cuts.slice(0, 2).map(({ at, ...c }) => c),
    [
      { limit: 'timeout', seconds: 7, command: 'timeout 7 slow', tool_use_id: 't1' },
      { limit: 'background', command: 'timeout 7 slow', tool_use_id: 't1' },
    ],
  );
  assert.equal(cuts.length, 6, 'two a turn');
});
