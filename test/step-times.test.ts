// Step times (#571): each finished step of a minion's plan is recorded with its guess and working time, and
// the readout's ratio is what those steps took against their guesses.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { STEP_RATIO, Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, testPins, until } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'step-times-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

// A stand-in `claude -p` whose turn makes a plan of two steps, starts the first and finishes it.
const fake = join(root, 'claude-fake');
const turn = [
  { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5' },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'TaskCreate', input: { subject: 'Read', description: 'x', metadata: { estimate: 10 } } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Task #1 created successfully: Read' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c2', name: 'TaskCreate', input: { subject: 'Build', description: 'x' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'Task #2 created successfully: Build' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's1' },
];
writeFileSync(
  fake,
  `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
  for (const ev of ${JSON.stringify(turn)}) console.log(JSON.stringify(ev));
  process.exit(0);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const runner = new Runner(
  store,
  () => {},
  () => ({}),
  fake,
);

let n = 0;
function minion(projectId = store.createProject(`P${++n}`, null).id) {
  const t = store.createTicket({ project_id: projectId, title: `M${++n}`, permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, `t${t.id}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  return store.getTicket(t.id)!;
}
type StepRow = { ticket_id: number; task_id: string; subject: string; estimate: number | null; started_at: number; finished_at: number; work_ms: number; model: string | null; effort: string | null };
const rows = (ticketId: number) => store.db.prepare('SELECT * FROM step_times WHERE ticket_id = ? ORDER BY started_at').all(ticketId) as StepRow[];
/** A stored Claude event at a given minute. */
const at = (min: number) => 1_000_000_000 + min * 60_000;
const event = (ticketId: number, data: object, min: number) => store.db.prepare("INSERT INTO events (ticket_id, kind, data, created_at) VALUES (?, 'claude', ?, ?)").run(ticketId, JSON.stringify(data), at(min));
const call = (ticketId: number, name: string, input: object, min: number) => event(ticketId, { type: 'assistant', message: { content: [{ type: 'tool_use', id: `x${++n}`, name, input }] } }, min);

test('a step finished in a turn is recorded as it finishes, and the backfill leaves it at one row', async () => {
  const t = minion();
  store.updateTicketQuietly(t.id, { last_effort: 'high' });
  runner.send(t.id, 'Cara', 'go');
  await until('the step to be recorded', async () => rows(t.id).length > 0 && !runner.isRunning(t.id));
  const [row] = rows(t.id);
  const started = store.listEvents(t.id).find((e) => e.data.includes('"u1"'))!;
  const done = store.listEvents(t.id).find((e) => e.data.includes('"u2"'))!;
  assert.deepEqual(
    { ...row },
    {
      ticket_id: t.id,
      task_id: '1',
      subject: 'Read',
      estimate: 10,
      started_at: started.created_at,
      finished_at: done.created_at,
      work_ms: done.created_at - started.created_at,
      model: 'claude-opus-5-5',
      effort: 'high',
    },
    'timed by the stored events, so a replay of them finds the same step',
  );
  await runner.backfillStepTimes();
  assert.equal(rows(t.id).length, 1, 'the backfill finds the same step and adds nothing');
});

test("the backfill records each finished step's working time across turns, and none for a step never started", async () => {
  store.deleteSetting('step_times_backfilled');
  const t = minion();
  event(t.id, { type: 'system', subtype: 'init', model: 'claude-fable-5-2' }, 0);
  for (const [id, subject] of [
    ['1', 'Read'],
    ['2', 'Skip'],
  ]) {
    event(t.id, { type: 'assistant', message: { content: [{ type: 'tool_use', id: `tc${id}`, name: 'TaskCreate', input: { subject, description: 'x', metadata: { estimate: 30 } } }] } }, 0);
    event(t.id, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tc${id}`, content: `Task #${id} created successfully` }] } }, 0);
  }
  call(t.id, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, 1);
  event(t.id, { type: 'result', is_error: false }, 6); // waits an hour on a card
  event(t.id, { type: 'system', subtype: 'init', model: 'claude-fable-5-2' }, 66);
  call(t.id, 'TaskUpdate', { taskId: '1', status: 'completed' }, 70);
  call(t.id, 'TaskUpdate', { taskId: '2', status: 'completed' }, 70);
  event(t.id, { type: 'result', is_error: false }, 71);
  await runner.backfillStepTimes();
  assert.deepEqual(
    rows(t.id).map((r) => [r.task_id, r.started_at, r.finished_at, r.work_ms, r.model]),
    [['1', at(1), at(70), 9 * 60_000, 'claude-fable-5-2']],
    '5 minutes in the first turn and 4 in the second, not the hour between; the step never started writes nothing',
  );
  assert.equal(store.getSetting('step_times_backfilled'), true);
  await runner.backfillStepTimes();
  assert.equal(rows(t.id).length, 1, 'it runs once');
});

test("the ratio is working over guessed minutes summed over the newest steps, the scheme's own once it has enough, and 1 below the least", () => {
  const fresh = new Store(join(root, 'ratio.db'));
  const a = fresh.createProject('A', null).id;
  const b = fresh.createProject('B', null).id;
  const ta = fresh.createTicket({ project_id: a, title: 'a', permission_mode: 'default', created_by: 'Cara' }).id;
  const tb = fresh.createTicket({ project_id: b, title: 'b', permission_mode: 'default', created_by: 'Cara' }).id;
  let k = 0;
  const steps = (ticketId: number, count: number, guess: number | null, workMin: number) =>
    fresh.addStepTimes(
      ticketId,
      Array.from({ length: count }, () => ({ id: String(++k), subject: 's', estimate: guess, startedAt: k, finishedAt: k, work: workMin * 60_000, model: null })),
      null,
    );
  steps(ta, STEP_RATIO.least - 1, 10, 3);
  steps(ta, 5, null, 50); // no guess: not counted
  assert.equal(fresh.stepRatio(a), 1, 'too few steps anywhere');
  steps(tb, 1, 20, 2); // 30 guessed steps across schemes: 29×3 + 2 over 29×10 + 20
  assert.equal(fresh.stepRatio(a).toFixed(4), ((29 * 3 + 2) / (29 * 10 + 20)).toFixed(4), "every scheme's, while A has fewer than its own needs");
  steps(ta, STEP_RATIO.scheme, 10, 1); // A's newest 50 + its older 29 guessed steps
  assert.equal(fresh.stepRatio(a).toFixed(4), ((50 * 1 + 29 * 3) / (79 * 10)).toFixed(4), "A's own once it has enough");
  steps(ta, STEP_RATIO.recent, 10, 5);
  assert.equal(fresh.stepRatio(a), 0.5, 'only the newest STEP_RATIO.recent count');
  assert.equal(fresh.stepRatio(b), 0.5, "B, with one of its own, uses every scheme's newest");
  fresh.deleteTicket(ta);
  fresh.deleteTicket(tb);
  assert.equal(fresh.db.prepare('SELECT COUNT(*) AS n FROM step_times').get()!.n, 0, 'a deleted minion takes its steps with it');
  fresh.db.close();
});
