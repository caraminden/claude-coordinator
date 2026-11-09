// The artifact bridge (#168): an HTML page saves through the viewer that framed it, into a store kept per
// page on the server. The viewer answers only its own frames' sandboxed pages, the server only a person
// whose viewer opened the same file the frame shows, and agents read and write only their scheme's pages.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { cleanEntries, injectBridge, LIMITS, writeStore } from '../src/artifact-data.ts';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { readRequest, takeWrite, TAG } from '../public/bridge-host.js';
import { bootServer, PASSWORD, REPO, SECRET, type Booted } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'artifact-bridge-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

// Scheme A: a minion with two pages and a note, a Taskmaster, and a shared page. Scheme B: a page of its own.
const store = new Store(join(data, 'coordinator.db'));
const A = store.createProject('A', null);
const B = store.createProject('B', null);
function thread(projectId: number, kind: 'ticket' | 'coordinator', dir: string) {
  const t = store.createTicket({ project_id: projectId, kind, title: dir, permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, dir);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  return store.getTicket(t.id)!;
}
const M = thread(A.id, 'ticket', 'work');
const TA = thread(A.id, 'coordinator', 'tm');
const MB = thread(B.id, 'ticket', 'work-b');
writeFileSync(join(root, 'work', 'picker.html'), '<!DOCTYPE html><html><head><title>Picker</title></head><body>pick</body></html>');
writeFileSync(join(root, 'work', 'other.html'), '<p>other</p>');
writeFileSync(join(root, 'work', 'notes.md'), '# Notes');
writeFileSync(join(root, 'work-b', 'theirs.html'), '<p>theirs</p>');
const shared = projectSharedDir(data, A.id);
mkdirSync(shared, { recursive: true });
writeFileSync(join(shared, 'board.html'), '<p>board</p>');
store.syncArtifacts(M, ['picker.html', 'other.html', 'notes.md'].map((path) => ({ path, size: 1, mtime: 1 })));
store.syncArtifacts(MB, [{ path: 'theirs.html', size: 1, mtime: 1 }]);
const art = (p: string) => [...store.listArtifacts(A.id), ...store.listArtifacts(B.id)].find((a) => a.path === p)!;
const [PICKER, OTHER, NOTES, THEIRS] = ['picker.html', 'other.html', 'notes.md', 'theirs.html'].map(art);
for (const a of [PICKER, OTHER, NOTES, THEIRS]) store.setArtifactPinned(a.id, 'Cara');

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(() => srv?.stop()); // Send starts turns (CLAUDE_BIN is /bin/false): stop ends them too

/** The token path a person's viewer frames an artifact at, as the frame's page reports it. */
async function pageOf(id: number) {
  const res = await fetch(`${srv.base}/api/artifacts/${id}/raw`, { headers: { Cookie: srv.cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  return new URL(res.headers.get('location')!, `${srv.base}/api/artifacts/${id}/raw`).pathname.replace('/api/files/', '');
}
const bridge = (body: object, headers: Record<string, string> = { Cookie: srv.cookie }) =>
  fetch(`${srv.base}/api/artifact-data`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, data: await r.json() }));
const agent = (id: number, body: object) =>
  fetch(`${srv.base}/api/projects/${store.getTicket(id)!.project_id}/artifact-data`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.agentToken(id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

test('the bridge goes in after the doctype, or first, and what it inlines cannot close its script', () => {
  const cfg = (entries: any[] = []) => ({ page: 't1-0.x.y/p.html', entries });
  const html = (s: string) => injectBridge(Buffer.from(s), cfg([{ key: 'k', value: '</script><!-- \u2028', by: 'Cara', at: 1 }])).toString();
  const withDoctype = html('\uFEFF<!-- made by a tool -->\n<!doctype html><title>x</title>');
  assert.match(withDoctype, /^\uFEFF<!-- made by a tool -->\n<!doctype html><script>\(function \(cfg\)/);
  assert.match(withDoctype, /<\/script><title>x<\/title>$/);
  assert.match(html('<p>no head</p>'), /^<script>\(function \(cfg\)[\s\S]*<\/script><p>no head<\/p>$/);
  // Exactly one </script>: the value's own is escaped, and so are the line separators.
  const out = html('<p>x</p>');
  assert.equal(out.split('</script>').length, 2);
  assert.ok(!out.includes('\u2028') && out.includes('\\u003c/script>') && out.includes('\\u2028'));
});

test('writes are checked: key length, value size, entries per write, keys and bytes per page', () => {
  assert.throws(() => cleanEntries([]), /non-empty/);
  assert.throws(() => cleanEntries([{ key: 'x'.repeat(LIMITS.keyChars + 1), value: 1 }]), /1 to 200/);
  assert.throws(() => cleanEntries([{ key: 'a\0b', value: 1 }]), /1 to 200/);
  assert.throws(() => cleanEntries([{ key: 'big', value: 'x'.repeat(LIMITS.valueBytes) }]), /over 64 KB/);
  assert.throws(() => cleanEntries(Array.from({ length: LIMITS.entries + 1 }, (_, i) => ({ key: `k${i}`, value: i }))), /At most 100/);
  assert.deepEqual(cleanEntries([{ key: 'a', value: { pick: 2 } }, { key: 'b', value: null }, { key: 'c' }]), [
    { key: 'a', value: '{"pick":2}' }, { key: 'b', value: null }, { key: 'c', value: null },
  ]);
  const s = new Store(join(root, 'limits.db'));
  const p = s.createProject('L', null);
  for (let i = 0; i < LIMITS.keys; i += 100) writeStore(s, p.id, '/f.html', cleanEntries(Array.from({ length: 100 }, (_, j) => ({ key: `k${i + j}`, value: 1 }))), 'Cara');
  assert.throws(() => writeStore(s, p.id, '/f.html', cleanEntries([{ key: 'one-more', value: 1 }]), 'Cara'), /at most 2000 keys/);
  // Replacing and deleting keys is fine at the limit, and a refused write changes nothing.
  writeStore(s, p.id, '/f.html', cleanEntries([{ key: 'k0', value: 2 }, { key: 'k1', value: null }]), 'Cara');
  assert.equal(s.artifactData(p.id, '/f.html').length, LIMITS.keys - 1);
  const big = 'x'.repeat(60 * 1024);
  const fill = () => writeStore(s, p.id, '/g.html', cleanEntries(Array.from({ length: 40 }, (_, j) => ({ key: `b${j}`, value: big }))), 'Cara');
  assert.throws(fill, /at most 2 MB/);
  assert.equal(s.artifactData(p.id, '/g.html').length, 0);
});

test("the viewer answers only its own frames' sandboxed pages, with well-formed requests", () => {
  const win = {};
  const frame = { iframe: { isConnected: true, contentWindow: win } };
  const frames = new Set<any>([frame]);
  const msg = (data: any, over: object = {}) => readRequest({ source: win, origin: 'null', data: { bridge: TAG, id: 1, page: 'p', ...data }, ...over }, frames);
  assert.equal(msg({ op: 'hello' })?.frame, frame);
  assert.equal(msg({ op: 'hello' }, { source: {} }), null, 'another window');
  assert.equal(msg({ op: 'hello' }, { origin: srv.base }), null, 'a page with an origin (not sandboxed)');
  assert.equal(msg({ op: 'hello', bridge: 'other' }), null);
  assert.equal(msg({ op: 'hello', id: 'x' }), null);
  assert.equal(msg({ op: 'nonsense' }), null);
  assert.equal(msg({ op: 'write', entries: [] }), null);
  assert.equal(msg({ op: 'write', entries: Array(101).fill({ key: 'k' }) }), null);
  assert.equal(msg({ op: 'write', entries: [{ key: 'k', value: 1 }] })?.req.op, 'write');
  assert.equal(msg({ op: 'send', text: ' ' }), null);
  assert.equal(msg({ op: 'send', text: 'x'.repeat(10_001) }), null);
  assert.equal(msg({ op: 'send', text: 'Picks: 3' })?.req.text, 'Picks: 3');
  // A frame taken out of the page is forgotten.
  frame.iframe.isConnected = false;
  assert.equal(msg({ op: 'hello' }), null);
  assert.equal(frames.size, 0);
});

test('a frame writes in a burst of 40, then 20 a second', () => {
  const f: any = {};
  let n = 0;
  while (takeWrite(f, 1000)) n++;
  assert.equal(n, 40);
  assert.equal(takeWrite(f, 1000), false);
  n = 0;
  while (takeWrite(f, 2000)) n++;
  assert.equal(n, 20);
});

test('a served page carries the bridge and what it saved', async () => {
  const page = await pageOf(PICKER.id);
  const w = await bridge({ open: { artifact: PICKER.id }, page, op: 'write', entries: [{ key: 'db/picks/cleric', value: { pick: 3, note: '</script>' } }] });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.equal(w.data.person, 'Cara');
  assert.deepEqual(w.data.entries.map((e: any) => [e.key, e.value, e.by]), [['db/picks/cleric', { pick: 3, note: '</script>' }, 'Cara']]);
  const res = await fetch(`${srv.base}/api/files/${page}`);
  assert.match(res.headers.get('content-security-policy')!, /allow-downloads/);
  const text = await res.text();
  assert.match(text, /^<!DOCTYPE html><script>\(function \(cfg\)/);
  assert.ok(text.includes('"db/picks/cleric"') && text.includes('\\u003c/script>'));
  assert.ok(text.endsWith('<body>pick</body></html>'));
  // Downloads get the file as it is.
  assert.equal(await (await fetch(`${srv.base}/api/files/${page}?download`)).text(), '<!DOCTYPE html><html><head><title>Picker</title></head><body>pick</body></html>');
});

test('the server refuses a frame showing a different page from the one the viewer opened', async () => {
  const page = await pageOf(PICKER.id);
  const write = { op: 'write', entries: [{ key: 'x', value: 1 }] };
  // The frame moved on to another page of the same folder, or of another scheme.
  assert.equal((await bridge({ open: { artifact: PICKER.id }, page: await pageOf(OTHER.id), ...write })).status, 409);
  assert.equal((await bridge({ open: { artifact: THEIRS.id }, page, ...write })).status, 409);
  // A forged token, another folder's scope, a path out of the folder, nothing at all.
  const [token, rel] = page.split('/');
  const forged = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}/${rel}`;
  for (const p of [forged, page.replace(`t${M.id}-0`, `t${M.id}-2`), `${token}/../work/picker.html`, `${token}/%2e%2e/picker.html`, '', 'x', null]) {
    assert.equal((await bridge({ open: { artifact: PICKER.id }, page: p, ...write })).status, 409, String(p));
  }
  // What the viewer opened must be an HTML page that exists.
  assert.equal((await bridge({ open: { artifact: NOTES.id }, page, ...write })).status, 404);
  assert.equal((await bridge({ open: { artifact: 99999 }, page, ...write })).status, 404);
  assert.equal((await bridge({ open: { project: A.id, path: join(root, 'work', 'picker.html') }, page, ...write })).status, 404);
  assert.equal(store.artifactData(A.id, join(root, 'work', 'picker.html')).some((r) => r.key === 'x'), false);
  // A token that expired while the page stayed open still names its page.
  const expired = `${tokens.fileToken(`t${M.id}-0`, Date.now() - 13 * 3600_000)}/picker.html`;
  assert.equal((await bridge({ open: { ticket: M.id, path: 'picker.html' }, page: expired, op: 'list' })).status, 200);
  // Agents don't use this route, and a bad op or entry is refused.
  assert.equal((await bridge({ open: { artifact: PICKER.id }, page, op: 'list' }, { Authorization: `Bearer ${tokens.agentToken(M.id)}` })).status, 403);
  assert.equal((await bridge({ open: { artifact: PICKER.id }, page, op: 'drop' })).status, 400);
  assert.equal((await bridge({ open: { artifact: PICKER.id }, page, op: 'write', entries: [{ key: 'v', value: 'x'.repeat(70_000) }] })).status, 413);
});

test('a shared page saves under its own store, opened from the shared folder', async () => {
  const res = await fetch(`${srv.base}/api/projects/${A.id}/shared/file?path=board.html&raw=1`, { headers: { Cookie: srv.cookie }, redirect: 'manual' });
  const loc = res.headers.get('location');
  assert.ok(loc, `no redirect: ${res.status}`);
  const page = new URL(loc!, `${srv.base}/api/projects/${A.id}/shared/file`).pathname.replace('/api/files/', '');
  const w = await bridge({ open: { project: A.id, path: 'board.html' }, page, op: 'write', entries: [{ key: 'localStorage/zoom', value: '2' }] });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  const r = await agent(TA.id, { path: 'scheme shared/board.html' });
  assert.deepEqual(r.data.entries.map((e: any) => [e.key, e.value]), [['localStorage/zoom', '2']]);
});

test("agents read and write their scheme's pages, by artifact or path, and no other scheme's", async () => {
  const byId = await agent(M.id, { artifact: PICKER.id });
  assert.equal(byId.status, 200, JSON.stringify(byId.data));
  assert.ok(byId.data.entries.some((e: any) => e.key === 'db/picks/cleric'));
  const set = await agent(TA.id, { path: join(root, 'work', 'picker.html'), entries: [{ key: 'db/picks/rogue', value: { pick: 1 } }, { key: 'db/picks/cleric', value: null }] });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.deepEqual(set.data.entries.map((e: any) => [e.key, e.by]), [['db/picks/rogue', 'Taskmaster']]);
  const rel = await agent(M.id, { path: 'picker.html', entries: [{ key: 'storage/n', value: 5 }] });
  assert.deepEqual(rel.data.entries.find((e: any) => e.key === 'storage/n').by, `#${M.number}`);
  // Scheme B's page, by id and by path; a page that isn't HTML; a path out of every folder.
  assert.equal((await agent(M.id, { artifact: THEIRS.id })).status, 404);
  assert.equal((await agent(M.id, { path: join(root, 'work-b', 'theirs.html') })).status, 404);
  assert.equal((await agent(M.id, { path: 'notes.md' })).status, 404);
  assert.equal((await agent(M.id, { path: '../work-b/theirs.html' })).status, 404);
  assert.equal((await agent(MB.id, { path: join(root, 'work', 'picker.html') })).status, 404);
});

test('artifact_data is offered to minions and Taskmasters, and reads a page', async () => {
  const call = (role: string, msg: object, env: object = {}) => {
    const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], { env: { ...process.env, COORDINATOR_ROLE: role, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, ...msg }) + '\n');
    return reply.finally(() => child.kill());
  };
  for (const role of ['coordinator', 'thread']) {
    const names = (await call(role, { method: 'tools/list' })).result.tools.map((t: any) => t.name);
    assert.ok(names.includes('artifact_data'), role);
  }
  const { result } = await call('thread', { method: 'tools/call', params: { name: 'artifact_data', arguments: { artifact: PICKER.id } } }, {
    COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(M.id), COORDINATOR_PROJECT: String(A.id), COORDINATOR_TICKET: String(M.id),
  });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.match(result.content[0].text, /picker\.html: \d+ keys?\./);
  assert.match(result.content[0].text, /^db\/picks\/rogue = \{"pick":1\} \(Taskmaster, \d{4}-\d\d-\d\dT\d\d:\d\dZ\)$/m);
});

// These start turns on M and the Taskmaster, which retires the nonce-less agent tokens the tests above use: keep them last.
const sendPage = (body: object, headers: Record<string, string> = { Cookie: srv.cookie }) =>
  fetch(`${srv.base}/api/artifact-send`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, data: await r.json() }));
const lastMessage = (id: number) => store.listEvents(id).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data)).at(-1);
async function sharedPage(path: string) {
  const res = await fetch(`${srv.base}/api/projects/${A.id}/shared/file?path=${path}&raw=1`, { headers: { Cookie: srv.cookie }, redirect: 'manual' });
  return new URL(res.headers.get('location')!, `${srv.base}/api/projects/${A.id}/shared/file`).pathname.replace('/api/files/', '');
}

test("a page's Send posts its text as the person to the minion that showed it (#417)", async () => {
  const page = await pageOf(PICKER.id);
  const r = await sendPage({ open: { artifact: PICKER.id }, page, text: 'Picks on "Picker":\n- B: Picked' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.deepEqual(r.data.to, { id: M.id, kind: 'ticket', number: M.number, label: `#${M.number}` });
  assert.deepEqual(lastMessage(M.id), { author: 'Cara', text: 'Picks on "Picker":\n- B: Picked', comment: { path: join(root, 'work', 'picker.html'), about: 'picker.html' } });
  // Opened from the chat that linked it: that chat.
  assert.equal((await sendPage({ open: { ticket: M.id, path: 'picker.html' }, page, text: 'again' })).data.to.id, M.id);
});

test('a shared page sends to the minion that last linked it, else the Taskmaster', async () => {
  writeFileSync(join(shared, 'takes.html'), '<p>takes</p>');
  const page = await sharedPage('takes.html');
  const r = await sendPage({ open: { project: A.id, path: 'takes.html' }, page, text: 'A' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.to.label, 'the Taskmaster');
  assert.equal(lastMessage(TA.id).text, 'A');
  const linker = thread(A.id, 'ticket', 'work-linker');
  store.syncArtifacts(linker, [{ path: join(shared, 'takes.html'), size: 1, mtime: 1 }]);
  const again = await sendPage({ open: { project: A.id, path: 'takes.html' }, page, text: 'B' });
  assert.equal(again.data.to.id, linker.id);
  assert.deepEqual(lastMessage(linker.id), { author: 'Cara', text: 'B', comment: { path: join(shared, 'takes.html'), about: join(shared, 'takes.html') } });
});

test("a page's Send is refused for another page, an empty text, and anyone but a person", async () => {
  const page = await pageOf(PICKER.id);
  const before = store.listEvents(M.id).filter((e) => e.kind === 'user_message').length;
  assert.equal((await sendPage({ open: { artifact: PICKER.id }, page: await pageOf(OTHER.id), text: 'x' })).status, 409);
  assert.equal((await sendPage({ open: { artifact: THEIRS.id }, page, text: 'x' })).status, 409);
  assert.equal((await sendPage({ open: { artifact: NOTES.id }, page, text: 'x' })).status, 404);
  assert.equal((await sendPage({ open: { artifact: PICKER.id }, page, text: '  ' })).status, 400);
  assert.equal((await sendPage({ open: { artifact: PICKER.id }, page, text: 'x'.repeat(10_001) })).status, 400);
  assert.equal((await sendPage({ open: { artifact: PICKER.id }, page, text: 'x' }, { Authorization: `Bearer ${tokens.agentToken(MB.id)}` })).status, 403);
  assert.equal((await sendPage({ open: { artifact: PICKER.id }, page, text: 'x' }, {})).status, 401);
  assert.equal(store.listEvents(M.id).filter((e) => e.kind === 'user_message').length, before, 'nothing was sent');
});
