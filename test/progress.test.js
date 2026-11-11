import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, createProgress, describeAction, liveSteps, nowDoing, progressLine, THINKING_AFTER, withoutCount } from '../public/progress.js';

// A plan of six steps with the given statuses: c(ompleted), i(n progress), p(ending).
const plan = (statuses) => ({
  ...createProgress(),
  tasks: [...statuses].map((s, n) => ({
    id: String(n + 1), subject: `Move turns ${n + 1}`, activeForm: `Moving turns ${n + 1}`, actions: 0,
    status: { c: 'completed', i: 'in_progress', p: 'pending' }[s],
  })),
});

test('every readout counts steps done, the number the list badge shows (#518)', () => {
  // The badge reads done/total; a line naming the step's place ("Step 3 of 6") beside "2/6" reads as out of sync.
  for (const statuses of ['ippppp', 'ccippp', 'ccpcip']) {
    const p = plan(statuses);
    const done = [...statuses].filter((s) => s === 'c').length;
    for (const running of [true, false]) {
      const line = progressLine(p, running);
      assert.match(line, new RegExp(`\\b${done} of 6 done$`), line);
      assert.doesNotMatch(line, /Step|step \d/, line);
    }
  }
  assert.equal(progressLine(plan('ccippp'), true), 'Moving turns 3… · 2 of 6 done');
});

test('paused, done and between-steps lines read sensibly', () => {
  assert.equal(progressLine(plan('cipppp'), false), 'Paused at: Move turns 2 · 1 of 6 done');
  assert.equal(progressLine(plan('cccccc'), false), 'Done · 6/6 steps');
  assert.equal(progressLine(plan('ccpppp'), true), 'Working… 2 of 6 done');
  assert.equal(progressLine(plan('pppppp'), true), 'Planning… 0 of 6 done');
  assert.equal(progressLine(plan('ccpppp'), false), 'Paused… 2 of 6 done');
});

test('a finished plan says nothing about a new running turn', () => {
  assert.equal(progressLine({ ...plan('cccccc'), lastAction: 'Read app.js' }, true), 'Working… Read app.js');
});

test("a step an earlier turn left underway isn't shown as underway in the next turn until the plan moves (#518)", () => {
  const p = createProgress();
  const claude = (data) => applyEvent(p, 'claude', data);
  const call = (name, input, id = name + Math.random()) => claude({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  call('TaskCreate', { subject: 'Land it', activeForm: 'Landing it' }, 'c1');
  claude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Task #1 created successfully' }] } });
  call('TaskCreate', { subject: 'Wait on the Allow', activeForm: 'Waiting on the Allow' }, 'c2');
  claude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'Task #2 created successfully' }] } });
  call('TaskUpdate', { taskId: '1', status: 'completed' });
  call('TaskUpdate', { taskId: '2', status: 'in_progress' });
  claude({ type: 'result', subtype: 'success', is_error: false });
  // Between turns it is still waiting there.
  assert.equal(progressLine(p, false), 'Paused at: Wait on the Allow · 1 of 2 done');
  // A card's answer starts a turn: the runner marks it running before the turn's init arrives.
  assert.equal(progressLine(p, true), 'Working… 1 of 2 done');
  claude({ type: 'system', subtype: 'init' });
  call('Bash', { command: 'tools/land.sh', description: 'Land the PR' });
  assert.equal(progressLine(p, true), 'Working… Running commands · 1 of 2 done');
  // Once the minion moves its plan in this turn, its step is current again.
  call('TaskUpdate', { taskId: '2', activeForm: 'Landing through the old land.sh' });
  assert.equal(progressLine(p, true), 'Landing through the old land.sh… · 1 of 2 done');
});

test("a new turn's work before its plan moves isn't filed under the step an earlier turn left underway (#518)", () => {
  const p = { ...plan('cipppp'), planMoved: false };
  const run = (id) => applyEvent(p, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } });
  assert.equal(run('b1')[0].taskId, null);
  applyEvent(p, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } }] } });
  assert.equal(run('b2')[0].taskId, '2');
});

test('withoutCount drops the count from every form, old and new', () => {
  const cases = {
    'Moving turns into units… · 2 of 6 done': 'Moving turns into units…',
    'Paused at: Move turns · 1 of 6 done': 'Paused at: Move turns',
    'Working… Read app.js · 2 of 6 done': 'Working… Read app.js',
    'Working… 2 of 6 done': 'Working…',
    'Done · 6/6 steps': 'Done',
    // Older forms, still in stored last_activity until the minion's next event.
    'Step 1 of 6: Moving turns into units…': 'Moving turns into units…',
    'Paused at step 2 of 6: Move turns': 'Paused at: Move turns',
    'Moving turns into units… 1/6': 'Moving turns into units…',
    'Paused at: Move turns 1/6': 'Paused at: Move turns',
    'Working… Read app.js': 'Working… Read app.js',
  };
  for (const [line, want] of Object.entries(cases)) assert.equal(withoutCount(line), want, line);
});

test("a new TodoWrite plan's steps get new ids, so the last plan's actions don't show under them (#468 S11-8)", () => {
  const p = createProgress();
  const todo = (id, ...subjects) => applyEvent(p, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos: subjects.map((s, n) => ({ content: s, activeForm: s, status: n ? 'pending' : 'in_progress' })) } }] } });
  const read = (id) => applyEvent(p, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/a.js' } }] } });
  todo('t1', 'Look', 'Fix');
  const first = read('r1')[0].taskId;
  todo('t2', 'Look', 'Fix'); // the same plan, its statuses moved on
  assert.equal(p.tasks[0].id, first, 'a step keeps its id while the plan keeps its steps');
  todo('t3', 'Test', 'Ship');
  assert.notEqual(p.tasks[0].id, first);
  assert.notEqual(read('r2')[0].taskId, first);
});

test("git's options before the subcommand don't stand in for it (#468 S11-12)", () => {
  const words = (command) => describeAction({ name: 'Bash', input: { command } }).text;
  assert.equal(words('git -C /home/x/repo status'), 'Checked what changed');
  assert.equal(words('git -c a.b=1 log --oneline'), 'Looked at commit history');
  assert.equal(words('git --git-dir /x/.git --work-tree /x diff'), 'Looked at code changes');
  assert.equal(words('git --git-dir=/x/.git show HEAD'), 'Looked at a commit');
});

test("an amended plan's steps keep their ids, so a step's actions still show under it (#468 S11-8 review)", () => {
  const p = createProgress();
  const todo = (id, todos) => applyEvent(p, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos: todos.map(([s, status]) => ({ content: s, activeForm: s, status })) } }] } });
  const read = (id) => applyEvent(p, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/a.js' } }] } });
  todo('t1', [['Look', 'in_progress'], ['Fix', 'pending']]);
  const look = read('r1')[0].taskId;
  const fix = p.tasks[1].id;
  todo('t2', [['Look', 'completed'], ['Fix', 'in_progress'], ['Add a test', 'pending']]);
  assert.deepEqual(p.tasks.slice(0, 2).map((t) => t.id), [look, fix], 'a step added to the plan leaves the others theirs');
  assert.ok(![look, fix].includes(p.tasks[2].id));
  todo('t3', [['Fix', 'completed'], ['Add a test', 'in_progress']]);
  assert.equal(p.tasks[0].id, fix, 'nor does a step dropped from it');
});

test('a turn that died says so, not the Done of a plan an earlier turn finished', () => {
  const p = plan('cccccc');
  applyEvent(p, 'error', { text: 'API Error: Can\'t reach the API server' });
  assert.equal(progressLine(p, false), 'Last turn failed: see the error below');
  // The next turn's start clears it (and drops the finished plan).
  applyEvent(p, 'claude', { type: 'system', subtype: 'init' });
  assert.equal(progressLine(p, false), '');
});

test('an error after a turn finished well (a deploy warning) or during one that then finished is not a failed turn', () => {
  const p = plan('cccccc');
  applyEvent(p, 'claude', { type: 'system', subtype: 'init' });
  applyEvent(p, 'error', { text: 'The thread MCP server is failed in this turn' });
  applyEvent(p, 'claude', { type: 'result', subtype: 'success', is_error: false });
  assert.notEqual(progressLine(p, false), 'Last turn failed: see the error below');
  applyEvent(p, 'error', { text: 'Live, but the push to GitHub failed' });
  assert.notEqual(progressLine(p, false), 'Last turn failed: see the error below');
  // A turn whose result was an error, then the runner's error event, did fail.
  applyEvent(p, 'claude', { type: 'system', subtype: 'init' });
  applyEvent(p, 'claude', { type: 'result', subtype: 'error_during_execution', is_error: true });
  applyEvent(p, 'error', { text: 'API Error' });
  assert.equal(progressLine(p, false), 'Last turn failed: see the error below');
});

test('the live card keeps a finished call\'s label for a few seconds, then says Thinking (#543)', () => {
  const read = { block: { type: 'tool_use', name: 'Read', input: { file_path: '/x/runner.ts' } } };
  const label = describeAction(read.block).text;
  assert.equal(nowDoing([], 0), 'Thinking…');
  assert.equal(nowDoing([{ ...read, result: null }], 99_999), label, 'a call underway shows however long it runs');
  const done = { ...read, result: { content: 'ok' }, doneAt: 10_000 };
  assert.equal(nowDoing([done], 10_000 + THINKING_AFTER - 1), label, 'the gap before the next call keeps the label');
  assert.equal(nowDoing([done], 10_000 + THINKING_AFTER), 'Thinking…');
});

test('the live card counts steps done like every readout, and shows the last two steps done (#518, #543)', () => {
  const p = plan('cccipp');
  p.tasks[1].outcome = 'Found it';
  const card = liveSteps(p, true);
  assert.equal(card.title, 'Moving turns 4');
  assert.equal(card.count, '3 of 6 done');
  assert.deepEqual(card.finished.map((t) => t.subject), ['Move turns 2', 'Move turns 3']);
  assert.deepEqual(liveSteps(createProgress(), true), { title: 'Working', count: '', finished: [] });
  // A step an earlier turn left underway isn't this turn's until the plan moves.
  const stale = { ...plan('cipppp'), planMoved: false };
  assert.equal(liveSteps(stale, true).title, 'Working');
});
