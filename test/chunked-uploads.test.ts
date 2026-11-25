// Big uploads in chunks (#832, src/chunked-uploads.ts): into the shared folder and into a contraption's DATA_DIR,
// resuming after a connection breaks off, refused under the free-disk floor. A real server (HOME moved to a temp
// folder, so a contraption's DATA_DIR is there too) and a stub contraption that records Citadel's "uploaded" call.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ChunkedUploads, CHUNK_SIZE } from '../src/chunked-uploads.ts';
import { verifyIdentity } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { bootServer, tempRoot, type Booted } from './helpers.ts';
import { until } from './wait.ts';

const DOMAIN = 'apps.test';
const APP = `stub.${DOMAIN}`;
const tmp = tempRoot('chunked-');
const root = tmp.dir;
const home = join(root, 'home');
let srv: Booted;
let port = 0;
let pub = '';
mkdirSync(join(root, 'data'), { recursive: true });
const seed = new Store(join(root, 'data', 'coordinator.db'));
const project = seed.createProject('Uploads', null).id;
const told: { login: string | null; body: unknown }[] = [];

const stub = createServer((req: IncomingMessage, res: ServerResponse) => {
  let text = '';
  req.on('data', (d) => (text += d));
  req.on('end', () => {
    if (req.url !== '/apps/stub/app-api/uploaded') return void res.writeHead(404).end();
    const identity = verifyIdentity(req.headers['x-citadel-identity'] as string | undefined, pub, 'stub');
    told.push({ login: identity?.login ?? null, body: JSON.parse(text) });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ imported: 1 }));
  });
});

/** The parts of the server's answers these tests read. */
type UpBody = { id: string; chunk: number; offset: number; size: number; done: boolean; path: string; app: unknown };
type Got = { status: number; body: UpBody };
/** A request to the server as `host`, with an optional body (fetch can't set Host). */
function ask(host: string, method: string, path: string, headers: Record<string, string>, body?: Buffer | string): Promise<Got> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode!, body: parsed as UpBody });
      });
    });
    r.on('error', reject);
    r.end(body);
  });
}

before(async () => {
  const stubPort = await tmp.serve(stub);
  srv = await bootServer({ root, env: { APPS_DOMAIN: DOMAIN, HOME: home, UPLOAD_FLOOR_GB: '0' } });
  port = Number(new URL(srv.base).port);
  const made = await srv.call('/api/contraptions', { name: 'stub', title: 'Stub', port: stubPort });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  pub = readFileSync(join(made.data.keys_dir, 'identity.pub'), 'utf8');
  const me = (await srv.call('/api/me')).data.id;
  assert.equal((await srv.call(`/api/contraptions/stub/people/${me}`, { enabled: true }, 'PUT')).status, 200);
});
after(async () => {
  await srv?.stop();
  await tmp.teardown();
});

test('a big file goes into the shared folder in chunks, resuming after a connection breaks off mid-chunk', async () => {
  const host = `127.0.0.1:${port}`;
  const base = `/api/projects/${project}/shared/uploads`;
  const cookie = { Cookie: srv.cookie };
  const data = randomBytes(2 * CHUNK_SIZE + 12345);
  const started = await ask(host, 'POST', base, { ...cookie, 'Content-Type': 'application/json' }, JSON.stringify({ name: 'trip.zip', size: data.length, folder: 'inbox/Trip' }));
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { id } = started.body;
  assert.equal(started.body.chunk, CHUNK_SIZE);
  const put = (offset: number, bytes: Buffer, h = cookie) => ask(host, 'PUT', `${base}/${id}?offset=${offset}`, h, bytes);

  assert.deepEqual((await put(0, data.subarray(0, CHUNK_SIZE))).body, { id, offset: CHUNK_SIZE, size: data.length });
  // A chunk sent again (its answer lost) is refused, and nothing doubles.
  assert.equal((await put(0, data.subarray(0, CHUNK_SIZE))).status, 409);
  // A chunk over the cap, or past the size it started with, keeps none of itself.
  assert.equal((await put(CHUNK_SIZE, randomBytes(17 * 1024 * 1024))).status, 413);
  assert.equal((await ask(host, 'GET', `${base}/${id}`, cookie)).body.offset, CHUNK_SIZE);

  // The next chunk breaks off halfway: what arrived stays, and the upload goes on from there.
  await new Promise<void>((resolve) => {
    const r = request({ host: '127.0.0.1', port, method: 'PUT', path: `${base}/${id}?offset=${CHUNK_SIZE}`, headers: { Host: host, ...cookie, 'Content-Length': String(CHUNK_SIZE) } });
    r.on('error', () => resolve());
    r.write(data.subarray(CHUNK_SIZE, CHUNK_SIZE + 1024 * 1024), () => setTimeout(() => (r.destroy(), resolve()), 300));
  });
  let at = CHUNK_SIZE;
  for (let i = 0; i < 50 && at === CHUNK_SIZE; i++) {
    await new Promise((r) => setTimeout(r, 50));
    at = (await ask(host, 'GET', `${base}/${id}`, cookie)).body.offset;
  }
  assert.ok(at > CHUNK_SIZE && at <= CHUNK_SIZE + 1024 * 1024, `resumes from ${at}`);
  // On like the kit's client: a 409 (the broken PUT still finishing) asks where it got to.
  let done: Got = { status: 0, body: {} as UpBody };
  const statuses: number[] = [];
  for (let i = 0; i < 100 && !done.body.done; i++) {
    done = await put(at, data.subarray(at, at + CHUNK_SIZE));
    statuses.push(done.status);
    if (done.status === 409) {
      await new Promise((r) => setTimeout(r, 20));
      at = (await ask(host, 'GET', `${base}/${id}`, cookie)).body.offset;
    } else {
      assert.equal(done.status, 200, `${statuses}: ${JSON.stringify(done.body)}`);
      at = done.body.offset;
    }
  }
  assert.equal(done.body.done, true);
  assert.equal(done.body.path, 'inbox/Trip/trip.zip');
  const shared = join(projectSharedDir(srv.data, project), 'inbox', 'Trip', 'trip.zip');
  assert.ok(readFileSync(shared).equals(data), 'the bytes as sent');
  // Finished, it's gone from the uploads under way.
  assert.equal((await ask(host, 'GET', `${base}/${id}`, cookie)).status, 404);
  // A second of the same name never overwrites the first.
  const again = await ask(host, 'POST', base, { ...cookie, 'Content-Type': 'application/json' }, JSON.stringify({ name: 'trip.zip', size: 3, folder: 'inbox/Trip' }));
  assert.equal((await ask(host, 'PUT', `${base}/${again.body.id}?offset=0`, cookie, 'abc')).body.path, 'inbox/Trip/trip (2).zip');
  // A folder can't climb or hide.
  for (const folder of ['..', '.git', 'a/b/c/d/e/f/g/h/i']) {
    assert.equal((await ask(host, 'POST', base, { ...cookie, 'Content-Type': 'application/json' }, JSON.stringify({ name: 'x', size: 1, folder }))).status, 400, folder);
  }
});

test("a contraption's page uploads into its DATA_DIR/uploads/<login>/, and Citadel tells the app as the uploader", async () => {
  // Signed in on the app's host through the real handoff from Citadel's.
  const header = (host: string, path: string, headers: Record<string, string>, name: string) =>
    new Promise<string>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path, headers: { Host: host, ...headers } }, (res) => (res.resume(), resolve(String(res.headers[name]))))
        .on('error', reject)
        .end();
    });
  const to = new URL(await header(`127.0.0.1:${port}`, '/apps/stub/', { Accept: 'text/html', Cookie: srv.cookie }, 'location'));
  const app = { Cookie: (await header(APP, to.pathname + to.search, {}, 'set-cookie')).split(';')[0] };
  const base = '/apps/_citadel/uploads/stub';
  const data = randomBytes(CHUNK_SIZE + 99);
  const started = await ask(APP, 'POST', base, { ...app, 'Content-Type': 'application/json' }, JSON.stringify({ name: 'IMG 0001.MOV', size: data.length, folder: 'Japan 2026' }));
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { id } = started.body;
  assert.equal((await ask(APP, 'PUT', `${base}/${id}?offset=0`, app, data.subarray(0, CHUNK_SIZE))).body.offset, CHUNK_SIZE);
  const done = await ask(APP, 'PUT', `${base}/${id}?offset=${CHUNK_SIZE}`, app, data.subarray(CHUNK_SIZE));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const login = told.at(-1)!.login!;
  assert.ok(login);
  assert.deepEqual(done.body.app, { status: 200, answer: { imported: 1 } });
  assert.equal(done.body.path, `uploads/${login}/Japan 2026/IMG 0001.MOV`);
  assert.deepEqual(told.at(-1)!.body, { path: done.body.path, name: 'IMG 0001.MOV', size: data.length, folder: 'Japan 2026' });
  assert.ok(readFileSync(join(home, '.local/share/stub', done.body.path)).equals(data));

  // Only on the app's own host, from its own pages, for its own uploads.
  assert.equal((await ask(`127.0.0.1:${port}`, 'POST', base, { Cookie: srv.cookie, 'Content-Type': 'application/json' }, '{"name":"x","size":1}')).status, 404);
  assert.equal((await ask(APP, 'POST', '/apps/_citadel/uploads/other', { ...app, 'Content-Type': 'application/json' }, '{"name":"x","size":1}')).status, 404);
  assert.equal((await ask(APP, 'POST', base, { ...app, Origin: 'http://evil.test', 'Content-Type': 'application/json' }, '{"name":"x","size":1}')).status, 403);
  assert.equal((await ask(APP, 'POST', base, { 'Content-Type': 'application/json' }, '{"name":"x","size":1}')).status, 401);
});

test('the free-disk floor counts what uploads under way still have to send; a stale upload is swept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chunked-unit-'));
  try {
    const c = new ChunkedUploads(dir, 100);
    c.free = async () => 150;
    const cara = { uid: 1, login: 'cara' };
    const target = { kind: 'shared', project: 1 } as const;
    await assert.rejects(c.start(cara, target, { name: 'big', size: 60 }), (e: Error & { status: number }) => e.status === 507 && /Not enough room/.test(e.message));
    const a = await c.start(cara, target, { name: 'a', size: 40 });
    // 150 free, 40 still owed by a: 20 more would leave 90, under the floor.
    await assert.rejects(c.start(cara, target, { name: 'b', size: 20 }), (e: Error & { status: number }) => e.status === 507);
    // Someone else's, or one for another place, is not found.
    await assert.rejects(c.status({ uid: 2, login: 'olive' }, target, a.id), (e: Error & { status: number }) => e.status === 404);
    await assert.rejects(c.status(cara, { kind: 'app', app: 'stub' }, a.id), (e: Error & { status: number }) => e.status === 404);
    // Down at the floor, chunks wait.
    c.free = async () => 99;
    await assert.rejects(
      c.put(cara, target, a.id, 0, [Buffer.from('x')], async () => ({})),
      (e: Error & { status: number }) => e.status === 507,
    );
    // Untouched for 3 days, it's given up at the next start, and no longer counted.
    const old = (Date.now() - 4 * 24 * 3600 * 1000) / 1000;
    utimesSync(join(dir, 'chunked', `${a.id}.part`), old, old);
    c.free = async () => 150;
    await c.start(cara, target, { name: 'b', size: 20 });
    assert.equal(existsSync(join(dir, 'chunked', `${a.id}.part`)), false);
    assert.equal(readdirSync(join(dir, 'chunked')).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the kit's client (ui/upload.js) pauses, resumes after a reload from where it got to, and cancels", async () => {
  // The page's globals, over the real server: fetch and an XMLHttpRequest that carry the session, and localStorage.
  const plain = globalThis.fetch;
  const withCookie = (o: RequestInit = {}) => ({ ...o, headers: { ...(o.headers as object), Cookie: srv.cookie } });
  const stored = new Map<string, string>();
  class Xhr {
    upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = '';
    #how = ['', ''];
    #stop = new AbortController();
    open(method: string, url: string) {
      this.#how = [method, url];
    }
    abort() {
      this.#stop.abort();
    }
    send(body: Blob) {
      plain(this.#how[1], withCookie({ method: this.#how[0], body, signal: this.#stop.signal })).then(
        async (r) => {
          this.status = r.status;
          this.responseText = await r.text();
          this.upload.onprogress?.({ loaded: body.size });
          this.onload?.();
        },
        () => (this.#stop.signal.aborted ? this.onabort : this.onerror)?.(),
      );
    }
  }
  Object.assign(globalThis, {
    fetch: (url: string, o?: RequestInit) => plain(url, withCookie(o)),
    XMLHttpRequest: Xhr,
    localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) },
  });
  try {
    const { startUpload } = await import('../public/ui/upload.js');
    const endpoint = `${srv.base}/api/projects/${project}/shared/uploads`;
    const data = randomBytes(2 * CHUNK_SIZE + 100);
    const file = new File([data], 'photos.bin', { lastModified: 1 });

    // Paused once the first chunk is in: it stays at that offset.
    const first = startUpload(endpoint, file, { folder: 'inbox/Kit', onChange: (u) => u.sent >= CHUNK_SIZE && u.pause() });
    await until('the upload to pause', async () => first.state === 'paused', 2000);
    assert.equal(first.state, 'paused');
    const id = JSON.parse([...stored.values()][0]).id;
    assert.equal((await ask(`127.0.0.1:${port}`, 'GET', `/api/projects/${project}/shared/uploads/${id}`, { Cookie: srv.cookie })).body.offset, CHUNK_SIZE);

    // A reload: a new client for the same file picks the upload up rather than starting another.
    const second = startUpload(endpoint, file, { folder: 'inbox/Kit' });
    const result = await second.done;
    assert.equal(result!.path, 'inbox/Kit/photos.bin');
    assert.equal(result!.size, data.length);
    assert.ok(readFileSync(join(projectSharedDir(srv.data, project), 'inbox/Kit/photos.bin')).equals(data));
    assert.deepEqual(readdirSync(join(projectSharedDir(srv.data, project), 'inbox/Kit')), ['photos.bin']);
    assert.equal(stored.size, 0, 'a finished upload is forgotten');

    // Cancelled: done answers null and the server lets it go.
    const third = startUpload(endpoint, new File([data], 'gone.bin'), { onChange: (u) => u.sent > 0 && u.cancel() });
    assert.equal(await third.done, null);
    await until('the chunked dir to empty', async () => !readdirSync(join(root, 'data', 'chunked')).length, 1000);
    assert.deepEqual(readdirSync(join(root, 'data', 'chunked')), []);
  } finally {
    Object.assign(globalThis, { fetch: plain, XMLHttpRequest: undefined, localStorage: undefined });
  }
});
