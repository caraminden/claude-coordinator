// Page reads while the readers are stalled on a swamped disk (#2003, src/front.ts): they wait for a reader, or fail in
// a way the page retries, and never run on the main thread, which would freeze every other request. The main thread's
// page reads are made slow here (citadel-test-main-read), so one that reaches it holds /api/health too.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer, tempRoot, type Booted } from './helpers.ts';
import { until } from './wait.ts';

const tmp = tempRoot('reader-stall-');
after(() => tmp.teardown());
const root = tmp.dir;
mkdirSync(join(root, 'data'), { recursive: true });
const store = new Store(join(root, 'data', 'coordinator.db'));
const scheme = store.createProject('A', null);
const M = store.createTicket({ project_id: scheme.id, kind: 'ticket', title: 'One', permission_mode: 'default', created_by: 'Cara' });
const cwd = join(root, 'work', String(M.id));
mkdirSync(cwd, { recursive: true });
store.setTicketDir(M.id, cwd, null);
store.addEvent(M.id, 'note', { text: 'first' });
store.db.close();

// A reader is late after 1 s, replaced after 3 s, and a page read waits 4 s for one (2, 10 and 8 s live).
const KNOBS = { CITADEL_READER_ANSWER_MS: '1000', CITADEL_READER_STUCK_MS: '3000' };
const HELD = 2000;
const PAGE = `/api/tickets/${M.id}/events?citadel-test-main-read=${HELD}`;
type Got = { status: number; by: string | null; body: string };
const get = async (srv: Booted, path: string, signal?: AbortSignal): Promise<Got> => {
  const res = await fetch(srv.base + path, { headers: { Cookie: srv.cookie }, signal });
  return { status: res.status, by: res.headers.get('x-citadel-answered'), body: await res.text() };
};
const readersAnswer = async (srv: Booted, log: string) => {
  await until('both readers are up', () => readFileSync(join(root, log), 'utf8').split('Reader test hook: ready').length === 3);
  await until('a reader answers', async () => (await get(srv, PAGE)).by === 'reader');
};
/** Stall both readers for `ms`: two requests, which go to a reader each, both given up at once by the page that sent them. */
async function stall(srv: Booted, log: string, ms: number) {
  const gone = new AbortController();
  const sent = [1, 2].map((n) => get(srv, `/api/tickets/${M.id}/events?citadel-test-reader=stall-${ms}&n=${n}`, gone.signal).catch(() => null));
  await until('both readers are stalled', () => readFileSync(join(root, log), 'utf8').split('Reader test hook: stalled').length === 3);
  gone.abort();
  await Promise.all(sent);
}
/** The slowest /api/health, a main-thread answer, until `done` settles. */
async function slowestHealth(srv: Booted, done: Promise<unknown>) {
  let over = false;
  void done.finally(() => (over = true)).catch(() => {});
  let worst = 0;
  while (!over) {
    const t0 = Date.now();
    assert.equal((await fetch(`${srv.base}/api/health`)).status, 200);
    worst = Math.max(worst, Date.now() - t0);
    // timing-ok: how often the main thread is asked, not a wait for anything
    await new Promise((r) => setTimeout(r, 50));
  }
  return worst;
}

test('with both readers stalled, page reads are answered by the readers started in their place, the main thread free throughout', { timeout: 90_000 }, async () => {
  const srv = await bootServer({ root, env: KNOBS, log: join(root, 'one.log') });
  try {
    await readersAnswer(srv, 'one.log');
    await stall(srv, 'one.log', 15_000);
    const t0 = Date.now();
    // As the page asks (public/base.js): again on a 503 that says so.
    const pages = Promise.all(
      [1, 2, 3].map(async () => {
        for (;;) {
          const got = await get(srv, PAGE);
          if (got.status !== 503) return got;
          assert.equal(JSON.parse(got.body).retry, true);
        }
      }),
    );
    const worst = await slowestHealth(srv, pages);
    for (const got of await pages) assert.deepEqual([got.status, got.by], [200, 'reader']);
    // timing-ok: one page read reaching the main thread holds it 2 s; a health answer takes a few ms
    assert.ok(worst < HELD, `the main thread was held for ${worst} ms`);
    // timing-ok: the stalled readers are stuck for 15 s, so these answers came from new ones
    assert.ok(Date.now() - t0 < 14_000, `pages took ${Date.now() - t0} ms`);
    // Each new one was ready before an old one went.
    await until('the stalled readers are gone', () => readFileSync(join(root, 'one.log'), 'utf8').split('Reader thread replaced').length === 3);
    const lines = readFileSync(join(root, 'one.log'), 'utf8').match(/Reader thread (started again|replaced)/g)!;
    assert.deepEqual(lines[0], 'Reader thread started again');
    assert.deepEqual(lines.slice().sort(), [...Array(2).fill('Reader thread replaced'), ...Array(2).fill('Reader thread started again')]);
  } finally {
    await srv.stop();
  }
});

test('with no reader to be had, a page read fails within its wait, saying to retry, and a reader that comes back answers again', { timeout: 90_000 }, async () => {
  const may = join(root, 'readers-may-start');
  writeFileSync(may, '');
  const srv = await bootServer({ root, env: { ...KNOBS, CITADEL_READER_BOOT_WAIT: may }, log: join(root, 'two.log') });
  try {
    await readersAnswer(srv, 'two.log');
    rmSync(may); // the ones started in their place don't get ready
    await stall(srv, 'two.log', 10_000);
    const first = get(srv, PAGE);
    // The tests' own client (bootServer's call) asks again on that answer, as the page does, so a read on a loaded
    // runner waits for a reader rather than failing its test (#2012).
    const asked = srv.call(PAGE);
    const worst = await slowestHealth(srv, first);
    const got = await first;
    assert.deepEqual([got.status, got.by], [503, 'front']);
    assert.equal(JSON.parse(got.body).retry, true);
    // timing-ok: as above
    assert.ok(worst < HELD, `the main thread was held for ${worst} ms`);
    // Slow, not stuck: the same readers answer once their disk does, neither thrown away.
    await until('a reader answers again', async () => (await get(srv, PAGE)).by === 'reader');
    assert.equal((await asked).status, 200, "the tests' client asked again until a reader answered");
    const log = readFileSync(join(root, 'two.log'), 'utf8');
    assert.match(log, /Reader thread silent for \d+ s: replacing it/);
    assert.doesNotMatch(log, /Reader thread (stopped|replaced|started again)/);
    assert.ok(!existsSync(may));
  } finally {
    writeFileSync(may, '');
    await srv.stop();
  }
});

test('a page read before the first reader is up waits for it past its usual wait, the main thread free throughout', { timeout: 90_000 }, async () => {
  const may = join(root, 'first-readers-may-start');
  const srv = await bootServer({ root, env: { ...KNOBS, CITADEL_READER_BOOT_WAIT: may }, log: join(root, 'four.log') });
  try {
    // Its reader, once up, takes 1.5 s over it: it has the whole wait from then, not what was left of the read's own.
    const first = get(srv, `${PAGE}&citadel-test-reader=stall-1500`);
    const sent = Date.now();
    const worst = slowestHealth(srv, first);
    // timing-ok: past the 4 s a read waits for readers that have been up, where it got a 503
    await until('the usual wait to be over', () => Date.now() - sent > 5000);
    writeFileSync(may, '');
    const got = await first;
    assert.deepEqual([got.status, got.by], [200, 'reader']);
    // timing-ok: as above
    assert.ok((await worst) < HELD, `the main thread was held for ${await worst} ms`);
  } finally {
    writeFileSync(may, '');
    await srv.stop();
  }
});

test('while writes are backed up, page reads wait for them in a reader, the main thread free throughout', { timeout: 90_000 }, async () => {
  const srv = await bootServer({ root, env: { ...KNOBS, CITADEL_DB_WRITE_DELAY_MS: '300' }, log: join(root, 'three.log') });
  try {
    await readersAnswer(srv, 'three.log');
    const sent = srv.call(`/api/tickets/${M.id}/messages`, { text: 'read your writes' });
    let over = false;
    void sent.finally(() => (over = true));
    const seen: (string | null)[] = [];
    const reads = (async () => {
      while (!over) seen.push((await get(srv, PAGE)).by);
    })();
    // timing-ok: as above
    const worst = await slowestHealth(srv, reads);
    assert.ok(worst < HELD, `the main thread was held for ${worst} ms`);
    assert.equal((await sent).status, 202);
    assert.ok(seen.length > 0 && seen.every((by) => by === 'reader' || by === 'front'), seen.join());
    // The message's answer came once its writes ran (#1244): the next read has it.
    const next = await until('a reader answers', async () => {
      const got = await get(srv, PAGE);
      return got.by === 'reader' && got;
    });
    assert.match(next.body, /read your writes/);
  } finally {
    await srv.stop();
  }
});
