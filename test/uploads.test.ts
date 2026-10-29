import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promptMessage } from '../src/runner.ts';
import { isUploadName, safeFileName, saveUpload, UploadTooLarge } from '../src/uploads.ts';
import { agentToken, bootServer } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'uploads-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

async function* chunks(...parts: string[]) {
  for (const p of parts) yield Buffer.from(p);
}

test('names keep their look but cannot leave the folder, hide, look like a flag or break a link', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\art\\hero.psd'), 'hero.psd');
  assert.equal(safeFileName('.bashrc'), 'bashrc');
  assert.equal(safeFileName('-rf hero.png'), 'rf hero.png');
  assert.equal(safeFileName('Héro sprite [v2].aseprite'), 'Héro sprite _v2_.aseprite');
  assert.equal(safeFileName('it\'s $(x).zip'), 'it_s _(x).zip');
  assert.equal(safeFileName('..'), 'file');
  assert.equal(safeFileName(''), 'file');
  const long = safeFileName('x'.repeat(300) + '.kra');
  assert.equal(long.length, 150);
  assert.ok(long.endsWith('.kra'));
  // Cut by letter, not UTF-16 unit, so a long name of rare letters still reads back as a valid name.
  const astral = safeFileName('𠀀'.repeat(200) + '.png');
  assert.equal(Array.from(astral).length, 150);
  assert.ok(isUploadName(astral));
  for (const ok of ['hero.png', 'Héro sprite _v2_.aseprite', 'sprite (2).png', long.slice(0, -4) + ' (2).kra']) assert.ok(isUploadName(ok), ok);
  for (const bad of ['', '.', '..', '../x', 'a/b', '.hidden', '-x', 'a\0b', 'a[1].png']) assert.ok(!isUploadName(bad), bad);
});

test('an upload never overwrites, and one over the cap leaves nothing behind', async () => {
  const dir = join(root, 'unit');
  const a = await saveUpload(dir, 'sprite.png', chunks('one'));
  const b = await saveUpload(dir, 'sprite.png', chunks('two', 'more'));
  assert.deepEqual([a.name, b.name, b.size], ['sprite.png', 'sprite (2).png', 7]);
  assert.equal(readFileSync(a.path, 'utf8'), 'one');
  await assert.rejects(saveUpload(dir, 'big.zip', chunks('12345', '67890'), 8), UploadTooLarge);
  assert.deepEqual(readdirSync(dir).sort(), ['sprite (2).png', 'sprite.png']);
});

test('Claude is told where each attached file is, its size and type', () => {
  const line = JSON.parse(promptMessage([{ author: 'Cara', text: '', images: [], files: [{ name: 'art.zip', path: '/data/shared/9/uploads/art.zip', size: 5 * 1024 * 1024, type: 'application/zip' }] }]));
  const text = line.message.content.map((c: any) => c.text).join('\n');
  assert.match(text, /^\[Cara\]: \(sent a file\)/);
  assert.match(text, /- \/data\/shared\/9\/uploads\/art\.zip \(5\.0 MB, application\/zip\)/);
});

let base = '';
let cookie = '';

before(async () => {
  const srv = await bootServer({ root, stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
});

const call = (path: string, init: RequestInit & { as?: number } = {}) =>
  fetch(base + path, { ...init, headers: { ...(init.as === undefined ? { Cookie: cookie } : { Authorization: `Bearer ${agentToken(join(root, 'data'), init.as)}` }), ...init.headers } });
const postJson = (path: string, body: unknown) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('people attach a file: it streams into the files folder, the message names it, and it downloads without rendering', async () => {
  const p = await (await postJson('/api/projects', { name: 'Scheme' })).json();
  const minion = await (await postJson(`/api/projects/${p.id}/tickets`, { message: 'hi' })).json();
  const page = await (await call(`/api/projects/${p.id}`)).json();
  const folder = join(root, 'data', 'projects', String(p.id), 'shared', String(minion.id), 'uploads');

  const put = (id: number, name: string, body: string, as?: number) => call(`/api/tickets/${id}/uploads?name=${encodeURIComponent(name)}`, { method: 'PUT', body, as });
  const html = await put(minion.id, 'page.html', '<script>alert(1)</script>');
  assert.equal(html.status, 201);
  assert.deepEqual(await html.json(), { name: 'page.html', size: 25 });
  const png = await (await put(minion.id, '../hero.png', 'not really a png')).json();
  assert.equal(png.name, 'hero.png');
  assert.ok(existsSync(join(folder, 'hero.png')));
  // The Taskmaster's chat takes files too, into its own folder.
  assert.equal((await put(page.coordinator.id, 'brief.pdf', '%PDF')).status, 201);
  assert.ok(existsSync(join(root, 'data', 'projects', String(p.id), 'shared', String(page.coordinator.id), 'uploads', 'brief.pdf')));
  // Only people upload, and only under the cap.
  assert.equal((await put(minion.id, 'x.txt', 'x', minion.id)).status, 403);
  // Refused from its Content-Length, before any of the body is read.
  const big = await new Promise<number>((resolve, reject) => {
    const req = request(`${base}/api/tickets/${minion.id}/uploads?name=big.zip`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Length': 201 * 1024 * 1024 } }, (res) => resolve(res.statusCode!));
    req.on('error', reject);
    req.flushHeaders();
  });
  assert.equal(big, 413);
  assert.ok(!existsSync(join(folder, 'big.zip')));

  const get = (name: string) => call(`/api/tickets/${minion.id}/uploads/${encodeURIComponent(name)}`);
  const dl = await get('page.html');
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.match(dl.headers.get('content-disposition')!, /^attachment; filename\*=UTF-8''page\.html$/);
  assert.match(dl.headers.get('content-security-policy')!, /^sandbox/);
  assert.equal(await dl.text(), '<script>alert(1)</script>');
  const img = await get('hero.png');
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('content-disposition'), null);
  const part = await call(`/api/tickets/${minion.id}/uploads/hero.png`, { headers: { Range: 'bytes=4-6' } });
  assert.deepEqual([part.status, await part.text()], [206, 'rea']);
  for (const bad of ['..%2F..%2Fcoordinator.db', '.hidden', 'missing.zip']) assert.equal((await call(`/api/tickets/${minion.id}/uploads/${bad}`)).status, 404, bad);
  // Linked as a file of the thread, an uploaded page still only downloads.
  const linked = await call(`/api/tickets/${minion.id}/file?path=${encodeURIComponent(join(folder, 'page.html'))}`);
  assert.equal(linked.status, 200);
  assert.match(linked.headers.get('content-disposition') ?? '', /^attachment/);

  const sent = await postJson(`/api/tickets/${minion.id}/messages`, { text: '', files: [{ name: 'page.html', type: 'text/html' }, { name: 'hero.png', type: 'evil type' }] });
  assert.equal(sent.status, 202, await sent.clone().text());
  const events = await (await call(`/api/tickets/${minion.id}/events?after=0`)).json();
  const msg = events.map((e: any) => ({ ...e, data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data })).filter((e: any) => e.kind === 'user_message').pop();
  assert.deepEqual(msg.data.files, [{ name: 'page.html', size: 25, type: 'text/html' }, { name: 'hero.png', size: 16, type: 'application/octet-stream' }]);
  assert.equal((await postJson(`/api/tickets/${minion.id}/messages`, { text: 'x', files: [{ name: 'gone.zip' }] })).status, 400);
  assert.equal((await postJson(`/api/tickets/${minion.id}/messages`, { text: 'x', files: [{ name: '../../coordinator.db' }] })).status, 400);
});
