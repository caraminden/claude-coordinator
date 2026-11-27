// The front thread and its readers (#1563, src/front.ts, src/reader.ts): people's read-only page requests on
// READER_PATHS answer from reader threads, the same answers the main thread gives, while the main thread is busy; a
// reader that dies or hangs is replaced and its request answered by the main thread; a read never misses a write the
// writer is still holding. Real servers on one data folder, with the front thread on and off (CITADEL_FRONT=0).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { READER_PATHS, READER_ROUTES } from '../src/front.ts';
import { SHELL_OFF_FILE } from '../src/shell.ts';
import { mainOnly, readerRoutes } from '../src/reader.ts';
import { bootServer, mintedAgentToken, PASSWORD, tempRoot, type Booted } from './helpers.ts';
import { until } from './wait.ts';

const tmp = tempRoot('front-');
after(() => tmp.teardown());
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });

// Two schemes; Max is a member of A only, Olive of neither. M1 in A has a few events, MB in B one.
const store = new Store(join(data, 'coordinator.db'));
const A = store.createProject('A', null);
const B = store.createProject('B', null);
const thread = (projectId: number, title: string) => {
  const t = store.createTicket({ project_id: projectId, kind: 'ticket', title, permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, 'work', String(t.id));
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  return store.getTicket(t.id)!;
};
const M1 = thread(A.id, 'One');
const MB = thread(B.id, 'Other');
// Written by /api/test/half-step, the whole-step test's.
const STEPS = thread(A.id, 'Steps');
const events = ['first', 'second', 'third'].map((text) => store.addEvent(M1.id, 'note', { text }));
const other = store.addEvent(MB.id, 'note', { text: 'elsewhere' });

// Every path the slice answers, with the cases a page asks for.
const PATHS = [
  `/api/tickets/${M1.id}/events`,
  `/api/tickets/${M1.id}/events?after=0`,
  `/api/tickets/${M1.id}/events?before=1000&limit=2`,
  `/c/api/tickets/${M1.id}/events`,
  `/api/tickets/${MB.id}/events`,
  '/api/tickets/9999/events',
  `/api/tickets/${M1.id}/events/${events[1].id}`,
  `/api/tickets/${M1.id}/events/${other.id}`,
  `/api/tickets/${M1.id}/events/99999`,
  `/api/projects/${A.id}/memory?q=one`,
  `/api/projects/${B.id}/memory?q=one`,
  `/api/projects/${A.id}/memory`,
  // Slice 2 (#1590): the minions list, a minion's page and the Status page.
  `/api/projects/${A.id}`,
  `/api/projects/${A.id}?tickets=open`,
  `/c/api/projects/${A.id}`,
  `/api/projects/${B.id}`,
  '/api/projects/999',
  `/api/tickets/${M1.id}`,
  `/api/tickets/${MB.id}`,
  '/api/tickets/9999',
  '/api/status',
  '/api/box-capacity',
  // Slice 3 (#1628): the rest of people's GETs that read only the database and the snapshot.
  ...['commands', 'ship-risk', 'time-log'].flatMap((r) => [`/api/tickets/${M1.id}/${r}`, `/api/tickets/${MB.id}/${r}`, `/api/tickets/9999/${r}`]),
  ...['members', 'taskmaster-events', 'instructions/history', 'my-instructions', 'my-instructions/history', 'repo-setup', 'plugins', 'properties', 'views', 'search?q=one', 'past-minions', 'schedule-audits', 'ship-lessons', 'claims', 'contraption-turns', 'day-strips?day=2026-11-20'].flatMap((r) => [
    `/api/projects/${A.id}/${r}`,
    `/api/projects/${B.id}/${r}`,
    `/api/projects/999/${r}`,
  ]),
  '/api/ship-lines',
  '/c/api/ship-lines',
  '/api/app/instructions',
  '/api/app/instructions/history',
  '/api/ci',
  '/api/ci-desktop',
  '/api/units',
];
// What differs between two servers' boots (its start time, the answer probe, the machine's load), or ends now (a time log), is compared on one server instead.
const BOOT_BOUND = new Set(['/api/status', '/api/box-capacity', ...[M1.id, MB.id].map((id) => `/api/tickets/${id}/time-log`)]);
// The clock a body carries, the one field that differs between two asks of the same answer.
const unclocked = (body: string) => body.replace(/"(at|now)":\d+/g, '"$1":0');

test("the readers' routes are GETs of the main thread's table, each asked for by a path here; the rest stay on main", () => {
  assert.deepEqual(
    readerRoutes()
      .map((r) => r.path)
      .sort(),
    [...READER_ROUTES].sort(),
  );
  assert.ok(readerRoutes().every((r) => [r.method].flat().includes('GET')));
  for (const p of PATHS) assert.ok(READER_PATHS.test(p.split('?')[0]), p);
  // A route that reaches for a part of the app a reader lacks throws, so the main thread answers it.
  assert.equal(mainOnly({ store: 1 }).store, 1);
  assert.throws(() => (mainOnly({}) as { runner?: unknown }).runner, /app\.runner is the main thread's/);
  const asked = (r: string) => new RegExp(`^(?:/c)?${r.replace(/:\w+/g, '[^/]+')}$`);
  for (const r of READER_ROUTES)
    assert.ok(
      PATHS.some((p) => asked(r).test(p.split('?')[0])),
      `a path asks for ${r}`,
    );
  for (const p of [
    '/api/tickets/1/x',
    '/api/tickets/1/events/1/x',
    '/api/projects/1/tickets',
    '/api/tickets/1/stream',
    '/api/projects',
    '/api/me',
    '/api/home',
    '/api/projects/1/ci-files',
    '/api/projects/1/shared',
    '/api/tickets/1/facts',
    '/api/projects/1/schedules',
    '/api/app/settings',
    '/api/reviews/schemes',
    '/api/tickets/1/jobs',
    '/api/ship-lines/x',
  ])
    assert.ok(!READER_PATHS.test(p), p);
});

const signIn = async (srv: Booted, name: string, password: string) => {
  const res = await fetch(`${srv.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, password }) });
  return res.headers.get('set-cookie')!.split(';')[0];
};
type Got = { status: number; body: string; reader: boolean; timed: boolean };
/** One stamp of the server's own time (#1752), never two: a main answer the front passes on carries the front's alone. */
const TIMED = /^app;dur=\d+(\.\d)?$/;
/** Asks again on the front thread's "try again" 503, as the page does (public/base.js); `once` gives that answer itself. */
const get = async (srv: Booted, path: string, cookie?: string, once = false): Promise<Got> => {
  for (;;) {
    const res = await fetch(srv.base + path, { headers: cookie ? { Cookie: cookie } : {} });
    const body = await res.text();
    if (once || res.status !== 503 || res.headers.get('x-citadel-answered') !== 'front') return { status: res.status, body, reader: res.headers.get('x-citadel-answered') === 'reader', timed: TIMED.test(res.headers.get('server-timing') ?? '') };
    // timing-ok: the page's own pause between asks, not a wait for a state
    await new Promise((r) => setTimeout(r, 1000));
  }
};
/**
 * Each caller's answer to each path. With `reader`, every answer is a reader's: one the main thread gave is asked again
 * until a reader gives it (#1903). A reader hands a read to the main thread when the main thread's write step stays open
 * past READ_WAIT_MS (50 ms, src/reader.ts inWholeStep), which a starved machine stretches: with ten copies of this file
 * at once that was one ask in 325, in 3 copies of 10. A route a reader can't answer is handed back every time, so it
 * still fails, named with every other.
 */
async function answers(srv: Booted, reader = false) {
  const callers: Record<string, string | undefined> = {
    cara: srv.cookie,
    max: await signIn(srv, 'Max', 'a-long-password'),
    olive: await signIn(srv, 'Olive', 'a-long-password'),
    anon: undefined,
    forged: 'cc_session=forged.cookie',
  };
  const out: Record<string, Got> = {};
  const ask = async (who: string, p: string) => (out[`${who} ${p}`] = await get(srv, p, callers[who]));
  for (const who of Object.keys(callers)) for (const p of PATHS) await ask(who, p);
  const byMain = () => Object.keys(out).filter((key) => !out[key].reader);
  if (reader)
    await until(
      'a reader to answer every route',
      async () => {
        for (const key of byMain()) await ask(key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1));
        return byMain().length === 0;
      },
      20_000,
      () => `the main thread answered ${byMain().join(', ')}`,
    );
  return out;
}

let viaMain: Record<string, Got>;

test('with readers off, the main thread answers everything (the reference answers)', { timeout: 120_000 }, async () => {
  const srv = await bootServer({ root, env: { CITADEL_FRONT: '0' } });
  try {
    for (const name of ['Max', 'Olive']) {
      const made = await srv.call('/api/people', { name });
      await fetch(`${srv.base}/api/invite/${made.data.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
    }
    store.addMember(A.id, store.findUser('name', 'Max')!.id);
    viaMain = await answers(srv);
    assert.ok(Object.values(viaMain).every((g) => !g.reader));
    // The main thread listening alone stamps its own time on each answer, refusals too (#1752).
    for (const [key, got] of Object.entries(viaMain)) assert.ok(got.timed, `main's answer to ${key} carries Server-Timing`);
    // The world is what the comparison needs: Cara and Max see M1, Olive and the signed-out don't.
    assert.equal(viaMain[`max /api/tickets/${M1.id}/events/${events[1].id}`].status, 200);
    assert.equal(viaMain[`olive /api/tickets/${M1.id}/events/${events[1].id}`].status, 404);
    assert.equal(viaMain[`anon /api/tickets/${M1.id}/events`].status, 401);
  } finally {
    await srv.stop();
  }
});

let srv: Booted;
// At the file's end, not the test's: the tests after the first share this server.
after(async () => {
  if (srv && srv.proc.exitCode === null && srv.proc.signalCode === null) await srv.stop();
});
const LOG = join(root, 'server.log');
const logged = () => readFileSync(LOG, 'utf8');
const readyAgain = () => logged().split('Reader thread started again').length - 1;
// A hung reader's other requests go to another after 1 s, the reader replaced after 3 s (2 s and 10 s live).
const KNOBS = { CITADEL_READER_ANSWER_MS: '1000', CITADEL_READER_STUCK_MS: '3000' };
// The minion page too: it waits for main's first pass over every minion (src/reader-live.ts).
/**
 * A reader's answer to `path`. The front thread passes a read on to the main thread while a snapshot change main posted
 * is still on its way to it (caughtUp, src/front.ts; main posts one whenever the Status inputs or a minion's view moved),
 * so any one ask may be main's, more often on a loaded machine (#2251): that ask is asked again. A route no reader
 * answers still fails, at the deadline.
 */
const fromReader = (s: Booted, path: string, cookie = s.cookie) =>
  until(`a reader to answer ${path}`, async () => {
    const got = await get(s, path, cookie);
    return got.reader && got;
  });
const readerAnswers = (s: Booted) => until('a reader answers', async () => (await get(s, PATHS[0], s.cookie)).reader && (await get(s, `/api/tickets/${M1.id}`, s.cookie)).reader);

test('through the front thread, readers give every caller the same answers and refusals as the main thread', { timeout: 120_000 }, async () => {
  srv = await bootServer({ root, env: KNOBS, log: LOG });
  // Readers start a moment after the port opens; until then the main thread answers.
  await readerAnswers(srv);
  const viaReaders = await answers(srv, true);
  for (const [key, got] of Object.entries(viaReaders)) {
    // A time log ends now, so its numbers differ; its stretches and rows don't.
    const same = (body: string) => (key.endsWith('/time-log') ? body.replace(/\d+/g, '0') : BOOT_BOUND.has(key.split(' ')[1]) ? '' : unclocked(body));
    assert.deepEqual({ status: got.status, body: same(got.body) }, { status: viaMain[key].status, body: same(viaMain[key].body) }, key);
    assert.ok(got.timed, `the answer to ${key} carries Server-Timing`);
  }
  assert.ok(
    Object.values(viaReaders).some((g) => g.reader && g.timed),
    "a reader's answer carries Server-Timing",
  );
  // Agents' calls stay on the main thread, where their nonces are.
  const bearer = await fetch(srv.base + PATHS[0], { headers: { Authorization: 'Bearer nope' } });
  assert.equal(bearer.headers.get('x-citadel-answered'), null);
  assert.equal(bearer.status, 401);
});

/**
 * How long each of `asks` takes while the main thread is busy for `ms`, checked against the slice's 100 ms (#1563, #1903).
 * One ask's wall time also holds every moment the machine ran something else in place of the server's threads or of
 * this process: with ten copies of this file at once, each spinning a main thread, that alone was 112 and 115 ms on
 * CI. So each time is the fastest of up to three asks answered while the main thread was still busy, and
 * the 100 ms is counted on top of what the same ask takes on this machine with the main thread idle, measured just
 * before and just after: 1 to 4 ms on a quiet one, and over 100 ms for all three asks when ten copies share one
 * core, where no number of asks finds a fast one. The claim is that a busy main thread adds nothing to these asks.
 */
async function withinWhileBusy(ms: number, asks: Record<string, (busy: boolean) => Promise<unknown>>) {
  const time = async (ask: () => Promise<unknown>) => {
    const s = Date.now();
    await ask();
    return Date.now() - s;
  };
  const idle: Record<string, number> = {};
  const idleNow = async () => {
    for (const [name, ask] of Object.entries(asks)) {
      const took: number[] = [];
      while (took.length < 3 && !(Math.min(...took) < 5)) took.push(await time(() => ask(false)));
      idle[name] = Math.max(idle[name] ?? 0, Math.min(...took));
    }
  };
  await idleNow();
  let unblocked = 0;
  const blocked = fetch(`${srv.base}/api/test/block?ms=${ms}`).then((r) => ((unblocked = Date.now()), r));
  // timing-ok: a busy main thread can't say it is busy; 200 ms puts these asks inside its loop
  await new Promise((r) => setTimeout(r, 200));
  // Only an ask answered while the main thread was still busy counts: one that waited for it is answered after, and
  // the asks that follow it would be fast. Each name has its share of the busy time for its second and third ask, so
  // on a starved machine the last name is still asked before the main thread is free.
  const start = Date.now();
  const names = Object.keys(asks);
  const busy: Record<string, number[]> = {};
  const late: Record<string, number> = {};
  for (const [i, name] of names.entries()) {
    const took: number[] = (busy[name] = []);
    const share = start + ((i + 1) * (ms - 700)) / names.length;
    while (!unblocked && took.length < 3 && !(Math.min(...took) < 100) && (!took.length || Date.now() < share)) {
      const t = await time(() => asks[name](true));
      if (unblocked) late[name] = t;
      else took.push(t);
    }
  }
  assert.equal((await blocked).status, 200);
  await idleNow();
  for (const name of names) {
    assert.ok(busy[name].length, `${name} wasn't answered while the main thread was busy${name in late ? `: its ask took ${late[name]} ms and ended after the main thread was free` : ''}`);
    // timing-ok: the slice's done line is "within 100 ms while the main thread is blocked 2 s" (#1563)
    assert.ok(Math.min(...busy[name]) < 100 + idle[name], `${name} took ${busy[name].join(', ')} ms (${idle[name]} ms with the main thread idle)`);
  }
}

test('while the main thread is busy for 2 s, the slice still answers within 100 ms', { timeout: 60_000 }, async () => {
  await readerAnswers(srv);
  const asks: Record<string, (busy: boolean) => Promise<unknown>> = {};
  for (const p of [PATHS[0], PATHS[6], PATHS[9], `/api/projects/${A.id}`, `/api/tickets/${M1.id}`, '/api/status'])
    asks[p] = async (busy) => {
      const got = await get(srv, p, srv.cookie);
      assert.equal(got.status, viaMain[`cara ${p}`].status, p);
      // With the main thread idle a reader may hand one ask back (main's write step open past 50 ms, see answers);
      // while it is busy, a hand-back is the wait this test is here to catch.
      if (busy) assert.ok(got.reader, p);
    };
  await withinWhileBusy(2000, asks);
});

test('a reader never sees half of one main step: two writes in one run of the main thread, a pause between them', { timeout: 60_000 }, async () => {
  const title = async () => {
    const got = await get(srv, `/api/tickets/${STEPS.id}`, srv.cookie);
    return { title: JSON.parse(got.body).ticket.title as string, reader: got.reader };
  };
  await until('a reader answers for the minion', async () => (await title()).reader);
  const before = (await title()).title;
  let stepEnded = 0;
  const step = fetch(`${srv.base}/api/test/half-step?ticket=${STEPS.id}&ms=2000`).then((r) => ((stepEnded = Date.now()), r));
  // timing-ok: the step's first write and its 2 s pause start within this; the reads below are checked to have been asked before the step ended
  await new Promise((r) => setTimeout(r, 300));
  // A reader holds a read back while a step is open and the busy main thread answers it when the step ends: whichever answers, it is never the half.
  const reads = await Promise.all([1, 2, 3, 4].map(async () => ({ asked: Date.now(), ...(await title()) })));
  assert.equal((await step).status, 200);
  assert.ok(
    reads.every((r) => r.asked < stepEnded),
    'every read was asked while the step was still running, so none could pass on a step already over',
  );
  const seen = reads.map((r) => r.title);
  assert.ok(
    seen.every((t) => t === before || t === 'whole'),
    `a read saw ${[...new Set(seen)].join(', ')} (before: ${before})`,
  );
  assert.ok(!seen.includes('half'), `a read saw half the step: ${[...new Set(seen)].join(', ')}`);
  // Once the step is whole, readers answer again, with all of it.
  await until('a reader answers with the whole step', async () => {
    const t = await title();
    return t.reader && t.title === 'whole';
  });
});

test('a reader that dies mid-request is replaced, and its request answered by the main thread', { timeout: 60_000 }, async () => {
  const died = await get(srv, `${PATHS[0]}?citadel-test-reader=exit`, srv.cookie);
  assert.equal(died.status, 200);
  assert.equal(died.reader, false);
  assert.equal(died.body, viaMain[`cara ${PATHS[0]}`].body);
  await until('the dead reader is replaced', () => readyAgain() === 1);
  for (let i = 0; i < 6; i++) await fromReader(srv, PATHS[0]);
});

test('a reader that hangs: its request gets a 503 the page retries, the other reader answers, and the thread is replaced', { timeout: 60_000 }, async () => {
  await readerAnswers(srv);
  const hanging = get(srv, `${PATHS[0]}?citadel-test-reader=hang`, srv.cookie, true);
  // Meanwhile the other reader answers, those asked of the hung one first included.
  await Promise.all(Array.from({ length: 4 }, () => fromReader(srv, PATHS[0])));
  const hung = await hanging;
  assert.equal(hung.status, 503);
  assert.equal(JSON.parse(hung.body).retry, true);
  // Two replacements so far: the dead one's, then this one's.
  await until('the hung reader is replaced', () => /Reader thread silent for \d+ s: replacing it/.test(logged()) && readyAgain() === 2);
  const all = await Promise.all(Array.from({ length: 8 }, () => fromReader(srv, PATHS[0])));
  assert.deepEqual(
    all.map((g) => g.status),
    all.map(() => 200),
  );
});

/** One raw answer (no fetch, which would undo the gzip): status, the headers both threads should agree on, the bytes. */
const raw = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer; front: boolean; timed: boolean }>((resolve, reject) => {
    const req = request(`${srv.base}${path}`, { method, headers }, (res) => {
      const parts: Buffer[] = [];
      res
        .on('data', (c) => parts.push(c))
        .on('end', () => {
          const { date, connection, 'keep-alive': _k, 'x-citadel-answered': by, 'server-timing': timing, ...rest } = res.headers;
          resolve({ status: res.statusCode!, headers: rest, body: Buffer.concat(parts), front: by === 'front', timed: TIMED.test(String(timing)) });
        });
    });
    req.on('error', reject).end();
  });
const viaMainThread = (path: string) => `${path}${path.includes('?') ? '&' : '?'}citadel-test-reader=main`;

test('a reload asks again and gets a 304 for every front-end file it already has, its tag the hash of the bytes it got (#1697)', { timeout: 60_000 }, async () => {
  const sha = (b: Buffer) => `"${createHash('sha256').update(b).digest('hex').slice(0, 16)}"`;
  for (const [path, headers] of [
    ['/c/', {}],
    ['/c/app.js', {}],
    ['/c/style.css', { 'Accept-Encoding': 'gzip' }],
    ['/manifest.webmanifest', { 'Sec-CH-Prefers-Color-Scheme': 'dark' }],
    ['/sw.js', {}],
    ['/apps/_citadel/theme.css', {}],
  ] as const) {
    for (const ask of [raw, (p: string, h: Record<string, string>) => raw(viaMainThread(p), h)]) {
      const first = await ask(path, { ...headers });
      assert.equal(first.status, 200, path);
      // never stale: the browser asks every time (no-cache), and a ship's new bytes are a new tag
      assert.equal(first.headers['cache-control'], 'no-cache', path);
      assert.equal(first.headers.etag, sha(first.headers['content-encoding'] ? gunzipSync(first.body) : first.body), path);
      const again = await ask(path, { ...headers, 'If-None-Match': String(first.headers.etag) });
      assert.equal(again.status, 304, path);
      assert.equal(again.body.length, 0, path);
      assert.equal((await ask(path, { ...headers, 'If-None-Match': '"0000000000000000"' })).status, 200, path);
    }
  }
  // A variant is its own tag: the light manifest's tag doesn't get a 304 for the dark one.
  const light = await raw('/manifest.webmanifest');
  assert.equal((await raw('/manifest.webmanifest', { 'Sec-CH-Prefers-Color-Scheme': 'dark', 'If-None-Match': String(light.headers.etag) })).status, 200);
  // Nor the service worker's: with the off switch on, the on worker's tag gets the off worker.
  const on = await raw('/sw.js');
  writeFileSync(join(srv.data, SHELL_OFF_FILE), '');
  try {
    const off = await raw('/sw.js', { 'If-None-Match': String(on.headers.etag) });
    assert.equal(off.status, 200);
    assert.notDeepEqual(off.body, on.body);
  } finally {
    rmSync(join(srv.data, SHELL_OFF_FILE));
  }
});

test('front-end files come from the front thread, the bytes and headers main sends, and while main is busy', { timeout: 60_000 }, async () => {
  const kit = await raw(viaMainThread('/apps/_citadel/theme.css'));
  const cases: [string, Record<string, string>, string?][] = [
    ['/c/', {}],
    ['/c/', { 'Accept-Encoding': 'gzip' }],
    ['/c/app.js', {}],
    ['/app.js', { 'Accept-Encoding': 'gzip, br' }],
    ['/app.js', {}],
    ['/style.css', {}, 'HEAD'],
    ['/sw.js', {}],
    ['/manifest.webmanifest', {}],
    ['/manifest.webmanifest', { 'Sec-CH-Prefers-Color-Scheme': 'dark' }],
    ['/apps/_citadel/theme.css', {}],
    ['/apps/_citadel/theme.css', { 'If-None-Match': String(kit.headers.etag) }],
    ['/apps/_citadel/ui/chat.js', {}],
  ];
  for (const [path, headers, method] of cases) {
    const main = await raw(viaMainThread(path), headers, method),
      front = await raw(path, headers, method);
    const key = `${method ?? 'GET'} ${path} ${JSON.stringify(headers)}`;
    assert.ok(front.front && !main.front, key);
    assert.ok(front.timed && main.timed, `${key}: both carry Server-Timing (#1752)`);
    assert.deepEqual({ ...front, front: true }, { ...main, front: true }, key);
  }
  assert.equal((await raw('/c/', { 'Accept-Encoding': 'gzip' })).headers['content-encoding'], 'gzip');
  assert.equal((await raw('/apps/_citadel/theme.css', { 'If-None-Match': String(kit.headers.etag) })).status, 304);
  assert.notDeepEqual((await raw('/manifest.webmanifest', { 'Sec-CH-Prefers-Color-Scheme': 'dark' })).body, (await raw('/manifest.webmanifest')).body);
  // Not a file, or the redirect to /c/: the main thread answers, as it always did.
  for (const path of ['/', '/c/share?x=1', '/nope.js', '/api/health', '/backup', '/apps/_citadel/nope.js']) assert.ok(!(await raw(path)).front, path);
  // The service worker's off switch (src/shell.ts) is read per request, so the front sees it the moment it is set.
  const on = await raw('/sw.js');
  writeFileSync(join(srv.data, SHELL_OFF_FILE), '');
  try {
    const off = await raw('/sw.js');
    assert.ok(off.front);
    assert.deepEqual(off.body, (await raw(viaMainThread('/sw.js'))).body);
    assert.notDeepEqual(off.body, on.body);
  } finally {
    rmSync(join(srv.data, SHELL_OFF_FILE));
  }
  // A file the front holds never waits on the main thread.
  const files: Record<string, (busy: boolean) => Promise<unknown>> = {};
  for (const path of ['/c/', '/app.js', '/apps/_citadel/theme.css'])
    files[path] = async (busy) => {
      const got = await raw(path);
      assert.equal(got.status, 200, path);
      // With the main thread idle the front passes a file on while a change main posted is still on its way to it
      // (caughtUp, src/front.ts): seen once on CI, just after the busy main thread was free. While it is busy, the
      // front's own answer is the claim.
      if (busy) assert.ok(got.front, path);
    };
  await withinWhileBusy(1500, files);
});

test('everything else passes through: a POST, a live stream, the password check', { timeout: 60_000 }, async () => {
  const wrong = await fetch(`${srv.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: `${PASSWORD}x` }) });
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get('server-timing') ?? '', TIMED, "a passed-on answer carries the front's stamp alone (#1752)");
  const me = await srv.call('/api/me');
  assert.equal(me.status, 200);
  const ctl = new AbortController();
  const stream = await fetch(`${srv.base}/api/stream`, { headers: { Cookie: srv.cookie, Accept: 'text/event-stream' }, signal: ctl.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /event-stream/);
  const first = await stream.body!.getReader().read();
  assert.ok(first.value && first.value.length > 0, 'the stream sent its first event through the front thread');
  ctl.abort();
});

test("a client can't set the peer headers, not even on a connection that asked for an upgrade the main thread refuses", { timeout: 60_000 }, async () => {
  const sock = connect(Number(new URL(srv.base).port), '127.0.0.1');
  // One request at a time on the one connection; each answer is a small JSON body, chunked or with a Content-Length.
  const ask = (extra: string) =>
    new Promise<string>((done, fail) => {
      let got = '';
      const on = (c: Buffer) => {
        got += c;
        const end = got.indexOf('\r\n\r\n'),
          len = Number(/content-length: (\d+)/i.exec(got)?.[1]);
        if (end < 0 || !(got.endsWith('\r\n0\r\n\r\n') || Buffer.byteLength(got) - end - 4 >= len)) return;
        sock.off('data', on);
        done(got);
      };
      sock.on('data', on).once('error', fail);
      sock.write(`GET /api/test/peer HTTP/1.1\r\nHost: 127.0.0.1\r\n${extra}X-Citadel-Peer: 10.9.9.9\r\nX-Citadel-Local: 10.9.9.9 4444\r\n\r\n`);
    });
  try {
    for (const extra of ['Connection: Upgrade\r\nUpgrade: websocket\r\n', '']) {
      const got = await ask(extra);
      assert.match(got, /^HTTP\/1\.1 200/);
      assert.doesNotMatch(got, /10\.9\.9\.9/, extra || 'the next request on that connection');
      assert.match(got, /"remote":"(::ffff:)?127\.0\.0\.1"/);
    }
  } finally {
    sock.destroy();
  }
});

test("a restart answers what the front thread already took, a reader's answer included, then exits", { timeout: 60_000 }, async () => {
  const slow = get(srv, `${PATHS[0]}?citadel-test-reader=slow`, srv.cookie);
  await until('the reader has the request', () => logged().includes('Reader test hook: slow'));
  srv.proc.kill('SIGTERM');
  const got = await slow;
  assert.equal(got.status, 200);
  assert.ok(got.reader);
  await until('the server exits', () => srv.proc.exitCode !== null || srv.proc.signalCode !== null);
  assert.equal(srv.proc.exitCode, 0);
});

test('a write the writer is still holding is never missed: the read waits for it', { timeout: 120_000 }, async () => {
  const slow = await bootServer({ root, env: { CITADEL_DB_WRITE_DELAY_MS: '300' } });
  try {
    await readerAnswers(slow);
    // Held 300 ms on the writer: a reader waits for it. A try the main thread answered is not the read under test (the
    // front passes one on while a change main posted is still on its way to it, #1903): it writes and reads again.
    const sent: ReturnType<typeof slow.call>[] = [];
    await until('a read that waited for the held write', async () => {
      sent.push(slow.call(`/api/tickets/${M1.id}/messages`, { text: 'read your writes' }));
      const t0 = Date.now();
      const got = await get(slow, PATHS[0], slow.cookie);
      assert.equal(got.status, 200);
      // timing-ok: a read that waits for nothing takes a few ms; the write is held 300
      return got.reader && Date.now() - t0 > 100;
    });
    for (const s of sent) assert.equal((await s).status, 202);
    // The response came once its writes ran (#1244): the next read, a reader's again, has the message.
    const next = await until('readers answer again', async () => {
      const got = await get(slow, PATHS[0], slow.cookie);
      return got.reader && got;
    });
    assert.match(next.body, /read your writes/);
  } finally {
    await slow.stop();
  }
});

test('a long TMPDIR with no XDG_RUNTIME_DIR still gets the server listening through the front (the socket path stays under 107 bytes)', async () => {
  const long = join(root, 'long-' + 'x'.repeat(100), 'heavy-tmp');
  mkdirSync(long, { recursive: true });
  const srv = await bootServer({ root: join(root, 'longtmp'), env: { TMPDIR: long, XDG_RUNTIME_DIR: '' } });
  try {
    const res = await fetch(`${srv.base}/api/tickets/${M1.id}/events`);
    assert.ok(res.status > 0);
  } finally {
    await srv.stop();
  }
});

test("a running turn, a queued message and an approval card: the readers' list, minion page and Status show each caller what main shows", { timeout: 120_000 }, async () => {
  const forever = join(root, 'claude-forever');
  writeFileSync(forever, `#!${process.execPath}\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`);
  chmodSync(forever, 0o755);
  const home = tmp.path('live');
  // No sweep in this test: each change's own broadcast must carry it to the readers.
  const live = await bootServer({ root: home, env: { ...KNOBS, CLAUDE_BIN: forever, NODE_NO_WARNINGS: '1', CITADEL_READER_SWEEP_MS: '600000', TMPDIR: undefined, HOME: home }, log: join(root, 'live.log') });
  try {
    const project = (await live.call('/api/projects', { name: 'Live' })).data;
    // Max a member who isn't an admin, Olive in no scheme: what the list and Status show depends on who asks.
    const ids: Record<string, number> = {};
    for (const name of ['Max', 'Olive']) {
      const invited = await live.call('/api/people', { name });
      ids[name] = invited.data.person.id;
      await fetch(`${live.base}/api/invite/${invited.data.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
    }
    assert.equal((await live.call(`/api/projects/${project.id}/members`, { person: ids.Max })).status, 200);
    const callers = { cara: live.cookie, max: await signIn(live, 'Max', 'a-long-password'), olive: await signIn(live, 'Olive', 'a-long-password') };
    const made = (await live.call(`/api/projects/${project.id}/tickets`, { message: 'tidy up' })).data;
    const t = made.ticket ?? made;
    const minion = { Authorization: `Bearer ${await mintedAgentToken(live.data, t.id)}`, 'Content-Type': 'application/json' };
    await until('the turn', async () => (await fetch(`${live.base}/api/tickets/${t.id}/approvals?id=x`, { headers: minion })).ok);
    // Past its launch (#1808): its token works a moment before the turn is followed and broadcast with its start time.
    await until('the turn is followed', async () => !!JSON.parse((await get(live, `/api/tickets/${t.id}?citadel-test-reader=main`, live.cookie)).body).ticket.turnStartedAt);
    assert.equal((await live.call(`/api/tickets/${t.id}/messages`, { text: 'and then this', after: true })).status, 202);
    // A tripwire card (test/approvals.test.ts): the server's HOME holds its data, the turn has its own TMPDIR.
    const bak = join(live.data, 'coordinator.db.bak-x');
    const card = await (
      await fetch(`${live.base}/api/tickets/${t.id}/approvals`, {
        method: 'POST',
        headers: minion,
        body: JSON.stringify({ tool_name: 'Bash', input: { command: `cp ${bak} "$TMPDIR/" && rm ${bak}`, description: 'Move the stale copy Cara named out of the data dir' } }),
      })
    ).json();
    assert.ok(card.id, JSON.stringify(card));
    const page = (p: string, main = false, cookie = live.cookie) => get(live, main ? `${p}${p.includes('?') ? '&' : '?'}citadel-test-reader=main` : p, cookie);
    // Main's own answer has the three: the turn running, the message queued, the card waiting.
    const first = await page(`/api/tickets/${t.id}`, true);
    const viaMainNow = JSON.parse(first.body).ticket;
    assert.equal(first.status, 200, first.body);
    assert.equal(viaMainNow.status, 'running', first.body.slice(0, 600));
    assert.equal(viaMainNow.queued, 1);
    assert.equal(viaMainNow.approvals, 1);
    assert.ok(
      viaMainNow.open_cards.some((c: { kind: string }) => c.kind === 'approval'),
      JSON.stringify(viaMainNow.open_cards),
    );
    // The scheme's first open makes its Taskmaster, a write: the main thread's (a reader hands it over).
    assert.equal((await page(`/api/projects/${project.id}`, true)).status, 200);
    for (const [who, cookie] of Object.entries(callers))
      for (const p of [`/api/tickets/${t.id}`, `/api/projects/${project.id}`, `/api/projects/${project.id}?tickets=open`, '/api/status']) {
        // The reader first, so its copy can't have been refreshed by main's answer to the same page.
        const reader = await fromReader(live, p, cookie);
        const main = await page(p, true, cookie);
        assert.ok(reader.reader && !main.reader, `${who} ${p}`);
        assert.equal(reader.status, main.status, `${who} ${p}`);
        if (who !== 'olive') assert.equal(reader.status, 200, `${who} ${p}`);
        // The Status page's clock is each answer's own. Values main moves on a timer with no broadcast, which only the
        // sweep (off here) carries: the turn's activity clock while a card waits on a person (Runner.checkQuiet), and the
        // answer-time probes' last readings. And the main thread's own stalls (#1903): it records one once its event loop
        // is free again, so its answer, which waited the stall out, counts a stall the reader's answer, given during it,
        // can't have (2.2 s on CI with ten copies of this file at once).
        const timed = (k: string, v: unknown) => (k === 'activity' && v ? { ...v, at: 0 } : k === 'answer' && v && typeof v === 'object' && 'probing' in v ? { ...v, now: 0, reader: 0 } : k === 'stalls' ? null : v);
        const sansNow = (body: string) => ({ ...JSON.parse(body, timed), now: 0 });
        const [r, m] = [sansNow(reader.body), sansNow(main.body)];
        assert.deepEqual(r, m, `${who} ${p}: ${differs(r, m).slice(0, 5).join(', ')}`);
      }
  } finally {
    await live.stop();
  }
});

/** The paths where two JSON values differ, for an assertion's message. */
function differs(a: unknown, b: unknown, at = ''): string[] {
  if (a === b) return [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return [at || '(root)'];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => differs((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`));
}
