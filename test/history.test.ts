import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { historyPage } from '../src/history.ts';
import { applyEvent, createProgress } from '../public/progress.js';

const root = mkdtempSync(join(tmpdir(), 'history-'));
after(() => rmSync(root, { recursive: true, force: true }));

function setup(name: string) {
  const store = new Store(join(root, `${name}.db`));
  const p = store.createProject(`P-${name}`, null);
  const t = store.createTicket({ project_id: p.id, title: 'x', permission_mode: 'default', created_by: 'Cara' });
  return { store, t };
}

let tool = 0;
/** One turn: the person's message, init, `work` tool calls with their results, a reply and the result. Returns its event ids. */
function turn(store: Store, ticketId: number, work: number, extra: object[] = []) {
  const ids = [store.addEvent(ticketId, 'user_message', { author: 'Cara', text: 'go' }).id];
  const add = (data: object) => ids.push(store.addEvent(ticketId, 'claude', data).id);
  add({ type: 'system', subtype: 'init', session_id: 's' });
  for (const data of extra) add(data);
  for (let i = 0; i < work; i++) {
    const id = `w${++tool}`;
    add({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls', description: 'List' } }] } });
    add({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  }
  add({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });
  add({ type: 'result', subtype: 'success', duration_ms: 10 });
  return ids;
}

test('the newest page is whole turns, as many as fit in the limit', () => {
  const { store, t } = setup('fit');
  const turns = [turn(store, t.id, 10), turn(store, t.id, 10), turn(store, t.id, 3), turn(store, t.id, 3)]; // 25, 25, 11, 11 events
  const page = historyPage(store, t.id, { limit: 30 });
  assert.deepEqual(page.events.map((e) => e.id), [...turns[2], ...turns[3]]);
  assert.equal(page.events[0].kind, 'user_message', 'a turn starts with the message that started it');
  assert.equal(page.more, true);
  // The next page back, before the oldest event shown.
  const earlier = historyPage(store, t.id, { before: page.events[0].id, limit: 30 });
  assert.deepEqual(earlier.events.map((e) => e.id), turns[1]);
  const first = historyPage(store, t.id, { before: earlier.events[0].id, limit: 30 });
  assert.deepEqual(first.events.map((e) => e.id), turns[0]);
  assert.equal(first.more, false);
});

test('a turn longer than the limit comes whole, running or not', () => {
  const { store, t } = setup('long');
  const old = turn(store, t.id, 2);
  const long = turn(store, t.id, 40);
  assert.deepEqual(historyPage(store, t.id, { limit: 20 }).events.map((e) => e.id), long);
  // A turn still running (no result yet) is the newest turn, whole.
  const running = [store.addEvent(t.id, 'user_message', { author: 'Cara', text: 'more' }).id];
  for (let i = 0; i < 30; i++) running.push(store.addEvent(t.id, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text: `step ${i}` }] } }).id);
  const page = historyPage(store, t.id, { limit: 20 });
  assert.deepEqual(page.events.map((e) => e.id), running);
  assert.equal(page.more, true);
  assert.ok(old.length);
});

test('a short history is one page with nothing more', () => {
  const { store, t } = setup('short');
  const ids = [...turn(store, t.id, 1), ...turn(store, t.id, 1)];
  const page = historyPage(store, t.id);
  assert.deepEqual(page.events.map((e) => e.id), ids);
  assert.deepEqual([page.more, page.tasks], [false, []]);
  assert.deepEqual(historyPage(setup('empty').store, 1), { events: [], more: false, tasks: [] });
});

test('from reaches back to the turn holding that event', () => {
  const { store, t } = setup('from');
  const turns = [turn(store, t.id, 5), turn(store, t.id, 5), turn(store, t.id, 5), turn(store, t.id, 5)];
  const newest = historyPage(store, t.id, { limit: 15 });
  assert.deepEqual(newest.events.map((e) => e.id), turns[3]);
  // A match in the middle of turn 1: everything from turn 1's start up to what's loaded.
  const page = historyPage(store, t.id, { before: newest.events[0].id, limit: 15, from: turns[1][5] });
  assert.deepEqual(page.events.map((e) => e.id), [...turns[1], ...turns[2]]);
  assert.equal(page.more, true);
});

test("each page carries the plan as it stood before it, so the readout matches a full replay", () => {
  const { store, t } = setup('plan');
  const create = (id: string, subject: string) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'TaskCreate', input: { subject, activeForm: `${subject}ing` } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Task #${id.slice(1)} created successfully: ${subject}` }] } },
  ];
  const update = (taskId: string, status: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `u${++tool}`, name: 'TaskUpdate', input: { taskId, status } }] } });
  // The plan is made in the first turn and worked on across the later ones.
  turn(store, t.id, 3, [...create('c1', 'Map'), ...create('c2', 'Build'), update('1', 'in_progress')]);
  turn(store, t.id, 8, [update('1', 'completed'), update('2', 'in_progress')]);
  turn(store, t.id, 4);
  const full = createProgress();
  for (const e of store.listEvents(t.id)) applyEvent(full, e.kind, JSON.parse(e.data));

  const page = historyPage(store, t.id, { limit: 12 });
  assert.equal(page.more, true);
  assert.deepEqual(page.tasks.map((x: any) => [x.subject, x.status]), [['Map', 'completed'], ['Build', 'in_progress']]);
  const seeded = { ...createProgress(), tasks: page.tasks };
  for (const e of page.events) applyEvent(seeded, e.kind, JSON.parse(e.data));
  assert.deepEqual(seeded.tasks, full.tasks);
});

test('after= is unchanged: every event after an id', () => {
  const { store, t } = setup('after');
  const ids = turn(store, t.id, 2);
  assert.deepEqual(store.listEvents(t.id, ids[2]).map((e) => e.id), ids.slice(3));
});
