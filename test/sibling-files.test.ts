// An HTML artifact loads the files beside it (#144): a person's request for the page redirects to it
// under a file token, and the page's sandboxed frame, which sends no cookies, loads its siblings by
// relative path with that token, never leaving the token's one folder.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { agentToken, bootServer, PASSWORD, SECRET, type Booted } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'sibling-files-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

// A minion whose worktree holds a page, a video, styles, a script and a sub-page, plus ways out:
// a symlinked file and folder pointing outside, and a dotfile.
const store = new Store(join(data, 'coordinator.db'));
const P = store.createProject('A', null);
const created = store.createTicket({ project_id: P.id, kind: 'ticket', title: 'Videos', permission_mode: 'default', created_by: 'Cara' });
const work = join(root, 'work');
const outside = join(root, 'outside');
for (const d of [work, join(work, 'css'), join(work, 'sub'), join(work, '.scratch'), outside]) mkdirSync(d, { recursive: true });
store.setTicketDir(created.id, work, null);
const M = store.getTicket(created.id)!;
const TM = store.createTicket({ project_id: P.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Cara' });
mkdirSync(join(root, 'tm'));
store.setTicketDir(TM.id, join(root, 'tm'), null);
const clip = Buffer.alloc(1000, 7);
writeFileSync(join(work, 'page.html'), '<title>Test videos</title><link rel=stylesheet href="css/site.css"><video src="clip.mp4"></video>');
writeFileSync(join(work, 'clip.mp4'), clip);
writeFileSync(join(work, 'css', 'site.css'), 'body { color: red }');
writeFileSync(join(work, 'app.js'), 'console.log(1)');
writeFileSync(join(work, 'sub', 'page2.html'), '<p>two</p>');
writeFileSync(join(work, 'notes.md'), '# Notes');
writeFileSync(join(work, '.scratch', 'demo.html'), '<p>hidden</p>');
writeFileSync(join(work, '.env.json'), '{"secret":1}');
writeFileSync(join(work, 'main.ts'), 'export {}');
writeFileSync(join(outside, 'secret.txt'), 'outside the root');
symlinkSync(join(outside, 'secret.txt'), join(work, 'escape.txt'));
symlinkSync(outside, join(work, 'escdir'));
const shared = projectSharedDir(data, P.id);
mkdirSync(shared, { recursive: true });
writeFileSync(join(shared, 'gallery.html'), '<img src="pic.png">');
writeFileSync(join(shared, 'pic.png'), 'png');
// Pinned, so the startup scan keeps them listed.
// gone.md was shown once and has since been deleted.
store.syncArtifacts(M, [{ path: 'page.html', size: 1, mtime: 1 }, { path: 'notes.md', size: 1, mtime: 1 }, { path: 'gone.md', size: 1, mtime: 1 }]);
const [PAGE, NOTES, GONE] = ['page.html', 'notes.md', 'gone.md'].map((p) => store.listArtifacts(P.id).find((a) => a.path === p)!);
for (const a of [PAGE, NOTES, GONE]) store.setArtifactPinned(a.id, 'Cara');

let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(() => srv?.proc.kill());

const get = (path: string, headers: Record<string, string> = {}) => fetch(srv.base + path, { headers, redirect: 'manual' });
/** Where a redirect from `path` lands, as an absolute path. */
async function follow(path: string, headers: Record<string, string> = { Cookie: srv.cookie }) {
  const res = await get(path, headers);
  assert.equal(res.status, 302, `${path} should redirect`);
  return new URL(res.headers.get('location')!, srv.base + path).pathname;
}
/** A request sent as written, without the URL parser collapsing `..` and `%2e%2e`. */
const raw = (path: string) => new Promise<number>((resolve, reject) => {
  request({ host: '127.0.0.1', port: srv.port, path }, (res) => (res.resume(), resolve(res.statusCode!))).on('error', reject).end();
});

test("a person's request for an HTML artifact goes to it under a file token; the frame loads it with no cookie", async () => {
  const page = await follow(`/api/artifacts/${PAGE.id}/raw?v=1`);
  assert.match(page, new RegExp(`^/api/files/t${M.id}-0\\.[a-z0-9]+\\.[\\w-]+/page\\.html$`));
  const res = await get(page);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy')!, /^sandbox allow-scripts /);
  assert.match(await res.text(), /<video src="clip.mp4">/);
});

test('siblings load by relative path, and videos seek', async () => {
  const page = await follow(`/api/artifacts/${PAGE.id}/raw`);
  const at = (rel: string) => new URL(rel, srv.base + page).pathname;
  const part = await get(at('clip.mp4'), { Range: 'bytes=10-19' });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal(part.headers.get('access-control-allow-origin'), '*');
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal((await get(at('clip.mp4'), { Range: 'bytes=5000-' })).status, 416);
  const css = await get(at('css/site.css'));
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await get(at('app.js'))).headers.get('content-type'), 'text/javascript; charset=utf-8');
  // A linked page is sandboxed too, and links back up with ../.
  const two = at('sub/page2.html');
  assert.match((await get(two)).headers.get('content-security-policy')!, /^sandbox /);
  assert.equal((await get(new URL('../clip.mp4', srv.base + two).pathname)).status, 200);
});

test('the token reads nothing outside its folder: symlinks, dotfiles, .., encoded slashes, source files', async () => {
  const page = await follow(`/api/artifacts/${PAGE.id}/raw`);
  const token = page.split('/')[3];
  const base = `/api/files/${token}`;
  for (const rel of ['escape.txt', 'escdir/secret.txt', '.env.json', 'main.ts', 'sub%2F..%2Fpage.html', 'sub%2f..%2f..%2foutside%2fsecret.txt', 'sub/%5c..%5cpage.html', 'nothing.mp4']) {
    const res = await get(`${base}/${rel}`);
    assert.equal(res.status, 404, rel);
    // A page's fetch() sees the 404 rather than a CORS failure.
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  }
  // Sent raw, .. and %2e%2e collapse before routing, and can't climb past the token's folder.
  for (const rel of ['%2e%2e', '../../outside/secret.txt', '%2e%2e/%2e%2e/outside/secret.txt', 'sub/../../../../etc/passwd', '../escape.txt']) {
    assert.notEqual(await raw(`${base}/${rel}`), 200, rel);
  }
  assert.equal(await raw(`${base}/sub/../clip.mp4`), 200);
});

test('a forged or expired token is refused, unless a signed-in person reopens it', async () => {
  const page = await follow(`/api/artifacts/${PAGE.id}/raw`);
  const [, , , token] = page.split('/');
  const forged = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
  assert.equal((await get(`/api/files/${forged}/clip.mp4`)).status, 403);
  // Without a login a bad token says nothing about which minions exist.
  assert.equal((await get('/api/files/t999-0.zzzzzz.forged/clip.mp4')).status, 403);
  // Signing another folder's scope needs the secret.
  assert.equal((await get(`/api/files/${token.replace(`t${M.id}-0`, `t${M.id}-2`)}/gallery.html`)).status, 403);
  const tokens = new Auth(PASSWORD, SECRET);
  const expired = tokens.fileToken(`t${M.id}-0`, Date.now() - 13 * 3600_000);
  assert.equal((await get(`/api/files/${expired}/sub/page2.html`)).status, 403);
  // A minion's bearer token doesn't renew one either.
  assert.equal((await get(`/api/files/${expired}/sub/page2.html`, { Authorization: `Bearer ${agentToken(data, M.id)}` })).status, 403);
  const renewed = await follow(`/api/files/${expired}/sub/page2.html`);
  assert.match(renewed, new RegExp(`^/api/files/t${M.id}-0\\.[a-z0-9]+\\.[\\w-]+/sub/page2\\.html$`));
  const again = await get(`/api/files/${expired}/clip.mp4?download`, { Cookie: srv.cookie });
  assert.match(again.headers.get('location')!, /^\.\.\/t\d+-0\.[^/]+\/clip\.mp4\?download$/);
  assert.equal((await get(renewed)).status, 200);
  // A scope that names nothing is a 404, signed or not.
  assert.equal((await get(`/api/files/${tokens.fileToken('t999-0')}/page.html`)).status, 404);
  assert.equal((await get(`/api/files/${tokens.fileToken(`t${M.id}-0`)}/page.html`)).status, 200);
});

test('scheme shared files and reply links redirect the same way; downloads, other kinds and minions get the file', async () => {
  const gallery = await follow(`/api/projects/${P.id}/shared/file?path=gallery.html`);
  assert.match(gallery, new RegExp(`^/api/files/p${P.id}\\.[^/]+/gallery\\.html$`));
  assert.equal((await get(new URL('pic.png', srv.base + gallery).pathname)).status, 200);
  assert.match(await follow(`/api/tickets/${M.id}/file?path=sub/page2.html`), /^\/api\/files\/t\d+-0\.[^/]+\/sub\/page2\.html$/);
  const download = await get(`/api/artifacts/${PAGE.id}/raw?download`, { Cookie: srv.cookie });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition')!, /^attachment/);
  assert.equal((await get(`/api/artifacts/${NOTES.id}/raw`, { Cookie: srv.cookie })).status, 200);
  // The Taskmaster reads the page itself, not a redirect it can't follow with its token.
  const asTaskmaster = await get(`/api/tickets/${M.id}/file?path=page.html`, { Authorization: `Bearer ${agentToken(data, TM.id)}` });
  assert.equal(asTaskmaster.status, 200);
  assert.match(await asTaskmaster.text(), /Test videos/);
  // A page under a hidden folder opens as before, without a token (its siblings can't load).
  const hidden = await get(`/api/tickets/${M.id}/file?path=.scratch/demo.html`, { Cookie: srv.cookie });
  assert.equal(hidden.status, 200);
  assert.match(await hidden.text(), /hidden/);
  // Without a login the old routes still refuse.
  assert.equal((await get(`/api/artifacts/${PAGE.id}/raw`)).status, 401);
});

test("the viewer's details of a linked or shared file load, and a file that's gone is a 404 that says so (#157)", async () => {
  const headers = { Cookie: srv.cookie };
  const linked = await get(`/api/tickets/${M.id}/file?path=clip.mp4&info`, headers);
  assert.equal(linked.status, 200);
  assert.equal((await linked.json()).name, 'clip.mp4');
  const inShared = await get('/api/projects/' + P.id + '/shared/file?path=pic.png&info', headers);
  assert.equal(inShared.status, 200);
  assert.equal((await inShared.json()).kind, 'image');
  for (const path of [`/api/tickets/${M.id}/file?path=gone.md&info`, `/api/projects/${P.id}/shared/file?path=gone.md&info`, `/api/artifacts/${GONE.id}/raw`]) {
    const res = await get(path, headers);
    assert.equal(res.status, 404, path);
    assert.match((await res.json()).error, /no longer there/, path);
  }
});
