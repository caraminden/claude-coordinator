// An app restarting behind the proxy (#1118): its requests wait for it instead of getting a 502, and a dead app still
// fails fast. A fixture app is closed and opened again on the same port under a stream of requests.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { HOLD_MS, RestartHolds } from '../src/apps.ts';
import { forward } from '../src/proxy.ts';
import { FakeClock } from './fake-clock.ts';
import { bootServer, fakeSystemd, freePort, tempRoot, until, type Booted } from './helpers.ts';

const servers: Server[] = [];
let srv: Booted | undefined;
const tmp = tempRoot('restart-hold-');
const root = tmp.dir;
// The fixture app's port and the "dead app" ports below stay on freePort: the hold decides an app is back by connecting to its
// port, so the port must be refused (not accepted and reset, as tmp.down() would) and the app must be able to listen on it again.
after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  await srv?.stop();
  await tmp.teardown();
});

/** The fixture app: answers 200 with the body it got. */
function app(port: number): Promise<Server> {
  const s = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`got ${Buffer.concat(parts).toString()}`));
  });
  servers.push(s);
  return new Promise((ok) => s.listen(port, '127.0.0.1', () => ok(s)));
}

/** A graceful stop: it takes no new connections and ends those it has once answered (one it has already read can't be replayed). */
const stop = (s: Server) =>
  new Promise<void>((ok) => {
    s.close(() => ok());
    s.closeIdleConnections();
  });

/** The proxy in front of it, as AppProxy.serve uses the holds. */
// The proxy's own retry of a refused GET (#1173, test/proxy-retry.test.ts) is off unless a test asks for it, so these
// test the hold alone; a held request never retries on top, as in src/apps.ts.
// `held` gets, per request path, whether it waited under the hold: the tests check that, not how long it took (#1444).
async function proxy(holds: RestartHolds, port: number, retryMs = 0, held: Record<string, boolean> = {}): Promise<string> {
  const s = createServer((req, res) =>
    holds.whenUp('fixture', port, res, (h) => {
      held[req.url!] = !!h;
      forward(req, res, port, req.url!, { ...req.headers }, { what: 'Fixture', retryMs: h ? 0 : retryMs });
    }),
  );
  servers.push(s);
  return `http://127.0.0.1:${await tmp.serve(s)}`;
}

const ask = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, { ...init, headers: { Connection: 'close' } });
  return { status: res.status, body: await res.text() };
};

test('an app restarting under a stream of requests: none gets a 502, each waits under the hold, a body arrives whole', async () => {
  const port = await freePort();
  let fixture = await app(port);
  // The hold's clock never moves, so its cap can't end a wait: every request sent in the gap got through because the
  // app came back, not because the hold gave up.
  const holds = new RestartHolds(3000, 200, new FakeClock().now);
  const base = await proxy(holds, port);
  // Requests sent before the stop may be on the app's socket when it closes: the kernel resets those, and they can't be
  // replayed (the app may have read them). Every one sent once it stopped listening must get through.
  const asked: Promise<Awaited<ReturnType<typeof ask>>>[] = [];
  let firstAfter = Infinity;
  let down = false;
  let inGap = 0;
  const stream = setInterval(() => {
    const n = asked.length;
    if (down) inGap++;
    if (down && firstAfter === Infinity) firstAfter = n;
    asked.push(n % 3 ? ask(`${base}/apps/fixture/${n}`) : ask(`${base}/apps/fixture/${n}`, { method: 'POST', body: `body ${n}` }));
  }, 20);
  await until('requests flowing before the restart', () => asked.length >= 10);
  const release = holds.hold('fixture');
  const stopped = stop(fixture);
  down = true;
  await stopped;
  await until('requests sent while the app is down', () => inGap >= 10);
  fixture = await app(port);
  down = false;
  release();
  const back = asked.length;
  await until('requests sent once it is back', () => asked.length >= back + 10);
  clearInterval(stream);
  const done = await Promise.all(asked);
  assert.deepEqual(
    done.map((d, n) => ({ ...d, n })).filter((d) => d.n >= firstAfter && d.status !== 200),
    [],
  );
  for (const [n, d] of done.entries()) if (n >= firstAfter && n % 3 === 0) assert.equal(d.body, `got body ${n}`);
});

test('an app that is not restarting and not answering: a 502 at once, not held', async () => {
  const port = await freePort();
  const held: Record<string, boolean> = {};
  const base = await proxy(new RestartHolds(3000, 200, new FakeClock().now), port, 0, held);
  const d = await ask(`${base}/apps/fixture/`);
  assert.equal(d.status, 502);
  assert.match(d.body, /Fixture is not answering/);
  assert.deepEqual(held, { '/apps/fixture/': false }, 'it went straight on, with no wait');
});

test('a restart that never comes back: the hold ends at its cap with a 502', async () => {
  const port = await freePort();
  const clock = new FakeClock();
  let reads = 0;
  const holds = new RestartHolds(600, 200, () => (reads++, clock.now()));
  const held: Record<string, boolean> = {};
  // With the proxy's retry on: a request that waited out the hold doesn't then retry for another 5 s.
  const base = await proxy(holds, port, 5000, held);
  holds.hold('fixture');
  const d = ask(`${base}/apps/fixture/`);
  await until('the request to wait under the hold', () => holds.waiting('fixture') === 1);
  clock.advance(599);
  const r = reads;
  // A whole turn of its poll loop reads the clock 3 times: 4 reads means it saw 599 ms and chose to keep waiting.
  await until('the hold to look at the clock again', () => reads >= r + 4);
  assert.deepEqual(held, {}, 'still waiting just before the cap');
  clock.advance(1);
  assert.equal((await d).status, 502);
  assert.deepEqual(held, { '/apps/fixture/': true }, 'it waited under the hold, so the proxy does not retry on top');
});

test('after the restart ends its grace runs out, then a dead app fails fast again', async () => {
  const port = await freePort();
  const clock = new FakeClock();
  const holds = new RestartHolds(300, 200, clock.now);
  const held: Record<string, boolean> = {};
  const base = await proxy(holds, port, 0, held);
  holds.hold('fixture')();
  clock.advance(299);
  const inGrace = ask(`${base}/apps/fixture/a`);
  await until('the request in the grace to wait', () => holds.waiting('fixture') === 1);
  clock.advance(1);
  assert.equal((await ask(`${base}/apps/fixture/b`)).status, 502);
  assert.deepEqual(held, { '/apps/fixture/b': false }, 'the grace is over: the next one is not held, while the one before still waits');
  clock.advance(299);
  assert.equal((await inGrace).status, 502, 'the one asked in the grace waited out its own cap');
  assert.equal(held['/apps/fixture/a'], true);
});

test('past the cap on waiting requests, the next one is not held', async () => {
  const port = await freePort();
  const clock = new FakeClock();
  const holds = new RestartHolds(800, 1, clock.now);
  const held: Record<string, boolean> = {};
  const base = await proxy(holds, port, 0, held);
  holds.hold('fixture');
  const first = ask(`${base}/apps/fixture/a`);
  await until('the first request to wait', () => holds.waiting('fixture') === 1);
  const second = await ask(`${base}/apps/fixture/b`);
  assert.equal(second.status, 502);
  assert.deepEqual(held, { '/apps/fixture/b': false }, 'the second went on at once while the first still waits');
  clock.advance(800);
  assert.equal((await first).status, 502);
  assert.equal(held['/apps/fixture/a'], true);
});

test("through Citadel: a restart from Settings holds the app's requests, a stop does not", async () => {
  // A systemctl whose restart takes a while, as a real one does while the app comes back; it says when it began.
  const fake = fakeSystemd(join(root, 'systemd'));
  const slow = join(root, 'slow-systemctl');
  writeFileSync(slow, `#!/bin/sh\ncase " $* " in *" restart "*) touch "${root}/restarting"; sleep 1.5;; esac\nexec "${fake.bin}" "$@"\n`);
  chmodSync(slow, 0o755);
  const home = join(root, 'home');
  const units = join(home, '.config', 'systemd', 'user');
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, 'citadel-app-fixture.service'), '# Written by Citadel for contraption fixture.\n');
  srv = await bootServer({ root, env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), CITADEL_SYSTEMCTL: slow, CITADEL_JOURNALCTL: fake.journal } });
  const port = await freePort();
  let fixture = await app(port);
  assert.equal((await srv.call('/api/contraptions', { name: 'fixture', title: 'Fixture', port })).status, 201);
  const me = (await srv.call('/api/me')).data.id;
  assert.equal((await srv.call(`/api/contraptions/fixture/people/${me}`, { enabled: true }, 'PUT')).status, 200);
  const get = async () => {
    const t = Date.now();
    const res = await fetch(`${srv!.base}/apps/fixture/x`, { headers: { Cookie: srv!.cookie, Connection: 'close' } });
    return { status: res.status, body: await res.text(), ms: Date.now() - t };
  };
  assert.equal((await get()).status, 200);

  const restarted = srv.call('/api/contraptions/fixture/service', { action: 'restart' });
  await until('the restart to begin', () => existsSync(join(root, 'restarting')));
  await stop(fixture);
  const held = [get(), get(), get()];
  // timing-ok: lets the three requests reach the server's hold first; shorter only makes the check weaker, never red
  await new Promise((r) => setTimeout(r, 800));
  fixture = await app(port);
  assert.equal((await restarted).status, 200);
  for (const d of await Promise.all(held)) assert.deepEqual([d.status, d.body], [200, 'got ']);

  assert.equal((await srv.call('/api/contraptions/fixture/service', { action: 'stop' })).status, 200);
  await stop(fixture);
  const d = await get();
  assert.equal(d.status, 502);
  // The server's hold is in another process, so this one stays on real time. A held request can't fail before HOLD_MS
  // (its port stays shut), so failing sooner proves the stop dropped the hold; no box is slow enough to blur the two.
  assert.ok(d.ms < HOLD_MS, `a stopped app took ${d.ms} ms to fail: it was held`); // timing-ok: HOLD_MS is the rule's own line

  // Started again: a GET while it boots waits for it (the proxy's retry), where a stopped one failed fast.
  assert.equal((await srv.call('/api/contraptions/fixture/service', { action: 'start' })).status, 200);
  const booting = get();
  // timing-ok: the app comes up after the GET is in flight; shorter only makes the check weaker, never red
  await new Promise((r) => setTimeout(r, 500));
  fixture = await app(port);
  assert.deepEqual([(await booting).status, (await booting).body], [200, 'got ']);
  await stop(fixture);
});

test('restarting() is true during a hold and for the grace after its release, never for a stopped or unknown app (#1728)', () => {
  let t = 1000;
  const holds = new RestartHolds(HOLD_MS, 200, () => t);
  assert.equal(holds.restarting('a', 15_000), false, 'never restarted');
  const release = holds.hold('a');
  t += 60_000;
  assert.equal(holds.restarting('a', 15_000), true, 'still held, however long');
  release();
  t += 14_999;
  assert.equal(holds.restarting('a', 15_000), true);
  t += 2;
  assert.equal(holds.restarting('a', 15_000), false, 'past the window');
  holds.hold('a')();
  holds.stopped('a');
  assert.equal(holds.restarting('a', 15_000), false, 'stopped on purpose');
});
