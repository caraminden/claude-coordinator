import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { historyPage } from '../src/history.ts';
import { applyEvent, createProgress, progressLine } from '../public/progress.js';
import { bootServer, stopTurns } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'history-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

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
  // Paging back gives the long turn whole, then the short first turn, then nothing more.
  const back = historyPage(store, t.id, { before: running[0], limit: 20 });
  assert.deepEqual([back.events.map((e) => e.id), back.more], [long, true]);
  const first = historyPage(store, t.id, { before: long[0], limit: 20 });
  assert.deepEqual([first.events.map((e) => e.id), first.more], [old, false]);
});

test('notes after a long last turn come with that turn, so the newest page is never just them (#288)', () => {
  const { store, t } = setup('tail');
  turn(store, t.id, 2);
  const long = turn(store, t.id, 40);
  const notes = [store.addEvent(t.id, 'note', { text: 'The deploy is live, so it dismissed this minion.' }).id,
    store.addEvent(t.id, 'note', { text: 'Deployed abc1234' }).id];
  const page = historyPage(store, t.id, { limit: 20 });
  assert.deepEqual(page.events.map((e) => e.id), [...long, ...notes]);
  assert.equal(page.more, true);
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

test('the newest page reaches back to the turn holding a card still waiting on people', () => {
  const { store, t } = setup('open-card');
  turn(store, t.id, 2);
  // A long planning turn ends with a plan card; the Taskmaster's short follow-up turn comes after it.
  const planning = [store.addEvent(t.id, 'user_message', { author: 'Josh', text: 'deep dive' }).id];
  for (let i = 0; i < 40; i++) planning.push(store.addEvent(t.id, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text: `reading ${i}` }] } }).id);
  planning.push(store.addEvent(t.id, 'plan', { id: 'p1', summary: 'Plan', plan: '- step', status: 'pending' }).id);
  planning.push(store.addEvent(t.id, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'The plan is on the card below.' }] } }).id);
  planning.push(store.addEvent(t.id, 'claude', { type: 'result', subtype: 'success', duration_ms: 10 }).id);
  const followUp = [store.addEvent(t.id, 'user_message', { author: 'Taskmaster', text: 'hold the WoW steps' }).id];
  for (let i = 0; i < 3; i++) followUp.push(store.addEvent(t.id, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text: `ok ${i}` }] } }).id);
  followUp.push(store.addEvent(t.id, 'claude', { type: 'result', subtype: 'success', duration_ms: 10 }).id);
  assert.deepEqual(historyPage(store, t.id, { limit: 20 }).events.map((e) => e.id), [...planning, ...followUp]);
  // Only so far back: a card with more events after it than a page may hold leaves the page as it was.
  assert.equal(store.openCardEventId(t.id, followUp.length + 2), planning.at(-3));
  assert.equal(store.openCardEventId(t.id, followUp.length + 1), null);
  // Once a person has written after it, the card isn't waiting any more and the page is whole turns that fit again.
  const said = store.addEvent(t.id, 'user_message', { author: 'Josh', text: 'lgtm' }).id;
  assert.deepEqual(historyPage(store, t.id, { limit: 20 }).events.map((e) => e.id), [...followUp, said]);
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
  for (const e of store.listEvents(t.id)) applyEvent(full, e.kind, JSON.parse(e.data), e.created_at);

  const page = historyPage(store, t.id, { limit: 12 });
  assert.equal(page.more, true);
  assert.deepEqual(page.tasks.map((x: any) => [x.subject, x.status]), [['Map', 'completed'], ['Build', 'in_progress']]);
  const seeded = { ...createProgress(), tasks: page.tasks };
  for (const e of page.events) applyEvent(seeded, e.kind, JSON.parse(e.data), e.created_at);
  assert.deepEqual(seeded.tasks, full.tasks);
});

test("a page of a running turn reads the same as a full replay, so a step left underway isn't shown as current (#518)", () => {
  const { store, t } = setup('plan-moved');
  const create = (id: string, subject: string) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'TaskCreate', input: { subject, activeForm: `${subject}ing` } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Task #${id.slice(1)} created successfully: ${subject}` }] } },
  ];
  const update = (taskId: string, status: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `u${++tool}`, name: 'TaskUpdate', input: { taskId, status } }] } });
  turn(store, t.id, 2, [...create('c1', 'Land'), ...create('c2', 'Wait on the Allow'), update('1', 'completed'), update('2', 'in_progress')]);
  // The card's answer starts a long turn that never touches the plan, still running.
  store.addEvent(t.id, 'user_message', { author: 'Cara', text: 'Merge and ship' });
  store.addEvent(t.id, 'claude', { type: 'system', subtype: 'init', session_id: 's' });
  for (let i = 0; i < 20; i++) store.addEvent(t.id, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: `w${++tool}`, name: 'Bash', input: { command: 'ls' } }] } });
  const full = createProgress();
  for (const e of store.listEvents(t.id)) applyEvent(full, e.kind, JSON.parse(e.data), e.created_at);

  const page = historyPage(store, t.id, { limit: 10 });
  assert.equal(page.more, true);
  // Pages are whole turns, so the running turn's start comes with it and the seed needn't carry planMoved.
  const seeded = { ...createProgress(), tasks: page.tasks };
  for (const e of page.events) applyEvent(seeded, e.kind, JSON.parse(e.data), e.created_at);
  assert.equal(progressLine(seeded, true), progressLine(full, true));
  assert.doesNotMatch(progressLine(seeded, true), /Wait/);
});

test("planEvents leaves out ordinary tool results yet replays to the same plan as every event (#497)", () => {
  const { store, t } = setup('plan-filter');
  const create = (id: string, subject: string) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'TaskCreate', input: { subject } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Task #${id.slice(1)} created successfully: ${subject}` }] } },
  ];
  const update = (taskId: string, status: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `u${++tool}`, name: 'TaskUpdate', input: { taskId, status } }] } });
  turn(store, t.id, 3, [...create('c7', 'Map'), ...create('c8', 'Build'), update('7', 'completed'), update('8', 'in_progress')]);
  turn(store, t.id, 2);
  const replay = (rows: { kind: string; data: string }[]) => {
    const p = createProgress();
    for (const e of rows) applyEvent(p, e.kind, JSON.parse(e.data));
    return { tasks: p.tasks, turnActions: p.turnActions, lastAction: p.lastAction };
  };
  const kept = store.planEvents(t.id);
  assert.deepEqual(replay(kept), replay(store.listEvents(t.id)));
  assert.deepEqual(replay(kept).tasks.map((x: any) => [x.subject, x.status]), [['Map', 'completed'], ['Build', 'in_progress']]);
  const results = kept.filter((e) => JSON.parse(e.data).type === 'user');
  assert.equal(results.length, 2, 'only the TaskCreate results, not the five ordinary tool results');
});

test('after= is unchanged: every event after an id', () => {
  const { store, t } = setup('after');
  const ids = turn(store, t.id, 2);
  assert.deepEqual(store.listEvents(t.id, ids[2]).map((e) => e.id), ids.slice(3));
});

test('search finds a quote, a backslash or a line break as typed, and a % or _ only literally (#468 S05-4)', () => {
  const { store, t } = setup('find');
  store.addEvent(t.id, 'user_message', { author: 'Cara', text: 'please say "hello" to C:\\temp\nnext line, 100% done' });
  const p = store.getTicket(t.id)!.project_id;
  const n = (q: string) => store.findEvents(p, q).length;
  assert.equal(n('say'), 1);
  assert.equal(n('say "hello"'), 1);
  assert.equal(n('C:\\temp'), 1);
  assert.equal(n('temp\nnext'), 1);
  assert.equal(n('100% done'), 1);
  assert.equal(n('100%_done'), 0);
});

test('the events route pages by default, keeps after= as a plain list, and search finds the oldest hit in one minion', async () => {
  // Seed a long minion and a second one, then boot the real server on that data.
  const routeRoot = join(root, 'route');
  const dataDir = join(routeRoot, 'data');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, 'coordinator.db'));
  const p = store.createProject('Route', null);
  const t = store.createTicket({ project_id: p.id, title: 'long', permission_mode: 'default', created_by: 'Cara' });
  const other = store.createTicket({ project_id: p.id, title: 'other', permission_mode: 'default', created_by: 'Cara' });
  const said = (id: number, text: string) => store.addEvent(id, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text }] } }).id;
  const firstHit = said(t.id, 'the pelican landed');
  for (let i = 0; i < 12; i++) turn(store, t.id, 10);
  said(t.id, 'another pelican');
  turn(store, t.id, 1);
  said(other.id, 'pelican elsewhere');

  const srv = await bootServer({ root: routeRoot });
  after(() => srv.stop()); // waits for the server to exit, so it isn't writing when the folder goes (#218)
  const get = async (path: string) => {
    const { status, data } = await srv.call(path);
    assert.equal(status, 200, path);
    return data;
  };

  const all = store.listEvents(t.id);
  const page = await get(`/api/tickets/${t.id}/events`);
  assert.equal(page.more, true);
  assert.ok(page.events.length <= 200 && page.events.length > 100, `${page.events.length} events`);
  assert.deepEqual(page.events.map((e: any) => e.id), all.slice(-page.events.length).map((e) => e.id));
  assert.deepEqual(page.tasks, []);
  const earlier = await get(`/api/tickets/${t.id}/events?before=${page.events[0].id}&limit=30`);
  assert.equal(earlier.events.at(-1).id, all[all.length - page.events.length - 1].id);
  // after= stays a plain list of everything since.
  assert.deepEqual((await get(`/api/tickets/${t.id}/events?after=0`)).map((e: any) => e.id), all.map((e) => e.id));
  // Search narrowed to one minion gives its oldest hit, and from= loads back to it.
  const hits = await get(`/api/projects/${p.id}/search?q=pelican&ticket=${t.id}`);
  assert.deepEqual(hits.map((h: any) => [h.ticketId, h.oldestId, h.matches]), [[t.id, firstHit, 2]]);
  const back = await get(`/api/tickets/${t.id}/events?before=${page.events[0].id}&from=${firstHit}`);
  assert.equal(back.events[0].id, firstHit);
  assert.equal(back.more, false);
  assert.equal((await get(`/api/projects/${p.id}/search?q=pelican`)).length, 2);
});

test('a newer page carries on from the last replay, with the task list a full replay gives (#609)', () => {
  const { store, t } = setup('resume');
  turn(store, t.id, 3);
  turn(store, t.id, 3);
  const plan = (id: string, subject: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'TaskCreate', input: { subject, description: subject } }] } });
  const made = (id: string, n: number) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Task #${n} created successfully: x` }] } });
  turn(store, t.id, 3, [plan('c1', 'One'), made('c1', 1)]);
  turn(store, t.id, 3);
  const first = historyPage(store, t.id, { limit: 12 });
  assert.deepEqual(first.tasks.map((x: any) => x.subject), ['One']);
  turn(store, t.id, 3, [plan('c2', 'Two'), made('c2', 2)]);
  turn(store, t.id, 3);
  const reads: number[] = [];
  const planEvents = store.planEvents.bind(store);
  store.planEvents = (id, before, after) => {
    reads.push(after ?? 0);
    return planEvents(id, before, after);
  };
  const later = historyPage(store, t.id, { limit: 12 });
  assert.ok(later.events[0].id > first.events[0].id);
  assert.ok(reads[0] > 0, 'it reads on from the last replay, not from the start');
  const full = createProgress();
  for (const row of planEvents(t.id, later.events[0].id)) applyEvent(full, row.kind, JSON.parse(row.data), row.created_at);
  assert.deepEqual(later.tasks, full.tasks);
  assert.deepEqual(later.tasks.map((x: any) => x.subject), ['One', 'Two']);
  // Paging back to before the last replay replays from the start, and leaves the furthest one in place.
  reads.length = 0;
  const back = historyPage(store, t.id, { before: first.events[0].id, limit: 12 });
  assert.equal(back.more, true);
  assert.equal(reads[0], 0);
});

test("after a restart, a chat's first open carries on from the saved replay, not from the start (#613)", () => {
  const { store, t } = setup('restart');
  const plan = (id: string, subject: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'TaskCreate', input: { subject, description: subject } }] } });
  const made = (id: string, n: number) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Task #${n} created successfully: x` }] } });
  turn(store, t.id, 3, [plan('r1', 'One'), made('r1', 1)]);
  turn(store, t.id, 3);
  turn(store, t.id, 3);
  const first = historyPage(store, t.id, { limit: 12 });
  assert.deepEqual(first.tasks.map((x: any) => x.subject), ['One']);
  turn(store, t.id, 3, [plan('r2', 'Two'), made('r2', 2)]);
  turn(store, t.id, 3);
  // A new Store on the same file is a restart: nothing kept in memory.
  const again = new Store(join(root, 'restart.db'));
  const reads: number[] = [];
  const planEvents = again.planEvents.bind(again);
  again.planEvents = (id, before, after) => {
    reads.push(after ?? 0);
    return planEvents(id, before, after);
  };
  const later = historyPage(again, t.id, { limit: 12 });
  assert.equal(reads[0], first.events[0].id - 1, 'it reads on from where the last open before the restart stopped');
  const full = createProgress();
  for (const row of planEvents(t.id, later.events[0].id)) applyEvent(full, row.kind, JSON.parse(row.data), row.created_at);
  // As the client gets them: the saved state is JSON, which drops keys left undefined.
  assert.deepEqual(JSON.parse(JSON.stringify(later.tasks)), JSON.parse(JSON.stringify(full.tasks)));
  assert.deepEqual(later.tasks.map((x: any) => x.subject), ['One', 'Two']);
  // Deleting the minion deletes its saved replay too.
  again.deleteTicket(t.id);
  assert.equal(again.getSetting(`plan:${t.id}:page`), null);
});
