import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { changedLines, describeProbe, HOLD_NOTE, LiveProbes, parseProbe, probeKey, runProbe, type Outcome, type Probe, type ProbeDeps, type ProbeEnv } from '../src/live-probe.ts';
import { git } from './git.ts';
import { until } from './wait.ts';

// #1741: a big ship's live probe. Probes are data, checked on the way in; the server runs them once the ship is live,
// with no model: a pass is one line in the chat, a fail keeps the minion open and wakes it, a probe that can't run says so.
const root = mkdtempSync(join(tmpdir(), 'live-probe-'));
let srv: Server;
let env: ProbeEnv;
before(async () => {
  srv = createServer((req, res) => {
    if (req.url === '/ok') return res.end('all good here');
    if (req.url === '/me') return req.headers.cookie === 'cc_session=abc' ? res.end('hello Cara') : ((res.statusCode = 401), res.end('sign in'));
    if (req.url === '/apps/voice/') return req.headers['x-forwarded-host'] === 'voice.apps.test' ? res.end('voice app') : ((res.statusCode = 404), res.end('moved'));
    if (req.url === '/slow') return void setTimeout(() => res.end('late'), 120);
    if (req.url === '/hang') return; // never answers
    res.statusCode = 500;
    res.end('boom: it broke');
  });
  await new Promise<void>((done) => srv.listen(0, '127.0.0.1', done));
  const db = new DatabaseSync(join(root, 'c.db'));
  db.exec("CREATE TABLE tickets (id INTEGER, title TEXT); INSERT INTO tickets VALUES (1, 'secret plans'), (2, 'more');");
  db.close();
  // As server.ts signs a GET in: an app's path goes to the app's own host.
  const headers = (path: string) => (path.startsWith('/apps/voice/') ? { 'x-forwarded-host': 'voice.apps.test', cookie: 'cc_app=abc' } : { cookie: 'cc_session=abc' });
  env = { base: `http://127.0.0.1:${(srv.address() as any).port}`, headers, dbPath: join(root, 'c.db'), timeoutMs: 1000 };
});
after(() => {
  srv.closeAllConnections();
  srv.close();
  // timing-ok: own temp dir
  rmSync(root, { recursive: true, force: true });
});

test('parseProbe takes the four kinds and refuses anything that is not plain data for them', () => {
  assert.deepEqual(parseProbe({ kind: 'http', path: '/api/skills' }), { kind: 'http', path: '/api/skills', status: 200 });
  assert.deepEqual(parseProbe({ kind: 'timing', path: '/api/x?y=1', ms: 800 }), { kind: 'timing', path: '/api/x?y=1', ms: 800 });
  assert.deepEqual(parseProbe({ kind: 'sql', query: 'SELECT count(*) FROM tickets;', min: 1 }), { kind: 'sql', query: 'SELECT count(*) FROM tickets', min: 1 });
  assert.deepEqual(parseProbe({ kind: 'none', reason: 'a prompt change' }), { kind: 'none', reason: 'a prompt change' });

  const refuses = (x: unknown, re: RegExp) => assert.throws(() => parseProbe(x), re, JSON.stringify(x));
  refuses({ kind: 'shell', cmd: 'ls' }, /kind must be/);
  refuses('GET /', /must be an object/);
  refuses({ kind: 'http', path: '//evil.example/x' }, /not a valid path/);
  refuses({ kind: 'http', path: 'http://evil.example/' }, /not a valid path/);
  refuses({ kind: 'http', path: '/a b' }, /not a valid path/);
  refuses({ kind: 'http', path: '/x', status: 999 }, /status must be/);
  refuses({ kind: 'timing', path: '/x', ms: 0 }, /ms must be/);
  refuses({ kind: 'sql', query: 'DELETE FROM tickets', max: 0 }, /one SELECT/);
  refuses({ kind: 'sql', query: 'SELECT 1; DELETE FROM tickets', max: 0 }, /one SELECT/);
  refuses({ kind: 'sql', query: 'SELECT 1' }, /needs min, max or both/);
  refuses({ kind: 'sql', query: 'SELECT 1', min: 3, max: 1 }, /min is over/);
  refuses({ kind: 'page', route: '#/p/2/skills' }, /page isn't offered: opening the front end as a person marks things seen/);
  refuses({ kind: 'none', reason: ' ' }, /reason is required/);
  assert.equal(describeProbe(parseProbe({ kind: 'sql', query: 'SELECT 1', min: 0, max: 0 })), 'SELECT 1 is 0');
});

test('an http probe passes on its status and text, fails with what it saw, and a 401 or no answer is no fail', async () => {
  const run = (p: object, e: Partial<ProbeEnv> = {}) => runProbe(parseProbe(p), { ...env, ...e });
  assert.equal((await run({ kind: 'http', path: '/ok', text: 'good' })).result, 'pass');
  assert.equal((await run({ kind: 'http', path: '/me', text: 'Cara' })).result, 'pass', "signed in as the minion's person");
  assert.equal((await run({ kind: 'http', path: '/apps/voice/', text: 'voice app' })).result, 'pass', "an app's path on its own host");
  // What a GET answered is read as a person; only the status and whether the text was there reach the chat.
  assert.deepEqual(await run({ kind: 'http', path: '/nope' }), { result: 'fail', saw: '500, not 200' });
  assert.deepEqual(await run({ kind: 'http', path: '/ok', text: 'usage bar' }), { result: 'fail', saw: '200, but the body has no "usage bar"' });
  assert.deepEqual(await run({ kind: 'http', path: '/me' }, { headers: () => null }), { result: 'cant', saw: '401: it needs a login and the minion has no person to sign in as' });
  assert.deepEqual(await run({ kind: 'http', path: '/hang' }, { timeoutMs: 200 }), { result: 'cant', saw: 'no answer within the time limit' });
  assert.equal((await run({ kind: 'http', path: '/ok' }, { base: 'http://127.0.0.1:1' })).result, 'cant', 'nothing listening');
});

test('a timing probe compares the median of three GETs with its bound, and an error page fails it', async () => {
  const fast = await runProbe(parseProbe({ kind: 'timing', path: '/ok', ms: 5000 }), env);
  assert.equal(fast.result, 'pass');
  assert.match(fast.saw, /^median \d+ ms of 3 \(\d+, \d+, \d+ ms\), bound 5000 ms$/);
  assert.equal((await runProbe(parseProbe({ kind: 'timing', path: '/slow', ms: 50 }), env)).result, 'fail');
  assert.deepEqual(await runProbe(parseProbe({ kind: 'timing', path: '/nope', ms: 5000 }), env), { result: 'fail', saw: '500, not a 2xx' });
});

test('a sql probe reads a number through the masked read-only reader and never shows anything else', async () => {
  const run = (p: object) => runProbe(parseProbe(p), { ...env, timeoutMs: 30_000 });
  assert.deepEqual(await run({ kind: 'sql', query: 'SELECT count(*) FROM tickets', min: 2, max: 2 }), { result: 'pass', saw: '2' });
  assert.deepEqual(await run({ kind: 'sql', query: 'SELECT count(*) FROM tickets', max: 0 }), { result: 'fail', saw: '2' });
  const text = await run({ kind: 'sql', query: 'SELECT title FROM tickets', min: 1 });
  assert.deepEqual(text, { result: 'fail', saw: 'its first column is not a number' }, "a row's text stays out of the chat");
  assert.deepEqual(await run({ kind: 'sql', query: "SELECT '12|pending'", min: 1 }), { result: 'fail', saw: 'its first column is not a number' }, 'text that starts with a number is still text');
  assert.deepEqual(await run({ kind: 'sql', query: "SELECT '7'", min: 1 }), { result: 'fail', saw: 'its first column is not a number' });
  assert.deepEqual(await run({ kind: 'sql', query: 'SELECT id FROM tickets WHERE id > 5', min: 1 }), { result: 'fail', saw: 'no rows' });
  assert.equal((await run({ kind: 'sql', query: 'SELECT count(*) FROM missing', min: 1 })).result, 'fail');
  const writes = await run({ kind: 'sql', query: 'WITH x AS (SELECT 1) SELECT count(*) FROM x', min: 1 });
  assert.equal(writes.result, 'pass', 'WITH ... SELECT is allowed');
});

/** LiveProbes over fake deps that record what it did. */
function probes(outcome: Outcome['result'] | (() => Outcome), opts: { live?: boolean; running?: boolean } = {}) {
  const settings = new Map<string, unknown>();
  const ticket = { state: 'pending-deploy' as string | null, note: null as string | null, status: 'idle', number: 41, project_id: 2 };
  const notes: string[] = [];
  const sent: string[] = [];
  const closed: string[] = [];
  const logged: Record<string, unknown>[] = [];
  const ran: Probe[] = [];
  const deps: ProbeDeps = {
    store: {
      getSetting: <T>(k: string) => (settings.get(k) as T) ?? null,
      setSetting: (k, v) => void settings.set(k, v),
      deleteSetting: (k) => void settings.delete(k),
      settingKeys: (prefix) => [...settings.keys()].filter((k) => k.startsWith(prefix)),
      getTicket: () => ticket,
      updateTicket: (_id, f) => Object.assign(ticket, f),
    },
    runner: {
      emit: (_id, _kind, data: any) => notes.push(data.text),
      send: (_id, _from, text) => sent.push(text),
      close: async (_id, text) => {
        ticket.status = 'closed';
        closed.push(text);
      },
      broadcastTicket: () => {},
      isRunning: () => !!opts.running,
      queued: () => 0,
    },
    from: 'Citadel',
    run: async (_id, p) => {
      ran.push(p);
      return typeof outcome === 'function' ? outcome() : { result: outcome, saw: outcome === 'fail' ? '500, not 200: boom' : '200 in 4 ms' };
    },
    isLive: async () => !!opts.live,
    log: (row) => void logged.push(row),
  };
  return { lp: new LiveProbes(deps), settings, ticket, notes, sent, closed, logged, ran, deps };
}
const HTTP: Probe = { kind: 'http', path: '/api/skills', status: 200 };

test('a pass once live is one line in the chat, with no message to the minion', async () => {
  const s = probes('pass');
  assert.equal(await s.lp.shipped(1, HTTP, 'abc1234', 'live'), false);
  assert.deepEqual(s.notes, ['Live probe passed: GET /api/skills answers 200 (200 in 4 ms).']);
  assert.equal(s.sent.length, 0, 'no model turn');
  assert.deepEqual(
    s.logged.map((r) => r.result),
    ['pass'],
  );
});

test('a fail keeps the minion open and wakes it with what the probe saw', async () => {
  const s = probes('fail');
  assert.equal(await s.lp.shipped(1, HTTP, 'abc1234', 'live'), true, 'the land hand-off keeps it open');
  assert.equal(s.ticket.state, null);
  assert.equal(s.ticket.note, 'live probe failed');
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /^Your live probe failed once your ship abc1234 went live\.\n\nProbe: GET \/api\/skills answers 200\nIt saw: 500, not 200: boom\n/);
  assert.match(s.sent[0], /hand_off_land/);
  assert.deepEqual(s.notes, []);
  assert.deepEqual(s.closed, []);
});

test("a probe that can't run says so and is no fail; none and a ship served nowhere only log", async () => {
  const cant = probes(() => ({ result: 'cant', saw: 'no answer within the time limit' }));
  assert.equal(await cant.lp.shipped(1, HTTP, 'abc1234', 'live'), false);
  assert.deepEqual(cant.notes, ["Live probe couldn't run: GET /api/skills answers 200 (no answer within the time limit). Not counted as a fail."]);
  assert.equal(cant.sent.length, 0);

  const none = probes('pass');
  assert.equal(await none.lp.shipped(1, { kind: 'none', reason: 'a prompt change' }, 'abc1234', 'live'), false);
  assert.deepEqual(none.ran, [], 'nothing runs');
  assert.deepEqual(none.notes, []);
  assert.deepEqual(
    none.logged.map((r) => [r.result, r.saw]),
    [['none', 'a prompt change']],
    'the trial counts its nones',
  );

  const nowhere = probes('pass');
  assert.equal(await nowhere.lp.shipped(1, HTTP, 'abc1234', 'nowhere'), false);
  assert.deepEqual(nowhere.ran, []);
  assert.match(nowhere.notes[0], /^Live probe couldn't run: nothing this ship changed is served by this server/);
});

test('a restart keeps the probe until live: the dismissal is held, the probe runs, and a pass dismisses it', async () => {
  const s = probes('pass');
  assert.equal(await s.lp.shipped(1, HTTP, 'def5678', 'later'), false);
  assert.deepEqual(s.ran, [], 'not live yet');
  assert.ok(s.settings.has(probeKey(1)), 'kept in a setting, so it outlasts the restart');

  assert.equal(s.lp.hold(1), true, "the restart's live (Runner.deployLive) is held");
  assert.equal(s.ticket.state, 'outside');
  assert.equal(s.ticket.note, HOLD_NOTE);
  await until('the held probe dismisses it', () => s.closed.length === 1);
  assert.deepEqual(s.closed, ['The deploy is live and its live probe passed, so it dismissed this minion.']);
  assert.deepEqual(s.notes, ['Live probe passed: GET /api/skills answers 200 (200 in 4 ms).']);
  assert.ok(!s.settings.has(probeKey(1)));
  assert.equal(s.lp.hold(1), false, 'nothing left to hold');
});

test('a held probe that fails wakes the minion and does not dismiss it; a turn started meanwhile keeps it open on a pass', async () => {
  const fail = probes('fail');
  await fail.lp.shipped(1, HTTP, 'def5678', 'later');
  fail.lp.hold(1);
  await until('the fail wakes it', () => fail.sent.length === 1);
  assert.deepEqual(fail.closed, []);
  assert.equal(fail.ticket.note, 'live probe failed');

  const busy = probes('pass', { running: true });
  await busy.lp.shipped(1, HTTP, 'def5678', 'later');
  busy.lp.hold(1);
  await until('the held probe is done', () => !busy.settings.has(probeKey(1)));
  assert.deepEqual(busy.closed, [], 'someone wrote: it answers them first');
});

test('a restart already live runs the probe at once; the sweep runs a kept probe once its ship is live and drops a stale one', async () => {
  const early = probes('pass', { live: true });
  await early.lp.shipped(1, HTTP, 'def5678', 'later');
  assert.equal(early.ran.length, 1, 'its restart went live before land.sh ended');
  assert.ok(!early.settings.has(probeKey(1)));

  const kept = probes('pass');
  await kept.lp.shipped(1, HTTP, 'def5678', 'later');
  await kept.lp.sweep();
  assert.equal(kept.ran.length, 0, 'not live: it waits');
  kept.deps.isLive = async () => true;
  kept.ticket.state = 'ready'; // a stay_open ship: the sweep runs it but closes nothing
  await kept.lp.sweep();
  assert.equal(kept.ran.length, 1);
  assert.deepEqual(kept.closed, []);
  assert.ok(!kept.settings.has(probeKey(1)));

  const stale = probes('pass');
  stale.settings.set(probeKey(3), { probe: HTTP, commit: 'aaa', at: Date.now() - 3 * 24 * 3600_000 });
  await stale.lp.sweep();
  assert.ok(!stale.settings.has(probeKey(3)));
  assert.deepEqual(
    stale.logged.map((r) => r.saw),
    ['never went live'],
  );
});

test('a hold and a restart ship that both reach the same kept probe run it once', async () => {
  // The ship reads its restart already live while the restart's own live holds the dismissal: one run, one wake.
  const s = probes('fail');
  let live!: (v: boolean) => void;
  s.deps.isLive = () =>
    new Promise((done) => {
      live = done;
    });
  const ship = s.lp.shipped(1, HTTP, 'def5678', 'later');
  assert.equal(s.lp.hold(1), true);
  live(true);
  assert.equal(await ship, false, 'the hold ran it, so the ship does not count its fail');
  await until('the held run is done', () => !s.settings.has(probeKey(1)));
  assert.equal(s.ran.length, 1);
  assert.equal(s.sent.length, 1, 'one wake');

  // The ship's run started first, and the hold came while it ran: the pass still dismisses the held minion.
  let answer!: (o: Outcome) => void;
  const t = probes(() => ({ result: 'pass', saw: 'unused' }), { live: true });
  t.deps.run = async (_id, p) => {
    t.ran.push(p);
    return new Promise((done) => {
      answer = done;
    });
  };
  const ship2 = t.lp.shipped(1, HTTP, 'def5678', 'later');
  await until('the ship runs it', () => t.ran.length === 1);
  assert.equal(t.lp.hold(1), true, 'still kept while it runs, so the restart holds the dismissal');
  answer({ result: 'pass', saw: '200 in 4 ms' });
  assert.equal(await ship2, false);
  assert.equal(t.ran.length, 1);
  assert.deepEqual(t.closed, ['The deploy is live and its live probe passed, so it dismissed this minion.']);
});

test('changedLines counts added and removed lines against main, binary files left out', async () => {
  const repo = join(root, 'repo');
  git(root, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'checkout', '-qb', 'ticket/1-x');
  writeFileSync(join(repo, 'a.txt'), 'one\n2\nthree\nfour\n');
  writeFileSync(join(repo, 'b.bin'), Buffer.from([0, 1, 2, 0, 3]));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'change');
  assert.equal(await changedLines(repo), 3, 'two added, one removed');
  assert.equal(await changedLines(join(root, 'nowhere')), 0);
});
