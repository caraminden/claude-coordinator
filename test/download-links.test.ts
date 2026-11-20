// #1184: with "Open links in Firefox" on, a download goes to Firefox, which has no Citadel login. The page asks for a
// short-lived link to the one file; the link serves exactly that file, with no cookie, until it expires.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { DownloadLinks, downloadTarget } from '../src/download-links.ts';
import { bootServer, type Booted } from './helpers.ts';

const TTL = 3000;
const root = mkdtempSync(join(tmpdir(), 'download-links-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
const store = new Store(join(data, 'coordinator.db'));
const P = store.createProject('A', null);
const T = store.createTicket({ project_id: P.id, kind: 'ticket', title: 'Builds', permission_mode: 'default', created_by: 'Cara' });
const work = join(root, 'work');
mkdirSync(work, { recursive: true });
store.setTicketDir(T.id, work, null);
writeFileSync(join(work, 'a.zip'), 'the a file');
writeFileSync(join(work, 'b.zip'), 'the b file');

let srv: Booted;
before(async () => {
  srv = await bootServer({ root, env: { DOWNLOAD_LINK_MS: String(TTL) } });
});
after(async () => {
  await srv?.stop();
  rmSync(root, { recursive: true, force: true });
});

const mint = (path: unknown, cookie: string | null = srv.cookie) => fetch(`${srv.base}/c/api/download-links`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ path }),
});
/** Firefox's request: no cookie. */
const open = (path: string, method = 'GET') => fetch(srv.base + path, { method, redirect: 'manual' });

test('a link serves exactly its one file, with no login, as a download', async () => {
  const res = await mint(`/c/api/tickets/${T.id}/file?path=a.zip&v=1&download`);
  assert.equal(res.status, 200);
  const { path } = await res.json();
  assert.match(path, /^\/c\/api\/dl\/[\w-]{32}$/, 'keeps the page\'s /c/ prefix');
  const got = await open(path);
  assert.equal(got.status, 200);
  assert.equal(await got.text(), 'the a file');
  assert.match(got.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''a\.zip$/);
  assert.equal(await (await open(path)).text(), 'the a file', 'Firefox may ask again inside the window');
  // The link names its file: a query on the link can't point it anywhere else.
  assert.equal(await (await open(`${path}?path=b.zip`)).text(), 'the a file');
  assert.equal((await open(path, 'POST')).status, 410, 'GET only');
});

test('only a signed-in person can make one, and only to a file route', async () => {
  assert.equal((await mint(`/api/tickets/${T.id}/file?path=a.zip`, null)).status, 401);
  for (const bad of ['/api/projects', `/api/tickets/${T.id}`, `/api/tickets/${T.id}/file/../../people`, '/api/download-links', 'https://example.com/api/artifacts/1/raw', '/apps/mandate/android/x.apk', 42, null]) {
    assert.equal((await mint(bad)).status, 400, String(bad));
  }
  // A file the person can't reach is checked when Firefox asks, by the file's own route.
  const { path } = await (await mint(`/api/tickets/${T.id}/file?path=missing.zip`)).json();
  assert.equal((await open(path)).status, 404);
});

test('a link stops working once it expires, and an unknown one never works', async () => {
  const { path } = await (await mint(`/api/tickets/${T.id}/file?path=b.zip`)).json();
  assert.match(path, /^\/api\/dl\//);
  assert.equal(await (await open(path)).text(), 'the b file');
  await new Promise((r) => setTimeout(r, TTL + 200));
  const gone = await open(path);
  assert.equal(gone.status, 410);
  assert.match((await gone.json()).error, /expired/);
  assert.equal((await open(`/api/dl/${'x'.repeat(32)}`)).status, 410);
});

test('downloadTarget keeps the prefix, asks for a download, and refuses anything but a file route', () => {
  assert.deepEqual(downloadTarget('/preview/7/api/artifacts/3/raw?v=2'), { prefix: '/preview/7', path: '/api/artifacts/3/raw?v=2&download=' });
  assert.deepEqual(downloadTarget('/api/projects/2/shared/file?path=x.zip&download'), { prefix: '', path: '/api/projects/2/shared/file?path=x.zip&download=' });
  assert.deepEqual(downloadTarget('/api/projects/2/ci-files/4/app.apk'), { prefix: '', path: '/api/projects/2/ci-files/4/app.apk?download=' });
  assert.deepEqual(downloadTarget('/api/tickets/5/uploads/a.bin'), { prefix: '', path: '/api/tickets/5/uploads/a.bin?download=' });
  assert.deepEqual(downloadTarget('/api/tickets/5/x/../file?path=a'), { prefix: '', path: '/api/tickets/5/file?path=a&download=' }, 'judged after `..` folds');
  for (const bad of ['/api/artifacts/3/raw/../../people', '/x/api/artifacts/3/raw', 'api/artifacts/3/raw', '/api/dl/abc', '/api/tickets/5/uploads/a/b', `/api/artifacts/3/raw?${'a'.repeat(5000)}`]) assert.equal(downloadTarget(bad), null, bad);
});

test('DownloadLinks: a token works until its time is up, then never again', () => {
  const links = new DownloadLinks(1000);
  const t = links.mint(7, '/api/artifacts/3/raw?download=', 0);
  assert.match(t, /^[\w-]{32}$/);
  assert.equal(DownloadLinks.token(`/api/dl/${t}`), t);
  assert.equal(DownloadLinks.token(`/api/dl/${t}/x`), null);
  assert.deepEqual(links.redeem(t, 999), { uid: 7, path: '/api/artifacts/3/raw?download=' });
  assert.equal(links.redeem(t, 1000), null);
  assert.equal(links.redeem(t, 0), null, 'gone for good once expired');
  assert.notEqual(links.mint(7, '/x', 0), links.mint(7, '/x', 0));
});
