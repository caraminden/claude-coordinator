// A page left open while its app restarts (#1376): a browser EventSource behind the proxy picks its stream back up
// by itself, even when the app is down longer than the proxy waits, and a page load while it's down gets the
// friendly down page, not a bare 502. The EventSource is Node's own (undici's, the WHATWG one, behind a flag), run in
// a child process, so the test proves what a browser does with the proxy's answers rather than assuming it.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { appDown } from '../src/apps.ts';
import { forward } from '../src/proxy.ts';
import { bootServer, fakeSystemd, tempRoot, until, type Booted } from './helpers.ts';

const tmp = tempRoot('app-restart-stream-');
const root = tmp.dir;
const rebound: Server[] = []; // an app that comes back on the port it had: the one thing tmp.serve (port 0) can't do
let srv: Booted | undefined;
after(async () => {
  for (const s of rebound) {
    s.closeAllConnections();
    s.close();
  }
  await srv?.stop();
  await tmp.teardown();
});

const listen = (s: Server, port: number) => new Promise<Server>((ok) => s.listen(port, '127.0.0.1', () => ok(s)));

/** The fake app: /x is an event stream that says which run of the app it is, then stays open. */
function appServer(run: number): Server {
  return createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write(`data: run ${run}\n\n`);
  });
}

/** Citadel's side, with a short stream hold so the test also sees the "come back" answer. */
/** Returns the port it listens on. */
async function front(appPort: number, failed: string[] = []) {
  const s = createServer((req, res) => forward(req, res, appPort, '/x', { ...req.headers }, { what: 'App', retryMs: 300, streamHoldMs: 1000, failed: (st, note) => failed.push(`${st} ${note ?? ''}`) }));
  return tmp.serve(s);
}

test('an EventSource open across an app restart longer than the hold reconnects and gets the new run, never closing for good', async () => {
  const first = appServer(1);
  const appPort = await tmp.serve(first);
  const failed: string[] = [];
  const proxyPort = await front(appPort, failed);
  const url = `http://127.0.0.1:${proxyPort}/x`;
  // The interval keeps the child alive while it waits to reconnect, as an open tab is (undici's wait doesn't).
  const script = `setInterval(() => {}, 1000);
const es = new EventSource(${JSON.stringify(url)});
es.onopen = () => console.log('open');
es.onmessage = (e) => console.log('message ' + e.data);
es.onerror = () => console.log('error ' + es.readyState);`;
  const child = tmp.spawn(process.execPath, ['--experimental-eventsource', '--no-warnings', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines: string[] = [];
  child.stdout!.setEncoding('utf8').on('data', (d: string) => lines.push(...d.split('\n').filter(Boolean)));
  await until('the first run\'s event', () => lines.includes('message run 1'), 10_000);

  // The app goes away mid-stream (a deploy, a crash), for longer than the proxy holds a stream's request.
  first.closeAllConnections();
  await new Promise<void>((ok) => first.close(() => ok()));
  await until('the proxy to tell the stream to come back', () => lines.filter((l) => l === 'open').length >= 2, 15_000, () => lines.join(' | '));
  rebound.push(await listen(appServer(2), appPort));
  await until('the second run\'s event', () => lines.includes('message run 2'), 15_000);

  // readyState 2 is CLOSED: what a 502 does to an EventSource, which then never asks again.
  assert.deepEqual(lines.filter((l) => l === 'error 2'), [], lines.join('\n'));
  assert.deepEqual(failed, [], 'a stream told to come back is nobody\'s error');
});

test('a stream to an app that is down gets an empty 200 stream with retry once the hold is up, not a 502', async () => {
  const proxyPort = await front(await tmp.down());
  const t = Date.now();
  const res = await fetch(`http://127.0.0.1:${proxyPort}/x`, { headers: { Accept: 'text/event-stream' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(await res.text(), 'retry: 3000\n\n');
  assert.ok(Date.now() - t >= 900, 'it waited out the hold first');
});

test('a stream to an app still warming up (it answers 503) is told to come back too, and the 503 is counted', async () => {
  const warming = createServer((req, res) => res.writeHead(503, { 'Content-Type': 'text/plain' }).end('warming up'));
  const appPort = await tmp.serve(warming);
  const failed: string[] = [];
  const proxyPort = await front(appPort, failed);
  const res = await fetch(`http://127.0.0.1:${proxyPort}/x`, { headers: { Accept: 'text/event-stream' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'retry: 3000\n\n');
  assert.deepEqual(failed, ['503 ']);
});

test('the down page: the kit\'s look, Retry, Back, and it checks again by itself', () => {
  const html = appDown('Peek <Auras>', 'https://citadel.example');
  assert.match(html, /<link rel="stylesheet" href="\/apps\/_citadel\/theme\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/apps\/_citadel\/ui\/base\.css">/);
  assert.match(html, /Can't reach Peek &#60;Auras&#62;/);
  assert.match(html, /class="cui-btn cui-primary" id="retry">Retry</);
  assert.match(html, /location\.href='https:\/\/citadel\.example\/c\/'/);
  assert.match(html, /setTimeout\(check,d\)/);
  assert.match(html, /'X-Citadel-Down-Check':'1'/);
});

test('through Citadel: a page load of an app that isn\'t answering gets the down page, a script\'s fetch still a 502', async () => {
  const fake = fakeSystemd(join(root, 'systemd'));
  const home = join(root, 'home');
  const units = join(home, '.config', 'systemd', 'user');
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, 'citadel-app-fixture.service'), '# Written by Citadel for contraption fixture.\n');
  srv = await bootServer({ root, env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), CITADEL_SYSTEMCTL: fake.bin, CITADEL_JOURNALCTL: fake.journal } });
  const port = await tmp.down();
  assert.equal((await srv.call('/api/contraptions', { name: 'fixture', title: 'Fixture', port })).status, 201);
  const me = (await srv.call('/api/me')).data.id;
  assert.equal((await srv.call(`/api/contraptions/fixture/people/${me}`, { enabled: true }, 'PUT')).status, 200);
  // Stopped on purpose first, so the proxy's 5 s retry is skipped and the answer comes at once.
  assert.equal((await srv.call('/api/contraptions/fixture/service', { action: 'stop' })).status, 200);
  const get = (accept: string, extra: Record<string, string> = {}) => fetch(`${srv!.base}/apps/fixture/`, { headers: { Cookie: srv!.cookie, Accept: accept, Connection: 'close', ...extra } });
  // The down page's own check comes first: it gets the 502 that keeps it waiting, and isn't counted in the error digest.
  const check = await fetch(`${srv.base}/apps/fixture/`, { method: 'HEAD', headers: { Cookie: srv.cookie, 'X-Citadel-Down-Check': '1', Connection: 'close' } });
  assert.equal(check.status, 502);
  const page = await get('text/html,application/xhtml+xml,*/*;q=0.8');
  assert.equal(page.status, 503);
  assert.equal(page.headers.get('retry-after'), '5');
  const body = await page.text();
  assert.match(body, /Can't reach Fixture/);
  assert.match(body, /id="retry">Retry</);
  const script = await get('*/*');
  assert.equal(script.status, 502);
  assert.equal(await script.text(), 'Fixture is not answering');
  // The digest's writes go through one worker in order, so once the later two are in, the check would be too.
  const rows = () => {
    const db = new DatabaseSync(join(srv!.data, 'coordinator.db'), { readOnly: true, timeout: 30_000 });
    try {
      return db.prepare("SELECT key, count FROM contraption_errors WHERE kind = 'http'").all().map((r) => ({ ...r }));
    } finally {
      db.close();
    }
  };
  await until('the page load and the fetch counted', () => rows().reduce((n, r) => n + Number(r.count), 0) >= 2);
  assert.deepEqual(rows(), [{ key: '502 GET /apps/fixture/ (not answering: ECONNRESET)', count: 2 }]);
});
