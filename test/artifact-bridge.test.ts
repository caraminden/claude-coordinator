// The artifact bridge (#168): an HTML page saves through the viewer that framed it, into a store kept per
// page on the server. The viewer answers only its own frames' sandboxed pages, the server only a person
// whose viewer opened the same file the frame shows, and agents read and write only their scheme's pages.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { cleanEntries, injectBridge, linkPageText, LIMITS, writeStore } from '../src/artifact-data.ts';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { attachBridge, bridgeTypedAt, bridgeUnsaved, onArtifactData, ownPicture, readRequest, takeWrite, TAG } from '../public/bridge-host.js';
import { bootServer, PASSWORD, SECRET, tempRoot, type Booted } from './helpers.ts';
import { mcpOnce } from './mcp-agent.ts';
import { json } from './typed.ts';

// The parts of the API's answers these tests read.
type Entry = { key: string; value?: unknown; by?: string };
type Posted = { bridge?: string; op?: string; ok?: boolean; retry?: boolean; entries?: Entry[] };
type Answer = { person: string; entries: Entry[]; error: string; id: string; to: { id: number; label: string } };

const tmp = tempRoot('artifact-bridge-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });

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
store.syncArtifacts(
  M,
  ['picker.html', 'other.html', 'notes.md'].map((path) => ({ path, size: 1, mtime: 1 })),
);
store.syncArtifacts(MB, [{ path: 'theirs.html', size: 1, mtime: 1 }]);
const art = (p: string) => [...store.listArtifacts(A.id), ...store.listArtifacts(B.id)].find((a) => a.path === p)!;
const [PICKER, OTHER, NOTES, THEIRS] = ['picker.html', 'other.html', 'notes.md', 'theirs.html'].map(art);
for (const a of [PICKER, OTHER, NOTES, THEIRS]) store.setArtifactPinned(a.id, 'Cara');

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(async () => {
  await srv?.stop(); // ends the server and its turns before the folder goes (#218)
  await tmp.teardown();
});

/** The token path a person's viewer frames an artifact at, as the frame's page reports it. */
async function pageOf(id: number) {
  const res = await fetch(`${srv.base}/api/artifacts/${id}/raw`, { headers: { Cookie: srv.cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  return new URL(res.headers.get('location')!, `${srv.base}/api/artifacts/${id}/raw`).pathname.replace('/api/files/', '');
}
const bridge = (body: object, headers: Record<string, string> = { Cookie: srv.cookie }) => fetch(`${srv.base}/api/artifact-data`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await json<Answer>(r) }));
const agent = (id: number, body: object) =>
  fetch(`${srv.base}/api/projects/${store.getTicket(id)!.project_id}/artifact-data`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.agentToken(id)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await json<Answer>(r) }));

test('the bridge goes in after the doctype, or first, and what it inlines cannot close its script', async () => {
  const cfg = (entries: { key: string; value: unknown; by: string; at: number }[] = []) => ({ page: 't1-0.x.y/p.html', entries });
  const html = async (s: string) => (await injectBridge(Buffer.from(s), cfg([{ key: 'k', value: '</script><!-- \u2028', by: 'Cara', at: 1 }]))).toString();
  const withDoctype = await html('\uFEFF<!-- made by a tool -->\n<!doctype html><title>x</title>');
  assert.match(withDoctype, /^\uFEFF<!-- made by a tool -->\n<!doctype html><script>\(function \(cfg\)/);
  assert.match(withDoctype, /<\/script><title>x<\/title>$/);
  assert.match(await html('<p>no head</p>'), /^<script>\(function \(cfg\)[\s\S]*<\/script><p>no head<\/p>$/);
  // Exactly one </script>: the value's own is escaped, and so are the line separators.
  const out = await html('<p>x</p>');
  assert.equal(out.split('</script>').length, 2);
  assert.ok(!out.includes('\u2028') && out.includes('\\u003c/script>') && out.includes('\\u2028'));
});

test("a page's bare URLs and web addresses become new-tab links; its scripts, styles, links, code and fields stay as written (#440)", async () => {
  const ext = (href: string, text = href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  assert.equal(linkPageText('<p>Open <b>console.firebase.google.com</b>, then https://x.io/a.</p>'), `<p>Open <b>${ext('https://console.firebase.google.com', 'console.firebase.google.com')}</b>, then ${ext('https://x.io/a')}.</p>`);
  const untouched =
    '<!doctype html><head><title>x.com</title><style>a::after{content:"https://s.io"}</style></head>' +
    '<!-- see https://c.io --><script>const u = "https://j.io"; if (a < b) go("x.com");</script>' +
    '<a href="https://a.io">https://a.io</a><code>y.com</code><pre>https://p.io</pre><textarea>https://t.io</textarea>' +
    '<button>z.com</button><svg><text>https://v.io</text></svg><img alt="https://i.io">' +
    // A comment inside code or a link doesn't split it.
    '<pre>https://a.io<!-- note -->https://b.io</pre><a href="https://c.io">x<!-- n -->https://c.io</a>';
  assert.equal(linkPageText(untouched), untouched);
  // Prose between the skipped parts still links, and the bridge goes in ahead of it all.
  assert.equal(linkPageText('<script>1</script>see x.com<style>p{}</style>'), `<script>1</script>see ${ext('https://x.com', 'x.com')}<style>p{}</style>`);
  const served = (await injectBridge(Buffer.from('<!doctype html><p>web.dev</p>'), { page: 't1-0.x.y/p.html', entries: [] })).toString();
  assert.ok(served.startsWith('<!doctype html><script>(function (cfg)') && served.endsWith(`<p>${ext('https://web.dev', 'web.dev')}</p>`));
});

test('writes are checked: key length, value size, entries per write, keys and bytes per page', () => {
  assert.throws(() => cleanEntries([]), /non-empty/);
  assert.throws(() => cleanEntries([{ key: 'x'.repeat(LIMITS.keyChars + 1), value: 1 }]), /1 to 200/);
  assert.throws(() => cleanEntries([{ key: 'a\0b', value: 1 }]), /1 to 200/);
  assert.throws(() => cleanEntries([{ key: 'big', value: 'x'.repeat(LIMITS.valueBytes) }]), /over 64 KB/);
  assert.throws(() => cleanEntries(Array.from({ length: LIMITS.entries + 1 }, (_, i) => ({ key: `k${i}`, value: i }))), /At most 100/);
  assert.deepEqual(cleanEntries([{ key: 'a', value: { pick: 2 } }, { key: 'b', value: null }, { key: 'c' }]), [
    { key: 'a', value: '{"pick":2}' },
    { key: 'b', value: null },
    { key: 'c', value: null },
  ]);
  const s = new Store(join(root, 'limits.db'));
  const p = s.createProject('L', null);
  for (let i = 0; i < LIMITS.keys; i += 100) writeStore(s, p.id, '/f.html', cleanEntries(Array.from({ length: 100 }, (_, j) => ({ key: `k${i + j}`, value: 1 }))), 'Cara');
  assert.throws(() => writeStore(s, p.id, '/f.html', cleanEntries([{ key: 'one-more', value: 1 }]), 'Cara'), /at most 2000 keys/);
  // Replacing and deleting keys is fine at the limit, and a refused write changes nothing.
  writeStore(
    s,
    p.id,
    '/f.html',
    cleanEntries([
      { key: 'k0', value: 2 },
      { key: 'k1', value: null },
    ]),
    'Cara',
  );
  assert.equal(s.artifactData(p.id, '/f.html').length, LIMITS.keys - 1);
  const big = 'x'.repeat(60 * 1024);
  const fill = () => writeStore(s, p.id, '/g.html', cleanEntries(Array.from({ length: 40 }, (_, j) => ({ key: `b${j}`, value: big }))), 'Cara');
  assert.throws(fill, /at most 2 MB/);
  assert.equal(s.artifactData(p.id, '/g.html').length, 0);
});

test("the viewer answers only its own frames' sandboxed pages, with well-formed requests", () => {
  const win = {};
  const frame = { iframe: { isConnected: true, contentWindow: win } };
  const frames = new Set([frame]);
  const msg = (data: object, over: object = {}): { frame: unknown; req: { op: string; text?: string; keepOpen?: boolean; images?: unknown[]; src?: string } } | null => readRequest({ source: win, origin: 'null', data: { bridge: TAG, id: 1, page: 'p', ...data }, ...over }, frames);
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
  assert.equal(msg({ op: 'send', text: 'x'.repeat(10_000) })?.req.op, 'send');
  assert.equal(msg({ op: 'send', text: 'x'.repeat(10_001) })?.req.op, 'refuse', 'told why, never posted (#1940)');
  assert.equal(msg({ op: 'send', text: 'x'.repeat(10_001) }, { source: {} }), null);
  assert.equal(msg({ op: 'send', text: 'Picks: 3' })?.req.text, 'Picks: 3');
  assert.equal(msg({ op: 'send', text: 'x', keepOpen: true })?.req.keepOpen, true);
  assert.equal(msg({ op: 'send', text: 'x', keepOpen: 'yes' })?.req.keepOpen, undefined, 'only a real true keeps it open');
  assert.equal(msg({ op: 'typing' })?.req.op, 'typing');
  assert.equal(msg({ op: 'kept' })?.req.op, 'kept');
  assert.equal(msg({ op: 'refuse' }), null, 'only the viewer makes one');
  // Marked pictures (#946): a list of at most 6 { mediaType, data }, and only those two keys go on.
  const img = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
  assert.deepEqual(msg({ op: 'send', text: 'x', images: [{ ...img, extra: 1 }] })?.req.images, [img]);
  assert.equal(msg({ op: 'send', text: 'x', images: [] })?.req.images, undefined);
  assert.equal(msg({ op: 'send', text: 'x', images: Array(7).fill(img) }), null);
  assert.equal(msg({ op: 'send', text: 'x', images: [{ mediaType: 'image/png' }] }), null);
  assert.equal(msg({ op: 'send', text: 'x', images: 'nope' }), null);
  assert.equal(msg({ op: 'draw', src: 'https://x/a.png' })?.req.src, 'https://x/a.png');
  assert.equal(msg({ op: 'draw' }), null);
  assert.equal(msg({ op: 'draw', src: 'x'.repeat(4001) }), null);
  assert.equal(msg({ op: 'link', url: 'https://example.org/' }), null, 'no link op any more: the page opens its own tab');
  // Only a picture behind a file token can be drawn on (the page could fetch it anyway), never a cookie-backed route.
  const base = 'https://citadel.test/';
  assert.equal(ownPicture('https://citadel.test/api/files/tok/shot.png', base), true);
  assert.equal(ownPicture('https://citadel.test/api/tickets/9/file?path=a.png', base), false);
  assert.equal(ownPicture('https://citadel.test/api/files/../tickets/9/file?path=a.png', base), false);
  assert.equal(ownPicture('https://citadel.test/api/files/%2e%2e/tickets/9/file?path=a.png', base), false);
  assert.equal(ownPicture('https://elsewhere.test/api/files/tok/shot.png', base), false);
  assert.equal(ownPicture('data:image/png;base64,AA', base), false);
  // A frame taken out of the page is forgotten.
  frame.iframe.isConnected = false;
  assert.equal(msg({ op: 'hello' }), null);
  assert.equal(frames.size, 0);
});

test('a write Citadel could not take while it restarts tells the page to try again, and holds a new front end until it lands (#821)', async (t) => {
  let onMessage = null as ((e: object) => void) | null;
  Object.assign(globalThis, {
    addEventListener: (type: string, fn: typeof onMessage) => {
      if (type === 'message') onMessage = fn;
    },
  });
  t.after(() => {
    delete (globalThis as { addEventListener?: unknown }).addEventListener;
  });
  let fail: Error | null = new TypeError('Failed to fetch');
  const api = async () => {
    if (fail) throw fail;
    return { store: 's9', entries: [], person: 'Cara' };
  };
  const posted: Posted[] = [];
  const win = { postMessage: (m: Posted) => posted.push(m) };
  const iframe = { isConnected: true, contentWindow: win };
  attachBridge(iframe, { open: { artifact: 9 }, name: 'p9.html', owner: 'Cara', api });
  // Taken out at the end, so the next test's viewer starts with no frames (and listens afresh).
  t.after(() => {
    iframe.isConnected = false;
    onArtifactData('none');
  });
  const write = (id: number) => onMessage!({ source: win, origin: 'null', data: { bridge: TAG, id, op: 'write', page: 'p9', entries: [{ key: 'k', value: 1 }] } });
  const settle = () => new Promise((r) => setImmediate(r));

  write(1);
  await settle();
  assert.equal(posted.at(-1)!.ok, false);
  assert.equal(posted.at(-1)!.retry, true, 'the network failing is worth retrying');
  assert.equal(bridgeUnsaved(), true, 'a page holds unsaved writes');
  fail = Object.assign(new Error('Citadel is restarting, try again in a moment'), { status: 502 });
  write(2);
  await settle();
  assert.equal(posted.at(-1)!.retry, true, 'a 502 while Citadel restarts too');
  fail = Object.assign(new Error('Value too big'), { status: 400 });
  write(3);
  await settle();
  assert.ok(!posted.at(-1)!.retry, 'a refusal is not retried');
  assert.equal(bridgeUnsaved(), false, 'refused for good: the page will not send it again, so nothing holds a reload');
  fail = new TypeError('Failed to fetch');
  write(4);
  await settle();
  assert.equal(bridgeUnsaved(), true);
  fail = null;
  write(5);
  await settle();
  assert.equal(posted.at(-1)!.ok, true);
  assert.equal(bridgeUnsaved(), false, 'landed');
  fail = new TypeError('Failed to fetch');
  write(6);
  await settle();
  fail = null;
  onMessage!({ source: win, origin: 'null', data: { bridge: TAG, id: 7, op: 'hello', page: 'p9' } });
  await settle();
  assert.equal(bridgeUnsaved(), false, 'a page that reloaded has no write left to send');

  // Typing on the page counts as typing in Citadel, and gets no answer.
  const n = posted.length;
  const before = Date.now();
  onMessage!({ source: win, origin: 'null', data: { bridge: TAG, id: 8, op: 'typing', page: 'p9' } });
  await settle();
  assert.ok(bridgeTypedAt() >= before);
  assert.equal(posted.length, n);
});

test('a frame writes in a burst of 40, then 20 a second', () => {
  const f = {};
  let n = 0;
  while (takeWrite(f, 1000)) n++;
  assert.equal(n, 40);
  assert.equal(takeWrite(f, 1000), false);
  n = 0;
  while (takeWrite(f, 2000)) n++;
  assert.equal(n, 20);
});

test('a store changed elsewhere reaches the frames showing it, with what it holds now, and no other frame', async (t) => {
  // The viewer's window is the boundary: its message listener and each frame's postMessage are stand-ins.
  let onMessage = null as ((e: object) => void) | null;
  Object.assign(globalThis, {
    addEventListener: (type: string, fn: typeof onMessage) => {
      if (type === 'message') onMessage = fn;
    },
  });
  t.after(() => {
    delete (globalThis as { addEventListener?: unknown }).addEventListener;
  });
  const held: Record<string, Entry[]> = { s1: [{ key: 'pick', value: 1 }], s2: [{ key: 'pick', value: 9 }] };
  const storeOf: Record<string, string> = { pa: 's1', pa2: 's1', pb: 's2' };
  const calls: string[][] = [];
  const api = async (path: string, { body }: { body: { page: string; op: string } }) => {
    calls.push([path, body.page, body.op]);
    return { store: storeOf[body.page], entries: held[storeOf[body.page]] };
  };
  const settle = () => new Promise((r) => setImmediate(r));
  const frame = (page: string) => {
    const posted: Posted[] = [];
    const win = { postMessage: (m: Posted) => posted.push(m) };
    const iframe = { isConnected: true, contentWindow: win };
    attachBridge(iframe, { open: { artifact: 1 }, name: `${page}.html`, owner: 'Cara', api });
    return { page, win, iframe, posted };
  };
  const [a, a2, b, gone, quiet] = [frame('pa'), frame('pa2'), frame('pb'), frame('pa'), frame('pa')];
  // Each frame's page lists its store once (that's how the viewer learns which store a frame shows), but `quiet`'s never asks.
  for (const f of [a, a2, b, gone]) onMessage!({ source: f.win, origin: 'null', data: { bridge: TAG, id: 1, op: 'list', page: f.page } });
  await settle();
  for (const f of [a, a2, b, gone]) f.posted.length = 0;
  calls.length = 0;
  gone.iframe.isConnected = false;

  held.s1 = [{ key: 'pick', value: 2 }];
  onArtifactData('s1');
  await settle();
  assert.deepEqual(a.posted, [{ bridge: TAG, op: 'changed', entries: [{ key: 'pick', value: 2 }] }]);
  assert.deepEqual(a2.posted, [{ bridge: TAG, op: 'changed', entries: [{ key: 'pick', value: 2 }] }], 'another page on the same store');
  assert.deepEqual(
    calls,
    [
      ['api/artifact-data', 'pa', 'list'],
      ['api/artifact-data', 'pa2', 'list'],
    ],
    'each read as its own page',
  );
  assert.deepEqual(b.posted, [], 'a frame on another store');
  assert.deepEqual(gone.posted, [], 'a frame taken out of the page');
  assert.deepEqual(quiet.posted, [], 'a frame that never asked');
});

test('a served page carries the bridge and what it saved', async () => {
  const page = await pageOf(PICKER.id);
  const w = await bridge({ open: { artifact: PICKER.id }, page, op: 'write', entries: [{ key: 'db/picks/cleric', value: { pick: 3, note: '</script>' } }] });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.equal(w.data.person, 'Cara');
  assert.deepEqual(
    w.data.entries.map((e) => [e.key, e.value, e.by]),
    [['db/picks/cleric', { pick: 3, note: '</script>' }, 'Cara']],
  );
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
  assert.equal(
    store.artifactData(A.id, join(root, 'work', 'picker.html')).some((r) => r.key === 'x'),
    false,
  );
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
  assert.deepEqual(
    r.data.entries.map((e) => [e.key, e.value]),
    [['localStorage/zoom', '2']],
  );
});

test("agents read and write their scheme's pages, by artifact or path, and no other scheme's", async () => {
  const byId = await agent(M.id, { artifact: PICKER.id });
  assert.equal(byId.status, 200, JSON.stringify(byId.data));
  assert.ok(byId.data.entries.some((e) => e.key === 'db/picks/cleric'));
  const set = await agent(TA.id, {
    path: join(root, 'work', 'picker.html'),
    entries: [
      { key: 'db/picks/rogue', value: { pick: 1 } },
      { key: 'db/picks/cleric', value: null },
    ],
  });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.deepEqual(
    set.data.entries.map((e) => [e.key, e.by]),
    [['db/picks/rogue', 'Taskmaster']],
  );
  const rel = await agent(M.id, { path: 'picker.html', entries: [{ key: 'storage/n', value: 5 }] });
  assert.deepEqual(rel.data.entries.find((e) => e.key === 'storage/n')!.by, `#${M.number}`);
  // Scheme B's page, by id and by path; a page that isn't HTML; a path out of every folder.
  assert.equal((await agent(M.id, { artifact: THEIRS.id })).status, 404);
  assert.equal((await agent(M.id, { path: join(root, 'work-b', 'theirs.html') })).status, 404);
  assert.equal((await agent(M.id, { path: 'notes.md' })).status, 404);
  assert.equal((await agent(M.id, { path: '../work-b/theirs.html' })).status, 404);
  assert.equal((await agent(MB.id, { path: join(root, 'work', 'picker.html') })).status, 404);
});

test('artifact_data is offered to minions and Taskmasters, and reads a page', async () => {
  const call = async (role: string, msg: { method: string; params?: object }, env: Record<string, string> = {}) => ({ result: await mcpOnce({ COORDINATOR_ROLE: role, ...env }, msg.method, msg.params, tmp.track) });
  for (const role of ['coordinator', 'thread']) {
    const names = (await call(role, { method: 'tools/list' })).result.tools.map((t) => t.name);
    assert.ok(names.includes('artifact_data'), role);
  }
  const { result } = await call(
    'thread',
    { method: 'tools/call', params: { name: 'artifact_data', arguments: { artifact: PICKER.id } } },
    {
      COORDINATOR_API: srv.base,
      COORDINATOR_TOKEN: tokens.agentToken(M.id),
      COORDINATOR_PROJECT: String(A.id),
      COORDINATOR_TICKET: String(M.id),
    },
  );
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.match(result.content[0].text, /picker\.html: \d+ keys?\./);
  assert.match(result.content[0].text, /^db\/picks\/rogue = \{"pick":1\} \(Taskmaster, \d{4}-\d\d-\d\dT\d\d:\d\dZ\)$/m);
});

// A choices card (#804): ask_question with doc names a mock kit page with pick bars, and the page's Send settles it.
writeFileSync(join(root, 'work', 'choices.html'), '<!DOCTYPE html><title>Header takes</title><script src="mockkit.js"></script><div data-pick>A</div><script>mock.picks();</script>');
const askDoc = (doc: string) =>
  fetch(`${srv.base}/api/tickets/${M.id}/questions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.agentToken(M.id)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ doc }),
  }).then(async (r) => ({ status: r.status, data: await json<Answer>(r) }));
const cardData = (id: string) =>
  store
    .listEvents(M.id)
    .filter((e) => e.kind === 'question')
    .map((e) => JSON.parse(e.data))
    .find((q) => q.id === id);
let choicesCard = '';

test('a choices card names a page with pick bars, and only such a page (#804)', async () => {
  assert.match((await askDoc('picker.html')).data.error, /mock kit page with pick bars/);
  assert.match((await askDoc('notes.md')).data.error, /must be an HTML page/);
  assert.match((await askDoc('../work-b/theirs.html')).data.error, /must be an HTML page/);
  const r = await askDoc('choices.html');
  assert.equal(r.status, 201, JSON.stringify(r.data));
  choicesCard = r.data.id;
  assert.deepEqual(cardData(choicesCard), { id: choicesCard, questions: [], doc: { path: join(root, 'work', 'choices.html'), title: 'Header takes' } });
  // It lists no options, so it is answered on its page, not on the card.
  const answer = await fetch(`${srv.base}/api/tickets/${M.id}/answer`, { method: 'POST', headers: { Cookie: srv.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: choicesCard }) });
  assert.equal(answer.status, 409);
});

// These start turns on M and the Taskmaster, which retires the nonce-less agent tokens the tests above use: keep them last.
const sendPage = (body: object, headers: Record<string, string> = { Cookie: srv.cookie }) => fetch(`${srv.base}/api/artifact-send`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await json<Answer>(r) }));
const lastMessage = (id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'user_message')
    .map((e) => JSON.parse(e.data))
    .at(-1);
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

test("a page's Send carries its marked pictures into the chat, checked as pasted ones are (#946)", async () => {
  const page = await pageOf(PICKER.id);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
  const r = await sendPage({ open: { artifact: PICKER.id }, page, text: 'Marked pictures (attached): shot.png', images: [{ mediaType: 'image/png', data: png }] });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const sent = lastMessage(M.id);
  assert.equal(sent.text, 'Marked pictures (attached): shot.png');
  assert.equal(sent.images.length, 1);
  assert.match(sent.images[0], /^[0-9a-f]{24}\.png$/);
  const before = store.listEvents(M.id).filter((e) => e.kind === 'user_message').length;
  const html = Buffer.from('<script>alert(1)</script>').toString('base64');
  assert.equal((await sendPage({ open: { artifact: PICKER.id }, page, text: 'x', images: [{ mediaType: 'image/png', data: html }] })).status, 415);
  assert.equal(store.listEvents(M.id).filter((e) => e.kind === 'user_message').length, before, 'a refused picture sends nothing');
});

test("a page's Send pressed again under the same id posts once (#1862)", async () => {
  const page = await pageOf(PICKER.id);
  const count = () => store.listEvents(M.id).filter((e) => e.kind === 'user_message').length;
  const before = count();
  const send = (text: string, sendId: string) => sendPage({ open: { artifact: PICKER.id }, page, text, sendId });
  const [a, b] = await Promise.all([send('once', 'id-1'), send('once', 'id-1')]);
  assert.deepEqual([a.status, b.status], [202, 202]);
  assert.deepEqual(a.data, b.data);
  assert.equal((await send('once', 'id-1')).status, 202);
  assert.equal(count(), before + 1);
  assert.equal((await send('once', 'id-2')).status, 202);
  assert.equal(count(), before + 2, 'a new id is a new message');
  // Taken before a restart, which forgot the ids it held: the message kept it.
  store.addEvent(M.id, 'user_message', { author: 'Cara', text: 'once', sendId: 'id-3' });
  assert.equal((await send('once', 'id-3')).status, 202);
  assert.equal(count(), before + 3);
});

test("a shared page's Send pressed again goes to the one chat, though another minion linked the page meanwhile (#1862)", async () => {
  writeFileSync(join(shared, 'relinked.html'), '<p>takes</p>');
  const page = await sharedPage('relinked.html');
  const send = () => sendPage({ open: { project: A.id, path: 'relinked.html' }, page, text: 'A', sendId: 'id-shared' });
  assert.equal((await send()).status, 202);
  assert.equal(lastMessage(TA.id).text, 'A');
  const linker = thread(A.id, 'ticket', 'work-relinker');
  store.syncArtifacts(linker, [{ path: join(shared, 'relinked.html'), size: 1, mtime: 1 }]);
  assert.equal((await send()).status, 202);
  assert.equal(store.listEvents(linker.id).filter((e) => e.kind === 'user_message').length, 0);
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

test("a choices page's Send settles its card in the chat that showed it (#804)", async () => {
  assert.equal(cardData(choicesCard).settled, undefined);
  store.syncArtifacts(M, [{ path: 'choices.html', size: 1, mtime: 1 }]);
  const page = await pageOf(art('choices.html').id);
  // A Send from another page leaves it waiting.
  await sendPage({ open: { artifact: PICKER.id }, page: await pageOf(PICKER.id), text: 'Picks on "Picker":' });
  assert.equal(cardData(choicesCard).settled, undefined);
  const r = await sendPage({ open: { ticket: M.id, path: 'choices.html' }, page, text: 'Picks on "Header takes":\n- A: Picked' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.deepEqual(cardData(choicesCard).settled, { at: cardData(choicesCard).settled.at, by: 'Cara', sent: true });
  assert.deepEqual(
    store
      .listEvents(M.id)
      .filter((e) => e.kind === 'question_result')
      .map((e) => JSON.parse(e.data).id),
    [choicesCard],
  );
  assert.equal(store.openCardsOf(M.id).length, 0);
});
