import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import vm from 'node:vm';
import { HEALTH_MAX_ROWS, Store } from '../src/db.ts';
import { HttpError } from '../src/http.ts';
import { ClientErrors, countsAsServerFault, DEDUPE_MS, DeployWatch, gitCommits, RATE, subjectTicket } from '../src/deploy-watch.ts';
import { git } from './git.ts';

// The post-deploy watch (#724): readings before and after each deploy, a wake for whoever shipped a regression.
const root = mkdtempSync(join(tmpdir(), 'deploy-watch-'));
after(() => rmSync(root, { recursive: true, force: true }));
const MIN = 60_000;
let dbs = 0;

function setup() {
  const file = join(root, `t-${++dbs}.db`);
  const store = new Store(file);
  const scheme = store.createProject('Citadel', null);
  const tm = store.createTicket({ project_id: scheme.id, title: 'Taskmaster', permission_mode: 'default', created_by: 'cara', kind: 'coordinator' });
  const a = store.createTicket({ project_id: scheme.id, title: 'A', permission_mode: 'default', created_by: 'cara' });
  const b = store.createTicket({ project_id: scheme.id, title: 'B', permission_mode: 'default', created_by: 'cara' });
  const clock = { now: Date.now() };
  const woken: { id: number; text: string }[] = [];
  const mailed: { id: number; text: string }[] = [];
  let head: string | null = null;
  let commits: { sha: string; subject: string }[] = [];
  const watch = () =>
    new DeployWatch({
      store,
      commits: async () => commits,
      wake: (id, text) => woken.push({ id, text }),
      mail: (id, text) => mailed.push({ id, text }),
      scheme: () => scheme,
      head: () => head,
      dbPath: file,
      now: () => clock.now,
      bootAt: 0,
    });
  const w = watch();
  const deploy = (sha: string, list: { sha: string; subject: string }[] = []) => {
    head = sha;
    commits = list;
    w.live(sha);
  };
  const errors = (n: number, at: number, detail = 'TypeError: x is undefined (/app.js:12)') => {
    for (let i = 0; i < n; i++) store.addHealthEvent('client-error', at + i, head, detail);
  };
  return { file, store, scheme, tm, a, b, clock, woken, mailed, w, watch, deploy, errors };
}

const sha = (c: string) => c.repeat(40);

test('a regression wakes each minion that shipped in the deploy once, by Shipped note or #N, and mails the Taskmaster', async () => {
  const { store, tm, a, b, clock, woken, mailed, w, deploy, errors } = setup();
  deploy(sha('0'));
  clock.now += 60 * MIN;
  errors(1, clock.now - 10 * MIN);
  // B's land moved main to bbbb…: it owns that commit and the unowned one before it; A's goes by its #N; one names no one.
  store.addEvent(b.id, 'note', { text: `Shipped ${sha('b').slice(0, 8)} "B's change": live after the restart.` });
  const at = clock.now;
  deploy(sha('b'), [
    { sha: sha('c'), subject: 'Tidy a comment' },
    { sha: sha('b'), subject: "B's change" },
    { sha: sha('d'), subject: `#${a.number}: A's change` },
    { sha: sha('e'), subject: 'Bump something' },
  ]);
  errors(14, at + 5 * MIN);

  clock.now = at + 19 * MIN;
  await w.tick();
  assert.equal(woken.length, 0, 'nothing runs before +20 min');

  clock.now = at + 20 * MIN;
  await w.tick();
  assert.deepEqual(woken.map((x) => x.id).sort(), [a.id, b.id].sort(), 'both shippers, once each');
  const toB = woken.find((x) => x.id === b.id)!.text;
  assert.match(toB, /front-end errors went from 1 to 14/);
  assert.match(toB, /comparing the 20 minutes after the deploy with the 20 minutes before it/);
  assert.match(toB, /cccccccc Tidy a comment; bbbbbbbb B's change/, 'B owns the commit before its land too');
  assert.match(toB, /14× TypeError: x is undefined/);
  assert.match(toB, /1 commit with no minion/);
  assert.match(woken.find((x) => x.id === a.id)!.text, /dddddddd #\d+: A's change/);
  assert.equal(mailed.length, 1);
  assert.equal(mailed[0].id, tm.id);
  assert.match(mailed[0].text, /Woke #\d+, #\d+\. Commits with no minion: eeeeeeee Bump something\. Nothing was reverted\./);

  errors(50, at + 30 * MIN);
  clock.now = at + 25 * 60 * MIN;
  await w.tick();
  assert.equal(woken.length, 2, 'one wake per minion per deploy, however bad later checks look');
  assert.equal(mailed.length, 1);
});

test('a doubling under the floor, or a rise short of double, is ignored', async () => {
  const { store, clock, woken, mailed, w, deploy, errors } = setup();
  deploy(sha('0'));
  clock.now += 60 * MIN;
  const at = clock.now;
  deploy(sha('1'), [{ sha: sha('1'), subject: 'x' }]);
  errors(2, at + MIN); // 0 → 2: doubled, but under 3
  for (let i = 0; i < 4; i++) store.addHealthEvent('server-5xx', at - 10 * MIN + i, null, 'GET /api/x: boom');
  for (let i = 0; i < 7; i++) store.addHealthEvent('server-5xx', at + MIN + i, null, 'GET /api/x: boom'); // 4 → 7: not double
  for (let i = 0; i < 2; i++) store.addHealthEvent('fallback', at + MIN + i, null, 'A turn: no slice'); // under 3
  clock.now = at + 20 * MIN;
  await w.tick();
  assert.deepEqual([woken, mailed], [[], []]);
});

test('a share of failed turns that doubles past the floor is a regression', async () => {
  const { file, store, a, clock, woken, w, deploy } = setup();
  deploy(sha('0'));
  clock.now += 60 * MIN;
  const at = clock.now;
  deploy(sha('1'), [{ sha: sha('1'), subject: `#${a.number}: thing` }]);
  const turn = (ended: number, bad: boolean) => {
    const e = store.addEvent(a.id, 'result', { type: 'result', is_error: bad, total_cost_usd: 0 });
    store.recordTurn(a.id, { event_id: e.id, ended_at: ended, session_cost_usd: 0 });
  };
  for (let i = 0; i < 10; i++) turn(at - 15 * MIN + i, i === 0); // 1 of 10
  for (let i = 0; i < 10; i++) turn(at + 2 * MIN + i, i < 2); // 2 of 10 ...
  // ... plus a turn that crashed before its result: an error event, dated inside the window.
  const err = store.addEvent(a.id, 'error', { message: 'claude exited 1' });
  const db = new DatabaseSync(file);
  db.prepare('UPDATE events SET created_at = ? WHERE id = ?').run(at + 3 * MIN, err.id);
  db.close();
  assert.deepEqual(store.turnOutcomes(at, at + 20 * MIN), { turns: 11, failed: 3, first: at + 2 * MIN });
  clock.now = at + 20 * MIN;
  await w.tick();
  assert.equal(woken.length, 1);
  assert.match(woken[0].text, /failed turns went from 10% \(1 of 10\) to 27% \(3 of 11\)/);
});

test('pending checks survive a restart, and a missed one runs late on the same windows', async () => {
  const { a, clock, woken, watch, deploy, errors } = setup();
  deploy(sha('0'));
  clock.now += 60 * MIN;
  const at = clock.now;
  deploy(sha('1'), [{ sha: sha('1'), subject: `#${a.number}: thing` }]);
  errors(6, at + 30 * MIN); // only inside the 1-hour window
  // The server was down from +10 min to +70 min: a fresh instance on the same database picks the checks up.
  clock.now = at + 70 * MIN;
  const restarted = watch();
  restarted.live(sha('1'));
  await restarted.tick();
  assert.equal(woken.length, 1, 'the 20-minute check found nothing, the 1-hour one did');
  assert.match(woken[0].text, /comparing the hour after the deploy with the hour before it/);
  assert.deepEqual(restarted.state().deploys[0].due, []);
});

test('trouble after the next deploy is blamed on that deploy, not the one before', async () => {
  const { a, b, clock, woken, w, deploy, errors } = setup();
  deploy(sha('0'));
  clock.now += 60 * MIN;
  const first = clock.now;
  deploy(sha('1'), [{ sha: sha('1'), subject: `#${a.number}: thing` }]);
  clock.now = first + 10 * MIN;
  const second = clock.now;
  deploy(sha('2'), [{ sha: sha('2'), subject: `#${b.number}: other` }]);
  errors(9, second + 2 * MIN);
  for (const t of [20, 30, 70, 25 * 60]) {
    clock.now = first + t * MIN;
    await w.tick();
  }
  assert.deepEqual(woken.map((x) => x.id), [b.id]);
});

test('a window cut under five minutes by the next deploy compares nothing', async () => {
  const { a, b, clock, woken, w, deploy, errors } = setup();
  deploy(sha('0'));
  clock.now += 60 * MIN;
  const first = clock.now;
  deploy(sha('1'), [{ sha: sha('1'), subject: `#${a.number}: thing` }]);
  errors(9, first + MIN);
  clock.now = first + 3 * MIN;
  deploy(sha('2'), [{ sha: sha('2'), subject: `#${b.number}: other` }]);
  clock.now = first + 25 * 60 * MIN;
  await w.tick();
  assert.equal(woken.some((x) => x.id === a.id), false);
});

test("git attribution: a Shipped note on a build's merge owns the commits merged in with it", async () => {
  const { store, a, b, scheme } = setup();
  const dir = mkdtempSync(join(root, 'git-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  const prev = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'build/1');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'Build work one');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'Build work two');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'Something on main meanwhile');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge build/1', 'build/1');
  const merge = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'commit', '-q', '--allow-empty', '-m', `#${a.number}: A's fix`);
  const head = git(dir, 'rev-parse', 'HEAD');
  store.addEvent(b.id, 'note', { text: `Shipped ${merge.slice(0, 8)} "Build 1": live after the restart.` });
  const w = new DeployWatch({ store, commits: gitCommits(dir), wake() {}, mail() {}, scheme: () => scheme, head: () => head, dbPath: '' });
  const { suspects, unowned } = await w.suspects({ commit: head, prev, at: Date.now(), due: [], len: 0 });
  const by = Object.fromEntries(suspects.map((s) => [s.ticketId, s.commits.map((c) => c.subject)]));
  assert.deepEqual(by[b.id].sort(), ['Build work one', 'Build work two', 'Merge build/1', 'Something on main meanwhile']);
  assert.deepEqual(by[a.id], [`#${a.number}: A's fix`]);
  assert.deepEqual(unowned, []);
  assert.equal(await gitCommits(dir)('nope', head), null, 'git failing is no list, not a throw');
});

test('restarting on the same commit is not a deploy; the first commit ever seen starts no watch', () => {
  const { clock, w, deploy } = setup();
  deploy(sha('0'));
  w.live(sha('0'));
  clock.now += MIN;
  w.live(sha('0'));
  assert.deepEqual(w.state(), { live: sha('0'), deploys: [] });
});

test('event-loop stalls in the first minutes after boot are not recorded', () => {
  const { store, clock, watch } = setup();
  const w = new DeployWatch({ ...(watch() as any).d, bootAt: clock.now });
  w.record('loop-lag', 'stalled 900 ms');
  clock.now += 8 * MIN;
  w.record('loop-lag', 'stalled 800 ms: restart warm-up (afterRestore) still running');
  assert.equal(store.healthCount('loop-lag', 0, Infinity).count, 0, 'a restart\'s warm-up runs minutes in');
  clock.now += 3 * MIN;
  w.record('loop-lag', 'Running: 90% all < newCode (src/new.ts:1)');
  assert.equal(store.healthCount('loop-lag', 0, Infinity).count, 1, 'new code stalling after warm-up still counts');
});

test('a stall in the watch\'s own query is not recorded, at any time', () => {
  const { store, watch } = setup();
  const w = watch() as any;
  w.record('loop-lag', 'Running: 92% get < eventIdAt (src/db.ts:2557) < turnOutcomes (src/db.ts:2575) < compare (src/deploy-watch.ts:185)');
  assert.equal(store.healthCount('loop-lag', 0, Infinity).count, 0);
  w.record('loop-lag', 'Running: 90% all < listEvents (src/db.ts:2153) < handler (src/routes/tickets.ts:553)');
  assert.equal(store.healthCount('loop-lag', 0, Infinity).count, 1);
});

test('eventIdAt finds the first event at or after a time', () => {
  const { store } = setup();
  const db = (store as any).db;
  db.exec('DELETE FROM events');
  assert.equal(store.eventIdAt(5), 1, 'no events');
  // Five events at known times, two sharing one, so the halving has to land on the first of a tie.
  const ids = [100, 200, 200, 300, 400].map((at) => {
    const { id } = store.addEvent(1, 'note', { text: `at ${at}` });
    db.prepare('UPDATE events SET created_at = ? WHERE id = ?').run(at, id);
    return Number(id);
  });
  assert.equal(store.eventIdAt(50), ids[0], 'before the first event');
  assert.equal(store.eventIdAt(100), ids[0], 'exactly on the first event');
  assert.equal(store.eventIdAt(200), ids[1], 'exactly on a tie: the first of the two');
  assert.equal(store.eventIdAt(300), ids[3], 'exactly on an event');
  assert.equal(store.eventIdAt(250), ids[3], 'between two events');
  assert.equal(store.eventIdAt(401), ids[4] + 1, 'after the last event: one past it');
});

test('health_events keeps at most HEALTH_MAX_ROWS rows', () => {
  const { store } = setup();
  const now = Date.now();
  for (let i = 0; i < HEALTH_MAX_ROWS + 300; i++) store.addHealthEvent('server-5xx', now + i, null, 'x');
  const { count } = store.healthCount('server-5xx', 0, Infinity);
  assert.ok(count <= HEALTH_MAX_ROWS && count > HEALTH_MAX_ROWS - 100, `${count} rows`);
});

test('beacon reports are de-duplicated and rate-limited per person, origin and query stripped', () => {
  const c = new ClientErrors();
  const t = 1_000_000;
  const body = { kind: 'error', message: 'TypeError: boom', source: 'https://citadel.zip/app.js?v=3', line: 12 };
  assert.equal(c.take('1', body, t), 'TypeError: boom (/app.js:12)');
  assert.equal(c.take('1', body, t + MIN), null, 'the same error again soon');
  assert.equal(c.take('2', body, t + MIN), 'TypeError: boom (/app.js:12)', 'someone else counts');
  assert.equal(c.take('1', body, t + DEDUPE_MS), 'TypeError: boom (/app.js:12)', 'again after the dedupe window');
  assert.equal(c.take('1', { kind: 'rejection', message: 'nope' }, t + DEDUPE_MS), 'Unhandled rejection: nope');
  assert.equal(c.take('1', { message: '  ' }, t), null);
  assert.equal(c.take('1', null, t), null);
  let taken = 0;
  for (let i = 0; i < 100; i++) if (c.take('3', { message: `e${i}` }, t + i)) taken++;
  assert.equal(taken, RATE);
  assert.equal(c.take('3', { message: 'later' }, t + 61 * MIN), 'later', 'the limit resets each hour');
});

test('the beacon never throws, sends each error once, skips network noise and stops at ten', () => {
  const listeners: Record<string, (e: any) => void> = {};
  const sent: any[] = [];
  let failing = false;
  class ErrorEvent {
    constructor(o: any) {
      Object.assign(this, o);
    }
  }
  const ctx = vm.createContext({
    ErrorEvent,
    addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] = fn),
    fetch: (url: string, init: any) => {
      if (failing) throw new Error('fetch is broken');
      sent.push({ url, ...JSON.parse(init.body), type: init.headers['Content-Type'] });
      return Promise.reject(new Error('offline'));
    },
  });
  vm.runInContext(readFileSync(new URL('../public/error-beacon.js', import.meta.url), 'utf8'), ctx);
  const error = (message: string, line = 3) => listeners.error(new ErrorEvent({ message, filename: 'https://h/app.js', lineno: line, error: new Error(message) }));
  error('boom');
  error('boom');
  assert.deepEqual(sent, [{ url: 'api/client-errors', kind: 'error', message: 'boom', source: 'https://h/app.js', line: 3, type: 'application/json' }]);
  error('TypeError: Failed to fetch');
  error('Script error.');
  listeners.error({ message: 'a broken <img>' }); // a resource load error is a plain Event, not an ErrorEvent
  assert.equal(sent.length, 1);
  const r = new Error('bad');
  r.stack = 'Error: bad\n    at go (https://h/chat.js:40:7)';
  listeners.unhandledrejection({ reason: r });
  listeners.unhandledrejection({ reason: 'plain string' });
  listeners.unhandledrejection({ reason: undefined });
  listeners.unhandledrejection({ reason: { get message() { throw new Error('hostile'); } } });
  assert.deepEqual(sent.slice(1).map((s) => [s.kind, s.message, s.source, s.line]), [['rejection', 'bad', 'https://h/chat.js', 40], ['rejection', 'plain string', '', 0]]);
  failing = true;
  assert.doesNotThrow(() => error('fetch throws'));
  failing = false;
  for (let i = 0; i < 20; i++) error(`e${i}`);
  assert.equal(sent.length, 3 + 6, 'at most ten distinct errors a page (one went to the failing fetch)');
});

test('offline-machine session answers after a deploy are not server faults and never wake a minion', async () => {
  const { clock, woken, mailed, w, deploy } = setup();
  deploy(sha('0'));
  clock.now += 60 * MIN;
  const at = clock.now;
  deploy(sha('1'), [{ sha: sha('1'), subject: 'x' }]);
  // The server's catch, as in server.ts: the machine routes' 503s carry `expected`.
  const offline = new HttpError(503, 'That machine is offline, or its workspace tools are off', true);
  for (let i = 0; i < 8; i++) if (countsAsServerFault(offline.status, offline)) w.record('server-5xx', 'GET /api/machines/#/session: offline');
  assert.equal(countsAsServerFault(503, new HttpError(503, 'down')), true); // an unflagged 5xx still counts
  assert.equal(countsAsServerFault(500, new Error('boom')), true);
  assert.equal(countsAsServerFault(404, new HttpError(404, 'x')), false);
  clock.now = at + 20 * MIN;
  await w.tick();
  assert.deepEqual([woken, mailed], [[], []]);
});

test('subjectTicket reads a subject the way tools/land.sh does: a leading #N, WIP #N or WIP: #N, else the last trailing (#N)', () => {
  assert.equal(subjectTicket('#12: fix it'), '12');
  assert.equal(subjectTicket('WIP #13: step'), '13');
  assert.equal(subjectTicket('WIP: #14 step'), '14');
  assert.equal(subjectTicket('Code health: drop the rules (#622)'), '622');
  assert.equal(subjectTicket('Revert "x (#5)" (#622)'), '622');
  assert.equal(subjectTicket('#7: follows #8) oddly (#9)'), '7');
  assert.equal(subjectTicket('no ticket here'), '');
});

test('turns that stopped on a usage limit are not failed turns, so a burst of them raises no finding', async () => {
  const { store, a, clock, woken, w, deploy } = setup();
  deploy(sha('0'));
  clock.now += 60 * MIN;
  const at = clock.now;
  deploy(sha('1'), [{ sha: sha('1'), subject: `#${a.number}: thing` }]);
  const turn = (ended: number, bad: boolean, result?: string) => {
    const e = store.addEvent(a.id, 'result', { type: 'result', is_error: bad, result, total_cost_usd: 0 });
    store.recordTurn(a.id, { event_id: e.id, ended_at: ended, session_cost_usd: 0 });
  };
  for (let i = 0; i < 10; i++) turn(at - 15 * MIN + i, i === 0);
  for (let i = 0; i < 10; i++) turn(at + 2 * MIN + i, false);
  for (let i = 0; i < 8; i++) turn(at + 5 * MIN + i, true, "You've hit your 5-hour limit · resets 3:30pm (America/Los_Angeles)");
  assert.deepEqual(store.turnOutcomes(at, at + 20 * MIN), { turns: 10, failed: 0, first: null });
  clock.now = at + 20 * MIN;
  await w.tick();
  assert.deepEqual(woken, []);
});
