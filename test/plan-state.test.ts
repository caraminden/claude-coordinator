// A minion's task-list state is saved when a turn ends, and a restarted server loads that and replays
// only the events since, not the whole history (#530). The risk is a wrong count on screen, so the
// saved state plus its tail must equal a full replay at every point.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { planKey, Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { applyEvent, createProgress, progressLine, stepInfo } from '../public/progress.js';
import { testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'plan-state-'));
after(() => rmSync(root, { recursive: true, force: true }));
const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const restart = () =>
  new Runner(
    store,
    () => {},
    () => ({}),
    '/bin/false',
  );
const newTicket = () => store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
const feed = (runner: Runner, id: number, lines: object[]) => {
  for (const l of lines) (runner as any).handleLine(id, JSON.stringify(l), () => {});
};

let n = 0;
const init = { type: 'system', subtype: 'init', session_id: 's' };
const result = { type: 'result', subtype: 'success', is_error: false, result: 'done' };
const say = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const call = (name: string, input: object, id = `c${++n}`) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const answer = (id: string, content: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const create = (taskId: number, subject: string) => {
  const id = `c${++n}`;
  return [call('TaskCreate', { subject, activeForm: `Doing ${subject}` }, id), answer(id, `Task #${taskId} created successfully: ${subject}`)];
};
const update = (taskId: number, input: object) => call('TaskUpdate', { taskId: String(taskId), ...input });
const work = () => {
  const c = call('Bash', { command: 'ls', description: 'List' });
  return [c, answer(c.message.content[0].id, 'ok')];
};

/** Three turns: a plan left half done over a turn's end, finished in the next, then a TodoWrite plan left mid-turn. */
const HISTORY: object[] = [
  init,
  ...create(1, 'Look'),
  ...create(2, 'Build'),
  ...create(3, 'Drop me'),
  update(1, { status: 'in_progress' }),
  ...work(),
  say('Looking.'),
  update(1, { status: 'completed', metadata: { outcome: 'Found it' } }),
  update(3, { status: 'deleted' }),
  update(2, { status: 'in_progress' }),
  ...work(),
  result,
  init,
  ...work(),
  update(2, { status: 'completed', subject: 'Built' }),
  say('Done.'),
  result,
  init,
  call('TodoWrite', {
    todos: [
      { content: 'A', activeForm: 'Doing A', status: 'completed' },
      { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
    ],
  }),
  ...work(),
  // A task whose result hasn't come back when the server restarts.
  call('TaskCreate', { subject: 'Pending' }, 'late'),
  answer('late', 'Task #9 created successfully: Pending'),
  say('Still going.'),
];

type Saved = { p: { tasks: unknown[] }; upTo: number; rules?: string };
const plain = (p: { pendingCreates?: Iterable<unknown>; [k: string]: unknown }) => JSON.parse(JSON.stringify({ ...p, pendingCreates: [...p.pendingCreates!] }));
function fullReplay(ticketId: number) {
  // As the runner replays: timed by the stored events, collecting the steps that finish after (#571).
  const p = createProgress();
  for (const row of store.planEvents(ticketId)) applyEvent(p, row.kind, JSON.parse(row.data), row.created_at);
  return { ...p, finished: [] };
}

test('after a restart at any point, the saved state plus the events since equals a full replay', () => {
  const t = newTicket();
  let live = restart();
  for (const [i, line] of HISTORY.entries()) {
    feed(live, t.id, [line]);
    live = restart();
    const got = (live as any).progressFor(t.id);
    const want = fullReplay(t.id);
    assert.deepEqual(plain(got), plain(want), `after event ${i + 1} of ${HISTORY.length}`);
    assert.deepEqual(JSON.parse(JSON.stringify(stepInfo(got))), JSON.parse(JSON.stringify(stepInfo(want))));
    assert.equal(progressLine(got, true), progressLine(want, true));
  }
  assert.deepEqual(live.view(store.getTicket(t.id)!).steps, { done: 1, total: 3 });
});

test('a restarted server reads only the events since the last turn ended', () => {
  const t = newTicket();
  feed(restart(), t.id, HISTORY.slice(0, HISTORY.indexOf(result) + 1));
  const lastResult = store.listEvents(t.id).at(-1)!.id;
  const read: number[] = [];
  const planEvents = store.planEvents.bind(store);
  store.planEvents = (...args: Parameters<Store['planEvents']>) => {
    const rows = planEvents(...args);
    read.push(...rows.map((r) => r.id));
    return rows;
  };
  try {
    const idle = restart();
    assert.deepEqual(idle.view(store.getTicket(t.id)!).steps, { done: 1, total: 2 });
    assert.deepEqual(read, [], 'an idle minion replays nothing');
    // Mid-turn: only that turn's events so far.
    feed(idle, t.id, [init, ...work()]);
    assert.deepEqual(restart().view(store.getTicket(t.id)!).steps, { done: 1, total: 2 });
    assert.ok(read.length > 0 && read.every((id) => id > lastResult), `read ${read}, all after ${lastResult}`);
  } finally {
    store.planEvents = planEvents;
  }
});

test('a minion with no saved state is replayed in full once, then saved', () => {
  const t = newTicket();
  feed(restart(), t.id, HISTORY.slice(0, 8)); // mid-turn, no result yet
  store.deleteSetting(planKey(t.id));
  assert.deepEqual(restart().view(store.getTicket(t.id)!).steps, { done: 0, total: 3 });
  const saved = store.getSetting<Saved>(planKey(t.id))!;
  assert.equal(saved.p.tasks.length, 3);
  assert.equal(saved.upTo, store.planEvents(t.id).at(-1)!.id);
});

test('a state saved by other task-list rules, or a broken one, is thrown away and rebuilt', () => {
  const t = newTicket();
  feed(restart(), t.id, HISTORY.slice(0, HISTORY.indexOf(result) + 1));
  const saved = store.getSetting<Saved>(planKey(t.id))!;
  const wrong = { ...saved.p, tasks: [{ id: '1', subject: 'Wrong', status: 'completed', actions: 0 }] };
  for (const bad of [{ ...saved, rules: 'older', p: wrong }, { ...saved, p: { ...wrong, tasks: 'x' } }, { ...saved, upTo: 'x', p: wrong }, 'junk']) {
    store.setSetting(planKey(t.id), bad);
    assert.deepEqual(restart().view(store.getTicket(t.id)!).steps, { done: 1, total: 2 }, JSON.stringify(bad).slice(0, 60));
    assert.deepEqual(store.getSetting<Saved>(planKey(t.id)), saved, 'and saved again');
  }
});

test("a plan rebuilt by new task-list rules re-words the row's stored line, so an idle minion's row isn't left on the old rules' words (#2201)", () => {
  const t = newTicket();
  feed(restart(), t.id, HISTORY.slice(0, HISTORY.indexOf(result) + 1));
  const line = store.getTicket(t.id)!.last_activity;
  assert.equal(line, 'Paused at: Build · 1 of 2 done');
  store.updateTicket(t.id, { last_activity: 'Paused at: Reading, building and testing, 5 steps · 0 of 6 done' });
  store.setSetting(planKey(t.id), { ...store.getSetting<Saved>(planKey(t.id))!, rules: 'older' });
  const touched = store.getTicket(t.id)!.updated_at;
  restart().view(store.getTicket(t.id)!);
  assert.equal(store.getTicket(t.id)!.last_activity, line);
  assert.equal(store.getTicket(t.id)!.updated_at, touched, 'not counted as new activity');
});

test('rewriting the stored events, or deleting the minion, drops the saved state', () => {
  const [a, b] = [newTicket(), newTicket()];
  for (const t of [a, b]) feed(restart(), t.id, HISTORY.slice(0, HISTORY.indexOf(result) + 1));
  store.deleteTicket(b.id);
  assert.equal(store.getSetting(planKey(b.id)), null);
  assert.ok(store.getSetting(planKey(a.id)));
  // The rewrite renames a step; a saved state would still show the old name.
  store.rewriteClaudeEvents((d) => JSON.parse(JSON.stringify(d).replace('"Build"', '"Rebuild"')));
  assert.equal(store.getSetting(planKey(a.id)), null);
  assert.equal((restart() as any).progressFor(a.id).tasks[1].subject, 'Rebuild');
});

test("a running minion's row gets its step's start and guess for the list's bar (#573)", () => {
  const t = newTicket();
  const live = restart();
  feed(live, t.id, [init, ...create(1, 'Look'), ...create(2, 'Build'), update(1, { status: 'in_progress', metadata: { estimate: 3 } })]);
  const started = store.listEvents(t.id).at(-1)!.created_at;
  store.updateTicket(t.id, { status: 'running' });
  assert.deepEqual(live.view(store.getTicket(t.id)!).steps, { done: 0, total: 2, since: started, usual: 180 });
  // A restarted server finds the same start from the stored events.
  assert.deepEqual(restart().view(store.getTicket(t.id)!).steps, { done: 0, total: 2, since: started, usual: 180 });
  // Not running: the row's bar counts steps done, so no time goes out.
  store.updateTicket(t.id, { status: 'idle' });
  assert.deepEqual(live.view(store.getTicket(t.id)!).steps, { done: 0, total: 2 });
  // Once steps have taken half their guesses (#571), the row's bar is scaled as the chat head's is.
  const done = newTicket();
  store.addStepTimes(
    done.id,
    Array.from({ length: 30 }, (_, i) => ({ id: String(i), subject: 's', estimate: 10, startedAt: i, finishedAt: i, work: 5 * 60_000, model: null })),
    null,
  );
  store.updateTicket(t.id, { status: 'running' });
  const row = restart().view(store.getTicket(t.id)!);
  assert.equal(row.step_ratio, 0.5);
  assert.deepEqual(row.steps, { done: 0, total: 2, since: started, usual: 90 });
});

// The server moves a tagged plan (#1923), in any scheme: this project isn't Citadel's.
test("a tagged plan moves from the minion's calls, the same after a restart at any point, and its reply's state ends it", () => {
  const t = newTicket();
  const steps = [
    { n: 1, step: 'Read', kind: 'read', minutes: 2 },
    { n: 2, step: 'Write A', kind: 'build', minutes: 4 },
    { n: 3, step: 'Write B', kind: 'build', minutes: 4 },
    { n: 4, step: 'Test', kind: 'test' },
    { n: 5, step: 'Ship', kind: 'ship' },
  ];
  const lines = [
    init,
    call('mcp__thread__plan', { steps }),
    call('Edit', { file_path: '/repo/a.ts' }),
    call('Bash', { command: 'npm test' }),
    call('Edit', { file_path: '/repo/a.ts' }),
    call('Bash', { command: 'npm test' }),
    call('mcp__thread__hand_off_land', { summary: 'x' }),
    say('Handed off.\n<!-- status: {"state":"pending-deploy","note":"going live"} -->'),
    result,
  ];
  const bars: string[] = [];
  let live = restart();
  for (const [i, line] of lines.entries()) {
    feed(live, t.id, [line]);
    live = restart();
    const got = (live as unknown as { progressFor(id: number): { tasks: { status: string }[] } }).progressFor(t.id);
    assert.deepEqual(plain(got), plain(fullReplay(t.id)), `after event ${i + 1}`);
    bars.push(got.tasks.map((s) => s.status[0]).join(''));
  }
  // Write B no edit could be told apart for stays to do (#2201); the round ends with the ship.
  assert.deepEqual(bars, ['', 'ipppp', 'cippp', 'cipip', 'cippp', 'cipip', 'cccci', 'ccccc', 'ccccc']);
  assert.deepEqual(live.view(store.getTicket(t.id)!).steps, { done: 5, total: 5 });
});
