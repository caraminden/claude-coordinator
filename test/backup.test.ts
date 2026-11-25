// The frozen backup chat at /backup (#410): src/backup.html, its routes in src/backup.ts, and the
// guarantees that keep it working when the main front end is broken.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKUP_PAGE, BACKUP_WORKER, chatLine } from '../src/backup.ts';
import { Store } from '../src/db.ts';
import { bootServer, REPO } from './helpers.ts';
import { until } from './wait.ts';

const page = readFileSync(BACKUP_PAGE, 'utf8');

// Bump this only for a fix to the backup page itself, never as part of a restyle or refactor of the app.
const FROZEN_SHA256 = '808196cfee5dc645efaeecffc79aeba5f33ddd7bbaa2927a9a3722edc309d61c';

test('src/backup.html is frozen: its hash is pinned', () => {
  const hash = createHash('sha256').update(readFileSync(BACKUP_PAGE)).digest('hex');
  assert.equal(hash, FROZEN_SHA256, 'src/backup.html is frozen on purpose (#410, see its header comment): leave it out of restyles and refactors. If this is a fix to the backup page itself, update FROZEN_SHA256 in test/backup.test.ts.');
});

test('the backup page loads nothing from outside itself', () => {
  assert.doesNotMatch(page, /<script[^>]*\bsrc\s*=/i, 'no external script');
  assert.doesNotMatch(page, /<link\b/i, 'no stylesheet or other linked file');
  assert.doesNotMatch(page, /@import|url\(/i, 'no CSS imports or url()');
  assert.doesNotMatch(page, /\bimport\s*[({'"*]|\bimportScripts\b/, 'no module imports');
  assert.doesNotMatch(page, /<(iframe|img|object|embed)\b/i, 'no embedded files');
  // The only link out is to the main app; every fetch goes to its own routes, or sign-in.
  assert.deepEqual(
    [...page.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)/gi)].map((m) => m[1]),
    ['/c/'],
  );
  assert.deepEqual([...new Set([...page.matchAll(/call\('([^'?]+)/g)].map((m) => m[1]))].sort(), ['/api/login', '/backup/messages', '/backup/send']);
});

test("the app's service worker leaves /backup to the network", () => {
  const listeners: Record<string, (e: unknown) => void> = {};
  const self = { addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn) };
  new Function('self', 'fetch', readFileSync(join(REPO, 'public', 'sw.js'), 'utf8'))(self, () => new Promise(() => {}));
  const answered = (url: string) => {
    let called = false;
    listeners.fetch({ request: { url, mode: 'navigate' }, respondWith: () => (called = true) });
    return called;
  };
  assert.equal(answered('https://citadel.example/backup'), false);
  assert.equal(answered('https://citadel.example/backup/'), false);
  assert.equal(answered('https://citadel.example/c/'), true, 'the check itself still sees app page loads');
});

test("/backup has its own worker, which outranks the app's for /backup and lets every request through", () => {
  // The page registers it with the narrower scope, which wins over the app's worker (scope /) for /backup.
  assert.match(page, /navigator\.serviceWorker\.register\('\/backup\/sw\.js', \{ scope: '\/backup' \}\)/);
  const listeners: Record<string, unknown> = {};
  new Function('self', BACKUP_WORKER)({ addEventListener: (type: string, fn: unknown) => (listeners[type] = fn) });
  assert.deepEqual(Object.keys(listeners).sort(), ['activate', 'install'], 'no fetch handler: nothing to break');
});

test('chat lines: messages, notes, errors and reply text only, as plain text', () => {
  const root = mkdtempSync(join(tmpdir(), 'backup-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'db.sqlite'));
  const p = store.createProject('P', null);
  const t = store.createTicket({ project_id: p.id, title: 'x', permission_mode: 'default', created_by: 'Cara' });
  const ids = [
    store.addEvent(t.id, 'user_message', { author: 'Cara', text: 'fix it' }).id,
    store.addEvent(t.id, 'claude', { type: 'system', subtype: 'init' }).id,
    store.addEvent(t.id, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } }).id,
    store.addEvent(t.id, 'claude', {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'On **it**' },
          { type: 'tool_use', id: 'b', name: 'Bash', input: {} },
        ],
      },
    }).id,
    store.addEvent(t.id, 'note', { text: 'Josh renamed it' }).id,
    store.addEvent(t.id, 'error', { text: 'Turn failed' }).id,
    store.addEvent(t.id, 'claude', { type: 'result', subtype: 'success' }).id,
  ];
  const lines = store.chatTextEvents(t.id, 0, 10).map(chatLine);
  assert.deepEqual(
    lines.map(({ id, author, text, kind }) => ({ id, author, text, kind })),
    [
      { id: ids[0], kind: 'user_message', author: 'Cara', text: 'fix it' },
      { id: ids[3], kind: 'claude', author: 'Taskmaster', text: 'On **it**' },
      { id: ids[4], kind: 'note', author: 'Note', text: 'Josh renamed it' },
      { id: ids[5], kind: 'error', author: 'Error', text: 'Turn failed' },
    ],
  );
  // The newest `limit`, oldest first; and only after the cursor.
  assert.deepEqual(
    store.chatTextEvents(t.id, 0, 2).map((e) => e.id),
    [ids[4], ids[5]],
  );
  assert.deepEqual(
    store.chatTextEvents(t.id, ids[3], 10).map((e) => e.id),
    [ids[4], ids[5]],
  );
  // A row that isn't JSON still makes a line rather than failing the whole read.
  assert.equal(chatLine({ id: 9, ticket_id: t.id, kind: 'note', data: '{oops', created_at: 0 }).text, '');
});

test('/backup serves the page and sends to and reads from the Citadel scheme (2) Taskmaster', async () => {
  const srv = await bootServer();
  after(() => srv.stop());
  // The backup talks to scheme 2, so make two.
  await srv.call('/api/projects', { name: 'First' });
  const { data: p } = await srv.call('/api/projects', { name: 'Citadel' });
  assert.equal(p.id, 2);

  // The page needs no login and carries its own policy, which lets its inline script and style run.
  for (const path of ['/backup', '/backup/']) {
    const res = await fetch(srv.base + path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /text\/html/);
    assert.match(res.headers.get('content-security-policy')!, /script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; worker-src 'self'/);
    assert.equal(await res.text(), page);
  }
  const worker = await fetch(`${srv.base}/backup/sw.js`);
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get('content-type')!, /javascript/);
  assert.equal(worker.headers.get('service-worker-allowed'), '/backup');
  assert.equal(await worker.text(), BACKUP_WORKER);
  // Its calls need a person signed in.
  assert.equal((await fetch(`${srv.base}/backup/messages`)).status, 401);
  assert.equal((await fetch(`${srv.base}/backup/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"hi"}' })).status, 401);

  // Before the scheme's chat is ever opened there is no Taskmaster yet; opening it makes one.
  assert.equal((await srv.call('/backup/messages')).status, 404);
  const { data: opened } = await srv.call('/api/projects/2');
  const sent = await srv.call('/backup/send', { text: '  The front end is broken, please fix it  ' });
  assert.equal(sent.status, 202);
  assert.equal(typeof sent.data.running, 'boolean');
  const read = await srv.call('/backup/messages');
  assert.equal(read.status, 200);
  const mine = read.data.lines.find((l: { kind: string; author: string; text: string }) => l.kind === 'user_message');
  assert.deepEqual({ author: mine.author, text: mine.text }, { author: 'Cara', text: 'The front end is broken, please fix it' });
  // It went to the Taskmaster's own chat, as the main app shows it.
  const events = (await srv.call(`/api/tickets/${opened.coordinator.id}/events?after=0`)).data;
  assert.ok(events.some((e: { kind: string; data: string }) => e.kind === 'user_message' && JSON.parse(e.data).text === 'The front end is broken, please fix it'));
  // Polling from the newest line returns nothing new. The turn (CLAUDE_BIN is /bin/false) ends with its own error line, whenever
  // the box gets to it: let it land first, so it can't arrive between the two reads.
  const settled = await until('the turn ends', async () => {
    const m = await srv.call('/backup/messages');
    return m.data.lines.some((l: { kind: string }) => l.kind === 'error') && m.data;
  });
  assert.deepEqual((await srv.call(`/backup/messages?after=${settled.last}`)).data.lines, []);

  // Refusals: an empty message, a cross-site post, a body that isn't JSON, an unknown path.
  assert.equal((await srv.call('/backup/send', { text: '   ' })).status, 400);
  const post = (headers: Record<string, string>, body: string) => fetch(`${srv.base}/backup/send`, { method: 'POST', headers: { Cookie: srv.cookie, ...headers }, body });
  assert.equal((await post({ 'Content-Type': 'application/json', Origin: 'https://evil.example' }, '{"text":"hi"}')).status, 403);
  assert.equal((await post({ 'Content-Type': 'text/plain' }, 'hi')).status, 415);
  assert.equal((await srv.call('/backup/nope')).status, 404);
});
