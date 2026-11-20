// An app restarting behind the proxy (#1118): its requests wait for it instead of getting a 502, and a dead app still
// fails fast. A fixture app is closed and opened again on the same port under a stream of requests.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { RestartHolds } from '../src/apps.ts';
import { forward } from '../src/proxy.ts';
import { bootServer, fakeSystemd, freePort, until, type Booted } from './helpers.ts';

const servers: Server[] = [];
let srv: Booted | undefined;
const root = mkdtempSync(join(tmpdir(), 'restart-hold-'));
after(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  await srv?.stop();
  rmSync(root, { recursive: true, force: true });
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
const stop = (s: Server) => new Promise<void>((ok) => {
  s.close(() => ok());
  s.closeIdleConnections();
});

/** The proxy in front of it, as AppProxy.serve uses the holds. */
// The proxy's own retry of a refused GET (#1173, test/proxy-retry.test.ts) is off unless a test asks for it, so these
// test the hold alone; a held request never retries on top, as in src/apps.ts.
async function proxy(holds: RestartHolds, port: number, retryMs = 0): Promise<string> {
  const s = createServer((req, res) => holds.whenUp('fixture', port, res, (held) => forward(req, res, port, req.url!, { ...req.headers }, { what: 'Fixture', retryMs: held ? 0 : retryMs })));
  servers.push(s);
  const p = await freePort();
  await new Promise<void>((ok) => s.listen(p, '127.0.0.1', () => ok()));
  return `http://127.0.0.1:${p}`;
}

const timed = async (url: string, init?: RequestInit) => {
  const t = Date.now();
  const res = await fetch(url, { ...init, headers: { Connection: 'close' } });
  return { status: res.status, body: await res.text(), ms: Date.now() - t };
};

test('an app restarting under a stream of requests: none gets a 502, each waits under the hold, a body arrives whole', async () => {
  const port = await freePort();
  let fixture = await app(port);
  const holds = new RestartHolds(3000);
  const base = await proxy(holds, port);
  // Requests sent before the stop may be on the app's socket when it closes: the kernel resets those, and they can't be
  // replayed (the app may have read them). Every one sent once it stopped listening must get through.
  const asked: Promise<Awaited<ReturnType<typeof timed>>>[] = [];
  let firstAfter = Infinity;
  let down = false;
  let inGap = 0;
  const stream = setInterval(() => {
    const n = asked.length;
    if (down) inGap++;
    if (down && firstAfter === Infinity) firstAfter = n;
    asked.push(n % 3 ? timed(`${base}/apps/fixture/${n}`) : timed(`${base}/apps/fixture/${n}`, { method: 'POST', body: `body ${n}` }));
  }, 20);
  await new Promise((r) => setTimeout(r, 200));
  const release = holds.hold('fixture');
  const stopped = stop(fixture);
  down = true;
  await stopped;
  await new Promise((r) => setTimeout(r, 1200));
  fixture = await app(port);
  down = false;
  release();
  await new Promise((r) => setTimeout(r, 300));
  clearInterval(stream);
  const done = await Promise.all(asked);
  assert.ok(inGap >= 5, `only ${inGap} requests went while the app was down`);
  assert.deepEqual(done.map((d, n) => ({ ...d, n })).filter((d) => d.n >= firstAfter && d.status !== 200), []);
  for (const [n, d] of done.entries()) if (n >= firstAfter && n % 3 === 0) assert.equal(d.body, `got body ${n}`);
  assert.ok(Math.max(...done.map((d) => d.ms)) < 3000, `the slowest took ${Math.max(...done.map((d) => d.ms))} ms`);
});

test('an app that is not restarting and not answering: a 502 inside 1 s', async () => {
  const port = await freePort();
  const base = await proxy(new RestartHolds(3000), port);
  const d = await timed(`${base}/apps/fixture/`);
  assert.equal(d.status, 502);
  assert.match(d.body, /Fixture is not answering/);
  assert.ok(d.ms < 1000, `took ${d.ms} ms`);
});

test('a restart that never comes back: the hold ends at its cap with a 502', async () => {
  const port = await freePort();
  const holds = new RestartHolds(600);
  // With the proxy's retry on: a request that waited out the hold doesn't then retry for another 5 s.
  const base = await proxy(holds, port, 5000);
  holds.hold('fixture');
  const d = await timed(`${base}/apps/fixture/`);
  assert.equal(d.status, 502);
  assert.ok(d.ms >= 550 && d.ms < 1500, `took ${d.ms} ms`);
});

test('after the restart ends its grace runs out, then a dead app fails fast again', async () => {
  const port = await freePort();
  const holds = new RestartHolds(300);
  const base = await proxy(holds, port);
  holds.hold('fixture')();
  assert.ok((await timed(`${base}/apps/fixture/`)).ms >= 250);
  await new Promise((r) => setTimeout(r, 350));
  assert.ok((await timed(`${base}/apps/fixture/`)).ms < 250);
});

test('past the cap on waiting requests, the next one is not held', async () => {
  const port = await freePort();
  const holds = new RestartHolds(800, 1);
  const base = await proxy(holds, port);
  holds.hold('fixture');
  const first = timed(`${base}/apps/fixture/a`);
  await new Promise((r) => setTimeout(r, 50));
  const second = await timed(`${base}/apps/fixture/b`);
  assert.equal(second.status, 502);
  assert.ok(second.ms < 400, `the second waited ${second.ms} ms`);
  assert.ok((await first).ms >= 750);
});

test('through Citadel: a restart from Settings holds the app\'s requests, a stop does not', async () => {
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
  await new Promise((r) => setTimeout(r, 800));
  fixture = await app(port);
  assert.equal((await restarted).status, 200);
  for (const d of await Promise.all(held)) assert.deepEqual([d.status, d.body], [200, 'got ']);

  assert.equal((await srv.call('/api/contraptions/fixture/service', { action: 'stop' })).status, 200);
  await stop(fixture);
  const d = await get();
  assert.equal(d.status, 502);
  assert.ok(d.ms < 1000, `a stopped app took ${d.ms} ms to fail`);

  // Started again: a GET while it boots waits for it (the proxy's retry), where a stopped one failed fast.
  assert.equal((await srv.call('/api/contraptions/fixture/service', { action: 'start' })).status, 200);
  const booting = get();
  await new Promise((r) => setTimeout(r, 500));
  fixture = await app(port);
  assert.deepEqual([(await booting).status, (await booting).body], [200, 'got ']);
  await stop(fixture);
});
