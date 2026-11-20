// Three lines after every ship (#1119): a minion's lines queue per scheme on a clean ship, with no extra turn; the
// scheme's first real lines add its weekly Ship lessons schedule, which skips free when there is nothing to group.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { ScheduledRuns } from '../src/schedules.ts';
import { parseLearned, queueLesson } from '../src/ship-lessons.ts';
import { agentToken, bootServer, until } from './helpers.ts';
import { git } from './git.ts';

const root = mkdtempSync(join(tmpdir(), 'ship-lessons-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const newStore = () => new Store(join(root, `db-${++n}.sqlite`));
const lessonsCheck = (store: Store, project: number) => store.schedules.list(project).filter((s) => s.template === 'ship-lessons');

test('parseLearned keeps three tidy lines, reads "nothing" as an answer, and cuts rather than refuses', () => {
  assert.equal(parseLearned(undefined), null);
  assert.equal(parseLearned(42), null);
  assert.equal(parseLearned('Nothing.'), '');
  assert.equal(parseLearned('  none '), '');
  assert.equal(parseLearned('\n\n'), '');
  assert.equal(parseLearned('- land.sh needs main checked out\n\n* tests read $TMPDIR'), 'land.sh needs main checked out\ntests read $TMPDIR');
  assert.equal(parseLearned('a\nb\nc\nd').split('\n').length, 3, 'a fourth line is dropped');
  const long = parseLearned('x'.repeat(400))!;
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
});

test("the queue is per scheme: open lines list newest first, nothing-rows only count, and taken lines stop coming back", () => {
  const store = newStore();
  const peek = store.createProject('Peek Auras', null);
  const other = store.createProject('Mandate', null);
  const t = (project: number, number: number) => ({ id: 100 + number, project_id: project, number });
  const t0 = Date.now();
  store.lessons.add({ ...t(peek.id, 1), ticket_id: 101, lines: 'the shaders build only on Windows', files: ['src/fx.rs'], source: 'land' }, t0 - 3000);
  store.lessons.add({ ...t(peek.id, 2), ticket_id: 102, lines: '', files: [], source: 'land' }, t0 - 2000);
  store.lessons.add({ ...t(peek.id, 3), ticket_id: 103, lines: 'fx needs a Windows build\nCI caches the SDK', files: ['src/fx.rs', 'ci.yml'], source: 'land' }, t0 - 1000);
  store.lessons.add({ ...t(other.id, 4), ticket_id: 104, lines: 'mandate line', files: [], source: 'land' }, t0);

  const open = store.lessons.list(peek.id);
  assert.deepEqual(open.map((l) => l.number), [3, 1], 'newest first, the nothing-row left out, the other scheme left out');
  assert.deepEqual(open[0].files, ['src/fx.rs', 'ci.yml']);
  assert.deepEqual(store.lessons.stats(peek.id, t0 - 60_000), { ships: 3, withLines: 2 });

  assert.deepEqual(store.lessons.take(peek.id, [open[0].id, open[1].id, store.lessons.list(other.id)[0].id], 'proposed: docs/build.md'), [open[0].id, open[1].id], "another scheme's id is skipped");
  assert.deepEqual(store.lessons.list(peek.id), []);
  assert.equal(store.lessons.list(peek.id, { taken: true })[0].taken_note, 'proposed: docs/build.md');
  assert.deepEqual(store.lessons.take(peek.id, [open[0].id], 'again'), [], 'taken once');
  assert.equal(store.lessons.list(other.id).length, 1);
});

test("log_learned's second call replaces its first within a few hours; a land always adds its own row", () => {
  const store = newStore();
  const p = store.createProject('Delve', null);
  const t = { id: 5, project_id: p.id, number: 5 };
  queueLesson(store, '/data', t, 'first try', [], 'tool');
  queueLesson(store, '/data', t, 'corrected', [], 'tool');
  assert.deepEqual(store.lessons.list(p.id).map((l) => l.lines), ['corrected']);
  queueLesson(store, '/data', t, 'second piece', [], 'land');
  queueLesson(store, '/data', t, 'third piece', [], 'land');
  assert.equal(store.lessons.list(p.id).length, 3);
});

test('a scheme gets its weekly Ship lessons schedule on its first real lines, once; "nothing" adds none', () => {
  const store = newStore();
  const p = store.createProject('Theory of Crafting', null);
  const q = store.createProject('Plain', null);
  queueLesson(store, '/data', { id: 1, project_id: p.id, number: 1 }, '', [], 'land');
  assert.equal(lessonsCheck(store, p.id).length, 0, 'a nothing-ship adds no schedule');
  queueLesson(store, '/data', { id: 2, project_id: p.id, number: 2 }, 'vitest needs --pool=forks here', [], 'land');
  const [s] = lessonsCheck(store, p.id);
  assert.ok(s, 'added on the first real lines');
  assert.equal(s.model, 'claude-sonnet-5-5');
  assert.equal(s.category, 'Process');
  assert.match(s.brief, /Theory of Crafting's ship lessons/);
  assert.equal(lessonsCheck(store, q.id).length, 0, 'another scheme gets none until it ships lines');
  store.schedules.remove(s.id);
  queueLesson(store, '/data', { id: 3, project_id: p.id, number: 3 }, 'another', [], 'land');
  assert.equal(lessonsCheck(store, p.id).length, 0, 'a deleted one stays deleted');
});

test('the weekly run skips free with fewer than two open lines or none new since the last run, and runs otherwise', async () => {
  const store = newStore();
  const p = store.createProject('Genesis Tree', null);
  const made: number[] = [];
  const runs = new ScheduledRuns({
    store,
    newMinion: async (project, m, by) => {
      const t = store.createTicket({ project_id: project.id, title: m.title, permission_mode: 'bypassPermissions', created_by: by });
      made.push(t.id);
      return { id: t.id, number: t.number! };
    },
    runner: { emit: () => {}, send: () => {}, limitWait: () => null, netWait: () => null } as any,
    broadcast: () => {},
    by: 'Citadel',
    dataDir: '/data',
  });
  queueLesson(store, '/data', { id: 1, project_id: p.id, number: 1 }, 'one line', [], 'land');
  const [s] = lessonsCheck(store, p.id);
  const due = () => (store as any).db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() - 1, s.id);
  due();
  await runs.runDue();
  assert.deepEqual(made, []);
  assert.match(store.schedules.get(s.id)!.last_skip!, /1 open ship lesson, too few to repeat/);

  queueLesson(store, '/data', { id: 2, project_id: p.id, number: 2 }, 'two lines', [], 'land');
  due();
  await runs.runDue();
  assert.equal(made.length, 1, 'two open lines, one new: it runs');
  assert.match(store.getTicket(made[0])!.title, /Ship lessons/);

  store.updateTicket(made[0], { status: 'closed' });
  due();
  await runs.runDue();
  assert.equal(made.length, 1, 'nothing new since that run');
  assert.match(store.schedules.get(s.id)!.last_skip!, /no new ship lessons since/);
});

// The Done when: a ship adds its lines to the queue with no extra turn. A real server, a scheme other than Citadel,
// a branch that touched a file, and a land.sh that reports a live land.
test('a handed-off land queues its lines with the files the branch touched; a failed one queues nothing; log_learned and the queue routes work', async () => {
  const srv = await bootServer();
  try {
    const store = new Store(join(srv.data, 'coordinator.db'));
    const project = store.createProject('Peek Auras', null);
    const mk = (title: string) => store.createTicket({ project_id: project.id, title, permission_mode: 'default', created_by: 'Cara' });
    const cwd = join(srv.root, 'wt');
    mkdirSync(join(cwd, 'tools'), { recursive: true });
    const landSh = (out: string, code: number) => `if [ "$1" = --check ]; then exit 0; fi\nprintf '%b' ${JSON.stringify(out)}\nexit ${code}\n`;
    writeFileSync(join(cwd, 'tools', 'land.sh'), landSh('land: tests failed\n', 1));
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'init');
    git(cwd, 'checkout', '-qb', 'ticket/1-x');
    writeFileSync(join(cwd, 'fx.rs'), 'fn main() {}\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'fx');

    const failed = mk('Fails');
    store.setTicketDir(failed.id, cwd, null);
    const call = (id: number, path: string, body?: object) => fetch(`${srv.base}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${agentToken(srv.data, id)}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const body = { summary: 'Fx', risk: 'low', risk_reason: 'r', learned: 'fx builds only on Windows\nthe shader cache lives in target/fx' };
    assert.equal((await call(failed.id, `/api/tickets/${failed.id}/land/handoff`, body)).status, 202);
    await until('the failed land is reported', () => store.getTicket(failed.id)!.state === null, 20_000);
    assert.equal(store.lessons.stats(project.id, 0).ships, 0, 'a failed land queues nothing');

    writeFileSync(join(cwd, 'tools', 'land.sh'), landSh('land: main is now at abc1234 "#2: fx"\ndeploy: live now: the server reloaded the front end (v2); open tabs reload when idle. No restart.\n', 0));
    git(cwd, 'commit', '-qam', 'land ok');
    const minion = mk('Ships');
    store.setTicketDir(minion.id, cwd, null);
    assert.equal((await call(minion.id, `/api/tickets/${minion.id}/land/handoff`, body)).status, 202);
    await until('the clean land is reported', () => store.getTicket(minion.id)!.status === 'closed', 20_000);
    const [row] = store.lessons.list(project.id);
    assert.equal(row.lines, 'fx builds only on Windows\nthe shader cache lives in target/fx');
    assert.equal(row.number, store.getTicket(minion.id)!.number);
    assert.deepEqual(row.files.sort(), ['fx.rs', 'tools/land.sh']);
    assert.equal(lessonsCheck(store, project.id).length, 1, 'its first lines added the weekly pass');

    // A pull-request ship logs its lines with log_learned instead.
    const pr = mk('PR ship');
    store.setTicketDir(pr.id, cwd, null);
    const logged = await (await call(pr.id, `/api/tickets/${pr.id}/learned`, { learned: 'Nothing' })).json();
    assert.equal(logged.lines, '');
    assert.equal((await call(pr.id, `/api/tickets/${pr.id}/learned`, {})).status, 400);

    const read = await (await call(pr.id, `/api/projects/${project.id}/ship-lessons`)).json();
    assert.deepEqual(read.week, { ships: 2, withLines: 1 });
    assert.equal(read.lessons.length, 1);
    const took = await (await call(pr.id, `/api/projects/${project.id}/ship-lessons/take`, { ids: [read.lessons[0].id], note: 'proposed: docs/build.md' })).json();
    assert.deepEqual(took.taken, [read.lessons[0].id]);
    assert.equal((await call(pr.id, `/api/projects/${project.id}/ship-lessons/take`, { ids: [], note: 'x' })).status, 400);
  } finally {
    await srv.stop();
  }
});
