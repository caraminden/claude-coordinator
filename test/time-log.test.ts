// The minion time log (#1991): events in, stretches and rows out (src/time-log.ts).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import type { EventRow } from '../src/db-rows.ts';
import { cardTimes, cutTime, timeLog, type LogTicket, type TimeLog } from '../src/time-log.ts';

const root = mkdtempSync(join(tmpdir(), 'time-log-'));
after(() => rmSync(root, { recursive: true, force: true }));
const store = new Store(join(root, 'coordinator.db'));
const project = store.createProject('Other scheme', null);
const MIN = 60_000;
const T0 = 1_795_000_000_000;

// A minion made at minute 0, its events written at given minutes.
function minion(extra: Partial<LogTicket> = {}) {
  const t = store.createTicket({ project_id: project.id, kind: 'ticket', title: 'M', permission_mode: 'default', created_by: 'Cara' });
  let call = 0;
  const at = (m: number, kind: string, data: unknown) => {
    const row = store.addEvent(t.id, kind, data);
    store.db.prepare('UPDATE events SET created_at = ? WHERE id = ?').run(T0 + m * MIN, row.id);
    return row.id;
  };
  const claude = (m: number, data: unknown) => at(m, 'claude', data);
  const say = (m: number, text: string) => claude(m, { type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const use = (m: number, name: string, input: unknown, opts: { id?: string } = {}) => {
    const id = opts.id ?? `c${++call}`;
    claude(m, { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    return id;
  };
  const result = (m: number, id: string, content = 'ok', is_error = false) => claude(m, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
  return {
    id: t.id,
    at,
    say,
    init: (m: number) => claude(m, { type: 'system', subtype: 'init' }),
    end: (m: number) => claude(m, { type: 'result', subtype: 'success' }),
    use,
    result,
    bash: (from: number, to: number, command: string, out = 'ok', err = false) => result(to, use(from, 'Bash', { command }), out, err),
    plan: (m: number, steps: unknown[]) => result(m, use(m, 'mcp__thread__plan', { steps })),
    note: (m: number, text: string) => at(m, 'note', { text }),
    log: (now: number, over: Partial<LogTicket> = {}) => timeLog(store, { id: t.id, created_at: T0, status: 'idle', state: null, closed_at: null, ...extra, ...over }, T0 + now * MIN),
  };
}
const mins = (ms: number) => Math.round((ms / MIN) * 10) / 10;
const segs = (l: TimeLog) => l.segs.map((s) => [mins(s.start - T0), mins(s.end - T0), s.kind, s.sub ?? '', s.guess ? 'guess' : '']);
const rows = (l: TimeLog) => l.rows.map((r) => [r.type, r.title, mins(r.work), mins(r.wait), mins(r.lost)]);

test('a plan of steps: each has its own time, its outcome, and the waits between them are rows', async () => {
  const m = minion();
  m.init(0);
  m.plan(0.2, [{ n: 1, step: 'Read' }, { n: 2, step: 'Build' }]);
  m.plan(0.5, [{ n: 1, status: 'doing' }]);
  m.bash(2, 4, 'rg x');
  m.plan(5, [{ n: 1, status: 'done', outcome: 'It was there.' }, { n: 2, status: 'doing' }]);
  m.end(8);
  m.at(20, 'user_message', { author: 'Cara', text: 'go on' });
  m.init(20.1);
  m.plan(22, [{ n: 2, status: 'done', outcome: 'Built.' }]);
  m.end(22);
  const l = await m.log(22, { state: 'ready' });
  const read = l.rows.find((r) => r.title === 'Read')!;
  const build = l.rows.find((r) => r.title === 'Build')!;
  assert.equal(mins(read.work), 4.5);
  assert.equal(mins(build.work), 4.9); // 5 to 8, then 20.1 to 22
  assert.equal(build.outcome, 'Built.');
  assert.deepEqual(l.rows.map((r) => r.type).slice(0, 3), ['step', 'step', 'wait']);
  assert.match(l.rows[2].title, /Waiting on Cara/);
  // A message that started the next turn says who, not that it was a person: a guess.
  assert.deepEqual(segs(l).find((s) => s[0] === 8), [8, 20, 'wait', 'person', 'guess']);
});

test('steps overlap: the one that started last owns the time; a step edge cuts the stretch', async () => {
  const m = minion();
  m.init(0);
  m.plan(0, [{ n: 1, step: 'A', status: 'doing' }, { n: 2, step: 'B' }]);
  m.plan(4, [{ n: 2, status: 'doing' }]);
  m.plan(9, [{ n: 2, status: 'done', outcome: 'b' }]);
  m.plan(10, [{ n: 1, status: 'done', outcome: 'a' }]);
  m.end(10);
  const l = await m.log(10);
  const of = (t: string) => mins(l.rows.find((r) => r.title === t)!.work);
  assert.equal(of('A') + of('B'), 10);
  assert.ok(of('B') >= 5);
});

test('never planned: its own lines stand in for steps', async () => {
  const m = minion();
  m.init(0);
  m.say(0.1, 'Reading the code that draws the bar.');
  m.bash(1, 2, 'ls');
  m.say(3, 'Cause found: the bar counts wrongly. Fixing it.');
  m.end(6);
  const l = await m.log(6);
  assert.deepEqual(
    l.rows.map((r) => r.type),
    ['line', 'line'],
  );
  assert.match(l.rows[0].title, /Reading the code/);
  assert.match(l.rows[1].title, /Cause found/);
  assert.equal(mins(l.totals.work), 6);
});

test('a wait command waits, unless other work runs; a time-limited run is lost; an ordinary command works', async () => {
  const m = minion();
  m.init(0);
  m.bash(1, 3, 'citadel-wait pid 5');
  m.bash(3, 6, 'npm test', 'Exit code 143\nCommand timed out after 3m 0s', true);
  m.bash(6, 8, 'rg x', 'Exit code 1', true);
  m.end(8);
  const l = await m.log(8);
  assert.equal(mins(l.totals.wait), 2);
  assert.equal(mins(l.totals.lost), 3);
  assert.equal(mins(l.totals.work), 3);
  const cut = l.segs.find((s) => s.sub === 'cut')!;
  assert.equal(cut.guess, true, 'worked out from the words, not recorded');
  assert.ok(cut.event);

  const b = minion();
  b.init(0);
  const wait = b.use(1, 'Bash', { command: 'citadel-wait pid 5' });
  const work = b.use(1, 'Bash', { command: 'npm test' });
  b.result(4, work);
  b.result(6, wait);
  b.end(6);
  assert.equal(mins((await b.log(6)).totals.wait), 2, 'only the part nothing else ran over');
});

test('cards, ships, holds, limits, kills and dismissals are exact, and cut a gap in turn', async () => {
  const m = minion();
  m.note(0, "Created by Taskmaster; its brief is held until #12 Other's work is live. Messages to it wait for that start; Unseal starts it now.");
  m.note(10, "#12's work is live, so this minion started.");
  m.init(10.1);
  m.at(14.9, 'question', { id: 'q1', questions: [{}] });
  m.end(15);
  m.at(40, 'user_message', { author: 'Cara', text: 'My answers', answer: { questionId: 'q1' } });
  m.init(40.1);
  const ho = m.use(44, 'mcp__thread__hand_off_land', {});
  m.result(44, ho);
  m.end(45);
  m.note(60, 'Shipped abc "x": y');
  m.note(62, 'Shipped and live, so the server dismissed this minion.');
  const l = await m.log(70, { status: 'closed', closed_at: T0 + 62 * MIN });
  assert.deepEqual(
    segs(l).filter((s) => s[2] !== 'work'),
    [
      [0, 10, 'wait', 'hold', ''],
      [10, 10.1, 'wait', 'unknown', 'guess'],
      [15, 40, 'wait', 'person', ''],
      [40, 40.1, 'wait', 'start', ''],
      [45, 60, 'wait', 'ship', ''],
      [60, 62, 'wait', 'deploy', ''],
    ],
  );
  assert.ok(l.segs.every((s) => s.kind === 'work' || s.sub === 'unknown' || s.sub === 'start' || s.event), 'each known wait names its event');
  assert.equal(l.end, T0 + 62 * MIN);

  const k = minion();
  k.init(0);
  k.bash(1, 2, 'ls');
  k.note(5, "The turn's process was killed before it finished, with no record of how.\nCitadel resumes it by itself in a moment, once: killed again, it stops for good.");
  k.init(7);
  k.end(8);
  assert.deepEqual(segs(await k.log(8)).find((s) => s[2] === 'lost'), [2, 7, 'lost', 'kill', '']);

  const u = minion();
  u.init(0);
  u.note(3, "You've hit your weekly limit · resets 5pm");
  u.note(90, 'Resumed after the usage limit reset');
  u.init(90);
  u.end(91);
  assert.deepEqual(segs(await u.log(91)).find((s) => s[3] === 'limit')?.slice(0, 4), [3, 90, 'wait', 'limit']);
});

test('states: running grows, not started waits, finished and dismissed stop, stopped waits for a message', async () => {
  const r = minion();
  r.init(0);
  assert.equal((await r.log(5, { status: 'running' })).running, true);
  assert.equal((await r.log(7, { status: 'running' })).totals.work, 7 * MIN, 'the same log, later: the last stretch grew');

  const n = minion();
  const none = await n.log(3, { status: 'new' });
  assert.deepEqual(segs(none), [[0, 3, 'wait', 'start', 'guess']]);

  const s = minion();
  s.init(0);
  s.note(2, 'Stopped by user.');
  const stopped = await s.log(10);
  assert.equal(stopped.rows.at(-1)!.title, 'Stopped, waiting for a message');
  assert.deepEqual(segs(stopped).at(-1)?.slice(2, 5), ['wait', 'stopped', '']);

  const f = minion();
  f.init(0);
  f.end(2);
  const done = await f.log(60, { state: 'complete' });
  assert.equal(done.segs.at(-1)!.kind, 'gone');
  assert.equal(done.totals.wait, 0, 'finished time is nobody’s wait');

  const w = minion();
  w.init(0);
  w.end(2);
  const waits = await w.log(30, { state: 'ready' });
  assert.deepEqual(segs(waits).at(-1)?.slice(2, 5), ['wait', 'person', 'guess']);
});

test('an old minion: a gap nothing explains is marked, not named', async () => {
  const m = minion();
  m.init(0);
  m.end(5);
  m.at(60, 'user_message', { author: 'Citadel', text: 'You hold the claim now.' });
  m.init(60);
  m.end(61);
  const l = await m.log(61, { state: 'complete' });
  assert.deepEqual(segs(l)[1], [5, 60, 'wait', 'unknown', 'guess']);
  assert.equal(l.totals.guess, 55 * MIN);
});

test('a recorded wait replaces a guess over it', async () => {
  const m = minion();
  m.init(0);
  m.end(5);
  m.init(30);
  m.end(31);
  const s = (await import('../src/time-log.ts')).cutTime;
  const base = await m.log(31);
  assert.equal(base.segs[1].guess, true);
  const t = { id: m.id, created_at: T0, status: 'idle', state: null, closed_at: null };
  const l = await timeLog(store, t, T0 + 31 * MIN, [{ start: T0 + 5 * MIN, end: T0 + 30 * MIN, kind: 'wait', sub: 'ship', title: 'Ship line' }]);
  assert.deepEqual(segs(l)[1], [5, 30, 'wait', 'ship', '']);
  assert.ok(s);
});

test('a card settled in place, by a result event or by a message closes at the first of them', () => {
  const row = (id: number, kind: string, data: unknown, at: number) => ({ id, ticket_id: 1, kind, data: JSON.stringify(data), created_at: at }) as EventRow;
  const cards = cardTimes([row(1, 'question', { id: 'a' }, 10), row(2, 'question', { id: 'b', settled: { at: 30 } }, 20), row(3, 'question_result', { id: 'a' }, 50), row(4, 'question', { id: 'n', notice: 'x' }, 5)], [{ at: 40, event: 9, tag: 'message', answers: 'a' }]);
  assert.deepEqual(
    cards.map((c) => [c.id, c.end]),
    [
      ['a', 40],
      ['b', 30],
    ],
  );
});

test('the longest chat reads in pages, and again for only what is new', async () => {
  const m = minion();
  m.init(0);
  for (let i = 0; i < 900; i++) m.bash(1 + i / 100, 1 + i / 100, 'ls');
  m.end(12);
  let pages = 0;
  const real = store.timeLogEvents;
  store.timeLogEvents = function (...a) {
    pages++;
    return real.apply(this, a);
  };
  const first = await m.log(12);
  assert.ok(pages > 5, `${pages} pages`);
  pages = 0;
  const [a, b] = await Promise.all([m.log(12), m.log(12)]);
  assert.ok(pages <= 2, 'nothing new is read again');
  assert.deepEqual(a.totals, first.totals);
  assert.deepEqual(b.totals, first.totals, 'two reads at once give one answer');
  store.timeLogEvents = real;
});

test('every stretch is contiguous and the totals add up, whatever the events', async () => {
  const m = minion();
  m.init(1);
  m.plan(1.2, [{ n: 1, step: 'A', status: 'doing' }]);
  m.bash(2, 3, 'sleep 30');
  m.end(4);
  m.init(9);
  m.end(10);
  const l = await m.log(12, { state: 'ready' });
  for (let i = 1; i < l.segs.length; i++) assert.equal(l.segs[i].start, l.segs[i - 1].end);
  assert.equal(l.segs[0].start, T0);
  assert.equal(l.segs.at(-1)!.end, T0 + 12 * MIN);
  assert.equal(l.totals.work + l.totals.wait + l.totals.lost, 12 * MIN);
  assert.ok(rows(l).length >= 2);
  void cutTime;
});
